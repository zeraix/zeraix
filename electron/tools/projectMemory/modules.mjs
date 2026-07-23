/**
 * Tier B — the module map.
 *
 * This is the section that makes ZERAIX.md hold architecture rather than config metadata: one
 * line per source module saying what it is responsible for. It is also the expensive one (an LLM
 * call per module), so it is the only part of the system with sub-section rebuild granularity:
 * the SECTION is the unit of document structure, the MODULE is the unit of rebuild. Unchanged
 * modules keep their previous line verbatim and cost nothing.
 *
 * Staleness for a module combines two signals:
 *   1. shape   — a deep dirshape hash, catching added / removed / renamed files
 *   2. git     — paths reported dirty by `git status`, plus paths committed since the sha this
 *                section was last built at (frontmatter `gitHead`)
 *
 * Signal 2 is what catches edits *inside* existing files, which shape alone cannot see. Note the
 * dirty-path SET is hashed rather than treated as a boolean: editing the same file twenty times
 * while you work does not change the set, so it does not re-summarise the module twenty times.
 * Outside a git repository neither committed-change detection nor dirty tracking exists, so the
 * fallback is shape plus a soft TTL.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { hash, isIgnoredEntry } from "./fingerprint.mjs";
import { gitInfo, changedSince, listTrackedFiles } from "./git.mjs";

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".rs", ".go", ".rb", ".php", ".java", ".kt", ".kts", ".scala", ".cs",
  ".swift", ".m", ".mm", ".c", ".cc", ".cpp", ".h", ".hpp", ".ex", ".exs", ".dart", ".lua",
]);

/** Container directories that are structure, not modules — descend one level when they branch. */
const WRAPPER_DIRS = new Set(["src", "lib", "libs", "packages", "apps", "crates", "cmd", "internal", "modules"]);

const SCAN_DEPTH = 4; // Depth searched when collecting a module's source files (also its shape)
const MAX_MODULES = 10; // Cap on lines in the map — it is a map, not an inventory
const MAX_FILES_PER_MODULE = 400; // Guard on the discovery walk
const WRAPPER_MIN_CHILDREN = 3; // Source-bearing subdirs needed before descending into a wrapper
const EXCERPT_FILES = 3; // Representative files sent to the model per module
const EXCERPT_LINES = 30;
const EXCERPT_CHARS = 800;
const LISTED_FILES = 40; // File names included in the prompt
const STALE_AFTER_DAYS = 14; // Non-git fallback only: shape cannot see in-file edits
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // How often the (expensive) staleness sweep may run

/** In-memory throttle: workdir → timestamp of the last staleness sweep. */
const lastChecked = new Map();

/**
 * Forget the throttle, forcing the next pass to sweep. For callers that know the project changed
 * underneath them (a workspace switch, an explicit re-scan) and for tests.
 */
export function resetModuleCheckThrottle(workdir) {
  if (workdir) lastChecked.delete(workdir);
  else lastChecked.clear();
}

/** Recursively collect source-file paths (relative to `rel`), bounded in depth and count. */
async function collectSourceFiles(workdir, rel, maxDepth = SCAN_DEPTH) {
  const out = [];
  async function walk(absDir, relDir, depth) {
    if (out.length >= MAX_FILES_PER_MODULE) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_MODULE) return;
      if (isIgnoredEntry(e.name)) continue;
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth > 1) await walk(path.join(absDir, e.name), childRel, depth - 1);
      } else if (SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) {
        out.push(childRel);
      }
    }
  }
  await walk(path.join(workdir, rel), "", maxDepth);
  return out;
}

/**
 * Split a wrapper's file list into per-subdirectory buckets, reusing the single walk already done
 * rather than re-scanning each child. Files sitting directly in the wrapper are ignored — they
 * belong to no child module.
 */
function bucketByFirstSegment(files) {
  const buckets = new Map();
  for (const f of files) {
    const i = f.indexOf("/");
    if (i < 0) continue;
    const seg = f.slice(0, i);
    if (!buckets.has(seg)) buckets.set(seg, []);
    buckets.get(seg).push(f.slice(i + 1));
  }
  return buckets;
}

