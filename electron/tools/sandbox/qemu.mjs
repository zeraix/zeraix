/**
 * QEMU execution engine: runs run_command inside a "single long-lived" QEMU VM (macOS=HVF / Windows=WHPX /
 * Linux=KVM). Commands run inside the guest via qemu-guest-agent, confined to the mount set by bubblewrap.
 * Same contract as native: run never throws.
 *
 * Long-lived services (dev servers, etc.) run inside the guest, and QMP hostfwd "dynamically forwards" their
 * ports to the host, so they can be previewed on the host.
 *
 * Mechanism files live in sandbox/qemu/: control.mjs (QMP + guest-agent client), Dockerfile +
 * build-rootfs-local.sh (toolbox image -> bootable qcow2). This module spawns the qemu process directly (no
 * shell), then connects with control.mjs's client.
 *
 * Mount model (no hot-mount / never rebuild): a one-time 9p share of the "host root" (posix "/", Windows drive
 * letters) into the guest's /mnt/hostfs; any cwd is already covered. The visible scope of untrusted commands is
 * confined per-command by bwrap to ONE directory: the command's own cwd, bound at the fixed guest path
 * /workspace (GUEST_WORKSPACE) and used as the guest cwd. The host path is therefore absent from the guest —
 * a command cannot name it and no `pwd` / error message can leak it.
 *
 * A sandbox failure is reported as a failed command, never re-run on the host (see sandboxFailure in qemu/shared.mjs).
 * Routing to native at all — dev mode, engine=native, before the VM is ready — is engine.mjs's decision, not this
 * module's.
 * Requires real-machine boot verification (see sandbox/qemu/README).
 *
 * This file is the public entry and owns the VM's lifecycle: boot, provision, run, the restart after a death, the resume
 * probe and dispose. The rest is split by concern into qemu/, and re-exported below where it is part of the API:
 *   qemu/shared.mjs   - state the parts share (cfg, vm, homeRoot) and the answers for a command the sandbox could not run
 *   qemu/args.mjs     - qemu argv, the guest's mount points, bubblewrap flags and binds (incl. setAssetHostDir)
 *   qemu/image.mjs    - VM image versions and directories, and the first-run download
 *   qemu/services.mjs - background services, their port forwards, and the job watchers
 *   qemu/orphans.mjs  - reaping a VM orphaned by an earlier session
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { qmp, guestAgent } from "./control.mjs";
import { startNinepServer } from "./ninep-server.mjs";
import { recordRecovery } from "../../store/recoveryLog.mjs";
import { isWin, cfg, vm, setCfg, setVm, setHomeRoot, sandboxFailure, sandboxDiedMidCommand } from "./qemu/shared.mjs";
import { QMP_PORT, GA_PORT, GUEST_MNT, GUEST_TMP, qemuBin, qemuArgs, bwrapFlags } from "./qemu/args.mjs";
import { VM_FILES, vmRoot, bootVersion, dirs, qemuImgBin, ensureRootfs } from "./qemu/image.mjs";
import { stopAll, watchers, stopWatching } from "./qemu/services.mjs";
import { reapOrphanVm, tailFile } from "./qemu/orphans.mjs";

// engine.mjs keeps this module object as the engine itself, so its export set IS the interface: the names below live in
// the parts and are re-exported to keep that set exactly what it was when the engine was one file.
export { setAssetHostDir } from "./qemu/args.mjs";
export { vmImageDir, sandboxVmInfo } from "./qemu/image.mjs";
export { startBackground, stopProcess, listProcesses, stopAll, exposePort, unexposePort } from "./qemu/services.mjs";

export const id = "qemu";

let onExitCb = null; // Injected by engine.mjs: callback when the VM process exits (used to downgrade the "ready" state so the UI doesn't keep showing running)
export function configure(c) {
  setCfg(c);
  if (c && typeof c.onExit === "function") onExitCb = c.onExit;
}

/** How long the guest still gets to come up after qemu has called the disk image corrupt, before that report is treated
 *  as the diagnosis (see boot). Well inside waitAgent's own 180s, but long enough that an image qemu grumbles about yet
 *  boots from is never condemned — the cost of a false positive is deleting and re-downloading a multi-GB image. */
const CORRUPT_GRACE_MS = 90000;

