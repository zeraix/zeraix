/**
 * Cancellation reaching the handlers that do the work (docs/agent-runtime-crash-recovery.md C6).
 *
 * The architecture doc's §13 finding was that a signal reached almost nothing: a web search or a page capture ran to
 * completion after Stop, and a timeout returned a timeout *result* while the underlying work carried on. Both are the
 * same defect seen from two sides, and both matter beyond tidiness — every other recovery category assumes the runtime
 * can be brought to rest before anything is reconciled, and work that cannot be stopped cannot be reconciled.
 *
 * Asserted against the shipped source, because the handlers need a live Electron main process to invoke.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolkit = fs.readFileSync(path.join(root, "electron/tools/aiToolkit.mjs"), "utf8");
const pageConsole = fs.readFileSync(path.join(root, "electron/tools/pageConsole.mjs"), "utf8");

/** The body of one handler in the toolkit's handler table, up to the next handler. */
function handler(name) {
  const start = toolkit.indexOf(`  async ${name}(`);
  assert.ok(start !== -1, `${name} is a handler`);
  const next = toolkit.indexOf("\n  async ", start + 1);
  return toolkit.slice(start, next === -1 ? start + 4000 : next);
}

test("runTool hands every handler the caller's signal", () => {
  // The plumbing was never the problem: the signal arrived and the handlers ignored it.
  assert.match(toolkit, /const content = await handler\(args \?\? \{\}, \{ signal \}\);/);
});

test("a timeout aborts the socket rather than only returning a timeout", () => {
  // Spec §15: a timeout must trigger real cancellation. Composing the two signals is what makes that true —
  // before this, the timeout aborted the fetch and the user's Stop was not passed in at all.
  const get = toolkit.slice(toolkit.indexOf("async function httpGet"), toolkit.indexOf("async function httpGet") + 900);
  assert.match(get, /AbortSignal\.any\(\[signal, ctrl\.signal\]\)/);
  assert.match(get, /signal: composed/, "the composed signal is what the fetch actually uses");
  assert.match(get, /typeof AbortSignal\.any === "function"/, "and the timeout still works if it is ever absent");
});

test("the network tools pass Stop down to the socket", () => {
  for (const name of ["web_search", "fetch_url", "page_console"]) {
    const body = handler(name);
    assert.match(body, /\{ signal \} = \{\}\)/, `${name} accepts the signal`);
    assert.match(body, /throwIfAborted\(signal\)/, `${name} refuses to start once stopped`);
  }
  assert.match(handler("web_search"), /httpGet\(endpoint, \{ accept: "text\/html", signal \}\)/);
  assert.match(handler("fetch_url"), /httpGet\(target, \{\n\s*signal,/);
  assert.match(handler("page_console"), /capturePageConsole\(\{[^}]*signal \}\)/s);
});

test("every disk mutator refuses to run after Stop", () => {
  // A small window — between dispatch and the write — but it is the difference between "the user cancelled and
  // nothing happened" and "the user cancelled and a file moved".
  //
  // These five used to be handlers here, each opening with its own `throwIfAborted(signal)`. They are served by
  // the Rust runtime now, where the check is made ONCE for every tool in `ToolRegistry::execute` ("Cheap
  // pre-check: if the caller already gave up, do not start work at all") — so the guarantee is no longer
  // something each tool can forget, and the JS handlers are gone rather than silently skipping the check.
  //
  // What is pinned here is the routing that makes that true: the runtime must be the only thing serving them.
  // If one reappears as a handler in this file, or drops out of RUNTIME_ONLY_TOOLS, this fires.
  const bridge = fs.readFileSync(path.join(root, "electron/tools/rustRuntime.mjs"), "utf8");
  const runtimeOnly = bridge.slice(bridge.indexOf("const RUNTIME_ONLY_TOOLS"), bridge.indexOf("];", bridge.indexOf("const RUNTIME_ONLY_TOOLS")));
  for (const name of ["append_file", "delete_file", "copy_file", "move_file", "create_directory"]) {
    assert.ok(runtimeOnly.includes(`"${name}"`), `${name} is served by the runtime`);
    assert.equal(toolkit.indexOf(`  async ${name}(`), -1, `${name} has no JS handler to bypass the runtime's check`);
  }
  // And the check the runtime makes on their behalf still exists.
  const registry = fs.readFileSync(path.join(root, "runtime/crates/agent-tools/src/registry.rs"), "utf8");
  assert.match(registry, /ctx\.check_cancelled\(\)\?;/, "the runtime pre-checks cancellation before any tool runs");
});

test("a stopped handler throws, so it needs no contract of its own", () => {
  // runTool already turns a throw into { ok: false }, and the loop is already watching the signal.
  const guard = toolkit.slice(toolkit.indexOf("function throwIfAborted"), toolkit.indexOf("function throwIfAborted") + 160);
  assert.match(guard, /throw new Error\("The user stopped this operation\."\)/);
  assert.doesNotMatch(guard, /return\s/, "it throws rather than returning a sentinel callers would have to know about");
});

test("the page capture's waits both end on Stop", () => {
  // Two waits: the load race (up to LOAD_TIMEOUT_MS) and the settle pause. A Stop used to end neither, so a hidden
  // window kept loading a page for up to twenty more seconds after the user gave up.
  assert.match(pageConsole, /function waitOrAbort\(ms, signal\)/);
  assert.match(pageConsole, /waitOrAbort\(LOAD_TIMEOUT_MS, signal\)/, "the load race ends on Stop");
  assert.match(pageConsole, /await waitOrAbort\(settle, signal\)/, "and so does the settle pause");
  assert.match(pageConsole, /signal\?\.aborted\) throw new Error\("The user stopped this operation\."\)/, "and it refuses to start");
});

test("the wait resolves on abort rather than rejecting", () => {
  // Every caller here treats the wait as "we have waited long enough", not as a step that can fail; rejecting
  // would turn a cancel into an error report in the middle of a teardown that was going to happen anyway.
  const w = pageConsole.slice(pageConsole.indexOf("function waitOrAbort"), pageConsole.indexOf("export async function capturePageConsole"));
  assert.match(w, /resolve\(\)/);
  assert.doesNotMatch(w, /reject/);
});

test("a capture cut short is reported as stopped, never as clean", () => {
  // The one wrong answer: telling the model a truncated capture found nothing wrong.
  assert.match(pageConsole, /The user stopped this page capture\./);
  const idx = pageConsole.indexOf("The user stopped this page capture.");
  const head = pageConsole.indexOf("const head =");
  assert.ok(idx < head, "the stopped branch returns before the normal summary is built");
});
