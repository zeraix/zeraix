/**
 * The `/goal` mechanism: command parsing, the state machine, the evaluator's contract, and the loop's
 * completion condition.
 *
 * What is pinned here is the set of rules that make a goal-driven loop different from a retry loop, and each
 * one is a failure that would be invisible in review:
 *
 *  - the agent cannot declare itself finished (no reducer produces `achieved` except the evaluator's verdict);
 *  - the agent cannot restate a user's condition in easier terms;
 *  - a failing evaluation is not a verdict — it never completes the goal and never wedges the loop;
 *  - the round limit stops the loop without ever claiming success;
 *  - resume restores the condition but not the counters of a run that is no longer happening.
 *
 * No model and no React: every module under test is pure, which is why they were built that way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// These modules import each other extensionlessly (bundler resolution), which node does not do on its own.
// Registered before the dynamic imports below; a static import would be hoisted above this call and fail.
register("./helpers/srcResolve.mjs", import.meta.url);
const { parseGoalCommand, GOAL_CLEAR_ALIASES } = await import("../src/app/agent/chat/goalCommand.ts");
const { parseVerdict, createGoalEvaluator } = await import("../src/app/agent/chat/goalEvaluator.ts");
const {
  emptyGoal,
  isGoalActive,
  isGoalEmpty,
  startGoal,
  clearGoal,
  achieveGoal,
  recordEvaluation,
  addTurnSpend,
  setCriteria,
  applyPlan,
  recordEvidence,
  todosFromGoal,
  applyTodoStatuses,
  restoreGoal,
  toStoredGoal,
  normalizeGoal,
  renderGoalState,
  decideNextRound,
  GOAL_CONDITION_WARN,
  MAX_GOAL_AUTO_ROUNDS,
} = await import("../src/app/agent/chat/goalState.ts");

const NOW = 1_700_000_000_000;
const started = (condition = "all tests pass") => startGoal(condition, { now: NOW, source: "user" });

/* ------------------------------------------------------------------ command parsing */

test("a plain message is not a command", () => {
  assert.equal(parseGoalCommand("what does /goal do?").kind, "none");
  assert.equal(parseGoalCommand("/goalkeeper stats").kind, "none");
  assert.equal(parseGoalCommand("/compact").kind, "none");
});

test("/goal with no argument asks for status", () => {
  assert.equal(parseGoalCommand("/goal").kind, "status");
  assert.equal(parseGoalCommand("  /goal   ").kind, "status");
});

test("/goal <condition> carries the condition verbatim", () => {
  const cmd = parseGoalCommand("/goal   npm test passes and the login page renders  ");
  assert.deepEqual(cmd, { kind: "set", condition: "npm test passes and the login page renders", long: false });
});

test("a multi-line condition survives parsing intact", () => {
  const cmd = parseGoalCommand("/goal fix the build:\n- typecheck clean\n- tests green");
  assert.equal(cmd.kind, "set");
  assert.equal(cmd.condition, "fix the build:\n- typecheck clean\n- tests green");
});

test("every documented clear alias clears", () => {
  for (const alias of ["clear", "stop", "off", "reset", "none", "cancel", "STOP", "Clear"]) {
    assert.equal(parseGoalCommand(`/goal ${alias}`).kind, "clear", alias);
  }
  // The list the error message offers must be the list that actually works.
  for (const alias of GOAL_CLEAR_ALIASES) assert.equal(parseGoalCommand(`/goal ${alias}`).kind, "clear", alias);
});

test("a single word that looks like a fumbled clear alias is questioned, not made the goal", () => {
  // The real failure this guards: a typo'd subcommand starting a self-driving loop toward a nonsense
  // condition. `stpo` is one edit from `stop`, so it is asked about rather than acted on.
  assert.deepEqual(parseGoalCommand("/goal stpo"), { kind: "error", code: "unknownSub", detail: "stpo" });
  assert.equal(parseGoalCommand("/goal clea").kind, "error");
  assert.equal(parseGoalCommand("/goal offf").kind, "error");
});

test("an ordinary single word IS the goal", () => {
  // The bug: every single word was refused, including ones no reasonable person would read as a subcommand —
  // and the refusal message itself said "/goal <condition> to set a goal", which is what the user had typed.
  for (const word of ["ship", "deploy", "refactor", "green"]) {
    assert.deepEqual(
      parseGoalCommand(`/goal ${word}`),
      { kind: "set", condition: word, long: false },
      word,
    );
  }
});

test("/goal set <condition> consumes the subcommand instead of keeping it in the goal", () => {
  // The bug: `/goal set deploy the site` set a goal literally called "set deploy the site", so the loop drove
  // toward an instruction with a stray verb in front of it.
  assert.deepEqual(parseGoalCommand("/goal set deploy the site"), {
    kind: "set",
    condition: "deploy the site",
    long: false,
  });
  // Case and spacing are the user's business, not the parser's.
  assert.equal(parseGoalCommand("/goal SET   ship it  ").condition, "ship it");
  // And it is the escape hatch for a word that would otherwise be read as a typo.
  assert.deepEqual(parseGoalCommand("/goal set clea"), { kind: "set", condition: "clea", long: false });
});