/** Whether a repo-relative path is source we care about, at a depth the walk would also reach. */
function isModuleSource(segs) {
  if (segs.length < 2 || segs.length > SCAN_DEPTH + 1) return false;
  if (segs[0].startsWith(".")) return false;
  if (segs.some((s) => isIgnoredEntry(s))) return false;
  return SOURCE_EXTS.has(path.extname(segs[segs.length - 1]).toLowerCase());
}

/** Group an already-known path list (from git) into top-level directory → relative file paths. */
function groupKnownFiles(paths) {
  const top = new Map();
  for (const p of paths) {
    const segs = p.split("/");
    if (!isModuleSource(segs)) continue;
    const name = segs[0];
    if (!top.has(name)) top.set(name, []);
    const bucket = top.get(name);
    if (bucket.length < MAX_FILES_PER_MODULE) bucket.push(segs.slice(1).join("/"));
  }
  return top;
}

/** Filesystem fallback: one walk per top-level directory. */
async function walkTopLevel(workdir) {
  let entries;
  try {
    entries = await fs.readdir(workdir, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const top = new Map();
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || isIgnoredEntry(e.name)) continue;
    top.set(e.name, await collectSourceFiles(workdir, e.name));
  }
  return top;
}

/**
 * Pick the directories worth a line in the map: top-level dirs containing source, with container
 * directories (src/, packages/, …) expanded one level so a monorepo does not collapse to a single
 * uninformative "src/" entry.
 *
 * Dot-directories are excluded wholesale. `.github`, `.claude`, `.cursor` and friends do hold
 * files with source extensions, but they configure the tooling around the project rather than
 * being part of it — they are not what someone means by "which module do I open?".
 *
 * Exactly one directory walk happens per top-level entry; both the wrapper split and the module
 * shape hash are derived from its result. This runs on every pass, so it is on the hot path.
 */
export async function discoverModules(workdir, knownFiles = null) {
  const topLevel = knownFiles ? groupKnownFiles(knownFiles) : await walkTopLevel(workdir);

  const found = [];
  for (const [name, files] of topLevel) {
    if (!files.length) continue;
    if (WRAPPER_DIRS.has(name.toLowerCase())) {
      const buckets = bucketByFirstSegment(files);
      if (buckets.size >= WRAPPER_MIN_CHILDREN) {
        for (const [seg, kidFiles] of buckets) found.push({ rel: `${name}/${seg}`, files: kidFiles });
        continue;
      }
    }
    found.push({ rel: name, files });
  }

  // Rank by source weight so the cap keeps the parts of the tree that matter, then restore
  // alphabetical order so the rendered map is stable between runs.
  return found
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, MAX_MODULES)
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── Persisted per-module state (marker attribute `mods=`) ────────────────────

