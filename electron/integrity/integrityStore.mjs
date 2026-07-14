/**
 * 聊天完整性 & 本地加密（主进程）。
 *
 * 三件事：
 *  1) 本地加密：用 AES-256-GCM 加密「对话内容」落盘（conversationStore 透明调用本模块的
 *     encryptJson / decryptEnvelope）。主密钥（32B 随机）由操作系统凭据库保护：
 *     Windows DPAPI / macOS Keychain / Linux Secret Service —— 经 Electron safeStorage 封装。
 *  2) 设备标识 deviceId：首次启动生成一次并持久化，之后每台设备稳定不变（归属标识，非鉴权）。
 *  3) 完整性元数据 sidecar：每个会话一份 <chatId>.json（仅存 version/hash/signature 等，
 *     不含正文），供启动批量对账时「只读元数据、不解密正文」。
 *
 * 密钥/密文永不出本机；服务端只拿到前端算好的 hash 与它下发的 signature。
 * 详见 docs/chat.md、docs/chat-integrity-frontend-zh.md。
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

// ── 路径布局（userData/agent/integrity 下）──────────────────────────────────────
const rootDir = () => path.join(app.getPath("userData"), "agent", "integrity");
const keyFile = () => path.join(rootDir(), "master.key.json");
const deviceFile = () => path.join(rootDir(), "device.json");
const metaDir = () => path.join(rootDir(), "meta");
/** 仅允许安全字符，防止路径穿越（与 conversationStore.safeId 对齐）。 */
const safeId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
const metaFile = (id) => path.join(metaDir(), `${safeId(id)}.json`);

const ENVELOPE_ALG = "AES-256-GCM";

// ── 主密钥与加密可用性（惰性、幂等初始化）───────────────────────────────────────
let MASTER_KEY = null; // Buffer(32) —— 仅内存
/** "keychain"：主密钥由 OS 凭据库封装；"plain"：凭据库不可用，主密钥明文落盘（降级）。 */
let ENCRYPTION_MODE = null;

function ensureDirSync() {
  fs.mkdirSync(metaDir(), { recursive: true });
}

/**
 * 初始化主密钥（幂等）。必须在 app ready 后调用（safeStorage 依赖之）。
 * 首次：生成 32B 随机密钥；能用凭据库就封装后落盘，否则明文落盘并降级。
 * 后续：读取并（按需）解封装恢复到内存。
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
        // key 字段是 safeStorage 封装后的密文（base64）。
        const wrapped = Buffer.from(String(rec.key), "base64");
        const b64 = safeStorage.decryptString(wrapped); // -> base64 的原始密钥
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
          "[integrity] OS 凭据库不可用（Linux 无 Secret Service？），主密钥以明文落盘（降级）。",
        );
      }
    }
  } catch (e) {
    // 任何失败都不能拖垮应用：放弃加密，走明文存储（读路径仍兼容）。
    console.error("[integrity] 初始化主密钥失败，加密已禁用：", e);
    MASTER_KEY = null;
    ENCRYPTION_MODE = "disabled";
  }
  return { mode: ENCRYPTION_MODE };
}

function writeKeyFile(rec) {
  // 尽量收紧权限（POSIX 0600；Windows 上 mode 基本被忽略，靠 DPAPI 封装保护）。
  fs.writeFileSync(keyFile(), JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
}

/** 是否已启用加密（keychain 或 plain 都算启用；disabled 表示不加密）。 */
export function isEncryptionEnabled() {
  if (!ENCRYPTION_MODE) initIntegrity();
  return !!MASTER_KEY && ENCRYPTION_MODE !== "disabled";
}

export function encryptionStatus() {
  if (!ENCRYPTION_MODE) initIntegrity();
  return { enabled: isEncryptionEnabled(), mode: ENCRYPTION_MODE };
}

// ── AES-256-GCM 信封 ───────────────────────────────────────────────────────────
/** 判断一个 JSON 对象是否为本模块的加密信封。 */
export function isEnvelope(obj) {
  return !!obj && typeof obj === "object" && obj.alg === ENVELOPE_ALG && typeof obj.ciphertext === "string";
}

/** 把任意可序列化对象加密成信封 { v, alg, iv, authTag, ciphertext }（均 base64）。 */
export function encryptJson(value) {
  if (!isEncryptionEnabled()) return null;
  const iv = randomBytes(12); // GCM 推荐 96-bit nonce
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

/** 解密信封，返回原对象。密钥缺失 / 篡改（GCM tag 不符）会抛错。 */
export function decryptEnvelope(env) {
  if (!MASTER_KEY) throw new Error("加密密钥不可用，无法解密");
  const iv = Buffer.from(env.iv, "base64");
  const decipher = createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString("utf8"));
}

/**
 * 为 SQLCipher（记忆库整库加密）派生一个独立的 32B 原始密钥，返回 hex 字符串。
 * 用 HKDF 从主密钥派生，与 encryptJson 直接使用主密钥的用途区分开（同一主密钥不复用于两处）。
 * 加密不可用（disabled）时返回 null —— 调用方应据此以「明文库」降级。
 */
export function getSqlCipherKey() {
  if (!isEncryptionEnabled()) return null;
  const info = Buffer.from("operease-memory-sqlcipher-v1");
  const derived = hkdfSync("sha256", MASTER_KEY, Buffer.alloc(0), info, 32);
  return Buffer.from(derived).toString("hex");
}

// ── 设备标识 ────────────────────────────────────────────────────────────────────
/** 取（或首次生成并持久化）稳定的 deviceId。 */
export function getDeviceId() {
  ensureDirSync();
  try {
    const rec = JSON.parse(fs.readFileSync(deviceFile(), "utf8"));
    if (rec && typeof rec.deviceId === "string" && rec.deviceId) return rec.deviceId;
  } catch {
    /* 不存在 → 生成 */
  }
  const deviceId = randomUUID();
  try {
    fs.writeFileSync(deviceFile(), JSON.stringify({ v: 1, deviceId }), "utf8");
  } catch (e) {
    console.error("[integrity] 持久化 deviceId 失败：", e);
  }
  return deviceId;
}

// ── 完整性元数据 sidecar（明文；仅 hash/签名/版本，无正文）─────────────────────────
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
    console.error("[integrity] saveMeta 失败：", e);
    return false;
  }
}

export async function deleteMeta(chatId) {
  try {
    await fsp.rm(metaFile(chatId), { force: true });
    return true;
  } catch (e) {
    console.error("[integrity] deleteMeta 失败：", e);
    return false;
  }
}

/** 读取全部 sidecar 元数据（启动批量对账用；不触碰正文）。 */
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
        /* 跳过坏文件 */
      }
    }
    return out;
  } catch {
    return [];
  }
}
