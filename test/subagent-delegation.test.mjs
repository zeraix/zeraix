/**
 * Delegation identity and the model-facing text of the concurrent path.
 *
 * Two things are pinned here. First, that the duplicate rule the scheduler coalesces on is the same rule
 * the completed-delegation guard already used — an in-flight twin and a finished twin are the same
 * question asked twice, and recognising only one of them is how a fan-out pays for the same investigation
 * more than once. Second, the wording the model actually reads: these strings are the only thing standing
 * between "wait once in join" and a poll loop, so a rewrite that drops the instruction should fail here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SUBAGENTS,
  delegationSubject,
  findRepeatDelegation,
  isSameDelegation,
  formatSpawnResult,
  formatJoinResult,
  formatAutoDelivery,
  spawnSubagentsTool,
  joinSubagentsTool,
} from "../src/lib/ai/subagents.ts";

const meta = (agent, task) => ({ agent, task, subject: delegationSubject(task) });

test("the same question in flight is recognised as a duplicate", () => {
  const a = meta("explore", "Find all files related to the MarketingBuilder module");
  const b = meta("explore", "Locate everything belonging to the MarketingBuilder module");
  assert.equal(isSameDelegation(a, b), true);
});

test("different subjects are not duplicates, however similar the phrasing", () => {
  // The real failure this guards: the model writes every delegation from one template, so whole-task
  // lexical similarity is high even when the modules differ. Only the naming tokens separate them.
  const a = meta("explore", "Find all files related to the MarketingBuilder module");
  const b = meta("explore", "Find all files related to the CheckoutFlow module");
  assert.equal(isSameDelegation(a, b), false);
});

test("a different sub-agent asking the same thing is not a duplicate", () => {
  const a = meta("explore", "Trace the AuthSession refresh path");
  const b = meta("reviewer", "Trace the AuthSession refresh path");
  assert.equal(isSameDelegation(a, b), false, "role changes what the delegation returns");
});

test("a task with no identifying tokens can never coalesce", () => {
  const a = meta("explore", "look around and tell me what you find");
  const b = meta("explore", "look around and tell me what you find");
  assert.equal(a.subject.size, 0);
  assert.equal(isSameDelegation(a, b), false, "an empty subject must fail open, not match everything");
});

test("findRepeatDelegation returns the entry it matched, conclusion included", () => {
  const prior = [
    { ...meta("explore", "Map the PaymentGateway retry logic"), conclusion: "it retries twice" },
  ];
  const hit = findRepeatDelegation("explore", "Explain the PaymentGateway retry logic", prior);
  assert.equal(hit?.conclusion, "it retries twice");
  assert.equal(findRepeatDelegation("explore", "Map the SearchIndex build", prior), null);
});

test("the spawn result tells the model to keep working, not to join next", () => {
  // The overlap between spawn and join is the only window in which the main agent can do its own work —
  // once inside a blocking join it can run nothing at all. So this text has to push the model into that
  // window rather than through it; an earlier version said "then call join_subagents", which read as an
  // instruction to join immediately and gave the concurrency straight back.
  const text = formatSpawnResult([
    { id: "s1", agent: "explore", coalesced: false },
    { id: "s2", agent: "reviewer", coalesced: false },
  ]);
  assert.match(text, /s1/);
  assert.match(text, /s2/);
  assert.match(text, /go on with your own work/i);
  assert.match(text, /Do NOT call join_subagents next if you still have anything to do/);
  assert.match(text, /block=false/, "the non-blocking collect must be discoverable here");
  assert.match(text, /[Nn]ever call it repeatedly/);
});

test("a non-blocking join that found nothing does not invite a retry", () => {
  // The one wording that could rebuild the poll loop by hand: an empty collect plus "call again" is a
  // spin instruction. It has to end on "carry on" and on the promise that results arrive unasked.
  const empty = formatJoinResult([], [], [], false, false);
  assert.match(empty, /Carry on with your own work/i);
  assert.match(empty, /appended to a later tool result/i);
  assert.doesNotMatch(empty, /call join_subagents again/i);

  const partial = formatJoinResult([], ["s2"], [], false, false);
  assert.match(partial, /Do not call join_subagents again to check/i);
  assert.match(partial, /only block on them once you have nothing else left to do/i);
});

test("a blocking join still tells the model it may block again for what is left", () => {
  const text = formatJoinResult([], ["s2"], [], false, true);
  assert.match(text, /it will block until they finish/i);
});

test("a coalesced spawn says so rather than pretending a second delegation started", () => {
  const text = formatSpawnResult([
    { id: "s1", agent: "explore", coalesced: false },
    { id: "s1", agent: "explore", coalesced: true },
  ]);
  assert.match(text, /identical to a delegation already running/i);
});

test("a refused spawn is reported without claiming any delegation started", () => {
  const text = formatSpawnResult([{ id: "", agent: "nope", coalesced: false, refused: "unknown sub-agent" }]);
  assert.match(text, /No delegations started/);
  assert.doesNotMatch(text, /join_subagents/, "there is nothing to join");
});

test("the join result carries each conclusion with the task it answers", () => {
  const text = formatJoinResult(
    [
      { meta: meta("explore", "Map the AuthSession flow"), id: "s1", state: "done", result: "lives in auth.ts" },
      { meta: meta("reviewer", "Check the SearchIndex change"), id: "s2", state: "done", result: "looks correct" },
    ],
    [],
    [],
    false,
  );
  assert.match(text, /s1 \(explore\) finished/);
  assert.match(text, /Map the AuthSession flow/);
  assert.match(text, /lives in auth\.ts/);
  assert.match(text, /s2 \(reviewer\) finished/);
});

test("a timed-out join says the delegations survive and stay joinable", () => {
  const text = formatJoinResult([], ["s1"], [], true);
  assert.match(text, /Still running after the timeout: s1/);
  assert.match(text, /remain joinable/i);
});

test("an invented id is reported rather than silently ignored", () => {
  const text = formatJoinResult([], [], ["s9"], false);
  assert.match(text, /No delegation exists with id\(s\): s9/);
});

test("auto-delivered results are fenced so they cannot read as the host tool's output", () => {
  const text = formatAutoDelivery([
    { meta: meta("explore", "Map the AuthSession flow"), id: "s1", state: "done", result: "lives in auth.ts" },
  ]);
  assert.match(text, /finished while you were working/i);
  assert.match(text, /\[end of delegation results\]/);
  assert.equal(formatAutoDelivery([]), "", "nothing to deliver must add nothing to the wire");
});

test("both delegation tools declare the sub-agent roles that actually exist", () => {
  const spawn = spawnSubagentsTool();
  const roles = spawn.function.parameters.properties.tasks.items.properties.agent.enum;
  assert.deepEqual(roles, SUBAGENTS.map((a) => a.id));
  // The anti-poll instruction and the keep-working steer are the load-bearing parts of these descriptions.
  assert.match(spawn.function.description, /never poll/i);
  assert.match(spawn.function.description, /KEEP WORKING/);
  const join = joinSubagentsTool();
  assert.match(join.function.description, /SUSPENDS/);
  assert.match(join.function.description, /block=false/);
  assert.deepEqual(join.function.parameters.properties.mode.enum, ["all", "any"]);
  assert.equal(join.function.parameters.properties.block.type, "boolean");
});
