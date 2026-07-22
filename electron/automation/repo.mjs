/**
 * Data access for automation run state. See docs/automation-workflow-design.md §6 / §9.
 *
 * Every write the Execution Manager makes goes through here, so the durability rules live in one
 * place rather than being re-derived at each call site:
 *   - a run's state transition is persisted immediately (the process may die between any two lines);
 *   - a checkpoint is written BEFORE the node it describes executes (§6.2);
 *   - events are append-only and never updated (§2, principle 3).
 *
 * No `electron` import -- see §9.1's testability constraint.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./db.mjs";

/** Run states (§6). Terminal states are the ones with no outgoing transition. */
export const RUN_STATES = Object.freeze({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  AWAITING_EVENT: "AWAITING_EVENT",
  AWAITING_RETRY: "AWAITING_RETRY",
  INTERRUPTED: "INTERRUPTED",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  TIMED_OUT: "TIMED_OUT",
});

export const TERMINAL_STATES = Object.freeze([
  RUN_STATES.SUCCEEDED,
  RUN_STATES.FAILED,
  RUN_STATES.CANCELLED,
  RUN_STATES.TIMED_OUT,
]);

export const isTerminal = (state) => TERMINAL_STATES.includes(state);

/* -------------------------------------------------------------------------- runs */

/** Create a QUEUED run pinned to a definition version. Returns the run id. */
export function createRun({ workflowId, definitionVersion, triggerType, now = Date.now(), id }) {
  const runId = id ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO runs (id, workflow_id, definition_version, state, trigger_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, workflowId, definitionVersion, RUN_STATES.QUEUED, triggerType, now);
  return runId;
}

/**
 * Move a run to a new state, persisting the timestamps that go with it.
 * `started_at` is only stamped on the first transition into RUNNING, so a resume after INTERRUPTED
 * does not rewrite when the run actually began.
 */
export function setRunState(runId, state, { now = Date.now(), error = null } = {}) {
  const db = getDb();
  if (state === RUN_STATES.RUNNING) {
    db.prepare("UPDATE runs SET state = ?, started_at = COALESCE(started_at, ?) WHERE id = ?").run(
      state,
      now,
      runId,
    );
  } else if (isTerminal(state)) {
    db.prepare("UPDATE runs SET state = ?, ended_at = ?, error = ? WHERE id = ?").run(
      state,
      now,
      error,
      runId,
    );
  } else {
    db.prepare("UPDATE runs SET state = ?, error = ? WHERE id = ?").run(state, error, runId);
  }
}

/** Accumulate usage onto the run total (used by the budget ceiling in §3 Policy Guard). */
export function addRunUsage(runId, { tokens = 0, costUsd = 0 } = {}) {
  getDb()
    .prepare(
      "UPDATE runs SET tokens_total = tokens_total + ?, cost_usd_total = cost_usd_total + ? WHERE id = ?",
    )
    .run(tokens, costUsd, runId);
}

/**
 * Persist the variables a run was started with. Written once at creation: a resume (after approval
 * or a crash) must execute against exactly the inputs the user supplied and approved, not the
 * definition's defaults.
 */
export function setRunVariables(runId, variables) {
  getDb().prepare("UPDATE runs SET variables = ? WHERE id = ?").run(JSON.stringify(variables ?? {}), runId);
}

export function getRunVariables(runId) {
  const row = getDb().prepare("SELECT variables FROM runs WHERE id = ?").get(runId);
  return row?.variables ? safeParse(row.variables) : {};
}

export function getRun(runId) {
  return getDb().prepare("SELECT * FROM runs WHERE id = ?").get(runId) ?? null;
}

/** Recent runs, newest first. Optionally filtered by workflow and/or state. */
export function listRuns({ workflowId, state, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (workflowId) { where.push("workflow_id = ?"); args.push(workflowId); }
  if (state) { where.push("state = ?"); args.push(state); }
  const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, limit);
}

