/**
 * Local persistence of conversation / project records (main process): one file per project + an index.
 *
 * Layout (under the "storage directory" STORE_DIR, default userData/agent):
 *   index.json                            -- array of project metadata { projects: [...] }
 *   conversations/<projectId>.json        -- a single project's conversations { conversations: [...] }
 *   conversations/<projectId>.blobs/<sha256>.txt|.enc
 *                                         -- the large strings of that project's conversations, one file each,
 *                                            referenced from the JSON (see resultBlobs.mjs); .enc when encrypted
 *                                            (raw AES-GCM bytes, not the JSON envelope: see encryptBytes)
 * The user can change the storage directory in settings; the chosen directory is recorded in userData/agent/store-config.json (a fixed location).
 *
 * Compatibility: if index.json is absent but the legacy single-file conversations.json exists, migrate it into the new
 * layout by regrouping on "working directory + mode" (the old file is not deleted, kept as a backup). A read failure always falls back to empty and does not throw.
 */
import { app } from "electron";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  encryptJson,
  decryptEnvelope,
  isEnvelope,
  isEncryptionEnabled,
  encryptBytes,
  decryptBytes,
} from "../integrity/integrityStore.mjs";
import {
  collectBlobRefs,
  detachLargeStrings,
  inlineBlobs,
  missingBlobNote,
  selectBlobsToLoad,
  unloadedBlobNote,
} from "./resultBlobs.mjs";

let STORE_DIR = null; // current storage directory (lazily initialized)

function defaultDir() {
  return path.join(app.getPath("userData"), "agent");
}
function configPath() {
  return path.join(app.getPath("userData"), "agent", "store-config.json");
}
const indexFile = () => path.join(STORE_DIR, "index.json");
const convDir = () => path.join(STORE_DIR, "conversations");
/** Allow only safe characters in the project id, to prevent path traversal. */
const safeId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
const convFile = (id) => path.join(convDir(), `${safeId(id)}.json`);
const blobDir = (id) => path.join(convDir(), `${safeId(id)}.blobs`);
const blobFile = (id, hash, encrypted) => path.join(blobDir(id), `${hash}.${encrypted ? "enc" : "txt"}`);

