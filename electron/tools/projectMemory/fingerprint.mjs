/**
 * Input fingerprinting for project memory sections.
 *
 * Every section in the registry declares what it is a function OF (`inputs`). This module turns
 * those declarations into a short hash, so a section can be asked "did anything you depend on
 * actually move?" without rebuilding it.
 *
 * Three input kinds cover the whole registry:
 *   - "file:<relPath>"     content hash of a (small) file; "absent" when missing
 *   - "exists:<relPath>"   presence only — for things we never read, e.g. `.git`
 *   - "dirshape:<relDir>"  hash of the sorted entry NAMES to a bounded depth (never contents)
 *   - "readme"             content hash of whichever README the workdir happens to have
 *
 * Content hashing (rather than mtime) is deliberate: these are KB-sized config files, hashing is
 * effectively free, and mtime lies across git checkouts, restores and clock skew.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { MEMORY_FILE, TMP_PREFIX } from "./constants.mjs";

/**
 * Directories skipped when walking for a shape fingerprint: dependency trees, build output and
 * tool caches. This runs against whatever project the user has open, not just JS ones, so the
 * list spans ecosystems.
 *
 * Inclusion test: would a change in here ever change how someone navigates the project? Generated
 * and vendored trees never do — and they are exactly the trees that churn most, which would
 * otherwise invalidate the map constantly. Deliberately NOT skipped: `bin` (real source in Node /
 * Go / script projects), `lib`, `pkg`, `docs`, and dotfile config dirs like `.github` or
 * `.claude`, which say something real about how a project is worked on.
 */
export const SKIP_DIRS = new Set([
  // Version control / repo metadata
  ".git", ".hg", ".svn", ".jj", ".bzr",
  // JavaScript / TypeScript
  "node_modules", "bower_components", ".yarn", ".pnpm-store",
  ".next", ".nuxt", ".svelte-kit", ".astro", ".docusaurus", ".vercel", ".netlify",
  ".turbo", ".parcel-cache", ".rollup.cache", ".vite", ".angular",
  // Common build output
  "dist", "dist-electron", "build", "out", ".output", "release", "Zeraix",
  // Test / coverage reports
  "coverage", ".nyc_output", "htmlcov", ".pytest_cache", ".tox",
  // Python
  "__pycache__", ".venv", "venv", "site-packages", ".mypy_cache", ".ruff_cache", ".ipynb_checkpoints",
  // Rust / Go / PHP / Ruby (vendored or generated trees)
  "target", "vendor", ".bundle", ".cargo",
  // JVM
  ".gradle", ".m2", ".kotlin",
  // .NET — `obj` is unambiguously generated; `bin` is not, so it stays visible
  "obj",
  // Swift / Apple
  ".build", "DerivedData", "Pods", ".swiftpm",
  // Elixir / Erlang
  "_build", "deps",
  // Dart / Flutter
  ".dart_tool",
  // Infrastructure tooling
  ".terraform", ".serverless", ".pulumi",
  // Editors / IDEs / generic caches
  ".idea", ".vscode", ".vs", ".fleet", ".cache", ".sass-cache", ".gradle-cache",
]);

/** Generated directories identified by suffix rather than exact name. */
const SKIP_SUFFIXES = [".egg-info", ".dSYM", ".xcworkspace"];

/**
 * Whether a directory entry is invisible to project memory.
 *
 * Note ZERAIX.md itself (and its atomic-write temp files): the map lives in the directory it
 * describes, so counting it would make every write invalidate the very fingerprint that write
 * just recorded — the document would rebuild itself forever. Its own existence is not a fact
 * about the project.
 */
export function isIgnoredEntry(name) {
  if (name === MEMORY_FILE || name.startsWith(TMP_PREFIX)) return true;
  if (SKIP_DIRS.has(name)) return true;
  return SKIP_SUFFIXES.some((s) => name.endsWith(s));
}

/** Depth walked for a "dirshape:" fingerprint — matches the two levels the tree section renders. */
const DIRSHAPE_DEPTH = 2;
/** Above this size a file is fingerprinted by size alone rather than read (guards against lockfiles). */
const HASH_MAX_BYTES = 512 * 1024;

/** Short, stable digest. Truncated — collisions here cost a redundant rebuild, nothing more. */
export function hash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** README at the workdir root (case- / extension-insensitive) → { name, text }, or null. */
export async function findReadme(workdir) {
  let entries;
  try {
    entries = await fs.readdir(workdir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(
    (e) => e.isFile() && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name),
  );
  if (!hit) return null;
  const abs = path.join(workdir, hit.name);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > HASH_MAX_BYTES) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null; // NUL byte → binary, ignore
    return { name: hit.name, text: buf.toString("utf8") };
  } catch {
    return null;
  }
}

/** Content hash of one file; "absent" when missing, "size:<n>" when too large to be worth reading. */
async function fileFp(workdir, rel) {
  const abs = path.join(workdir, rel);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return "absent";
    if (st.size > HASH_MAX_BYTES) return `size:${st.size}`;
    return hash(await fs.readFile(abs, "utf8"));
  } catch {
    return "absent";
  }
}

/** Presence of a path, without reading it. */
async function existsFp(workdir, rel) {
  try {
    await fs.access(path.join(workdir, rel));
    return "yes";
  } catch {
    return "no";
  }
}

/**
 * Hash of a directory's SHAPE: the sorted list of entry names to DIRSHAPE_DEPTH levels, with
 * heavy directories skipped. Blind to file contents by design — this is what makes it cheap.
 */
export async function dirShapeFp(workdir, rel, maxDepth = DIRSHAPE_DEPTH) {
  const names = [];
  const root = rel && rel !== "." ? path.join(workdir, rel) : workdir;

  async function walk(absDir, relDir, depth) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (isIgnoredEntry(e.name)) continue;
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      names.push(e.isDirectory() ? `${relPath}/` : relPath);
      if (e.isDirectory() && depth > 1) {
        await walk(path.join(absDir, e.name), relPath, depth - 1);
      }
    }
  }

  await walk(root, "", maxDepth);
  return hash(names.join("\n"));
}

/** Resolve a single input spec to its fingerprint string. Unknown kinds degrade to a constant. */
async function fingerprintInput(workdir, spec) {
  const idx = spec.indexOf(":");
  const kind = idx < 0 ? spec : spec.slice(0, idx);
  const arg = idx < 0 ? "" : spec.slice(idx + 1);

  if (kind === "file") return fileFp(workdir, arg);
  if (kind === "exists") return existsFp(workdir, arg);
  if (kind === "dirshape") return dirShapeFp(workdir, arg);
  if (kind === "readme") {
    const r = await findReadme(workdir);
    return r ? hash(`${r.name}\n${r.text}`) : "absent";
  }
  return "unknown";
}

/**
 * Combined fingerprint for one section's declared inputs.
 * Never throws: a failing stat must not block a session, so it degrades to a fixed value that
 * simply compares equal on the next run (treated as "fresh" by the caller).
 */
export async function fingerprintSection(workdir, inputs = []) {
  try {
    const parts = [];
    for (const spec of inputs) {
      parts.push(`${spec}=${await fingerprintInput(workdir, spec)}`);
    }
    return hash(parts.join("|"));
  } catch {
    return "error";
  }
}
