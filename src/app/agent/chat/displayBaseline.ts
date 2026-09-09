"use client";

import type { DisplayMsg } from "./types";

/**
 * Which transcript a round's streamed output may be written onto, and what it must be appended to.
 *
 * ## The bug this exists for
 *
 * A round rendered itself as `[...liveBase, ...items]`, where `liveBase` was captured ONCE when the round
 * started:
 *
 * ```ts
 * const liveBase = active() ? displayRef.current : [];   // captured at round start
 * const renderTurn = (…) => { if (!active()) return; setDisplay([...liveBase, ...items]); };
 * ```
 *
 * The capture is conditioned on `active()` and the write re-checks `active()` — and the two can disagree,
 * because `active()` is `convIdRef.current === genConvId` and `convIdRef` moves the instant the user clicks
 * another conversation. So, with two sessions running (the reported workflow):
 *
 *  1. conversation A generates in the background while the user reads B — the round starts inactive, so
 *     `liveBase` is `[]`;
 *  2. the user switches back to A. `setConvId` writes `convIdRef` SYNCHRONOUSLY, so `active()` is now true,
 *     while `swapInConversation` is still awaiting `setWorkingDir` and has not rebuilt the transcript yet;
 *  3. the next streamed delta passes the `active()` guard and writes `[...[], ...items]` — the whole
 *     transcript above is replaced by this round's few rows.
 *
 * And it does not recover: `liveBase` stays `[]` for the rest of the round, so every later delta wipes the
 * transcript again, including the one `swapInConversation` had just rebuilt correctly. That is why switching
 * away and back does not fix it while the round is running, and why restarting does — the archive was never
 * truncated, only the view.
 *
 * ## The fix
 *
 * A baseline is only valid for the exact transcript it was taken from. `ViewToken` names that transcript: who
 * it belongs to, and which rebuild of it this is. The baseline is re-taken whenever the token moves, and the
 * round declines to write at all when the transcript on screen is not its own — which `active()` alone cannot
 * tell, since `convIdRef` leads the rebuilt display by one await.
 */

/** Identifies the transcript currently in `displayRef`: whose it is, and which rebuild of it. */
export interface ViewToken {
  /** The conversation whose messages are in the display array right now. */
  owner: string | null;
  /**
   * Bumped every time the display is REPLACED wholesale by something other than a round's own render — a
   * conversation switch, a new conversation, a cleared one. Rounds append; these replace, and a baseline
   * taken before one of them describes an array that is no longer on screen.
   */
  epoch: number;
}

/** One round's memory of the transcript it is appending to. Created per round; mutated as the view moves. */
export interface RoundBaseline {
  base: DisplayMsg[] | null;
  /** The token the baseline was taken against, or null when nothing has been taken yet. */
  token: ViewToken | null;
}

export const newRoundBaseline = (): RoundBaseline => ({ base: null, token: null });

const sameToken = (a: ViewToken | null, b: ViewToken) => !!a && a.owner === b.owner && a.epoch === b.epoch;

/**
 * The array this round should append its rendered items to, or `null` when it must not render at all.
 *
 * `null` means the transcript on screen belongs to another conversation — during a switch the id moves before
 * the transcript does, so this is the check that `active()` cannot make. Rendering then would append one
 * conversation's rows to another's transcript.
 *
 * Otherwise the baseline is re-taken whenever the view token has moved, which covers both ways a frozen
 * baseline goes stale: a round that began while its conversation was in the background (there was no
 * transcript to take a baseline from), and a switch away and back (the transcript was rebuilt from the
 * archive, so the array held here is a different one). Between those events the baseline is stable, so
 * streaming appends to a fixed prefix rather than growing it delta by delta.
 */
export function baselineFor(
  state: RoundBaseline,
  view: { token: ViewToken; display: DisplayMsg[] },
  roundConvId: string,
): DisplayMsg[] | null {
  if (view.token.owner !== roundConvId) return null;
  if (!sameToken(state.token, view.token)) {
    state.base = view.display;
    state.token = view.token;
  }
  return state.base;
}
