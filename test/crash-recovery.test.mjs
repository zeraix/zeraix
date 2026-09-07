/**
 * Crash recovery, stage 1 (docs/agent-runtime-crash-recovery.md §6 item 1, §7).
 *
 * The three pieces that turn a silent loss into a reported one, tested where each of them actually decides
 * something: the session lock (C9) deciding whether the last run ended cleanly, the turn checkpoint (C2)
 * deciding what a crash left behind and how it is described, and the recovery log (C10) being the durable
 * record the other two write to.
 *
 * The rule under test throughout is §5: work that may already have had side effects is never silently re-run.
 * A checkpoint is a REPORT, so the assertions below are about what it says — never about resuming anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);

import { setRecoveryLogDir, recordRecovery, readRecoveryLog, recoveryLogPath } from "../electron/store/recoveryLog.mjs";
import { acquireSessionLock, releaseSessionLock, lastSession, pidAlive } from "../electron/store/sessionLock.mjs";

const { createTurnCheckpoint, describeInterruptedTurn, summarizeInterruptedTurn, isMutatingTool, isInterrupted } =
  await import("../src/app/agent/chat/turnState.ts");

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zeraix-${name}-`));
}

// ── C9 · the session lock ───────────────────────────────────────────────────────────────────────────

test("a clean shutdown leaves no lock, so the next launch reports nothing", () => {
  const dir = tmpdir("lock-clean");
  const first = acquireSessionLock({ dir, version: "1.0.0" });
  assert.equal(first.unclean, false, "a first-ever launch has no previous session");
  releaseSessionLock();
  assert.equal(fs.existsSync(path.join(dir, "session.lock")), false, "release removes the lock");

  const second = acquireSessionLock({ dir, version: "1.0.0" });
  assert.equal(second.unclean, false);
  releaseSessionLock();
});

test("a lock left by a dead process is an unclean shutdown, and is logged", () => {
  const dir = tmpdir("lock-crash");
  setRecoveryLogDir(path.join(dir, "logs"));
  // A pid that cannot be alive: the previous session died without reaching the end of before-quit.
  fs.writeFileSync(
    path.join(dir, "session.lock"),
    JSON.stringify({ pid: 0x7ffffffe, startedAt: 1700000000000, version: "0.9.0" }),
  );

  const found = acquireSessionLock({ dir, version: "1.0.0" });
  assert.equal(found.unclean, true);
  assert.equal(found.previous.version, "0.9.0");
  assert.equal(lastSession().unclean, true, "the finding is readable afterwards, for the renderer's notice");

  const log = readRecoveryLog();
  assert.equal(log.at(-1).component, "session");
  assert.equal(log.at(-1).event, "unclean-shutdown");
  assert.equal(log.at(-1).detail.previousVersion, "0.9.0");
  releaseSessionLock();
  setRecoveryLogDir("");
});

test("a live pid in the lock is reported as reused, never guessed as a crash", () => {
  const dir = tmpdir("lock-alive");
  fs.writeFileSync(path.join(dir, "session.lock"), JSON.stringify({ pid: process.pid, startedAt: 1, version: "1.0.0" }));
  const found = acquireSessionLock({ dir, version: "1.0.0" });
  assert.equal(found.unclean, false, "a live process is not condemned as a crash");
  assert.equal(found.pidReused, true);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0x7ffffffe), false);
  releaseSessionLock();
});

test("release only removes this process's own lock", () => {
  const dir = tmpdir("lock-foreign");
  acquireSessionLock({ dir, version: "1.0.0" });
  // A newer session replaced the marker; ours must not delete theirs and hide their crash.
  fs.writeFileSync(path.join(dir, "session.lock"), JSON.stringify({ pid: process.pid + 1, startedAt: 2, version: "1.1.0" }));
  releaseSessionLock();
  assert.equal(fs.existsSync(path.join(dir, "session.lock")), true);
});

// ── C10 · the recovery log ──────────────────────────────────────────────────────────────────────────

test("the recovery log is append-only, survives a torn line, and is a no-op without a folder", () => {
  setRecoveryLogDir("");
  assert.equal(recordRecovery("sandbox", "orphan-vm-reaped", { pid: 1 }), null, "unconfigured: nothing is written");
  assert.deepEqual(readRecoveryLog(), []);

  const dir = tmpdir("reclog");
  setRecoveryLogDir(dir);
  recordRecovery("orphans", "reaped", { count: 2, pids: [11, 12] });
  recordRecovery("sidecar", "journal-replayed", { interrupted: [{ id: "t1", label: "npm install" }] });
  // A crash mid-append tears the last line; everything written before it must still read back.
  fs.appendFileSync(recoveryLogPath(), '{"at":"2026-09-07T00:00:00.00');

  const log = readRecoveryLog();
  assert.equal(log.length, 2, "the torn tail is skipped, not fatal");
  assert.equal(log[0].event, "reaped");
  assert.deepEqual(log[0].detail.pids, [11, 12]);
  assert.equal(log[1].detail.interrupted[0].label, "npm install");
  setRecoveryLogDir("");
});

// ── C2 · the turn checkpoint ────────────────────────────────────────────────────────────────────────

/** A checkpoint over an in-memory sink, standing in for the chat store. */
function harness(opts = {}) {
  const saved = [];
  let state = null;
  const cp = createTurnCheckpoint({
    turnId: "conv1-abc",
    save: (s) => {
      state = s;
      saved.push(s);
    },
    queued: opts.queued ?? (() => []),
    delegations: opts.delegations ?? (() => 0),
    now: () => 1_700_000_000_000,
  });
  return { cp, saved, get state() { return state; } };
}

