// Minimal 9p2000.L server — host-side file sharing for the Windows sandbox.
//
// WHY: on Windows, QEMU ships without virtio-9p/virtfs (fsdev compiled out), so the usual
// `-fsdev local + virtio-9p-pci` host share is unavailable. But the guest kernel's 9p CLIENT
// is present and speaks 9p over any byte stream. This server exports a host directory tree
// (or a virtual multi-drive root) over 9p2000.L on either:
//   - a TCP socket   — guest mounts `trans=tcp` via the SLIRP gateway 10.0.2.2 (host loopback);
//   - qemu's virtio-serial chardev socket (connect mode) — guest mounts `trans=fd` on the
//     matching /dev/vport*, bypassing SLIRP entirely (virtqueue bandwidth, much faster bulk I/O).
// All host FS access is plain Node `fs`, so it works on a Windows host — no virtio-9p device,
// no VMM change, no vhost-user.
//
// CONCURRENCY: the data plane (read/write/readdir/fsync) is async — requests are handled
// concurrently and replies may go out of order (9p is tag-based; the Linux client expects this).
// Tflush is honored: a flushed request's reply is dropped and Rflush is sent after it settles.
// Metadata ops stay sync (single-stat, sub-ms). This keeps bulk I/O off the Electron main
// thread's critical path and lets pipelined reads overlap.
//
// SCOPE: the 9p2000.L operations the Linux v9fs client issues for a general dev workload.
// security_model=none semantics: unix uid/gid are 0 and mode is synthesized (Windows has no
// real POSIX mode), matching how qemu's own Windows 9p behaves. xattr/lock are stubbed.
//
//   const srv = await startNinepServer({ root: "C:\\", host: "127.0.0.1", port: 0 });
//   const srv = await startNinepServer({ drives: true, connect: { port: 4446 }, token });
//   // srv.port -> pass to the guest mount; srv.close() to stop.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const readAsync = promisify(fs.read);   // positional (fd, buf, off, len, pos) — safe concurrently
const writeAsync = promisify(fs.write);
const fsyncAsync = promisify(fs.fsync);

// ── 9p2000.L message types (request; reply = request+1, except Rlerror=7) ─────
const Tstatfs = 8, Tlopen = 12, Tlcreate = 14, Tsymlink = 16, Trename = 20, Treadlink = 22,
  Tgetattr = 24, Tsetattr = 26, Txattrwalk = 30, Treaddir = 40, Tfsync = 50, Tlock = 52,
  Tgetlock = 54, Tlink = 70, Tmkdir = 72, Trenameat = 74, Tunlinkat = 76, Tversion = 100,
  Tauth = 102, Tattach = 104, Tflush = 108, Twalk = 110, Tread = 116, Twrite = 118,
  Tclunk = 120, Tremove = 122;
const Rlerror = 7;

const QID_DIR = 0x80, QID_SYMLINK = 0x02, QID_FILE = 0x00;
const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const MAXMSIZE = 524288; // 512 KiB — fewer round trips; kernel negotiates down if it wants less
const EMPTY = Buffer.alloc(0);

// Node error code -> Linux errno (little else is portable across win/posix).
const ERR = { EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EEXIST: 17, EXDEV: 18,
  ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOSPC: 28, EROFS: 30, ENAMETOOLONG: 36, ENOSYS: 38,
  ENOTEMPTY: 39, ELOOP: 40, ENODATA: 61, ENOTSUP: 95, EOPNOTSUPP: 95 };
const errnoOf = (e) => ERR[e && e.code] || ERR.EIO;
const DEBUG = !!process.env.NINEP_DEBUG;

