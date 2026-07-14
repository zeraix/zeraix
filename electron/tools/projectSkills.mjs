/**
 * Project-local skill discovery (main process).
 *
 * Detects "skill" files that other tools drop into the project (Claude Code's `.claude/skills`,
 * Cursor's `.cursor/rules`, and our own `.zeraix/skills`), and remembers the user's per-project
 * decision (add / ignore) in `.zeraix/config.json` at the project root.
 *
 * config.json shape (only `skills` is used today; memories/agents/models are reserved for later):
 *   {
 *     "skills": [
 *       { "path": ".claude/skills/react.md", "source": "claude", "enabled": true },
 *       { "path": ".cursor/rules/frontend.mdc", "source": "cursor", "enabled": false }
 *     ]
 *   }
 *
 * A skill file found on disk but NOT present in config.skills is "discovered" (undecided) — the
 * UI prompts the user to Add / Ignore it. enabled:true → active, enabled:false → ignored (won't
 * prompt again). All reads/writes are confined to the working directory and the recognized skill
 * folders; arbitrary paths are rejected.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getWorkingDir } from "./aiToolkit.mjs";

/**
 * Recognized skill / instruction sources dropped by various AI tools. Each source can contribute:
 *   - `dirs`: folders scanned recursively for files matching `exts`;
 *   - `files`: specific root files taken as-is (regardless of extension) when present.
 * Add a tool here to support it — nothing else changes.
 */
const SOURCES = [
  { source: "claude", dirs: [".claude/skills"], files: ["CLAUDE.md"], exts: [".md"] },
  { source: "openai", dirs: [".codex/prompts", ".codex/skills"], files: ["AGENTS.md"], exts: [".md"] },
  { source: "cursor", dirs: [".cursor/rules"], files: [".cursorrules"], exts: [".mdc", ".md"] },
  { source: "copilot", dirs: [], files: [".github/copilot-instructions.md"], exts: [".md"] },
  { source: "windsurf", dirs: [".windsurf/rules"], files: [], exts: [".md"] },
  { source: "zeraix", dirs: [".zeraix/skills"], files: [], exts: [".md"] },
];
const CONFIG_REL = ".zeraix/config.json";
const MAX_DEPTH = 2; // e.g. .claude/skills/<name>/SKILL.md
const READ_CAP = 200 * 1024; // per-file read cap (chars) for content / meta

/** Normalize a relative path to forward slashes, no leading "./". */
function normRel(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Which source a relative path belongs to (recognized dir prefix or exact root file), or null. */
function sourceOf(relPath) {
  const rel = normRel(relPath);
  for (const s of SOURCES) {
    if ((s.files || []).some((f) => normRel(f) === rel)) return s.source;
    if ((s.dirs || []).some((d) => rel === d || rel.startsWith(`${d}/`))) return s.source;
  }
  return null;
}

/** All skill files a source contributes: recursive dir scans + any present root files (absolute paths). */
async function collectSourceFiles(workdir, src) {
  const abs = [];
  for (const d of src.dirs || []) abs.push(...(await walk(path.join(workdir, d), src.exts, MAX_DEPTH)));
  for (const f of src.files || []) {
    const fp = path.join(workdir, f);
    try {
      if ((await fs.stat(fp)).isFile()) abs.push(fp);
    } catch {
      /* file absent → skip */
    }
  }
  return abs;
}

/** Resolve a relative path strictly inside the working directory (rejects path traversal). */
function resolveInside(workdir, relPath) {
  const root = path.resolve(workdir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("path escapes the working directory");
  }
  return abs;
}

/** Recursively list files under `base` matching one of `exts`, up to `maxDepth`. Missing dir → []. */
async function walk(base, exts, maxDepth, depth = 0) {
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const abs = path.join(base, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) out.push(...(await walk(abs, exts, maxDepth, depth + 1)));
    } else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) {
      out.push(abs);
    }
  }
  return out;
}

/** Read a text file, capped; returns "" on failure. */
async function safeRead(abs) {
  try {
    const buf = await fs.readFile(abs, "utf8");
    return buf.length > READ_CAP ? buf.slice(0, READ_CAP) : buf;
  } catch {
    return "";
  }
}

