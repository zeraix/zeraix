/**
 * The fallback rule for `process.run` (see electron/tools/rustRuntime.mjs, `tryRunProcess`).
 *
 * Stage 1's rule is "every failure means the JS handler serves this call", and it is safe there because
 * those five tools are read-only: serving one twice costs a little time and nothing else. Stage 2 breaks
 * that assumption. Falling back after the sidecar has already been told to run `npm install`, `git push`
 * or `rm -rf build` means running it a second time, and the user asked for it once.
 *
 * So the rule splits by WHEN the failure happened. Before the request is written, nothing has run and the
 * answer is still `null`. After it is written, the command may have run, so the caller gets a RESULT --
 * a failure it can report -- and never a `null` that would send the same command down the JS path.
 *
 * These tests drive that with a fake sidecar rather than the real binary, because the interesting case is
 * "the runtime dies mid-command", which is awkward to arrange with a working one and trivial to script.
 * It is also why they do not need `cargo build` to have run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rust = await import("../electron/tools/rustRuntime.mjs");
const native = await import("../electron/tools/sandbox/native.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-fake-sidecar-"));

/**
 * Windows cannot host the fake sidecar, and that costs nothing.
 *
 * The bridge spawns its binary directly, so a fake has to be executable on its own. A `.sh` with a
 * shebang is that on POSIX; the Windows equivalent is a `.cmd`, and Node has refused to spawn `.cmd`
 * without `shell: true` since the CVE-2024-27980 fix, so there is no equivalent to reach for.
 *
 * What is under test is branch selection inside `tryRunProcess` -- pure JS with no platform-dependent
 * behaviour -- so a POSIX-only run tests the same logic a Windows run would. The platform-specific half
 * of Stage 2 is the shell invocation, and that is covered where it belongs: by the parity harness, which
 * CI runs on windows-latest precisely because that is where such differences live.
 */
const posixOnly = process.platform === "win32" ? "fake sidecars need a POSIX exec wrapper" : false;

/**
 * Write a fake sidecar: a node script speaking the line-delimited protocol, behind an exec wrapper so
 * the bridge can spawn it the way it spawns a real binary.
 *
 * `onRun` is inlined and decides what happens when a `process.run` arrives, which is the only method
 * these tests need to vary.
 */
