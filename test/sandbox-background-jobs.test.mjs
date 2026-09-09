/**
 * A background command inside the sandbox has to be noticed when it ENDS.
 *
 * The native engine gets this for free: it holds a child process object, so `child.on("exit")` fires
 * whether or not anyone asked to be notified, and the service table is cleaned either way. A guest job
 * has no such object — it was launched with `setsid … &` inside the VM — so the only way to learn it
 * finished is to poll it.
 *
 * That poll used to be started only for `notify` jobs. The consequence was reported from the app: a
 * background command that ends on its own (`sleep 60 && ls …`, sandbox: true) stayed in the service
 * table for the life of the VM — listed as running, offered by stop_service under a guest pid that
 * answers to nothing, and holding host port forwards that pointed nowhere.
 *
 * Asserted against the shipped source, in the style of sandbox-resilience.test.mjs: these paths need a
 * real VM, and the property worth pinning is structural — WHO gets watched, and where the notify flag
 * comes from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const qemu = fs.readFileSync(path.join(root, "electron/tools/sandbox/qemu.mjs"), "utf8");
const native = fs.readFileSync(path.join(root, "electron/tools/sandbox/native.mjs"), "utf8");

test("every guest background job is watched, not only the ones that asked to be notified", () => {
  // Call sites only — the declaration `function watchGuestJob({ … })` matches the same shape.
  const call = qemu.match(/(?<!function\s)watchGuestJob\(\{[^}]*\}\)/g) ?? [];
  assert.equal(call.length, 1, "one place starts the watcher");
  // The regression this file exists for: `if (opts.notify) watchGuestJob(...)`.
  assert.doesNotMatch(
    qemu,
    /if\s*\(\s*opts\.notify\s*\)\s*watchGuestJob/,
    "watching must not be gated on notify — an unwatched job never leaves the service table",
  );
  assert.match(call[0], /notify:\s*!!opts\.notify/, "the flag is passed through, not assumed");
});

test("notify decides who is woken, never whether the job is reaped", () => {
  const watcher = qemu.slice(qemu.indexOf("function watchGuestJob"), qemu.indexOf("function stopWatching"));
  // The table entry and its port forwards are released on exit unconditionally...
  assert.match(watcher, /procs\.delete\(key\)/, "the finished job leaves the service table");
  assert.match(watcher, /removePort/, "its host forwards are released");
  // ...while the emitted event only WAKES the model when this job asked for it.
  assert.match(watcher, /notify:\s*!!notify/, "the event carries the caller's choice");
  assert.doesNotMatch(watcher, /notify:\s*true/, "never hardcoded — that would wake the model for every job");
});

test("the native engine keeps the behaviour the guest one is being matched to", () => {
  // The reference implementation: exit is handled for every background child, and notify only rides
  // along on the event. If this ever changes, the guest rule above is no longer 'parity'.
  const onExit = native.slice(native.indexOf('child.on("exit"'), native.indexOf("child.unref"));
  assert.match(onExit, /emitService\(\{/, "an exit always emits");
  assert.match(onExit, /notify:\s*!!entry\?\.notify/, "and carries the caller's choice");
});
