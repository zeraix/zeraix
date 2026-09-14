/**
 * Read-only decoder for conversation files that releases up to v2.1.0 wrote encrypted (main process).
 *
 * Those releases stored each project document as an AES-256-GCM JSON envelope and each blob as raw AES-GCM bytes
 * (.enc), under a master key in userData/agent/integrity/master.key.json (wrapped by safeStorage when the OS
 * credential store was available). Nothing is encrypted any more: conversationStore opens such a file through this
 * module, and its next save of that project writes plaintext in its place. No key is created here and nothing here
 * writes.
 *
 * Delete this module and its call sites in conversationStore once no supported install can still hold an encrypted
 * file. Until then master.key.json must stay where it is: without it those files cannot be read.
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createDecipheriv } from "node:crypto";

const keyFile = () => path.join(app.getPath("userData"), "agent", "integrity", "master.key.json");

let KEY = null; // Buffer(32) once found; a failed lookup is not cached, so a briefly locked keychain is retried

function legacyKey() {
  if (KEY) return KEY;
  try {
    const rec = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
    // "keychain": the key field is the safeStorage-wrapped base64 of the key; any other mode stored it directly.
    const b64 = rec?.mode === "keychain" ? safeStorage.decryptString(Buffer.from(String(rec.key), "base64")) : String(rec.key);
    KEY = Buffer.from(b64, "base64");
  } catch (e) {
    throw new Error(`the key for conversations encrypted by an earlier release is unavailable: ${e?.message ?? e}`);
  }
  return KEY;
}

/** Whether a parsed project document is the envelope an earlier release wrote. */
export function isLegacyEnvelope(obj) {
  return !!obj && typeof obj === "object" && obj.alg === "AES-256-GCM" && typeof obj.ciphertext === "string";
}

/** The document inside an envelope. Throws when the key is unavailable or the tag does not match. */
export function decryptLegacyEnvelope(env) {
  const decipher = createDecipheriv("aes-256-gcm", legacyKey(), Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

/** magic "ZXB1" (4) | iv (12) | auth tag (16) | ciphertext */
const BYTES_MAGIC = Buffer.from("ZXB1", "latin1");
const BYTES_HEADER = 4 + 12 + 16;

/** The plaintext of an encrypted blob. Throws like decryptLegacyEnvelope, or when the bytes are not such a blob. */
export function decryptLegacyBytes(buf) {
  if (buf.length < BYTES_HEADER || !buf.subarray(0, 4).equals(BYTES_MAGIC)) throw new Error("not an encrypted blob");
  const decipher = createDecipheriv("aes-256-gcm", legacyKey(), buf.subarray(4, 16));
  decipher.setAuthTag(buf.subarray(16, BYTES_HEADER));
  const body = decipher.update(buf.subarray(BYTES_HEADER));
  // GCM is a stream mode: final() verifies the tag and yields nothing, and concatenating an empty tail would copy
  // the whole plaintext once more — 200 MB, for a 200 MB blob.
  const tail = decipher.final();
  return tail.length ? Buffer.concat([body, tail]) : body;
}