function fakeSidecar(name, onRun) {
  const script = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(
    script,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "runtime.initialize") {
    send({ id: msg.id, result: { protocol_version: "1.1", runtime_version: "fake", tools: [], features: ["process.run"] } });
    return;
  }
  // Answered so teardown is immediate and clean. A fake that ignored it would cost each test the
  // bridge's 2s shutdown timeout, and would then be killed by signal -- which the bridge counts as a
  // crash, walking the module's failure counter toward the threshold that disables it for the session.
  if (msg.method === "runtime.shutdown") {
    send({ id: msg.id, result: { ok: true } });
    process.exit(0);
  }
  if (msg.method === "process.run") { ${onRun} }
});
`,
  );
  const wrapper = path.join(tmp, `${name}.sh`);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
    mode: 0o755,
  });
  return wrapper;
}

/** Point the bridge at one fake sidecar for the duration of `fn`. */
async function withSidecar(file, fn) {
  const priorBin = process.env.ZERAIX_RUST_RUNTIME_BIN;
  const priorFlag = process.env.ZERAIX_RUST_RUNTIME;
  process.env.ZERAIX_RUST_RUNTIME_BIN = file;
  process.env.ZERAIX_RUST_RUNTIME = "on";
  try {
    return await fn();
  } finally {
    await rust.shutdown();
    if (priorBin === undefined) delete process.env.ZERAIX_RUST_RUNTIME_BIN;
    else process.env.ZERAIX_RUST_RUNTIME_BIN = priorBin;
    if (priorFlag === undefined) delete process.env.ZERAIX_RUST_RUNTIME;
    else process.env.ZERAIX_RUST_RUNTIME = priorFlag;
  }
}

/** Run with the flag forced to a value, restoring whatever the suite had. */
async function withFlag(value, fn) {
  const prior = process.env.ZERAIX_RUST_RUNTIME;
  process.env.ZERAIX_RUST_RUNTIME = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.ZERAIX_RUST_RUNTIME;
    else process.env.ZERAIX_RUST_RUNTIME = prior;
  }
}

const node = JSON.stringify(process.execPath);

test("with the runtime off, the command runs on Node exactly as before", async () => {
  const r = await withFlag("off", () =>
    native.run(`${node} -e "console.log('js path')"`, { timeoutMs: 30_000 }),
  );
  assert.equal(r.code, 0);
  assert.match(r.stdout, /js path/);
  assert.equal(r.canceled, false);
});

test("an already-aborted signal is answered without spawning anything", async () => {
  const r = await native.run("echo should-not-run", { signal: AbortSignal.abort() });
  assert.equal(r.canceled, true);
  assert.equal(r.stdout, "");
  assert.equal(r.code, "?");
});

test("a sidecar that dies mid-command reports a failure instead of re-running it", { skip: posixOnly }, async () => {
  // The property this whole file exists for. The fake accepts the run and then exits without answering
  // -- what a panic or an OOM kill looks like from the host's side.
  //
  // The command is one that would SUCCEED on the JS path, so a silent fallback would show up as a clean
  // exit 0 rather than as the failure asserted below.
  const file = fakeSidecar("dies-mid-command", "process.exit(1);");
  const r = await withSidecar(file, () =>
    native.run(`${node} -e "console.log('ran twice')"`, { timeoutMs: 5_000 }),
  );

  assert.equal(r.code, "?", "a runtime failure reports the unknown exit code the JS path uses");
  assert.equal(r.stdout, "", "the command must not have been run a second time on Node");
  assert.match(r.stderr, /could not be completed by the agent runtime/);
  assert.equal(r.killed, false);
  assert.equal(r.canceled, false);
});

test("a sidecar that answers normally serves the command", { skip: posixOnly }, async () => {
  // The other half of the same branch: a reply is passed through as the engine contract, untouched.
  const file = fakeSidecar(
    "answers",
    `send({ id: msg.id, result: { stdout: "from the sidecar", stderr: "", code: 0, killed: false, canceled: false, truncated: false } });`,
  );
  const r = await withSidecar(file, () => native.run("anything", { timeoutMs: 5_000 }));
  assert.equal(r.stdout, "from the sidecar");
  assert.equal(r.code, 0);
});

test("a sidecar that cannot start at all falls back to Node", async () => {
  // Pre-dispatch: nothing ran, so `null` is correct here and the command must still be executed.
  const prior = process.env.ZERAIX_RUST_RUNTIME_BIN;
  process.env.ZERAIX_RUST_RUNTIME_BIN = path.join(tmp, "does-not-exist");
  try {
    const r = await withFlag("on", () =>
      native.run(`${node} -e "console.log('fell back')"`, { timeoutMs: 30_000 }),
    );
    assert.equal(r.code, 0);
    assert.match(r.stdout, /fell back/);
  } finally {
    if (prior === undefined) delete process.env.ZERAIX_RUST_RUNTIME_BIN;
    else process.env.ZERAIX_RUST_RUNTIME_BIN = prior;
  }
});

// ── Background services (Stage 2b) ────────────────────────────────────────────────────────────────
//
// The host half of the split: the runtime owns the process, and everything here decides what the user
// and the model are told about it. Driven against scripted sidecars because the interesting moment is
// an exit that arrives *after* the host stopped polling — which a real service cannot be made to do on
// cue, and which is the entire reason the event direction exists.

const { setServiceEventHandler } = await import("../electron/tools/sandbox/events.mjs");

/** A sidecar with a hand-written body, for fakes that answer more than one method. */
function scriptedSidecar(name, body) {
  const script = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(
    script,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + "\\n");
const FEATURES = ["process.run", "process.background"];
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "runtime.initialize") {
    send({ id: msg.id, result: { protocol_version: "1.1", runtime_version: "fake", tools: [], features: FEATURES } });
    return;
  }
  if (msg.method === "runtime.shutdown") {
    send({ id: msg.id, result: { ok: true } });
    process.exit(0);
  }
  ${body}
});
`,
  );
  const wrapper = path.join(tmp, `${name}.sh`);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
    mode: 0o755,
  });
  return wrapper;
}

/** Wait for a service event matching `pred`, or fail. */
async function waitForEvent(seen, pred, what) {
  for (let i = 0; i < 100; i++) {
    const hit = seen.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`no ${what} event arrived; saw ${JSON.stringify(seen.map((e) => e.type))}`);
}

