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
import type { ApiMsg, ReminderState } from "./types";

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
  // The "from this turn on" framing is stated ONCE as a lead-in rather than repeated per item. It has to
  // survive - a long conversation accumulates several of these with different values, and each must read as
  // something that happened at a point rather than a claim about the present - but repeating it per line
  // cost ~5 tokens x however many items changed, on every turn that carries a reminder.
  const since = atCut ? "As of this point in the conversation" : "From this turn on";
  const lead = `${since}:`;
  // Ordered LEAST volatile first. Every reminder sits inside a user turn, so the prefix the KV can reuse
  // ends at the first byte that differs from last time. Leading with the workdir path and today's date put
  // the two values most likely to have changed at the front, throwing away the match for everything behind
  // them; leading with the static sandbox prose keeps that part shared and confines the break to the tail.
  if (state.env !== undefined) {
    lines.push(state.env);
  }
  if (state.skills) {
    lines.push(
      state.skills.length
        ? `- skills available — call load_skill with an id for its full instructions:\n` +
            state.skills.map((s) => `- ${s.id}: ${s.description}`).join("\n")
        : `- no skills available; do not call load_skill.`,
    );
  }
  if (state.disabledTools) {
    lines.push(
      state.disabledTools.length
        ? `- these declared tools are NOT usable and will fail: ${state.disabledTools.join(", ")}. Say so plainly rather than promising the result.`
        : `- every declared tool is usable again.`,
    );
  }
  if (state.task !== undefined) {
    lines.push(state.task ? state.task : "The mission brief has been cleared.");
  }
  // Most volatile LAST: the workdir changes per project and the date changes daily, so anything placed
  // after them would lose its cached prefix every time either moves.
  if (state.workdir !== undefined) {
    lines.push(`- working directory: ${state.workdir}`);
  }
  if (state.ctx) {
    const { date, model, tz } = state.ctx;
    lines.push(`- date ${date}; model ${model}; time zone ${tz}.`);
  }
  return lines.length ? [lead, ...lines].join("\n") : "";
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
 * Merge each turn's `reminderText` into its content, producing the array actually sent to the model.
 *
 * This is the ONLY place the two are combined, and it happens on the outgoing copy — never on the buffer or on disk. Keeping them
 * apart everywhere else is what lets `content` stay "what the user typed" / "what the tool returned": the UI can render it, the
 * summariser can read it, and a transform that rewrites content (stubbing a stale tool result, stripping images a model cannot see)
 * cannot silently delete operator text the model has already been shown.
 *
 * Position follows the role, and follows the prefix. A user turn is new text on the turn it is emitted, so the block goes at the
 * front where it is read first. A tool turn may already have been sent, so its block goes at the end: that puts any divergence
 * after a result that can run to thousands of characters rather than before it.
 */
export function materializeReminders(msgs: ApiMsg[]): ApiMsg[] {
  if (!msgs.some((m) => (m.role === "user" || m.role === "tool") && m.reminderText)) return msgs;
  return msgs.map((m) => {
    if (m.role === "tool" && m.reminderText) {
      const { reminderText, ...rest } = m;
      return { ...rest, content: rest.content ? `${rest.content}\n\n${reminderText}` : reminderText };
    }
    if (m.role === "user" && m.reminderText) {
      const { reminderText, ...rest } = m;
      if (typeof rest.content === "string") {
        return { ...rest, content: rest.content ? `${reminderText}\n\n${rest.content}` : reminderText };
      }
      // Multimodal: merge into the first text part, so no part is added and the image parts keep their order.
      const parts = [...rest.content];
      const i = parts.findIndex((p) => p.type === "text");
      if (i < 0) return { ...rest, content: [{ type: "text" as const, text: reminderText }, ...parts] };
      const part = parts[i] as { type: "text"; text: string };
      parts[i] = { type: "text", text: `${reminderText}\n\n${part.text}` };
      return { ...rest, content: parts };
    }
    return m;
  });
}

/** Append a block to whatever this turn already carries, so two guards firing in one round do not overwrite each other. */
export function addBlock(existing: string | undefined, block: string): string {
  return existing ? `${existing}\n\n${block}` : block;
}