test("/goal set with nothing after it is reported rather than becoming a goal called \"set\"", () => {
  assert.deepEqual(parseGoalCommand("/goal set"), { kind: "error", code: "unknownSub", detail: "set" });
});

test("a clear alias still clears even though single words now set", () => {
  // The one case that must not regress: the aliases are checked before anything is treated as a condition.
  for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
    assert.equal(parseGoalCommand(`/goal ${alias}`).kind, "clear", alias);
  }
});

test("a long condition is accepted in full, never refused and never truncated", () => {
  // It is the user's own requirement. Refusing it says their requirement is inadmissible; cutting it in half
  // would leave the loop driving toward a condition they never wrote.
  const long = "x ".repeat(GOAL_CONDITION_WARN);
  const cmd = parseGoalCommand(`/goal ${long}`);
  assert.equal(cmd.kind, "set");
  assert.equal(cmd.condition, long.trim());
  // ...but it is flagged, because a condition is re-sent every round rather than paid for once.
  assert.equal(cmd.long, true);
});

test("an ordinary condition is not flagged as long", () => {
  const cmd = parseGoalCommand("/goal all tests pass");
  assert.equal(cmd.kind, "set");
  assert.equal(cmd.long, false);
});

test("a long condition survives into the state uncut", () => {
  const long = "y ".repeat(GOAL_CONDITION_WARN).trim();
  const g = startGoal(long, { now: NOW, source: "user" });
  assert.equal(g.condition, long);
  assert.equal(g.condition.length, long.length);
  // And back off disk unchanged: truncating on the way through persistence would be the same bug, later.
  assert.equal(restoreGoal(JSON.parse(JSON.stringify(toStoredGoal(g)))).condition, long);
});

/* ------------------------------------------------------------------ goal creation */

test("starting a goal makes it active with a fresh run", () => {
  const g = started("the suite is green");
  assert.equal(isGoalActive(g), true);
  assert.equal(g.condition, "the suite is green");
  assert.equal(g.conditionSource, "user");
  assert.deepEqual([g.run.turnCount, g.run.tokenSpend, g.run.startedAt], [0, 0, NOW]);
});

test("a replacement goal inherits nothing from the one it displaces", () => {
  let g = started("old condition");
  g = applyPlan(g, { steps: ["step one"] }).goal;
  g = recordEvaluation(g, { reason: "not yet", tokens: 500 });
  const next = startGoal("new condition", { now: NOW + 1000, source: "user" });
  assert.equal(next.plan.steps.length, 0);
  assert.equal(next.run.turnCount, 0);
  assert.equal(next.run.tokenSpend, 0);
});

/* ------------------------------------------------------------------ criteria: the anti-lowering rule */

test("set_goal on an empty state declares the goal and activates it", () => {
  const { goal, ok } = setCriteria(emptyGoal(), {
    objective: "users can sign in",
    acceptanceCriteria: [{ text: "npm test passes" }, { text: "/api/me returns 401 when unauthenticated" }],
  }, { now: NOW });
  assert.equal(ok, true);
  assert.equal(isGoalActive(goal), true);
  assert.equal(goal.conditionSource, "model");
  assert.equal(goal.criteria.length, 2);
});

test("set_goal cannot restate a condition the user wrote", () => {
  // The failure this prevents: an agent that cannot satisfy "and the tests pass" quietly rewriting the goal
  // without that clause and then meeting the easier one.
  const user = started("login works AND the whole test suite passes");
  const { goal, ok, message } = setCriteria(user, {
    objective: "login works",
    acceptanceCriteria: [{ text: "the login form submits" }],
  }, { now: NOW });
  assert.equal(ok, true);
  assert.equal(goal.condition, "login works AND the whole test suite passes");
  assert.equal(goal.conditionSource, "user");
  assert.match(message, /has NOT been changed/);
});

test("a model-authored condition may be refined by the model that wrote it", () => {
  const first = setCriteria(emptyGoal(), {
    objective: "make it work",
    acceptanceCriteria: [{ text: "it runs" }],
  }, { now: NOW }).goal;
  const second = setCriteria(first, {
    objective: "the dev server starts and serves the home page",
    acceptanceCriteria: [{ text: "curl localhost:3000 returns 200" }],
  }, { now: NOW }).goal;
  assert.equal(second.condition, "the dev server starts and serves the home page");
});

