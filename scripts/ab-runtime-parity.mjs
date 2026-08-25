/**
 * A/B parity harness for the Rust Agent Runtime (Stage 1).
 *
 * The Stage 1 proof obligation is that the Rust tools return **byte-identical** output to the JS
 * handlers they stand in for. That is a stricter bar than "works", and it is the right one: a model
 * reads these strings, the renderer's stale-read dedup parses `read_file`'s line-span notes, and the
 * app's whole tool pipeline keys on the exact truncation notices. A subtly different string is a
 * behaviour change wearing the clothes of a refactor.
 *
 * How it works: both implementations run **in this one process, against the same tree**. The JS side is
 * the real `runTool` from aiToolkit.mjs (loaded through the electron stub hook -- a reimplementation
 * would prove nothing); the Rust side is the real sidecar over its real protocol. The feature flag is
 * toggled per call so each side is exercised through the path it will actually take in production.
 *
 * Usage:
 *   node --import ./scripts/electron-stub-hook.mjs scripts/ab-runtime-parity.mjs [--dir <path>] [--bench]
 *
 * Exit code is non-zero if any case diverges, so this can gate the flag being turned on.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WANT_BENCH = args.includes("--bench");

// The bridge only spawns when the flag is on; the harness drives it deliberately, per call.
process.env.ZERAIX_RUST_RUNTIME = "off";

const { runTool, setWorkingDir } = await import("../electron/tools/aiToolkit.mjs");
const rust = await import("../electron/tools/rustRuntime.mjs");

/** Run one call through the JS handlers (flag forced off). */
async function viaJs(name, toolArgs) {
  process.env.ZERAIX_RUST_RUNTIME = "off";
  return runTool(name, toolArgs);
}

/** Run one call through the Rust sidecar (flag forced on), or null if it declined. */
async function viaRust(name, toolArgs, workdir) {
  process.env.ZERAIX_RUST_RUNTIME = "on";
  try {
    return await rust.tryRunTool(name, toolArgs, { workdir });
  } finally {
    process.env.ZERAIX_RUST_RUNTIME = "off";
  }
}

/**
 * Build a fixture tree.
 *
 * Deterministic on purpose: the interesting cases are the boundaries (an empty directory, a file with
 * no trailing newline, CRLF, non-ASCII, a directory over the entry cap, enough matches to trip the
 * match cap), and waiting to encounter those in a real project is how they go untested.
 */
async function buildFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zeraix-ab-"));
  const w = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  w("README.md", "# Title\n\nneedle here\nsecond line\n");
  w("no-trailing-newline.txt", "alpha\nbeta\ngamma");
  w("crlf.txt", "one\r\ntwo\r\nneedle\r\nfour\r\n");
  w("unicode.txt", "中文一行\nneedle 中文\n😀 emoji line\n");
  w("empty.txt", "");
  w("Uppercase.md", "NEEDLE in caps\n");
  w("src/index.ts", "export const x = 1;\n// needle\n");
  w("src/deep/nested/mod.rs", "fn main() { /* needle */ }\n");
  w("src/a.test.ts", "describe('needle', () => {});\n");
  fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });

  // Skipped-directory proof: these must be invisible to both walks.
  w("node_modules/pkg/index.js", "needle in node_modules\n");
  w(".git/config", "needle in git\n");

  // A long line, to exercise the per-line clip at 400 UTF-16 units.
  w("long-line.txt", `${"x".repeat(500)} needle ${"y".repeat(500)}\n`);

  // Enough files to exceed MAX_ENTRIES (300) in one directory, and enough matches to trip
  // MAX_MATCHES (200) across the tree.
  for (let i = 0; i < 320; i++) w(`many/file${String(i).padStart(3, "0")}.txt`, `needle ${i}\n`);

  // A multi-thousand-line file, for read_file offset/limit paths.
  w("big.txt", Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

  return root;
}

