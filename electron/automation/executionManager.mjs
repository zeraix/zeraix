/**
 * Execution Manager: owns the run state machine. See docs/automation-workflow-design.md §6.
 *
 *   QUEUED -> RUNNING -> { SUCCEEDED | FAILED | CANCELLED | TIMED_OUT }
 *   RUNNING -> AWAITING_RETRY -> RUNNING
 *   INTERRUPTED -> RUNNING            (crash recovery, §5.1)
 *
 * Durability rules it enforces, all of which assume the process can die between any two lines:
 *   - a run pins `definitionVersion`, so history is explained by the definition that actually ran;
 *   - a node's resolved inputs are checkpointed BEFORE it executes (§6.2), so a resume restarts that
 *     node from exactly the inputs it first saw -- never mid-stream;
 *   - node outputs live in the event log, so a resume can feed later nodes from pre-crash results.
 *
 * No `electron` import (§9.1 testability constraint).
 */
import { EventEmitter } from "node:events";
import { getWorkflow } from "./definitions.mjs";
import { linearOrder } from "./schema.mjs";
import { resolveInputs, buildVariables, resolveList } from "./dataBus.mjs";
import { createDispatcher } from "./dispatcher.mjs";
import { createPolicyGuard, BudgetExceededError } from "./policyGuard.mjs";
import { priceForModel } from "../agent/modelResolver.mjs";
import * as repo from "./repo.mjs";
import { RUN_STATES } from "./repo.mjs";

const {
  RUNNING, SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED,
  AWAITING_RETRY, AWAITING_APPROVAL, AWAITING_EVENT,
} = RUN_STATES;