test("set_goal without checkable criteria is refused", () => {
  const res = setCriteria(emptyGoal(), { objective: "make it good", acceptanceCriteria: [] }, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(isGoalEmpty(res.goal), true);
});

/* ------------------------------------------------------------------ plan */

test("a plan is recorded, revised, and never touches the condition", () => {
  let g = started("the suite is green");
  g = applyPlan(g, { steps: ["read the failing test", "fix it"], rationale: "start from the failure" }).goal;
  assert.equal(g.plan.revision, 1);
  assert.equal(g.plan.steps.length, 2);

  const revised = applyPlan(g, { steps: ["rewrite the module"], rationale: "the first approach cannot work" });
  assert.equal(revised.goal.plan.revision, 2);
  assert.equal(revised.goal.condition, "the suite is green");
  assert.match(revised.message, /goal condition is unchanged/);
});

test("re-planning carries step statuses over by title", () => {
  let g = started();
  g = applyPlan(g, { steps: [{ title: "read the code", status: "completed" }, { title: "fix it" }] }).goal;
  g = applyPlan(g, { steps: [{ title: "read the code" }, { title: "fix it differently" }] }).goal;
  // Work already done is not silently reset by a re-plan around a blocker.
  assert.equal(g.plan.steps[0].status, "completed");
  assert.equal(g.plan.steps[1].status, "pending");
});

test("a failed step is not a failed goal", () => {
  let g = started();
  g = applyPlan(g, { steps: [{ title: "run the migration", status: "failed" }], blockers: ["no DB credentials"] }).goal;
  assert.equal(isGoalActive(g), true);
  assert.equal(g.status, "active");
  assert.deepEqual(g.blockers, ["no DB credentials"]);
});

test("a plan without a goal is refused", () => {
  const res = applyPlan(emptyGoal(), { steps: ["do something"] });
  assert.equal(res.ok, false);
  // The refusal now points at /goal rather than at set_goal: the model has no tool for setting a goal, so
  // telling it to call one would send it after something that does not exist. The behaviour under test —
  // a plan is refused when there is no goal to plan for — is unchanged.
  assert.match(res.message, /No goal is set/);
  assert.doesNotMatch(res.message, /set_goal/, "must not name a tool the model cannot call");
});

/* ------------------------------------------------------------------ todo synchronisation */

test("the plan and the checklist are one list seen from two sides", () => {
  let g = started();
  g = applyPlan(g, {
    steps: [{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }, { title: "c", status: "failed" }],
  }).goal;
  assert.deepEqual(todosFromGoal(g), [
    { title: "a", status: "completed" },
    { title: "b", status: "in_progress" },
    // The panel has three states; a failed step is simply not done from the user's point of view.
    { title: "c", status: "pending" },
  ]);
});

test("ticking a checklist item folds back into the plan", () => {
  let g = started();
  g = applyPlan(g, { steps: ["a", "b"] }).goal;
  g = applyTodoStatuses(g, [{ title: "a", status: "completed" }, { title: "b", status: "pending" }]);
  assert.equal(g.plan.steps[0].status, "completed");
});

test("a checklist that does not match the plan cannot corrupt it", () => {
  let g = started();
  g = applyPlan(g, { steps: [{ title: "run the migration", status: "failed" }] }).goal;
  const after = applyTodoStatuses(g, [{ title: "something else entirely", status: "completed" }]);
  assert.equal(after.plan.steps[0].status, "failed");
});

test("un-ticking does not overwrite a harder truth the plan recorded", () => {
  let g = started();
  g = applyPlan(g, { steps: [{ title: "run the migration", status: "failed" }] }).goal;
  const after = applyTodoStatuses(g, [{ title: "run the migration", status: "pending" }]);
  assert.equal(after.plan.steps[0].status, "failed");
});

/* ------------------------------------------------------------------ sub-agent write-back */

test("a sub-agent conclusion is written back and survives as established fact", () => {
  let g = started();
  g = recordEvidence(g, { source: "run_subagent", summary: "the auth middleware lives in src/mw/auth.ts" });
  assert.equal(g.evidence.length, 1);
  assert.equal(g.evidence[0].source, "run_subagent");
});

test("the evidence log is bounded rather than growing with the run", () => {
  let g = started();
  for (let i = 0; i < 30; i++) g = recordEvidence(g, { source: "run_subagent", summary: `finding ${i}` });
  assert.ok(g.evidence.length <= 12, `bounded, got ${g.evidence.length}`);
  // The newest survive: the tail is what the evaluator needs.
  assert.match(g.evidence[g.evidence.length - 1].summary, /finding 29/);
});

test("evidence on a goal-less state is dropped rather than inventing a goal", () => {
  assert.equal(recordEvidence(emptyGoal(), { source: "x", summary: "y" }).evidence.length, 0);
});

/* ------------------------------------------------------------------ the evaluator's contract */

test("a clean JSON verdict is read", () => {
  assert.deepEqual(parseVerdict('{"met": true, "reason": "tests passed"}'), { met: true, reason: "tests passed" });
});

test("a fenced or chatty reply still yields its verdict", () => {
  assert.deepEqual(parseVerdict('```json\n{"met": false, "reason": "no test run"}\n```'), {
    met: false,
    reason: "no test run",
  });
  assert.deepEqual(parseVerdict('Sure!\n{"met": false, "reason": "still failing"}\nHope that helps.'), {
    met: false,
    reason: "still failing",
  });
});

test("a non-boolean `met` is not a verdict", () => {
  // Coercing "true" would let a confused model complete a goal by accident, which is the one error that
  // cannot be recovered from — the task simply ends.
  assert.equal(parseVerdict('{"met": "true", "reason": "done"}'), null);
  assert.equal(parseVerdict('{"reason": "done"}'), null);
  assert.equal(parseVerdict("the goal is met"), null);
  assert.equal(parseVerdict(""), null);
});

const reply = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 10 } });