// ── stable qid.path per host path (the client keys its inode cache on it) ─────
const qidIds = new Map();
let qidNext = 1n;
// qid without a stat: stable path-id + caller-provided type + version 0. Treaddir uses this with
// the directory entry's d_type, so it needs no lstat per entry.
function qidFor(p, type) {
  let id = qidIds.get(p);
  if (id === undefined) { id = qidNext++; qidIds.set(p, id); }
  return { type, version: 0, path: id };
}
function qidOf(p, st) {
  const type = st.isDirectory() ? QID_DIR : st.isSymbolicLink() ? QID_SYMLINK : QID_FILE;
  const q = qidFor(p, type);
  q.version = (st.mtimeMs >>> 0) || 0;
  return q;
}
function modeOf(st) {
  // Synthesize a POSIX mode. Files get an exec bit so the guest (running as root under bwrap)
  // can execute shared scripts — root still needs >=1 x bit to execve.
  if (st.isDirectory()) return (S_IFDIR | 0o755) >>> 0;
  if (st.isSymbolicLink()) return (S_IFLNK | 0o777) >>> 0;
  return (S_IFREG | 0o755) >>> 0;
}
// Map Linux open flags (fixed x86 numeric values) to Node/libuv flags.
function toNodeFlags(lf) {
  const acc = lf & 3;
  let f = acc === 1 ? fs.constants.O_WRONLY : acc === 2 ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  if (lf & 0o100) f |= fs.constants.O_CREAT;
  if (lf & 0o200) f |= fs.constants.O_EXCL;
  if (lf & 0o1000) f |= fs.constants.O_TRUNC;
  if (lf & 0o2000) f |= fs.constants.O_APPEND;
  return f;
}

// ── little-endian reader / growable writer ────────────────────────────────────
class R {
  constructor(b) { this.b = b; this.o = 0; }
  u8() { const v = this.b.readUInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  str() { const n = this.u16(); const s = this.b.toString("utf8", this.o, this.o + n); this.o += n; return s; }
  bytes(n) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
}
class W {
  constructor() { this.b = Buffer.allocUnsafe(128); this.o = 0; }
  ensure(n) { if (this.o + n > this.b.length) { const nb = Buffer.allocUnsafe(Math.max(this.b.length * 2, this.o + n)); this.b.copy(nb, 0, 0, this.o); this.b = nb; } }
  u8(v) { this.ensure(1); this.b.writeUInt8(v & 0xff, this.o); this.o += 1; return this; }
  u16(v) { this.ensure(2); this.b.writeUInt16LE(v & 0xffff, this.o); this.o += 2; return this; }
  u32(v) { this.ensure(4); this.b.writeUInt32LE(v >>> 0, this.o); this.o += 4; return this; }
  u64(v) { this.ensure(8); this.b.writeBigUInt64LE(typeof v === "bigint" ? v : BigInt(Math.trunc(v)), this.o); this.o += 8; return this; }
  str(s) { const buf = Buffer.from(s, "utf8"); this.u16(buf.length); this.ensure(buf.length); buf.copy(this.b, this.o); this.o += buf.length; return this; }
  qid(q) { return this.u8(q.type).u32(q.version).u64(q.path); }
  raw(buf) { this.ensure(buf.length); buf.copy(this.b, this.o); this.o += buf.length; return this; }
  done() { return this.b.subarray(0, this.o); }
}

// Virtual multi-drive root (Windows): expose each drive letter as a top-level dir (/C, /E, …) so a
// workdir on any drive maps under /mnt/hostfs. Selected by passing { drives: true } — then ROOT is
// the DRIVES sentinel and the top level lists drives instead of a single real directory.
const DRIVES = " drives";
const DIR_STAT = { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false,
  mtimeMs: 0, atimeMs: 0, ctimeMs: 0, size: 0, nlink: 1, blksize: 4096, blocks: 0 };
const statOf = (p) => (p === DRIVES ? DIR_STAT : fs.lstatSync(p));
function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z (skip A/B floppies)
    const d = String.fromCharCode(c) + ":\\";
    try { fs.statSync(d); out.push(String.fromCharCode(c)); } catch { /* absent */ }
  }
  return out;
}

// Keep walks/creates from escaping the exported root (`..` clamping / drive bounds).
function within(rootAbs, p) {
  if (rootAbs === DRIVES) return p === DRIVES || /^[A-Za-z]:/.test(p); // any drive-absolute path
  const rp = path.resolve(p);
  const base = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  return rp === rootAbs || rp === base || rp.startsWith(base);
}