export function createExecutionManager({
  dispatcher = createDispatcher(),
  workdir = process.cwd(),
  now = () => Date.now(),
  /** Optional OS-notification hook, injected by the wiring layer so this module stays electron-free. */
  notifyApproval = null,
} = {}) {
  /** runId -> AbortController, for cancellation and shutdown. */
  const active = new Map();
  /** Live event stream for the renderer; the UI is a projection over this plus SQLite (§2, principle 4). */
  const bus = new EventEmitter();
  // A run's events are a normal fan-out, not an error condition -- do not warn at 11 listeners.
  bus.setMaxListeners(0);

  /** Append to the durable log AND publish live. Order matters: persist first, then notify. */
  const emit = (runId, nodeId, type, payload = {}) => {
    const at = now();
    const seq = repo.appendEvent({ runId, nodeId, type, payload, now: at });
    bus.emit("event", { seq, runId, nodeId, type, payload, at });
    return seq;
  };

  const setState = (runId, state, opts = {}) => {
    repo.setRunState(runId, state, { now: now(), ...opts });
    bus.emit("state", { runId, state, error: opts.error ?? null });
  };

  /**
   * Create a run. Returns { ok, runId } or { ok:false, error } -- notably when concurrency is
   * 'single' and one is already in flight, which is the default for scheduled workflows.
   */
  function createRun({ workflowId, triggerType = "manual", version, variables = {} }) {
    const pinned = version ?? undefined;
    const def = getWorkflow(workflowId, pinned);
    if (!def) return { ok: false, error: `unknown workflow "${workflowId}"` };

    if (def.limits?.concurrency === "single" && repo.hasActiveRun(workflowId)) {
      return { ok: false, error: "a run of this workflow is already active (concurrency: single)" };
    }

    // Fail before the run exists rather than deep inside a node: a half-executed run that dies on a
    // missing input has already spent money and may have touched the outside world.
    const missing = (def.variables ?? [])
      .filter((v) => v.required && variables[v.key] === undefined)
      .map((v) => v.label || v.key);
    if (missing.length) {
      return { ok: false, error: `missing required input(s): ${missing.join(", ")}`, missing };
    }

    const runId = repo.createRun({
      workflowId,
      definitionVersion: def.version,
      triggerType,
      now: now(),
    });
    // Stored now so a resume long after the fact still has them (see migration v3).
    repo.setRunVariables(runId, variables);
    emit(runId, null, "run:created", {
      workflowId,
      definitionVersion: def.version,
      triggerType,
      // Names only. Values may hold a resume path or a threshold the user considers private, and
      // the event log is surfaced verbatim in the Timeline.
      variableKeys: Object.keys(variables ?? {}),
    });
    return { ok: true, runId, definition: def };
  }

  /**
   * Execute a run to completion. Safe to call for a QUEUED run or to resume an INTERRUPTED one --
   * nodes that already succeeded are skipped and their outputs replayed from the event log.
   */
  async function executeRun(runId, { variables = {} } = {}) {
    const run = repo.getRun(runId);
    if (!run) return { ok: false, error: `unknown run "${runId}"` };
    if (repo.isTerminal(run.state)) return { ok: false, error: `run already ${run.state}` };

    // Always load the PINNED version: editing the workflow mid-run must not change what this run is.
    const def = getWorkflow(run.workflow_id, run.definition_version);
    if (!def) {
      setState(runId, FAILED, { error: "definition version missing" });
      return { ok: false, error: "definition version missing" };
    }

    const chain = linearOrder(def);
    if (!chain.ok) {
      setState(runId, FAILED, { error: chain.error });
      emit(runId, null, "run:failed", { error: chain.error });
      return { ok: false, error: chain.error };
    }

    const controller = new AbortController();
    active.set(runId, controller);
    setState(runId, RUNNING);
    emit(runId, null, "run:started", { nodes: chain.order });

    // Seeded from the run's persisted totals so a resumed run cannot spend its budget twice over.
    const guard = createPolicyGuard({
      limits: def.limits ?? {},
      seed: { tokens: run.tokens_total ?? 0, costUsd: run.cost_usd_total ?? 0 },
      startedAt: run.started_at ?? now(),
      priceFor: priceForModel,
      now,
    });

    const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
    // Persisted inputs win over the definition's defaults; an explicit call-site override (rare)
    // still takes precedence over both.
    const vars = buildVariables(def, { ...repo.getRunVariables(runId), ...variables });
    // Replayed from the log so a resumed run can read outputs produced before the crash.
    const outputs = repo.nodeOutputs(runId);
    const done = new Set(repo.completedNodes(runId));

    try {
      for (const nodeId of chain.order) {
        if (controller.signal.aborted) throw new CancelledError();

        if (done.has(nodeId)) {
          emit(runId, nodeId, "node:skipped", { reason: "already succeeded in an earlier attempt" });
          continue;
        }

        const node = nodesById.get(nodeId);

        // Fan-out: one execution per item, each independently checkpointed, retried and approved.
        // Sequential on purpose -- items usually share a budget and an external rate limit, and a
        // parallel burst is exactly how an unattended run gets an account throttled or banned.
        const plan = node.forEach
          ? resolveList(node.forEach, { outputs, variables: vars })
          : { ok: true, items: [undefined] };
        if (!plan.ok) {
          setState(runId, FAILED, { error: plan.error });
          emit(runId, nodeId, "run:failed", { error: plan.error });
          return { ok: false, error: plan.error };
        }

        const items = node.forEach ? plan.items.slice(0, node.maxItems) : plan.items;
        if (node.forEach && plan.items.length > items.length) {
          // Never silently truncate: "we processed everything" would be a lie.
          emit(runId, nodeId, "log", {
            level: "warn",
            message: `forEach capped at maxItems=${node.maxItems}; ${plan.items.length - items.length} item(s) skipped`,
          });
        }

        const collected = [];
        for (let i = 0; i < items.length; i++) {
          if (controller.signal.aborted) throw new CancelledError();
          // Per-item identity keeps attempt/checkpoint/approval rows unique and the Timeline legible.
          const stepId = node.forEach ? `${nodeId}#${i}` : nodeId;
          if (done.has(stepId)) {
            collected.push(outputs[stepId] ?? {});
            continue;
          }
          const item = items[i];

          // Wait gate, evaluated BEFORE approval so an approval preview can show what actually
          // arrived. Same suspend/checkpoint/resume shape as an approval; the difference is who
          // resolves it — a human decides an approval, an inbound event resolves a wait.
          let eventPayload;
          if (node.waitFor) {
            const gate = checkWaitGate({ runId, node, stepId, item, outputs, vars });
            if (gate.suspended) return { ok: false, suspended: true, awaitingEvent: stepId };
            if (!gate.received) {
              if (node.forEach && node.onItemError === "continue") {
                // "No reply within N days" — drop this candidate, keep the rest of the batch.
                emit(runId, stepId, "node:skipped", { reason: gate.reason ?? "wait timed out" });
                continue;
              }
              const error = gate.reason ?? "wait timed out";
              setState(runId, FAILED, { error });
              emit(runId, stepId, "run:failed", { error });
              return { ok: false, error };
            }
            eventPayload = gate.payload;
          }

          // Approval gate. SUSPENDS rather than awaits: the user may be asleep and the app closed
          // for days. With forEach this asks per item, which is the point for something like
          // "apply to this company" -- one blanket approval for a whole list is not consent.
          if (node.requiresApproval) {
            const gate = await checkApprovalGate({ runId, def, node, stepId, item, outputs, vars });
            if (gate.suspended) return { ok: false, suspended: true, awaiting: stepId };
            if (!gate.approved) {
              if (node.forEach && node.onItemError !== "fail") {
                // A rejected item is a decision about that item, not a failure of the run.
                emit(runId, stepId, "node:skipped", { reason: gate.reason ?? "rejected" });
                continue;
              }
              const error = gate.reason ?? "approval rejected";
              setState(runId, CANCELLED, { error });
              emit(runId, stepId, "run:cancelled", { reason: error });
              return { ok: false, error, rejected: true };
            }
          }

          const result = await runNodeWithRetry({ runId, node, stepId, item, eventPayload, outputs, vars, controller, guard });
          if (!result.ok) {
            if (node.forEach && node.onItemError === "continue") {
              emit(runId, stepId, "node:skipped", { reason: result.error });
              continue;
            }
            setState(runId, result.timedOut ? TIMED_OUT : FAILED, { error: result.error });
            emit(runId, stepId, "run:failed", { error: result.error });
            return { ok: false, error: result.error };
          }
          outputs[stepId] = result.values;
          collected.push(result.values);
        }

        // Downstream reads `run://<nodeId>/items` for the whole fan-out, or a single node's values
        // as before.
        outputs[nodeId] = node.forEach ? { items: collected, count: collected.length } : collected[0] ?? {};
      }

      setState(runId, SUCCEEDED);
      emit(runId, null, "run:succeeded", {});
      return { ok: true, outputs };
    } catch (e) {
      if (e instanceof CancelledError || controller.signal.aborted) {
        setState(runId, CANCELLED, { error: "cancelled" });
        emit(runId, null, "run:cancelled", {});
        return { ok: false, error: "cancelled", cancelled: true };
      }
      const error = e?.message || String(e);
      setState(runId, FAILED, { error });
      emit(runId, null, "run:failed", { error });
      return { ok: false, error };
    } finally {
      active.delete(runId);
    }
  }

  /**
   * Evaluate a node's wait-for-event gate.
   * @returns {{suspended:true} | {suspended:false, received:boolean, payload?:unknown, reason?:string}}
   */
  function checkWaitGate({ runId, node, stepId, item, outputs, vars }) {
    const existing = repo.getWait(runId, stepId);
    if (existing?.state === repo.WAIT_STATES.RECEIVED) {
      return { suspended: false, received: true, payload: existing.payload };
    }
    if (existing?.state === repo.WAIT_STATES.EXPIRED) {
      return { suspended: false, received: false, reason: `no event received before the deadline` };
    }

    if (!existing) {
      // The key may reference the item, so a fan-out has one outstanding wait per candidate rather
      // than a single wait for the whole batch.
      const resolved = resolveInputs(node, { outputs, variables: vars });
      const scope = { ...(resolved.ok ? resolved.inputs : {}), item };
      const matchKey = interpolateKey(node.waitFor.key, scope);
      const deadlineAt = node.waitFor.timeoutMs ? now() + node.waitFor.timeoutMs : null;
      repo.requestWait({
        runId,
        nodeId: stepId,
        matchKey,
        deadlineAt,
        onTimeout: node.waitFor.onTimeout ?? "fail",
        now: now(),
      });
      emit(runId, stepId, "wait:started", { matchKey, deadlineAt });
    }

    setState(runId, AWAITING_EVENT);
    return { suspended: true };
  }

  /**
   * Deliver an inbound event. Resolves the oldest pending wait with this key and resumes its run.
   * Returns { ok:false } when nothing is waiting -- an event for a run that already moved on is not
   * an error, but it must not silently look like a success either.
   */
  async function deliverEvent(matchKey, payload) {
    const wait = repo.deliverEvent(matchKey, payload, { now: now() });
    if (!wait) return { ok: false, error: `nothing is waiting for "${matchKey}"` };
    emit(wait.run_id, wait.node_id, "wait:received", { matchKey });
    void executeRun(wait.run_id).catch((e) => console.error("[automation] resume after event failed:", e));
    return { ok: true, runId: wait.run_id, nodeId: wait.node_id };
  }

  /** Apply the timeout policy to overdue waits. Startup + timer, same as approvals. */
  function expireOverdueWaits() {
    const overdue = repo.overdueWaits(now());
    for (const w of overdue) {
      repo.expireWait(w.id, { now: now() });
      emit(w.run_id, w.node_id, "wait:expired", { matchKey: w.match_key });
      // Re-enter the run so its own onItemError policy decides whether to drop the item or fail.
      void executeRun(w.run_id).catch(() => {});
    }
    if (overdue.length) console.log(`[automation] ${overdue.length} wait(s) hit their deadline`);
    return overdue.length;
  }

  /**
   * Evaluate a node's approval gate.
   * @returns {{suspended:true} | {suspended:false, approved:boolean, reason?:string}}
   */
  async function checkApprovalGate({ runId, def, node, stepId = node.id, item, outputs, vars }) {
    const existing = repo.getApproval(runId, stepId);

    if (existing?.state === repo.APPROVAL_STATES.APPROVED) return { suspended: false, approved: true };
    if (existing?.state === repo.APPROVAL_STATES.REJECTED) {
      return { suspended: false, approved: false, reason: existing.note || "rejected by user" };
    }
    if (existing?.state === repo.APPROVAL_STATES.EXPIRED) {
      // Timeout policy was already applied when it expired; "approve" rewrites the row, so reaching
      // here means the policy was reject.
      return { suspended: false, approved: false, reason: "approval timed out" };
    }

    if (!existing) {
      // The preview is what the user actually authorises, so it must show the concrete action --
      // "send this message to this company" -- not just the node id.
      const resolved = resolveInputs(node, { outputs, variables: vars });
      const previewInputs = resolved.ok ? { ...resolved.inputs } : {};
      if (item !== undefined) previewInputs.item = item;
      const deadlineAt = node.approvalTimeoutMs ? now() + node.approvalTimeoutMs : null;
      repo.requestApproval({
        runId,
        workflowId: def.id,
        nodeId: stepId,
        title: node.approvalTitle || `${def.name}: ${stepId}`,
        preview: { runtime: node.runtime, config: redact(node.config), inputs: previewInputs },
        deadlineAt,
        onTimeout: node.onApprovalTimeout ?? "reject",
        now: now(),
      });
      emit(runId, stepId, "approval:requested", { deadlineAt, title: node.approvalTitle ?? null });
      // Best-effort nudge. The app may be closed, in which case there is no notification at all --
      // which is exactly why pending approvals are also surfaced in the UI on next open.
      notifyApproval?.({ runId, nodeId: stepId, workflowName: def.name, deadlineAt });
    }

    setState(runId, AWAITING_APPROVAL);
    return { suspended: true };
  }

  /** One node, including its retry policy. Each attempt is recorded separately (§6.1). */
  async function runNodeWithRetry({ runId, node, stepId = node.id, item, eventPayload, outputs, vars, controller, guard }) {
    const policy = node.retry ?? { attempts: 1 };
    const maxAttempts = Math.max(1, policy.attempts ?? 1);
    let lastError = "unknown error";
    let timedOut = false;

    // Continue the numbering rather than restarting at 1: a resumed run may already have attempt
    // rows for this node (see repo.nextAttempt).
    const firstAttempt = repo.nextAttempt(runId, stepId);
    for (let i = 0; i < maxAttempts; i++) {
      const attempt = firstAttempt + i;
      if (controller.signal.aborted) throw new CancelledError();
      if (i > 0) {
        setState(runId, AWAITING_RETRY);
        const delay = backoffDelay(policy, i + 1);
        emit(runId, stepId, "node:retry", { attempt, delayMs: delay, previousError: lastError });
        await sleep(delay, controller.signal);
        setState(runId, RUNNING);
      }

      const res = await runNodeOnce({ runId, node, stepId, item, eventPayload, outputs, vars, controller, attempt, guard });
      if (res.ok) return res;
      lastError = res.error;
      timedOut = res.timedOut;
      // A policy denial is a decision, not a transient fault -- retrying cannot change the verdict.
      // A policy denial (including a budget stop) is a decision, not a transient fault.
      if (res.policyDenied || res.budgetExceeded) break;
    }
    return { ok: false, error: lastError, timedOut };
  }

  /** A single attempt: checkpoint, dispatch, drain events, record the outcome. */
  async function runNodeOnce({ runId, node, stepId = node.id, item, eventPayload, outputs, vars, controller, attempt, guard }) {
    const resolved = resolveInputs(node, { outputs, variables: vars });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    // Expose the current item as a normal input, so shell nodes see $INPUT_ITEM and agent prompts
    // can use {{inputs.item}} -- no runtime needs to know fan-out exists.
    if (item !== undefined) resolved.inputs.item = item;
    // The delivered event is an ordinary input too, so a runtime needs no knowledge of waiting.
    if (eventPayload !== undefined) resolved.inputs.event = eventPayload;

    // THE CHECKPOINT (§6.2): inputs are durable before the node runs, so a crash mid-node can
    // restart it from exactly what it saw. Writing this after execution would be useless.
    repo.writeCheckpoint({ runId, nodeId: stepId, inputs: resolved.inputs, now: now() });

    const attemptId = repo.startAttempt({ runId, nodeId: stepId, attempt, now: now() });
    emit(runId, stepId, "node:started", { attempt, runtime: node.runtime });

    // Per-node timeout composed with the run-level cancel signal, so either can stop the node.
    const nodeController = new AbortController();
    const onOuterAbort = () => nodeController.abort();
    controller.signal.addEventListener("abort", onOuterAbort, { once: true });
    let timer = null;
    let timedOut = false;
    if (node.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        nodeController.abort();
      }, node.timeoutMs);
      timer.unref?.();
    }

    const pids = [];
    try {
      let values = null;
      for await (const event of dispatcher.dispatch({
        runId,
        nodeId: stepId,
        attempt,
        runtime: node.runtime,
        config: node.config ?? {},
        inputs: resolved.inputs,
        signal: nodeController.signal,
        workdir,
        policy: guard,
      })) {
        if (event.type === "output") {
          values = event.values;
          emit(runId, stepId, "output", { values });
        } else if (event.type === "process") {
          // Recorded immediately so a crash right now still leaves a reapable pid (§5.1).
          pids.push(event.pid);
          repo.recordProcess({ runId, nodeId: stepId, pid: event.pid, kind: event.kind, now: now() });
        } else if (event.type === "usage") {
          repo.addRunUsage(runId, { tokens: event.tokens ?? 0, costUsd: event.costUsd ?? 0 });
          emit(runId, stepId, "usage", event);
          // Throws BudgetExceededError once a ceiling is crossed, aborting this node immediately
          // rather than after it finishes spending.
          guard?.noteUsage({ tokens: event.tokens, costUsd: event.costUsd, model: event.model });
          for (const w of guard?.drainWarnings?.() ?? []) {
            emit(runId, stepId, "log", { level: "warn", message: w });
          }
        } else {
          emit(runId, stepId, event.type, event);
        }
      }

      repo.finishAttempt(attemptId, { state: SUCCEEDED, now: now() });
      emit(runId, stepId, "node:succeeded", { attempt });
      return { ok: true, values: values ?? {} };
    } catch (e) {
      const cancelledByRun = controller.signal.aborted;
      const error = timedOut ? `node timed out after ${node.timeoutMs}ms` : e?.message || String(e);
      repo.finishAttempt(attemptId, {
        state: timedOut ? TIMED_OUT : cancelledByRun ? CANCELLED : FAILED,
        error,
        now: now(),
      });
      emit(runId, stepId, "node:failed", { attempt, error, timedOut });
      if (cancelledByRun) throw new CancelledError();
      return {
        ok: false,
        error,
        timedOut,
        policyDenied: e?.name === "PolicyDeniedError",
        budgetExceeded: e instanceof BudgetExceededError,
      };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onOuterAbort);
      for (const pid of pids) repo.clearProcess({ runId, nodeId: stepId, pid });
    }
  }

  /**
   * Record a human decision and resume the run. Safe to call when the app has just started and the
   * run is not in memory: execution is rebuilt from SQLite, not from anything held in RAM.
   */
  async function decideApproval({ approvalId, approved, note = null }) {
    const approval = repo.getApprovalById(approvalId);
    if (!approval) return { ok: false, error: "unknown approval" };
    if (approval.state !== repo.APPROVAL_STATES.PENDING) {
      return { ok: false, error: `already ${approval.state.toLowerCase()}` };
    }

    repo.decideApproval(approvalId, { approved, by: "user", note, now: now() });
    emit(approval.run_id, approval.node_id, approved ? "approval:approved" : "approval:rejected", { note });

    // Resume in the background so the caller (an IPC handler) is not blocked for the length of a run.
    void executeRun(approval.run_id).catch((e) => console.error("[automation] resume failed:", e));
    return { ok: true };
  }

  /**
   * Apply the timeout policy to every overdue approval. Called at startup and on a timer, because a
   * deadline almost always elapses while the app is closed -- discovering it by looking at the clock
   * is the only thing that works (§12.2's catch-up principle, applied to approvals).
   */
  function expireOverdueApprovals() {
    const overdue = repo.overdueApprovals(now());
    for (const a of overdue) {
      if (a.on_timeout === "approve") {
        repo.decideApproval(a.id, { approved: true, by: "timeout", note: "auto-approved on timeout", now: now() });
        emit(a.run_id, a.node_id, "approval:approved", { by: "timeout" });
        void executeRun(a.run_id).catch(() => {});
      } else {
        repo.expireApproval(a.id, { now: now() });
        emit(a.run_id, a.node_id, "approval:expired", {});
        // Reject-on-timeout ends the run: the opportunity lapsed, and that is recorded rather than
        // left as a run that silently waits forever.
        setState(a.run_id, CANCELLED, { error: "approval timed out" });
      }
    }
    if (overdue.length) console.log(`[automation] ${overdue.length} approval(s) hit their deadline`);
    return overdue.length;
  }

  /** Cancel an in-flight run. Returns false when the run is not currently executing. */
  function cancelRun(runId) {
    const controller = active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Startup recovery (§5.1). Reap processes left by a previous crash, then mark the runs that were
   * mid-flight as INTERRUPTED so they can be resumed from their last checkpoint.
   *
   * Reaping happens FIRST: a resumed run may need the resources a dead run's orphan still holds.
   */
  function recoverInterrupted() {
    const orphans = repo.listRecordedProcesses();
    let reaped = 0;
    for (const proc of orphans) {
      try {
        // Signal 0 would only test liveness; we want it gone.
        process.kill(proc.pid, "SIGKILL");
        reaped++;
      } catch {
        // Already dead, or the pid was recycled and is not ours -- either way, nothing to do.
      }
    }
    repo.clearAllProcesses();

    const stranded = repo.unfinishedRuns();
    for (const run of stranded) {
      repo.setRunState(run.id, INTERRUPTED, { now: now(), error: "interrupted by shutdown" });
      repo.appendEvent({ runId: run.id, type: "run:interrupted", payload: {}, now: now() });
    }
    expireOverdueApprovals();
    expireOverdueWaits();
    if (reaped || stranded.length) {
      console.log(`[automation] recovery: reaped ${reaped} process(es), ${stranded.length} run(s) marked INTERRUPTED`);
    }
    return { reaped, interrupted: stranded.map((r) => r.id) };
  }

  /** Abort everything in flight (app shutdown). */
  async function shutdown() {
    for (const controller of active.values()) controller.abort();
    active.clear();
    await dispatcher.dispose();
  }

  return {
    bus,
    createRun,
    executeRun,
    cancelRun,
    decideApproval,
    expireOverdueApprovals,
    deliverEvent,
    expireOverdueWaits,
    recoverInterrupted,
    shutdown,
    /** Convenience for the common path: create then execute. */
    async run({ workflowId, triggerType = "manual", variables = {} }) {
      const created = createRun({ workflowId, triggerType, variables });
      if (!created.ok) return created;
      const result = await executeRun(created.runId, { variables });
      return { ...result, runId: created.runId };
    },
  };
}

/**
 * Strip anything secret-looking before it is stored in an approval preview.
 *
 * The preview is shown in the UI and persisted, so it must be safe to read. Approval payloads are
 * the one place where node config is deliberately surfaced verbatim to a human, which makes this the
 * easiest place to leak a key by accident (§7.2 keeps secrets out of the event log for the same reason).
 */
function redact(config) {
  if (!config || typeof config !== "object") return config;
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = /key|token|secret|password|authorization/i.test(k) ? "[redacted]" : v;
  }
  return out;
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** Substitute {{item}} / {{item.field}} / {{inputs.x}} into a wait key. */
function interpolateKey(template, scope) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, pathExpr) => {
    const value = pathExpr.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), scope);
    if (value === undefined || value === null) return whole;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function backoffDelay(policy, attempt) {
  const base = policy.delayMs ?? 0;
  return policy.backoff === "exponential" ? base * 2 ** (attempt - 2) : base;
}

/** Interruptible sleep: a cancel during a retry backoff must not wait out the full delay. */
function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