/** The comparison battery. Each entry is [tool, args, label]. */
function cases() {
  return [
    // read_file
    ["read_file", { path: "README.md" }, "whole small file"],
    ["read_file", { path: "no-trailing-newline.txt" }, "no trailing newline"],
    ["read_file", { path: "crlf.txt" }, "CRLF preserved"],
    ["read_file", { path: "unicode.txt" }, "non-ASCII"],
    ["read_file", { path: "empty.txt" }, "empty file"],
    ["read_file", { path: "big.txt" }, "default line cap"],
    ["read_file", { path: "big.txt", offset: 100, limit: 50 }, "offset+limit"],
    ["read_file", { path: "big.txt", offset: 4990 }, "offset near end"],
    ["read_file", { path: "big.txt", offset: 99999 }, "offset past end"],
    ["read_file", { path: "big.txt", offset: 0 }, "offset 0 coerces to 1"],
    ["read_file", { path: "big.txt", offset: "3", limit: "2" }, "numeric strings"],
    ["read_file", { path: "/workspace/README.md" }, "/workspace alias"],
    ["read_file", { path: "does-not-exist.txt" }, "missing file"],
    ["read_file", { path: "../outside.txt" }, "path escape"],
    ["read_file", {}, "missing required arg"],

    // list_directory
    ["list_directory", {}, "root listing"],
    ["list_directory", { path: "src" }, "subdirectory"],
    ["list_directory", { path: "empty-dir" }, "empty directory"],
    ["list_directory", { path: "many" }, "over the entry cap"],
    ["list_directory", { path: "nope" }, "missing directory"],

    // file_info
    ["file_info", { path: "README.md" }, "file"],
    ["file_info", { path: "src" }, "directory"],
    ["file_info", { path: "nope" }, "missing"],

    // search_files
    ["search_files", { pattern: "*.md" }, "simple glob"],
    ["search_files", { pattern: "*.ts" }, "glob across subdirs"],
    ["search_files", { pattern: "*.TS" }, "glob is case-insensitive"],
    ["search_files", { pattern: "file0??.txt" }, "question marks"],
    ["search_files", { pattern: "*.txt" }, "over the match cap"],
    ["search_files", { pattern: "*.nothing" }, "no matches"],
    ["search_files", { pattern: "a.test.ts" }, "dot is literal"],

    // search_in_files
    ["search_in_files", { query: "needle" }, "literal"],
    ["search_in_files", { query: "NEEDLE" }, "case-sensitive miss"],
    ["search_in_files", { query: "NEEDLE", ignore_case: true }, "ignore_case"],
    ["search_in_files", { query: "needle", pattern: "*.md" }, "with name pattern"],
    ["search_in_files", { query: "needle", context: 0 }, "zero context"],
    ["search_in_files", { query: "needle", context: 5 }, "max context"],
    ["search_in_files", { query: "needle", context: 99 }, "context clamped"],
    ["search_in_files", { query: "n[e]+dle", regex: true }, "regex"],
    ["search_in_files", { query: "^line 4[0-9]$", regex: true }, "anchored regex"],
    ["search_in_files", { query: "needle", pattern: "long-line.txt" }, "long line clip"],
    ["search_in_files", { query: "中文" }, "non-ASCII query"],
    ["search_in_files", { query: "zzz-absent-zzz" }, "no matches"],
    ["search_in_files", { query: "" }, "empty query"],
  ];
}

function diffPreview(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && out.length < 6; i++) {
    if (la[i] !== lb[i]) {
      out.push(`    line ${i + 1}:`);
      out.push(`      js  : ${JSON.stringify((la[i] ?? "<absent>").slice(0, 160))}`);
      out.push(`      rust: ${JSON.stringify((lb[i] ?? "<absent>").slice(0, 160))}`);
    }
  }
  return out.join("\n");
}

async function main() {
  const explicit = arg("--dir", null);
  const root = explicit ? path.resolve(explicit) : await buildFixture();
  if (!fs.existsSync(root)) throw new Error(`no such directory: ${root}`);
  await setWorkingDir(root);
  console.log(`workspace: ${root}\n`);

  let pass = 0;
  let fail = 0;
  let declined = 0;
  const failures = [];

  for (const [tool, toolArgs, label] of cases()) {
    const js = await viaJs(tool, toolArgs);
    const rs = await viaRust(tool, toolArgs, root);

    if (rs === null) {
      declined++;
      console.log(`  ~ ${tool.padEnd(17)} ${label} — runtime declined (JS handler serves it)`);
      continue;
    }
    const same = js.ok === rs.ok && js.content === rs.content;
    if (same) {
      pass++;
      console.log(`  ✓ ${tool.padEnd(17)} ${label}`);
    } else {
      fail++;
      failures.push({ tool, label, js, rs });
      console.log(`  ✗ ${tool.padEnd(17)} ${label}`);
      if (js.ok !== rs.ok) console.log(`    ok: js=${js.ok} rust=${rs.ok}`);
      const d = diffPreview(js.content, rs.content);
      if (d) console.log(d);
    }
  }

  console.log(`\n${pass} identical, ${fail} divergent, ${declined} declined`);

  if (WANT_BENCH) {
    console.log("\nlatency (median of 9, ms) — includes the full IPC round trip for the Rust column:");
    const bench = [
      ["search_in_files", { query: "needle" }],
      ["search_files", { pattern: "*.txt" }],
      ["list_directory", { path: "many" }],
      ["read_file", { path: "big.txt" }],
    ];
    const median = async (fn) => {
      const runs = [];
      for (let i = 0; i < 9; i++) {
        const t = process.hrtime.bigint();
        await fn();
        runs.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      return runs.sort((a, b) => a - b)[4];
    };
    for (const [tool, toolArgs] of bench) {
      const j = await median(() => viaJs(tool, toolArgs));
      const r = await median(() => viaRust(tool, toolArgs, root));
      const ratio = j / r;
      console.log(
        `  ${tool.padEnd(17)} js ${j.toFixed(1).padStart(7)}   rust ${r.toFixed(1).padStart(7)}   ${
          ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`
        }`,
      );
    }
  }

  await rust.shutdown();
  if (!explicit) await fsp.rm(root, { recursive: true, force: true });

  if (fail > 0) {
    console.error(`\nPARITY FAILED: ${fail} case(s) diverged. The flag must not be enabled.`);
    process.exit(1);
  }
  if (pass === 0) {
    console.error("\nNo cases were served by the runtime — is the binary built? (cd runtime && cargo build --release)");
    process.exit(1);
  }
  console.log("\nPARITY OK");
}

await main();