test("a turn that ends by any route leaves no checkpoint", () => {
  const h = harness();
  h.cp.roundStarted();
  h.cp.callsStarted([{ callId: "c1", name: "run_command" }]);
  h.cp.callsFinished();
  assert.equal(h.state.round, 1);
  h.cp.clear(); // the `finally` in send(), reached by a reply, an error and a user Stop alike
  assert.equal(h.state, null, "only a record that outlives the process means an interruption");
});

test("the checkpoint records the round and the calls that were in flight", () => {
  const h = harness({ queued: () => ["and then deploy it"], delegations: () => 2 });
  h.cp.roundStarted();
  h.cp.roundStarted();
  h.cp.callsStarted([
    { callId: "c1", name: "run_command" },
    { callId: "c2", name: "read_file" },
  ]);

  assert.equal(h.state.round, 2);
  assert.equal(h.state.turnId, "conv1-abc");
  assert.deepEqual(
    h.state.running.map((r) => [r.callId, r.name, r.mutating]),
    [["c1", "run_command", true], ["c2", "read_file", false]],
    "mutating is decided per call, conservatively",
  );
  assert.deepEqual(h.state.queued, ["and then deploy it"], "the queue is read at write time, not pushed");
  assert.equal(h.state.delegations, 2);

  h.cp.callsFinished();
  assert.deepEqual(h.state.running, [], "nothing in flight once the batch settles");
});

test("unknown and dispatching tools are treated as mutating", () => {
  // The conservative reading: a false "mutating" costs one look at the working directory; a false
  // "read-only" could cost a second `npm install`.
  for (const name of ["run_command", "write_file", "call_tool", "mcp__github__create_issue", "run_subagent"]) {
    assert.equal(isMutatingTool(name), true, `${name} must be treated as mutating`);
  }
  for (const name of ["read_file", "list_directory", "search_in_files", "web_search", "load_skill"]) {
    assert.equal(isMutatingTool(name), false, `${name} is read-only`);
  }
});

test("a checkpoint whose turn is still running in this process is not an interruption", () => {
  const state = { turnId: "conv1-abc", startedAt: 1, updatedAt: 2, round: 1, running: [], delegations: 0, queued: [] };
  assert.equal(isInterrupted(state, ["conv1-abc"]), false, "its own turn still owns it");
  assert.equal(isInterrupted(state, ["conv9-zzz"]), true);
  assert.equal(isInterrupted(undefined, []), false);
});

test("the notice tells the model what ran and to check before repeating — never to resume", () => {
  const state = {
    turnId: "conv1-abc",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    round: 3,
    running: [
      { callId: "c1", name: "run_command", mutating: true },
      { callId: "c2", name: "read_file", mutating: false },
    ],
    delegations: 1,
    queued: ["ship it"],
  };
  const text = describeInterruptedTurn(state);

  assert.match(text, /round 3/);
  assert.match(text, /run_command \(tool_call id c1; may have had side effects\)/);
  assert.match(text, /read_file \(tool_call id c2; read-only\)/);
  assert.match(text, /results are unknown/i);
  assert.match(text, /inspect the working directory/i);
  assert.match(text, /1 delegated sub-agent task/);
  assert.match(text, /"ship it"/);
  assert.match(text, /Do not resume automatically/i);
  // The rule of §5, stated negatively: nothing in the notice may read as an instruction to re-run.
  assert.doesNotMatch(text, /re-?run (it|them|the)/i);
  assert.doesNotMatch(text, /continue where you left off/i);

  const idle = describeInterruptedTurn({ ...state, running: [], delegations: 0, queued: [] });
  assert.match(idle, /no tool call was in flight/);
  assert.doesNotMatch(idle, /side effects/);
});

