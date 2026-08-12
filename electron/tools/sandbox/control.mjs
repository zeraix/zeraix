// Control plane for the single long-lived sandbox VM. Identical on macOS + Windows
// (both talk TCP to 127.0.0.1). Used by the qemu engine (electron/tools/sandbox/qemu.mjs):
//
//   qmp()        -> QMP capabilities handshake + dynamic host->guest port forward
//                   (hostfwd_add / hostfwd_remove), host-side, instant
//   guestAgent() -> qemu-guest-agent client: runStatus() (non-throwing timed run for the
//                   run_command engine) + exec() (raw guest-exec). The workload is confined
//                   by bubblewrap; qemu.mjs builds the bwrap argv (bind set = mount set).
import net from 'node:net';

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry the TCP connect until QEMU has opened the listener (VM just launched).
function connect(port, { retries = 240, delay = 500 } = {}) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tryOnce = () => {
      const s = net.createConnection({ host: HOST, port });
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        if (++n >= retries) return reject(new Error(`connect 127.0.0.1:${port} failed`));
        setTimeout(tryOnce, delay);
      });
    };
    tryOnce();
  });
}

// Line-delimited JSON (QMP + guest agent). Commands are serialized (await each), so
// FIFO matching against {return}/{error} is safe; greetings/async events are ignored.
function jsonSock(sock) {
  const waiters = [];
  let buf = '';
  sock.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!('return' in m || 'error' in m)) continue;
      const head = waiters[0];
      // A sync waiter swallows everything until its own nonce comes back, which is what makes the FIFO matching below sound:
      // waitAgent's connect/destroy probes can leave a reply in flight, and positional matching would otherwise hand it to
      // the first real command as that command's answer, shifting every reply after it by one.
      //
      // Hardening, not a fix for an observed bug. This was written while chasing "PID ld does not exist" on the theory that a
      // misaligned queue was sending guest-exec-status a pid of undefined; that theory was never reproduced (a stale reply
      // arriving with no waiter queued is simply dropped, so both the old and new code survive it). The real cause was the
      // guest OOM-killer taking the python process — and qemu-ga with it — so the pid genuinely no longer existed. Kept
      // because positional matching against a shared channel is only sound if nothing else can be in flight, and nothing else
      // enforced that.
      if (head && head.nonce !== undefined) {
        if ('return' in m && m.return === head.nonce) { waiters.shift(); head.resolve(true); }
        continue; // anything else at this point is stale: drop it rather than answer a command with it
      }
      const w = waiters.shift();
      if (w && m.error) w.reject(new Error(m.error.desc || 'error'));
      else if (w) w.resolve(m.return);
    }
  });
  const send = obj => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    sock.write(JSON.stringify(obj) + '\n');
  });
  /** Flush anything stale still in flight, through this same queue, so the next send() is aligned. */
  const sync = (timeoutMs = 3000) => new Promise((resolve) => {
    const nonce = ++syncSeq * 100000 + (Date.now() % 100000);
    const w = { nonce, resolve: () => { clearTimeout(t); resolve(true); }, reject: () => { clearTimeout(t); resolve(false); } };
    const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(false); }, timeoutMs);
    waiters.push(w);
    sock.write(JSON.stringify({ execute: 'guest-sync', arguments: { id: nonce } }) + '\n');
  });
  return { sock, send, sync };
}

/** QMP: capabilities handshake + dynamic host->guest port forwards. */
export async function qmp({ port = +(process.env.QMP_PORT || 4444), handshakeMs = 15000 } = {}) {
  const sock = await connect(port);
  const c = jsonSock(sock);
  // Drain the QMP greeting line, then negotiate capabilities -- under a timeout, because connecting is not the same as
  // being served. QMP hands out ONE client slot: while another client holds it, a second connection still completes at
  // the TCP level and then sits in the accept backlog, unread. Observed as a restart that never finished, with the
  // kernel showing the 31 bytes of this very command queued forever:
  //   127.0.0.1.4444 <- .56900  Recv-Q 31  ESTABLISHED   (qemu never accepted it)
  //   127.0.0.1.4444 <- .56899  Recv-Q  0  ESTABLISHED   (qemu holds this one)
  // An await with no timeout turns that into a permanent "starting", so fail with the reason instead.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* ignore */ }
      reject(new Error(`QMP handshake timed out after ${handshakeMs}ms on 127.0.0.1:${port} — the port is open but another client holds the monitor`));
    }, handshakeMs);
    c.send({ execute: 'qmp_capabilities' }).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
  const hmp = line => c.send({ execute: 'human-monitor-command', arguments: { 'command-line': line } });
  return {
    addPort:    (host, guest, ip = '127.0.0.1') => hmp(`hostfwd_add net0 tcp:${ip}:${host}-:${guest}`),
    removePort: (host, ip = '127.0.0.1')        => hmp(`hostfwd_remove net0 tcp:${ip}:${host}`),
    quit:       () => c.send({ execute: 'quit' }).catch(() => {}),
    /** Drop this client's socket, freeing qemu's single monitor slot for the next connection. */
    close:      () => { try { sock.destroy(); } catch { /* ignore */ } },
    raw: c.send,
  };
}