test("the evaluator is never given tools", () => {
  const seen = [];
  const evaluate = createGoalEvaluator(async (messages, tools) => {
    seen.push(tools);
    return reply('{"met": true, "reason": "ok"}');
  });
  return evaluate({ condition: "c", criteria: [], established: [], messages: [] }).then(() => {
    // Judging must not be able to change anything; passing no tool array is what guarantees it structurally.
    assert.deepEqual(seen, [undefined]);
  });
});

test("a malformed reply is retried exactly once, then gives up without a verdict", async () => {
  let calls = 0;
  const evaluate = createGoalEvaluator(async () => {
    calls++;
    return reply("I think it's probably fine");
  });
  const out = await evaluate({ condition: "c", criteria: [], established: [], messages: [] });
  assert.equal(calls, 2);
  assert.equal(out.ok, false);
  // Tokens spent on both attempts are still reported, so the loop's accounting stays honest.
  assert.equal(out.tokens, 20);
});

test("a retry that returns valid JSON is accepted", async () => {
  let calls = 0;
  const evaluate = createGoalEvaluator(async () => {
    calls++;
    return reply(calls === 1 ? "hmm" : '{"met": false, "reason": "the test never ran"}');
  });
  const out = await evaluate({ condition: "c", criteria: [], established: [], messages: [] });
  assert.equal(out.ok, true);
  assert.equal(out.verdict.met, false);
});

test("a transport failure resolves rather than throwing", async () => {
  const evaluate = createGoalEvaluator(async () => {
    throw new Error("ECONNREFUSED");
  });
  const out = await evaluate({ condition: "c", criteria: [], established: [], messages: [] });
  // The loop must never hang on the evaluator, and the user's next message must never be blocked by it.
  assert.equal(out.ok, false);
  assert.match(out.error, /ECONNREFUSED/);
});

test("the condition, the criteria and sub-agent findings all reach the evaluator", async () => {
  let sent = "";
  const evaluate = createGoalEvaluator(async (messages) => {
    sent = messages.map((m) => m.content).join("\n");
    return reply('{"met": false, "reason": "x"}');
  });
  await evaluate({
    condition: "the suite is green",
    criteria: ["npm test exits 0"],
    established: ["run_subagent: the failing test is in auth.test.ts"],
    messages: [{ role: "user", content: "please fix the tests" }],
  });
  assert.match(sent, /the suite is green/);
  assert.match(sent, /npm test exits 0/);
  assert.match(sent, /auth\.test\.ts/);
  assert.match(sent, /please fix the tests/);
});

/* ------------------------------------------------------------------ the loop's completion condition */

test("a met verdict stops the loop", () => {
  const g = started();
  assert.deepEqual(decideNextRound(g, { met: true, reason: "all green" }), { action: "stop", prompt: "" });
});

test("an unmet verdict continues automatically, carrying the reason as the instruction", () => {
  const g = started("the suite is green");
  const d = decideNextRound(g, { met: false, reason: "auth.test.ts still fails" });
  assert.equal(d.action, "continue");
  // The reason is what the next round acts on, so it has to be in the prompt.
  assert.match(d.prompt, /auth\.test\.ts still fails/);
  assert.match(d.prompt, /the suite is green/);
  // And it must not read as the user speaking, or the model answers it instead of acting on it.
  assert.match(d.prompt, /not the user speaking/);
});

test("no goal means the loop never engages", () => {
  assert.equal(decideNextRound(emptyGoal(), { met: false, reason: "x" }).action, "stop");
  assert.equal(decideNextRound(null, { met: false, reason: "x" }).action, "stop");
});

test("a cleared goal stops the loop immediately", () => {
  // `/goal clear` mid-run: the next end-of-turn check must not continue.
  const g = clearGoal(started());
  assert.equal(decideNextRound(g, { met: false, reason: "still failing" }).action, "stop");
});

test("by default the loop is not stopped by its round count", () => {
  // The default ceiling is gone: a goal loop now runs until the evaluator settles it or the user stops it.
  // This asserted the opposite (exhausted at 25) until the caps came off.
  assert.equal(MAX_GOAL_AUTO_ROUNDS, null, "the default ceiling is off");
  let g = started("something long");
  for (let i = 0; i < 200; i++) g = recordEvaluation(g, { reason: "no", tokens: 1 });
  assert.equal(decideNextRound(g, { met: false, reason: "no" }).action, "continue");
});

