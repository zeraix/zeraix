/**
 * Audit log: the append-only record of every permission decision this subsystem makes.
 *
 * The problem it solves: a grant is a transient object. It is created, used for a few minutes, and revoked
 * — and once it is gone, nothing in memory can answer "why did that sub-agent have shell access", or the
 * question that actually gets asked after an incident, "why *didn't* it get the tool it asked for". The
 * broker's decisions are pure functions of code and config, so they are reproducible in principle; this
 * module is what makes them reconstructable in practice, including the human y/n answers that are not in
 * the code at all.
 *
 * Recorded here: every Grant at issuance with the full requested-vs-granted diff and a reason per dropped
 * tool, every high-risk approval decision and who made it, every `verifyToolUse` rejection, every tool call
 * with its duration, and every revocation. Chained by `parentGrantId`, that is enough to rebuild the whole
 * spawn tree for a task after the fact — see `buildCallTree`.
 *
 * ## On tamper-resistance, honestly
 *
 * The spec asks for a log "the agent itself cannot modify or delete". This interface delivers the part an
 * interface can: it is append-only by construction — there is no update, no delete, no truncate, and no way
 * to reach the underlying file handle. No agent can rewrite history *through this module*.
 *
 * That is not the same as being tamper-proof, and pretending otherwise would be worse than saying so. The
 * tools in `capabilities.ts` are mocks today; the moment `exec_shell` or `write_file` gains a real
 * implementation, a sub-agent holding either one can delete the JSONL file outright, and no application-
 * level design prevents it. The controls that actually close that gap are outside this process:
 *
 *   - write the log somewhere the agent's own filesystem access cannot reach (a different user, a
 *     container boundary, an append-only mount, `chattr +a`), or
 *   - ship it off-box as it is written, so the local copy is a convenience rather than the record.
 *
 * `AuditSink` exists as an interface precisely so that swap is a constructor argument rather than a rewrite.
 * Until one of those is in place, treat the JSONL file as an operational log that happens to be complete,
 * not as evidence that would survive a hostile agent.
 *
 * ## Why the file sink lives elsewhere
 *
 * This module is imported by the renderer, which runs in a browser context where `node:fs` does not exist —
 * a single top-level `import ... from "node:fs/promises"` here would break the client bundle for every
 * consumer, whether or not they ever touch a file. `JsonlAuditLog` therefore lives in `audit-log-file.ts`,
 * which only Node-side callers import. Everything in this file is environment-agnostic.
 */

/** Why a requested tool did not make it into the final grant. Answers "why not this time". */
export type DenialReason =
  /** Not in TOOL_REGISTRY at all — a hallucinated or misspelled tool name. */
  | "unknown_tool"
  /** Real tool, but not on the human-edited ceiling. The ceiling is the answer; nothing else was consulted. */
  | "not_on_ceiling"
  /** High-risk and the approval path said no. Low-risk tools in the same request were unaffected. */
  | "high_risk_denied"
  /** The whole grant was zeroed because the spawn generation exceeded MAX_SPAWN_DEPTH. */
  | "depth_limit_exceeded";

export interface DeniedTool {
  name: string;
  reason: DenialReason;
}

/**
 * Stamped by the sink, never supplied by callers — a component that can choose its own timestamp and
 * sequence number can also choose to look like it acted earlier than it did.
 */
export interface AuditEnvelope {
  seq: number;
  at: number;
}

export type AuditEvent =
  /**
   * A Grant was issued. Present even when `grantedTools` is empty (depth-limit case): a grant that granted
   * nothing is still a decision, and it is the node the spawn tree hangs off.
   */
  | {
      type: "grant_issued";
      grantId: string;
      agentId: string;
      requesterId: string;
      parentGrantId: string | null;
      generation: number;
      taskDescription: string;
      createdAt: number;
      expiresAt: number;
      requestedTools: string[];
      grantedTools: string[];
      denied: DeniedTool[];
      /**
       * Known tool combinations in this grant whose joint capability exceeds any member's individual risk
       * level — see `ESCALATION_PAIRS` in `capabilities.ts`.
       *
       * Recorded, not enforced. A risk level is a property of one tool, but capability is a property of the
       * set, and the two come apart: `write_file` and `check_project` are each medium, and together they are
       * arbitrary command execution that never touched the high-risk approval path. Blocking that properly
       * means evaluating combinations rather than tools, which is a larger design than this system has.
       *
       * So the gap is written down instead of being papered over. Empty on almost every grant; when it is
       * not empty, a reviewer reading the log can see that a grant carried more capability than its tool
       * list suggests, which is the thing that would otherwise be invisible.
       */
      escalations: string[];
    }
  /**
   * No Grant came into existence. Distinct from `grant_issued` with an empty tool set because there is no
   * grantId to hang later events off — the request was refused before an identity was assigned.
   */
  | {
      type: "grant_rejected";
      requesterId: string;
      parentGrantId: string | null;
      generation: number;
      requestedTools: string[];
      reason: "concurrency_limit";
      detail: string;
    }
  /** The outcome of the high-risk approval path, including who decided. Recorded either way. */
  | {
      type: "high_risk_decision";
      grantId: string;
      agentId: string;
      tools: string[];
      approved: boolean;
      /** Identifies the approving authority — "terminal:human" for the default prompt implementation. */
      approver: string;
      taskDescription: string;
    }
  /**
   * The pre-execution check refused a tool. Each of these is either a model hallucination or an attempted
   * privilege escalation, and both are worth seeing.
   */
  | {
      type: "verify_denied";
      grantId: string;
      agentId: string;
      toolName: string;
      reason: "not_in_grant" | "expired" | "revoked";
    }
  /** A tool actually ran. `inputSummary` is truncated — see summarizeInput. */
  | {
      type: "tool_call";
      grantId: string;
      agentId: string;
      toolName: string;
      inputSummary: string;
      durationMs: number;
      ok: boolean;
    }
  | {
      type: "revoked";
      grantId: string;
      agentId: string;
      reason: "completed" | "explicit" | "expired";
    };

