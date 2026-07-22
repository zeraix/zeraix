/**
 * Versioned workflow-definition store. See docs/automation-workflow-design.md §4.
 *
 * Layout under userData/agent/automation/workflows/<workflowId>/:
 *   meta.json     { id, currentVersion, updatedAt }
 *   v1.json       an immutable WorkflowDefinition snapshot
 *   v2.json       ...
 *
 * The design doc sketches `current -> v2` as a symlink; this uses meta.json instead, because symlink
 * creation on Windows needs elevation or developer mode. Same role, no platform tax.
 *
 * The core invariant: **an existing v<N>.json is never rewritten.** Saving always mints a new
 * version. Runs pin `definitionVersion`, so an old run can always be replayed and explained exactly
 * as it executed -- editing a workflow must not rewrite the meaning of history (§2, principle 1).
 */
import fs from "node:fs";
import path from "node:path";
import { validateDefinition } from "./schema.mjs";
import { workflowsDir } from "./storage.mjs";

const safeId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");

const dirFor = (id) => path.join(workflowsDir(), safeId(id));
const metaFile = (id) => path.join(dirFor(id), "meta.json");
const versionFile = (id, v) => path.join(dirFor(id), `v${v}.json`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write via a temp file + rename so a crash mid-write cannot leave a truncated definition behind. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** Summaries for the workflow list. Unreadable or malformed directories are skipped, never thrown. */
export function listWorkflows() {
  const root = workflowsDir();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // nothing created yet
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readJson(metaFile(entry.name));
    if (!meta?.currentVersion) continue;
    const def = readJson(versionFile(entry.name, meta.currentVersion));
    if (!def) continue;
    out.push({
      id: def.id,
      name: def.name,
      version: meta.currentVersion,
      updatedAt: meta.updatedAt ?? null,
      triggerTypes: (def.triggers ?? []).map((t) => t.type),
      nodeCount: (def.nodes ?? []).length,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Read one definition.
 * @param {string} id
 * @param {number} [version] Defaults to the current version. Runs must pass their pinned version.
 * @returns {object|null}
 */
export function getWorkflow(id, version) {
  const v = version ?? readJson(metaFile(id))?.currentVersion;
  if (!v) return null;
  return readJson(versionFile(id, v));
}

/** Current version number, or 0 when the workflow does not exist. */
export function currentVersion(id) {
  return readJson(metaFile(id))?.currentVersion ?? 0;
}

/**
 * Persist a definition as a **new version**. The caller's `version` field is ignored and replaced
 * with the next number -- callers cannot overwrite history even by mistake.
 * @param {object} def
 * @param {number} [now] Injected timestamp (tests / deterministic replay).
 * @returns {{ ok: true, version: number, definition: object } | { ok: false, errors: string[] }}
 */
export function saveWorkflow(def, now = Date.now()) {
  if (!def || typeof def !== "object") return { ok: false, errors: ["definition must be an object"] };
  const id = safeId(def.id);
  if (!id) return { ok: false, errors: ["id must match [a-zA-Z0-9_-]{1,64}"] };

  const nextVersion = currentVersion(id) + 1;
  const candidate = { ...def, id, version: nextVersion };

  // Validate the exact bytes that will be written, not the caller's draft.
  const { ok, errors } = validateDefinition(candidate);
  if (!ok) return { ok: false, errors };

  fs.mkdirSync(dirFor(id), { recursive: true });
  // Version file first: if the process dies between the two writes, meta.json still points at the
  // previous good version and the orphaned file is simply unreferenced. The reverse order would
  // leave meta.json pointing at a file that does not exist.
  writeJsonAtomic(versionFile(id, nextVersion), candidate);
  writeJsonAtomic(metaFile(id), { id, currentVersion: nextVersion, updatedAt: now });

  return { ok: true, version: nextVersion, definition: candidate };
}

/**
 * Delete a workflow and every version of it.
 *
 * Note: runs in SQLite referencing this workflow are intentionally left alone -- their history stays
 * readable, but getWorkflow() will return null for them. A UI showing an old run must tolerate a
 * missing definition.
 */
export function deleteWorkflow(id) {
  try {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Every stored version number for a workflow, ascending (for a future "run history / diff" view). */
export function listVersions(id) {
  try {
    return fs
      .readdirSync(dirFor(id))
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
