/**
 * 基于文件的「记忆」存储（主进程）：每条记忆 = 一个独立的 Markdown 文件。
 *
 * 无任何模型 / 数据库依赖，纯 fs 读写，轻量。文件位于 userData/memories/<id>.md，
 * 带 YAML 风格 frontmatter（title / id / created / updated），正文为记忆内容（Markdown）。
 *
 * 供 AI 通过 save_memory 工具写入；渲染层也可列出 / 删除 / 打开目录。
 */
import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 记忆目录：userData/memories。 */
function memoryDir() {
  return path.join(app.getPath("userData"), "memories");
}

function ensureDir() {
  const d = memoryDir();
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* 已存在或创建失败（写入时会再报错） */
  }
  return d;
}

/** 生成文件名安全的 slug（保留中英文与数字，其余转连字符）。 */
function slugify(s) {
  const base = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "memory";
}

/** 极简 frontmatter 解析：取首个 --- 块内的 key: value，返回 { meta, body }。 */
function parse(raw) {
  const text = String(raw ?? "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

/** frontmatter 里的单行值：去掉换行，避免破坏结构。 */
function oneLine(s) {
  return String(s ?? "").replace(/\r?\n/g, " ").trim();
}

/**
 * 保存一条记忆为独立 Markdown 文件。传入 id 且已存在则更新（保留 created）；否则新建。
 * @param {{title?:string, content?:string, id?:string}} input
 * @returns {{id:string, title:string, file:string, created:string, updated:string}}
 */
export function saveMemoryFile({ title, content, id } = {}) {
  const dir = ensureDir();
  const now = new Date().toISOString();
  const theTitle = oneLine(title) || "未命名记忆";
  const theId = (id && slugify(id)) || `${slugify(theTitle)}-${Date.now().toString(36)}`;
  const file = path.join(dir, `${theId}.md`);

  let created = now;
  try {
    if (fs.existsSync(file)) created = parse(fs.readFileSync(file, "utf8")).meta.created || now;
  } catch {
    /* 读旧文件失败则视为新建 */
  }

  const md =
    `---\n` +
    `title: ${theTitle}\n` +
    `id: ${theId}\n` +
    `created: ${created}\n` +
    `updated: ${now}\n` +
    `---\n\n` +
    `${String(content ?? "").trim()}\n`;
  fs.writeFileSync(file, md, "utf8");
  return { id: theId, title: theTitle, file, created, updated: now };
}

/** 列出全部记忆（按更新时间倒序）。 */
export function listMemoryFiles() {
  const dir = memoryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return []; // 目录不存在 → 无记忆
  }
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const { meta, body } = parse(fs.readFileSync(file, "utf8"));
      rows.push({
        id: meta.id || name.replace(/\.md$/i, ""),
        title: meta.title || "",
        content: body,
        created: meta.created || "",
        updated: meta.updated || meta.created || "",
        file,
      });
    } catch {
      /* 跳过无法读取的文件 */
    }
  }
  rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return rows;
}

/** 删除一条记忆文件。返回是否删除成功。 */
export function deleteMemoryFile(id) {
  if (!id) return false;
  const file = path.join(memoryDir(), `${slugify(id)}.md`);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从若干外部文件路径导入记忆：每个文件解析 frontmatter（有则用其 title/id），
 * 否则以文件名为标题、整篇为正文，逐个保存为独立记忆。返回导入成功的记忆列表。
 * @param {string[]} paths
 */
export function importFromPaths(paths = []) {
  const out = [];
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const { meta, body } = parse(raw);
      const base = path.basename(String(p)).replace(/\.(md|markdown|txt)$/i, "");
      const title = meta.title || base;
      const content = body || raw.trim();
      if (!content) continue; // 空文件跳过
      out.push(saveMemoryFile({ title, content, id: meta.id }));
    } catch {
      /* 跳过无法读取的文件 */
    }
  }
  return out;
}

/** 用系统文件管理器打开记忆目录（不存在则先创建）。 */
export function openMemoryDir() {
  const dir = ensureDir();
  void shell.openPath(dir);
  return dir;
}

/** 当前记忆条目数（.md 文件数）。 */
export function countMemoryFiles() {
  try {
    return fs.readdirSync(memoryDir()).filter((f) => f.toLowerCase().endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** 记忆模板文件的内容：id 随机、created/updated 为「下载时刻」。 */
function buildTemplateMarkdown() {
  const now = new Date().toISOString();
  const id = `tpl-${randomUUID()}`;
  return (
    `---\n` +
    `title: 示例记忆标题\n` +
    `id: ${id}\n` +
    `created: ${now}\n` +
    `updated: ${now}\n` +
    `---\n\n` +
    `在此填写记忆内容（Markdown）。每条记忆保存为一个独立的 .md 文件。\n\n` +
    `- title：记忆的简短标题；\n` +
    `- id：唯一标识（本模板已随机生成，导入时保留则按 id 覆盖，删除该行则导入时新建）；\n` +
    `- created / updated：时间戳（本模板取下载时刻）。\n\n` +
    `填好后可在「设置 → 记忆 → 导入」中导入。\n`
  );
}

/** 把记忆模板写入指定路径（供「下载模板」用）。返回随机生成的模板 id。 */
export function saveTemplateFile(targetPath) {
  const content = buildTemplateMarkdown();
  fs.writeFileSync(targetPath, content, "utf8");
  return content.match(/^id:\s*(.+)$/m)?.[1] ?? "";
}

// ── 极简 ZIP 打包（store 存储，无压缩，无第三方依赖）────────────────────────────
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** 用 store 方式打包若干 { name, data:Buffer } 为标准 ZIP Buffer。 */
function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // 存储（不压缩）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

/** 把所有记忆 .md 打包为 ZIP 写入指定路径。返回打包的条目数。 */
export function exportMemoriesZip(targetPath) {
  const dir = memoryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    names = [];
  }
  const entries = [];
  for (const name of names) {
    try {
      entries.push({ name, data: fs.readFileSync(path.join(dir, name)) });
    } catch {
      /* 跳过读不了的文件 */
    }
  }
  fs.writeFileSync(targetPath, zipStore(entries));
  return entries.length;
}