export function startNinepServer({ root, host = "127.0.0.1", port = 0, token = null, drives = false, connect = null } = {}) {
  const ROOT = drives ? DRIVES : path.resolve(root);
  const ctx = { ROOT, token };

  // connect mode: dial out (e.g. to qemu's virtio-serial chardev socket) and serve 9p on that
  // one stream. The guest mounts trans=fd on the matching /dev/vport*.
  if (connect) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const sock = net.createConnection({ host: connect.host ?? "127.0.0.1", port: connect.port });
        sock.once("connect", () => {
          serveSocket(sock, ctx);
          if (DEBUG) console.error(`[9p] connected ${connect.host ?? "127.0.0.1"}:${connect.port} root=${ROOT}`);
          resolve({ host: connect.host ?? "127.0.0.1", port: connect.port, root: ROOT,
            close: () => { sock.destroy(); return Promise.resolve(); } });
        });
        sock.once("error", (e) => { sock.destroy(); if (++tries >= 20) reject(e); else setTimeout(attempt, 250); });
      };
      attempt();
    });
  }

  const server = net.createServer((sock) => serveSocket(sock, ctx));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: p } = server.address();
      if (DEBUG) console.error(`[9p] listening ${host}:${p} root=${ROOT}`);
      resolve({ port: p, host, root: ROOT, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function serveSocket(sock, { ROOT, token }) {
  sock.setNoDelay(true);
  const fids = new Map(); // fid -> { path, fd?, dir?, entries? }
  const inflight = new Map(); // tag -> { flushed, flushTags[] } (async ops may settle out of order)
  let msize = MAXMSIZE;
  let buf = Buffer.alloc(0);

  sock.on("error", () => {});
  sock.on("close", () => { for (const f of fids.values()) if (f.fd != null) try { fs.closeSync(f.fd); } catch {} });

  // One frame per reply. cork/uncork coalesces header+body without a concat copy — `extra`
  // carries big payloads (Rread data) straight from the read buffer, zero-copy.
  const sendFrame = (t, tag, w, extra) => {
    const body = w ? w.done() : EMPTY;
    const x = extra || EMPTY;
    const h = Buffer.allocUnsafe(7);
    h.writeUInt32LE(7 + body.length + x.length, 0); h.writeUInt8(t, 4); h.writeUInt16LE(tag, 5);
    sock.cork();
    sock.write(h);
    if (body.length) sock.write(body);
    if (x.length) sock.write(x);
    sock.uncork();
  };

  sock.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 7) break;
      const size = buf.readUInt32LE(0);
      if (size < 7 || size > MAXMSIZE + 0x2000) { sock.destroy(); return; }
      if (buf.length < size) break;
      const msg = buf.subarray(0, size); buf = buf.subarray(size);
      handle(msg);
    }
  });

  function handle(msg) {
    const type = msg.readUInt8(4), tag = msg.readUInt16LE(5);
    const r = new R(msg.subarray(7));

    // Tflush: if the old request is still in flight, drop its (future) reply and answer Rflush
    // once it settles; otherwise it already completed — just ack.
    if (type === Tflush) {
      const oldtag = r.u16();
      const e = inflight.get(oldtag);
      if (e) { e.flushed = true; e.flushTags.push(tag); }
      else sendFrame(Tflush + 1, tag, new W());
      return;
    }

    const entry = { flushed: false, flushTags: [] };
    inflight.set(tag, entry);
    const reply = (w, extra) => { if (!entry.flushed) sendFrame(type + 1, tag, w, extra); };
    const err = (e) => {
      if (DEBUG) console.error(`[9p] type ${type} -> errno ${e}`);
      if (!entry.flushed) sendFrame(Rlerror, tag, new W().u32(e));
    };
    dispatch(type, r, reply, err)
      .catch((e) => { if (DEBUG) console.error(`[9p] type ${type} threw`, e); err(errnoOf(e)); })
      .finally(() => {
        inflight.delete(tag);
        for (const ft of entry.flushTags) sendFrame(Tflush + 1, ft, new W());
      });
  }

  async function dispatch(type, r, reply, err) {
    const getf = (fid) => fids.get(fid);
    switch (type) {
      case Tversion: {
        const m = r.u32(), ver = r.str();
        fids.clear();
        msize = Math.min(m, MAXMSIZE);
        const ok = ver.includes("9P2000.L");
        return reply(new W().u32(msize).str(ok ? "9P2000.L" : "unknown"));
      }
      case Tauth:
        return err(ERR.EOPNOTSUPP); // no auth; client attaches with afid=NOFID
      case Tattach: {
        const fid = r.u32(); r.u32(); r.str(); const aname = r.str(); r.u32(); // afid, uname, aname, n_uname
        if (token != null && aname !== token) return err(ERR.EACCES);
        const st = statOf(ROOT);
        fids.set(fid, { path: ROOT });
        return reply(new W().qid(qidOf(ROOT, st)));
      }
      case Twalk: {
        const fid = r.u32(), newfid = r.u32(), n = r.u16();
        const names = []; for (let i = 0; i < n; i++) names.push(r.str());
        const f = getf(fid); if (!f) return err(ERR.EBADF);
        let cur = f.path; const qids = [];
        for (let i = 0; i < names.length; i++) {
          const nm = names[i];
          let np;
          if (cur === DRIVES) {
            if (nm === "." || nm === "..") np = DRIVES;
            else { const dl = nm.toUpperCase(); if (!/^[A-Z]$/.test(dl)) { if (i === 0) return err(ERR.ENOENT); break; } np = dl + ":\\"; }
          } else if (nm === "..") {
            np = ROOT === DRIVES && /^[A-Za-z]:[\\/]?$/.test(cur) ? DRIVES : path.dirname(cur);
          } else np = path.join(cur, nm);
          if (!within(ROOT, np)) { if (i === 0) return err(ERR.ENOENT); break; }
          let st; try { st = statOf(np); } catch (e) { if (i === 0) return err(errnoOf(e)); break; }
          qids.push(qidOf(np, st)); cur = np;
        }
        if (qids.length === names.length) fids.set(newfid, { path: cur }); // full walk (incl. clone n=0)
        const w = new W().u16(qids.length); for (const q of qids) w.qid(q);
        return reply(w);
      }
      case Tgetattr: {
        const fid = r.u32(); r.u64(); // request_mask (we always return the basic set)
        const f = getf(fid); if (!f) return err(ERR.EBADF);
        const st = statOf(f.path);
        const w = new W();
        w.u64(0x000007ffn);                 // valid = P9_GETATTR_BASIC
        w.qid(qidOf(f.path, st));
        w.u32(modeOf(st)).u32(0).u32(0);     // mode, uid, gid
        w.u64(st.nlink || 1).u64(0).u64(st.size); // nlink, rdev, size
        w.u64(st.blksize || 4096).u64(st.blocks || Math.ceil(st.size / 512));
        w.u64(st.atimeMs / 1000).u64((st.atimeMs % 1000) * 1e6);
        w.u64(st.mtimeMs / 1000).u64((st.mtimeMs % 1000) * 1e6);
        w.u64(st.ctimeMs / 1000).u64((st.ctimeMs % 1000) * 1e6);
        w.u64(0).u64(0).u64(0).u64(0);       // btime sec/nsec, gen, data_version
        return reply(w);
      }
      case Tsetattr: {
        const fid = r.u32(), valid = r.u32();
        r.u32(); r.u32(); r.u32(); const size = r.u64(); // mode, uid, gid (no persistent meaning on Windows)
        const atS = r.u64(); r.u64(); const mtS = r.u64(); r.u64(); // *_nsec unused
        const f = getf(fid); if (!f) return err(ERR.EBADF);
        const V = { SIZE: 8, ATIME: 16, MTIME: 32, ATIME_SET: 64, MTIME_SET: 128 };
        if (valid & V.SIZE) { if (f.fd != null) fs.ftruncateSync(f.fd, Number(size)); else fs.truncateSync(f.path, Number(size)); }
        if (valid & (V.ATIME | V.MTIME)) {
          const now = Date.now() / 1000;
          const at = valid & V.ATIME_SET ? Number(atS) : now;
          const mt = valid & V.MTIME_SET ? Number(mtS) : now;
          try { fs.utimesSync(f.path, at, mt); } catch {}
        }
        return reply(new W());
      }
      case Tlopen: {
        const fid = r.u32(), flags = r.u32();
        const f = getf(fid); if (!f) return err(ERR.EBADF);
        const st = statOf(f.path);
        if (st.isDirectory()) { f.dir = true; f.entries = null; }
        else f.fd = fs.openSync(f.path, toNodeFlags(flags));
        return reply(new W().qid(qidOf(f.path, st)).u32(0)); // iounit 0 -> use msize
      }
      case Tlcreate: {
        const fid = r.u32(), name = r.str(), flags = r.u32(), mode = r.u32(); r.u32(); // gid
        const f = getf(fid); if (!f) return err(ERR.EBADF);
        const np = path.join(f.path, name); if (!within(ROOT, np)) return err(ERR.EACCES);
        const fd = fs.openSync(np, toNodeFlags(flags) | fs.constants.O_CREAT, mode & 0o777);
        f.path = np; f.fd = fd; f.dir = false;
        return reply(new W().qid(qidOf(np, fs.fstatSync(fd))).u32(0));
      }
      case Treaddir: {
        const fid = r.u32(), offset = Number(r.u64()), count = r.u32();
        const f = getf(fid); if (!f || !f.dir) return err(ERR.EBADF);
        if (offset === 0 || !f.entries) {
          const ents = [];
          // "." and ".." are always directories — synthesize their qids without a stat.
          ents.push({ name: ".", qid: qidFor(f.path, QID_DIR), dt: 4 });
          ents.push({ name: "..", qid: qidFor(f.path === DRIVES ? DRIVES : path.dirname(f.path), QID_DIR), dt: 4 });
          if (f.path === DRIVES) {
            for (const d of listDrives()) ents.push({ name: d, qid: qidFor(d + ":\\", QID_DIR), dt: 4 });
          } else {
            // withFileTypes gives the type from the directory read itself (accurate on a Windows
            // host), so we avoid an lstat per entry — a big win for large dirs (node_modules…).
            // Async: a huge listing doesn't block the main thread.
            for (const de of await fs.promises.readdir(f.path, { withFileTypes: true })) {
              const [t, dt] = de.isDirectory() ? [QID_DIR, 4] : de.isSymbolicLink() ? [QID_SYMLINK, 10] : [QID_FILE, 8];
              ents.push({ name: de.name, qid: qidFor(path.join(f.path, de.name), t), dt });
            }
          }
          f.entries = ents;
        }
        const chunks = []; let used = 0;
        for (let i = offset; i < f.entries.length; i++) {
          const e = f.entries[i];
          const ew = new W().qid(e.qid).u64(i + 1).u8(e.dt).str(e.name);
          const eb = ew.done();
          if (used + eb.length > count) break;
          chunks.push(eb); used += eb.length;
        }
        const data = Buffer.concat(chunks);
        return reply(new W().u32(data.length).raw(data));
      }
      case Tread: {
        const fid = r.u32(), offset = Number(r.u64()), count = r.u32();
        const f = getf(fid); if (!f || f.fd == null) return err(ERR.EBADF);
        const b = Buffer.allocUnsafe(Math.min(count, msize - 11));
        const { bytesRead: n } = await readAsync(f.fd, b, 0, b.length, offset);
        return reply(new W().u32(n), b.subarray(0, n)); // payload as `extra` — no copy into W
      }
      case Twrite: {
        const fid = r.u32(), offset = Number(r.u64()), count = r.u32(), data = r.bytes(count);
        const f = getf(fid); if (!f || f.fd == null) return err(ERR.EBADF);
        const { bytesWritten: n } = await writeAsync(f.fd, data, 0, count, offset);
        return reply(new W().u32(n));
      }
      case Tclunk: {
        const fid = r.u32(), f = getf(fid);
        if (f) { if (f.fd != null) try { fs.closeSync(f.fd); } catch {} fids.delete(fid); }
        return reply(new W());
      }
      case Tremove: {
        const fid = r.u32(), f = getf(fid); if (!f) return err(ERR.EBADF);
        try {
          const st = fs.lstatSync(f.path);
          if (st.isDirectory()) fs.rmdirSync(f.path); else fs.unlinkSync(f.path);
        } finally { if (f.fd != null) try { fs.closeSync(f.fd); } catch {} fids.delete(fid); }
        return reply(new W());
      }
      case Tstatfs: {
        r.u32();
        return reply(new W().u32(0x01021997).u32(4096)
          .u64(1n << 32n).u64(1n << 31n).u64(1n << 31n) // blocks/bfree/bavail
          .u64(1n << 20n).u64(1n << 19n).u64(0n).u32(255)); // files/ffree/fsid/namelen
      }
      case Tmkdir: {
        const dfid = r.u32(), name = r.str(), mode = r.u32(); r.u32();
        const f = getf(dfid); if (!f) return err(ERR.EBADF);
        const np = path.join(f.path, name); if (!within(ROOT, np)) return err(ERR.EACCES);
        fs.mkdirSync(np, mode & 0o777);
        return reply(new W().qid(qidOf(np, fs.lstatSync(np))));
      }
      case Trename: {
        const fid = r.u32(), dfid = r.u32(), name = r.str();
        const f = getf(fid), d = getf(dfid); if (!f || !d) return err(ERR.EBADF);
        const np = path.join(d.path, name); if (!within(ROOT, np)) return err(ERR.EACCES);
        fs.renameSync(f.path, np); f.path = np;
        return reply(new W());
      }
      case Trenameat: {
        const od = r.u32(), oldn = r.str(), nd = r.u32(), newn = r.str();
        const o = getf(od), n = getf(nd); if (!o || !n) return err(ERR.EBADF);
        const op = path.join(o.path, oldn), np = path.join(n.path, newn);
        if (!within(ROOT, op) || !within(ROOT, np)) return err(ERR.EACCES);
        fs.renameSync(op, np);
        return reply(new W());
      }
      case Tunlinkat: {
        const dfid = r.u32(), name = r.str(); r.u32(); // flags (AT_REMOVEDIR handled by lstat)
        const f = getf(dfid); if (!f) return err(ERR.EBADF);
        const np = path.join(f.path, name); if (!within(ROOT, np)) return err(ERR.EACCES);
        const st = fs.lstatSync(np);
        if (st.isDirectory()) fs.rmdirSync(np); else fs.unlinkSync(np);
        return reply(new W());
      }
      case Treadlink: {
        const f = getf(r.u32()); if (!f) return err(ERR.EBADF);
        return reply(new W().str(fs.readlinkSync(f.path).split(path.sep).join("/")));
      }
      case Tsymlink: {
        const fid = r.u32(), name = r.str(), tgt = r.str(); r.u32();
        const f = getf(fid); if (!f) return err(ERR.EBADF);
        const np = path.join(f.path, name); if (!within(ROOT, np)) return err(ERR.EACCES);
        fs.symlinkSync(tgt, np); // may EPERM on Windows without privilege — surfaced as errno
        return reply(new W().qid(qidOf(np, fs.lstatSync(np))));
      }
      case Tlink: {
        const dfid = r.u32(), fid = r.u32(), name = r.str();
        const d = getf(dfid), f = getf(fid); if (!d || !f) return err(ERR.EBADF);
        const np = path.join(d.path, name); if (!within(ROOT, np)) return err(ERR.EACCES);
        fs.linkSync(f.path, np);
        return reply(new W());
      }
      case Tfsync: {
        const f = getf(r.u32());
        if (f && f.fd != null) await fsyncAsync(f.fd).catch(() => {});
        return reply(new W());
      }
      case Tlock:
        return reply(new W().u8(0)); // P9_LOCK_SUCCESS — advisory locks are host-local no-ops
      case Tgetlock: {
        r.u32(); r.u8(); const start = r.u64(), len = r.u64(), proc = r.u32(), cid = r.str();
        return reply(new W().u8(2).u64(start).u64(len).u32(proc).str(cid)); // F_UNLCK
      }
      case Txattrwalk:
        return err(ERR.ENODATA); // no xattrs
      default:
        return err(ERR.EOPNOTSUPP);
    }
  }
}
