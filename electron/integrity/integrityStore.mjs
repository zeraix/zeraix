/**
 * Chat integrity (main process).
 *
 * Two responsibilities:
 *  1) Device identifier deviceId: generated once on first launch and persisted, then stable per device
 *     thereafter (an ownership identifier, not authentication).
 *  2) Integrity metadata sidecar: one <chatId>.json per conversation (stores only version/hash/signature
 *     etc., no message body), so startup batch reconciliation can "read metadata only, never load the body".
 *
 * The server only receives the hash computed by the frontend and the signature it issues. Conversations are no
 * longer encrypted on disk; files an earlier release encrypted are read by store/legacyDecrypt.mjs, whose key file
 * still lives in this directory.
 * See docs/chat.md, docs/chat-integrity-frontend-zh.md for details.
 */
import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── Path layout (under userData/agent/integrity) ────────────────────────────────
const rootDir = () => path.join(app.getPath("userData"), "agent", "integrity");
const deviceFile = () => path.join(rootDir(), "device.json");
const metaDir = () => path.join(rootDir(), "meta");
/** Allow only safe characters to prevent path traversal (aligned with conversationStore.safeId). */
const safeId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
const metaFile = (id) => path.join(metaDir(), `${safeId(id)}.json`);

function ensureDirSync() {
  fs.mkdirSync(metaDir(), { recursive: true });
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
