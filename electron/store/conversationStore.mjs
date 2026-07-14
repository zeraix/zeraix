/**
 * 对话 / 项目记录的本地持久化（主进程）：按项目分文件 + 索引。
 *
 * 布局（位于「存储目录」STORE_DIR 下，默认 userData/agent）：
 *   index.json                      —— 项目元数据数组 { projects: [...] }
 *   conversations/<projectId>.json  —— 单个项目的对话 { conversations: [...] }
 * 用户可在设置里改存储目录，所选目录记录于 userData/agent/store-config.json（固定位置）。
 *
 * 兼容：若 index.json 不存在但旧版单文件 conversations.json 存在，则按「工作目录+模式」
 * 重新分组迁移成新布局（不删除旧文件，作备份）。读失败一律回退为空，不抛异常。
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

let STORE_DIR = null; // 当前存储目录（惰性初始化）

function defaultDir() {
  return path.join(app.getPath("userData"), "agent");
}
function configPath() {
  return path.join(app.getPath("userData"), "agent", "store-config.json");
}
const indexFile = () => path.join(STORE_DIR, "index.json");
const convDir = () => path.join(STORE_DIR, "conversations");
/** 仅允许安全字符的项目 id，防止路径穿越。 */
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

/** 惰性初始化 STORE_DIR（读配置），并按需迁移旧单文件。 */
function ensureInit() {
  if (STORE_DIR) return;
  STORE_DIR = defaultDir();
  try {
    const cfg = JSON.parse(fssync.readFileSync(configPath(), "utf8"));
    if (cfg && typeof cfg.dir === "string" && cfg.dir) STORE_DIR = cfg.dir;
  } catch {
    /* 无配置 → 默认 */
  }
  migrateIfNeeded();
}

/** 旧版 conversations.json → 新布局（按 工作目录+模式 重新分组）。 */
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
          name: wd ? path.basename(wd) : "默认项目",
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

// ── 路径 ────────────────────────────────────────────────────────────────────
export function getStorePath() {
  ensureInit();
  return STORE_DIR;
}

/** 设置存储目录：迁移现有数据（新目录无 index 时）并持久化配置，返回新目录。 */
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

// ── 索引 / 项目 ──────────────────────────────────────────────────────────────
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
    // 加密信封 → 解密取回 { conversations }；旧版明文 → 原样读取（惰性迁移：下次写入即加密）。
    const data = isEnvelope(raw) ? decryptEnvelope(raw) : raw;
    return { conversations: Array.isArray(data?.conversations) ? data.conversations : [] };
  } catch (e) {
    // 文件缺失属正常；解密失败（密钥缺失 / 被篡改）也回退为空，绝不抛出拖垮加载。
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
    // 加密可用则落密文信封；否则明文（降级 / 未初始化）。读路径两者都兼容。
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