// qemu-guest-agent framing MUST be resynced on every fresh connection: after the host
// side of the virtio-serial channel drops and reopens (e.g. waitAgent's connect/destroy
// probes during boot), qemu-ga ignores commands until it sees a `guest-sync` echoing a
// nonce. A bare guest-ping never gets a reply → the channel looks dead forever. So each
// new socket drains any stale bytes and blocks on the nonce before real commands flow.
let syncSeq = 1;
function guestSync(sock, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const id = ++syncSeq * 100000 + (Date.now() % 100000);
    let buf = '', done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      clearTimeout(timer); sock.removeListener('data', onData); resolve(ok);
    };
    const onData = (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if ('return' in m && m.return === id) return finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('data', onData);
    sock.write(JSON.stringify({ execute: 'guest-sync', arguments: { id } }) + '\n');
  });
}

/** Wait until the in-guest agent responds (guest booted + qemu-ga up). Reconnects per
 *  attempt so a slow boot never leaves a dangling waiter, and syncs each probe so the
 *  reconnect churn doesn't wedge qemu-ga's framing. */
async function waitAgent(port, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    let s;
    try {
      s = await connect(port, { retries: 1 });
      if (await guestSync(s, 1500)) { s.destroy(); return; }
    } catch { /* not ready */ }
    try { s?.destroy(); } catch { /* ignore */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('guest agent did not come up');
    await sleep(1000);
  }
}

/** qemu-guest-agent client: timed non-throwing run + raw guest-exec. */
export async function guestAgent({ port = +(process.env.GA_PORT || 4445) } = {}) {
  await waitAgent(port);
  const sock = await connect(port);
  await guestSync(sock); // resync this fresh persistent socket + drain stale replies before FIFO
  const c = jsonSock(sock);
  // Then flush again THROUGH the queue. guestSync above uses its own listener and its own buffer, so a reply that arrives
  // after it returns is picked up by jsonSock and answers the first real command instead. This second pass leaves the queue
  // aligned; see the sync waiter in jsonSock.
  await c.sync();

  /** Raw guest-exec: run argv, poll to completion, throw on non-zero. */
  const exec = async (bin, arg, { input, env } = {}) => {
    const a = { path: bin, arg, 'capture-output': true };
    if (env) a.env = env; // ["K=V", ...] passed to execve verbatim (no shell parsing)
    if (input != null) a['input-data'] = Buffer.from(input).toString('base64');
    const started = await c.send({ execute: 'guest-exec', arguments: a });
    const pid = started?.pid;
    if (typeof pid !== 'number') { await c.sync(); throw new Error(`guest-exec returned no pid (got ${JSON.stringify(started)}); agent channel was out of sync, resynced`); }
    for (;;) {
      const st = await c.send({ execute: 'guest-exec-status', arguments: { pid } });
      if (st.exited) {
        const out = Buffer.from(st['out-data'] || '', 'base64').toString();
        const err = Buffer.from(st['err-data'] || '', 'base64').toString();
        if (st.exitcode) throw new Error(`${bin} exited ${st.exitcode}: ${err}`);
        return { out, err };
      }
      await sleep(50);
    }
  };

  return {
    /** Drop this client's socket. The agent's chardev takes one client too, so a socket left over from a previous VM
     *  would keep the next one from being served. */
    close: () => { try { sock.destroy(); } catch { /* ignore */ } },
    /** Non-throwing, timed run (for the run_command engine). Wraps in coreutils
     *  `timeout`; returns exit status instead of throwing. code 124 => timed out. */
    async runStatus(argv, { timeoutSec = 60 } = {}) {
      const started = await c.send({ execute: 'guest-exec', arguments: {
        path: '/usr/bin/timeout', arg: ['-k', '2', String(timeoutSec), ...argv], 'capture-output': true } });
      const pid = started?.pid;
      // Check the reply really is a guest-exec reply. Without this, a queue that had slipped out of alignment would send
      // `{ pid: undefined }` to guest-exec-status and the failure would surface one step later as qemu-ga's "PID does not
      // exist" — naming a pid rather than the misalignment that produced it. Resync so the next command starts clean.
      if (typeof pid !== 'number') {
        await c.sync();
        throw new Error(`guest-exec returned no pid (got ${JSON.stringify(started)}); agent channel was out of sync, resynced`);
      }
      for (;;) {
        const st = await c.send({ execute: 'guest-exec-status', arguments: { pid } });
        if (st.exited) {
          const code = st.exitcode ?? 0;
          return {
            out: Buffer.from(st['out-data'] || '', 'base64').toString(),
            err: Buffer.from(st['err-data'] || '', 'base64').toString(),
            code, killed: code === 124,
          };
        }
        await sleep(50);
      }
    },
    exec,
  };
}
