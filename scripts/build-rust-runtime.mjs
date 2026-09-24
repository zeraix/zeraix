/**
 * Build the Rust Agent Runtime sidecar and stage it where electron-builder can find it.
 *
 * Mirrors how the QEMU binaries reach the package: a script lays them out under `resources/`, and
 * `extraResources` embeds that directory. Staging rather than pointing `extraResources` straight at
 * `runtime/target/**` matters for one reason — the cargo output path contains the target triple only
 * when `--target` is passed and does NOT when it is a plain host build, so a glob into `target/` is
 * wrong half the time. One known destination removes that whole class of mistake.
 *
 * ## Why there is no cross-compilation here
 *
 * There is nothing to cross-compile. The mac target is arm64-only (see electron-builder.yml) and CI runs
 * it on `macos-14`, which is arm64; the Windows target is x64-only and runs on `windows-latest`, which is
 * x64. Every runner therefore builds for its own host, which is the cheapest and least breakable
 * arrangement available. If an x64 mac build ever comes back, this script gains a `--target` flag rather
 * than a cross-compilation toolchain.
 *
 * ## Exit codes
 *
 * Distinct, so `ensure-runtime.mjs` can give advice that matches the failure instead of one message for all
 * of them. It used to answer every failure with "install a Rust toolchain" — including a compile error on a
 * machine with a working toolchain, and a binary the running app had open.
 *
 *   0    built and staged
 *   75   the binary is in use by a running process (Windows) — nothing was built
 *   127  cargo is not installed
 *   1    anything else, most often a compile error (cargo's own output says which)
 *
 * Usage:
 *   node scripts/build-rust-runtime.mjs            # build + stage
 *   node scripts/build-rust-runtime.mjs --check     # verify a staged binary exists and runs
 *   node scripts/build-rust-runtime.mjs --skip-build  # stage an already-built binary
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime";
/** Must match runtimeBinaryPath() in electron/tools/runtimeBinary.mjs: resourcesPath/runtime/<exe>. */
const stagedDir = path.join(root, "resources", "runtime");
const staged = path.join(stagedDir, exe);
const built = path.join(root, "runtime", "target", "release", exe);

// Not exported: this module builds on import, so anything that imported a constant from it would start a
// cargo build. ensure-runtime.mjs spawns the script and reads the exit status instead.
const EXIT_IN_USE = 75;
const EXIT_NO_CARGO = 127;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/** Fail loudly rather than shipping an installer whose sidecar is absent or broken. */
function verify(binary) {
  if (!fs.existsSync(binary)) throw new Error(`no binary at ${binary}`);
  const { size } = fs.statSync(binary);
  if (size < 100_000) throw new Error(`binary at ${binary} is only ${size} bytes — truncated?`);
  // --version is answered without starting the runtime, so this is a cheap end-to-end check that the
  // file is executable and links on this machine.
  const out = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+/.test(out)) throw new Error(`unexpected --version output: ${JSON.stringify(out)}`);
  return { size, version: out };
}

if (has("--check")) {
  const { size, version } = verify(staged);
  console.log(`[rust-runtime] staged ok — ${staged} (${(size / 1e6).toFixed(1)} MB, v${version})`);
  process.exit(0);
}

/**
 * Running processes started from one of `paths`: `[{ pid, path }]`. Windows only; empty elsewhere.
 *
 * Why this exists: on Windows a running executable cannot be deleted, so cargo fails to replace
 * `target/release/zeraix-agent-runtime.exe` while the dev app's sidecar is running — two minutes into the
 * build, as `failed to remove file … (os error 5)`, which reads like a build failure. On POSIX the old inode
 * lives on under the running process and the replace succeeds, so there is nothing to check.
 *
 * Asked of the process table, not the file. Opening the image for writing SUCCEEDS on Windows while it is
 * running — the mapped section blocks deletion, not opening — so every file-based probe says "free". Measured
 * against a live sidecar on 2026-09-23 rather than assumed. A process started from the path is exactly the
 * condition cargo trips on.
 *
 * Any failure to ask answers "none": this is advice, and a check that cannot run must not stop a build.
 */
function holdersOf(paths) {
  if (process.platform !== "win32") return [];
  let out = "";
  try {
    out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name zeraix-agent-runtime -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}' -f $_.Id, $_.Path }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
  } catch {
    return [];
  }
  // Windows paths are case-insensitive, and Get-Process does not promise the case path.join produced.
  const wanted = new Set(paths.map((p) => path.resolve(p).toLowerCase()));
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("|");
      return { pid: line.slice(0, i), path: line.slice(i + 1) };
    })
    .filter((h) => h.path && wanted.has(path.resolve(h.path).toLowerCase()));
}

// Before building, not after: the build is minutes, and it would fail at the very last step.
const holders = holdersOf([built, staged]);
if (holders.length) {
  console.error("[rust-runtime] cannot rebuild — the runtime binary is in use:");
  for (const h of holders) console.error(`[rust-runtime]   pid ${h.pid}  ${h.path}`);
  console.error("[rust-runtime] Quit the running app (or stop that process) and run this again.");
  process.exit(EXIT_IN_USE);
}

if (!has("--skip-build")) {
  console.log("[rust-runtime] cargo build --release");
  try {
    execFileSync("cargo", ["build", "--release", "--locked"], {
      cwd: path.join(root, "runtime"),
      stdio: "inherit",
    });
  } catch (e) {
    if (e?.code === "ENOENT") {
      console.error("[rust-runtime] cargo is not installed — see https://rustup.rs");
      process.exit(EXIT_NO_CARGO);
    }
    // cargo already printed why. Exiting non-zero without a Node stack trace on top of it: the trace
    // names this script's line, which is the one thing about the failure that is not interesting.
    process.exit(1);
  }
}

const { size, version } = verify(built);
fs.mkdirSync(stagedDir, { recursive: true });
fs.copyFileSync(built, staged);
// Copy preserves mode on POSIX, but be explicit: an extraResource that is not executable produces a
// spawn EACCES at runtime, which the bridge swallows as "unavailable" and is then invisible.
if (process.platform !== "win32") fs.chmodSync(staged, 0o755);

console.log(
  `[rust-runtime] staged ${path.relative(root, staged)} — ${(size / 1e6).toFixed(1)} MB, v${version}, ${process.platform}/${process.arch}`,
);
