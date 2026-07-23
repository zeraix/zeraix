/**
 * The write path — how knowledge the agent earned gets back into ZERAIX.md.
 *
 * Everything else in this directory DERIVES the map from the repository. That leaves a gap: when
 * the agent actually reads code to answer a question, what it learned is thrown away the moment
 * the turn ends, and the next session pays to rediscover it. This module closes that gap.
 *
 * Two targets, because there are two kinds of thing worth keeping:
 *   - a module description — replaces one line of the module map, and PINS it, so a later
 *     staleness sweep will not overwrite a description written from real reading with a
 *     one-shot summary generated from file names and excerpts
 *   - a note — appended to the authored Tier C section: invariants, gotchas, conventions, the
 *     things no amount of scanning could have told you
 *
 * Pins are honoured even by `refresh: true`, on the same principle as `lock`: machine-generated
 * content is replaceable, authored content is not. Removing a pin means editing the file.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { MEMORY_FILE } from "./constants.mjs";
import { withLock } from "./lock.mjs";
import { parseDocument, emitDocument, findSection, writeAtomic } from "./markdown.mjs";
import { parseModuleLines, parsePins, serialisePins } from "./modules.mjs";

const MAX_NOTE_CHARS = 500;
const MAX_NOTES = 40; // Keep the authored section from growing without bound

/** Normalise free text to a single tidy line suitable for a bullet. */
function oneLine(s, max) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-*`\s]+/, "")
    .trim()
    .slice(0, max);
}

/**
 * Record something learned about the project.
 *
 * @param {object} opts
 * @param {string} opts.workdir
 * @param {string} opts.note          The text: a module description, or a standalone note.
 * @param {string} [opts.module]      Module path (e.g. "electron" or "src/lib"). When given, the
 *                                    note becomes that module's line in the map instead.
 * @param {Function} [opts.ensure]    Called to create the document if it does not exist yet.
 * @returns {Promise<{ok:boolean, message:string, file:string}>}
 */
export async function rememberProject({ workdir, note, module: modulePath, ensure } = {}) {
  const file = path.join(workdir, MEMORY_FILE);
  const text = oneLine(note, MAX_NOTE_CHARS);
  if (!text) return { ok: false, message: "note must not be empty", file };

  // Create the map first if there is none. Done outside the lock because ensure() takes it too.
  try {
    await fs.access(file);
  } catch {
    if (typeof ensure === "function") await ensure();
  }

  return withLock(workdir, async () => {
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return { ok: false, message: `no ${MEMORY_FILE} yet — run init_command first`, file };
    }

    const { meta, nodes } = parseDocument(raw);
    const result = modulePath
      ? applyModuleDescription(nodes, modulePath, text)
      : applyNote(nodes, text);
    if (!result.ok) return { ...result, file };

    await writeAtomic(file, emitDocument(meta, nodes));
    return { ...result, file };
  });
}

/** Replace one module's line in the map and pin it against future overwrites. */
function applyModuleDescription(nodes, modulePath, text) {
  const section = findSection(nodes, "modules");
  if (!section) {
    return { ok: false, message: "the module map does not exist yet — run init_command first" };
  }

  const rel = String(modulePath).replace(/^\.?\//, "").replace(/\/+$/, "");
  const lines = parseModuleLines(section.body);
  if (!lines.has(rel)) {
    const known = [...lines.keys()].join(", ") || "(none)";
    return { ok: false, message: `"${rel}" is not a module in the map. Known modules: ${known}` };
  }

  lines.set(rel, text);
  section.body = [
    "## Module Map",
    ...[...lines.entries()].map(([k, v]) => `- \`${k}/\` — ${v}`),
  ].join("\n");

  const pins = parsePins(section.attrs?.pins);
  pins.add(rel);
  section.attrs = { ...section.attrs, pins: serialisePins(pins) };

  return { ok: true, message: `Recorded the description of ${rel}/ in the module map (pinned, so it will not be regenerated).` };
}

/** Append a note to the authored Tier C section. */
function applyNote(nodes, text) {
  const section = findSection(nodes, "notes");
  if (!section) {
    return { ok: false, message: "the notes section does not exist yet — run init_command first" };
  }

  const lines = section.body.split("\n");
  const kept = lines.filter((l) => l.trim() !== "- (nothing recorded yet)");
  const bullet = `- ${text}`;
  if (kept.some((l) => l.trim() === bullet)) {
    return { ok: true, message: "That note is already recorded; nothing to add." };
  }

  // Drop the oldest bullets rather than let the section grow without limit.
  const bullets = kept.filter((l) => l.trimStart().startsWith("- "));
  const prose = kept.filter((l) => !l.trimStart().startsWith("- "));
  const next = [...bullets, bullet].slice(-MAX_NOTES);
  section.body = [...prose, ...next].join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return { ok: true, message: `Recorded in the ${"Invariants & Gotchas"} section of ZERAIX.md.` };
}
