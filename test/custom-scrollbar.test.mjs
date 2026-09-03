/**
 * The custom scrollbar's arithmetic (src/components/CustomScrollbar/logic.ts).
 *
 * Three things a scrollbar gets wrong at the edges, each of which has been a real bug in this one: a thumb clamped
 * to its minimum length that stops short of the end of the track; a drag that scales the pointer's travel by the
 * wrong ratio, so the thumb slides out from under the cursor; and a fade-out timer that measures from the first
 * scroll instead of the last. The fourth is new here: a track shorter than the minimum thumb.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { MIN_THUMB, thumbMetrics, dragScroll, fadeDecision } = await import("../src/components/CustomScrollbar/logic.ts");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);

test("content that does not overflow gets a thumb that fills the track and never moves", () => {
  assert.deepEqual(thumbMetrics(100, 100, 0), { len: 100, pos: 0, travel: 0 });
  assert.deepEqual(thumbMetrics(100, 50, 0), { len: 100, pos: 0, travel: 0 });
  assert.deepEqual(thumbMetrics(100, 100, 40), { len: 100, pos: 0, travel: 0 });
});

test("degenerate sizes yield numbers, never NaN", () => {
  for (const [c, s, o] of [[0, 0, 0], [0, 100, 0], [100, 0, 0], [NaN, 100, 0], [100, NaN, 0], [100, 400, NaN]]) {
    const m = thumbMetrics(c, s, o);
    assert.ok(Number.isFinite(m.len) && Number.isFinite(m.pos) && Number.isFinite(m.travel), `${c},${s},${o}: ${JSON.stringify(m)}`);
  }
});

test("a proportional thumb spans the track exactly from the start to the end of the content", () => {
  // 200px track over 800px of content: a quarter is visible, and a 50px thumb is above the floor.
  const top = thumbMetrics(200, 800, 0);
  near(top.len, 50, "a quarter of the content is visible, so the thumb is a quarter of the track");
  near(top.pos, 0);
  const bottom = thumbMetrics(200, 800, 600); // 600 is the maximum scrollTop
  near(bottom.pos + bottom.len, 200, "at the end of the content the thumb ends at the end of the track");
  const middle = thumbMetrics(200, 800, 300);
  near(middle.pos, 75, "halfway through the content, halfway along its travel");
});

test("a thumb clamped to its minimum length still reaches the end of the track", () => {
  const m = thumbMetrics(100, 100_000, 100_000 - 100);
  assert.equal(m.len, MIN_THUMB, "1/1000th of the track is unusable; the floor applies");
  near(m.pos + m.len, 100, "the naive offset/scroll ratio would stop it 29px short");
});

test("a track shorter than the minimum thumb caps the thumb at the track, and it stays put", () => {
  // Before: len 30 in a 20px track, travel −10, so scrolling pushed the thumb UP off the top of the track.
  const m = thumbMetrics(20, 200, 180);
  assert.equal(m.len, 20);
  assert.equal(m.travel, 0);
  assert.equal(m.pos, 0, "no negative offsets");
  assert.equal(dragScroll(20, 200, 0, 10), null, "and there is no room to drag it, so a drag is a no-op");
});

test("an overscroll offset cannot carry the thumb past either end of the track", () => {
  const bounceTop = thumbMetrics(100, 400, -60);
  assert.equal(bounceTop.pos, 0);
  const bounceBottom = thumbMetrics(100, 400, 360);
  near(bounceBottom.pos + bounceBottom.len, 100);
});

test("dragging the thumb by its whole travel scrolls the content to its end, and by half to the middle", () => {
  const { travel } = thumbMetrics(100, 1000, 0);
  near(dragScroll(100, 1000, 0, travel), 900, "full travel = maximum scrollTop");
  near(dragScroll(100, 1000, 0, travel / 2), 450);
  near(dragScroll(100, 1000, 300, -travel / 3), 0, "and it works from a mid-scroll start, in either direction");
  assert.equal(dragScroll(100, 100, 0, 10), null, "nothing to scroll: leave the content alone");
});

test("a drag round-trips through the painted position: the thumb stays under the cursor", () => {
  // Wherever the drag lands the content, painting that offset puts the thumb exactly where the pointer moved it.
  const start = thumbMetrics(100, 5000, 1200);
  const moved = dragScroll(100, 5000, 1200, 17);
  const after = thumbMetrics(100, 5000, moved);
  near(after.pos - start.pos, 17);
});

test("the fade-out waits for the LAST reveal, sleeping only for what remains of the delay", () => {
  // Armed at t=0 for 1200ms; the user kept scrolling until t=900; the timer fires at t=1200.
  assert.deepEqual(fadeDecision(1200, 900, 1200, false), { hide: false, ms: 900 });
  // Fires again at t=2100 with no scroll since t=900: hide.
  assert.deepEqual(fadeDecision(1200, 900, 2100, false), { hide: true });
  assert.deepEqual(fadeDecision(1200, 0, 1200, false), { hide: true }, "exactly on time is time");
});

test("the fade-out holds while the thumb is hovered or dragged, then re-checks a full delay later", () => {
  assert.deepEqual(fadeDecision(1200, 0, 1200, true), { hide: false, ms: 1200 });
  assert.deepEqual(fadeDecision(1200, 900, 1200, true), { hide: false, ms: 900 }, "still counting down: wait for that first");
});

test("the fade-out never sleeps longer than one delay, and a zero delay hides at once", () => {
  assert.deepEqual(fadeDecision(1200, 5000, 1000, false), { hide: false, ms: 1200 }, "a reveal 'from the future' cannot park the bar for good");
  assert.deepEqual(fadeDecision(0, 0, 0, false), { hide: true });
  assert.deepEqual(fadeDecision(0, 0, 5, true), { hide: false, ms: 0 }, "held with no delay: re-check on the next tick");
});
