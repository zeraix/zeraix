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
      if ('return' in m || 'error' in m) {
        const w = waiters.shift();
        if (w && m.error) w.reject(new Error(m.error.desc || 'error'));
        else if (w) w.resolve(m.return);
      }
    }
  });
  const send = obj => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    sock.write(JSON.stringify(obj) + '\n');
  });
  return { sock, send };
}

/** QMP: capabilities handshake + dynamic host->guest port forwards. */
export async function qmp({ port = +(process.env.QMP_PORT || 4444) } = {}) {
  const c = jsonSock(await connect(port));
  // Drain the QMP greeting line, then negotiate capabilities.
  await c.send({ execute: 'qmp_capabilities' });
  const hmp = line => c.send({ execute: 'human-monitor-command', arguments: { 'command-line': line } });
  return {
    addPort:    (host, guest, ip = '127.0.0.1') => hmp(`hostfwd_add net0 tcp:${ip}:${host}-:${guest}`),
    removePort: (host, ip = '127.0.0.1')        => hmp(`hostfwd_remove net0 tcp:${ip}:${host}`),
    quit:       () => c.send({ execute: 'quit' }).catch(() => {}),
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

  /** Raw guest-exec: run argv, poll to completion, throw on non-zero. */
  const exec = async (bin, arg, { input, env } = {}) => {
    const a = { path: bin, arg, 'capture-output': true };
    if (env) a.env = env; // ["K=V", ...] passed to execve verbatim (no shell parsing)
    if (input != null) a['input-data'] = Buffer.from(input).toString('base64');
    const { pid } = await c.send({ execute: 'guest-exec', arguments: a });
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
    /** Non-throwing, timed run (for the run_command engine). Wraps in coreutils
     *  `timeout`; returns exit status instead of throwing. code 124 => timed out. */
    async runStatus(argv, { timeoutSec = 60 } = {}) {
      const { pid } = await c.send({ execute: 'guest-exec', arguments: {
        path: '/usr/bin/timeout', arg: ['-k', '2', String(timeoutSec), ...argv], 'capture-output': true } });
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