test("a configured round limit stops the loop and never claims success", () => {
  // The ceiling still exists for anyone who sets one, and reaching it must still read as unfinished rather
  // than as done. Driven by an explicit `maxRounds`, since the default no longer supplies one -- without
  // that this would pass by never reaching a limit at all, which is not the property being pinned.
  let g = started("something impossible");
  for (let i = 0; i < 25; i++) g = recordEvaluation(g, { reason: "no", tokens: 1 });
  const d = decideNextRound(g, { met: false, reason: "no", maxRounds: 25 });
  assert.equal(d.action, "exhausted");
  assert.notEqual(g.status, "achieved");
  // The final round is an honest report, explicitly not a claim of completion.
  assert.match(d.prompt, /HONEST/);
  assert.match(d.prompt, /not reached/);
});

test("the limit is configurable and is a limit, not a completion condition", () => {
  let g = started();
  g = recordEvaluation(g, { reason: "no", tokens: 1 });
  g = recordEvaluation(g, { reason: "no", tokens: 1 });
  assert.equal(decideNextRound(g, { met: false, reason: "no", maxRounds: 5 }).action, "continue");
  assert.equal(decideNextRound(g, { met: false, reason: "no", maxRounds: 2 }).action, "exhausted");
  // Reaching the limit leaves the goal unmet in every case.
  assert.notEqual(g.status, "achieved");
});

test("a failed evaluation is recorded but never treated as a verdict", () => {
  const g = recordEvaluation(started(), { reason: "the evaluator did not return a usable verdict", failed: true, tokens: 5 });
  assert.equal(g.run.turnCount, 1);
  assert.equal(g.run.lastEvalFailed, true);
  // Neither completed nor abandoned: the goal survives so the next message re-arms the check.
  assert.equal(g.status, "active");
});

test("no verdict stops the loop rather than driving another round blind", () => {
  // The failure this prevents: an evaluator that is down reads as "not met" every round, so the loop spends
  // the entire cap working with no idea whether the goal was met on round one.
  const g = recordEvaluation(started(), { reason: "the goal check timed out", failed: true, tokens: 5 });
  assert.equal(decideNextRound(g, { met: false, reason: g.run.lastReason, failed: true }).action, "stop");
  // ...and the goal is still there to be checked again.
  assert.equal(isGoalActive(g), true);
});

test("an unsatisfiable condition ends the loop at once instead of exhausting the cap", () => {
  const g = started("ship it to the App Store today without an Apple account");
  const d = decideNextRound(g, { met: false, reason: "no Apple account exists", impossible: true });
  assert.equal(d.action, "impossible");
  // The final round explains rather than claiming success or quietly substituting a lesser result.
  assert.match(d.prompt, /cannot be met/);
  assert.match(d.prompt, /no Apple account exists/);
  assert.doesNotMatch(d.prompt, /achieved/i);
  // It is recognised on round one — that is the entire point of the verdict.
  assert.equal(g.run.turnCount, 0);
});

test("impossible outranks the round budget but not a met verdict", () => {
  const g = started();
  assert.equal(decideNextRound(g, { met: true, reason: "done", impossible: true }).action, "stop");
  // A no-verdict failure is not an impossibility claim either.
  assert.equal(decideNextRound(g, { met: false, reason: "x", impossible: true, failed: true }).action, "stop");
});

test("only the evaluator's verdict produces an achieved goal", () => {
  // Nothing the agent can call — criteria, plan, checklist, evidence — reaches `achieved`.
  let g = started();
  g = setCriteria(g, { objective: "x", acceptanceCriteria: [{ text: "y" }] }, { now: NOW }).goal;
  g = applyPlan(g, { steps: [{ title: "a", status: "completed" }] }).goal;
  g = applyTodoStatuses(g, [{ title: "a", status: "completed" }]);
  g = recordEvidence(g, { source: "run_subagent", summary: "everything looks done to me" });
  g = addTurnSpend(g, 5000);
  assert.equal(g.status, "active");
  assert.equal(achieveGoal(g, "verified green").status, "achieved");
});

/* ------------------------------------------------------------------ accounting */

test("the run accumulates both the turns' spend and the evaluator's", () => {
  let g = started();
  g = addTurnSpend(g, 1200);
  g = recordEvaluation(g, { reason: "not yet", tokens: 300 });
  assert.equal(g.run.tokenSpend, 1500);
  assert.equal(g.run.turnCount, 1);
});

/* ------------------------------------------------------------------ persistence and resume */

test("only an active goal is persisted", () => {
  assert.ok(toStoredGoal(started()));
  // A finished run must not be able to come back: achieved and cleared goals are session state.
  assert.equal(toStoredGoal(achieveGoal(started(), "done")), null);
  assert.equal(toStoredGoal(clearGoal(started())), null);
  assert.equal(toStoredGoal(emptyGoal()), null);
});

