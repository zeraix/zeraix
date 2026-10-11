/**
 * QEMU engine — orphaned VMs: finding and killing a qemu that an earlier session left running (it holds the fixed control
 * ports and, on Windows, the overlay file), plus tailFile, which quotes the VM's logs into a boot failure. Part of the
 * qemu engine; qemu.mjs is the public entry.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { recordRecovery } from "../../../store/recoveryLog.mjs";
import { isWin } from "./shared.mjs";
import { vmRoot } from "./image.mjs";

/**
 * Kill a qemu left behind by a previous run, before starting a new one.
 *
 * QMP_PORT / GA_PORT / the ssh forward are fixed, so exactly one VM can exist at a time. If the app dies without disposing —
 * crash, force quit, `pkill` — qemu is orphaned and keeps holding the port. Every later launch then dies instantly with
 * "Failed to find an available port: Address already in use", exit code 1, and every command then fails until someone finds
 * the stray process by hand. Observed in the wild; qemu.log had five unmatched "qemu started" lines.
 *
 * On Windows the orphan does something worse than hold a port: it holds an open handle to run.qcow2. Windows refuses to
 * delete a file another process has open (POSIX unlink succeeds regardless), so boot's `fs.rmSync(overlay)` fails with
 * EPERM and initialization dies before qemu is ever spawned — surfacing as "EPERM, permission denied … run.qcow2" with no
 * hint that a stray VM is the cause. That is why this must run BEFORE the overlay is touched, not just before the spawn.
 *
 * Scoped to OUR VM: matched on our app-data VM path in the process's own -drive argument, so an unrelated qemu on this machine
 * is never touched. Best-effort — a failure here just means the caller reports the conflict as it did before.
 *
 * Returns true when something was actually killed, so the caller knows to wait for the handle to be released.
 */
/**
 * PIDs of qemu processes running OUR VM, identified by the overlay path in their own command line.
 *
 * The matching happens where the command line already lives — in the shell on Windows, in JS on POSIX — rather than by
 * shipping command lines back to be searched here. That is not a style choice: PowerShell renders pipeline output
 * through its formatter, which WRAPS at the host buffer width (120 columns when stdout is redirected). A qemu command
 * line runs to several hundred characters, so the overlay path lands past the wrap point and arrives split across two
 * lines — and a substring test for it then fails against every line, silently finding no orphan to reap. Returning only
 * PIDs keeps every output line far too short to wrap.
 */
function findOrphanPids(match) {
  if (!isWin) {
    // -ax: other users' processes are not ours to kill, but they would still hold the port; listing them lets us say so.
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5000 });
    return out
      .split("\n")
      .filter((l) => l.includes("qemu-system-") && l.includes(match))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
  }
  // Windows has no `ps`; the original implementation called it anyway and swallowed the ENOENT, so reaping silently never
  // happened on the one platform where an orphan also blocks the overlay delete. CIM rather than the shorter `wmic`, which
  // is deprecated and absent from current Windows 11 images. -NonInteractive/-NoProfile so a user's PowerShell profile
  // cannot hang or pollute the output, matching the WHP probe in engine.mjs.
  //
  // The path travels in the environment, not interpolated into the script: it contains backslashes, and `-like` would
  // additionally read any [ ] * ? in it as wildcards. .Contains() on an env var needs no escaping at all.
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'qemu-system-%'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:ZERAIX_REAP_MATCH) } | " +
    "ForEach-Object { $_.ProcessId }";
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, ZERAIX_REAP_MATCH: match } },
  );
  return out.split("\n").map((l) => Number(l.trim()));
}

/** Last few lines of a log file, for quoting into a boot failure. Bounded on both counts — this text ends up in a status
 *  string that reaches the UI — and total: a missing or unreadable file is itself information worth reporting. */
export function tailFile(file, lines = 12, maxChars = 1200) {
  try {
    const text = fs.readFileSync(file, "utf8").trimEnd();
    if (!text) return "(empty)";
    return text.split("\n").slice(-lines).join("\n").slice(-maxChars);
  } catch {
    return "(not written)";
  }
}

export function reapOrphanVm(vd) {
  let killed = false;
  // Matched on the VM tree, not on this boot's exact overlay file. QMP_PORT / GA_PORT / the ssh forward are fixed, so an
  // orphan started from ANY version directory holds the same ports and blocks this boot just as effectively — and after
  // an update it is precisely the old version's overlay that is left running, which an exact-path match cannot see. Still
  // narrow enough that an unrelated qemu is never touched: nobody else's VM has our app-data path on its command line.
  const match = process.env.ZERAIX_VMDIR ? vd : vmRoot();
  try {
    for (const pid of findOrphanPids(match)) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      console.warn(`[sandbox] reaping orphaned VM (pid ${pid}) left by a previous session`);
      recordRecovery("sandbox", "orphan-vm-reaped", { pid });
      try {
        // taskkill /F rather than process.kill: Windows has no SIGTERM, so process.kill(pid, "SIGTERM") on a process we
        // did not spawn is unreliable, and a half-killed qemu still holds the overlay. /T takes the process tree with it.
        if (isWin) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
        else process.kill(pid, "SIGTERM");
        killed = true;
      } catch { /* already gone, or another user's process we may not touch */ }
    }
  } catch { /* process listing unavailable: fall through and let the caller report the conflict */ }
  return killed;
}