test("the banner summary carries the same facts as the model's notice", () => {
  const summary = summarizeInterruptedTurn({
    turnId: "t",
    startedAt: 1,
    updatedAt: 2,
    round: 2,
    running: [{ callId: "c1", name: "write_file", mutating: true }],
    delegations: 0,
    queued: ["a", "b"],
  });
  assert.deepEqual(summary, { round: 2, tools: ["write_file"], mutating: true, delegations: 0, queued: 2 });
});

// ── The notice on the wire: emitted once, never replayed ───────────────────────────────────────────

const { diffReminder, renderReminder, renderSnapshot, foldReminders } = await import(
  "../src/app/agent/chat/reminders.ts"
);

test("the recovery notice is announced once and never restated or retracted", () => {
  const notice = "RECOVERY NOTICE: your previous turn was cut short at round 2.";

  // First send after reopening: the notice is part of the delta and reaches the model.
  const first = diffReminder({ workdir: "/w", recovery: notice }, {});
  assert.equal(first.recovery, notice);
  assert.match(renderReminder(first), /RECOVERY NOTICE/);

  // Every later send omits the key entirely (page.tsx deletes the pending entry once emitted). An absent
  // key is skipped by diffReminder, so nothing is re-announced and nothing is retracted either.
  const last = foldReminders([{ role: "user", content: "hi", reminder: first }]);
  assert.equal(last.recovery, notice, "the fold still remembers what was said");
  assert.equal(diffReminder({ workdir: "/w" }, last), null, "an unchanged turn emits no event at all");

  // A directory change on a later turn must carry the directory and NOT the stale notice.
  const later = diffReminder({ workdir: "/other" }, last);
  assert.deepEqual(Object.keys(later), ["workdir"]);
});

test("a compaction snapshot never replays the crash notice as current", () => {
  const state = { workdir: "/w", recovery: "RECOVERY NOTICE: your previous turn was cut short at round 2." };
  // The snapshot describes standing state as of the cut. An interruption is an event that already happened;
  // replaying it would tell the model a crash is happening now, many turns after it did.
  const snapshot = renderSnapshot(state);
  assert.match(snapshot, /working directory: \/w/);
  assert.doesNotMatch(snapshot, /RECOVERY NOTICE/);
  // The same state rendered as a live change event does carry it.
  assert.match(renderReminder(state), /RECOVERY NOTICE/);
});

// ── C7 · the renderer crash policy ─────────────────────────────────────────────────────────────────

const { createCrashPolicy, MAX_RELOADS, WINDOW_MS, STABLE_MS } = await import("../electron/rendererRecovery.mjs");

test("a renderer crash is reloaded, but only up to the bound", () => {
  const p = createCrashPolicy();
  let now = 1_000;
  const crash = () => p.onCrash({ reason: "crashed" }, { now: (now += 1_000) });

  for (let i = 1; i <= MAX_RELOADS; i++) {
    const v = crash();
    assert.equal(v.action, "reload", `crash ${i} within the bound reloads`);
    assert.equal(v.count, i);
  }
  // Past the bound the loop is real: stop reloading and say so, rather than flickering forever.
  assert.equal(crash().action, "giveUp");
  assert.equal(crash().action, "giveUp", "it stays given up while the crashes keep coming");
});

test("our own teardown is not a crash", () => {
  const p = createCrashPolicy();
  // What Electron reports when WE end the process. Reloading here would fight the shutdown it reacts to.
  assert.equal(p.onCrash({ reason: "clean-exit" }).action, "ignore");
  assert.equal(p.onCrash({ reason: "killed" }).action, "ignore");
  // ...and a real crash during quit is still not something to reload into.
  assert.equal(p.onCrash({ reason: "crashed" }, { quitting: true }).action, "ignore");
  assert.equal(p.crashCount(), 0, "ignored events are not held against the window");
});

