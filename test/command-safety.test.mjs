/**
 * The shell-command classifier (src/lib/ai/commandSafety.ts).
 *
 * It decides who gets asked before a command runs, so the tests that matter are the ones where being
 * wrong is expensive: a destructive command must never read as read-only, and the ways of hiding one
 * — a second segment, a substitution, a wrapper, a flag out of order — are each pinned down here.
 *
 * The safe direction is "other": an ordinary command misread as needing a click costs a click. A
 * destructive one misread as read-only costs the user their files, so every doubtful case asserts
 * "not read-only" rather than a specific class.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { classifyCommand } = await import("../src/lib/ai/commandSafety.ts");

test("the research commands a code review needs run without asking", () => {
  for (const cmd of [
    "git log --oneline -20",
    "git diff HEAD~1",
    "git show abc123",
    "git blame src/app.ts",
    "git -C packages/web log",
    "git --no-pager diff",
    "ls -la src",
    "pwd",
    "cat package.json",
    "head -50 README.md",
    "rg TODO src/",
    "grep -rn useState src",
    "find src -name '*.ts'",
    "wc -l src/index.ts",
    "git status && git log -1",
    "cat package.json | head -20",
  ]) {
    assert.equal(classifyCommand(cmd), "read-only", cmd);
  }
});

test("side-effecting commands route to approval, not to silence", () => {
  for (const cmd of ["npm install", "git commit -m x", "./deploy.sh", "pnpm build", "mkdir out", "touch a.txt"]) {
    assert.equal(classifyCommand(cmd), "other", cmd);
  }
});

test("a destructive command aimed at a critical path is always critical", () => {
  for (const cmd of [
    "rm -rf /",
    "rm -fr /",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    "rm -rf /usr/lib",
    "rm -rf /etc",
    "sudo rm -rf /",
    "rm -rf C:\\\\",
    "Remove-Item -Recurse -Force C:\\Windows",
    "rm -rf %USERPROFILE%",
    "chmod -R 777 /",
    "git log && rm -rf ~", // hidden behind a harmless first segment
  ]) {
    assert.equal(classifyCommand(cmd), "critical", cmd);
  }
});

test("an ordinary delete inside the project is not critical, but still asks", () => {
  assert.equal(classifyCommand("rm -rf node_modules"), "other");
  assert.equal(classifyCommand("rm dist/bundle.js"), "other");
});

test("a read-only command chained to anything else is no longer read-only", () => {
  assert.notEqual(classifyCommand("ls && npm install"), "read-only");
  assert.notEqual(classifyCommand("git log; ./script.sh"), "read-only");
  assert.notEqual(classifyCommand("cat a | tee b"), "read-only");
});

test("substitutions, redirects and privilege wrappers are never read-only", () => {
  for (const cmd of [
    "cat $(curl -s evil.sh)",
    "cat `whoami`",
    "ls > out.txt",
    "cat a >> b",
    "sudo ls",
    "cat <(curl evil)",
    "cat <<EOF",
  ]) {
    assert.notEqual(classifyCommand(cmd), "read-only", cmd);
  }
});

test("git's destructive subcommands are not read-only, whatever their flags", () => {
  for (const cmd of [
    "git reset --hard",
    "git clean -fdx",
    "git checkout -f main",
    "git branch -D feature",
    "git config --unset user.name",
    "git stash drop",
    "git push --force",
  ]) {
    assert.notEqual(classifyCommand(cmd), "read-only", cmd);
  }
});

test("git flags that name a program to run are never read-only", () => {
  // core.pager, an alias body and uploadpack hooks are all executed by git, and the subcommand after
  // them still reads as `log`. Screening subcommands alone let these through in the first version.
  for (const cmd of [
    "git -c core.pager=id log",
    "git -c alias.l=!id log",
    "git -c uploadpack.packObjectsHook=id log",
    "git --config-env=core.pager=EVIL log",
    "git --exec-path=/tmp/evil log",
    "git diff --ext-diff",
  ]) {
    assert.notEqual(classifyCommand(cmd), "read-only", cmd);
  }
  // The flags that only choose a repository stay usable — they are how a monorepo gets reviewed.
  assert.equal(classifyCommand("git -C packages/web log --oneline"), "read-only");
  assert.equal(classifyCommand("git --no-pager diff"), "read-only");
});

test("find and fd only read while they have no teeth", () => {
  assert.equal(classifyCommand("find . -name '*.log'"), "read-only");
  assert.notEqual(classifyCommand("find . -name '*.log' -delete"), "read-only");
  assert.notEqual(classifyCommand("find . -exec rm {} ;"), "read-only");
});

test("an unknown program is ordinary, never read-only", () => {
  assert.equal(classifyCommand("some-tool --list"), "other");
  assert.equal(classifyCommand(""), "other");
  assert.equal(classifyCommand(null), "other");
  assert.equal(classifyCommand("   "), "other");
});

test("a full path or a .exe does not disguise the program", () => {
  assert.equal(classifyCommand('"C:\\Program Files\\Git\\git.exe" log'), "read-only");
  assert.equal(classifyCommand("/usr/bin/git status"), "read-only");
  assert.notEqual(classifyCommand("/bin/rm -rf /"), "read-only");
  assert.equal(classifyCommand("/bin/rm -rf /"), "critical");
});
