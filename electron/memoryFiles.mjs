/**
 * File-based "memory" storage (main process): each memory = one standalone Markdown file.
 *
 * No model / database dependency, plain fs reads and writes, lightweight. Files live at userData/memories/<id>.md,
 * with YAML-style frontmatter (title / id / created / updated) and the body as the memory content (Markdown).
 *
 * Written by the AI via the save_memory tool; the renderer can also list / delete / open the directory.
 */
import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Memory directory: userData/memories. */
function memoryDir() {
  return path.join(app.getPath("userData"), "memories");
}

function ensureDir() {
  const d = memoryDir();
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* already exists, or creation failed (writing will report the error again) */
  }
  return d;
}

/** Generate a filename-safe slug (keeps Chinese/English letters and digits, converts everything else to hyphens). */
function slugify(s) {
  const base = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "memory";
}

/** Minimal frontmatter parsing: takes the key: value pairs inside the first --- block, returns { meta, body }. */
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

/** A single-line value for frontmatter: strips newlines to avoid breaking the structure. */
function oneLine(s) {
  return String(s ?? "").replace(/\r?\n/g, " ").trim();
}

/**
 * Save a memory as a standalone Markdown file. If an id is passed and already exists, update it (keeping created); otherwise create a new one.
 * @param {{title?:string, content?:string, id?:string}} input
 * @returns {{id:string, title:string, file:string, created:string, updated:string}}
 */
export function saveMemoryFile({ title, content, id } = {}) {
  const dir = ensureDir();
  const now = new Date().toISOString();
  const theTitle = oneLine(title) || "Untitled memory";
  const theId = (id && slugify(id)) || `${slugify(theTitle)}-${Date.now().toString(36)}`;
  const file = path.join(dir, `${theId}.md`);

  let created = now;
  try {
    if (fs.existsSync(file)) created = parse(fs.readFileSync(file, "utf8")).meta.created || now;
  } catch {
    /* if reading the old file fails, treat it as a new file */
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

/** List all memories (in descending order of update time). */
export function listMemoryFiles() {
  const dir = memoryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return []; // directory does not exist -> no memories
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
      /* skip files that cannot be read */
    }
  }
  rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return rows;
}

/** Delete a memory file. Returns whether the deletion succeeded. */
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
 * Import memories from several external file paths: each file's frontmatter is parsed (using its title/id if present),
 * otherwise the filename becomes the title and the whole file becomes the body, saving each as a standalone memory. Returns the list of successfully imported memories.
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
      if (!content) continue; // skip empty files
      out.push(saveMemoryFile({ title, content, id: meta.id }));
    } catch {
      /* skip files that cannot be read */
    }
  }
  return out;
}

/** Open the memory directory in the system file manager (creating it first if it does not exist). */
export function openMemoryDir() {
  const dir = ensureDir();
  void shell.openPath(dir);
  return dir;
}

/** Current number of memory entries (count of .md files). */
export function countMemoryFiles() {
  try {
    return fs.readdirSync(memoryDir()).filter((f) => f.toLowerCase().endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** Content of the memory template file: random id, created/updated set to the "download moment". */
function buildTemplateMarkdown() {
  const now = new Date().toISOString();
  const id = `tpl-${randomUUID()}`;
  return (
    `---\n` +
    `title: Example memory title\n` +
    `id: ${id}\n` +
    `created: ${now}\n` +
    `updated: ${now}\n` +
    `---\n\n` +
    `Enter the memory content here (Markdown). Each memory is saved as a standalone .md file.\n\n` +
    `- title: a short title for the memory;\n` +
    `- id: a unique identifier (this template generates one at random; keep it on import to overwrite by id, or delete this line to create a new entry on import);\n` +
    `- created / updated: timestamps (this template uses the download moment).\n\n` +
    `Once filled in, import it via "Settings -> Memory -> Import".\n`
  );
}

/** Write the memory template to the given path (used by "download template"). Returns the randomly generated template id. */
export function saveTemplateFile(targetPath) {
  const content = buildTemplateMarkdown();
  fs.writeFileSync(targetPath, content, "utf8");
  return content.match(/^id:\s*(.+)$/m)?.[1] ?? "";
}

// ── Minimal ZIP packaging (store method, no compression, no third-party dependency) ────────────────────────────
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

/** Package several { name, data:Buffer } entries into a standard ZIP Buffer using the store method. */
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
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename
    local.writeUInt16LE(0, 8); // store (no compression)
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

/** Package all memory .md files into a ZIP written to the given path. Returns the number of packaged entries. */
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
      /* skip files that cannot be read */
    }
  }
  fs.writeFileSync(targetPath, zipStore(entries));
  return entries.length;
}
