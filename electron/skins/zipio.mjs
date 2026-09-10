/**
 * Minimal zip reading and writing for skin packages, without a dependency.
 *
 * Why not adm-zip, which is already in package.json: it is not in electron-builder's node_modules allowlist, so
 * main-process code importing it works in dev and throws in the installed app. More to the point, a skin package
 * is untrusted input, and this reader can be stricter than a general-purpose library has any reason to be:
 *
 *   - Names are never used as paths. The caller passes a filter over a flat set of expected basenames; anything
 *     nested, absolute, containing `..`, or simply unexpected is skipped before a byte of it is read.
 *   - Inflation is hard-capped with zlib's maxOutputLength, per entry and in total. A 50 KB deflate bomb that
 *     would expand to gigabytes fails at the cap instead of after it.
 *   - Declared sizes and CRCs are checked against what actually came out.
 *   - Encrypted entries, zip64 and exotic compression methods are refused rather than half-supported.
 *
 * One concession to real-world zips: a single wrapping folder (what "Compress" on a folder produces on Windows
 * and macOS) is stripped, so `my-skin/skin.json` reads the same as `skin.json`.
 */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write a STORE (uncompressed) zip. Images are already compressed; deflating them again buys nothing. */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Normalise an entry name to a flat basename, or null if it is anything but a plain file at depth 0 or 1. */
function flatName(raw) {
  const name = raw.replace(/\\/g, "/");
  if (name.endsWith("/")) return null; // directory entry
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null; // absolute
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (parts.length > 2) return null;
  return { dir: parts.length === 2 ? parts[0] : "", base: parts[parts.length - 1] };
}

/**
 * Read the entries of a zip whose basenames pass `allow`.
 *
 * @returns {Map<string, Buffer>} basename -> contents
 * @throws on anything malformed, oversized, encrypted, zip64, or using an unsupported method
 */
export function readZip(buf, { allow, maxEntryBytes, maxTotalBytes, maxEntries = 64 }) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("not a zip file");
  // End of central directory: scan back over the maximum comment length.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 is not supported");
  if (count > maxEntries) throw new Error("too many entries");
  if (cdOffset + cdSize > eocd) throw new Error("corrupt zip: central directory out of range");

  // First pass: collect acceptable entries, and learn whether everything sits under one wrapping folder.
  const found = [];
  const dirs = new Set();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip: bad central header");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString(flags & 0x0800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const flat = flatName(rawName);
    if (!flat) continue;
    if (flat.dir) dirs.add(flat.dir);
    if (!allow(flat.base)) continue;
    if (flags & 0x0001) throw new Error("encrypted zip entries are not supported");
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error("zip64 is not supported");
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method}`);
    if (size > maxEntryBytes) throw new Error(`${flat.base} is too large`);
    found.push({ ...flat, method, crc, compSize, size, localOffset });
  }
  // Mixed depths, or two different folders, is not a wrapped package: only root-level files count then.
  const wrapped = dirs.size === 1 && found.every((e) => e.dir);
  const out = new Map();
  let total = 0;
  for (const e of found) {
    if (e.dir && !wrapped) continue;
    if (out.has(e.base)) throw new Error(`duplicate entry ${e.base}`);
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) throw new Error("corrupt zip: bad local header");
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    if (start + e.compSize > buf.length) throw new Error("corrupt zip: entry out of range");
    const slice = buf.subarray(start, start + e.compSize);
    const cap = Math.min(maxEntryBytes, maxTotalBytes - total);
    if (cap <= 0) throw new Error("package is too large");
    let data;
    if (e.method === 0) {
      if (e.compSize > cap) throw new Error(`${e.base} is too large`);
      data = Buffer.from(slice);
    } else {
      try {
        data = zlib.inflateRawSync(slice, { maxOutputLength: cap });
      } catch (err) {
        throw new Error(err?.code === "ERR_BUFFER_TOO_LARGE" ? `${e.base} is too large` : `${e.base} is corrupt`);
      }
    }
    if (data.length !== e.size) throw new Error(`${e.base}: size mismatch`);
    if (crc32(data) !== e.crc) throw new Error(`${e.base}: checksum mismatch`);
    total += data.length;
    out.set(e.base, data);
  }
  return out;
}
