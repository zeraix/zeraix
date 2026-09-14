/**
 * The startup recovery pass (docs/agent-runtime-crash-recovery.md C4 / C5 / C9): what the previous session left
 * behind, found and dealt with before any service or window starts writing.
 */
import { app, powerMonitor } from "electron";
import path from "node:path";
import { reapOrphans } from "../tools/sandbox/orphans.mjs";
import { setRecoveryLogDir, recordRecovery } from "../store/recoveryLog.mjs";
import { sweepAndRecord } from "../store/tempSweep.mjs";
import { acquireSessionLock } from "../store/sessionLock.mjs";
import { probeAfterResume } from "../tools/sandbox/qemu.mjs";
import { getStorePath } from "../store/conversationStore.mjs";

/** Once the consent screen has been answered, before anything else starts. */
export function runStartupRecovery() {
  // C9: did the previous session end cleanly? The lock is removed at the very end of before-quit, so any lock
  // found here whose process is gone means the last run died before its teardown finished. Recorded first so
  // the sweep and the sidecar's journal replay below can be read against it.
  setRecoveryLogDir(path.join(app.getPath("userData"), "logs"));
  {
    const session = acquireSessionLock({ dir: app.getPath("userData"), version: app.getVersion() });
    if (session.unclean) {
      console.warn(
        `[session] the previous session (pid ${session.previous?.pid}, v${session.previous?.version ?? "?"}) ended without a clean shutdown`,
      );
    }
  }
  // Abandoned `*.tmp` siblings from an atomic write that was interrupted (C4). Cheap, shallow, and only files
  // older than an hour — a younger one may belong to a write happening right now. Synchronous because it is a
  // handful of stat calls against directories this app owns, and it must finish before anything writes there.
  try {
    sweepAndRecord([
      getStorePath(),
      app.getPath("userData"),
      path.join(app.getPath("userData"), "logs"),
    ]);
  } catch (e) {
    console.warn("[temp] sweep failed:", e?.message ?? e);
  }
  // Waking from sleep is a partial crash for the sandbox (docs/agent-runtime-crash-recovery.md C5): qemu is still
  // running, so nothing about the process says anything is wrong, while the guest's clock has jumped and its agent
  // socket is commonly dead. Without this the first command after waking pays a full timeout to discover that, and
  // reports a timeout — which reads as a slow command rather than a sandbox that was asleep.
  powerMonitor.on("resume", () => {
    void probeAfterResume().catch(() => {});
  });
  // Kill command trees left running by a previous session that never got to clean up after itself --
  // End Task, a crash, an OS shutdown. Nothing else will: on Windows a child simply outlives its parent,
  // so a build the agent started can hold a core indefinitely with no app left to show it. Deliberately
  // not awaited (it shells out to check start times, and the window should not wait on that), and the
  // result is logged because an app that silently kills processes at boot is worse to debug than the
  // orphans were. See electron/tools/sandbox/orphans.mjs.
  void reapOrphans()
    .then((killed) => {
      if (killed.length) {
        console.log(`[orphans] killed ${killed.length} command tree(s) left by a previous run:`);
        for (const k of killed) console.log(`[orphans]   pid ${k.pid}: ${k.command}`);
        recordRecovery("orphans", "reaped", { count: killed.length, pids: killed.map((k) => k.pid) });
      }
    })
    .catch(() => {});
}
