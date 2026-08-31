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
import { spawn } from "node:child_process";
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
// Stage 2 compares at the engine contract, not at the tool: `run()` is what both callers of a host
// command go through (the run_command tool, and the runShell helper behind check_project), and it is the
// function that now delegates. Driving it directly with the flag toggled exercises the real delegation.
const native = await import("../electron/tools/sandbox/native.mjs");

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

/**
 * Commands for the process battery.
 *
 * Every one is spelled as `node -e "..."` rather than as a shell builtin, because this harness runs on
 * Windows in CI and `sleep`, `cat` and `/dev/null` are not there. Node is, by construction — it is
 * running this file — and double-quoted outside with single quotes inside parses identically under
 * `/bin/sh -c` and `cmd.exe /d /s /c`.
 *
 * Both sides run the same shell on the same machine, so shell-specific spelling (CRLF from cmd.exe, the
 * wording of a "not recognized" error) appears identically in both columns. What is being compared is
 * the two implementations, not the two shells.
 */
function processCases() {
  const node = JSON.stringify(process.execPath);
  return [
    [`${node} -e "console.log('hello')"`, {}, "stdout"],
    [`${node} -e "console.error('oops')"`, {}, "stderr"],
    [`${node} -e "console.log('out'); console.error('err')"`, {}, "both streams"],
    [`${node} -e "process.exit(3)"`, {}, "non-zero exit"],
    [`${node} -e ""`, {}, "no output, exit 0"],
    [`${node} -e "console.log('中文 ünïcodé')"`, {}, "non-ASCII output"],
    [`${node} -e "for (let i = 0; i < 200; i++) console.log('line ' + i)"`, {}, "multi-line"],
    // The cap is the interesting boundary: JS buffers the whole stream and slices afterwards, Rust
    // stops reading at the cap. Same bytes out, by very different means.
    [`${node} -e "process.stdout.write('x'.repeat(50000))"`, { maxBuffer: 1000 }, "output cap"],
    [`${node} -e "process.stdout.write('x'.repeat(50000))"`, { maxBuffer: 50000 }, "cap exactly at size"],
    // Killed by its deadline: `killed` true, and whatever it printed first is still returned.
    [`${node} -e "console.log('before'); setTimeout(() => {}, 10000)"`, { timeoutMs: 1500 }, "timeout kills"],
    ["definitely-not-a-command-xyz", {}, "command not found"],
    [`${node} -e "console.log(require('fs').existsSync('README.md'))"`, {}, "cwd is honoured"],
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

  // ── Stage 2: process execution ────────────────────────────────────────────────────────────────
  //
  // Compared field by field rather than as one string: the engine contract is an object, and a
  // divergence in `killed` or `canceled` changes how run_command words its answer even when the output
  // is identical. `truncated` is deliberately not compared — it is additive, and the JS path has no
  // equivalent to disagree with.
  console.log("");
  for (const [command, opts, label] of processCases()) {
    const runWith = async (flag) => {
      process.env.ZERAIX_RUST_RUNTIME = flag;
      try {
        return await native.run(command, { cwd: root, ...opts });
      } finally {
        process.env.ZERAIX_RUST_RUNTIME = "off";
      }
    };
    const js = await runWith("off");
    const rs = await runWith("on");

    const fields = ["stdout", "stderr", "code", "killed", "canceled"];
    const differing = fields.filter((f) => String(js[f]) !== String(rs[f]));
    if (differing.length === 0) {
      pass++;
      console.log(`  ✓ ${"process.run".padEnd(17)} ${label}`);
    } else {
      fail++;
      failures.push({ tool: "process.run", label, js, rs });
      console.log(`  ✗ ${"process.run".padEnd(17)} ${label}`);
      for (const f of differing) {
        console.log(`    ${f}: js=${JSON.stringify(String(js[f]).slice(0, 160))} rust=${JSON.stringify(String(rs[f]).slice(0, 160))}`);
      }
    }
  }

  // ── Stage 2b: background services ─────────────────────────────────────────────────────────────
  //
  // The startup report is what a model reads, so it is compared whole. Both paths share `awaitStartup`,
  // which means this is checking something narrower than the process cases above and worth being honest
  // about: not that two implementations of the wording agree, but that the runtime's process behaves
  // the same way underneath it — same output visible in the same window, same alive/exited verdict.
  //
  // The pid is normalised out. It is genuinely different between the two runs and always will be.
  const withoutPid = (s) => s.replace(/\(pid \d+\)/g, "(pid N)");
  for (const [command, label] of [
    [`${JSON.stringify(process.execPath)} -e "console.log('Local: http://localhost:5173/'); setInterval(()=>{},1000)"`, "dev server prints a URL"],
    [`${JSON.stringify(process.execPath)} -e "console.log('listening')"`, "one-off command exits immediately"],
    [`${JSON.stringify(process.execPath)} -e "process.exit(1)"`, "exits with no output"],
  ]) {
    const startWith = async (flag) => {
      process.env.ZERAIX_RUST_RUNTIME = flag;
      try {
        const text = await native.startBackground(command, { cwd: root });
        // Stop whatever is still running before the next leg, or the machine collects dev servers.
        for (const p of native.listProcesses()) native.stopProcess(p.pid);
        return withoutPid(text);
      } finally {
        process.env.ZERAIX_RUST_RUNTIME = "off";
      }
    };
    const js = await startWith("off");
    const rs = await startWith("on");
    if (js === rs) {
      pass++;
      console.log(`  ✓ ${"start_background".padEnd(17)} ${label}`);
    } else {
      fail++;
      failures.push({ tool: "start_background", label, js, rs });
      console.log(`  ✗ ${"start_background".padEnd(17)} ${label}`);
      const d = diffPreview(js, rs);
      if (d) console.log(d);
    }
  }

  // ── Stage 3b: MCP, the same server under both implementations ─────────────────────────────────
  //
  // The declarations an MCP server contributes sit ahead of `messages` in the cached prompt prefix, so
  // a byte of difference between the SDK path and the runtime path re-prefills every conversation from
  // token 0. That makes this the case where whole-output comparison earns its keep most.
  //
  // Both legs drive the REAL client.mjs against the REAL fixture server, with only the flag changed.
  {
    const mcp = await import("../electron/mcp/client.mjs");
    const cfgMod = await import("../electron/mcp/config.mjs");
    const serverId = "parityfixture";
    const fixture = path.resolve("runtime/crates/agent-mcp/tests/fixtures/mcp-server.mjs");

    const added = cfgMod.upsertServer(serverId, {
      command: process.execPath,
      args: [fixture],
      approved: true,
    });
    // Stage 3c: the same comparison for a REMOTE server. Started here because the port is chosen by
    // the OS, and both legs must talk to one server for the diff to mean anything.
    const httpFixture = path.resolve("runtime/crates/agent-mcp/tests/fixtures/mcp-http-server.mjs");
    const httpProc = spawn(process.execPath, [httpFixture], { stdio: ["ignore", "pipe", "ignore"] });
    // Unref'd so a crash or an early return in this harness can never leave the process holding the
    // event loop open. The explicit kill below is still the normal path; this is the backstop, and in
    // CI the difference is a job that ends versus one that runs to its timeout.
    httpProc.unref();
    const httpUrl = await new Promise((resolve) => {
      let buf = "";
      httpProc.stdout.on("data", (d) => {
        buf += d;
        const m = buf.match(/LISTENING (\S+)/);
        if (m) resolve(m[1]);
      });
      setTimeout(() => resolve(null), 10_000);
    });
    // try/finally around everything below: a refused config, a failed connect or a thrown assertion
    // must still stop the fixture server. Without this the harness exits cleanly on the happy path and
    // hangs on every other one.
    try {
    if (!added?.ok) {
      console.log(`  ~ ${"mcp".padEnd(17)} skipped (${added?.error ?? "config refused"})`);
    } else {
      const runWith = async (flag) => {
        process.env.ZERAIX_RUST_RUNTIME = flag;
        try {
          const e = await mcp.connectServer(serverId);
          const declared = mcp
            .listMcpTools()
            .filter((t) => t.name.includes(serverId))
            .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
          const echoed = await mcp.callMcpTool(`mcp__${serverId}__echo`, { text: "same either way" });
          const failed = await mcp.callMcpTool(`mcp__${serverId}__boom`, {});
          await mcp.disconnectServer(serverId);
          return JSON.stringify({ status: e.status, declared, echoed, failed }, null, 2);
        } finally {
          process.env.ZERAIX_RUST_RUNTIME = "off";
        }
      };

      const js = await runWith("off");
      const rs = await runWith("on");

      // The remote leg, driven exactly the same way.
      let httpJs = null;
      let httpRs = null;
      const httpId = "parityhttp";
      if (httpUrl && cfgMod.upsertServer(httpId, { url: httpUrl, approved: true })?.ok) {
        const runHttp = async (flag) => {
          process.env.ZERAIX_RUST_RUNTIME = flag;
          try {
            const e = await mcp.connectServer(httpId);
            const declared = mcp
              .listMcpTools()
              .filter((t) => t.name.includes(httpId))
              .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
            const echoed = await mcp.callMcpTool(`mcp__${httpId}__echo`, { text: "same either way" });
            await mcp.disconnectServer(httpId);
            return JSON.stringify({ status: e.status, declared, echoed }, null, 2);
          } finally {
            process.env.ZERAIX_RUST_RUNTIME = "off";
          }
        };
        httpJs = await runHttp("off");
        httpRs = await runHttp("on");
        cfgMod.removeServer(httpId);
      }

      const comparisons = [["declarations and call results", js === rs]];
      if (httpJs !== null) comparisons.push(["remote server, over HTTP", httpJs === httpRs]);
      else console.log(`  ~ ${"mcp".padEnd(17)} remote server skipped (fixture did not start)`);
      for (const [label, ok] of comparisons) {
        if (ok) {
          pass++;
          console.log(`  ✓ ${"mcp".padEnd(17)} ${label}`);
        } else {
          fail++;
          const [a, b] = label.startsWith("remote") ? [httpJs, httpRs] : [js, rs];
          failures.push({ tool: "mcp", label, js: a, rs: b });
          console.log(`  ✗ ${"mcp".padEnd(17)} ${label}`);
          const d = diffPreview(a, b);
          if (d) console.log(d);
        }
      }
      cfgMod.removeServer(serverId);
    }
    } finally {
      try {
        httpProc.kill();
      } catch {
        /* already gone */
      }
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
