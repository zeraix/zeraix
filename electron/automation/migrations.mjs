/**
 * Automation database schema + migration runner. See docs/automation-workflow-design.md §9.1.
 *
 * Deliberately free of any `electron` import so the schema can be exercised by a plain Node process
 * (and so a bad migration is caught by a test rather than by a user's first launch). db.mjs owns the
 * Electron-specific concerns -- where the file lives and when it opens.
 */

/**
 * Applied in order, tracked with PRAGMA user_version, so each runs exactly once.
 * Never edit a shipped migration -- append a new one, otherwise upgraded installs and fresh installs
 * end up with different schemas.
 */
export const MIGRATIONS = [
  // v1 -- initial run-state schema
  `
  CREATE TABLE runs (
    id                 TEXT PRIMARY KEY,
    workflow_id        TEXT NOT NULL,
    -- Pinned so history never lies: editing a workflow must not rewrite what an old run meant.
    definition_version INTEGER NOT NULL,
    state              TEXT NOT NULL,
    trigger_type       TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    started_at         INTEGER,
    ended_at           INTEGER,
    tokens_total       INTEGER NOT NULL DEFAULT 0,
    cost_usd_total     REAL    NOT NULL DEFAULT 0,
    error              TEXT
  );
  CREATE INDEX idx_runs_workflow ON runs(workflow_id, created_at DESC);
  CREATE INDEX idx_runs_state    ON runs(state);

  CREATE TABLE node_attempts (
    id         TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id    TEXT NOT NULL,
    attempt    INTEGER NOT NULL,
    state      TEXT NOT NULL,
    model_used TEXT,                        -- which fallback actually ran (§6.1)
    tokens     INTEGER,
    cost_usd   REAL,
    started_at INTEGER,
    ended_at   INTEGER,
    error      TEXT,
    UNIQUE (run_id, node_id, attempt)
  );
  CREATE INDEX idx_attempts_run ON node_attempts(run_id);

  -- Append-only. Projections are rebuilt from this; reactors track position in reactor_marks.
  CREATE TABLE events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL,
    node_id TEXT,
    type    TEXT NOT NULL,
    payload TEXT NOT NULL,                  -- JSON, secrets pre-redacted (§7.2)
    at      INTEGER NOT NULL
  );
  CREATE INDEX idx_events_run ON events(run_id, seq);

  -- Written BEFORE a node executes; that write is the checkpoint (§6.2).
  CREATE TABLE checkpoints (
    run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    inputs  TEXT NOT NULL,                  -- resolved refs
    at      INTEGER NOT NULL,
    PRIMARY KEY (run_id, node_id)
  );

  -- Long-lived OS resources, so a crash can be reaped on next start (§5.1).
  CREATE TABLE run_processes (
    run_id  TEXT NOT NULL,
    node_id TEXT NOT NULL,
    pid     INTEGER,
    kind    TEXT,
    at      INTEGER NOT NULL
  );
  CREATE INDEX idx_run_processes_run ON run_processes(run_id);

  -- At-least-once delivery for side-effecting reactors; replay past this point is a no-op (§8).
  CREATE TABLE reactor_marks (
    reactor  TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL
  );

  -- Catch-up scheduling (§12.2). last_fired_at is written BEFORE enqueueing, so a crash mid
  -- catch-up cannot replay the same window and turn backfill into an infinite loop.
  CREATE TABLE trigger_state (
    workflow_id   TEXT NOT NULL,
    trigger_id    TEXT NOT NULL,
    last_fired_at INTEGER,
    PRIMARY KEY (workflow_id, trigger_id)
  );
  `,

  // v2 -- human approval gates (§6).
  //
  // An approval is NOT an in-memory await: the app may be closed for days between a node asking and
  // the user deciding, so the request is a durable row and the run suspends. `deadline_at` is
  // evaluated on every startup as well as on a timer, so a deadline that passes while the app is
  // closed is still honoured at next launch -- the same catch-up principle the scheduler uses.
  `
  CREATE TABLE approvals (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    workflow_id  TEXT NOT NULL,
    node_id      TEXT NOT NULL,
    state        TEXT NOT NULL,           -- PENDING | APPROVED | REJECTED | EXPIRED
    title        TEXT,                    -- short human summary of what is being approved
    preview      TEXT,                    -- JSON: the exact payload the user is authorising
    requested_at INTEGER NOT NULL,
    deadline_at  INTEGER,                 -- null = waits indefinitely
    on_timeout   TEXT NOT NULL DEFAULT 'reject',   -- reject | approve
    decided_at   INTEGER,
    decided_by   TEXT,                    -- 'user' | 'timeout'
    note         TEXT,
    UNIQUE (run_id, node_id)
  );
  CREATE INDEX idx_approvals_state ON approvals(state, deadline_at);
  `,

  // v3 -- per-run inputs.
  //
  // Variables supplied when a run starts (the uploaded resume, an adjustable threshold) MUST be
  // durable. A run that suspends for approval resumes days later via executeRun(runId) with no
  // caller-supplied arguments; keeping them in memory meant a resumed run silently fell back to the
  // definition's defaults, quietly executing against different inputs than the ones approved.
  `
  ALTER TABLE runs ADD COLUMN variables TEXT;
  `,

  // v4 -- waiting on the outside world.
  //
  // "After the company replies" may be days away, so this is the same shape as an approval: a
  // durable row, a suspended run, a deadline evaluated by the clock. The difference is who resolves
  // it -- a human decides an approval; an inbound event resolves a wait.
  //
  // `match_key` is what an incoming event is matched against. It is interpolated per item, so a
  // fan-out can have one outstanding wait per company rather than one for the whole batch.
  `
  CREATE TABLE waits (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL,
    match_key   TEXT NOT NULL,
    state       TEXT NOT NULL,          -- PENDING | RECEIVED | EXPIRED
    payload     TEXT,                   -- JSON delivered with the event
    created_at  INTEGER NOT NULL,
    deadline_at INTEGER,                -- null = waits indefinitely
    on_timeout  TEXT NOT NULL DEFAULT 'fail',   -- fail | continue
    resolved_at INTEGER,
    UNIQUE (run_id, node_id)
  );
  CREATE INDEX idx_waits_pending ON waits(state, match_key);
  CREATE INDEX idx_waits_deadline ON waits(state, deadline_at);
  `,
];

/**
 * Apply any migrations newer than the stored user_version, each in its own transaction.
 * @param {import("node:sqlite").DatabaseSync} handle
 * @returns {{ from: number, to: number }}
 */
export function migrate(handle) {
  const from = Number(handle.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (let v = from; v < MIGRATIONS.length; v++) {
    handle.exec("BEGIN");
    try {
      handle.exec(MIGRATIONS[v]);
      // user_version rejects a bound parameter, hence interpolation -- the value is a loop index,
      // never user input.
      handle.exec(`PRAGMA user_version = ${v + 1}`);
      handle.exec("COMMIT");
    } catch (e) {
      handle.exec("ROLLBACK");
      throw new Error(`automation migration v${v + 1} failed: ${e?.message || e}`);
    }
  }
  return { from, to: MIGRATIONS.length };
}
