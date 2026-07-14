/**
 * 主进程环境变量加载。
 *
 * Electron 主进程（electron .）与 Next 的 dev server 是两个独立进程：Next 会自动读取
 * 项目根的 .env* 文件，但主进程不会。于是主进程里 process.env.GOOGLE_OAUTH_CLIENT_ID 等
 * 恒为空。此模块在 dev（未打包）时按 Next 的优先级把根目录 .env 文件灌入 process.env，
 * 只填充「尚未定义」的键（不覆盖真实环境变量）。打包后这些文件通常不存在，静默跳过。
 *
 * 仅做最小的 KEY=VALUE 解析（忽略注释/空行、去成对引号），不支持变量插值等高级特性。
 */
import fs from "node:fs";
import path from "node:path";

/** 解析 .env 文本为键值对。 */
function parseEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * 按 Next 优先级加载项目根的 .env 文件到 process.env（先加载者优先，不被后者覆盖）。
 * @param {string} rootDir 项目根目录（含 .env* 文件）
 * @param {string} [nodeEnv] 环境名（默认 "development"），决定 .env.<env> 文件名
 */
export function loadEnvFiles(rootDir, nodeEnv = "development") {
  // Next 优先级：.env.<env>.local > .env.local > .env.<env> > .env
  const files = [`.env.${nodeEnv}.local`, ".env.local", `.env.${nodeEnv}`, ".env"];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(rootDir, file), "utf8");
    } catch {
      continue; // 文件不存在等：跳过
    }
    for (const [k, v] of Object.entries(parseEnv(content))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
