/**
 * Which transcript a round writes onto (src/app/agent/chat/displayBaseline.ts).
 *
 * The bug these exist for, as reported: running two sessions at once, the transcript of a conversation goes
 * blank except for the round currently generating — every user message and every earlier step gone. Switching
 * to another conversation and back does NOT fix it; restarting the app does.
 *
 * Those three facts together are the whole diagnosis. The archive is intact (restart restores it), so only the
 * view was damaged; and the damage is re-applied while the round runs (switching back does not help), so it is
 * not a one-off write but something the round keeps doing on every streamed delta.
 *
 * It was `const liveBase = active() ? displayRef.current : []`, captured once at the start of the round and
 * consumed under an `active()` check made later. A background round captured `[]`, the user switched back,
 * `active()` flipped to true, and every delta then wrote `[...[], ...items]`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { baselineFor, newRoundBaseline } = await import("../src/app/agent/chat/displayBaseline.ts");

const msg = (t) => ({ kind: "user", content: t });
/** A transcript with real history in it, the thing that went missing. */
const history = [msg("first question"), msg("second question"), msg("third question")];

const view = (owner, epoch, display) => ({ token: { owner, epoch }, display });

// ── The reported failure ────────────────────────────────────────────────────────────────────────────────

test("a round that began in the background does not wipe the transcript when the user switches back", () => {
  const st = newRoundBaseline();
  // 1. Conversation A is generating while the user reads B. The round renders nothing: the transcript on
  //    screen is B's, and writing to it would put A's rows in B's conversation.
  assert.equal(baselineFor(st, view("B", 1, [msg("B's own history")]), "A"), null);

  // 2. The user switches back to A. `swapInConversation` rebuilds A's transcript from the archive, which
  //    bumps the epoch and names A as the owner.
  const base = baselineFor(st, view("A", 2, history), "A");

  // 3. The next delta must append to A's history — not replace it. This is the assertion that fails against
  //    the old code, where the baseline was the `[]` captured back at step 1.
  assert.deepEqual(base, history);
  assert.equal(base.length, 3, "the transcript above the round survived the switch back");
});

test("and it keeps surviving: every later delta in the same round sees the same baseline", () => {
  // The reason switching away and back did not fix the old bug: the stale baseline was re-applied on every
  // delta, so the correctly rebuilt transcript was wiped again a moment later.
  const st = newRoundBaseline();
  baselineFor(st, view("B", 1, []), "A");
  const v = view("A", 2, history);
  for (let delta = 0; delta < 5; delta++) {
    assert.deepEqual(baselineFor(st, v, "A"), history, `delta ${delta} lost the transcript`);
  }
});

// ── It must not overcorrect ─────────────────────────────────────────────────────────────────────────────

test("a stable view keeps ONE baseline, so streaming appends to a fixed prefix", () => {
  // Re-taking on every delta would be the opposite bug: renderTurn writes [...base, ...items] into the
  // display, so a baseline re-read from the display each time would swallow the previous delta's items and
  // grow without bound.
  const st = newRoundBaseline();
  const v = view("A", 7, history);
  const first = baselineFor(st, v, "A");
  const grown = { token: v.token, display: [...history, msg("this round's own row")] };
  assert.equal(baselineFor(st, grown, "A"), first, "the baseline moved without the view being rebuilt");
});

test("a round never writes onto another conversation's transcript", () => {
  const st = newRoundBaseline();
  baselineFor(st, view("A", 1, history), "A"); // established while active
  // The user switches away. The id moves before the rebuild lands, which is exactly the window `active()`
  // cannot see; the owner is what closes it.
  assert.equal(baselineFor(st, view("B", 2, [msg("B's history")]), "A"), null);
  // ...and switching back re-establishes it against whatever the archive rebuilt.
  const back = [...history, msg("a message sent from elsewhere")];
  assert.deepEqual(baselineFor(st, view("A", 3, back), "A"), back);
});

test("a rebuild of the SAME conversation still re-takes the baseline", () => {
  // Same owner, new epoch: loadConversation rebuilt A's transcript from the archive, so the array held from
  // before that rebuild is a different one and must not be written back over it.
  const st = newRoundBaseline();
  const before = baselineFor(st, view("A", 1, history), "A");
  const rebuilt = [...history, msg("persisted while the round ran")];
  const after = baselineFor(st, view("A", 2, rebuilt), "A");
  assert.notEqual(after, before);
  assert.deepEqual(after, rebuilt);
});

test("with no conversation on screen, nothing is rendered", () => {
  const st = newRoundBaseline();
  assert.equal(baselineFor(st, view(null, 1, []), "A"), null);
});
