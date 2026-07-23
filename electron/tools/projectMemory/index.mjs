/**
 * Project memory (ZERAIX.md) — freshness is PULLED at read time, never pushed by a watcher.
 *
 * ensureProjectMemory() is the only writer. It parses the existing document, recomputes each
 * section's fingerprint from that section's declared inputs, and rebuilds only the mismatches.
 * A document whose inputs have not moved costs a handful of stat/read calls and zero writes.
 *
 * Design notes:
 *  - No file watcher. Reads are rare, writes are constant, so the work belongs on the cold path;
 *    the map only has to be correct at the instant it is consumed. A pull model also catches
 *    changes made while the app was closed, which a watcher cannot.
 *  - Tier C (authored) sections are seeded once and then never machine-written.
 *  - Every failure degrades to stale-but-real content; nothing here may throw a session dead.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { fingerprintSection } from "./fingerprint.mjs";
import {
  parseDocument,
  emitDocument,
  findSection,
  hasManagedSections,
  writeAtomic,
} from "./markdown.mjs";
import { SECTIONS, buildContext } from "./sections.mjs";
import { MEMORY_FILE } from "./constants.mjs";
import { withLock } from "./lock.mjs";
import { resetModuleCheckThrottle } from "./modules.mjs";

export { MEMORY_FILE, resetModuleCheckThrottle };

const SCHEMA_VERSION = 1;
const TOTAL_MAX_CHARS = 6000; // Whole-document budget; it competes with the user's question for context
const MAX_LLM_CALLS = 8; // Tier B calls per pass, shared across sections — bounds latency and spend
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Read the existing memory file; null when absent, unreadable or implausibly large. */
async function readExisting(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Normalise a builder's return value into a uniform shape. */
function normaliseBuild(result) {
  if (result == null) return null;
  if (typeof result === "string") return { body: result, stale: null, attrs: {}, meta: {}, deferred: [] };
  return {
    body: String(result.body ?? ""),
    stale: result.stale ?? null,
    attrs: result.attrs ?? {},
    meta: result.meta ?? {},
    deferred: result.deferred ?? [],
  };
}

/**
 * Stable comparison of two marker attribute sets.
 * `id` is excluded: it is carried on parsed attrs but never on computed ones, and comparing it
 * would make every freshly built section look different from the one already on disk.
 */
function sameAttrs(a = {}, b = {}) {
  const norm = (o) =>
    JSON.stringify(
      Object.entries(o)
        .filter(([k, v]) => k !== "id" && v !== undefined && v !== null && v !== "")
        .sort(([x], [y]) => x.localeCompare(y)),
    );
  return norm(a) === norm(b);
}

/** Apply a section's own character budget. */
function truncate(body, maxChars) {
  if (!maxChars || body.length <= maxChars) return body;
  return `${body.slice(0, maxChars).trimEnd()}\n\n… (truncated)`;
}

/**
 * Bring ZERAIX.md up to date and return it.
 *
 * @param {object}   opts
 * @param {string}   opts.workdir           Absolute working-directory root.
 * @param {"auto"|"full"} [opts.mode]       "auto" rebuilds only stale sections; "full" rebuilds
 *                                          every unlocked, non-authored section.
 * @param {{available:boolean, chat:Function}} [opts.llm]  Injected so this module never imports
 *                                          the toolkit back (no cycle).
 * @param {Function} [opts.detectCheckSteps] Injected; shared with the check_project tool.
 * @returns {Promise<{file:string, markdown:string, written:boolean, rebuilt:string[],
 *                    fresh:string[], deferred:string[], dropped:string[], migrated:boolean}>}
 */
export function ensureProjectMemory({ workdir, mode = "auto", llm, detectCheckSteps } = {}) {
  return withLock(workdir, () => run({ workdir, mode, llm, detectCheckSteps }));
}

async function run({ workdir, mode, llm, detectCheckSteps }) {
  const file = path.join(workdir, MEMORY_FILE);
  const original = await readExisting(file);

  let { meta, nodes } = parseDocument(original ?? "");
  const priorFrontmatter = { ...meta };
  let migrated = false;

  // Migration: a pre-marker file is entirely derived content, but it may also carry hand-edits we
  // have no way to distinguish. Preserve it whole as a locked block rather than guess.
  if (original && !hasManagedSections(nodes)) {
    const legacyBody = nodes
      .map((n) => n.text)
      .join("")
      .trim();
    nodes = legacyBody
      ? [
          {
            type: "section",
            id: "legacy",
            attrs: { lock: true },
            body: `## Notes (imported from the previous ZERAIX.md)\n\n${legacyBody}`,
          },
        ]
      : [];
    migrated = true;
  }

  // 1) Fingerprint every derived section against its declared inputs. Sections marked `always`
  //    are exempt: their staleness is finer-grained than a section-level hash can express, so the
  //    builder decides (see modules.mjs).
  const derived = SECTIONS.filter((s) => !s.authored);
  const fps = new Map();
  for (const s of derived) {
    if (!s.always) fps.set(s.id, await fingerprintSection(workdir, s.inputs));
  }

  // 2) Decide the rebuild set.
  //
  // Sections dropped by a previous pass's size budget stay dropped. Without this they are
  // indistinguishable from sections that were never built: each pass would rebuild one, find the
  // document still over budget, drop it again, and write — churning forever and paying for a
  // build whose output is thrown away. `refresh: true` re-evaluates the decision.
  const droppedBefore = new Set(
    mode === "full" ? [] : String(priorFrontmatter.dropped || "").split(",").filter(Boolean),
  );

  const toBuild = [];
  const fresh = [];
  for (const s of derived) {
    if (droppedBefore.has(s.id) && !findSection(nodes, s.id)) continue;
    const node = findSection(nodes, s.id);
    if (node?.attrs?.lock) {
      fresh.push(s.id); // hand-frozen: never touched
      continue;
    }
    const needs =
      s.always || mode === "full" || !node || node.attrs?.fp !== fps.get(s.id) || Boolean(node.attrs?.stale);
    if (needs) toBuild.push(s);
    else fresh.push(s.id);
  }

  // 3) One LLM budget for the whole pass, shared between sections that make a single call and
  //    sections that make one per unit of work. Whatever it does not cover keeps its previous
  //    content and is retried later — deferrals are reported, never silently dropped.
  const deferred = [];
  const budget = {
    left: MAX_LLM_CALLS,
    take() {
      if (this.left <= 0) return false;
      this.left -= 1;
      return true;
    },
  };

  // 4) Seed and build in a single pass over the registry, so sections appended to a new (or newly
  //    extended) document land in registry order. Sections that already exist are updated where
  //    they sit — the user may have moved them, and that is theirs to decide.
  //    Context is assembled only when something is actually stale.
  const rebuilt = [];
  const recomputed = [];
  const removed = [];
  let seeded = false;
  let metaExtra = {};
  const buildSet = new Set(toBuild.map((s) => s.id));
  const base = toBuild.length ? await buildContext({ workdir, llm, detectCheckSteps }) : null;
  const priorMeta = meta;

  for (const s of SECTIONS) {
    if (s.authored) {
      if (findSection(nodes, s.id)) continue;
      nodes.push({ type: "section", id: s.id, attrs: { lock: true }, body: s.seed });
      seeded = true;
      continue;
    }
    if (!buildSet.has(s.id)) continue;

    const prior = findSection(nodes, s.id);

    // Section-level budget for Tier B sections that make a single call. The budget is consumed
    // whether or not the section can be deferred — otherwise a first-time build would spend a call
    // without accounting for it, and the cap would be exceeded. A section with no content yet is
    // still built when over budget: leaving a hole in the map is worse than going slightly over.
    if (s.tier === "B" && !s.always && !budget.take() && prior) {
      prior.attrs = { ...prior.attrs, stale: "deferred" };
      deferred.push(s.id);
      continue;
    }

    let out;
    try {
      out = normaliseBuild(
        await s.build({
          ...base,
          budget,
          mode,
          meta: priorMeta,
          previous: prior ? { attrs: prior.attrs, body: prior.body } : null,
        }),
      );
    } catch {
      // A builder that throws must not take the document with it: leave the old body in place
      // and mark it for retry.
      const existing = findSection(nodes, s.id);
      if (existing) existing.attrs = { ...existing.attrs, stale: "error" };
      continue;
    }

    const existing = findSection(nodes, s.id);
    if (!out) {
      // Section no longer applies (e.g. the README was deleted) → drop it.
      if (existing) {
        nodes = nodes.filter((n) => n !== existing);
        removed.push(s.id);
      }
      continue;
    }

    if (out.deferred.length) deferred.push(...out.deferred.map((d) => `${s.id}/${d}`));
    metaExtra = { ...metaExtra, ...out.meta };

    const attrs = s.always ? { ...out.attrs } : { fp: fps.get(s.id), ...out.attrs };
    if (out.stale) attrs.stale = out.stale;
    // `always` sections own their own timestamp — stamping one here would make the document
    // differ every day and defeat the no-op check below.
    if (s.tier === "B" && !s.always) attrs.built = new Date().toISOString().slice(0, 10);
    const body = truncate(out.body, s.maxChars);

    // A section that ran is "recomputed"; a section whose output actually differs is "rebuilt".
    // Keeping these apart is what makes `always` sections free — consulted every pass, but only
    // dirtying the document when they produce something new — and it keeps `refresh: true`
    // honest, since a forced pass that finds everything current should still say it looked.
    recomputed.push(s.id);
    if (existing && existing.body === body && sameAttrs(existing.attrs, attrs)) {
      fresh.push(s.id);
      continue;
    }

    if (existing) {
      existing.attrs = attrs;
      existing.body = body;
    } else {
      nodes.push({ type: "section", id: s.id, attrs, body });
    }
    rebuilt.push(s.id);
  }

  // 5) Whole-document budget, measured on the EMITTED file (markers and frontmatter are part of
  //    what the model has to read, so they count). Lowest-value derived sections go first;
  //    authored content, locked sections and raw text are never dropped.
  meta = { ...meta, ...metaExtra, schema: SCHEMA_VERSION, generated: new Date().toISOString(), workdir };
  delete meta.dropped;

  const newlyDropped = [];
  const byPriority = [...SECTIONS]
    .filter((s) => !s.authored && (s.priority ?? 0) >= 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const s of byPriority) {
    if (emitDocument(meta, nodes).length <= TOTAL_MAX_CHARS) break;
    const node = findSection(nodes, s.id);
    if (!node || node.attrs?.lock) continue;
    nodes = nodes.filter((n) => n !== node);
    newlyDropped.push(s.id);
  }

  // Carry forward earlier drops so the decision survives into the next pass.
  const dropped = [...new Set([...droppedBefore, ...newlyDropped])].sort();
  const dropsChanged = dropped.join(",") !== [...droppedBefore].sort().join(",");

  // 6) Emit. Nothing changed → no write at all, which is the common case.
  //
  // A moved git baseline counts as a change even when no section body did. Without this, a module
  // whose commit produced an identical summary would leave `gitHead` pinned to the old sha, and
  // every later pass would see that same commit as new work and re-summarise it forever.
  const metaChanged = Object.entries(metaExtra).some(([k, v]) => priorMeta[k] !== String(v));
  const changed =
    migrated ||
    seeded ||
    metaChanged ||
    rebuilt.length > 0 ||
    removed.length > 0 ||
    dropsChanged ||
    !original;

  if (!changed && original) {
    return {
      file,
      markdown: original,
      written: false,
      rebuilt: [],
      recomputed,
      fresh,
      deferred,
      dropped: [],
      migrated: false,
    };
  }

  if (dropped.length) meta.dropped = dropped.join(",");
  const markdown = emitDocument(meta, nodes);
  await writeAtomic(file, markdown);

  return { file, markdown, written: true, rebuilt, recomputed, fresh, deferred, dropped, migrated };
}

/**
 * A pointer to the gaps in the map, for the model reading this result.
 *
 * Without it the failure mode is silent and wasteful: the model sees "(not yet summarised)",
 * explores the module itself to answer the question, gives a good answer — and drops everything
 * it learned, so the next session repeats the work. Naming the gap and the tool that fills it is
 * what turns a one-off exploration into memory.
 */
function pendingHint(result) {
  const n = (String(result.markdown || "").match(/\(not yet summarised\)/g) || []).length;
  if (!n) return "";
  return (
    ` ${n} module${n > 1 ? "s have" : " has"} no description yet. If you read any of them while` +
    " working on this task, record what you learn with remember_project({ module, note }) so the" +
    " next session starts with it."
  );
}

/** One-line human/model-readable summary of what a pass did. */
export function summarise(result) {
  if (!result.written) {
    const checked = result.recomputed?.length
      ? `${result.fresh.length} sections unchanged (${result.recomputed.length} re-checked)`
      : `${result.fresh.length} sections unchanged`;
    return `Project memory is up to date (${MEMORY_FILE}; ${checked}, no rewrite needed).${pendingHint(result)}`;
  }
  const bits = [];
  if (result.migrated) bits.push("migrated the previous file into a locked block");
  if (result.rebuilt.length) bits.push(`rebuilt ${result.rebuilt.join(", ")}`);
  if (result.fresh.length) bits.push(`reused ${result.fresh.length} unchanged`);
  if (result.deferred.length) bits.push(`deferred ${result.deferred.join(", ")} to the next pass`);
  if (result.dropped.length) bits.push(`dropped ${result.dropped.join(", ")} to stay within the size budget`);
  return `Project memory written to ${MEMORY_FILE} (${bits.join("; ") || "generated"}).${pendingHint(result)}`;
}
