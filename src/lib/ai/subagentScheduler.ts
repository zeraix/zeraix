/**
 * Sub-agent scheduler: run several delegations concurrently, and let the main agent wait for them
 * without polling.
 *
 * The problem this exists to solve is that a tool-calling loop has no callback. A model only regains
 * control when a tool result comes back, so "start work now, collect it later" has exactly two possible
 * shapes: the model asks again and again until the answer is ready (a poll loop — one full model
 * round-trip, prompt included, per check), or a tool call *suspends* until the answer exists. This
 * scheduler is built for the second: `spawn` returns handles immediately and `join` blocks on real
 * promises, so waiting for three sub-agents costs one model round-trip instead of one per check.
 *
 * Deliberately dependency-free — no React, no LLM, no imports. The delegation itself is a `run` callback
 * supplied by the caller (see runDelegation in the chat page), which is what keeps this file testable
 * without a provider (see test/subagent-scheduler.test.mjs) and keeps the polling-avoidance logic in one
 * place rather than smeared through the run loop.
 */

/** Where a job is in its life. `queued` means spawned but waiting on a concurrency slot. */
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/** A job that will never change again. `result` is the conclusion text, or the reason it has none. */
export interface JobOutcome {
  id: string;
  state: "done" | "failed" | "cancelled";
  /** The sub-agent's conclusion, or the error / cancellation notice standing in for one. */
  result: string;
  /** Wall clock from spawn to settle, queue wait included — this is what the delegation actually cost the turn. */
  ms: number;
}

/** The read-only view of a job handed to callers and to the `run` callback. */
export interface JobView<M> {
  id: string;
  meta: M;
  state: JobState;
  /** How many later spawns were folded into this one by the duplicate check. */
  coalesced: number;
}

export interface SpawnResult<M> {
  id: string;
  /** True when this spawn was folded into an already-running identical job rather than starting a second copy. */
  coalesced: boolean;
  /** The meta of the job the caller is now attached to — the *existing* job's meta when coalesced. */
  meta: M;
  /** Set when the spawn was refused (turn cancelled, or the per-turn job cap is reached). */
  refused?: string;
}

export interface JoinResult<M> {
  /** Outcomes that were ready, in spawn order. Each is marked delivered, so it is never returned twice. */
  ready: Array<{ job: JobView<M>; outcome: JobOutcome }>;
  /** Ids asked for that are still queued or running (only non-empty on `any` mode or a timeout). */
  pending: string[];
  /** Ids asked for that this scheduler has never issued — almost always the model inventing a handle. */
  unknown: string[];
  /** True when the wait ended on the timeout rather than on the work finishing. */
  timedOut: boolean;
}

export interface SchedulerOptions<M> {
  /** Delegations allowed to run at once; the rest queue. Each one is an independent model loop, so this
   *  is a spend and rate-limit control, not just a CPU one. */
  limit: number;
  /** Hard cap on jobs per scheduler (i.e. per turn). Backstop against a model that fans out without end. */
  maxJobs?: number;
  /** Called on every state change, for status text ("2 running, 1 queued"). */
  onChange?: () => void;
  /**
   * Whether a new spawn duplicates an unsettled one. Two identical delegations issued in the same batch
   * are the concurrent counterpart of the repeat-delegation guard: that guard compares against delegations
   * that already *finished*, so before this it could not see a twin that was still in flight.
   */
  isDuplicate?: (candidate: M, existing: M) => boolean;
  /** Injectable clock, so tests are not at the mercy of real time. */
  now?: () => number;
}

interface Job<M> {
  id: string;
  meta: M;
  state: JobState;
  coalesced: number;
  queuedAt: number;
  outcome: JobOutcome | null;
  /** Resolves when the job settles. Never rejects: a failure is an outcome, not an exception, because a
   *  join waiting on five jobs must not lose the other four to one throw. */
  settled: Promise<JobOutcome>;
  resolve: (o: JobOutcome) => void;
  /** Set once the outcome has been handed to the model, so join and auto-delivery cannot both report it. */
  delivered: boolean;
}