test("resume restores the condition and its plan but zeroes the run", () => {
  let g = started("the suite is green");
  g = setCriteria(g, { objective: "x", acceptanceCriteria: [{ text: "npm test exits 0" }] }, { now: NOW }).goal;
  g = applyPlan(g, { steps: [{ title: "fix auth.test.ts", status: "in_progress" }] }).goal;
  g = addTurnSpend(recordEvaluation(g, { reason: "still failing", tokens: 400 }), 8000);

  const back = restoreGoal(JSON.parse(JSON.stringify(toStoredGoal(g))));
  assert.equal(back.condition, "the suite is green");
  assert.equal(back.criteria.length, 1);
  assert.equal(back.plan.steps[0].status, "in_progress");
  // The counters describe an activation that is no longer happening; showing them would read as progress.
  assert.deepEqual([back.run.turnCount, back.run.tokenSpend, back.run.startedAt], [0, 0, 0]);
  assert.equal(back.run.lastReason, "");
});

test("an achieved goal cannot be resurrected by a reload", () => {
  const done = achieveGoal(started(), "verified");
  // It was never written, but even handed the record directly, restore refuses to reactivate it.
  assert.equal(isGoalActive(restoreGoal({ ...done })), false);
});

test("a partial or foreign record is repaired rather than crashing the page", () => {
  assert.equal(isGoalEmpty(normalizeGoal(null)), true);
  assert.equal(isGoalEmpty(normalizeGoal({ status: "active" })), true); // no condition → no goal
  const g = normalizeGoal({ condition: "c", plan: { steps: [{ title: "a", status: "bogus" }] }, criteria: [{ text: "x" }] });
  assert.equal(g.plan.steps[0].status, "pending");
  assert.equal(g.criteria[0].id, "c1");
});

/* ------------------------------------------------------------------ what the model is shown */

test("the goal block re-renders the current state, so compaction cannot lose it", () => {
  let g = started("the suite is green");
  g = setCriteria(g, { objective: "x", acceptanceCriteria: [{ text: "npm test exits 0" }] }, { now: NOW }).goal;
  g = applyPlan(g, { steps: [{ title: "fix auth.test.ts", status: "in_progress" }] }).goal;
  g = recordEvaluation(g, { reason: "the test never ran", tokens: 1 });

  const text = renderGoalState(g);
  assert.match(text, /the suite is green/);
  assert.match(text, /npm test exits 0/);
  assert.match(text, /fix auth\.test\.ts/);
  assert.match(text, /the test never ran/);
  // A user-authored condition says so, because that is the rule the model must not break.
  assert.match(text, /may not narrow, paraphrase or lower it/);
});

test("an inactive goal renders nothing", () => {
  assert.equal(renderGoalState(emptyGoal()), "");
  assert.equal(renderGoalState(clearGoal(started())), "");
  assert.equal(renderGoalState(achieveGoal(started(), "done")), "");
});

/* ------------------------------------------------------------------ the composer's `/` menu */

const { matchSlashCommands, SLASH_COMMANDS } = await import("../src/app/agent/chat/slashCommands.ts");

test("a bare slash offers every command", () => {
  // The discovery case: `/goal` shipped with no affordance at all, so this is the whole point of the menu.
  assert.deepEqual(matchSlashCommands("/"), SLASH_COMMANDS);
});

test("the menu filters as the command word is typed", () => {
  const goalRows = SLASH_COMMANDS.filter((c) => c.name.startsWith("/goal")).length;
  for (const typed of ["/g", "/GOAL", "/goa"]) {
    assert.equal(matchSlashCommands(typed).length, goalRows, typed);
  }
  // A prefix that belongs to a different command narrows to that one, not to everything.
  assert.equal(matchSlashCommands("/c").length, 1);
  assert.equal(matchSlashCommands("/clear")[0].id, "clear");
});

test("a word that matches nothing shows no menu rather than an empty one", () => {
  assert.equal(matchSlashCommands("/zzz"), null);
});

test("a slash inside a sentence never opens the menu", () => {
  // The everyday false positive: paths and dates are full of slashes.
  assert.equal(matchSlashCommands("look in src/app"), null);
  assert.equal(matchSlashCommands("what does /goal do?"), null);
});

test("the menu closes once the command word is settled", () => {
  // Everything after the word is a free-text argument — a goal condition is a sentence, and a menu hovering
  // over it would swallow the Enter that submits it.
  assert.equal(matchSlashCommands("/goal "), null);
  assert.equal(matchSlashCommands("/goal all tests pass"), null);
});

test("plain text and an empty box show nothing", () => {
  assert.equal(matchSlashCommands(""), null);
  assert.equal(matchSlashCommands("hello"), null);
});

