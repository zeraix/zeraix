/**
 * Which commands run_command starts in the background on its own (electron/tools/commandShape.mjs).
 *
 * The rule decides what shows up in the running-services panel: a backgrounded command is registered as a
 * service the user can stop. It used to be a keyword match over the whole command line, and the panel
 * filled with things that were never services — a curl to a `/dev/` path, a `git checkout dev`, a
 * `cat dev.log`. The cases below are the ones that were wrong, next to the ones that must keep working.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { looksLongRunning, firstProgram } = await import("../electron/tools/commandShape.mjs");

test("dev servers and watchers are started in the background", () => {
  for (const cmd of [
    "npm run dev",
    "npm start",
    "yarn dev",
    "pnpm dev --host",
    "bun dev",
    "npx vite",
    "vite preview",
    "npx webpack-dev-server",
    "nodemon server.js",
    "next dev -p 3001",
    "npm run watch",
    "serve -s build",
    "cd app && npm run dev",
    "cd app; npm start",
    "PORT=4000 npm start",
    "sudo npm start",
    'powershell -Command "Set-Location \'C:\\proj\'; npm run dev"',
    "./dev.sh",
    "./serve",
    "start.cmd",
  ]) {
    assert.equal(looksLongRunning(cmd), true, cmd);
  }
});

test("a fetch is never a service, whatever its URL says", () => {
  for (const cmd of [
    "curl http://localhost:3000/dev/api",
    "curl -s http://localhost:8080/preview",
    "curl -X POST http://localhost:5173/start",
    "curl -v http://localhost:3000/ | head -c 200",
    "wget http://localhost:8000/watch",
    'Invoke-WebRequest -Uri "http://localhost:3000/dev"',
    "iwr http://localhost:3000/start",
    "http GET localhost:3000/dev",
    "cd app && curl http://localhost:3000/dev",
  ]) {
    assert.equal(looksLongRunning(cmd), false, cmd);
  }
});

test("a word inside a path, a file name or a branch is not a verb", () => {
  for (const cmd of [
    "git checkout dev",
    "git log --oneline dev",
    "cat dev.log",
    "Get-Content dev.log",
    "type start.txt",
    "ls /dev/shm",
    "grep -r start src/",
    "echo start",
    'echo "dev server is up"',
    "cp preview.png out/",
    "python -c \"print('start')\"",
    "npm run build",
    "npm test",
    "git status",
  ]) {
    assert.equal(looksLongRunning(cmd), false, cmd);
  }
});

test("the program name is found past env assignments, wrappers, paths and .exe", () => {
  assert.equal(firstProgram("PORT=3000 NODE_ENV=dev npm start"), "npm");
  assert.equal(firstProgram("sudo env FOO=1 nohup vite"), "vite");
  assert.equal(firstProgram('"C:\\Program Files\\nodejs\\npm.cmd" run dev'), "npm.cmd");
  assert.equal(firstProgram("/usr/bin/curl.exe -s http://localhost"), "curl");
  assert.equal(firstProgram("   "), "");
  assert.equal(looksLongRunning(""), false);
  assert.equal(looksLongRunning(undefined), false);
});
