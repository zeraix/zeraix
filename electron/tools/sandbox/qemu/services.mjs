/**
 * QEMU engine — background long-lived services: a command started with `setsid … &` inside the guest, its listening ports
 * found from the socket table and forwarded to the host over QMP hostfwd, the service table that stop_service and the
 * running-services panel read, and the poller that notices when a guest job ends. Part of the qemu engine; qemu.mjs is
 * the public entry and re-exports this module's API.
 */
import { emitService } from "../events.mjs";
import { vm, sandboxFailure } from "./shared.mjs";
import { bwrapFlags, shq } from "./args.mjs";

// Background long-lived service table: id -> { id, gpid, hostPorts, url, command, log }. The id is the service's primary
// port when it has one, otherwise PORTLESS_ID_BASE + gpid; hostPorts lists every forward it actually got.
const procs = new Map();
let svcSeq = 0;

// ── Background long-lived services: run inside the guest + QMP hostfwd forwards ports to the host ──────────────────────
const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;
const pickPort = (s) => {
  const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  return m ? Number(m[1]) : 0;
};
const PORTLESS_ID_BASE = 100000; // above the top of the port range (65535), so a portless service's id can never be mistaken for a port
const PORT_WAIT_MS = 8000; // total time a service is given to bind before we return without a forward
const READY_GRACE_MS = 1500; // extra time after the log looks ready — a server binds before it logs, so this is slack, not a wait

/**
 * Every TCP port THIS service is listening on, ascending (empty if none).
 *
 * Plural because one service commonly binds several: a dev server with a separate HMR/websocket port, an app plus its
 * debug port, a framework that opens both v4 and v6 sockets. Returning just the first would forward whichever the
 * kernel happened to list first — ss output is in hash order, not port order — so the one the user was told about could
 * be the wrong one.
 *
 * The socket table decides, not the log. A log line is a convention every framework writes differently --
 * "http://localhost:5173/", "Listening on 0.0.0.0:9123", "Server listening on port 3000", or nothing at all -- while a
 * LISTEN socket is the fact we need. Reading the text forwarded the frameworks that print a URL and silently forwarded
 * nothing for the rest.
 *
 * The socket is attributed to the service by PROCESS ANCESTRY, not by diffing the guest's ports before and after: a
 * diff cannot tell two services starting at once apart, and answers "some port appeared" when the question is "which
 * port is this service's". Walking PPid from each listening socket's owner up to gpid answers exactly that, and it also
 * covers a server that forks workers, since every worker is still a descendant.
 *
 * Ancestry rather than session or process group: bwrap is invoked with --new-session, so the sandboxed process gets a
 * fresh session and pgid of its own and neither matches gpid.
 *
 * Asked through the guest agent, which runs OUTSIDE bwrap. Each command has its own PID namespace (--unshare-pid), so
 * one command can never see another's processes, but the guest agent sees the whole guest, and the network namespace is
 * shared, so the service's socket and its owning pid are both visible from there.
 */
async function servicePorts(gpid) {
  if (!gpid) return [];
  // For each LISTEN socket: take its owning pids out of the ss "users:((...,pid=N,...))" column, then walk each one up
  // the PPid chain (from /proc/<pid>/status, whose PPid line is safe to parse — /proc/<pid>/stat is not, because the
  // comm field can itself contain spaces and parentheses). First hit wins; the depth cap is a cycle guard.
  const script = `
ss -Hltnp 2>/dev/null | while read -r st rq sq local rest; do
  port=\${local##*:}
  for pid in $(printf '%s' "$rest" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    p=$pid; n=0
    while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ] && [ "$n" -lt 40 ]; do
      if [ "$p" = "$SVC_PID" ]; then echo "$port"; break 2; fi
      p=$(awk '/^PPid:/{print $2}' "/proc/$p/status" 2>/dev/null)
      n=$((n + 1))
    done
  done
done | sort -un`;
  try {
    const { out } = await vm.guest.exec("/bin/bash", ["-lc", script], { env: [`SVC_PID=${gpid}`] });
    return String(out)
      .split(/\s+/)
      .map(Number)
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  } catch {
    return []; // ss unavailable / agent hiccup — the caller falls back to reading the log
  }
}

/**
 * Start a long-lived command in the background inside the guest (bwrap-confined + network allowed), scan early output for a port, QMP hostfwd
 * to the same port on the host, and return a host-reachable URL. On stop, the forward is removed too. A launch-channel failure
 * is reported, not run on the host — same reasoning as sandboxFailure (qemu/shared.mjs), and a long-lived service escaping the sandbox is
 * worse than a one-shot command doing so.
 */
/**
 * Watch a guest background job and report how it ended.
 *
 * The host has no child process to hang an `exit` handler on — the job lives inside the VM behind the guest
 * agent — so completion has to be polled. `kill -0` is the cheapest liveness question there is, and 3s is
 * frequent enough that a finished install is announced while the user still cares, without making the guest
 * agent busy for the hours a dev server may run.
 *
 * Only started for `notify` jobs. Every other background command keeps the previous behaviour, where nobody
 * is listening for the end and polling would be pure cost.
 */
