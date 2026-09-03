/**
 * The scrollbar's arithmetic, kept pure so its edge cases can be pinned down without a DOM: the clamped thumb that
 * still has to reach the end of the track, the drag that has to land the content where the cursor says, and the
 * fade-out that has to wait for the LAST scroll rather than the first.
 */

/** Floor on the thumb's length, so a very long scroll area still leaves something grabbable. */
export const MIN_THUMB = 30;

export interface ThumbMetrics {
  /** Thumb length in px — never longer than the track itself. */
  len: number;
  /** Thumb offset along the track in px. */
  pos: number;
  /** How far the thumb can travel (track minus thumb); 0 when it cannot move at all. */
  travel: number;
}

/**
 * Where the thumb goes for a track of `client` px showing `scroll` px of content scrolled to `offset`.
 *
 * The scroll range is spread over the track the thumb can actually travel (track minus thumb), not the naive
 * offset/scroll ratio: that ratio assumes an unclamped thumb, and once MIN_THUMB kicks in on long content the bar
 * would stop short of the end. The thumb is also capped at the track's own length — a track shorter than MIN_THUMB
 * used to get a thumb longer than itself, pushed off the top as the content scrolled. And the offset is clamped
 * to the scroll range, so an overscroll bounce cannot carry the thumb past the track either.
 */
export function thumbMetrics(client: number, scroll: number, offset: number, minThumb = MIN_THUMB): ThumbMetrics {
  if (!(client > 0) || !(scroll > client)) return { len: client > 0 ? client : 0, pos: 0, travel: 0 };
  const len = Math.min(client, Math.max((client / scroll) * client, minThumb));
  const travel = client - len;
  const max = scroll - client;
  const clamped = Math.min(Math.max(offset || 0, 0), max);
  return { len, pos: travel > 0 ? (clamped / max) * travel : 0, travel };
}

/**
 * The content offset a drag has reached: the pointer's travel along the track, scaled back into scroll units —
 * `thumbMetrics` inverted, so the thumb stays under the cursor. Null when the thumb cannot move (nothing to
 * scroll, or a track with no room), so the caller leaves the content where it is.
 */
export function dragScroll(
  client: number,
  scroll: number,
  startOffset: number,
  pointerDelta: number,
  minThumb = MIN_THUMB,
): number | null {
  const { travel } = thumbMetrics(client, scroll, startOffset, minThumb);
  if (travel <= 0) return null;
  return startOffset + (pointerDelta / travel) * (scroll - client);
}

/**
 * What the fade-out timer does when it fires: hide, or sleep again for `ms`.
 *
 * The bar is revealed on every scroll event, but the timer is armed once and reads WHEN the bar was last revealed,
 * so it hides `hideDelay` after the last scroll without being cleared and re-armed per event. While the pointer is
 * parked on the thumb or a drag is running it keeps waiting — otherwise it would fade out from under the cursor
 * exactly as the user reaches for it. It never sleeps longer than one delay, whatever the clocks say.
 */
export function fadeDecision(
  hideDelay: number,
  lastRevealAt: number,
  now: number,
  held: boolean,
): { hide: true } | { hide: false; ms: number } {
  const remaining = hideDelay - (now - lastRevealAt);
  if (remaining > 0) return { hide: false, ms: Math.min(remaining, hideDelay) };
  if (held) return { hide: false, ms: hideDelay };
  return { hide: true };
}