const SWAPFILE = "/var/swapfile";
const SWAP_MIB = 2048;

/**
 * Give the guest swap. The image ships with none.
 *
 * Without it a transient spike is not a slowdown, it is a kill: the guest kernel logged twelve
 * `Out of memory: Killed process (python3)` in one boot, every one at roughly the RAM ceiling, with `Total swap = 0kB`. OCR
 * loading a model and rasterising a page peaks well above its steady state, and there was nothing to page it out to.
 *
 * A file rather than a partition, created here rather than in the image, so it needs no rootfs rebuild — same reasoning as
 * GUEST_TMP. It lands in run.qcow2, the throwaway overlay, so it costs host disk only while the VM is alive and is discarded
 * with it. fallocate is a metadata operation, so this adds no measurable boot time; dd is the fallback for a filesystem where
 * fallocate cannot produce a swap-eligible extent.
 *
 * Confirmed working and on the fast path: the guest logged `Adding 2097148k swap on /var/swapfile` at 1.8 s uptime, and the
 * overlay stayed at 8.5 MB afterwards — dd would have pushed 2 GiB into it. Subsequent runs of the same OCR workload stopped
 * being killed, at the SAME 2048 MiB of RAM that was being killed before, which is what identifies swap rather than RAM as
 * the fix.
 *
 * Best-effort: a guest that will not take swap should still boot and run commands, it just keeps the old OOM behaviour.
 */
async function enableSwap(guest) {
  // Braces are required, not style: `&&` and `||` have equal precedence and associate left-to-right, so an ungrouped
  // `a && b || c && d` runs `c`'s tail after `a && b` SUCCEEDS — here that meant re-running mkswap on an already-active
  // swapfile. Each alternative has to be one grouped command.
  const make = (alloc) => `{ ${[
    `${alloc}`,
    `chmod 600 ${SWAPFILE}`,
    `mkswap ${SWAPFILE} >/dev/null 2>&1`,
    `swapon ${SWAPFILE} 2>/dev/null`,
  ].join(" && ")}; }`;
  const script = [
    // fallocate first: it only writes metadata, so the common path costs milliseconds rather than the seconds it takes to
    // push 2 GiB through virtio-blk into a growing qcow2. swapon can still refuse the result — on some filesystems a
    // fallocate'd file's extents are unwritten and swap needs them mapped — so fall back to dd on the whole sequence, not
    // just on fallocate failing. That is the slow path, and the timing below says when it was taken.
    `${make(`fallocate -l ${SWAP_MIB}M ${SWAPFILE} 2>/dev/null`)} || ${make(`dd if=/dev/zero of=${SWAPFILE} bs=1M count=${SWAP_MIB} status=none`)} || true`,
    // MiB of swap the kernel reports as active; 0 means it did not take. Read from /proc, which is always there —
    // `free` comes from procps and a minimal image is not guaranteed to ship it.
    `awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo`,
  ].join("; ");
  const t0 = Date.now();
  try {
    const { out } = await guest.exec("/bin/bash", ["-lc", script]);
    const mib = parseInt(String(out).trim().split("\n").pop(), 10) || 0;
    const ms = Date.now() - t0;
    if (mib > 0) console.log(`[sandbox/qemu] swap enabled: ${mib} MiB in ${ms} ms`);
    else console.warn(`[sandbox/qemu] swap did NOT activate (${ms} ms) — the guest keeps its previous out-of-memory behaviour`);
  } catch (e) {
    console.warn(`[sandbox/qemu] swap setup failed after ${Date.now() - t0} ms: ${e?.message ?? e}`);
  }
}

let ninep = null; // Windows: in-process 9p-over-TCP server backing the host share

/** How long the guest gets to answer a liveness probe after the host wakes. See probeAfterResume. */
const RESUME_PROBE_MS = 5000;

/**
 * Foreground commands currently talking to the guest agent.
 *
 * The agent channel matches replies to requests POSITIONALLY (see jsonSock in control.mjs), which is only sound while
 * one caller is in flight — the file says so itself: "positional matching against a shared channel is only sound if
 * nothing else can be in flight, and nothing else enforced that". Anything that sends concurrently with a running
 * command can hand that command someone else's reply. The resume probe is such a sender, so it counts here and stands
 * down rather than risking it.
 */
let commandsInFlight = 0;

