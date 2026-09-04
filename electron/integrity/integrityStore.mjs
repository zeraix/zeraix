/**
 * Chat integrity & local encryption (main process).
 *
 * Three responsibilities:
 *  1) Local encryption: encrypt "conversation content" to disk with AES-256-GCM (conversationStore
 *     transparently calls this module's encryptJson / decryptEnvelope). The master key (32B random)
 *     is protected by the OS credential store:
 *     Windows DPAPI / macOS Keychain / Linux Secret Service -- wrapped via Electron safeStorage.
 *  2) Device identifier deviceId: generated once on first launch and persisted, then stable per device
 *     thereafter (an ownership identifier, not authentication).
 *  3) Integrity metadata sidecar: one <chatId>.json per conversation (stores only version/hash/signature
 *     etc., no message body), so startup batch reconciliation can "read metadata only, never decrypt the body".
 *
 * Keys/ciphertext never leave the local machine; the server only receives the hash computed by the
 * frontend and the signature it issues.
 * See docs/chat.md, docs/chat-integrity-frontend-zh.md for details.
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

// ── Path layout (under userData/agent/integrity) ────────────────────────────────
const rootDir = () => path.join(app.getPath("userData"), "agent", "integrity");
const keyFile = () => path.join(rootDir(), "master.key.json");
const deviceFile = () => path.join(rootDir(), "device.json");
const metaDir = () => path.join(rootDir(), "meta");
/** Allow only safe characters to prevent path traversal (aligned with conversationStore.safeId). */
const safeId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
const metaFile = (id) => path.join(metaDir(), `${safeId(id)}.json`);

const ENVELOPE_ALG = "AES-256-GCM";

// ── Master key & encryption availability (lazy, idempotent init) ─────────────────
let MASTER_KEY = null; // Buffer(32) -- in memory only
/** "keychain": master key wrapped by the OS credential store; "plain": credential store unavailable, master key written to disk in plaintext (degraded). */
let ENCRYPTION_MODE = null;

function ensureDirSync() {
  fs.mkdirSync(metaDir(), { recursive: true });
}

/**
 * Initialize the master key (idempotent). Must be called after app ready (safeStorage depends on it).
 * First time: generate a 32B random key; wrap and persist it if the credential store is available,
 * otherwise write plaintext and degrade.
 * Thereafter: read and (as needed) unwrap it back into memory.
 */
export function initIntegrity() {
  if (MASTER_KEY) return { mode: ENCRYPTION_MODE };
  ensureDirSync();
  const canKeychain = (() => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  })();

  try {
    if (fs.existsSync(keyFile())) {
      const rec = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
      if (rec?.mode === "keychain") {
        // The key field is the safeStorage-wrapped ciphertext (base64).
        const wrapped = Buffer.from(String(rec.key), "base64");
        const b64 = safeStorage.decryptString(wrapped); // -> raw key as base64
        MASTER_KEY = Buffer.from(b64, "base64");
        ENCRYPTION_MODE = "keychain";
      } else {
        MASTER_KEY = Buffer.from(String(rec.key), "base64");
        ENCRYPTION_MODE = "plain";
      }
    } else {
      MASTER_KEY = randomBytes(32);
      if (canKeychain) {
        const wrapped = safeStorage.encryptString(MASTER_KEY.toString("base64"));
        writeKeyFile({ v: 1, mode: "keychain", key: wrapped.toString("base64") });
        ENCRYPTION_MODE = "keychain";
      } else {
        writeKeyFile({ v: 1, mode: "plain", key: MASTER_KEY.toString("base64") });
        ENCRYPTION_MODE = "plain";
        console.warn(
          "[integrity] OS credential store unavailable (no Secret Service on Linux?); master key written to disk in plaintext (degraded).",
        );
      }
    }
  } catch (e) {
    // No failure may take down the app: give up encryption and fall back to plaintext storage (the read path stays compatible).
    console.error("[integrity] Failed to initialize master key; encryption disabled:", e);
    MASTER_KEY = null;
    ENCRYPTION_MODE = "disabled";
  }
  return { mode: ENCRYPTION_MODE };
}

function writeKeyFile(rec) {
  // Tighten permissions as much as possible (POSIX 0600; on Windows mode is largely ignored, protection relies on DPAPI wrapping).
  fs.writeFileSync(keyFile(), JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
}

/** Whether encryption is enabled (keychain or plain both count as enabled; disabled means no encryption). */
export function isEncryptionEnabled() {
  if (!ENCRYPTION_MODE) initIntegrity();
  return !!MASTER_KEY && ENCRYPTION_MODE !== "disabled";
}

export function encryptionStatus() {
  if (!ENCRYPTION_MODE) initIntegrity();
  return { enabled: isEncryptionEnabled(), mode: ENCRYPTION_MODE };
}

// ── AES-256-GCM envelope ─────────────────────────────────────────────────────────
/** Determine whether a JSON object is an encryption envelope produced by this module. */
export function isEnvelope(obj) {
  return !!obj && typeof obj === "object" && obj.alg === ENVELOPE_ALG && typeof obj.ciphertext === "string";
}

/** Encrypt any serializable object into an envelope { v, alg, iv, authTag, ciphertext } (all base64). */
export function encryptJson(value) {
  if (!isEncryptionEnabled()) return null;
  const iv = randomBytes(12); // GCM recommends a 96-bit nonce
  const cipher = createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const pt = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ENVELOPE_ALG,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ct.toString("base64"),
  };
}

