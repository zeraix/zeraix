/**
 * app.config：位于可执行文件同级目录的 INI 配置文件，持久化用户在「设置」里调整的
 * [llm] / [limits] / [ui] 参数。启动时读入内存，渲染层经 IPC 读写；写入即落盘。
 *
 * 结构：{ [section]: { [key]: string } }，序列化为 INI（; 注释、[section]、key=value）。
 * 仅存字符串标量；不做转义（键名受控，值为端点 / 模型 / 密钥 / 数字，均无换行）。
 * value 内允许出现 '='（如端点带查询串）：解析时只按「第一个 =」拆分。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** 配置文件路径：优先 electron-builder 便携版目录，否则可执行文件所在目录。 */
function configPath() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
  return path.join(dir, "app.config");
}

/** 对外暴露配置文件绝对路径（供主进程「打开 app.config」用）。 */
export function getConfigPath() {
  return configPath();
}

/** 确保配置文件已在磁盘存在（不存在则按当前内存快照落盘），返回其路径。 */
export function ensureConfigFile() {
  const p = configPath();
  try {
    if (!fs.existsSync(p)) persist();
  } catch {
    /* 落盘失败不影响后续打开尝试 */
  }
  return p;
}

let cache = null; // { section: { key: value } }；null 表示尚未从磁盘读入

function parseIni(text) {
  const out = {};
  let section = "default";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!key) continue;
    (out[section] ??= {})[key] = val;
  }
  return out;
}

function serializeIni(obj) {
  const lines = [
    "; Zeraix app.config",
    "; 由「设置」自动写入，也可手动编辑（重启应用后生效）。",
    "",
  ];
  for (const section of Object.keys(obj)) {
    const entries = Object.entries(obj[section] || {});
    if (entries.length === 0) continue;
    lines.push(`[${section}]`);
    for (const [k, v] of entries) lines.push(`${k}=${v}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 读入配置到内存（幂等；文件不存在 / 读失败则视为空配置）。 */
export function loadAppConfig() {
  try {
    cache = parseIni(fs.readFileSync(configPath(), "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

function ensure() {
  if (cache === null) loadAppConfig();
  return cache;
}

/** 返回内存中的完整配置对象（供渲染层同步取初始快照）。 */
export function getAppConfig() {
  return ensure();
}

function persist() {
  try {
    fs.writeFileSync(configPath(), serializeIni(cache), "utf8");
  } catch (e) {
    console.error("[app.config] 写入失败：", e?.message || e);
  }
}

/** 设置一个键（空值 / null 则删除该键）。写入即落盘，返回最新配置对象。 */
export function setAppConfig(section, key, value) {
  const c = ensure();
  if (!section || !key) return c;
  if (value === "" || value == null) {
    if (c[section]) {
      delete c[section][key];
      if (Object.keys(c[section]).length === 0) delete c[section];
    }
  } else {
    (c[section] ??= {})[key] = String(value);
  }
  persist();
  return c;
}

/** 删除一个键。 */
export function removeAppConfig(section, key) {
  return setAppConfig(section, key, "");
}

/**
 * 确保某段包含给定键：缺失则以空串补齐并落盘。用于把「需要用户手填」的配置项
 * （如 [google] client_id）预置到 app.config —— 让用户在 dev / 打包后都能直接看到该段
 * 并填写，而不必凭空知道键名。空串值会正常序列化为 `key=`（parse/serialize round-trip
 * 安全），且被读取方（如 googleAuth）当作「未配置」。已存在的键不动（不覆盖用户值）。
 */
export function ensureAppConfigKeys(section, keys) {
  const c = ensure();
  const target = (c[section] ??= {});
  let changed = false;
  for (const key of keys) {
    if (!(key in target)) {
      target[key] = "";
      changed = true;
    }
  }
  if (changed) persist();
  return c;
}
