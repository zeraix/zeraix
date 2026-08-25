/**
 * Task Memory (CRITICAL tier of the context-memory-tiers design — see docs/context-memory-tiers-design.md).
 *
 * The per-conversation *mission state* the model keeps for itself: the plan, goal, key decisions and hard
 * constraints for the task in flight. It is pinned into the wire on every turn and NEVER summarised, so the
 * agent cannot forget what it is doing after older rounds are compacted. Distinct from ZERAIX.md project
 * memory (durable across sessions); this is this conversation's mission only.
 *
 * INTERNAL and INVISIBLE by design. Prose-only (`notes`) — a free-form markdown brief the model writes in
 * its own words. It deliberately holds no structured todo list: the user-facing checklist is the separate
 * `update_todos` panel. Task Memory is context the *model* reads, not a surface the *user* sees.
 *
 * `source` records provenance (error-hardening §A2/§B2):
 *   - "model"          — written by the model's own set_task_state call. PERMANENTLY IMMUNE: the extractor
 *                        never overwrites it (it is the model's deliberate truth).
 *   - "auto-extracted" — captured by the compaction-time extractor from a discarded span. REFRESHABLE: a
 *                        later extraction (from a larger span) may overwrite it, so a wrong first capture
 *                        can self-correct rather than being frozen forever.
 *
 * Two ways it is populated:
 *   - applyTaskState(): the model's own set_task_state — REPLACE the brief, stamp source "model".
 *   - mergeExtracted(): the compaction-time extractor — fill when empty OR refresh a prior auto-extracted
 *     brief; never touches a model-authored one. Stamps source "auto-extracted".
 *
 * Everything here is pure and JSON-serialisable (persisted as-is with the conversation).
 */

export type TaskMemorySource = "model" | "auto-extracted";

export interface TaskMemory {
  /** Free-form markdown task brief: mission, plan, constraints, decisions — in the model's own words. */
  notes: string;
  /** Provenance of `notes` — see module doc. Irrelevant when notes is empty. */
  source: TaskMemorySource;
}

/** A model-authored update (set_task_state): the caller supplies notes; source is stamped "model". */
export interface TaskStatePatch {
  notes?: string;
}
/** A compaction-extracted delta: the caller supplies notes; source is stamped "auto-extracted". */
export interface ExtractedTaskState {
  notes?: string;
}

// The brief rides every turn uncached at the wire tail, so cap it (prose, ~1K tokens).
const MAX_NOTES = 4000; // chars

const clampStr = (s: unknown, max: number): string => {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  const t = str.trim();
  return t.length > max ? t.slice(0, max) : t;
};

export function emptyTaskMemory(): TaskMemory {
  return { notes: "", source: "model" };
}

export function isTaskMemoryEmpty(tm: TaskMemory | null | undefined): boolean {
  return !tm || !tm.notes;
}

/**
 * Normalise any (possibly persisted / partial) object into a well-formed, bounded TaskMemory. A persisted
 * brief with no `source` (pre-dates the field) defaults to "model" — the SAFE default, so an
 * unknown-provenance brief is treated as immune and never overwritten by the extractor.
 */
export function normalizeTaskMemory(raw: unknown): TaskMemory {
  const r = (raw as Partial<TaskMemory> | null) ?? {};
  return {
    notes: clampStr(r.notes, MAX_NOTES),
    source: r.source === "auto-extracted" ? "auto-extracted" : "model",
  };
}

/** Model-authored update (set_task_state): replaces the brief (source "model") when notes is provided. */
export function applyTaskState(prev: TaskMemory, patch: TaskStatePatch): TaskMemory {
  if (patch.notes == null) return { ...prev };
  return { notes: clampStr(patch.notes, MAX_NOTES), source: "model" };
}

/**
 * Compaction-extracted delta. Applied when the brief is empty (fill) OR was itself auto-extracted (refresh
 * — §B2, so a wrong first capture can self-correct from a larger span). A "model"-authored brief is immune
 * and left untouched. Always stamps source "auto-extracted".
 */
export function mergeExtracted(prev: TaskMemory, ex: ExtractedTaskState): TaskMemory {
  const refreshable = !prev.notes || prev.source === "auto-extracted";
  if (refreshable && ex.notes) return { notes: clampStr(ex.notes, MAX_NOTES), source: "auto-extracted" };
  return { ...prev };
}

/** Markers the compaction summariser wraps its structured task-state capture in (see page.tsx summarizeHistory). */
export const TASK_STATE_OPEN = "<<<TASK_STATE>>>";
export const TASK_STATE_CLOSE = "<<<END_TASK_STATE>>>";
const TASK_STATE_RE = /<<<TASK_STATE>>>([\s\S]*?)<<<END_TASK_STATE>>>/;

/**
 * Split a compaction summariser's output into its prose summary and the task-state brief it appended.
 * Best-effort and total: malformed/absent markers or bad JSON yield a null delta and the raw text as the
 * summary, so extraction can never break compaction. The delta is applied via mergeExtracted.
 */
export function parseSummaryWithTaskState(raw: string): {
  summary: string;
  extracted: ExtractedTaskState | null;
} {
  let summary = raw ?? "";
  let extracted: ExtractedTaskState | null = null;
  const m = summary.match(TASK_STATE_RE);
  if (m) {
    summary = summary.slice(0, m.index).trim();
    try {
      const obj = JSON.parse(m[1].trim()) as { notes?: unknown };
      if (typeof obj.notes === "string" && obj.notes.trim()) extracted = { notes: obj.notes };
    } catch {
      /* malformed JSON → no extraction, keep the summary */
    }
  }
  return { summary: summary.trim(), extracted };
}

/**
 * The invariant half of the task-state block: what a mission brief is and how to update it. Identical for every install and every
 * conversation, so it belongs in messages[0] where the prefix cache covers it — see docs/cache-stable-prompt-context.md. Only the
 * brief itself varies, and it is delivered as a change event.
 *
 * Worded without positional references ("the conversation above") because it no longer sits next to the brief.
 */
export const TASK_STATE_EXPLAINER =
  "[TASK STATE] When a mission brief is in effect it arrives in a system-reminder marked TASK STATE. It is your own working " +
  "memory: the surrounding conversation may be summarised, but the brief is preserved verbatim, so it is where the things you " +
  "would otherwise lose belong — decisions you made and why, approaches you ruled out and what ruled them out, constraints the " +
  "user stated, findings that cost you effort to establish. It is NOT where the goal or the plan live: the GOAL reminder holds " +
  "the condition to be met, and update_todos holds the steps. Do not restate either here. " +
  "Update it via set_task_state ONLY when something durable changes — not every turn.";

/**
 * Render Task Memory into the text carried by a change event. Empty → "" (nothing emitted).
 * The brief is emitted verbatim (it is already prose); provenance is internal metadata, not shown.
 * The explanation of what this block is lives in messages[0] as TASK_STATE_EXPLAINER, not here.
 */
export function renderTaskMemory(tm: TaskMemory | null | undefined): string {
  if (isTaskMemoryEmpty(tm)) return "";
  return `[TASK STATE]\n${tm!.notes}`;
}
