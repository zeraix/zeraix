/**
 * 生成 electron/services/google-defaults.json（gitignored）：把本机 .env* 里的 Google OAuth
 * 凭据写入一个随包分发的 JSON，供打包后的主进程作为「最后兜底」读取。
 *
 * 为什么需要：主进程只在 dev（未打包）时经 loadEnv 从 .env* 灌入 process.env；打包后 .env* 不随包，
 * 于是 process.env.GOOGLE_OAUTH_CLIENT_ID 恒空，Google 登录报「未配置 client_id」。此脚本在构建前
 * 把凭据落成 JSON 打进包体（electron-builder 的 files 含 electron/**），让打包版开箱即用。
 * 优先级仍是：环境变量 > app.config [google] > 本兜底 JSON（见 googleAuth 的 readClientConfig）。
 *
 * 安全：桌面客户端是公开客户端，真正的保护是 PKCE + 后端对 id_token 的独立校验；client_id 公开，
 * client_secret 对桌面客户端亦「非机密」。文件 gitignored，不进版本库。构建时才由本机 .env 生成。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 最小 .env 解析（与 electron/loadEnv.mjs 一致：忽略注释/空行，去成对引号）。 */
function parseEnv(content) {
  const out = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

// 按 Next 优先级读取根目录 .env*（先到者优先），再让真实环境变量覆盖。
const env = {};
for (const f of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  try {
    const c = fs.readFileSync(path.join(root, f), "utf8");
    for (const [k, v] of Object.entries(parseEnv(c))) if (env[k] === undefined) env[k] = v;
  } catch {
    /* 文件不存在：跳过 */
  }
}

const client_id = process.env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID || "";
const client_secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET || "";

const outPath = path.join(root, "electron", "services", "google-defaults.json");
fs.writeFileSync(outPath, JSON.stringify({ client_id, client_secret }, null, 2) + "\n", "utf8");
console.log(
  `[gen-google-defaults] client_id: ${client_id ? "set" : "EMPTY"}, client_secret: ${client_secret ? "set" : "EMPTY"} → ${outPath}`,
);
if (!client_id) {
  console.warn(
    "[gen-google-defaults] 警告：未从 .env* / 环境变量取到 GOOGLE_OAUTH_CLIENT_ID，打包版将缺少默认 client_id。",
  );
}
