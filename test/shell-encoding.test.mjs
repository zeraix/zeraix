/**
 * The UTF-8 wrapper every host command goes through (electron/tools/sandbox/shellEncoding.mjs).
 *
 * Windows gets a UTF-8 console code page, so `echo 中文 > f` writes UTF-8 rather than cp936; macOS and Linux get
 * a UTF-8 LANG only when the app inherited none. The wrapper must leave the command's own exit status and its
 * `&&` / `||` chains alone, and must not touch an empty command.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { utf8Shell } from "../electron/tools/sandbox/shellEncoding.mjs";

const sh = promisify(execFile);

test("windows: the code page switch precedes the command and its output is silenced", () => {
  assert.equal(utf8Shell("echo 中文 > out.csv", "win32"), "chcp 65001>nul & echo 中文 > out.csv");
  assert.equal(utf8Shell("cd app && npm test", "win32"), "chcp 65001>nul & cd app && npm test");
});

test("posix: a UTF-8 LANG is set only when the environment carries no locale", () => {
  assert.equal(utf8Shell("ls", "darwin"), 'if [ -z "$LANG$LC_ALL" ]; then export LANG=en_US.UTF-8; fi; ls');
  assert.equal(utf8Shell("ls", "linux"), 'if [ -z "$LANG$LC_ALL" ]; then export LANG=C.UTF-8; fi; ls');
});

test("an empty command stays empty", () => {
  assert.equal(utf8Shell("", "win32"), "");
  assert.equal(utf8Shell("   ", "darwin"), "   ");
});

test("posix wrapper: the command's exit status and chains survive, and an existing locale is kept", async () => {
  if (process.platform === "win32") return;
  const run = (cmd, env) => sh("/bin/sh", ["-c", utf8Shell(cmd, "linux")], { env: { PATH: process.env.PATH, ...env } });
  const a = await run("echo $LANG", {});
  assert.equal(a.stdout.trim(), "C.UTF-8", "set when absent");
  const b = await run("echo $LANG", { LANG: "fr_FR.UTF-8" });
  assert.equal(b.stdout.trim(), "fr_FR.UTF-8", "kept when present");
  const c = await run("echo $LANG", { LC_ALL: "de_DE.UTF-8" });
  assert.equal(c.stdout.trim(), "", "LC_ALL present: LANG left alone");
  await assert.rejects(run("false && echo no", {}), (e) => e.code === 1);
  const d = await run("printf 中文", {});
  assert.equal(d.stdout, "中文");
});