export const watchers = new Map(); // key → interval id
function watchGuestJob({ key, gpid, cmd, log, notify }) {
  if (watchers.has(key)) return;
  // A notify job has the model waiting on it, so it is polled briskly. Everything else is polled only
  // so the service table stops claiming a finished job is still running — nobody is blocked on that,
  // and each poll is a process spawned inside the guest, so a dev server running for hours should not
  // pay 3-second attention it has no use for.
  const every = notify ? 3000 : 12_000;
  const timer = setInterval(async () => {
    if (!vm) return stopWatching(key);
    try {
      await vm.guest.exec("/bin/kill", ["-0", String(gpid)]);
      return; // still running
    } catch {
      /* gone → fall through and report */
    }
    stopWatching(key);
    // Drop it from the service table too. The job is gone; leaving the entry behind would keep listing it as a
    // running service and give stop_service a pid that answers to nothing.
    const p = procs.get(key);
    if (p) {
      procs.delete(key);
      for (const hp of p.hostPorts ?? []) vm?.ports.removePort(hp).catch(() => {});
    }
    let tail = "";
    // The exit CODE is not recoverable: the job was launched with `setsid … &` and its shell is long gone, so
    // there is nothing left to reap. The log tail is what remains, and it is what the model actually reads.
    try {
      const r = await vm.guest.exec("/bin/tail", ["-c", "4000", log]);
      tail = String(r.out ?? "").trim();
    } catch {
      /* log unreadable (VM restarted, /tmp cleared) — report completion without it */
    }
    // `notify` decides whether this WAKES the model; the event itself is emitted either way, because the
    // running-services panel needs to know the job is over regardless of who asked to be told.
    emitService({ type: "stopped", pid: key, reason: "exited", command: cmd, code: null, tail, notify: !!notify });
  }, every);
  timer.unref?.(); // a pending poll must never hold the app open at quit
  watchers.set(key, timer);
}
export function stopWatching(key) {
  const t = watchers.get(key);
  if (t) clearInterval(t);
  watchers.delete(key);
}