function existsSync(p) {
  try {
    fssync.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Lazily initialize STORE_DIR (read the config), and migrate the legacy single file if needed. */
function ensureInit() {
  if (STORE_DIR) return;
  STORE_DIR = defaultDir();
  try {
    const cfg = JSON.parse(fssync.readFileSync(configPath(), "utf8"));
    if (cfg && typeof cfg.dir === "string" && cfg.dir) STORE_DIR = cfg.dir;
  } catch {
    /* no config -> default */
  }
  migrateIfNeeded();
}

/** Legacy conversations.json -> new layout (regrouped by working directory). */
function migrateIfNeeded() {
  if (existsSync(indexFile())) return;
  const oldFile = path.join(STORE_DIR, "conversations.json");
  if (!existsSync(oldFile)) return;
  try {
    const old = JSON.parse(fssync.readFileSync(oldFile, "utf8"));
    const oldProjects = Array.isArray(old?.projects) ? old.projects : [];
    const oldConvs = Array.isArray(old?.conversations) ? old.conversations : [];
    const projWorkdir = new Map(oldProjects.map((p) => [p.id, p.workdir ?? ""]));
    // Keyed by working directory alone. It used to be "<workdir>\0<mode>", splitting one folder into a daily project and a
    // dev project; the two mode tags merged into one, so a folder is one project and this migration must not manufacture the
    // duplicate rows the sidebar would now show side by side.
    const keyToProject = new Map(); // "<workdir>" -> project
    const byProject = new Map(); // projectId -> conversations[]
    for (const c of oldConvs) {
      const wd = (c?.workdir ?? projWorkdir.get(c?.projectId) ?? "") || "";
      let proj = keyToProject.get(wd);
      if (!proj) {
        proj = {
          id: randomUUID(),
          name: wd ? path.basename(wd) : "Default Project",
          workdir: wd,
          mode: "dev",
          createdAt: Date.now(),
        };
        keyToProject.set(wd, proj);
        byProject.set(proj.id, []);
      }
      byProject.get(proj.id).push({ ...c, projectId: proj.id });
    }
    fssync.mkdirSync(convDir(), { recursive: true });
    for (const [pid, convs] of byProject) {
      fssync.writeFileSync(convFile(pid), JSON.stringify({ conversations: convs }, null, 2), "utf8");
    }
    fssync.writeFileSync(
      indexFile(),
      JSON.stringify({ projects: [...keyToProject.values()] }, null, 2),
      "utf8",
    );
  } catch (e) {
    console.error("migrate store failed:", e);
  }
}

// ── Paths ────────────────────────────────────────────────────────────────────
export function getStorePath() {
  ensureInit();
  return STORE_DIR;
}

/** Set the storage directory: migrate existing data (when the new directory has no index) and persist the config; returns the new directory. */
export async function setStorePath(dir) {
  ensureInit();
  if (!dir || typeof dir !== "string") throw new Error("invalid path");
  const newDir = path.resolve(dir);
  if (newDir === STORE_DIR) return STORE_DIR;
  try {
    if (!existsSync(path.join(newDir, "index.json"))) {
      await fs.mkdir(newDir, { recursive: true });
      if (existsSync(indexFile())) await fs.copyFile(indexFile(), path.join(newDir, "index.json"));
      if (existsSync(convDir())) {
        await fs.cp(convDir(), path.join(newDir, "conversations"), { recursive: true });
      }
    }
  } catch (e) {
    console.error("migrate store dir failed:", e);
  }
  STORE_DIR = newDir;
  try {
    const cf = configPath();
    await fs.mkdir(path.dirname(cf), { recursive: true });
    await fs.writeFile(cf, JSON.stringify({ dir: newDir }, null, 2), "utf8");
  } catch (e) {
    console.error("write store-config failed:", e);
  }
  return STORE_DIR;
}

// ── Index / projects ──────────────────────────────────────────────────────────────
export async function loadIndex() {
  ensureInit();
  try {
    const data = JSON.parse(await fs.readFile(indexFile(), "utf8"));
    return { projects: Array.isArray(data?.projects) ? data.projects : [] };
  } catch {
    return { projects: [] };
  }
}

export async function loadProject(projectId) {
  ensureInit();
  try {
    const raw = JSON.parse(await fs.readFile(convFile(projectId), "utf8"));
    // Encrypted envelope -> decrypt to retrieve { conversations }; legacy plaintext -> read as-is (lazy migration: the next write encrypts it).
    const data = isEnvelope(raw) ? decryptEnvelope(raw) : raw;
    return { conversations: Array.isArray(data?.conversations) ? await withBlobsInlined(projectId, data.conversations) : [] };
  } catch (e) {
    // A missing file is normal; a decryption failure (missing key / tampering) also falls back to empty and never throws in a way that takes down loading.
    if (e?.code !== "ENOENT") console.error("loadProject failed:", e);
    return { conversations: [] };
  }
}

export async function saveIndex(projects) {
  ensureInit();
  try {
    await fs.mkdir(STORE_DIR, { recursive: true });
    const safe = Array.isArray(projects) ? projects : [];
    await fs.writeFile(indexFile(), JSON.stringify({ projects: safe }, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("saveIndex failed:", e);
    return false;
  }
}

/**
 * One write per project at a time, and only the newest of the writes that queued up behind it.
 *
 * The renderer flushes a project 250 ms after any change and does not wait for the previous flush. Two writes
 * of the same file in flight at once could interleave, and — now that a save also sweeps blob files nothing
 * references — an older save finishing after a newer one could delete a blob the newer document depends on.
 * Serialising per project removes both; keeping only the latest queued state means a burst of changes costs
 * one extra write, not one per change.
 */
const saving = new Map(); // projectId -> Promise<boolean> of the write in progress
const queued = new Map(); // projectId -> conversations to write once the current write finishes

export function saveProject(projectId, conversations) {
  ensureInit();
  const key = safeId(projectId);
  if (saving.has(key)) {
    queued.set(key, conversations);
    return saving.get(key);
  }
  const run = (async () => {
    let ok = await writeProject(projectId, conversations);
    while (queued.has(key)) {
      const next = queued.get(key);
      queued.delete(key);
      ok = await writeProject(projectId, next);
    }
    saving.delete(key);
    return ok;
  })();
  saving.set(key, run);
  return run;
}

async function writeProject(projectId, conversations) {
  try {
    await fs.mkdir(convDir(), { recursive: true });
    const safe = Array.isArray(conversations) ? conversations : [];
    // The large strings leave the document first (resultBlobs.mjs): each is written once, under its hash, and
    // the document keeps a reference. Blobs before the document, so a document on disk never points at a file
    // that is not there yet; the sweep afterwards, so a crash in between leaves an orphan, not a dangling ref.
    const blobs = new Map();
    const payload = detachLargeStrings({ conversations: safe }, (hash, text) => blobs.set(hash, text));
    for (const [hash, text] of blobs) await writeBlob(projectId, hash, text);
    // If encryption is available, write a ciphertext envelope; otherwise plaintext (degraded / uninitialized). The read path supports both.
    const envelope = isEncryptionEnabled() ? encryptJson(payload) : null;
    const body = envelope
      ? JSON.stringify(envelope)
      : JSON.stringify(payload, null, 2);
    await writeAtomic(convFile(projectId), body);
    await sweepBlobs(projectId, collectBlobRefs(payload));
    return true;
  } catch (e) {
    console.error("saveProject failed:", e);
    return false;
  }
}

/** Write to a sibling temp file and rename over the target, so a crash mid-write leaves the old file, not half a new one. */
let tmpSeq = 0;
async function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await fs.writeFile(tmp, body, Buffer.isBuffer(body) ? undefined : "utf8");
  await fs.rename(tmp, file);
}

/**
 * Write one blob unless it is already there. Encrypted when the store is, as raw bytes (encryptBytes — the
 * JSON envelope would cost three copies of a 100 MB string); a plaintext copy left from before encryption
 * was turned on is replaced, the same lazy migration the document gets.
 */
async function writeBlob(projectId, hash, text) {
  const encrypted = isEncryptionEnabled();
  const target = blobFile(projectId, hash, encrypted);
  if (existsSync(target)) return;
  await fs.mkdir(blobDir(projectId), { recursive: true });
  await writeAtomic(target, encrypted ? encryptBytes(Buffer.from(text, "utf8")) : text);
  if (encrypted) await fs.rm(blobFile(projectId, hash, false), { force: true });
}

/** The text of one blob, or null when it is unreadable — the caller substitutes a note, never throws. */
async function readBlob(projectId, hash) {
  try {
    return decryptBytes(await fs.readFile(blobFile(projectId, hash, true))).toString("utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error("readBlob failed:", e);
      return null;
    }
  }
  try {
    return await fs.readFile(blobFile(projectId, hash, false), "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") console.error("readBlob failed:", e);
    return null;
  }
}

/**
 * Resolve the references in a loaded document: the text for blobs worth loading, a note for the rest.
 *
 * A blob over the per-blob cap, or past the project's total budget (resultBlobs.selectBlobsToLoad), is not read
 * — not decrypted, not stringified, not sent to the renderer. Its note names it, and the save path turns the note
 * back into the reference (detachLargeStrings), so the file is kept for as long as the conversation is.
 */
async function withBlobsInlined(projectId, conversations) {
  const refs = collectBlobRefs(conversations);
  if (refs.size === 0) return conversations;
  const chosen = selectBlobsToLoad(refs);
  const texts = new Map();
  for (const hash of chosen) texts.set(hash, await readBlob(projectId, hash));
  return inlineBlobs(conversations, (hash, n) =>
    chosen.has(hash) ? (texts.get(hash) ?? missingBlobNote(n)) : unloadedBlobNote(hash, n),
  );
}

/** Delete the blob files the document no longer references — a deleted conversation's results, a stray temp file. */
async function sweepBlobs(projectId, referenced) {
  let names;
  try {
    names = await fs.readdir(blobDir(projectId));
  } catch {
    return; // no blob directory: nothing to sweep
  }
  for (const name of names) {
    const hash = name.slice(0, name.indexOf("."));
    const keep = referenced.has(hash) && (name.endsWith(".txt") || name.endsWith(".enc"));
    if (!keep) await fs.rm(path.join(blobDir(projectId), name), { force: true });
  }
}

export async function deleteProject(projectId) {
  ensureInit();
  try {
    await fs.rm(convFile(projectId), { force: true });
    await fs.rm(blobDir(projectId), { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error("deleteProject failed:", e);
    return false;
  }
}