// ── Boot ─────────────────────────────────────────────────────────────────────
// Windows host share: qemu has no virtio-9p, so serve the host tree from an in-process 9p2000.L
// server (virtual multi-drive root; see ninep-server.mjs) mounted in-guest over trans=tcp via the
// SLIRP gateway 10.0.2.2 (→ host loopback). firstboot brings the NIC up first and is ordered
// Before qemu-guest-agent, so no NIC bring-up is needed here. A random attach token gates the
// loopback-bound server to this VM's mount.
// Transport benchmarks (2026-07, this host): SLIRP TCP reads ~93 MB/s / writes ~30 MB/s; the
// virtio-serial alternative (socat-bridged /dev/vport — trans=fd can't drive vport directly, the
// chardev lacks write_iter) inverts that: reads ~46 / writes ~114. Dev workloads are
// read-dominated and big writes land on guest tmpfs, so TCP wins; cache=readahead measured as a
// no-op. If a faster transport lands, ninep-server's connect mode is the ready-made hook.
async function winShareMount(guest) {
  const token = crypto.randomBytes(16).toString("hex");
  ninep = await startNinepServer({ drives: true, host: "127.0.0.1", port: 0, token });
  await guest.exec("/bin/sh", ["-c",
    `mkdir -p ${GUEST_MNT} && mount -t 9p -o trans=tcp,port=${ninep.port},version=9p2000.L,msize=524288,aname=${token} 10.0.2.2 ${GUEST_MNT}`]);
}

