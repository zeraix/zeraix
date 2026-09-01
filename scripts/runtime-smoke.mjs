#!/usr/bin/env node
/**
 * Runtime smoke check: every tool the app depends on is actually served by the sidecar.
 *
 * ## What this replaced, and why
 *
 * This was `ab-runtime-parity.mjs`, which ran each tool through the JS handler and the Rust sidecar and
 * diffed the two byte for byte. That was the right check while both existed — it is what let the migration
 * claim the replacement behaved identically rather than merely plausibly.
 *
 * The JS handlers were deleted at 2.0 (TODO §0.2 F1). There is no second implementation to compare against,
 * so parity is not a question that can be asked any more.
 *
 * What replaced it is the invariant that took its place. With no fallback, **a tool the sidecar fails to serve
 * is a tool the app does not have** — a missing `read_file` is no longer a slow path, it is a broken install.
 * That is worth checking on every platform CI builds for, and it is exactly what disappeared when parity did.
 *
 * ## What it asserts
 *
 *  - the sidecar starts and completes its handshake;
 *  - it declares every tool the app cannot run without;
 *  - each of those tools actually executes against a fixture and returns a well-formed result;
 *  - `process.run` honours the engine contract that `run_command` depends on.
 *
 * It does NOT assert exact output. That was parity's job and parity needed two implementations; asserting
 * the Rust output against a copy of itself would only pin it to whatever it happens to do today.
 *
 * Usage:
 *   node --import ./scripts/electron-stub-hook.mjs scripts/runtime-smoke.mjs
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const rust = await import("../electron/tools/rustRuntime.mjs");
const native = await import("../electron/tools/sandbox/native.mjs");

/**
 * Tools the app cannot run without.
 *
 * Listed here rather than derived from the handshake on purpose: the failure this guards against is the
 * sidecar declaring FEWER tools than it should, and a check that reads its list and then verifies that same
 * list would pass no matter how much was missing.
 */
const REQUIRED = [
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "file_info",
  "search_files",
  "search_in_files",
];

/** A small fixture with the boundaries worth touching: CRLF, non-ASCII, empty, nested. */
async function buildFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zeraix-smoke-"));
  const w = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  w("README.md", "# Title\n\nneedle here\nsecond line\n");
  w("crlf.txt", "one\r\ntwo\r\nneedle\r\nfour\r\n");
  w("unicode.txt", "中文一行\nneedle 中文\n😀 emoji line\n");
  w("empty.txt", "");
  w("src/index.ts", "export const x = 1;\n// needle\n");
  w("src/deep/nested/mod.rs", "fn main() { /* needle */ }\n");
  fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });
  return root;
}

/** One call per required tool, chosen so a wrong answer is visible in the result rather than only in a code. */
function cases(root) {
  return [
    ["read_file", { path: "README.md" }, (r) => r.content.includes("needle here")],
    ["read_file", { path: "crlf.txt" }, (r) => r.content.includes("needle")],
    ["read_file", { path: "unicode.txt" }, (r) => r.content.includes("中文")],
    ["read_file", { path: "empty.txt" }, (r) => r.ok],
    ["list_directory", { path: "." }, (r) => r.content.includes("README.md")],
    ["list_directory", { path: "empty-dir" }, (r) => r.ok],
    ["file_info", { path: "README.md" }, (r) => r.ok && r.content.length > 0],
    ["search_files", { pattern: "*.ts" }, (r) => r.content.includes("index.ts")],
    ["search_in_files", { query: "needle" }, (r) => r.content.includes("README.md")],
    ["search_in_files", { query: "no-such-string-anywhere" }, (r) => r.ok],
    ["write_file", { path: "written.txt", content: "hello\n" }, (r) => r.ok && fs.readFileSync(path.join(root, "written.txt"), "utf8") === "hello\n"],
    // The guarantee that is easiest to lose in a rewrite: a model sends LF, the file keeps its CRLF.
    ["edit_file", { path: "crlf.txt", old_string: "one\ntwo", new_string: "one\nTWO" }, () =>
      fs.readFileSync(path.join(root, "crlf.txt"), "utf8") === "one\r\nTWO\r\nneedle\r\nfour\r\n"],
    // A failure is a RESULT, not an exception — the contract the whole tool layer rests on.
    ["read_file", { path: "does-not-exist.txt" }, (r) => r.ok === false && r.content.length > 0],
  ];
}

async function main() {
  const root = await buildFixture();
  console.log(`workspace: ${root}\n`);

  let pass = 0;
  let fail = 0;
  const failures = [];

  const warm = await rust.warmUp();
  if (!warm.enabled) {
    console.error("runtime-smoke: the runtime is disabled (ZERAIX_RUST_RUNTIME). Nothing to check.");
    process.exit(1);
  }
  if (!rust.isReady()) {
    console.error(
      "runtime-smoke: the sidecar did not start. With the JS handlers gone this is a broken install, " +
        "not a slow path — see the runtime log above.",
    );
    process.exit(1);
  }

  // 1. Every required tool is declared. Checked against a list this file owns, so a sidecar that declares
  //    nothing fails loudly rather than trivially agreeing with itself.
  const served = new Set(rust.servedTools());
  const missing = REQUIRED.filter((t) => !served.has(t));
  if (missing.length) {
    console.error(`✗ the sidecar does not declare: ${missing.join(", ")}`);
    fail += missing.length;
  } else {
    console.log(`✓ all ${REQUIRED.length} required tools are declared`);
  }

  // 2. Each one actually runs.
  for (const [tool, args, check] of cases(root)) {
    const label = `${tool} ${JSON.stringify(args).slice(0, 60)}`;
    const r = await rust.tryRunTool(tool, args, { workdir: root });
    if (r === null) {
      fail++;
      failures.push(`${label} — the sidecar declined it, and nothing else implements it`);
      console.log(`  ✗ ${label} — declined`);
      continue;
    }
    let ok = false;
    try {
      ok = Boolean(check(r));
    } catch (e) {
      ok = false;
      r.content = `${r.content}\n[check threw: ${e?.message ?? e}]`;
    }
    if (ok) {
      pass++;
      console.log(`  ✓ ${label}`);
    } else {
      fail++;
      failures.push(`${label} → ok=${r.ok} content=${JSON.stringify(String(r.content).slice(0, 200))}`);
      console.log(`  ✗ ${label}`);
    }
  }

  // 3. The engine contract `run_command` depends on.
  console.log("");
  const cmd = process.platform === "win32" ? "echo smoke" : "echo smoke";
  const r = await native.run(cmd, { cwd: root, timeoutMs: 30_000 });
  const contractOk =
    typeof r.stdout === "string" && r.stdout.includes("smoke") && r.code === 0 && r.killed === false && r.canceled === false;
  if (contractOk) {
    pass++;
    console.log("  ✓ process.run honours the engine contract");
  } else {
    fail++;
    failures.push(`process.run → ${JSON.stringify(r).slice(0, 300)}`);
    console.log("  ✗ process.run does not honour the engine contract");
  }

  await rust.shutdown();
  await fsp.rm(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("runtime-smoke failed:", e);
  process.exit(1);
});