test("every offered goal row inserts something the goal parser accepts", () => {
  // The menu must not be able to teach a form that then fails to parse.
  for (const c of SLASH_COMMANDS.filter((x) => x.name.startsWith("/goal"))) {
    const parsed = parseGoalCommand(c.insert.trim() === "/goal" ? c.insert.trim() : `${c.insert}x y`);
    assert.notEqual(parsed.kind, "none", c.id);
    assert.notEqual(parsed.kind, "error", c.id);
  }
});

/* ------------------------------------------------------------------ the command tag in the input box */

const { commandTokenLength } = await import("../src/app/agent/chat/slashCommands.ts");

test("a complete command word is measured for the tag", () => {
  assert.equal(commandTokenLength("/goal"), 5);
  assert.equal(commandTokenLength("/goal "), 5);
  assert.equal(commandTokenLength("/goal all tests pass"), 5);
  assert.equal(commandTokenLength("/GOAL all tests pass"), 5);
});

test("only the command word is tagged, never its arguments", () => {
  // Tagging "clear" or the condition would blur the very distinction the tag exists to draw.
  assert.equal(commandTokenLength("/goal clear"), 5);
});

test("a half-typed word is not tagged", () => {
  // The menu opens on a prefix, but decorating "/goa" would promise something Enter will not deliver.
  assert.equal(commandTokenLength("/goa"), 0);
  assert.equal(commandTokenLength("/"), 0);
});

test("ordinary text is never tagged", () => {
  assert.equal(commandTokenLength("look in src/app"), 0);
  assert.equal(commandTokenLength("hello"), 0);
  assert.equal(commandTokenLength(""), 0);
  assert.equal(commandTokenLength("/unknown thing"), 0);
});

test("the tag covers exactly what the parser treats as the command", () => {
  // Drift here would draw the pill around a different span of text than the one that actually dispatches.
  for (const text of ["/goal", "/goal clear", "/goal ship the release"]) {
    assert.equal(text.slice(0, commandTokenLength(text)), "/goal", text);
    assert.notEqual(parseGoalCommand(text).kind, "none", text);
  }
});

/* ------------------------------------------------------------------ background-job delivery */

const { isJobCompletion, describeJobEvent, formatJobDelivery, formatJobMessage } = await import(
  "../src/lib/ai/services.ts"
);

const jobEvent = (over = {}) => ({
  type: "stopped",
  pid: 1,
  reason: "exited",
  notify: true,
  code: 0,
  command: "npm run build",
  ...over,
});

test("only a notify job that exited on its own reports back", () => {
  assert.equal(isJobCompletion(jobEvent()), true);
  // A dev server the user stopped is not a result anybody is waiting for.
  assert.equal(isJobCompletion(jobEvent({ reason: "stopped" })), false);
  assert.equal(isJobCompletion(jobEvent({ notify: false })), false);
  assert.equal(isJobCompletion(jobEvent({ type: "started" })), false);
  // `reason` is absent on events from an older main process; missing must never read as "exited".
  assert.equal(isJobCompletion(jobEvent({ reason: undefined })), false);
});

test("the outcome line distinguishes success, failure and an unknowable exit", () => {
  assert.match(describeJobEvent(jobEvent({ code: 0 })), /finished successfully/);
  assert.match(describeJobEvent(jobEvent({ code: 1 })), /failed with exit code 1/);
  // The sandbox cannot reap a `setsid …&` job, so there is genuinely no code — it must not read as success.
  const unknown = describeJobEvent(jobEvent({ code: null }));
  assert.match(unknown, /\[Background job finished\]/);
  assert.doesNotMatch(unknown, /successfully/);
});

test("both delivery routes describe the same event identically", () => {
  // One describer, two envelopes: the inline and standalone forms cannot drift into contradicting each other.
  const notice = describeJobEvent(jobEvent({ code: 1 }));
  assert.ok(formatJobDelivery([notice]).includes(notice));
  assert.ok(formatJobMessage(notice).includes(notice));
});