/** Light frontmatter peek: pull single-line `name:` / `description:` out of a leading `---` block. */
function peekMeta(raw) {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const fm = m ? m[1] : "";
  const grab = (key) => {
    const g = new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(fm);
    return g ? g[1].trim().replace(/^['"]|['"]$/g, "") : "";
  };
  return { name: grab("name"), description: grab("description") };
}

/** Strip a leading frontmatter block, returning just the instruction body (trimmed). */
function stripFrontmatter(raw) {
  const m = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (m ? raw.slice(m[0].length) : raw).trim();
}

function basenameNoExt(rel) {
  // path.extname ignores a leading dot, so dotfiles like ".cursorrules" keep their full name.
  const base = path.basename(rel);
  return base.slice(0, base.length - path.extname(base).length);
}

/** Read `.zeraix/config.json` (tolerant): missing / invalid → {}. */
async function readConfig(workdir) {
  try {
    const raw = await fs.readFile(path.join(workdir, CONFIG_REL), "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Write `.zeraix/config.json` (creates `.zeraix/`), preserving unrelated keys already present. */
async function writeConfig(workdir, cfg) {
  await fs.mkdir(path.join(workdir, ".zeraix"), { recursive: true });
  await fs.writeFile(path.join(workdir, CONFIG_REL), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/** Config skill entries as a Map keyed by normalized path. */
function configSkillMap(cfg) {
  const list = Array.isArray(cfg.skills) ? cfg.skills : [];
  const map = new Map();
  for (const s of list) {
    if (s && typeof s.path === "string") map.set(normRel(s.path), s);
  }
  return map;
}

/**
 * Discover project skills across all recognized sources, merged with the saved decisions.
 * Returns { workdir, skills: [{ path, source, name, description, status }] }, where status is
 * "discovered" (undecided → prompt), "enabled", or "ignored".
 */
export async function discoverProjectSkills() {
  const workdir = getWorkingDir();
  const cfg = await readConfig(workdir);
  const decided = configSkillMap(cfg);

  const skills = [];
  const seen = new Set();
  for (const src of SOURCES) {
    const files = await collectSourceFiles(workdir, src);
    for (const abs of files) {
      const rel = normRel(path.relative(workdir, abs));
      if (seen.has(rel)) continue; // a file matched by multiple sources: keep the first
      seen.add(rel);
      const meta = peekMeta(await safeRead(abs));
      const entry = decided.get(rel);
      const status = entry ? (entry.enabled ? "enabled" : "ignored") : "discovered";
      skills.push({
        path: rel,
        source: src.source,
        name: meta.name || basenameNoExt(rel),
        description: meta.description || "",
        status,
      });
    }
  }
  skills.sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
  return { workdir, skills };
}

/** Record the user's decision for one discovered skill (Add → enabled:true, Ignore → false). */
export async function setProjectSkillDecision(relPath, enabled) {
  const workdir = getWorkingDir();
  const rel = normRel(relPath);
  const source = sourceOf(rel);
  if (!source) throw new Error(`not a recognized project-skill path: ${rel}`);
  resolveInside(workdir, rel); // guard traversal even though we only store the string
  const cfg = await readConfig(workdir);
  const others = (Array.isArray(cfg.skills) ? cfg.skills : []).filter(
    (s) => !(s && normRel(s.path) === rel),
  );
  cfg.skills = [...others, { path: rel, source, enabled: !!enabled }];
  await writeConfig(workdir, cfg);
  return { path: rel, source, enabled: !!enabled };
}

/** Read a project skill file's raw content (for "View Content"). Restricted to recognized skill paths. */
export async function readProjectSkillFile(relPath) {
  const workdir = getWorkingDir();
  const rel = normRel(relPath);
  if (!sourceOf(rel)) throw new Error(`not a recognized project-skill path: ${rel}`);
  return safeRead(resolveInside(workdir, rel));
}

/**
 * Load the enabled project skills with their instruction bodies, for feeding the agent.
 * Returns [{ path, source, name, description, instructions }].
 */
export async function loadEnabledProjectSkills() {
  const workdir = getWorkingDir();
  const { skills } = await discoverProjectSkills();
  const out = [];
  for (const s of skills) {
    if (s.status !== "enabled") continue;
    const raw = await safeRead(resolveInside(workdir, s.path));
    out.push({
      path: s.path,
      source: s.source,
      name: s.name,
      description: s.description,
      instructions: stripFrontmatter(raw),
    });
  }
  return out;
}
