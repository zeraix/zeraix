#!/usr/bin/env node
/**
 * Runtime benchmarks (TODO §13).
 *
 * Drives the real sidecar over its real protocol and reports numbers. Deliberately NOT a test: a timing
 * assertion fails when the machine is busy, and a suite that fails for reasons unrelated to the change teaches
 * people to re-run it until it passes. The properties that must always hold are asserted in Rust, under
 * `agent-loop/tests/stress.rs` and `agent-scheduler/tests/stress.rs`; this measures what those deliberately do
 * not.
 *
 * ## A caveat about where you run it
 *
 * Filesystem-heavy numbers (`tools`, `cpu`, `memory`) are dominated by the filesystem, not by the runtime. On
 * WSL with the repository on a Windows drive (`/mnt/...`, i.e. DrvFs) a search that takes 30ms on ext4 takes
 * hundreds of milliseconds, so those figures measure the mount rather than the code. Compare like with like,
 * and treat a cross-machine comparison of them as meaningless unless both ran on the same kind of filesystem.
 *
 * `startup`, `shutdown` and `command` do not have that problem and are comparable anywhere.
 *
 * Usage:
 *   node scripts/runtime-bench.mjs               # everything
 *   node scripts/runtime-bench.mjs startup tools # named benchmarks only
 *   node scripts/runtime-bench.mjs --json        # machine-readable, for tracking over time
 *
 * What is measured, and why each one is worth a number:
 *
 *   startup   — how long a cold sidecar takes to answer its first request. Paid on every app launch.
 *   memory    — resident set after a burst of work. The number that decides whether a sidecar is cheap enough
 *               to leave running.
 *   cpu       — CPU seconds for a fixed workload, which is what distinguishes "slow because it is waiting" from
 *               "slow because it is working".
 *   shutdown  — how long a clean stop takes. Paid on every quit, and a slow one reads to the user as a hang.
 *   command   — `process.run` round trip, against Node's own `child_process` as the baseline it replaces.
 *   tools     — one tool call, serial, and the same calls fanned out, so the concurrency is visible as a
 *               number rather than as a claim.
 */
import { exec, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** Where `build:runtime` stages the binary, and where cargo leaves it in a dev tree. */
function binaryPath() {
  const exe = process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime";
  const candidates = [
    path.join(ROOT, "resources", "runtime", exe),
    path.join(ROOT, "runtime", "target", "release", exe),
    path.join(ROOT, "runtime", "target", "debug", exe),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** A live sidecar, with just enough protocol to drive it. */
class Runtime {
  constructor(bin) {
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Notifications share the stream with replies and have no id.
        if (msg.id === undefined) continue;
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
      }
    });
  }

  call(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async stop() {
    await this.call("runtime.shutdown", {});
    await new Promise((resolve) => this.child.once("exit", resolve));
  }
}

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const now = () => process.hrtime.bigint();

/** Median and p95, which say more than a mean: the tail is the interesting part of "how long does X take". */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

/** Resident set of a pid, in MB. Best-effort and platform-specific; null when it cannot be read. */
async function residentMb(pid) {
  if (process.platform === "linux") {
    try {
      const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8");
      const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      return kb ? kb / 1024 : null;
    } catch {
      return null;
    }
  }
  // ps is available on macOS and most Unixes; rss is in KB.
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, stdout) => {
      const kb = Number(String(stdout).trim());
      resolve(err || !kb ? null : kb / 1024);
    });
  });
}

/** CPU seconds a pid has used. Linux only; null elsewhere, which is honest rather than a guess. */
async function cpuSeconds(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
    // Fields after the (possibly parenthesised, possibly space-containing) comm field.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    const utime = Number(after[11]);
    const stime = Number(after[12]);
    const hz = 100; // USER_HZ; effectively always 100 on Linux.
    return (utime + stime) / hz;
  } catch {
    return null;
  }
}

const WORKDIR = ROOT;