test("the bound is a sliding window, not a session total", () => {
  const p = createCrashPolicy();
  let now = 0;
  const crash = () => p.onCrash({ reason: "oom" }, { now });

  crash();
  crash();
  assert.equal(crash().action, "giveUp");

  // An unrelated crash days later must still be recovered from.
  now += WINDOW_MS + 1;
  assert.equal(crash().action, "reload");
});

test("a page that loads and then dies immediately still hits the bound", () => {
  // The failure the bound exists to prevent. Loading is NOT proof of health: if did-finish-load cleared the
  // record, this renderer would reset its own count on every attempt and reload forever.
  const p = createCrashPolicy();
  let now = 0;
  const actions = [];
  for (let i = 0; i < 4; i++) {
    p.noteLoaded(now);
    now += 1_000; // up for a second, then gone again
    actions.push(p.onCrash({ reason: "crashed" }, { now }).action);
    now += 100;
  }
  assert.deepEqual(actions, ["reload", "reload", "giveUp", "giveUp"]);
});

test("a renderer that stays up for a while has its record forgiven", () => {
  const p = createCrashPolicy();
  let now = 0;
  p.noteLoaded(now);
  assert.equal(p.onCrash({ reason: "crashed" }, { now: (now += 1_000) }).action, "reload");

  // This time it runs properly before dying: a new problem, not a continuation of the last one.
  p.noteLoaded(now);
  now += STABLE_MS + 1;
  const v = p.onCrash({ reason: "crashed" }, { now });
  assert.equal(v.action, "reload");
  assert.equal(v.count, 1, "the earlier crash is forgiven, so this one starts a fresh count");
});

test("only the user's Try again grants a fresh budget outright", () => {
  const p = createCrashPolicy();
  let now = 0;
  for (let i = 0; i < 3; i++) p.onCrash({ reason: "crashed" }, { now: (now += 100) });
  assert.equal(p.crashCount(), 3);

  p.reset(); // the crash page's button, not anything the app decides on its own
  assert.equal(p.crashCount(), 0);
  assert.equal(p.onCrash({ reason: "crashed" }, { now: (now += 100) }).action, "reload");
});

test("the checkpoint never breaks the turn it observes", () => {
  // It reads two callbacks it does not own and writes to the store. A crash reporter that can take down the turn
  // is worse than no crash reporter, so every failure is swallowed and logged.
  const boom = () => {
    throw new Error("scheduler went away mid-turn");
  };
  const cp = createTurnCheckpoint({
    turnId: "t",
    save: () => {},
    queued: boom,
    delegations: boom,
  });
  assert.doesNotThrow(() => cp.roundStarted());
  assert.doesNotThrow(() => cp.callsStarted([{ callId: "c1", name: "run_command" }]));
  assert.doesNotThrow(() => cp.callsFinished());

  const failingSave = createTurnCheckpoint({ turnId: "t", save: boom });
  assert.doesNotThrow(() => failingSave.roundStarted());
  assert.doesNotThrow(() => failingSave.clear(), "clear runs in a finally block; throwing there would mask the real error");
});

// ── Failure attribution in the UI ───────────────────────────────────────────────────────────────

const chatPage = fs.readFileSync(
  path.join(fileURLToPath(new URL("../", import.meta.url)), "src/app/agent/chat/page.tsx"),
  "utf8",
);

test("an error banner belongs to the conversation that produced it", () => {
  // Reported from real use: a "Failed to fetch" from one chat stayed on screen while the user read a different
  // one. The banner renders at the foot of the transcript, so it read as that chat's failure — a chat that had
  // never made a request. Only "new chat" and "clear chat" cleared it; switching conversations did not.
  const page = chatPage;

  // Tagged at the moment it is raised, so no call site has to remember to pass an id...
  assert.match(page, /setErrorState\(text \? \{ convId: convIdRef\.current, text \} : null\)/);
  // ...and shown only while that conversation is the one on screen.
  assert.match(page, /errorState && errorState\.convId === viewConvId \? errorState\.text : null/);

  // The one-argument shape is what keeps every existing call site correct.
  assert.match(page, /const setError = \(text: string \| null\) =>/);
  assert.doesNotMatch(page, /useState<string \| null>\(null\); \/\/ error/, "no bare error string survives");
});

test("a fresh send clears the previous failure rather than stacking on it", () => {
  // Otherwise a conversation that failed once would carry its banner under every later successful reply.
  const page = chatPage;
  const send = page.slice(page.indexOf("const send = async (opts?:"), page.indexOf("const send = async (opts?:") + 4000);
  assert.match(send, /setError\(null\)/, "send() resets the banner before it starts");
});