/**
 * Runs left mid-flight by a crash or a kill. These are the runs startup recovery must reap and then
 * either resume from their last checkpoint or fail (§5.1).
 */
export function unfinishedRuns() {
  return getDb()
    .prepare(`SELECT * FROM runs WHERE state IN (?, ?) ORDER BY created_at`)
    .all(RUN_STATES.RUNNING, RUN_STATES.QUEUED);
}

/** Is another run of this workflow already active? Backs limits.concurrency = 'single'. */
export function hasActiveRun(workflowId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) c FROM runs WHERE workflow_id = ? AND state NOT IN (${TERMINAL_STATES.map(() => "?").join(",")})`,
    )
    .get(workflowId, ...TERMINAL_STATES);
  return row.c > 0;
}

/* ----------------------------------------------------------------- node attempts */

/**
 * Next attempt number for a node in this run.
 *
 * Must not restart at 1 on a resume: a node killed mid-execution leaves a row in RUNNING, and
 * re-inserting attempt 1 would violate UNIQUE(run_id, node_id, attempt) and surface as an opaque
 * constraint error instead of a clean second attempt.
 */
export function nextAttempt(runId, nodeId) {
  const row = getDb()
    .prepare("SELECT MAX(attempt) m FROM node_attempts WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId);
  return (row?.m ?? 0) + 1;
}

/** Record the start of a node attempt; returns the attempt row id. */
export function startAttempt({ runId, nodeId, attempt, now = Date.now() }) {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO node_attempts (id, run_id, node_id, attempt, state, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, runId, nodeId, attempt, RUN_STATES.RUNNING, now);
  return id;
}

/** Close out an attempt with its outcome and whatever usage it accrued. */
export function finishAttempt(attemptId, { state, error = null, modelUsed = null, tokens = null, costUsd = null, now = Date.now() }) {
  getDb()
    .prepare(
      `UPDATE node_attempts
          SET state = ?, error = ?, model_used = ?, tokens = ?, cost_usd = ?, ended_at = ?
        WHERE id = ?`,
    )
    .run(state, error, modelUsed, tokens, costUsd, now, attemptId);
}

export function listAttempts(runId) {
  return getDb()
    .prepare("SELECT * FROM node_attempts WHERE run_id = ? ORDER BY started_at, attempt")
    .all(runId);
}

/* ------------------------------------------------------------------------ events */

/** Append one event. The payload is stored as JSON; callers must redact secrets first (§7.2). */
export function appendEvent({ runId, nodeId = null, type, payload = {}, now = Date.now() }) {
  const res = getDb()
    .prepare("INSERT INTO events (run_id, node_id, type, payload, at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, nodeId, type, JSON.stringify(payload), now);
  return Number(res.lastInsertRowid);
}

/** Read a run's events in order. `sinceSeq` lets a reconnecting UI fetch only what it is missing. */
export function readEvents(runId, { sinceSeq = 0, limit = 5000 } = {}) {
  return getDb()
    .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(runId, sinceSeq, limit)
    .map((row) => ({ ...row, payload: safeParse(row.payload) }));
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // A corrupt payload must not break the whole Timeline -- surface it instead of throwing.
    return { _unparseable: String(text) };
  }
}

/**
 * Rebuild each node's outputs from the event log.
 *
 * Outputs are not kept in a table of their own: they are already in the log as 'output' events, and
 * duplicating them would create a second source of truth to keep in sync (§2, principle 3). This is
 * what lets a resumed run feed a later node from a node that ran before the crash.
 */
export function nodeOutputs(runId) {
  const rows = getDb()
    .prepare("SELECT node_id, payload FROM events WHERE run_id = ? AND type = 'output' ORDER BY seq")
    .all(runId);
  const out = {};
  for (const row of rows) {
    if (!row.node_id) continue;
    out[row.node_id] = safeParse(row.payload)?.values ?? {};
  }
  return out;
}

/* ------------------------------------------------------------------- checkpoints */

/**
 * Persist a node's resolved inputs. This write IS the checkpoint (§6.2): it must happen before the
 * node executes, so a resume can restart that node from exactly the inputs it originally saw.
 */
export function writeCheckpoint({ runId, nodeId, inputs, now = Date.now() }) {
  getDb()
    .prepare(
      `INSERT INTO checkpoints (run_id, node_id, inputs, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, node_id) DO UPDATE SET inputs = excluded.inputs, at = excluded.at`,
    )
    .run(runId, nodeId, JSON.stringify(inputs), now);
}

export function readCheckpoint(runId, nodeId) {
  const row = getDb()
    .prepare("SELECT * FROM checkpoints WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId);
  return row ? { ...row, inputs: safeParse(row.inputs) } : null;
}

/** Node ids already checkpointed for this run -- i.e. where a resume should pick up. */
export function completedNodes(runId) {
  return getDb()
    .prepare(
      `SELECT node_id FROM node_attempts WHERE run_id = ? AND state = ? ORDER BY started_at`,
    )
    .all(runId, RUN_STATES.SUCCEEDED)
    .map((r) => r.node_id);
}

/* -------------------------------------------------------------------- approvals */

export const APPROVAL_STATES = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
});

/**
 * Record a pending approval. Idempotent per (run, node): a resumed run re-reaches the same gate and
 * must find the existing request rather than creating a duplicate and re-notifying the user.
 */
export function requestApproval({ runId, workflowId, nodeId, title, preview, deadlineAt = null, onTimeout = "reject", now = Date.now() }) {
  const existing = getApproval(runId, nodeId);
  if (existing) return existing;
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO approvals (id, run_id, workflow_id, node_id, state, title, preview, requested_at, deadline_at, on_timeout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, runId, workflowId, nodeId, APPROVAL_STATES.PENDING, title ?? null, JSON.stringify(preview ?? {}), now, deadlineAt, onTimeout);
  return getApproval(runId, nodeId);
}

const hydrate = (row) => (row ? { ...row, preview: safeParse(row.preview) } : null);

export function getApproval(runId, nodeId) {
  return hydrate(getDb().prepare("SELECT * FROM approvals WHERE run_id = ? AND node_id = ?").get(runId, nodeId));
}

export function getApprovalById(id) {
  return hydrate(getDb().prepare("SELECT * FROM approvals WHERE id = ?").get(id));
}

/** Everything still awaiting a human, oldest first -- what the UI shows when the app opens. */
export function pendingApprovals() {
  return getDb()
    .prepare("SELECT * FROM approvals WHERE state = ? ORDER BY requested_at")
    .all(APPROVAL_STATES.PENDING)
    .map(hydrate);
}

export function decideApproval(id, { approved, by = "user", note = null, now = Date.now() }) {
  getDb()
    .prepare("UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND state = ?")
    .run(approved ? APPROVAL_STATES.APPROVED : APPROVAL_STATES.REJECTED, now, by, note, id, APPROVAL_STATES.PENDING);
  return getApprovalById(id);
}

/**
 * Approvals whose deadline has passed. Called at startup and on a timer -- the app is usually closed
 * when a deadline elapses, so "expired" must be discovered by looking at the clock, never by having
 * been running at the right moment.
 */
export function overdueApprovals(now = Date.now()) {
  return getDb()
    .prepare("SELECT * FROM approvals WHERE state = ? AND deadline_at IS NOT NULL AND deadline_at <= ?")
    .all(APPROVAL_STATES.PENDING, now)
    .map(hydrate);
}

export function expireApproval(id, { now = Date.now() } = {}) {
  getDb()
    .prepare("UPDATE approvals SET state = ?, decided_at = ?, decided_by = 'timeout' WHERE id = ? AND state = ?")
    .run(APPROVAL_STATES.EXPIRED, now, id, APPROVAL_STATES.PENDING);
  return getApprovalById(id);
}

/* ------------------------------------------------------------------------ waits */

export const WAIT_STATES = Object.freeze({
  PENDING: "PENDING",
  RECEIVED: "RECEIVED",
  EXPIRED: "EXPIRED",
});

/**
 * Register a wait for an inbound event. Idempotent per (run, node) for the same reason approvals
 * are: a resumed run re-reaches the gate and must find the existing wait, not open a second one.
 */
export function requestWait({ runId, nodeId, matchKey, deadlineAt = null, onTimeout = "fail", now = Date.now() }) {
  const existing = getWait(runId, nodeId);
  if (existing) return existing;
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO waits (id, run_id, node_id, match_key, state, created_at, deadline_at, on_timeout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, runId, nodeId, matchKey, WAIT_STATES.PENDING, now, deadlineAt, onTimeout);
  return getWait(runId, nodeId);
}

const hydrateWait = (row) => (row ? { ...row, payload: row.payload ? safeParse(row.payload) : null } : null);

export function getWait(runId, nodeId) {
  return hydrateWait(getDb().prepare("SELECT * FROM waits WHERE run_id = ? AND node_id = ?").get(runId, nodeId));
}

/** Everything still waiting on the outside world -- shown in the UI so a stalled run is visible. */
export function pendingWaits() {
  return getDb()
    .prepare("SELECT * FROM waits WHERE state = ? ORDER BY created_at")
    .all(WAIT_STATES.PENDING)
    .map(hydrateWait);
}

/**
 * Deliver an event to the OLDEST pending wait with this key. Oldest-first matters for a fan-out:
 * several items can be waiting on similar keys, and first-come ordering is the only defensible
 * rule without richer correlation data.
 */
export function deliverEvent(matchKey, payload, { now = Date.now() } = {}) {
  const row = getDb()
    .prepare("SELECT * FROM waits WHERE state = ? AND match_key = ? ORDER BY created_at LIMIT 1")
    .get(WAIT_STATES.PENDING, matchKey);
  if (!row) return null;
  getDb()
    .prepare("UPDATE waits SET state = ?, payload = ?, resolved_at = ? WHERE id = ?")
    .run(WAIT_STATES.RECEIVED, JSON.stringify(payload ?? {}), now, row.id);
  return hydrateWait(getDb().prepare("SELECT * FROM waits WHERE id = ?").get(row.id));
}

/** Waits whose deadline has passed. Evaluated by the clock, since the app is usually closed. */
export function overdueWaits(now = Date.now()) {
  return getDb()
    .prepare("SELECT * FROM waits WHERE state = ? AND deadline_at IS NOT NULL AND deadline_at <= ?")
    .all(WAIT_STATES.PENDING, now)
    .map(hydrateWait);
}

export function expireWait(id, { now = Date.now() } = {}) {
  getDb()
    .prepare("UPDATE waits SET state = ?, resolved_at = ? WHERE id = ? AND state = ?")
    .run(WAIT_STATES.EXPIRED, now, id, WAIT_STATES.PENDING);
}

/* --------------------------------------------------------------- run processes */

/** Track an OS process so a crash can be reaped on the next start (§5.1). */
export function recordProcess({ runId, nodeId, pid, kind, now = Date.now() }) {
  getDb()
    .prepare("INSERT INTO run_processes (run_id, node_id, pid, kind, at) VALUES (?, ?, ?, ?, ?)")
    .run(runId, nodeId, pid, kind, now);
}

export function clearProcess({ runId, nodeId, pid }) {
  getDb()
    .prepare("DELETE FROM run_processes WHERE run_id = ? AND node_id = ? AND pid = ?")
    .run(runId, nodeId, pid);
}

export function listRecordedProcesses() {
  return getDb().prepare("SELECT * FROM run_processes").all();
}

export function clearAllProcesses() {
  getDb().prepare("DELETE FROM run_processes").run();
}