const benchmarks = {
  /** Cold start to first answered request. Paid on every app launch. */
  async startup(bin) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const started = now();
      const rt = new Runtime(bin);
      await rt.call("runtime.initialize", { protocol_version: "1.0", client: "bench" });
      samples.push(ms(started));
      await rt.stop();
    }
    return { unit: "ms", ...stats(samples) };
  },

  /** Resident set after a burst of real work. */
  async memory(bin) {
    const rt = new Runtime(bin);
    await rt.call("runtime.initialize", { protocol_version: "1.0", client: "bench" });
    const baseline = await residentMb(rt.child.pid);

    await Promise.all(
      Array.from({ length: 64 }, () =>
        rt.call("tool.call", {
          name: "search_in_files",
          args: { query: "fn ", path: "crates", max_results: 200 },
          workdir: path.join(ROOT, "runtime"),
          call_id: `m${Math.random()}`,
        }),
      ),
    );
    const after = await residentMb(rt.child.pid);
    await rt.stop();
    return { unit: "MB", baseline, after, growth: baseline != null && after != null ? after - baseline : null };
  },

  /** CPU seconds for a fixed workload. */
  async cpu(bin) {
    const rt = new Runtime(bin);
    await rt.call("runtime.initialize", { protocol_version: "1.0", client: "bench" });
    const before = await cpuSeconds(rt.child.pid);
    const started = now();
    await Promise.all(
      Array.from({ length: 32 }, () =>
        rt.call("tool.call", {
          name: "search_in_files",
          args: { query: "pub fn", path: "crates", max_results: 500 },
          workdir: path.join(ROOT, "runtime"),
          call_id: `c${Math.random()}`,
        }),
      ),
    );
    const wall = ms(started);
    const after = await cpuSeconds(rt.child.pid);
    await rt.stop();
    if (before == null || after == null) return { unit: "s", cpu: null, note: "not measurable on this platform" };
    return { unit: "s", cpu: after - before, wallMs: wall, calls: 32 };
  },

  /** A clean stop. Paid on every quit, and a slow one reads to the user as a hang. */
  async shutdown(bin) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const rt = new Runtime(bin);
      await rt.call("runtime.initialize", { protocol_version: "1.0", client: "bench" });
      const started = now();
      await rt.stop();
      samples.push(ms(started));
    }
    return { unit: "ms", ...stats(samples) };
  },

  /** `process.run` against Node's own `child_process`, which is what it replaces. */
  async command(bin) {
    const rt = new Runtime(bin);
    await rt.call("runtime.initialize", { protocol_version: "1.0", client: "bench" });
    const cmd = process.platform === "win32" ? "echo bench" : "echo bench";

    const runtime = [];
    for (let i = 0; i < 20; i++) {
      const started = now();
      await rt.call("process.run", { command: cmd, cwd: WORKDIR, timeout_ms: 30_000, call_id: `p${i}` });
      runtime.push(ms(started));
    }
    await rt.stop();

    const node = [];
    for (let i = 0; i < 20; i++) {
      const started = now();
      await new Promise((resolve) => {
        exec(cmd, { cwd: WORKDIR }, () => resolve());
      });
      node.push(ms(started));
    }
    return { unit: "ms", runtime: stats(runtime), node: stats(node) };
  },

  /** One tool call serially, then the same calls fanned out. The difference IS the concurrency. */
  async tools(bin) {
    const rt = new Runtime(bin);
    await rt.call("runtime.initialize", { protocol_version: "1.0", client: "bench" });
    const one = (i) =>
      rt.call("tool.call", {
        name: "search_in_files",
        args: { query: "impl ", path: "crates", max_results: 100 },
        workdir: path.join(ROOT, "runtime"),
        call_id: `t${i}-${Math.random()}`,
      });

    const serial = [];
    for (let i = 0; i < 16; i++) {
      const started = now();
      await one(i);
      serial.push(ms(started));
    }

    const started = now();
    await Promise.all(Array.from({ length: 16 }, (_, i) => one(100 + i)));
    const concurrentTotal = ms(started);
    await rt.stop();

    const serialTotal = serial.reduce((a, b) => a + b, 0);
    return {
      unit: "ms",
      serialPerCall: stats(serial),
      serialTotal,
      concurrentTotal,
      speedup: Number((serialTotal / concurrentTotal).toFixed(2)),
    };
  },
};

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const names = args.filter((a) => !a.startsWith("--"));
  const selected = names.length ? names : Object.keys(benchmarks);

  const bin = binaryPath();
  if (!bin) {
    console.error(
      "runtime-bench: no sidecar binary found. Build one first:\n" +
        "  cd runtime && cargo build --release\n" +
        "or `npm run build:runtime` to stage it under resources/runtime.",
    );
    process.exit(1);
  }
  if (!asJson) console.error(`runtime-bench: using ${bin}\n`);

  const results = {};
  for (const name of selected) {
    const bench = benchmarks[name];
    if (!bench) {
      console.error(`runtime-bench: no benchmark named '${name}' (have: ${Object.keys(benchmarks).join(", ")})`);
      process.exit(1);
    }
    try {
      results[name] = await bench(bin);
    } catch (e) {
      results[name] = { error: e?.message ?? String(e) };
    }
    if (!asJson) console.error(`  ${name}: ${JSON.stringify(results[name])}`);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { at: new Date().toISOString(), platform: `${os.platform()}-${os.arch()}`, binary: bin, results },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error("runtime-bench failed:", e);
  process.exit(1);
});
