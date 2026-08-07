/**
 * Deployment configuration for the sub-agent orchestration system.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *  THIS FILE MUST NEVER BE MODIFIABLE BY ANY AGENT, THROUGH ANY TOOL CALL, BY ANY PATH.
 *
 *  It is edited by a human, directly, at deployment time, in a reviewed commit — and by nothing else.
 *  Everything the rest of this subsystem enforces is downstream of the values below, so an agent that can
 *  write here does not need to defeat the broker: it can simply raise the ceiling and ask again. There is
 *  no clever runtime check that recovers from that, which is why the control has to be structural:
 *
 *    - keep this path outside every workspace root a `write_file` implementation will accept;
 *    - run the agent process as a user with no write permission to the deployed source;
 *    - treat any diff to this file that did not come from a human as an incident, not a bug.
 *
 *  The same applies to anything that can rewrite it indirectly — `exec_shell`, a build step an agent can
 *  influence, a config loader that reads an agent-writable file. If it can change these numbers, it is part
 *  of the security boundary.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Why the values live here rather than being computed: every one of them is a policy judgment about how much
 * autonomy is acceptable in this deployment, and policy judgments belong somewhere a person can read the
 * whole of it at once and say yes.
 */

import type { AuditSink } from "./audit-log";
import {
  CapabilityBroker,
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_MAX_SPAWN_DEPTH,
  TerminalApprover,
  type HighRiskApprover,
} from "./capability-broker";
import { DEFAULT_MAX_TURNS } from "./sub-agent-runner";
import { SUBAGENTS } from "../subagents";

/**
 * The permission ceiling: the absolute maximum any sub-agent may ever be granted, regardless of what it
 * asks for or how convincingly it asks.
 *
 * **Derived from the fixed roles in `subagents.ts`, one-directionally.** The four shipped roles (explore,
 * plan, coder, reviewer) already encode a reviewed answer to "what may a sub-agent touch", and they do not
 * go through the broker at run time — they carry static tool lists and always will. Taking their union as
 * the ceiling means a dynamically-brokered sub-agent can never exceed what a fixed role already does, and
 * there is one place that decides it. Nothing here changes `subagents.ts`; the dependency points this way
 * only.
 *
 * Concretely, today, that union is 14 tools and excludes `delete_file`, `open_path`, `stop_service`,
 * `mcp_connect`, `web_search` and `fetch_url` — so it is a real bound rather than a formality. `run_command`
 * *is* included, via `CODER_TOOLS`, and is classified high-risk, which means a dynamic sub-agent asking for
 * it reaches the human approval path rather than being refused outright.
 *
 * **Deliberately not readable from the environment.** Every other value below accepts an env override; this
 * one does not. Environment is process state — a launcher, a shell profile, a container spec, a CI variable
 * — the least reviewed layer in the stack, and the ceiling is precisely the value whose purpose is to
 * require review. Widening it means editing a role's tool list, in a commit, on purpose.
 */
function deriveCeiling(): readonly string[] {
  const union = new Set<string>();
  for (const role of SUBAGENTS) {
    // In `subagents.ts`, an omitted `tools` means "every tool" — so a role like that makes the union
    // meaningless and the ceiling unbounded. Failing at load is the only honest response: silently
    // substituting every tool would grant more than any reviewed role ever did, and silently skipping the
    // role would produce a ceiling that quietly under-represents what the system already permits. Either
    // way a human has to decide, so make them.
    if (!role.tools) {
      throw new Error(
        `Sub-agent role "${role.id}" declares no tool list, which means unrestricted access. ` +
          `The orchestration ceiling is derived from the union of role tool lists and cannot be computed ` +
          `while a role is unbounded — give it an explicit list, or exclude it from the derivation here.`,
      );
    }
    for (const tool of role.tools) union.add(tool);
  }
  return Object.freeze([...union]);
}

export const CEILING_TOOLS: readonly string[] = deriveCeiling();

/**
 * Read a numeric override that can only make a limit *stricter*.
 *
 * The clamp is the point. Environment variables are useful for locking a particular deployment down harder
 * than the default, and dangerous as a way to raise a limit that was set in code — so `MAX_SPAWN_DEPTH=99`
 * yields the hard-coded 3 while `MAX_SPAWN_DEPTH=1` yields 1. Absent, unparseable, or non-positive values
 * fall back to the code default: a typo in a deployment script must never silently disable a limit.
 */