/**
 * Distributed over the union rather than written as `AuditEnvelope & AuditEvent`, so that narrowing on
 * `record.type` still gives back the specific member's fields.
 */
type WithEnvelope<T> = T extends unknown ? AuditEnvelope & T : never;
export type AuditRecord = WithEnvelope<AuditEvent>;

export interface AuditQuery {
  /**
   * Matches the event's `agentId`, and also `requesterId` — asking "everything about this agent" should
   * return the grants it was refused as well as the ones it received.
   */
  agentId?: string;
  grantId?: string;
  /** Inclusive lower bound on `at`. */
  from?: number;
  /** Inclusive upper bound on `at`. */
  to?: number;
}

/**
 * The storage boundary. Append-only on purpose: this interface is the reason no code path exists that could
 * edit a past record, so keep it that way when swapping in a database — an `update` here would undo the
 * guarantee for every caller at once.
 */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
  query(filter?: AuditQuery): Promise<AuditRecord[]>;
}

/** Default cap on recorded tool input. */
export const INPUT_SUMMARY_LIMIT = 200;

/**
 * Condense a tool input for the log.
 *
 * Truncated rather than stored whole because tool inputs carry file contents, email bodies and fetched
 * URLs: a log that copies them verbatim becomes a second place secrets live, with a longer retention than
 * the first. The keys survive in full, which is what you need to tell one call from another; the values are
 * cut. This is a summary for correlation, not a replay buffer.
 */
export function summarizeInput(input: unknown, limit = INPUT_SUMMARY_LIMIT): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    // Cyclic or otherwise unserializable input still deserves a log line.
    text = "[unserializable input]";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}…(+${text.length - limit} chars)`;
}

export function matches(record: AuditRecord, filter: AuditQuery): boolean {
  if (filter.from !== undefined && record.at < filter.from) return false;
  if (filter.to !== undefined && record.at > filter.to) return false;
  if (filter.grantId !== undefined) {
    if (!("grantId" in record) || record.grantId !== filter.grantId) return false;
  }
  if (filter.agentId !== undefined) {
    const onAgent = "agentId" in record && record.agentId === filter.agentId;
    const onRequester = "requesterId" in record && record.requesterId === filter.agentId;
    if (!onAgent && !onRequester) return false;
  }
  return true;
}

/**
 * Sequence numbers and clock, isolated so tests can make time deterministic without stubbing globals.
 */
export interface AuditClock {
  now(): number;
}

export const SYSTEM_CLOCK: AuditClock = { now: () => Date.now() };

/** In-memory sink: for tests, and for callers that want the records without a file. */
export class InMemoryAuditLog implements AuditSink {
  private readonly records: AuditRecord[] = [];
  private seq = 0;
  private readonly clock: AuditClock;

  constructor(clock: AuditClock = SYSTEM_CLOCK) {
    this.clock = clock;
  }

  async append(event: AuditEvent): Promise<void> {
    this.records.push({ ...event, seq: ++this.seq, at: this.clock.now() } as AuditRecord);
  }

  async query(filter: AuditQuery = {}): Promise<AuditRecord[]> {
    return this.records.filter((r) => matches(r, filter));
  }

  /** Everything, unfiltered and in order. Test convenience; not part of AuditSink. */
  all(): readonly AuditRecord[] {
    return this.records;
  }
}

// ── Call-tree reconstruction ──────────────────────────────────────────────────────────────

export interface CallTreeNode {
  grantId: string;
  agentId: string;
  taskDescription: string;
  generation: number;
  parentGrantId: string | null;
  /** The issuing record, with the full requested-vs-granted diff. */
  issued: AuditRecord & { type: "grant_issued" };
  /** Everything else that referenced this grant, in sequence order. */
  events: AuditRecord[];
  children: CallTreeNode[];
}

/**
 * Rebuild the spawn tree from a set of records.
 *
 * Roots are grants with no parent — and also grants whose parent is not in the given records, which happens
 * whenever the query was scoped to a time range that cut the chain. Those are surfaced as roots rather than
 * dropped: a partial tree is a usable answer, a silently missing sub-agent is not.
 *
 * `grant_rejected` records have no grantId and therefore no node. They are still in the query results; they
 * just cannot be attached to a tree that is keyed by grant identity.
 */
export function buildCallTree(records: readonly AuditRecord[]): CallTreeNode[] {
  const byGrant = new Map<string, CallTreeNode>();
  const ordered = [...records].sort((a, b) => a.seq - b.seq);

  for (const r of ordered) {
    if (r.type !== "grant_issued") continue;
    byGrant.set(r.grantId, {
      grantId: r.grantId,
      agentId: r.agentId,
      taskDescription: r.taskDescription,
      generation: r.generation,
      parentGrantId: r.parentGrantId,
      issued: r,
      events: [],
      children: [],
    });
  }

  for (const r of ordered) {
    if (r.type === "grant_issued" || !("grantId" in r)) continue;
    byGrant.get(r.grantId)?.events.push(r);
  }

  const roots: CallTreeNode[] = [];
  for (const node of byGrant.values()) {
    const parent = node.parentGrantId === null ? undefined : byGrant.get(node.parentGrantId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Flatten a tree back to a list, parents before children. Handy for rendering or assertions. */
export function flattenCallTree(nodes: readonly CallTreeNode[]): CallTreeNode[] {
  const out: CallTreeNode[] = [];
  const walk = (n: CallTreeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
