/**
 * Automatic capture — learning from what the agent actually read.
 *
 * Phase 3 added a tool for recording knowledge, and testing in the app showed the flaw in that:
 * the model explored the codebase, described the modules correctly to the user, and never called
 * it. Knowledge that depends on the model volunteering does not get written down.
 *
 * So this does not ask. Every `read_file` is observed in the main process — which sees sub-agent
 * calls too, and sub-agents are usually the ones doing the exploring. Once enough files have been
 * read under a module whose map line is still a placeholder, that module is summarised in the
 * background FROM THE CONTENT THAT WAS ACTUALLY READ, and written to ZERAIX.md.
 *
 * Three deliberate limits:
 *  - It only ever enriches a map that already exists. If the user never ran init_command, they did
 *    not ask for project memory, and unprompted background LLM calls would be a surprise.
 *  - It never touches a description someone (or an earlier observation) actually authored — those
 *    are pinned. It fills a placeholder from two files read, and upgrades a merely GENERATED
 *    description from four, because a generated line is a guess from file names and excerpts while
 *    an observed one comes from content the agent chose to open. Upgrading matters: with a working
 *    LLM there are no placeholders left after the first couple of passes, so a fill-only rule would
 *    freeze the map at guess quality forever — which is exactly the bug this was reported for.
 *  - At most one call per module per session, so cost is bounded by the number of modules, not by
 *    how much the agent reads.
 *  - Nothing here may fail, slow down, or alter a tool call. Every path is fire-and-forget.
 *
 * The result is pinned, like a hand-written description: it was derived from real file contents
 * the agent chose to open, which is strictly better than the name-and-excerpt heuristic a sweep
 * would otherwise apply, and must not be overwritten by it.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { MEMORY_FILE } from "./constants.mjs";
import { parseDocument, findSection } from "./markdown.mjs";
import { parseModuleLines, parsePins } from "./modules.mjs";
import { rememberProject } from "./remember.mjs";

const PLACEHOLDER = "(not yet summarised)";
const MIN_FILES_TO_FILL = 2; // Reads needed to replace a placeholder
const MIN_FILES_TO_UPGRADE = 4; // Reads needed to replace a generated description — a higher bar,
//                                 since that line is already useful and might cover more of the
//                                 module than the handful of files this session happened to open.
const TRIGGER_COUNTS = [MIN_FILES_TO_FILL, MIN_FILES_TO_UPGRADE];
const CHECK_EVERY = 3; // Periodic fallback check — keeps the common path free of file I/O
const MAX_PREFIX_DEPTH = 3; // Module paths are 1–2 segments; scan a little deeper to be safe
const MAX_FILE_CHARS = 1500; // Per-file excerpt sent to the model
const MAX_MODULE_CHARS = 6000; // Total content sent for one module
const MAX_TRACKED_FILES = 200; // Ceiling on what one session remembers
const MAX_CAPTURES_PER_CHECK = 2; // Gentle: a burst of reads cannot trigger a burst of LLM calls

/** workdir → { reads, sinceCheck, done, busy } */
const sessions = new Map();

function sessionFor(workdir) {
  let s = sessions.get(workdir);
  if (!s) {
    s = { reads: new Map(), sinceCheck: 0, done: new Set(), busy: new Set() };
    sessions.set(workdir, s);
  }
  return s;
}

/** Drop observations for a workdir (or all of them) — used when the workspace changes. */
export function resetObservations(workdir) {
  if (workdir) sessions.delete(workdir);
  else sessions.clear();
}

/** Normalise a tool's path argument to a forward-slashed path relative to the workdir. */
function toRelative(workdir, p) {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  const abs = path.isAbsolute(raw) ? raw : path.join(workdir, raw);
  const rel = path.relative(workdir, abs);
  if (!rel || rel.startsWith("..")) return "";
  return rel.split(path.sep).join("/");
}