function tighten(envName: string, hardLimit: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return hardLimit;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return hardLimit;
  return Math.min(Math.floor(parsed), hardLimit);
}

/** Nesting levels of sub-agents. Generation 0 is the orchestrator, so 3 permits three levels below it. */
export const MAX_SPAWN_DEPTH: number = tighten("MAX_SPAWN_DEPTH", DEFAULT_MAX_SPAWN_DEPTH);

/** Sub-agents holding live grants at one time. A spend and blast-radius control, not a CPU one. */
export const MAX_CONCURRENT_SUBAGENTS: number = tighten(
  "MAX_CONCURRENT_SUBAGENTS",
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
);

/** Grant lifetime. Tasks normally end with an explicit revoke well before this; the TTL is the backstop. */
export const GRANT_TTL_MS: number = tighten("GRANT_TTL_MS", DEFAULT_GRANT_TTL_MS);

/** Model turns one sub-agent may take before the runner gives up on it. */
export const MAX_TURNS_PER_SUBAGENT: number = tighten("MAX_TURNS_PER_SUBAGENT", DEFAULT_MAX_TURNS);

/**
 * Where a file-backed audit log should be written, for hosts that use one.
 *
 * Overridable without clamping — it is a location, not a limit. Point it somewhere the agent's own
 * filesystem access cannot reach; see the tamper-resistance note at the top of `audit-log.ts` for why that
 * placement, not this module, is what actually protects the record.
 *
 * This module does not construct the sink. `JsonlAuditLog` lives in `audit-log-file.ts` and needs `node:fs`,
 * while this config is also read by the renderer — and a default that quietly picked a file path would be
 * wrong there in a way nothing would notice until it failed.
 */
export const AUDIT_LOG_PATH: string =
  process.env.ORCHESTRATION_AUDIT_LOG ?? ".orchestration/audit.jsonl";

export interface OrchestrationConfig {
  readonly CEILING_TOOLS: readonly string[];
  readonly MAX_SPAWN_DEPTH: number;
  readonly MAX_CONCURRENT_SUBAGENTS: number;
  readonly GRANT_TTL_MS: number;
  readonly MAX_TURNS_PER_SUBAGENT: number;
  readonly AUDIT_LOG_PATH: string;
}

/** The whole policy in one frozen object, for logging it at start-up or asserting on it in a smoke test. */
export const ORCHESTRATION_CONFIG: OrchestrationConfig = Object.freeze({
  CEILING_TOOLS,
  MAX_SPAWN_DEPTH,
  MAX_CONCURRENT_SUBAGENTS,
  GRANT_TTL_MS,
  MAX_TURNS_PER_SUBAGENT,
  AUDIT_LOG_PATH,
});

/**
 * Build a broker from this configuration.
 *
 * The blessed wiring, so that no call site has to remember which values belong together — a broker built by
 * hand with a locally invented ceiling would be perfectly type-correct and would quietly ignore the policy
 * this file exists to state.
 *
 * The approver defaults to `TerminalApprover` here, unlike the broker's own default of `DenyAllApprover`.
 * That difference is intentional and is the reason both exist: a broker constructed anywhere else — a test,
 * a background job, a server with nobody at the terminal — must fail closed, while a deployment that has
 * loaded this file has declared it is the human-in-the-loop configuration. For a non-interactive deployment,
 * pass an approver that reaches your approval system; do not pass one that answers yes.
 */
export function createConfiguredBroker(opts: {
  /** Required: where the record goes is an environment decision, so there is no default to get wrong. */
  audit: AuditSink;
  approver?: HighRiskApprover;
}): CapabilityBroker {
  return new CapabilityBroker({
    ceiling: CEILING_TOOLS,
    audit: opts.audit,
    approver: opts.approver ?? new TerminalApprover(),
    ttlMs: GRANT_TTL_MS,
    maxDepth: MAX_SPAWN_DEPTH,
    maxConcurrent: MAX_CONCURRENT_SUBAGENTS,
  });
}
