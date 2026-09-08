/**
 * The tool-approval policy (src/lib/ai/approvalMode.ts).
 *
 * One pure function decides what happens to every tool call the app makes, so the rules are worth
 * pinning down directly rather than through the tool loop. The cases that matter are the ones where a
 * mode must NOT inherit the previous mode's leniency: a sub-agent riding the user's "don't ask again",
 * manual approval being hollowed out by an allowance collected under default, and plan mode letting a
 * write through because someone allowed that tool earlier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { approvalDecision, approvalReminderLine, loadApprovalMode, APPROVAL_MODES, DEFAULT_APPROVAL_MODE } =
  await import("../src/lib/ai/approvalMode.ts");
const { diffReminder, foldReminders, renderReminder } = await import("../src/app/agent/chat/reminders.ts");

test("default: reads run, sensitive tools ask, and an allowance silences the repeat", () => {
  assert.equal(approvalDecision("default", { sensitive: false }), "run");
  assert.equal(approvalDecision("default", { sensitive: true }), "ask");
  assert.equal(approvalDecision("default", { sensitive: true, alreadyAllowed: true }), "run");
});

test("default: a sub-agent asks even for a tool the user allowed", () => {
  assert.equal(
    approvalDecision("default", { sensitive: true, alreadyAllowed: true, fromSubagent: true }),
    "ask",
  );
});

test("full trust runs everything, including a sub-agent's sensitive call", () => {
  assert.equal(approvalDecision("trust", { sensitive: true }), "run");
  assert.equal(approvalDecision("trust", { sensitive: true, fromSubagent: true }), "run");
  assert.equal(approvalDecision("trust", { sensitive: false }), "run");
});

test("manual asks for everything, reads included", () => {
  assert.equal(approvalDecision("manual", { sensitive: false }), "ask");
  assert.equal(approvalDecision("manual", { sensitive: true }), "ask");
});

test("manual honours an explicit allowance, but not one a sub-agent is riding", () => {
  // Otherwise the panel offers "don't ask again" and then asks again — an option that does nothing.
  assert.equal(approvalDecision("manual", { sensitive: true, alreadyAllowed: true }), "run");
  assert.equal(approvalDecision("manual", { sensitive: false, alreadyAllowed: true }), "run");
  assert.equal(
    approvalDecision("manual", { sensitive: true, alreadyAllowed: true, fromSubagent: true }),
    "ask",
  );
});

test("plan refuses the tools that write files, allowance or not", () => {
  assert.equal(approvalDecision("plan", { sensitive: true }), "refuse");
  assert.equal(approvalDecision("plan", { sensitive: true, alreadyAllowed: true }), "refuse");
  assert.equal(approvalDecision("plan", { sensitive: true, fromSubagent: true }), "refuse");
  // Research still works: read-only tools are exactly what plan mode is for.
  assert.equal(approvalDecision("plan", { sensitive: false }), "run");
});

test("plan routes shell commands in three tiers rather than refusing them", () => {
  const cmd = (command, rest = {}) => approvalDecision("plan", { sensitive: true, command, ...rest });
  assert.equal(cmd("read-only"), "run", "git log is how a plan gets researched");
  assert.equal(cmd("other"), "ask", "npm install stops at the panel, it is not refused");
  assert.equal(cmd("critical"), "ask");
  // An allowance granted before the user switched to plan mode does not carry into it.
  assert.equal(cmd("other", { alreadyAllowed: true }), "ask");
});

test("a critical command always asks — past an allowance, and past full trust", () => {
  for (const mode of APPROVAL_MODES) {
    assert.equal(
      approvalDecision(mode, { sensitive: true, command: "critical", alreadyAllowed: true }),
      "ask",
      mode,
    );
  }
});

test("read-only commands run in every mode except the one whose promise is to ask", () => {
  for (const mode of ["default", "trust", "plan"]) {
    assert.equal(approvalDecision(mode, { sensitive: true, command: "read-only" }), "run", mode);
  }
  assert.equal(approvalDecision("manual", { sensitive: true, command: "read-only" }), "ask");
});

test("an unknown mode falls back to the default policy rather than to 'run'", () => {
  // Storage is user-writable and survives downgrades, so a mode this build has never heard of must
  // not read as permission.
  assert.equal(approvalDecision("bogus", { sensitive: true }), "ask");
  assert.equal(loadApprovalMode(), DEFAULT_APPROVAL_MODE); // no storage in node → the default
});

test("every non-default mode has its own line; default says nothing", () => {
  const others = APPROVAL_MODES.filter((m) => m !== DEFAULT_APPROVAL_MODE);
  const lines = others.map(approvalReminderLine);
  assert.equal(new Set(lines).size, others.length);
  for (const line of lines) assert.match(line, /^- approval mode: /);
  assert.match(approvalReminderLine("plan"), /BLOCKED/);
  // messages[0] already tells the model that sensitive operations are gated, so the ordinary case
  // must not spend a reminder restating it — and must not move the first differing byte of the turn.
  assert.equal(approvalReminderLine("default"), "");
});

test("the mode is announced when it changes, and retracted when it goes back", () => {
  const state = (mode) => ({ workdir: "/w", approval: approvalReminderLine(mode) });
  // The buffer, as the app holds it: what was last announced is FOLDED from every turn, never from
  // the last one alone (reminders.ts). Each turn below carries only the delta it emitted.
  const turns = [];
  const emit = (mode) => {
    const delta = diffReminder(state(mode), foldReminders(turns));
    if (delta) turns.push({ role: "user", content: "hi", reminder: delta });
    return delta;
  };

  // A conversation that never leaves default emits nothing about approval at all.
  assert.deepEqual(Object.keys(emit("default")), ["workdir"], "default must not announce itself");

  assert.match(renderReminder(emit("plan")), /approval mode: plan/);
  // Unchanged next turn: no event at all, which is what keeps the prefix stable.
  assert.equal(emit("plan"), null);

  // Back to default: "" is a retraction, not silence — the model has been told plan mode is on and
  // would otherwise keep refusing to touch anything for the rest of the conversation.
  const back = emit("default");
  assert.notEqual(back, null, "returning to default must be announced");
  assert.match(renderReminder(back), /back to default/);
  assert.equal(emit("default"), null, "and then stays quiet again");
});