export const CANCELLED_RESULT = "(cancelled: the turn was interrupted before this delegation finished)";

/**
 * What the main agent reads when the user stops ONE delegation from the Sub-agent Inspector.
 *
 * Different from CANCELLED_RESULT on purpose: there the whole turn is unwinding and nobody reads the
 * answer, here the main agent carries on and has to learn two things — that this work is incomplete, and
 * that the user chose that. Without the second it would simply delegate the same task again.
 */
export const STOPPED_BY_USER_RESULT =
  "(stopped by the user before this delegation finished — its work is incomplete. " +
  "Do not start it again unless the user asks; carry on with what you have.)";

/**
 * The scheduler surface the delegation tools call.
 *
 * Extracted so a second implementation can stand behind it — the Rust runtime, in Stage 4b — without
 * the call sites knowing which one they hold. `spawn` is allowed to be async there (it crosses two
 * process boundaries) and stays synchronous here; awaiting a plain value costs a microtask and nothing
 * else, which is why the call sites can simply `await` it either way.
 */
export interface SchedulerLike<M> {
  spawn(meta: M, run: (job: JobView<M>) => Promise<string>): SpawnResult<M> | Promise<SpawnResult<M>>;
  join(
    ids: string[] | null,
    opts: { mode: "all" | "any"; timeoutMs: number; block: boolean },
  ): Promise<JoinResult<M>>;
  drain(): Array<{ job: JobView<M>; outcome: JobOutcome }>;
  counts(): { queued: number; running: number; settled: number; total: number };
  outstanding(): string[];
  cancelAll(): void;
  /**
   * Settle ONE job as cancelled, leaving its siblings and the scheduler itself running.
   *
   * Returns the state the job was in, or null when there was nothing to cancel (unknown, or settled). A
   * caller needs the distinction: a job that was still queued never ran its body, so nothing else will
   * ever report it.
   */
  cancel(id: string, reason?: string): "queued" | "running" | null;
}

export class SubAgentScheduler<M> {
  private readonly limit: number;
  private readonly maxJobs: number;
  private readonly onChange?: () => void;
  private readonly isDuplicate?: (a: M, b: M) => boolean;
  private readonly now: () => number;

  private readonly jobs = new Map<string, Job<M>>();
  /** Spawn order, which is the order results are reported in — stable regardless of who finished first. */
  private readonly order: string[] = [];
  private seq = 0;

  /** Slots in use. Paired with `waiters` to form a FIFO semaphore. */
  private running = 0;
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(opts: SchedulerOptions<M>) {
    this.limit = Math.max(1, opts.limit);
    this.maxJobs = opts.maxJobs ?? Infinity;
    this.onChange = opts.onChange;
    this.isDuplicate = opts.isDuplicate;
    this.now = opts.now ?? Date.now;
  }

  // ── Introspection ────────────────────────────────────────────────────────────────────────────

  /** Live counts for status text. */
  counts(): { queued: number; running: number; settled: number; total: number } {
    let queued = 0;
    let running = 0;
    let settled = 0;
    for (const j of this.jobs.values()) {
      if (j.state === "queued") queued++;
      else if (j.state === "running") running++;
      else settled++;
    }
    return { queued, running, settled, total: this.jobs.size };
  }

  /** Every job in spawn order, for rendering and for the duplicate check. */
  list(): JobView<M>[] {
    return this.order.map((id) => this.view(this.jobs.get(id)!));
  }

  /** Ids that have been spawned but have not settled. */
  outstanding(): string[] {
    return this.order.filter((id) => {
      const s = this.jobs.get(id)!.state;
      return s === "queued" || s === "running";
    });
  }

  private view(j: Job<M>): JobView<M> {
    return { id: j.id, meta: j.meta, state: j.state, coalesced: j.coalesced };
  }

  private emit() {
    this.onChange?.();
  }

  // ── Concurrency gate ─────────────────────────────────────────────────────────────────────────

