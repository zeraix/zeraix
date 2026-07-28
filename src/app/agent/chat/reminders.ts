/**
 * Change events: the standing state the model needs, delivered *downstream* of the cached prefix.
 *
 * Everything variable (working directory, date / model / time zone, the skill menu, unavailable tools, the mission brief) used to
 * be spliced into messages[0] on every request, which re-prefilled the whole conversation from token 0 whenever any of it moved.
 * Instead each value is announced once, when it CHANGES, as a <system-reminder> block written into the content of a turn that
 * already exists — never as a message of its own, because message counts are the app's alignment anchor for edit / regenerate,
 * ratings, and the compaction tail.
 *
 * Two representations travel together:
 *  - the rendered TEXT, inside the turn's content (and its persisted `wireText`) — this is what the model reads, and what keeps the
 *    prefix byte-stable on every later turn;
 *  - the structured `reminder` payload — read only by the compaction fold, and stripped from the wire before sending.
 *
 * See docs/cache-stable-prompt-context.md.
 */
import type { ApiMsg, ContentPart, ReminderState } from "./types";

/** Wrapper marking the block as operator-injected rather than user-typed. */
const OPEN = "<system-reminder>";
const CLOSE = "</system-reminder>";

/** Structural equality, order-insensitive for object keys. Values here are plain JSON, so this is sufficient and cheap. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Replay every reminder in a span into the state as of its end.
 *
 * Used for two things, and it must be the same function for both: deriving "what did we last tell the model" before deciding
 * whether to emit, and building the snapshot spliced at a compaction cut. Deriving rather than caching is what makes it correct
 * across edit / regenerate truncation, conversation switching and reload — a cached value would keep claiming an emission that was
 * just deleted from history.
 */
export function foldReminders(msgs: ApiMsg[]): ReminderState {
  const out: ReminderState = {};
  for (const m of msgs) {
    if (m.role !== "user" || !m.reminder) continue;
    Object.assign(out, m.reminder);
  }
  return out;
}

/** An "empty" value, as the callers use one: the sentinel for "nothing here" ("" for strings, [] for lists). */
const isEmptyValue = (v: unknown): boolean => v === "" || (Array.isArray(v) && v.length === 0);

/** The subset of `current` that differs from `last`. Null when nothing changed — the common case, and the whole point. */
export function diffReminder(current: ReminderState, last: ReminderState): ReminderState | null {
  const delta: ReminderState = {};
  let any = false;
  for (const key of Object.keys(current) as (keyof ReminderState)[]) {
    const value = current[key];
    if (value === undefined) continue;
    // An empty value that was never announced needs no event — there is nothing to retract. Without this, the first turn of
    // every conversation would open with "the mission brief has been cleared" / "every declared tool is usable again" about
    // state that was never stated. Retractions of a real earlier value (last[key] set) still go through.
    if (last[key] === undefined && isEmptyValue(value)) continue;
    if (sameValue(value, last[key])) continue;
    // @ts-expect-error — key-wise copy across a union of value types; each assignment is same-key, same-type.
    delta[key] = value;
    any = true;
  }
  return any ? delta : null;
}

/**
 * Render state as prose.
 *
 * Worded as events ("from this turn on…"), never as assertions about the present. A long conversation accumulates several of these
 * with different values; each has to read as something that happened at a point, or the model sees three contradictory claims about
 * what the working directory currently is.
 */
function renderBody(state: ReminderState, atCut: boolean): string {
  const lines: string[] = [];
  const since = atCut ? "As of this point in the conversation" : "From this turn on";
  if (state.workdir !== undefined) {
    lines.push(`${since}, the working directory is: ${state.workdir}`);
  }
  if (state.ctx) {
    const { date, model, tz } = state.ctx;
    lines.push(`${since}, the date is ${date}, the model answering is ${model}, and the user's time zone is ${tz}.`);
  }
  if (state.skills) {
    lines.push(
      state.skills.length
        ? `${since}, these skills are available — call load_skill with an id to get its full instructions:\n` +
            state.skills.map((s) => `- ${s.id}: ${s.description}`).join("\n")
        : `${since}, no skills are available; do not call load_skill.`,
    );
  }
  if (state.disabledTools) {
    lines.push(
      state.disabledTools.length
        ? `${since}, these declared tools are NOT usable and calling them will fail: ${state.disabledTools.join(", ")}. Say so plainly rather than promising the result.`
        : `${since}, every declared tool is usable again.`,
    );
  }
  if (state.task !== undefined) {
    lines.push(state.task ? state.task : "The mission brief has been cleared.");
  }
  return lines.join("\n\n");
}

/** A change event, for the turn that carries it. */
export function renderReminder(delta: ReminderState): string {
  return `${OPEN}\n${renderBody(delta, false)}\n${CLOSE}`;
}

/** Wrap an already-written prompt (the one-shot nudges) in the same marker, so the model reads it as operator-injected. */
export function wrapReminder(text: string): string {
  return `${OPEN}\n${text}\n${CLOSE}`;
}

/**
 * The state snapshot spliced at a compaction cut, folded from the reminders BEFORE the cut.
 *
 * It describes the state as of the cut, not the current state: if the working directory changed at a turn that survives in the kept
 * region, a current-state snapshot would make every kept message before that change read under the wrong directory. Kept reminders
 * then replay the state forward correctly. Being computed rather than summarised is what makes it immune to the summariser
 * paraphrasing or dropping a constraint.
 */
export function renderSnapshot(state: ReminderState): string {
  const body = renderBody(state, true);
  return body ? `${OPEN}\n${body}\n${CLOSE}` : "";
}

/**
 * Write a reminder block into a turn's content.
 *
 * `where` matters for the prefix. A user turn is new text either way, so the block goes at the front where it is read first. A tool
 * turn has already been sent and stored, so writing into it moves the divergence point into already-cached tokens — appending puts
 * that divergence at the end of a result that can run to thousands of characters, instead of at its start.
 */
export function writeReminderInto(
  content: string | ContentPart[],
  block: string,
  where: "start" | "end",
): string | ContentPart[] {
  const join = (body: string) => (where === "start" ? `${block}\n\n${body}` : `${body}\n\n${block}`);
  if (typeof content === "string") return content ? join(content) : block;
  // Multimodal: merge into the first text part so no part is added and the image parts keep their order.
  const parts = [...content];
  const i = parts.findIndex((p) => p.type === "text");
  if (i < 0) {
    return where === "start"
      ? [{ type: "text" as const, text: block }, ...parts]
      : [...parts, { type: "text" as const, text: block }];
  }
  const part = parts[i] as { type: "text"; text: string };
  parts[i] = { type: "text", text: join(part.text) };
  return parts;
}

/** Does this turn's content already carry the given block? Used by the mid-loop nudge guards, which no longer add a message to scan for. */
export function contentHasBlock(content: string | ContentPart[], needle: string): boolean {
  if (typeof content === "string") return content.includes(needle);
  return content.some((p) => p.type === "text" && p.text.includes(needle));
}