async function boot(onProgress, forceConfigured = false) {
  await ensureRootfs(onProgress, forceConfigured); // first run downloads the image; forceConfigured=update (downloads the target version)
  const { vd, rootfs } = dirs(forceConfigured);
  if (!fs.existsSync(rootfs)) throw new Error(`rootfs not found: ${rootfs}`);
  if (!fs.existsSync(path.join(vd, "Image")) || !fs.existsSync(path.join(vd, "initrd.img")))
    throw new Error(`kernel not found: need Image + initrd.img next to ${rootfs}`);
  // Image ready -> enter the boot phase. Reported at 100, not null: the "ready" message above it is broadcast
  // milliseconds into a warm start, before the window has subscribed, and this message overwrites it. A dialog that
  // attaches afterwards decides "image done" from the last status it can see, and with null here it saw nothing to
  // decide from — so every warm boot read as "checking runtime environment" until the VM was up (2026-09-04). The
  // boot itself still has no fine-grained progress; the dialog's boot step shows its own indeterminate state.
  onProgress?.(100, "Starting the runtime environment...");
  fs.mkdirSync(vd, { recursive: true });
  // Throwaway overlay: the base image stays clean, writes are discarded on shutdown.
  const overlay = path.join(vd, "run.qcow2");
  const imgBin = qemuImgBin();
  // FIRST, before the overlay is deleted or recreated. An orphaned qemu from a crashed session holds an open handle to
  // run.qcow2, and on Windows that makes the delete below fail outright — so reaping afterwards (where this used to sit)
  // could never help: boot threw EPERM and returned before reaching it.
  const reaped = reapOrphanVm(vd);
  // Windows releases a handle asynchronously after the process dies, so the delete can still lose a race with a kill we
  // just issued. maxRetries/retryDelay is Node's own backoff for exactly this class (EBUSY/EPERM/ENOTEMPTY); only paid
  // when something was actually holding the file.
  try {
    fs.rmSync(overlay, { force: true, maxRetries: reaped ? 20 : 5, retryDelay: 100 });
  } catch (e) {
    // Rethrown with the cause named. The raw error is "EPERM: operation not permitted, unlink '\\?\C:\…\run.qcow2'",
    // which reaches the user verbatim as the sandbox's failure reason (engine.mjs sets status.reason to e.message) and
    // says nothing about what is wrong or what to do. On Windows this is essentially always an open handle, not a
    // permissions problem — the app owns the folder it created — and the holder is a VM the reaper above could not stop.
    if (isWin && (e?.code === "EPERM" || e?.code === "EACCES" || e?.code === "EBUSY")) {
      throw new Error(
        `the runtime disk (${overlay}) is locked by another process — usually a sandbox VM left running by a previous ` +
          "session, or an antivirus scanning the file. Sign out and back in (or end any qemu-system-* task in Task " +
          `Manager) and start the sandbox again. Original error: ${e.message}`,
      );
    }
    throw e;
  }
  await new Promise((res, rej) => {
    const p = spawn(imgBin, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", rootfs, overlay]);
    p.on("exit", (c) => (c ? rej(new Error(`qemu-img exit ${c}`)) : res()));
    p.on("error", rej);
  });
  // Capture qemu's own stdout/stderr to vd/qemu.log (was stdio:"ignore", leaving no way to diagnose a process crash).
  // This is the "host-side" qemu output (HVF errors, assertions, sleep/wake failures, etc.); the guest kernel/systemd output is in console.log instead.
  let lastStderr = "";
  // Set when qemu reports the backing image is structurally broken. It says this within about a second of starting and
  // then carries on running a VM whose disk cannot be read, so without watching for it the only symptom is the guest
  // agent never answering — a 180s wait ending in "guest agent did not come up", which points at the guest and is wrong.
  let corruptReport = null;
  let onCorrupt = () => {};
  let corruptTimer = null;
  const qlog = fs.createWriteStream(path.join(vd, "qemu.log"), { flags: "a" });
  try { qlog.write(`\n===== qemu started ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
  const proc = spawn(qemuBin(), qemuArgs(vd, overlay), { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (b) => { try { qlog.write(b); } catch { /* ignore */ } });
  // Remember the last stderr line: qemu reports a fatal startup problem there and then exits, so by the time the exit handler
  // runs the reason is otherwise only in qemu.log. "Address already in use" in particular has a specific, actionable cause.
  proc.stderr.on("data", (b) => {
    const t = String(b).trim();
    if (t) lastStderr = t.split("\n").pop();
    if (!corruptReport && /Image is corrupt/i.test(t)) {
      corruptReport = t.split("\n").find((l) => /Image is corrupt/i.test(l))?.trim() ?? t;
      onCorrupt();
    }
    try { qlog.write(b); } catch { /* ignore */ }
  });
  const exitCb = onExitCb; // bind the callback at the time this proc starts (after a restart, old and new procs each correspond to their own; see the engine.disposing guard)
  proc.on("exit", (code, signal) => {
    try { qlog.write(`\n===== qemu exited code=${code} signal=${signal ?? "-"} @ ${new Date().toISOString()} =====\n`); qlog.end(); } catch { /* ignore */ }
    setVm(null); try { ninep?.close(); } catch {} ninep = null;
    try { exitCb?.(code, signal, lastStderr); } catch { /* ignore */ }
  });
  // Everything from here on runs with a live qemu process, so every exit from this block has to account for it.
  //
  // It previously did not: a boot that spawned qemu and then failed — the guest agent never answering, a corrupt image,
  // a QMP handshake nobody served — threw straight out of boot(), and nothing upstream owned the process. initEngine's
  // catch only writes a status string, and `sandbox` stays null there, so dispose() is never called on it either. The
  // qemu just kept running. That is what turns one bad boot into an escalating series: the leaked VM holds QMP_PORT /
  // GA_PORT, so the NEXT start cannot bind them, and its symptom ("another client holds the monitor") describes the
  // wreckage of the previous failure rather than anything wrong with this one.
  let ports;
  let guest;
  try {
    try {
      ports = await qmp({ port: QMP_PORT });
    } catch (e) {
      // Reaching here means a qemu we could not stop still owns the monitor: reapOrphanVm ran before this and either
      // found nothing (a VM outside our tree, or one owned by another user account) or was refused the kill. The
      // underlying message explains the socket state accurately and tells the user nothing they can act on.
      throw new Error(
        `${e?.message ?? e}. A sandbox VM from an earlier session is still running and owns port ${QMP_PORT}. ` +
          (isWin
            ? "End any qemu-system-x86_64.exe task in Task Manager (or sign out and back in) and start the sandbox again."
            : "Kill the stray qemu-system-* process (pkill -f qemu-system) and start the sandbox again."),
      );
    }
    try {
      // Raced against the corruption report rather than simply awaited. A broken disk image cannot become a booted guest,
      // so sitting out the full guest-agent timeout only delays the answer by three minutes and then gives the wrong one.
      const agentReady = guestAgent({ port: GA_PORT }); // includes waiting for the guest to be ready
      // Race does not cancel the loser: when corruption settles this first, the wait above still runs to its own 180s
      // timeout and rejects with nobody left to receive it. Attaching a sink here — not replacing what the race sees,
      // since .catch() returns a new promise — is what keeps that from surfacing as an unhandled rejection.
      agentReady.catch(() => {});
      guest = await Promise.race([
        agentReady,
        new Promise((_res, rej) => {
          // Not an immediate verdict. qemu itself calls some of these events non-fatal ("further non-fatal corruption
          // events will be suppressed"), and an image that still boots must not be deleted over a warning — so the
          // report only shortens the deadline instead of ending the wait. Boot wins if it happens inside the grace
          // period; failing to boot within it, having been told the disk is broken, is the actual diagnosis.
          const arm = () => { corruptTimer = setTimeout(() => rej(new Error(corruptReport)), CORRUPT_GRACE_MS); };
          if (corruptReport) return arm();
          onCorrupt = arm;
        }),
      ]);
    } catch (e) {
      if (corruptReport) {
        // Self-healing: drop the unusable image so the next start downloads it again. These files are a CDN cache the app
        // already deletes on its own (pruneOldVmVersions), and versionComplete() is an existsSync test — so leaving a
        // corrupt one in place is precisely what makes the failure permanent, with no button anywhere that repairs it
        // ("Update" resolves to this same version directory and finds nothing missing to fetch).
        //
        // Only the managed copy. A rootfs pointed at by config or ZERAIX_ROOTFS is the user's own file, not ours to delete.
        const managed = !cfg?.rootfs && !process.env.ZERAIX_ROOTFS && rootfs === path.join(vd, "rootfs.qcow2");
        if (managed) {
          // Kill qemu FIRST. It has the corrupt image open as its backing file, and Windows refuses to delete a file
          // another process holds — so deleting before killing (which is what the outer cleanup would have meant) fails
          // silently inside this catch, the image survives, and the self-heal quietly does nothing on the one platform
          // it was written for. Same retry backoff as the overlay delete, for the same asynchronous handle release.
          try { proc.kill(); } catch { /* ignore */ }
          try { fs.rmSync(rootfs, { force: true, maxRetries: 20, retryDelay: 100 }); }
          catch { /* still locked: the next start finds it corrupt again and says so */ }
          recordRecovery("sandbox", "image-condemned", { report: String(corruptReport).slice(0, 300) });
        }
        throw new Error(
          `the runtime disk image is corrupt (${corruptReport}). ` +
            (managed
              ? "It has been discarded — start the sandbox again to download a fresh copy."
              : `Replace or remove ${rootfs} and start the sandbox again.`),
        );
      }
      // "guest agent did not come up" on its own names a symptom and no cause, and the two files that DO hold the cause are
      // written silently beside the disk image where nobody thinks to look. The distinction that matters is already in them:
      // console.log empty / stuck at the first lines = the guest never booted (a host-side problem — acceleration, CPU model,
      // firmware, and qemu.log will say so); console.log full of systemd output = it booted and qemu-guest-agent is what
      // failed. Quote the tails so that distinction reaches the user in the dialog, instead of costing a support round trip.
      throw new Error(
        `${e?.message ?? e}\n` +
          `The VM was started but never answered. Diagnostics are in ${vd}:\n` +
          `--- console.log (guest kernel / systemd; empty means the guest never booted) ---\n${tailFile(path.join(vd, "console.log"))}\n` +
          `--- qemu.log (host-side qemu errors) ---\n${tailFile(path.join(vd, "qemu.log"))}`,
      );
    } finally {
      // Disarm the rejector once the race is decided. qemu reports non-fatal corruption during normal operation too, and
      // the stderr handler outlives this block — so leaving it armed means a late report rejects a promise no one is
      // awaiting any more, i.e. an unhandled rejection on a VM that is running perfectly well. The pending timer goes
      // with it, or a healthy VM would still be holding the event loop open for the rest of the grace period.
      onCorrupt = () => {};
      if (corruptTimer) clearTimeout(corruptTimer);
    }
    // Backing store for the sandbox's /tmp (see GUEST_TMP / bwrapFlags). Created here rather than in the image so it needs no
    // rootfs rebuild. 1777 = the mode /tmp is expected to have (world-writable, sticky).
    try { await guest.exec("/bin/mkdir", ["-p", "-m", "1777", GUEST_TMP]); } catch { /* bwrap falls back to failing loudly if absent */ }
    await enableSwap(guest);
    setVm({ proc, ports, guest });
    if (isWin) await winShareMount(guest); // Windows host share: 9p-over-tcp (no virtio-9p)
    return vm;
  } catch (e) {
    // The VM this boot started never became usable, so it must not outlive the attempt. Sockets first: both control
    // channels serve exactly one client, and one left open is what makes the NEXT boot's handshake hang instead of
    // failing cleanly. `vm` is cleared by the exit handler, so a half-assembled one cannot be left behind either.
    try { ports?.close?.(); } catch { /* best effort */ }
    try { guest?.close?.(); } catch { /* best effort */ }
    try { proc.kill(); } catch { /* best effort */ }
    throw e;
  }
}

/** Called by engine.mjs: start the long-lived VM. onProgress(pct,msg): progress callback for downloading the VM disk/kernel on first run.
 *  forceConfigured=true: user "update" -- download the versions.json target version and switch to it. */
export async function provision(rootHost, onProgress, forceConfigured = false) {
  setHomeRoot(path.resolve(rootHost));
  await boot(onProgress, forceConfigured);
}

// ── Foreground execution ─────────────────────────────────────────────────────────────────
/**
 * Check that the guest is still answering, and bring it back if it is not (C5).
 *
 * Written for suspend/resume, which is the one failure this file could not see. The host sleeps, the VM's clock jumps
 * by however long the lid was shut, and the guest-agent socket is commonly dead on the other side — but qemu is still
 * running, so nothing about the process tells us anything is wrong. The first command after waking then pays a full
 * timeout to discover it, and reports a timeout, which reads as "your command was slow" rather than "the sandbox was
 * asleep".
 *
 * A short probe answers it in a second, and a failure takes the same route as any other death: restart once, at most
 * once, and record it. Skipped while a command is in flight — that command is a better probe than this one, and
 * restarting under it would be the very thing this file is trying to stop happening by accident.
 */
export async function probeAfterResume() {
  // A running command is a better liveness probe than this one, and — more importantly — sending concurrently on the
  // agent channel can hand that command someone else's reply. See commandsInFlight.
  if (!vm || restarting || commandsInFlight > 0) return { ok: true, skipped: true };
  try {
    // Bounded HERE rather than relying on the call: `guest.exec` polls guest-exec-status in an unbounded loop, so a
    // guest whose socket is alive but which never completes anything would keep this pending for ever — which is
    // precisely the state the probe exists to detect, and the one it would then never report. A healthy agent answers
    // a `/bin/true` in milliseconds, so anything past this is the answer.
    await Promise.race([
      vm.guest.exec("/bin/true", []),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`guest did not answer within ${RESUME_PROBE_MS}ms`)), RESUME_PROBE_MS);
        t.unref?.();
      }),
    ]);
    return { ok: true };
  } catch (e) {
    console.warn("[sandbox/qemu] the guest did not answer after the host resumed:", e?.message ?? e);
    recordRecovery("sandbox", "unresponsive-after-resume", { reason: String(e?.message ?? e).slice(0, 200) });
    await restartAfterDeath("unresponsive after the host resumed");
    return { ok: false };
  }
}

/**
 * Bring the sandbox back after it died under a running command, at most once per death.
 *
 * Bounded the same way every other restart in this document is: a VM that dies on every boot must not be rebooted per
 * command. `boot()` already self-heals a corrupt image and reaps an orphan, so the work here is only to make sure the
 * NEXT command finds a live sandbox instead of every later call rediscovering the same corpse — and to say plainly in
 * the log when it could not.
 */
let restarting = null;
async function restartAfterDeath(reason) {
  if (restarting) return restarting;
  restarting = (async () => {
    try {
      // An automatic restart must never become an automatic DOWNLOAD. `boot()` goes through `ensureRootfs`, which
      // fetches a multi-gigabyte image when one is missing — and "missing" is exactly the state the self-heal leaves
      // behind after condemning a corrupt image. Starting that in the background, with no consent, no progress and no
      // dialog, off the back of one failed command is not a recovery; it is a surprise. When the image is not already
      // on disk this stands down and the user starts the sandbox themselves, which is the path that reports progress.
      const vd = path.join(vmRoot(), bootVersion());
      const missing = VM_FILES.filter((f) => !fs.existsSync(path.join(vd, f)));
      if (missing.length) {
        console.warn(`[sandbox/qemu] not restarting automatically: ${missing.join(", ")} would have to be downloaded first`);
        recordRecovery("sandbox", "restart-skipped", { reason: "image not present", missing });
        return;
      }
      try {
        await dispose({ waitMs: 2000 });
      } catch {
        /* it is already gone; that is the case we are here for */
      }
      await boot();
      console.info("[sandbox/qemu] restarted after the sandbox stopped mid-command");
      recordRecovery("sandbox", "restarted", { reason: String(reason).slice(0, 200), ok: true });
    } catch (e) {
      console.warn("[sandbox/qemu] could not restart the sandbox:", e?.message ?? e);
      recordRecovery("sandbox", "restarted", { reason: String(reason).slice(0, 200), ok: false, error: String(e?.message ?? e).slice(0, 200) });
    } finally {
      restarting = null;
    }
  })();
  return restarting;
}

/** Foreground execution: inside the guest, bwrap confined to the mount set, bash -c cmd, with a timeout; never throws. */
export async function run(cmd, opts = {}) {
  const { cwd, timeoutMs, maxBuffer, signal } = opts;
  try {
    if (!vm) throw new Error("vm not ready");
    const argv = ["/usr/bin/bwrap", ...bwrapFlags(cwd), "--", "/bin/bash", "-c", cmd];
    commandsInFlight += 1;
    let settled;
    try {
      settled = await vm.guest.runStatus(argv, {
        timeoutSec: Math.max(1, Math.round((timeoutMs ?? 60000) / 1000)),
        signal,
      });
    } finally {
      commandsInFlight -= 1;
    }
    const { out, err, code, killed, canceled } = settled;
    const cap = (s) => (maxBuffer && s.length > maxBuffer ? s.slice(0, maxBuffer) : s);
    return { stdout: cap(out), stderr: cap(err), code, killed, canceled: !!canceled };
  } catch (e) {
    // Started, then the channel died: the command's fate is unknown and must not be reported as "not run".
    if (e?.started) {
      // One automatic restart, so the NEXT command has a sandbox to run in rather than every later call
      // rediscovering the same corpse. Fire-and-forget: this command's answer does not depend on it.
      void restartAfterDeath(`command interrupted: ${e?.message ?? e}`);
      return sandboxDiedMidCommand(e?.message ?? String(e));
    }
    return sandboxFailure(`exec failed: ${e?.message ?? e}`);
  }
}

/** Exit cleanup: remove all forwards + shut down the VM. */
export async function dispose({ waitMs = 10000 } = {}) {
  const proc = vm?.proc;
  const ports = vm?.ports;
  const guest = vm?.guest;
  // Sweep the services while `vm` is still set, so each one really does have its forward removed and its process group
  // killed. Everything here dies with the VM anyway, but leaving `procs` to be cleared by a half-working sweep would
  // hide a bug the moment this is ever called without the VM going away.
  try { stopAll(); } catch { /* best effort */ }
  // stopAll goes through stopProcess, which cancels each watcher — but only for jobs still in `procs`. This is the
  // backstop for any that are not, so no poller is left ticking against a VM that is about to be gone.
  for (const key of [...watchers.keys()]) stopWatching(key);
  setVm(null); // from here on no command may reach a VM that is going away
  try { ninep?.close(); } catch { /* best effort */ } finally { ninep = null; }
  try { ports?.quit(); } catch { /* best effort */ }
  try { proc?.kill(); } catch { /* best effort */ }
  // Hand back the control sockets. Both the QMP monitor and the guest agent serve ONE client, so a socket left open here
  // is not merely untidy: the next VM's handshake connects, is never accepted, and waits forever. That is exactly how a
  // restart used to stall in "starting" with a healthy VM running beside it.
  try { ports?.close?.(); } catch { /* best effort */ }
  try { guest?.close?.(); } catch { /* best effort */ }
  // Wait for the process to be gone before returning, so a caller that starts a new VM next cannot race the old one for
  // the fixed control ports. SIGTERM first; escalate only if it will not leave.
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, waitMs);
      proc.once("exit", done);
    });
  }
}
