/**
 * The Rust runtime standing in for `SubAgentScheduler`, behind the same surface.
 *
 * Stage 4b of docs/agent-runtime-migration.md. The runtime decides *whether, when and how many* — the
 * per-turn cap, a concurrency limit that is process-global rather than per turn, the cancellation tree,
 * and delivering each outcome exactly once. This window still runs every delegation, because that means
 * holding a model conversation.
 *
 * ## What deliberately did NOT move
 *
 * **Coalescing.** `isSameDelegation` is a Jaccard overlap over subject tokens, not an equality check:
 * "are these the same question" is a judgement about language, not a scheduling mechanic. The runtime
 * coalesces on an exact key and could not reproduce it, so the check stays here and the runtime is
 * never told about it — the same rule that kept the readiness scrape and MCP's `[server]` prefix in JS.
 *
 * ## Delivery is tracked here
 *
 * `drain()` is synchronous — it is called while composing a tool result — and the runtime only reports
 * on `join`. But this window RUNS every body, so it learns each conclusion first-hand and buffers it.
 * `delivered` then guarantees the exactly-once rule across both paths: whichever of `drain` or `join`
 * reports an outcome, the other will not report it again.
 */
import {
  isSameDelegation,
  type DelegationMeta,
} from "@/lib/ai/subagents";
import type { JobOutcome, JobState, JobView, JoinResult, SpawnResult } from "@/lib/ai/subagentScheduler";
import { CANCELLED_RESULT, STOPPED_BY_USER_RESULT } from "@/lib/ai/subagentScheduler";

type Body<M> = (job: JobView<M>) => Promise<string>;

interface RuntimeApi {
  spawn: (turnId: string, jobs: Array<{ meta: unknown; key?: string }>) => Promise<{
    jobs: Array<{ id: string; coalesced: boolean; refused?: string }>;
  } | null>;
  join: (
    turnId: string,
    opts: { ids: string[]; mode: string; timeoutMs?: number; block: boolean },
  ) => Promise<{
    ready: Array<{ id: string; meta: unknown; state: string; result: string; ms: number; coalesced: number }>;
    pending: string[];
    unknown: string[];
    timed_out: boolean;
  } | null>;
  cancel: (turnId: string, reason?: string) => Promise<unknown>;
  onRun: (cb: (p: { requestId: string; turnId: string; jobId: string; meta: unknown }) => void) => () => void;
  reply: (requestId: string, body: { result?: string; error?: string }) => void;
}

function api(): RuntimeApi | null {
  const w = globalThis as unknown as { subagents?: RuntimeApi };
  return w.subagents ?? null;
}

/** Whether this build can schedule sub-agents in the runtime. */
export function runtimeSchedulerAvailable(): boolean {
  return api() !== null;
}

/** Live schedulers, so an inbound `subagent.run` reaches the turn that spawned it. */
const active = new Map<string, RuntimeSchedulerImpl<DelegationMeta>>();
/**
 * The bridge currently subscribed to, rather than a boolean.
 *
 * A one-shot flag latches onto whichever bridge existed the first time anything spawned, and then
 * silently ignores a later one. In the app that is the same object for the life of the window, so the
 * bug is invisible — which is exactly why it is worth not writing: the first test to install a second
 * bridge found it, and a renderer reload would have found it in production.
 */
let subscribedTo: RuntimeApi | null = null;

/**
 * Deliver one delegation to its scheduler.
 *
 * A request can arrive before `spawn()` has returned the id it belongs to: the runtime starts a job the
 * moment it has a slot, and the reply carrying that id is still travelling back. Rather than fail — the
 * fifth appearance of this race in the migration — the request waits briefly for the body to register.
 * See D12 in docs/agent-runtime-migration.md.
 */
function ensureSubscription() {
  const rt = api();
  if (!rt || subscribedTo === rt) return;
  subscribedTo = rt;
  rt.onRun(({ requestId, turnId, jobId, meta }) => {
    const sched = active.get(turnId);
    if (!sched) {
      rt.reply(requestId, { error: `turn ${turnId} is not scheduling delegations here` });
      return;
    }
    void sched.serve(requestId, jobId, meta as DelegationMeta);
  });
}

/** How long an inbound run may wait for its body to be registered. */
const BODY_REGISTRATION_GRACE_MS = 10_000;

