/**
 * Enter vs. the input method editor.
 *
 * An IME turns keystrokes into a *composition* — an underlined buffer the user is still editing — and
 * Enter is one of the keys that commits it. A handler that treats every Enter as "submit" therefore fires
 * in the middle of someone typing, sending a half-finished message or confirming a rename against a
 * partial name. Nothing in this codebase guarded against it, so every Enter-to-submit surface had the bug.
 *
 * The case that makes it constant rather than occasional: typing **English on a Chinese IME**. Committing
 * Chinese normally ends with Space or a candidate number, so Enter rarely comes up — but Latin letters
 * produce no candidate worth picking, and Enter is the natural way to commit them literally. Users doing
 * that hit this on the first word.
 *
 * Three clauses, because browsers disagree about what Enter looks like at the moment of commit:
 *
 *  1. `isComposing` — the spec answer, and what Chromium reports: keydown fires with `isComposing: true`
 *     and `compositionend` follows.
 *  2. `keyCode === 229` — the legacy "key belongs to the IME" sentinel, still what some Windows IMEs send.
 *  3. A short window after `compositionend` — for the opposite event order, where `compositionend` is
 *     dispatched BEFORE the keydown that caused it (WebKit's long-standing behaviour, and reported of
 *     Chromium on macOS with some IMEs). In that order the first two clauses are both false by the time
 *     the handler runs, and the composition state has already been torn down, so the only remaining
 *     evidence that this Enter was a commit is that a commit just happened.
 *
 * Clause 3 is the one that can misfire, by ignoring an Enter the user genuinely meant. The window is set
 * far below a human gap between two deliberate keystrokes — committing a composition and then reaching
 * for Enter again is well over 100ms — so in practice it only ever catches the same physical keypress.
 */
import { useRef } from "react";

/**
 * How long after `compositionend` an Enter is still assumed to belong to that commit.
 *
 * The two orders this has to separate are a same-keypress commit (sub-millisecond — the events are
 * dispatched in one input-processing pass) and a deliberate second keypress (>100ms for any human). 50ms
 * sits between them with an order of magnitude of slack either way.
 */
export const IME_COMMIT_GRACE_MS = 50;

/** The composition-relevant fields of a keyboard event, so the decision below can be tested without a DOM. */
export interface ImeKey {
  isComposing: boolean;
  keyCode: number;
}

/** What the guard remembers between events. */
export interface ImeState {
  composing: boolean;
  /** Timestamp of the last `compositionend`, or 0 if there has not been one. */
  endedAt: number;
}

/**
 * Whether this keypress belongs to the IME rather than to the application.
 *
 * Pure and separated from the hook so the three clauses can be exercised directly — the whole point of
 * this module is behaviour under event orders that are awkward to reproduce and impossible to reproduce
 * on a machine without the relevant IME installed.
 */
export function isImeKey(e: ImeKey, state: ImeState, now: number): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  if (state.composing) return true;
  return state.endedAt > 0 && now - state.endedAt < IME_COMMIT_GRACE_MS;
}

/**
 * Track composition state for one text field.
 *
 * Spread `bind` onto the input/textarea and call `isImeKey(e)` at the top of the key handler, returning
 * early when it is true. Return early WITHOUT `preventDefault`: the keypress is the IME's, and swallowing
 * it would stop the commit it was meant to perform.
 */
export function useImeGuard() {
  const state = useRef<ImeState>({ composing: false, endedAt: 0 });

  const bind = {
    onCompositionStart: () => {
      state.current.composing = true;
    },
    onCompositionEnd: () => {
      state.current.composing = false;
      state.current.endedAt = Date.now();
    },
  };

  return {
    bind,
    /** True when this key event is the IME's business — return early, and do not preventDefault. */
    isImeKey: (e: { nativeEvent: { isComposing?: boolean }; keyCode: number }) =>
      isImeKey(
        { isComposing: Boolean(e.nativeEvent?.isComposing), keyCode: e.keyCode },
        state.current,
        Date.now(),
      ),
  };
}