  /**
   * FIFO semaphore. A freed slot is handed straight to the next waiter rather than decremented and
   * re-acquired, so `running` never dips below the real load and a queued job cannot be overtaken by a
   * job spawned after it.
   */
  private acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((res) => this.waiters.push(res));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.running--;
  }

  // ── Spawn ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Register a delegation and start it as soon as a slot frees. Returns synchronously — the whole point
   * of the spawn/join split is that the model gets its handles back in the same round it asked.
   *
   * The job is registered before this returns, so several spawns issued in one batch can see each other:
   * that is what lets the duplicate check catch a twin that is still in flight.
   */
  spawn(meta: M, run: (job: JobView<M>) => Promise<string>): SpawnResult<M> {
    if (this.closed) {
      return { id: "", coalesced: false, meta, refused: CANCELLED_RESULT };
    }
    if (this.isDuplicate) {
      for (const id of this.order) {
        const j = this.jobs.get(id)!;
        if (j.state !== "queued" && j.state !== "running") continue;
        if (this.isDuplicate(meta, j.meta)) {
          j.coalesced++;
          this.emit();
          return { id: j.id, coalesced: true, meta: j.meta };
        }
      }
    }
    if (this.jobs.size >= this.maxJobs) {
      return {
        id: "",
        coalesced: false,
        meta,
        refused:
          `Refused: this turn has already spawned ${this.jobs.size} delegations, which is the limit. ` +
          `Collect the ones you have with join_subagents before spawning more.`,
      };
    }

    const id = `s${++this.seq}`;
    let resolve!: (o: JobOutcome) => void;
    const settled = new Promise<JobOutcome>((res) => {
      resolve = res;
    });
    const job: Job<M> = {
      id,
      meta,
      state: "queued",
      coalesced: 0,
      queuedAt: this.now(),
      outcome: null,
      settled,
      resolve,
      delivered: false,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.emit();
    void this.drive(job, run);
    return { id, coalesced: false, meta };
  }

  private async drive(job: Job<M>, run: (job: JobView<M>) => Promise<string>) {
    await this.acquire();
    // Cancelled while queued: cancelAll already settled it, so the delegation must not start. The slot is
    // still released, because cancelAll hands one to every waiter to keep the count honest.
    if (job.outcome) {
      this.release();
      return;
    }
    job.state = "running";
    this.emit();
    try {
      const text = await run(this.view(job));
      this.settle(job, "done", text);
    } catch (e) {
      this.settle(job, "failed", e instanceof Error ? e.message : String(e));
    } finally {
      this.release();
    }
  }

  private settle(job: Job<M>, state: "done" | "failed" | "cancelled", result: string) {
    if (job.outcome) return; // already settled (cancelAll races a natural finish)
    job.state = state;
    job.outcome = { id: job.id, state, result, ms: this.now() - job.queuedAt };
    job.resolve(job.outcome);
    this.emit();
  }

  // ── Join ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Wait for delegations and return their conclusions.
   *
   * This is the anti-polling primitive: it awaits the jobs' own promises, so the tool call is suspended
   * for exactly as long as the work takes and wakes the instant it is done. `mode: "any"` returns as soon
   * as the first one lands, which is what lets a model start on the earliest result instead of blocking
   * on the slowest. `timeoutMs` bounds the wait so one wedged delegation cannot hold the turn forever —
   * the still-running ids come back in `pending` and can be joined again later.
   */
  async join(
    ids: string[] | null,
    opts: { mode?: "all" | "any"; timeoutMs?: number; block?: boolean } = {},
  ): Promise<JoinResult<M>> {
    const mode = opts.mode ?? "all";
    const unknown: string[] = [];
    let targets: Job<M>[];

    if (ids && ids.length > 0) {
      targets = [];
      // Deduped and put back into spawn order, so joining ["s3","s1","s1"] reports s1 then s3 exactly once.
      const wanted = new Set(ids);
      for (const id of wanted) if (!this.jobs.has(id)) unknown.push(id);
      for (const id of this.order) if (wanted.has(id)) targets.push(this.jobs.get(id)!);
    } else {
      // No ids: everything outstanding, plus anything that finished but has not been reported yet — a
      // bare join must not silently skip a result the model never saw.
      targets = this.order
        .map((id) => this.jobs.get(id)!)
        .filter((j) => !j.outcome || !j.delivered);
    }

    let timedOutFlag = false;

    // `block: false` skips the wait entirely and harvests whatever is already settled. This is what lets
    // the main agent stay in control of its own time: blocking is only the right move once it has nothing
    // left to do, and before that point it needs a way to pick up finished work in passing without
    // committing the turn to a wait. Not a poll loop — it returns immediately either way, and there is
    // nothing to re-check, because anything still running is delivered automatically when it lands.
    if (targets.length > 0 && opts.block !== false) {
      const waitFor = targets.map((j) => j.settled);
      const work =
        mode === "any" ? Promise.race(waitFor).then(() => {}) : Promise.all(waitFor).then(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const races: Promise<void>[] = [work];
      if (opts.timeoutMs != null && opts.timeoutMs > 0) {
        races.push(
          new Promise<void>((res) => {
            timer = setTimeout(() => {
              timedOutFlag = true;
              res();
            }, opts.timeoutMs);
          }),
        );
      }
      await Promise.race(races);
      if (timer) clearTimeout(timer);
    }

    const ready: JoinResult<M>["ready"] = [];
    const pending: string[] = [];
    for (const j of targets) {
      if (j.outcome && !j.delivered) {
        j.delivered = true;
        ready.push({ job: this.view(j), outcome: j.outcome });
      } else if (!j.outcome) {
        pending.push(j.id);
      }
    }
    return { ready, pending, unknown, timedOut: timedOutFlag };
  }

  /**
   * Outcomes that have settled but were never reported to the model, marking them delivered.
   *
   * This is the auto-delivery half: the run loop calls it after each tool result, so a delegation that
   * finished while the agent was doing something else surfaces on its own. Without it, a spawn the model
   * forgets to join is work paid for and thrown away.
   */
  drain(): Array<{ job: JobView<M>; outcome: JobOutcome }> {
    const out: Array<{ job: JobView<M>; outcome: JobOutcome }> = [];
    for (const id of this.order) {
      const j = this.jobs.get(id)!;
      if (j.outcome && !j.delivered) {
        j.delivered = true;
        out.push({ job: this.view(j), outcome: j.outcome });
      }
    }
    return out;
  }

  // ── Cancelling one job ───────────────────────────────────────────────────────────────────────

  /**
   * Settle one job as cancelled — the Inspector's per-sub-agent Stop.
   *
   * Settling is what wakes a join blocked on this job NOW, rather than whenever the body notices its signal.
   * The body is not touched here: its stop signal belongs to the caller (see executionRegistry.ts), and a
   * running body that later returns is ignored by `settle`, exactly as a body racing `cancelAll` is. A job
   * still queued never starts: `drive` sees the outcome after acquiring its slot and hands the slot back.
   */
  cancel(id: string, reason: string = STOPPED_BY_USER_RESULT): "queued" | "running" | null {
    const j = this.jobs.get(id);
    if (!j || j.outcome) return null;
    const was = j.state as "queued" | "running";
    this.settle(j, "cancelled", reason);
    return was;
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Settle everything unfinished as cancelled and refuse further spawns, unblocking any join in flight.
   *
   * Every queued waiter is handed a slot before being woken, keeping `running` consistent with the
   * release each of them will perform on its way out.
   */
  cancelAll(reason: string = CANCELLED_RESULT) {
    this.closed = true;
    for (const id of this.order) {
      const j = this.jobs.get(id)!;
      if (!j.outcome) this.settle(j, "cancelled", reason);
    }
    const woken = this.waiters;
    this.waiters = [];
    this.running += woken.length;
    for (const w of woken) w();
  }
}