class RuntimeSchedulerImpl<M> {
  private readonly bodies = new Map<string, Body<M>>();
  private readonly metas = new Map<string, M>();
  /** Waiters for bodies not registered yet — see `ensureSubscription`. */
  private readonly waiting = new Map<string, Array<(b: Body<M> | null) => void>>();
  /** Settled here, not yet reported to the model by either `drain` or `join`. */
  private readonly undelivered: Array<{ job: JobView<M>; outcome: JobOutcome }> = [];
  private readonly delivered = new Set<string>();
  /** Settled in THIS window — by its body returning, or by `cancel`. What `record` dedupes on. */
  private readonly settledIds = new Set<string>();
  /** Bodies the runtime has asked this window to run. What tells a queued job from a running one. */
  private readonly serving = new Set<string>();
  private readonly started = new Map<string, number>();
  private total = 0;
  private settled = 0;

  readonly turnId: string;
  private readonly onChange: () => void;

  // Assigned explicitly rather than through parameter properties: the test loader runs these modules
  // through Node's type stripping, which does not support that syntax.
  constructor(turnId: string, onChange: () => void) {
    this.turnId = turnId;
    this.onChange = onChange;
  }

  counts() {
    // Mirrored locally rather than asked for: this feeds a status line and is read synchronously, and a
    // round trip per progress update would cost more than the number is worth. `queued` cannot be told
    // from `running` without asking the runtime, so outstanding work is reported as running.
    const outstanding = this.total - this.settled;
    return { queued: 0, running: Math.max(0, outstanding), settled: this.settled, total: this.total };
  }

  outstanding(): string[] {
    return [...this.bodies.keys()].filter((id) => !this.delivered.has(id));
  }