export async function startBackground(cmd, opts = {}) {
  if (!vm) return sandboxFailure("vm not ready");
  const cwd = opts.cwd;
  const log = `/tmp/zx-svc-${++svcSeq}.log`;
  const flags = bwrapFlags(cwd).map(shq).join(" ");
  // SVC_CMD is passed via the guest-exec env (execve directly, no shell), and "$SVC_CMD" is used as a single whole string argument to bash -lc.
  const script =
    `setsid /usr/bin/bwrap ${flags} -- /bin/bash -lc "$SVC_CMD" >${shq(log)} 2>&1 </dev/null & echo $!`;
  let gpid = 0;
  try {
    const { out } = await vm.guest.exec("/bin/bash", ["-lc", script], { env: [`SVC_CMD=${cmd}`] });
    gpid = parseInt(String(out).trim(), 10) || 0;
  } catch (e) {
    return sandboxFailure(`service launch failed: ${e?.message ?? e}`);
  }

  // Wait for the service to bind. The log supplies only the startup text shown to the user and the hint that the process
  // is up; the port comes from the socket table (servicePort), so a service that prints its port in an unusual format,
  // or prints nothing at all, is forwarded exactly like one that prints a tidy URL.
  //
  // READY no longer ends the scan on its own. It used to, and that lost the port for anything whose first line matched
  // before it had bound — "Server listening on port 3000" satisfies READY, carries no URL for pickPort, and the loop
  // exited right there:
  //   before: "listening" seen -> break -> no port -> no forward, and the service was left untracked
  //   after:  "listening" seen -> keep polling the socket table for READY_GRACE_MS -> port -> forward
  // Something that never listens (a watcher, a compiler) still returns promptly, one grace period after it looks ready,
  // instead of costing the full timeout.
  let out = "";
  let ports = [];
  let readyAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < PORT_WAIT_MS) {
    try {
      const r = await vm.guest.exec("/bin/cat", [log]);
      out = r.out || out;
    } catch {
      /* log not generated yet */
    }
    ports = await servicePorts(gpid);
    if (ports.length) break;
    if (readyAt && Date.now() - readyAt > READY_GRACE_MS) break;
    if (!readyAt && READY.test(out)) readyAt = Date.now();
    await new Promise((r) => setTimeout(r, 300));
  }
  // Last resort, for a guest where ss cannot answer: believe the log if it printed a URL.
  const logPort = pickPort(out);
  if (!ports.length && logPort) ports = [logPort];

  // Forward every port the service owns, guest port -> same host port (the guest must listen on 0.0.0.0, reached via the
  // SLIRP gateway 10.0.2.x). One may fail while others succeed — the host port can already be taken by something else on
  // the machine — so each is tried on its own and only the ones that took are remembered for teardown.
  const forwarded = [];
  for (const p of ports) {
    try {
      await vm.ports.addPort(p, p);
      forwarded.push(p);
    } catch {
      /* that host port is busy; the service still runs, and its other ports may still forward */
    }
  }
  // The URL names the port the service itself announced, when it announced one — for a dev server that is the page to
  // open, not its HMR socket, and the lowest number is not reliably either. Otherwise: the lowest forwarded port.
  const primary = forwarded.includes(logPort) ? logPort : forwarded[0] || 0;
  const url = primary ? `http://localhost:${primary}` : "";
  const extra = forwarded.filter((p) => p !== primary);

  const alive = gpid > 0;
  // Register whether or not a port was found. This used to live inside the branch above, so anything without a forward --
  // a watcher, a compiler, or a server whose port was missed -- ran on with no entry here: listProcesses could not list
  // it and stop_service could not stop it. Nothing else could either, because every command gets its own PID namespace,
  // so a kill from a later command cannot even see the process; only restarting the VM ended it.
  // The id is the primary port when there is one, so "stop_service 5173" reads naturally. Otherwise it is derived from
  // the guest pid and offset past the top of the port range, so a portless service can never be handed the same id as a
  // forwarded one — and if that number is somehow already taken, fall back too rather than evict the existing entry.
  let id = primary;
  if (!id || procs.has(id)) id = PORTLESS_ID_BASE + gpid;
  if (alive) {
    // hostPorts holds only the forwards that actually took, so stopping never removes one that was never added.
    procs.set(id, { id, gpid, hostPorts: forwarded, url, command: cmd, log });
    emitService({ type: "started", pid: id, url, command: cmd });
    // Every background job is watched, not just the `notify` ones. A guest job has no process object to
    // hang an "exit" handler on — the native engine gets that for free from child.on("exit") and cleans
    // up whether or not anyone asked to be notified — so polling is the only way to learn it ended. When
    // this was gated on `notify`, a command that finished on its own (`sleep 60 && …`) left its entry in
    // `procs` for the life of the VM: still listed as a running service, still offered by stop_service
    // under a guest pid that answers to nothing, and its forwarded host ports never released.
    // Keyed by the same id the table uses, so a stop cancels the same entry the watcher would report.
    watchGuestJob({ key: id, gpid, cmd, log, notify: !!opts.notify });
  }
  const headline = alive
    ? `✅ Service started in the background inside the sandbox${url ? `, and forwarded to the host: ${url}` : ports.length ? ` (guest port ${ports.join(", ")}, forwarding failed)` : ""}.`
    : "⚠️ The process failed to start.";
  return (
    `${headline}\n\n--- Startup output ---\n${(out.trim() || "(no output yet)").slice(-4000)}\n` +
    (url
      ? `\nNote: the service runs inside an isolated sandbox with its port forwarded, so the host can reach ${url} (use it to preview).${extra.length ? ` Its other ports are forwarded too: ${extra.map((p) => `http://localhost:${p}`).join(", ")}.` : ""} If it's unreachable, make the service listen on 0.0.0.0. Do not start it again.`
      : alive
        ? // Names stop_service and the id, because that is the only way to stop this process — it has no port to be
          // known by, and no other command can reach it (separate PID namespaces). The old text sent the model to
          // "expose_port", which is not a declared tool, for a service it also could not have stopped.
          `\nNote: the service runs in the background inside the sandbox. Nothing is listening yet, so no port is forwarded — if it should serve HTTP, make it listen on 0.0.0.0 (not 127.0.0.1, which the host cannot reach) and it will be forwarded on the next start. Stop it with stop_service pid ${id}.`
        : "")
  );
}

/** Stop a background service (by the id it was started under): remove the hostfwd, if it has one, + terminate the guest process group. */
export function stopProcess(pid) {
  const key = Number(pid);
  const p = procs.get(key);
  if (!p) return false;
  procs.delete(key);
  stopWatching(key); // a user-initiated stop is not a completion; do not wake the model for it
  // Every forward this service got, not just one: a dev server with an HMR port would otherwise leave the second
  // hostfwd behind, pointing into a VM where nothing answers.
  for (const hp of p.hostPorts ?? []) vm?.ports.removePort(hp).catch(() => {});
  // setsid makes gpid the process-group leader; a negative kill terminates the whole group, falling back to the single process on failure.
  vm?.guest
    .exec("/bin/kill", ["-TERM", `-${p.gpid}`])
    .catch(() => vm?.guest.exec("/bin/kill", ["-TERM", String(p.gpid)]).catch(() => {}));
  emitService({ type: "stopped", pid: key });
  return true;
}

export function listProcesses() {
  // p.id, not a port: a service without a forward has no port to be named by, and reporting 0 for all of them would make
  // every such service look like the same one and stop none of them.
  return [...procs.values()].map((p) => ({ pid: p.id, url: p.url, command: p.command }));
}

export function stopAll() {
  for (const key of [...procs.keys()]) stopProcess(key);
}

/** Explicit port forwarding (for the LLM's expose_port tool): guest port -> host port, returns a reachable URL. */
export async function exposePort(guestPort, hostPort = guestPort) {
  if (!vm) throw new Error("sandbox not running");
  await vm.ports.addPort(hostPort, guestPort);
  return `http://localhost:${hostPort}`;
}
export async function unexposePort(hostPort) {
  if (!vm) return false;
  await vm.ports.removePort(hostPort).catch(() => {});
  return true;
}
