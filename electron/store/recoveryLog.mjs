/**
 * The recovery log: one line per recovery action, so what the app did after a crash can be read afterwards.
 *
 * docs/agent-runtime-crash-recovery.md C10. Every category that survives a failure — the session lock noticing
 * an unclean shutdown, the orphan sweep, the sidecar's journal replay, the VM self-heal, a renderer crash —
 * writes here, and a person (or a test) reads it back. It is the contract between the categories: C9 reports
 * from it, tests assert on it, support asks for it.
 *
 * Deliberately synchronous and tiny. A recovery event is rare and usually adjacent to a crash, so it has to be
 * on disk by the time the call returns; buffering it the way the usage log does would lose exactly the entries
 * this file exists for. No electron import: main.mjs hands the folder in, and a plain node test can do the same.
 *
 * Layout: <dir>/recovery.jsonl, rotated once to recovery.1.jsonl past MAX_BYTES. Never throws.
 */
import fs from "node:fs";
import path from "node:path";

const FILE = "recovery.jsonl";
const ROTATED = "recovery.1.jsonl";
/** Past this the file is rotated. Entries are ~200 bytes; this is years of ordinary use. */
const MAX_BYTES = 1024 * 1024;

let baseDir = "";

/** Point the log at a folder (userData/logs in the app). Unset = every record is a no-op, which is what a test that never configured it wants. */
export function setRecoveryLogDir(dir) {
  baseDir = typeof dir === "string" ? dir : "";
}

export function recoveryLogPath() {
  return baseDir ? path.join(baseDir, FILE) : "";
}

/**
 * Append one entry. `component` names the subsystem ("session", "renderer", "sidecar", "sandbox", "orphans", "turn"),
 * `event` what happened, `detail` whatever a reader needs to chase it — never file contents or prompts.
 */
export function recordRecovery(component, event, detail = {}) {
  const file = recoveryLogPath();
  if (!file) return null;
  const entry = { at: new Date().toISOString(), component: String(component), event: String(event), detail };
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(baseDir, ROTATED));
    } catch {
      /* no file yet, or the rename lost a race: either way, keep writing */
    }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.warn("[recovery] could not write the recovery log:", e?.message ?? e);
  }
  return entry;
}

/** The last `limit` entries, oldest first. A torn last line (a crash mid-append) is skipped, not fatal. */
export function readRecoveryLog(limit = 200) {
  const file = recoveryLogPath();
  if (!file) return [];
  const out = [];
  for (const p of [path.join(baseDir, ROTATED), file]) {
    let text = "";
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* torn or foreign line */
      }
    }
  }
  return out.slice(-Math.max(0, limit));
}
