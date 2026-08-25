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
/** Must match binaryPath() in electron/tools/rustRuntime.mjs: resourcesPath/runtime/<exe>. */
const stagedDir = path.join(root, "resources", "runtime");
const staged = path.join(stagedDir, exe);
const built = path.join(root, "runtime", "target", "release", exe);

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

if (!has("--skip-build")) {
  console.log("[rust-runtime] cargo build --release");
  execFileSync("cargo", ["build", "--release", "--locked"], {
    cwd: path.join(root, "runtime"),
    stdio: "inherit",
  });
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
