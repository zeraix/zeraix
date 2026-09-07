/**
 * Reclaiming what a crashed run left behind (docs/agent-runtime-crash-recovery.md C4).
 *
 * Two leaks with the same cause: `before-quit` is the only thing that cleans up, and a hard kill never runs it. The
 * startup sweep is the backstop, and until now it knew about command trees and nothing else — an MCP stdio server, a
 * terminal shell and the automation child all outlived the app unobserved. The other leak is quieter: every atomic
 * write leaves a `.tmp` if it is interrupted, and nothing ever removed one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sweepTempFiles, ABANDONED_AFTER_MS } from "../electron/store/tempSweep.mjs";
import { setRecoveryLogDir, readRecoveryLog } from "../electron/store/recoveryLog.mjs";
import { sweepAndRecord } from "../electron/store/tempSweep.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zeraix-${name}-`));
}

/** Write a file and backdate it, so "old" does not mean "wait an hour". */
function aged(dir, name, ageMs) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, "x");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(full, when, when);
  return full;
}

// ── the temp sweep ──────────────────────────────────────────────────────────────────────────────

test("an abandoned .tmp is removed and a fresh one is left alone", () => {
  const dir = tmpdir("temp");
  const old = aged(dir, "index.json.tmp", ABANDONED_AFTER_MS + 60_000);
  const fresh = aged(dir, "conversations.json.tmp", 5_000);

  const { removed, skipped } = sweepTempFiles([dir]);
  assert.deepEqual(removed, [old]);
  assert.deepEqual(skipped, [fresh], "a young .tmp may belong to a write happening right now");
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("it only ever touches the suffix this app's atomic writes produce", () => {
  const dir = tmpdir("temp-scope");
  const keep = [
    aged(dir, "index.json", ABANDONED_AFTER_MS * 2),
    aged(dir, "notes.tmp.md", ABANDONED_AFTER_MS * 2),
    aged(dir, "tmp", ABANDONED_AFTER_MS * 2),
    aged(dir, "report.TMP", ABANDONED_AFTER_MS * 2), // a user's file, not one of ours
  ];
  const { removed } = sweepTempFiles([dir]);
  assert.deepEqual(removed, [], "nothing but an exact `.tmp` suffix is a candidate");
  for (const f of keep) assert.equal(fs.existsSync(f), true, f);
});

test("it does not recurse, so a user's own tree is never walked", () => {
  const dir = tmpdir("temp-shallow");
  const nested = path.join(dir, "projects", "deep");
  fs.mkdirSync(nested, { recursive: true });
  const buried = aged(nested, "stale.tmp", ABANDONED_AFTER_MS * 2);

  const { removed } = sweepTempFiles([dir]);
  assert.deepEqual(removed, []);
  assert.equal(fs.existsSync(buried), true, "one shallow pass per configured directory, by design");
});

test("a missing or unreadable directory is ordinary, not an error", () => {
  assert.doesNotThrow(() => sweepTempFiles([path.join(os.tmpdir(), "zeraix-does-not-exist-ever")]));
  assert.doesNotThrow(() => sweepTempFiles([undefined, "", null]));
  assert.deepEqual(sweepTempFiles([]).removed, []);
});

test("a sweep that removed nothing writes no recovery entry", () => {
  const dir = tmpdir("temp-quiet");
  setRecoveryLogDir(path.join(dir, "logs"));
  aged(dir, "fresh.json.tmp", 1_000);
  sweepAndRecord([dir]);
  assert.deepEqual(readRecoveryLog(), [], "an ordinary launch is silent");

  aged(dir, "stale.json.tmp", ABANDONED_AFTER_MS * 2);
  sweepAndRecord([dir]);
  const log = readRecoveryLog();
  assert.equal(log.at(-1).component, "temp");
  assert.equal(log.at(-1).detail.removed, 1);
  assert.deepEqual(log.at(-1).detail.names, ["stale.json.tmp"], "names, not paths: a log should not carry the user's layout");
  setRecoveryLogDir("");
});

// ── what the orphan sweep now knows about ───────────────────────────────────────────────────────

test("every kind of child this app spawns is recorded for the sweep", () => {
  // Before this, only command trees were. The other three each outlive a hard kill in their own way: an MCP
  // server holds whatever it opened, a terminal can hold a build, and the automation child holds a browser.
  const cases = [
    ["electron/tools/sandbox/native.mjs", /recordChild\(/, "commands and background services"],
    ["electron/mcp/client.mjs", /recordChild\(e\.pid, `mcp server:/, "MCP stdio servers"],
    ["electron/tools/terminal.mjs", /recordChild\(pty\.pid, `terminal:/, "terminal shells"],
    ["electron/main.mjs", /recordChild\(automationChild\.pid, "automation: cdpAgent"\)/, "the automation child"],
  ];
  for (const [file, pattern, what] of cases) {
    assert.match(read(file), pattern, `${what} are recorded (${file})`);
  }
});

test("each new record is paired with a forget, so the file never names a dead pid", () => {
  // An unpaired record is not harmless: the next launch would try to kill a pid that has since been reused.
  assert.match(read("electron/mcp/client.mjs"), /if \(e\.pid\) forgetChild\(e\.pid\);/);
  assert.match(read("electron/tools/terminal.mjs"), /forgetChild\(pty\.pid\);/);
  assert.match(read("electron/main.mjs"), /if \(automationChild\?\.pid\) forgetChild\(automationChild\.pid\);/);
});

test("the sweep runs before anything else writes to those directories", () => {
  const main = read("electron/main.mjs");
  const sweep = main.indexOf("sweepAndRecord([");
  const orphans = main.indexOf("void reapOrphans()");
  assert.ok(sweep !== -1 && orphans !== -1);
  assert.ok(sweep < orphans, "the temp sweep is part of the same startup recovery pass");
});
