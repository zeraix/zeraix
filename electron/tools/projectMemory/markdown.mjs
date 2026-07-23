/**
 * ZERAIX.md document model: parse → merge → emit.
 *
 * The file is a sequence of nodes, each either RAW text (anything the generator did not write —
 * headings, prose, hand-authored notes) or a managed SECTION delimited by HTML-comment markers:
 *
 *   <!-- zeraix:begin id=stack fp=a1b2c3d4 -->
 *   ## Tech Stack
 *   - Next.js
 *   <!-- zeraix:end id=stack -->
 *
 * Markers are comments so they stay invisible in any Markdown renderer, and each section carries
 * its own fingerprint, so the document survives being reordered or partially hand-edited.
 *
 * Invariant: RAW nodes are preserved byte-exact, in place. Anything the registry does not know
 * about is data, not garbage.
 */
import fs from "node:fs/promises";

const BEGIN_RE = /<!--\s*zeraix:begin\s+([^>]*?)\s*-->/g;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse marker attributes: `key=value` pairs plus bare flags (`lock`). */
function parseAttrs(raw) {
  const attrs = {};
  for (const tok of String(raw).trim().split(/\s+/)) {
    if (!tok) continue;
    const i = tok.indexOf("=");
    if (i < 0) {
      // Bare flag. `zeraix:lock` is accepted as a synonym for `lock`.
      attrs[tok.replace(/^zeraix:/, "")] = true;
    } else {
      attrs[tok.slice(0, i).replace(/^zeraix:/, "")] = tok.slice(i + 1);
    }
  }
  return attrs;
}

/** Minimal flat `key: value` frontmatter, matching the convention in electron/memoryFiles.mjs. */
export function parseFrontmatter(raw) {
  const text = String(raw ?? "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

function emitFrontmatter(meta) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v).replace(/\r?\n/g, " ").trim()}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
}

/**
 * Parse a ZERAIX.md into { meta, nodes }.
 * nodes: [{ type: "raw", text } | { type: "section", id, attrs, body }]
 */
export function parseDocument(raw) {
  const { meta, body } = parseFrontmatter(raw);
  const nodes = [];
  let cursor = 0;
  let m;

  BEGIN_RE.lastIndex = 0;
  while ((m = BEGIN_RE.exec(body))) {
    const attrs = parseAttrs(m[1]);
    if (!attrs.id) continue; // malformed marker → leave it inside a raw node

    const endRe = new RegExp(`<!--\\s*zeraix:end\\s+id=${escapeRe(attrs.id)}\\s*-->`, "g");
    endRe.lastIndex = m.index + m[0].length;
    const em = endRe.exec(body);
    if (!em) continue; // unterminated → leave it inside a raw node

    if (m.index > cursor) nodes.push({ type: "raw", text: body.slice(cursor, m.index) });
    nodes.push({
      type: "section",
      id: attrs.id,
      attrs,
      body: body.slice(m.index + m[0].length, em.index).trim(),
    });
    cursor = em.index + em[0].length;
    BEGIN_RE.lastIndex = cursor;
  }
  if (cursor < body.length) nodes.push({ type: "raw", text: body.slice(cursor) });

  return { meta, nodes };
}

/** Attributes emitted first, in this order, so markers read consistently. Any other attribute a
 *  builder sets is emitted after them — the emitter must never silently drop state it does not
 *  recognise, or a builder's persisted state would vanish on the next write. */
const ATTR_ORDER = ["fp", "lock", "stale", "built"];

/** Render one managed section, markers included. */
function emitSection(node) {
  const attrs = node.attrs || {};
  const parts = [`id=${node.id}`];
  const emit = (k) => {
    const v = attrs[k];
    if (v === undefined || v === null || v === "" || v === false) return;
    parts.push(v === true ? k : `${k}=${String(v).replace(/\s+/g, "")}`);
  };
  for (const k of ATTR_ORDER) emit(k);
  for (const k of Object.keys(attrs)) {
    if (k !== "id" && !ATTR_ORDER.includes(k)) emit(k);
  }
  return `<!-- zeraix:begin ${parts.join(" ")} -->\n${node.body}\n<!-- zeraix:end id=${node.id} -->`;
}

/** Render the whole document back to Markdown. */
export function emitDocument(meta, nodes) {
  const chunks = nodes.map((n) => (n.type === "raw" ? n.text : emitSection(n)));
  // Raw nodes carry their own surrounding whitespace; sections appended after one another need a
  // blank line between them, so normalise runs of 3+ newlines down to exactly one blank line.
  const body = chunks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return `${emitFrontmatter(meta)}\n${body}\n`;
}

/** Find a managed section node by id. */
export function findSection(nodes, id) {
  return nodes.find((n) => n.type === "section" && n.id === id) || null;
}

/** Whether the document contains any managed section at all (false → pre-marker legacy file). */
export function hasManagedSections(nodes) {
  return nodes.some((n) => n.type === "section");
}

/**
 * Write atomically: temp file + rename, so a concurrent reader never observes a half-written map.
 * Falls back to a direct write if the rename is refused (Windows file locking / AV interference).
 */
export async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, file);
  } catch {
    try {
      await fs.unlink(tmp);
    } catch {
      /* temp file already gone */
    }
    await fs.writeFile(file, content, "utf8");
  }
}