/** "electron/tools:a1b2c3,src/lib:d4e5f6" → Map. */
export function parseModsAttr(raw) {
  const map = new Map();
  if (!raw || typeof raw !== "string") return map;
  for (const pair of raw.split(",")) {
    const i = pair.lastIndexOf(":");
    if (i > 0) map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return map;
}

function serialiseModsAttr(map) {
  return [...map.entries()]
    .filter(([rel]) => !rel.includes(",") && !rel.includes(":")) // unrepresentable → treat as always-stale
    .map(([rel, fp]) => `${rel}:${fp}`)
    .join(",");
}

/** "electron,src/lib" → Set. Modules whose description was authored, not generated. */
export function parsePins(raw) {
  return new Set(String(raw || "").split(",").filter(Boolean));
}

export function serialisePins(pins) {
  return [...pins].filter((p) => !p.includes(",")).sort().join(",");
}

/** Recover the previous per-module descriptions so unchanged modules keep their line for free. */
export function parseModuleLines(body) {
  const map = new Map();
  for (const line of String(body || "").split("\n")) {
    const m = line.match(/^-\s+`([^`]+?)\/?`\s+—\s+(.*)$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

function ttlExpired(built) {
  if (!built) return true;
  const t = Date.parse(built);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

// ── Summarisation ────────────────────────────────────────────────────────────

/** Rank files so the excerpt shows entry points rather than whatever sorts first. */
function rankFiles(files) {
  const score = (f) => {
    const base = path.basename(f).toLowerCase();
    let s = f.split("/").length * 2; // shallower is more likely to be the entry point
    if (/^(index|main|mod|app|entry|init)\./.test(base)) s -= 10;
    return s;
  };
  return [...files].sort((a, b) => score(a) - score(b));
}

/** First lines of a file, capped — enough for a header comment or the import block. */
async function excerpt(abs) {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null;
    return buf.toString("utf8").split("\n").slice(0, EXCERPT_LINES).join("\n").slice(0, EXCERPT_CHARS);
  } catch {
    return null;
  }
}

/** One sentence describing what a module is responsible for. Throws on LLM failure. */
async function summariseModule(ctx, mod) {
  const ranked = rankFiles(mod.files);
  const parts = [];
  for (const rel of ranked.slice(0, EXCERPT_FILES)) {
    const text = await excerpt(path.join(ctx.workdir, mod.rel, rel));
    if (text) parts.push(`--- ${mod.rel}/${rel} ---\n${text}`);
  }

  const listing = ranked.slice(0, LISTED_FILES).join("\n");
  const more = mod.files.length > LISTED_FILES ? `\n… and ${mod.files.length - LISTED_FILES} more files` : "";

  const text = await ctx.llm.chat(
    [
      {
        role: "system",
        content:
          "You describe one directory of a codebase for a navigation map. Given its file listing and " +
          "a few file excerpts, reply with ONE sentence (at most 110 characters) saying what this " +
          "directory is responsible for, and name its main entry file if there is an obvious one. " +
          "Write for a developer deciding whether to open it. Do not restate the directory path, do " +
          "not start with 'This directory', do not use a trailing period, and output nothing but the " +
          "sentence itself, in English.",
      },
      {
        role: "user",
        content: `Directory: ${mod.rel}/\n\nFiles (${mod.files.length}):\n${listing}${more}\n\n${parts.join("\n\n")}`,
      },
    ],
    { temperature: 0.2, maxTokens: 120 },
  );

  return String(text)
    .replace(/\s+/g, " ")
    .replace(/^[-*`\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 160)
    .trim();
}

// ── The section builder ──────────────────────────────────────────────────────

/**
 * Build (or incrementally update) the module map.
 * Returns the standard builder shape plus `attrs` (per-module state) and `meta` (the git baseline).
 */