  /** Attach a delegation the runtime has asked this window to run. */
  async serve(requestId: string, jobId: string, meta: M) {
    const rt = api();
    if (!rt) return;
    const body = await this.bodyFor(jobId);
    if (!body) {
      rt.reply(requestId, { error: `no delegation is registered for ${jobId}` });
      return;
    }
    const job: JobView<M> = { id: jobId, meta: this.metas.get(jobId) ?? meta, state: "running", coalesced: 0 };
    const startedAt = this.started.get(jobId) ?? Date.now();
    this.serving.add(jobId);
    try {
      const result = await body(job);
      this.record(job, "done", result, Date.now() - startedAt);
      rt.reply(requestId, { result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.record(job, "failed", message, Date.now() - startedAt);
      rt.reply(requestId, { error: message });
    }
  }

  private bodyFor(jobId: string): Promise<Body<M> | null> {
    const known = this.bodies.get(jobId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(jobId);
        resolve(null);
      }, BODY_REGISTRATION_GRACE_MS);
      const list = this.waiting.get(jobId) ?? [];
      list.push((b) => {
        clearTimeout(timer);
        resolve(b);
      });
      this.waiting.set(jobId, list);
    });
  }

  private record(job: JobView<M>, state: JobOutcome["state"], result: string, ms: number) {
    // Settled once. A body returning after `cancel` already settled its job is the same race `settle`
    // handles in the in-process scheduler: the first outcome stands.
    if (this.delivered.has(job.id) || this.settledIds.has(job.id)) return;
    this.settledIds.add(job.id);
    this.settled++;
    this.undelivered.push({ job: { ...job, state: state as JobState }, outcome: { id: job.id, state, result, ms } });
    this.onChange();
  }

  async spawn(meta: M, run: Body<M>): Promise<SpawnResult<M>> {
    const rt = api();
    if (!rt) return { id: "", coalesced: false, meta, refused: "the runtime is unavailable" };

    // The in-flight duplicate check, kept here — see the header. Folding happens before the runtime is
    // asked, so it never sees the second spawn at all.
    for (const [id, existing] of this.metas) {
      if (this.delivered.has(id)) continue;
      if (isSameDelegation(existing as DelegationMeta, meta as DelegationMeta)) {
        return { id, coalesced: true, meta: existing };
      }
    }

    const res = await rt.spawn(this.turnId, [{ meta }]);
    const first = res?.jobs?.[0];
    if (!first) return { id: "", coalesced: false, meta, refused: "the runtime refused this delegation" };
    if (first.refused) return { id: first.id, coalesced: first.coalesced, meta, refused: first.refused };

    this.total++;
    this.metas.set(first.id, meta);
    this.started.set(first.id, Date.now());
    this.bodies.set(first.id, run);
    // Serve anything that arrived while this was in flight.
    const waiters = this.waiting.get(first.id);
    if (waiters) {
      this.waiting.delete(first.id);
      for (const w of waiters) w(run);
    }
    this.onChange();
    return { id: first.id, coalesced: first.coalesced, meta };
  }

  async join(
    ids: string[] | null,
    opts: { mode: "all" | "any"; timeoutMs: number; block: boolean },
  ): Promise<JoinResult<M>> {
    const rt = api();
    if (!rt) return { ready: [], pending: [], unknown: ids ?? [], timedOut: false };

    const r = await rt.join(this.turnId, {
      ids: ids ?? [],
      mode: opts.mode,
      timeoutMs: opts.timeoutMs,
      block: opts.block,
    });
    if (!r) return { ready: [], pending: [], unknown: ids ?? [], timedOut: false };

    // Anything this window already reported through `drain` is not reported again.
    const ready: Array<{ job: JobView<M>; outcome: JobOutcome }> = [];
    for (const item of r.ready) {
      if (this.delivered.has(item.id)) continue;
      this.delivered.add(item.id);
      // An outcome this window settled itself outranks the runtime's: a job the user stopped is one the
      // runtime saw finish "done" with the stop notice as its text, because the body replied rather than
      // erroring, and reporting it as finished would hide the one fact the model needs.
      const local = this.undelivered.find((u) => u.job.id === item.id);
      if (local) {
        ready.push(local);
        continue;
      }
      const meta = (this.metas.get(item.id) ?? (item.meta as M)) as M;
      ready.push({
        job: { id: item.id, meta, state: item.state as JobState, coalesced: item.coalesced },
        outcome: {
          id: item.id,
          state: (item.state === "done" || item.state === "failed" ? item.state : "cancelled") as JobOutcome["state"],
          result: item.result || (item.state === "cancelled" ? CANCELLED_RESULT : ""),
          ms: item.ms,
        },
      });
    }
    // Drop anything just delivered from the local buffer, so drain cannot repeat it.
    for (let i = this.undelivered.length - 1; i >= 0; i--) {
      if (this.delivered.has(this.undelivered[i].job.id)) this.undelivered.splice(i, 1);
    }
    return { ready, pending: r.pending, unknown: r.unknown, timedOut: r.timed_out };
  }

  /** Settled but never reported. Synchronous, because it is called while composing a tool result. */
  drain(): Array<{ job: JobView<M>; outcome: JobOutcome }> {
    const out = this.undelivered.splice(0, this.undelivered.length);
    for (const item of out) this.delivered.add(item.job.id);
    return out;
  }

  /**
   * Settle one job as cancelled in this window — the Inspector's per-sub-agent Stop.
   *
   * The runtime's protocol cancels a whole turn and nothing smaller, so it is not told. What it sees is the
   * body replying with the stop notice as its result (the caller aborts the body's signal); `join` above
   * prefers the outcome recorded here over that reply. A queued job stays queued in the runtime until it is
   * served, at which point the body sees its aborted signal and returns at once.
   */
  cancel(id: string, reason: string = STOPPED_BY_USER_RESULT): "queued" | "running" | null {
    const meta = this.metas.get(id);
    if (meta === undefined || this.settledIds.has(id) || this.delivered.has(id)) return null;
    const was = this.serving.has(id) ? "running" : "queued";
    this.record(
      { id, meta, state: "cancelled", coalesced: 0 },
      "cancelled",
      reason,
      Date.now() - (this.started.get(id) ?? Date.now()),
    );
    return was;
  }

  cancelAll() {
    active.delete(this.turnId);
    void api()?.cancel(this.turnId, "the turn was interrupted");
  }
}

/** A scheduler backed by the runtime, or null when this build has no bridge. */
export function createRuntimeScheduler<M>(
  turnId: string,
  onChange: () => void,
): RuntimeSchedulerImpl<M> | null {
  if (!api()) return null;
  ensureSubscription();
  const sched = new RuntimeSchedulerImpl<M>(turnId, onChange);
  active.set(turnId, sched as unknown as RuntimeSchedulerImpl<DelegationMeta>);
  return sched;
}

export type RuntimeScheduler<M> = RuntimeSchedulerImpl<M>;