test("a runtime-owned service is announced, listed, and cleared when the runtime says it ended", { skip: posixOnly }, async () => {
  // Answers peek with a dev server's usual output, then pushes an exit a moment later — after
  // startBackground has already settled and stopped looking.
  const file = scriptedSidecar(
    "service-lifecycle",
    `if (msg.method === "process.start_background") {
      send({ id: msg.id, result: { pid: 4242 } });
      setTimeout(() => notify("process.exited", { pid: 4242, code: 3, signal: null, output: "  build failed  ", command: "pretend-dev-server" }), 1200);
    } else if (msg.method === "process.peek") {
      send({ id: msg.id, result: { alive: true, output: "Local: http://localhost:5173/" } });
    }`,
  );

  const seen = [];
  setServiceEventHandler((e) => seen.push(e));
  try {
    await withSidecar(file, async () => {
      const msg = await native.startBackground("pretend-dev-server", { cwd: tmp, notify: true });
      // Every word of this comes from the host, whoever spawned the process.
      assert.match(msg, /Service started successfully/);
      assert.match(msg, /http:\/\/localhost:5173/);
      assert.match(msg, /\(pid 4242\)/);

      const started = await waitForEvent(seen, (e) => e.type === "started", "started");
      assert.equal(started.pid, 4242);
      assert.equal(started.url, "http://localhost:5173", "the URL is scraped by the host's own pattern");
      assert.ok(native.listProcesses().some((p) => p.pid === 4242), "and it is listed as running");

      // Nothing is polling by now. Only the pushed event can report this.
      const stopped = await waitForEvent(seen, (e) => e.type === "stopped", "stopped");
      assert.equal(stopped.pid, 4242);
      assert.equal(stopped.code, 3);
      assert.equal(stopped.reason, "exited");
      assert.equal(stopped.tail, "build failed", "the host clips and trims the tail, not the runtime");
      assert.equal(stopped.notify, true, "the notify flag set at start survives to the completion notice");
      assert.ok(!native.listProcesses().some((p) => p.pid === 4242), "and it stops being listed");
    });
  } finally {
    setServiceEventHandler(null);
  }
});

test("a runtime that dies takes its services out of the listing with it", { skip: posixOnly }, async () => {
  // Its children die with it, so those services are genuinely gone — but no process.exited can be
  // delivered to say so. Left alone the UI would keep offering to stop a pid that owns nothing.
  const file = scriptedSidecar(
    "service-then-crash",
    `if (msg.method === "process.start_background") {
      send({ id: msg.id, result: { pid: 5252 } });
      setTimeout(() => process.exit(1), 1200);
    } else if (msg.method === "process.peek") {
      send({ id: msg.id, result: { alive: true, output: "listening on 4000" } });
    }`,
  );

  const seen = [];
  setServiceEventHandler((e) => seen.push(e));
  try {
    await withSidecar(file, async () => {
      await native.startBackground("pretend-service", { cwd: tmp, notify: false });
      assert.ok(native.listProcesses().some((p) => p.pid === 5252));

      const stopped = await waitForEvent(seen, (e) => e.type === "stopped" && e.pid === 5252, "stopped");
      assert.equal(stopped.code, null, "there is no exit code to report when the reporter is what died");
      assert.ok(!native.listProcesses().some((p) => p.pid === 5252), "the phantom service is gone");
    });
  } finally {
    setServiceEventHandler(null);
  }
});

test("an exit that arrives in the same chunk as the start reply is not lost", { skip: posixOnly }, async () => {
  // The race, made deterministic. A service that ends almost immediately -- a one-off command mistaken
  // for a dev server, or one that dies on startup -- can have its exit written by the sidecar in the
  // same breath as the pid. Both lines then reach `onData` in one chunk, which handles them
  // synchronously: settling the start reply only SCHEDULES the caller's continuation as a microtask, so
  // the registration it performs has not happened yet when the exit handler looks for the pid.
  //
  // Dropped there, nothing ever removes the service again: it sits in the listing as running, the
  // indicator offers to stop a pid that owns nothing, and a `notify` job waits for a notice that will
  // never come.
  const file = scriptedSidecar(
    "exit-in-same-chunk",
    `if (msg.method === "process.start_background") {
      // One write, deliberately: this is what the kernel is free to deliver as a single chunk.
      process.stdout.write(
        JSON.stringify({ id: msg.id, result: { pid: 7373 } }) + "\\n" +
        JSON.stringify({ method: "process.exited", params: { pid: 7373, code: 0, signal: null, output: "done and gone", command: "quick" } }) + "\\n"
      );
    } else if (msg.method === "process.peek") {
      send({ id: msg.id, result: { alive: false, output: "done and gone" } });
    }`,
  );

  const seen = [];
  setServiceEventHandler((e) => seen.push(e));
  try {
    await withSidecar(file, async () => {
      const msg = await native.startBackground("quick", { cwd: tmp, notify: true });
      assert.match(msg, /Process has ended/, "a service that exited is reported as ended");

      const stopped = await waitForEvent(seen, (e) => e.type === "stopped" && e.pid === 7373, "stopped");
      assert.equal(stopped.tail, "done and gone", "and its output still reaches the completion notice");
      assert.ok(
        !native.listProcesses().some((p) => p.pid === 7373),
        "and it must not be left in the listing as a service that is still running",
      );
    });
  } finally {
    setServiceEventHandler(null);
  }
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