test("inline delivery is fenced so it cannot read as the host tool's output", () => {
  const out = formatJobDelivery([describeJobEvent(jobEvent())]);
  assert.match(out, /\[Background jobs that finished while you were working/);
  assert.match(out, /\[end of background job results\]/);
  // Nothing to deliver must add nothing at all — every tool result passes through this.
  assert.equal(formatJobDelivery([]), "");
});

test("inline delivery does not tell the model the user has moved on", () => {
  // True of a standalone turn, false mid-turn: the model is still doing the thing it started.
  const inline = formatJobDelivery([describeJobEvent(jobEvent())]);
  assert.doesNotMatch(inline, /not the user speaking/);
  assert.match(formatJobMessage(describeJobEvent(jobEvent())), /not the user speaking/);
});

test("several jobs finishing in one turn are all delivered", () => {
  const notices = [jobEvent({ command: "npm run build" }), jobEvent({ command: "npm test", code: 1 })].map(
    describeJobEvent,
  );
  const out = formatJobDelivery(notices);
  assert.match(out, /npm run build/);
  assert.match(out, /npm test/);
});

/* ------------------------------------------------------------------ evaluator hardening */

test("an impossible verdict is read, and only when coherent", () => {
  assert.deepEqual(parseVerdict('{"met": false, "reason": "no such API", "impossible": true}'), {
    met: false,
    reason: "no such API",
    impossible: true,
  });
  // "met AND impossible" is incoherent; reading it either way would be guessing.
  assert.equal(parseVerdict('{"met": true, "reason": "ok", "impossible": true}').impossible, undefined);
  // Only a literal true — this verdict ends the task, so a truthy string is not enough.
  assert.equal(parseVerdict('{"met": false, "reason": "x", "impossible": "yes"}').impossible, undefined);
  assert.equal(parseVerdict('{"met": false, "reason": "x"}').impossible, undefined);
});

test("a stalled evaluator is cut off rather than holding the turn open", async () => {
  const evaluate = createGoalEvaluator(
    () => new Promise(() => {}), // never settles
    { timeoutMs: 30 },
  );
  const out = await evaluate({ condition: "c", criteria: [], established: [], messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true);
  // The goal check sits between the model finishing and the user getting control back; a hang there is a hang
  // for the user.
  assert.match(out.error, /timed out/);
});

test("a user cancel is reported as a cancel, not as a timeout", async () => {
  const ctrl = new AbortController();
  const evaluate = createGoalEvaluator(
    (m, tools, signal) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    { timeoutMs: 10_000 },
  );
  const pending = evaluate({ condition: "c", criteria: [], established: [], messages: [] }, ctrl.signal);
  ctrl.abort();
  const out = await pending;
  assert.equal(out.ok, false);
  // The two are reported to the user differently, so they must not collapse into one error.
  assert.equal(out.timedOut, false);
});

test("a truncated transcript tells the evaluator what the omission means", async () => {
  let sent = "";
  const evaluate = createGoalEvaluator(
    async (messages) => {
      sent = messages.map((m) => m.content).join("\n");
      return reply('{"met": false, "reason": "x"}');
    },
    { budgetChars: 2000 },
  );
  const many = Array.from({ length: 400 }, (_, i) => ({
    role: "user",
    content: `message number ${i} with enough text to push the transcript past the budget`,
  }));
  await evaluate({ condition: "c", criteria: [], established: [], messages: many });
  // Merely saying "omitted" leaves the evaluator answering from what it can see. Saying what the omission
  // MEANS is what makes truncation fail safe.
  assert.match(sent, /insufficient evidence in transcript/);
  assert.match(sent, /message number 399/); // the tail is what survives
  assert.doesNotMatch(sent, /message number 0 with/);
});

/* ------------------------------------------------------------------ the command dispatcher */

const { parseSlashCommand } = await import("../src/app/agent/chat/slashCommands.ts");

test("the dispatcher splits a registered command from its arguments", () => {
  assert.deepEqual(parseSlashCommand("/clear"), { name: "clear", rest: "" });
  assert.deepEqual(parseSlashCommand("/goal all tests pass"), { name: "goal", rest: "all tests pass" });
  assert.deepEqual(parseSlashCommand("  /GOAL   clear  "), { name: "goal", rest: "clear" });
});

test("an unregistered word is not a command and is sent as an ordinary message", () => {
  // People type paths and dates; refusing them would reject messages the user meant to send.
  assert.equal(parseSlashCommand("/usr/local/bin"), null);
  assert.equal(parseSlashCommand("/unknown thing"), null);
  assert.equal(parseSlashCommand("what does /clear do?"), null);
  assert.equal(parseSlashCommand("hello"), null);
  assert.equal(parseSlashCommand(""), null);
});

test("every registered command is reachable through the dispatcher", () => {
  // A row the menu offers but the dispatcher does not recognise would insert text that then gets sent as chat.
  for (const c of SLASH_COMMANDS) {
    assert.notEqual(parseSlashCommand(c.insert), null, c.id);
  }
});

test("/clear is tagged in the input box like any other command", () => {
  assert.equal(commandTokenLength("/clear"), 6);
  assert.equal(commandTokenLength("/clea"), 0);
});

test("a transposed alias is caught, because that is the typo people actually make", () => {
  // `stpo` is two Levenshtein edits from `stop` but one keystroke away from it. A guard that scored it as
  // distance 2 would wave through the single commonest way to fumble a subcommand — which is what an earlier
  // version of this check did.
  for (const typo of ["stpo", "clera", "rest", "noen", "cancle"]) {
    assert.equal(parseGoalCommand(`/goal ${typo}`).kind, "error", typo);
  }
});

test("words that merely share letters with an alias are still goals", () => {
  // The guard has to be narrow, or it starts refusing ordinary one-word goals.
  for (const word of ["ship", "deploy", "compile", "release", "document"]) {
    assert.equal(parseGoalCommand(`/goal ${word}`).kind, "set", word);
  }
});
