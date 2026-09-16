/**
 * Telling the Rust runtime which MCP servers the user approved (electron/tools/runtimeMcp.mjs, `mcpSetApproved`).
 *
 * The runtime refuses every `mcp.call` to a server it was not told is approved, and before this call existed
 * the host never told it — so every runtime-owned server showed as connected and failed each tool call with
 * "outside the configured ceiling". These drive the bridge against a fake sidecar, like
 * rust-runtime-process.test.mjs, and so need no `cargo build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rust = await import("../electron/tools/rustRuntime.mjs");
const { mcpSetApproved } = await import("../electron/tools/runtimeMcp.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-fake-mcp-sidecar-"));
// See rust-runtime-process.test.mjs: a fake sidecar needs a POSIX exec wrapper.
const posixOnly = process.platform === "win32" ? "fake sidecars need a POSIX exec wrapper" : false;

/** A fake sidecar announcing `features`, answering `mcp.set_approved` by echoing what it was sent. */
function fakeSidecar(name, features) {
  const script = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(
    script,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "runtime.initialize") {
    send({ id: msg.id, result: { protocol_version: "1.1", runtime_version: "fake", tools: [], features: ${JSON.stringify(features)} } });
  } else if (msg.method === "runtime.shutdown") {
    send({ id: msg.id, result: { ok: true } });
    process.exit(0);
  } else if (msg.method === "mcp.set_approved") {
    send({ id: msg.id, result: { applied: true, heard: msg.params.servers } });
  }
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

test("the approved list reaches a runtime that accepts it", { skip: posixOnly }, async () => {
  await withSidecar(fakeSidecar("approval", ["mcp.stdio", "mcp.http", "mcp.approval"]), async () => {
    assert.equal(await rust.hasFeature("mcp.approval"), true);
    assert.equal(await mcpSetApproved(["local-mcp", "other"]), true);
  });
});

test("a runtime too old to accept the list is reported as not delivered", { skip: posixOnly }, async () => {
  await withSidecar(fakeSidecar("no-approval", ["mcp.stdio", "mcp.http"]), async () => {
    assert.equal(await rust.hasFeature("mcp.http"), true);
    // client.mjs keeps such a server on the SDK path rather than handing it to a runtime that denies every call.
    assert.equal(await rust.hasFeature("mcp.approval"), false);
    assert.equal(await mcpSetApproved(["local-mcp"]), false);
  });
});

test("sending the list never starts the runtime", { skip: posixOnly }, async () => {
  await withSidecar(fakeSidecar("not-started", ["mcp.stdio", "mcp.approval"]), async () => {
    assert.equal(await mcpSetApproved(["local-mcp"]), false);
    assert.equal(rust.isReady(), false);
  });
});
