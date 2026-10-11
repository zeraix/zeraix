/**
 * check_project: detect the project type and run its build / lint / test steps. Split out of aiToolkit.mjs, whose
 * handler table spreads `checkHandlers` in; detectCheckSteps is shared with project memory (init_command).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getEngine } from "../sandbox/engine.mjs";
import { ensureWorkdir, getWorkingDir } from "./workdir.mjs";
import { CMD_MAX_BUFFER, cancellationResult } from "./command.mjs";

// ── Project verification (build / test) ───────────────────────────────────────
const CHECK_TIMEOUT_MS = 180_000; // Per-step timeout for build / test (more lenient than a normal command)
const CHECK_OUT_CAP = 4000; // Per-step output feedback cap (characters)

/** Whether a file / directory exists under WORKDIR. */
async function existsInWorkdir(relPath) {
  try {
    await fs.access(path.join(getWorkingDir(), relPath));
    return true;
  } catch {
    return false;
  }
}

/** Run one command under WORKDIR, returning { ok, code, out, killed, canceled } (never throws). Goes through the current execution engine. */
async function runShell(cmd, signal) {
  const r = await getEngine().run(cmd, {
    cwd: getWorkingDir(),
    timeoutMs: CHECK_TIMEOUT_MS,
    maxBuffer: CMD_MAX_BUFFER,
    signal,
  });
  return {
    ok: r.code === 0 && !r.killed && !r.canceled,
    code: r.code,
    killed: !!r.killed,
    canceled: !!r.canceled,
    out: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim(),
  };
}

/**
 * Infer the "build / test" steps to run based on the project type, returning [{ label, cmd }].
 * Supports Node/TS, Rust, Go, Python; returns an empty array if none is detected.
 */
export async function detectCheckSteps() {
  const steps = [];

  if (await existsInWorkdir("package.json")) {
    let pkg = {};
    try {
      pkg = JSON.parse(await fs.readFile(path.join(getWorkingDir(), "package.json"), "utf8"));
    } catch {
      pkg = {};
    }
    const scripts = pkg.scripts || {};
    // Pick the package manager (by lock file).
    const pm = (await existsInWorkdir("pnpm-lock.yaml"))
      ? "pnpm"
      : (await existsInWorkdir("yarn.lock"))
        ? "yarn"
        : (await existsInWorkdir("bun.lockb"))
          ? "bun"
          : "npm";
    const runScript = (s) => (pm === "npm" ? `npm run ${s} --silent` : `${pm} run ${s}`);

    // Build / type-check: prefer the project's own script, otherwise run tsc --noEmit for TS projects.
    if (scripts.typecheck) steps.push({ label: "typecheck", cmd: runScript("typecheck") });
    else if (await existsInWorkdir("tsconfig.json"))
      steps.push({ label: "typecheck", cmd: "npx tsc --noEmit" });
    if (scripts.lint) steps.push({ label: "lint", cmd: runScript("lint") });
    // Test: only when a real test script exists (skip npm's default placeholder).
    if (scripts.test && !/no test specified/i.test(scripts.test))
      steps.push({ label: "test", cmd: runScript("test") });
  } else if (await existsInWorkdir("Cargo.toml")) {
    steps.push({ label: "compile", cmd: "cargo check" });
    steps.push({ label: "test", cmd: "cargo test" });
  } else if (await existsInWorkdir("go.mod")) {
    steps.push({ label: "compile", cmd: "go build ./..." });
    steps.push({ label: "test", cmd: "go test ./..." });
  } else if (
    (await existsInWorkdir("pyproject.toml")) ||
    (await existsInWorkdir("setup.py")) ||
    (await existsInWorkdir("requirements.txt"))
  ) {
    steps.push({ label: "compile", cmd: "python -m compileall -q ." });
    steps.push({ label: "test", cmd: "pytest -q" });
  }
  return steps;
}

// ── Tool implementations ──────────────────────────────────────────────────────
export const checkHandlers = {
  async check_project({ skip_tests } = {}, { signal } = {}) {
    await ensureWorkdir();
    let steps = await detectCheckSteps();
    if (skip_tests) steps = steps.filter((s) => s.label !== "test");
    if (steps.length === 0) {
      return "No verifiable project type detected (supports Node/TS, Rust, Go, Python).";
    }

    const blocks = [];
    let allOk = true;
    for (const s of steps) {
      const r = await runShell(s.cmd, signal);
      // Stopped part-way through a multi-step check: kill this step, run no further ones, and report what
      // did complete. Continuing would run a test suite the user has just asked to stop.
      if (r.canceled) {
        blocks.push(`## ${s.label}: \`${s.cmd}\`\n⏹ Stopped by the user${r.out ? `\n${r.out}` : ""}`);
        return `${blocks.join("\n\n")}\n\n${cancellationResult({})}`;
      }
      if (!r.ok) allOk = false;
      const status = r.ok
        ? "✅ Passed"
        : `❌ Failed (exit ${r.code}${r.killed ? ", timeout" : ""})`;
      const body = r.out
        ? `\n${r.out.length > CHECK_OUT_CAP ? `${r.out.slice(0, CHECK_OUT_CAP)}\n… (output truncated)` : r.out}`
        : "";
      blocks.push(`## ${s.label}: \`${s.cmd}\`\n${status}${body}`);
    }
    const header = allOk ? "All checks passed ✅" : "Some checks failed ❌";
    return `${header}\n\n${blocks.join("\n\n")}`;
  },
};