export async function buildModuleMap(ctx) {
  // Throttle: detecting in-file edits across a whole project means inspecting every source file,
  // and there is no cheap way to do that — on a Windows drive mounted into WSL, `git status` and a
  // raw stat sweep both cost seconds, because per-file I/O on drvfs is ~5 ms. So the check is rate
  // limited rather than made fast. Between checks the section returns its previous body byte for
  // byte, which the caller treats as no change: no subprocesses, no write, nothing.
  //
  // The throttle lives in memory, not in the document, so it costs no file churn; a restart simply
  // pays for one check. `refresh: true` always bypasses it.
  // Work already known to be outstanding (modules deferred by the LLM budget, or lost to an
  // outage) is never throttled — that would leave "(not yet summarised)" lines sitting in the map
  // for ten minutes when the very next pass could finish them.
  const now = Date.now();
  const last = lastChecked.get(ctx.workdir) ?? 0;
  const pending = Boolean(ctx.previous?.attrs?.stale);
  if (ctx.previous && !pending && ctx.mode !== "full" && now - last < CHECK_INTERVAL_MS) {
    return { body: ctx.previous.body, attrs: { ...ctx.previous.attrs } };
  }
  lastChecked.set(ctx.workdir, now);

  const git = await gitInfo(ctx.workdir);

  // Inside a repository the file list comes from the index (plus untracked paths from `status`),
  // which is both far cheaper than walking and correctly .gitignore-aware.
  let knownFiles = null;
  if (git.isRepo) {
    const tracked = await listTrackedFiles(ctx.workdir);
    if (tracked) knownFiles = [...new Set([...tracked, ...git.dirty])];
  }

  const mods = await discoverModules(ctx.workdir, knownFiles);
  if (!mods.length) return null; // nothing source-like → the section does not apply

  const storedHead = ctx.meta?.gitHead || null;
  const storedFps = parseModsAttr(ctx.previous?.attrs?.mods);
  const pins = parsePins(ctx.previous?.attrs?.pins);
  const lines = parseModuleLines(ctx.previous?.body);

  // Which modules did commits touch since this section was last built? null = unknowable
  // (no baseline, or a rewritten history) → treat every module as stale rather than risk lying.
  const changedPaths = git.isRepo ? await changedSince(ctx.workdir, storedHead) : [];
  const unknownHistory = git.isRepo && storedHead && changedPaths === null;
  const under = (p, rel) => p === rel || p.startsWith(`${rel}/`);

  const fps = new Map();
  const stale = [];
  for (const mod of mods) {
    // Shape comes from the file list discovery already produced — walking the module again just
    // to hash the same names would triple the cost of a pass that usually changes nothing.
    const shape = hash([...mod.files].sort().join("\n"));
    const dirty = git.dirty.filter((p) => under(p, mod.rel)).sort();
    fps.set(mod.rel, hash(`${shape}|${dirty.join(",")}`));

    // A pinned module was described by someone who actually read the code. Regenerating it from
    // file names would be a downgrade, so it is never stale — not even under `refresh: true`.
    if (pins.has(mod.rel) && lines.has(mod.rel)) continue;

    const committed = (changedPaths || []).some((p) => under(p, mod.rel));
    const isStale =
      !lines.has(mod.rel) ||
      storedFps.get(mod.rel) !== fps.get(mod.rel) ||
      committed ||
      unknownHistory ||
      (!git.isRepo && ttlExpired(ctx.previous?.attrs?.built));
    if (isStale) stale.push(mod);
  }

  // Spend the LLM budget; anything left over keeps its previous line and is retried next pass.
  const deferred = [];
  const rebuilt = [];
  for (const mod of stale) {
    if (!ctx.budget.take()) {
      deferred.push(mod.rel);
      continue;
    }
    try {
      lines.set(mod.rel, await summariseModule(ctx, mod));
      rebuilt.push(mod.rel);
    } catch {
      deferred.push(mod.rel); // LLM failure: keep the old line, retry later
    }
  }

  // Forget modules that no longer exist.
  for (const rel of [...lines.keys()]) {
    if (!mods.some((m) => m.rel === rel)) lines.delete(rel);
  }

  // Deferred modules keep their PREVIOUS fingerprint so they still read as stale next pass;
  // recording the current one would silently mark unsummarised work as done.
  const outFps = new Map();
  for (const mod of mods) {
    const isDeferred = deferred.includes(mod.rel);
    const keep = isDeferred ? storedFps.get(mod.rel) : fps.get(mod.rel);
    if (keep) outFps.set(mod.rel, keep);
  }

  const body = [
    "## Module Map",
    ...mods.map((m) => `- \`${m.rel}/\` — ${lines.get(m.rel) || "(not yet summarised)"}`),
  ].join("\n");

  // Only advance the git baseline when every stale module was actually rebuilt — otherwise the
  // deferred ones would fall into the gap between the old and new sha and never be revisited.
  const head = deferred.length ? storedHead : git.head;
  // Forget pins for modules that no longer exist, but otherwise carry them through untouched.
  const livePins = new Set([...pins].filter((p) => mods.some((m) => m.rel === p)));
  const attrs = { mods: serialiseModsAttr(outFps) };
  if (livePins.size) attrs.pins = serialisePins(livePins);
  if (rebuilt.length || !ctx.previous) attrs.built = new Date().toISOString().slice(0, 10);
  else if (ctx.previous?.attrs?.built) attrs.built = ctx.previous.attrs.built;
  if (deferred.length) attrs.stale = "deferred";

  return {
    body,
    attrs,
    meta: head ? { gitHead: head } : {},
    deferred,
    rebuiltUnits: rebuilt,
  };
}
