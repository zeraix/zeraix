/**
 * The sandbox surviving its own death (docs/agent-runtime-crash-recovery.md C5).
 *
 * The find here is not a missing feature, it is a wrong sentence. When the VM stopped while a command was running,
 * the model was told "The command was NOT run" — which is true when the sandbox was never up, and flatly wrong when
 * the command had already started, may have finished, and may already have written files or installed packages.
 * Telling the model a command did not run when it may have is precisely how a crash becomes a second `npm install`,
 * which is the rule (§5) this whole document is built on.
 *
 * Asserted against the shipped source: these paths need a real VM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const qemu = fs.readFileSync(path.join(root, "electron/tools/sandbox/qemu.mjs"), "utf8");
const control = fs.readFileSync(path.join(root, "electron/tools/sandbox/control.mjs"), "utf8");
const main = fs.readFileSync(path.join(root, "electron/main.mjs"), "utf8");

function block(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a !== -1, `${start} exists`);
  const b = end ? src.indexOf(end, a + 1) : -1;
  return src.slice(a, b === -1 ? a + 2500 : b);
}

test("a command that had started is never reported as not run", () => {
  const died = block(qemu, "function sandboxDiedMidCommand", "/**\n * Check that the guest");
  assert.match(died, /STATUS UNKNOWN/);
  assert.match(died, /may have completed, partly completed, or done nothing/);
  assert.match(died, /Do NOT assume it failed and do NOT simply repeat it/);
  assert.match(died, /check the working/i);
  assert.doesNotMatch(died, /was NOT run/, "that sentence belongs to the never-started case and only there");
});

test("the never-started case keeps its own, different answer", () => {
  const never = block(qemu, "function sandboxFailure", "function sandboxDiedMidCommand");
  assert.match(never, /The command was NOT run/, "true here, and the reason the two are separate functions");
  assert.doesNotMatch(never, /STATUS UNKNOWN/);
});

test("the two are told apart by evidence, not by guessing", () => {
  // control.mjs marks the failure once the guest process provably exists; run() branches on that mark.
  assert.match(control, /e\.started = true;/);
  assert.match(control, /e\.guestPid = pid;/);
  const started = control.indexOf("e.started = true;");
  const exec = control.indexOf("execute: 'guest-exec-status'");
  assert.ok(exec !== -1 && started > exec - 400, "the mark is set only inside the polling loop, after the pid exists");
  assert.match(qemu, /if \(e\?\.started\) \{/);
});

test("a mid-command death restarts the sandbox once, not once per command", () => {
  const restart = block(qemu, "let restarting = null;", "/** Foreground execution");
  assert.match(restart, /if \(restarting\) return restarting;/, "concurrent deaths share one restart");
  assert.match(restart, /finally \{\n\s*restarting = null;/, "and the latch is released however it ends");
  assert.match(restart, /recordRecovery\("sandbox", "restarted"/);
  // The command's own answer must not wait on the restart: its fate is already unknown either way.
  assert.match(qemu, /void restartAfterDeath\(/);
});

test("waking from sleep is treated as a partial crash", () => {
  const probe = block(qemu, "export async function probeAfterResume", "let restarting = null;");
  assert.match(probe, /if \(!vm \|\| restarting/, "nothing to probe, or a restart is already running");
  assert.match(probe, /vm\.guest\.exec\("\/bin\/true", \[\]\)/, "a probe, not a real command");
  assert.match(probe, /await restartAfterDeath\(/);
  assert.match(probe, /recordRecovery\("sandbox", "unresponsive-after-resume"/);
  assert.match(main, /powerMonitor\.on\("resume"/, "and the host actually subscribes to it");
});

test("the probe stands down while a real command is in flight", () => {
  // Not politeness: the guest-agent channel matches replies to requests POSITIONALLY, which is only sound while one
  // caller is in flight — control.mjs says so itself. A probe sent concurrently with a running command can hand that
  // command someone else's reply, which is a far worse outcome than a missed probe.
  const probe = block(qemu, "export async function probeAfterResume", "let restarting = null;");
  assert.match(probe, /commandsInFlight > 0/, "a running command suppresses the probe");
  assert.match(probe, /restarting/, "and it defers to a restart already under way");
  // The counter has to be maintained around the call that actually talks to the guest, and released on every path.
  const run = block(qemu, "export async function run(cmd, opts", "// ── Background long-lived services");
  assert.match(run, /commandsInFlight \+= 1;/);
  assert.match(run, /finally \{\n\s*commandsInFlight -= 1;/, "released even when the command throws");
});

test("no partial output is invented for a command whose bytes are gone", () => {
  // qemu's guest agent returns a command's stdout only when it has exited, so a VM that dies mid-command takes the
  // output with it. Claiming empty output would read as "the command produced nothing", which is a different claim.
  const died = block(qemu, "function sandboxDiedMidCommand", "/**\n * Check that the guest");
  assert.match(died, /stdout: "",/);
  assert.match(died, /Its output was lost with the sandbox/, "said plainly rather than implied by an empty string");
  assert.match(qemu, /returns a command's stdout only once it has exited/, "and the reason is recorded where someone will look");
});

test("an unknown outcome is distinguishable by the caller, not only by prose", () => {
  const died = block(qemu, "function sandboxDiedMidCommand", "/**\n * Check that the guest");
  assert.match(died, /unknown: true/, "a flag the host can branch on later without parsing English");
  assert.match(died, /code: 125/, "and a code distinct from the 126 the never-started case uses");
});

test("an automatic restart never becomes an automatic download", () => {
  // boot() goes through ensureRootfs, which fetches a multi-gigabyte image when one is missing — and "missing" is
  // exactly the state the self-heal leaves behind after condemning a corrupt image. Starting that in the background
  // off the back of one failed command, with no consent and no progress, is a surprise rather than a recovery.
  const restart = block(qemu, "let restarting = null;", "/** Foreground execution");
  assert.match(restart, /VM_FILES\.filter\(\(f\) => !fs\.existsSync/, "the image must already be on disk");
  assert.match(restart, /recordRecovery\("sandbox", "restart-skipped"/);
  const check = restart.indexOf("VM_FILES.filter");
  const boot = restart.indexOf("await boot()");
  assert.ok(check !== -1 && boot !== -1 && check < boot, "and the check comes before the boot, not after");
});

test("the resume probe is bounded, because the thing it detects is a guest that never answers", () => {
  // `guest.exec` polls guest-exec-status in an unbounded loop. A guest whose socket is alive but which completes
  // nothing would keep an unbounded probe pending for ever — exactly the state the probe exists to report, and the
  // one it would then never report. The bound has to live here, not in the shared exec.
  const probe = block(qemu, "export async function probeAfterResume", "let restarting = null;");
  assert.match(probe, /Promise\.race\(\[/);
  assert.match(probe, /RESUME_PROBE_MS/);
  assert.match(qemu, /const RESUME_PROBE_MS = \d+;/);
  assert.match(probe, /t\.unref\?\.\(\)/, "and the timer never holds the process open on its own");
});