/** Decrypt an envelope and return the original object. Throws if the key is missing or on tampering (GCM tag mismatch). */
export function decryptEnvelope(env) {
  if (!MASTER_KEY) throw new Error("Encryption key unavailable, cannot decrypt");
  const iv = Buffer.from(env.iv, "base64");
  const decipher = createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString("utf8"));
}

// ── AES-256-GCM over raw bytes, for files too large for the JSON envelope ─────────────
/**
 * A 100 MB tool result through encryptJson costs a JSON string of it, a base64 copy, and a JSON parse on the
 * way back — 1.6 s and three transient copies, measured. This is the same cipher and the same master key
 * with none of that: a fixed header, then the ciphertext of the bytes as given.
 *
 *   magic "ZXB1" (4) | iv (12) | auth tag (16) | ciphertext
 */
const BYTES_MAGIC = Buffer.from("ZXB1", "latin1");
const BYTES_HEADER = 4 + 12 + 16;

/** Encrypt a Buffer. Null when encryption is disabled, so the caller writes plaintext, as it does for the envelope. */
export function encryptBytes(plain) {
  if (!isEncryptionEnabled()) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BYTES_MAGIC, iv, cipher.getAuthTag(), ct]);
}

/** Whether a Buffer starts the way encryptBytes writes it. */
export function isEncryptedBytes(buf) {
  return Buffer.isBuffer(buf) && buf.length >= BYTES_HEADER && buf.subarray(0, 4).equals(BYTES_MAGIC);
}

/** Decrypt what encryptBytes produced. Throws on a missing key or a tag mismatch, like decryptEnvelope. */
export function decryptBytes(buf) {
  if (!MASTER_KEY) throw new Error("Encryption key unavailable, cannot decrypt");
  if (!isEncryptedBytes(buf)) throw new Error("not an encrypted byte stream");
  const decipher = createDecipheriv("aes-256-gcm", MASTER_KEY, buf.subarray(4, 16));
  decipher.setAuthTag(buf.subarray(16, BYTES_HEADER));
  return Buffer.concat([decipher.update(buf.subarray(BYTES_HEADER)), decipher.final()]);
}

/**
 * Derive a separate 32B raw key for SQLCipher (whole-database encryption of the memory store), returned as a hex string.
 * Derived from the master key via HKDF, keeping it distinct from encryptJson's direct use of the master key
 * (the same master key is not reused in two places).
 * Returns null when encryption is unavailable (disabled) -- the caller should degrade to a "plaintext database" accordingly.
 */
export function getSqlCipherKey() {
  if (!isEncryptionEnabled()) return null;
  const info = Buffer.from("operease-memory-sqlcipher-v1");
  const derived = hkdfSync("sha256", MASTER_KEY, Buffer.alloc(0), info, 32);
  return Buffer.from(derived).toString("hex");
}

// ── Device identifier ──────────────────────────────────────────────────────────
/** Get (or generate and persist on first use) a stable deviceId. */
export function getDeviceId() {
  ensureDirSync();
  try {
    const rec = JSON.parse(fs.readFileSync(deviceFile(), "utf8"));
    if (rec && typeof rec.deviceId === "string" && rec.deviceId) return rec.deviceId;
  } catch {
    /* Does not exist -> generate */
  }
  const deviceId = randomUUID();
  try {
    fs.writeFileSync(deviceFile(), JSON.stringify({ v: 1, deviceId }), "utf8");
  } catch (e) {
    console.error("[integrity] Failed to persist deviceId:", e);
  }
  return deviceId;
}

// ── Integrity metadata sidecar (plaintext; only hash/signature/version, no body) ──
export async function loadMeta(chatId) {
  try {
    const data = JSON.parse(await fsp.readFile(metaFile(chatId), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export async function saveMeta(chatId, meta) {
  try {
    await fsp.mkdir(metaDir(), { recursive: true });
    await fsp.writeFile(metaFile(chatId), JSON.stringify(meta ?? {}, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[integrity] saveMeta failed:", e);
    return false;
  }
}

export async function deleteMeta(chatId) {
  try {
    await fsp.rm(metaFile(chatId), { force: true });
    return true;
  } catch (e) {
    console.error("[integrity] deleteMeta failed:", e);
    return false;
  }
}

/** Read all sidecar metadata (for startup batch reconciliation; never touches the body). */
export async function listMeta() {
  try {
    const files = await fsp.readdir(metaDir());
    const out = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(await fsp.readFile(path.join(metaDir(), f), "utf8"));
        if (data && typeof data === "object") out.push(data);
      } catch {
        /* Skip corrupt files */
      }
    }
    return out;
  } catch {
    return [];
  }
}
