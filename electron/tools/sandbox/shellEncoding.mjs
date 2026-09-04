/**
 * Run a host command in a UTF-8 environment, whatever the platform's shell defaults to.
 *
 * Windows: cmd.exe writes and reads redirected text in the console code page — cp936 on a Chinese system — so
 * `echo 序号,测试项 > out.csv` produced GBK bytes, `read_file` (UTF-8) showed mojibake, and the model concluded the
 * host could not write Chinese (2026-09-04). `chcp 65001` switches that child's own hidden console to UTF-8 before
 * the command runs; `>nul` drops chcp's one-line banner, and `&` keeps the command's exit code as the last one.
 *
 * macOS / Linux: `/bin/sh` does not transcode, but a GUI app launched from Finder inherits no locale at all, and
 * a tool that consults it (Python before 3.7, sort, grep on some builds) falls back to ASCII. A UTF-8 LANG is set
 * only when neither LANG nor LC_ALL is present, so a user's own locale is never overridden.
 *
 * Applied to the command string at the runner's entry (native.mjs run / startBackground), so the Rust and the Node
 * runner receive the same command and the parity harness keeps comparing like with like. The model's own command
 * is what the transcript, the log and the loop detector see; this wrapper is invisible to them.
 */
export function utf8Shell(cmd, platform = process.platform) {
  const c = String(cmd ?? "");
  if (!c.trim()) return c;
  if (platform === "win32") return `chcp 65001>nul & ${c}`;
  const lang = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  return `if [ -z "$LANG$LC_ALL" ]; then export LANG=${lang}; fi; ${c}`;
}