/** Directory prefixes a path could belong to: "src/lib/ai/x.ts" → ["src", "src/lib", "src/lib/ai"]. */
function candidatePrefixes(rel) {
  const segs = rel.split("/");
  const out = [];
  for (let i = 1; i < segs.length && i <= MAX_PREFIX_DEPTH; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** How many distinct observed files sit under a directory prefix. */
function countUnder(reads, prefix) {
  let n = 0;
  for (const rel of reads.keys()) if (rel.startsWith(`${prefix}/`)) n++;
  return n;
}

/**
 * Observe one file read. Returns immediately; any capture happens in the background.
 * Safe to call for every read — the expensive part runs only when a directory has just become
 * summarisable, or as a periodic fallback.
 */
export function noteFileRead({ workdir, relPath, text, llm } = {}) {
  try {
    if (!workdir || !llm?.available) return;
    const rel = toRelative(workdir, relPath);
    if (!rel || rel === MEMORY_FILE) return;
    const body = String(text ?? "").trim();
    if (!body) return;

    const s = sessionFor(workdir);
    if (!s.reads.has(rel) && s.reads.size >= MAX_TRACKED_FILES) return;
    const isNew = !s.reads.has(rel);
    s.reads.set(rel, body.slice(0, MAX_FILE_CHARS));

    // Check the moment a directory reaches the file count that makes it summarisable. A periodic
    // check alone was wrong: it ran every CHECK_EVERY reads, a HIGHER bar than the two files a
    // capture needs, so a session that read exactly two files in one module never checked at all —
    // which is most sessions. The periodic check stays as a fallback for everything else.
    const ready =
      isNew && candidatePrefixes(rel).some((p) => TRIGGER_COUNTS.includes(countUnder(s.reads, p)));

    if (!ready && ++s.sinceCheck < CHECK_EVERY) return;
    s.sinceCheck = 0;
    void capture(workdir, llm, s).catch(() => {});
  } catch {
    /* observation must never disturb the tool call that triggered it */
  }
}

/**
 * Modules worth capturing, and how much evidence each needs.
 * Pinned lines — authored by a human, by remember_project, or by an earlier observation — are
 * excluded outright: they are already better than anything this could produce.
 */
async function captureCandidates(workdir) {
  let raw;
  try {
    raw = await fs.readFile(path.join(workdir, MEMORY_FILE), "utf8");
  } catch {
    return null; // no map yet → nothing to enrich
  }
  const { nodes } = parseDocument(raw);
  const section = findSection(nodes, "modules");
  if (!section) return null;

  const pins = parsePins(section.attrs?.pins);
  const out = [];
  for (const [rel, desc] of parseModuleLines(section.body)) {
    if (pins.has(rel)) continue;
    const empty = !desc || desc === PLACEHOLDER;
    out.push({ rel, need: empty ? MIN_FILES_TO_FILL : MIN_FILES_TO_UPGRADE });
  }
  return out;
}

/** Summarise a module from the file contents the agent actually opened. */
async function summariseFromReads(llm, moduleRel, files) {
  let total = 0;
  const parts = [];
  for (const [rel, excerpt] of files) {
    if (total >= MAX_MODULE_CHARS) break;
    const slice = excerpt.slice(0, Math.max(0, MAX_MODULE_CHARS - total));
    total += slice.length;
    parts.push(`--- ${rel} ---\n${slice}`);
  }

  const text = await llm.chat(
    [
      {
        role: "system",
        content:
          "You describe one directory of a codebase for a navigation map. You are given the actual " +
          "contents of files that were just read from it. Reply with ONE sentence (at most 110 " +
          "characters) saying what this directory is responsible for, naming its main entry file if " +
          "one is evident. Write for a developer deciding whether to open it. Do not restate the " +
          "directory path, do not start with 'This directory', do not use a trailing period, and " +
          "output nothing but the sentence itself, in English.",
      },
      { role: "user", content: `Directory: ${moduleRel}/\n\n${parts.join("\n\n")}` },
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

/** Describe any module the session has now read enough of. */
async function capture(workdir, llm, s) {
  const pending = await captureCandidates(workdir);
  if (!pending || !pending.length) return;

  let budget = MAX_CAPTURES_PER_CHECK;
  for (const { rel: mod, need } of pending) {
    if (budget <= 0) break;
    if (s.done.has(mod) || s.busy.has(mod)) continue;

    const files = [...s.reads.entries()].filter(([rel]) => rel.startsWith(`${mod}/`));
    if (files.length < need) continue;

    budget -= 1;
    s.busy.add(mod);
    try {
      const description = await summariseFromReads(llm, mod, files);
      if (description) {
        await rememberProject({ workdir, module: mod, note: description });
        s.done.add(mod); // one capture per module per session, whatever happens next
      }
    } catch {
      /* an outage here is not worth reporting: the placeholder simply remains */
    } finally {
      s.busy.delete(mod);
    }
  }
}
