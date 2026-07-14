/**
 * Local persistence of conversation / project records (main process): one file per project + an index.
 *
 * Layout (under the "storage directory" STORE_DIR, default userData/agent):
 *   index.json                      -- array of project metadata { projects: [...] }
 *   conversations/<projectId>.json  -- a single project's conversations { conversations: [...] }
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
} from "../integrity/integrityStore.mjs";

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

/** Legacy conversations.json -> new layout (regrouped by working directory + mode). */
function migrateIfNeeded() {
  if (existsSync(indexFile())) return;
  const oldFile = path.join(STORE_DIR, "conversations.json");
  if (!existsSync(oldFile)) return;
  try {
    const old = JSON.parse(fssync.readFileSync(oldFile, "utf8"));
    const oldProjects = Array.isArray(old?.projects) ? old.projects : [];
    const oldConvs = Array.isArray(old?.conversations) ? old.conversations : [];
    const projWorkdir = new Map(oldProjects.map((p) => [p.id, p.workdir ?? ""]));
    const keyToProject = new Map(); // "<workdir>\0<mode>" -> project
    const byProject = new Map(); // projectId -> conversations[]
    for (const c of oldConvs) {
      const mode = c?.mode === "dev" ? "dev" : "daily";
      const wd = (c?.workdir ?? projWorkdir.get(c?.projectId) ?? "") || "";
      const key = `${wd}\x00${mode}`;
      let proj = keyToProject.get(key);
      if (!proj) {
        proj = {
          id: randomUUID(),
          name: wd ? path.basename(wd) : "Default Project",
          workdir: wd,
          mode,
          createdAt: Date.now(),
        };
        keyToProject.set(key, proj);
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
    return { conversations: Array.isArray(data?.conversations) ? data.conversations : [] };
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

export async function saveProject(projectId, conversations) {
  ensureInit();
  try {
    await fs.mkdir(convDir(), { recursive: true });
    const safe = Array.isArray(conversations) ? conversations : [];
    const payload = { conversations: safe };
    // If encryption is available, write a ciphertext envelope; otherwise plaintext (degraded / uninitialized). The read path supports both.
    const envelope = isEncryptionEnabled() ? encryptJson(payload) : null;
    const body = envelope
      ? JSON.stringify(envelope)
      : JSON.stringify(payload, null, 2);
    await fs.writeFile(convFile(projectId), body, "utf8");
    return true;
  } catch (e) {
    console.error("saveProject failed:", e);
    return false;
  }
}

export async function deleteProject(projectId) {
  ensureInit();
  try {
    await fs.rm(convFile(projectId), { force: true });
    return true;
  } catch (e) {
    console.error("deleteProject failed:", e);
    return false;
  }
}
