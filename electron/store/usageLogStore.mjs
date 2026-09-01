/**
 * Usage log store (main process): an append-only record of what the app spent tokens on.
 *
 * One JSONL line per event, in three kinds:
 *   - "model"    every LLM invocation (chat turn, sub-agent round, compaction, automation node,
 *                workflow builder), with the provider's token usage;
 *   - "tool"     every tool call, tagged with the actor that made it -- "main" for the primary
 *                agent, "sub:<id>" for a sub-agent -- so a delegation's actions are attributable;
 *   - "subagent" one summary line per delegation (which agent, the task, rounds, steps, tokens).
 *
 * WHY JSONL AND NOT THE JSON STORES USED ELSEWHERE
 * conversationStore / notificationStore rewrite a whole file per change, which is fine for a few
 * hundred records. This log grows by an entry per tool call, so a rewrite-per-append would re-serialize
 * a megabyte file thousands of times in one session. Append-only lines also survive a crash mid-write:
 * the last line is lost, not the file.
 *
 * OFF BY DEFAULT. The switch lives in app.config ([logging] usage=1) so the main process can answer
 * "should I write this?" without asking a window -- automation runs with no window open at all.
 * While disabled, appendEntry returns immediately and nothing touches the disk.
 *
 * Layout: userData/logs/usage/YYYY-MM-DD.jsonl (local date). Files older than RETENTION_DAYS are
 * pruned at startup; a single day stops accepting writes past MAX_FILE_BYTES so a runaway loop can
 * fill neither the disk nor the viewer.
 */
import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getAppConfig, setAppConfig } from "../appConfig.mjs";

const CONFIG_SECTION = "logging";
const CONFIG_KEY = "usage";

/** Per-day ceiling. Past this the day is closed for writing rather than growing without bound. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Day files older than this are deleted on startup. */
const RETENTION_DAYS = 30;
/** Buffered append window: coalesce a burst of parallel tool calls into one write. */
const FLUSH_MS = 800;
const FLUSH_BYTES = 64 * 1024;

/** Field size caps. The model chose most of these strings, so none of them are trusted to be short. */
const LIMITS = {
  source: 40,
  actor: 80,
  kind: 20,
  model: 200,
  provider: 80,
  endpoint: 200,
  convId: 120,
  turnId: 120,
  runId: 120,
  nodeId: 120,
  name: 120,
  agent: 80,
  task: 2000,
  error: 500,
  preview: 2000,
  args: 1500,
};

let enabled = null; // null = not yet read from app.config
let pending = []; // buffered lines, keyed nowhere: they all belong to today
let pendingBytes = 0;
let flushTimer = null;
let dayBytes = new Map(); // day -> bytes already on disk (avoids a stat per append)
let seq = 0;

/** Root of the log tree. Kept out of the conversation store so "clear logs" can never touch chat data. */
export function usageLogDir() {
  return path.join(app.getPath("userData"), "logs", "usage");
}

/** Local (not UTC) date key: a log the user reads by day should break where their day breaks. */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayFile(day) {
  return path.join(usageLogDir(), `${day}.jsonl`);
}

/** A day key is used to build a path, so it is validated rather than trusted (renderer input). */
function isValidDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day);
}

// ── Enable switch ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether logging is on. Source of truth is app.config, so a headless run reads the same answer.
 *
 * **Default ON.** It used to be off, which meant the log was empty exactly when someone went looking for
 * it — after the run they wanted to understand had already happened. Retention makes that affordable: day
 * files older than RETENTION_DAYS are pruned at startup and a single day stops accepting writes past
 * MAX_FILE_BYTES, so "on and forgotten" is bounded rather than unbounded.
 *
 * Only an explicit "0"/"false" turns it off. An ABSENT value now means on, which is the part that had to
 * change in step with the writer below: while off was stored as an absent key, flipping this default alone
 * would have read every explicit "off" back as "on".
 */
export function isUsageLogEnabled() {
  if (enabled === null) {
    const v = getAppConfig()?.[CONFIG_SECTION]?.[CONFIG_KEY];
    enabled = !(v === "0" || v === "false");
  }
  return enabled;
}

/**
 * Turn logging on/off and persist it. Flushes on the way down so nothing already recorded is lost.
 *
 * Off is written as an explicit "0" rather than by clearing the key. Clearing it was correct while absent
 * meant off; now that absent means on, clearing would silently re-enable the thing the user just turned off.
 */
export function setUsageLogEnabled(on) {
  const next = !!on;
  if (next === enabled) return next;
  enabled = next;
  setAppConfig(CONFIG_SECTION, CONFIG_KEY, next ? "1" : "0");
  if (!next) void flushUsageLog();
  return next;
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────────

function clip(value, max) {
  if (value == null) return undefined;
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.length > max ? `${s.slice(0, max)}…` : s;
  return trimmed || undefined;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

/**
 * Tool arguments, safe to persist.
 *
 * Same rule as the automation timeline's redactArgs (electron/agent/turn.mjs): a value the model
 * produced under a key that looks like a credential is replaced rather than written to a file the
 * user may later attach to a bug report.
 */
function redactArgs(args) {
  if (!args || typeof args !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (/key|token|secret|password|authorization/i.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    } else if (v === null || ["number", "boolean"].includes(typeof v)) {
      out[k] = v;
    } else {
      out[k] = clip(JSON.stringify(v), 300);
    }
  }
  return clip(JSON.stringify(out), LIMITS.args);
}

/**
 * Normalize a caller-supplied entry into the stored shape.
 *
 * A field allowlist rather than a spread: entries come from the renderer over IPC, and an unbounded
 * object would let a single tool result balloon the log file it is being written to.
 */
function normalize(raw) {
  const kind = clip(raw?.kind, LIMITS.kind) ?? "model";
  const entry = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    ts: num(raw?.ts) ?? Date.now(),
    kind,
    source: clip(raw?.source, LIMITS.source) ?? "chat",
    actor: clip(raw?.actor, LIMITS.actor) ?? "main",
    ok: raw?.ok !== false,
  };
  // Correlation: turnId groups one user turn's model calls, tool calls and delegations together,
  // which is what the timeline view draws lanes from.
  for (const k of ["convId", "turnId", "runId", "nodeId"]) {
    const v = clip(raw?.[k], LIMITS[k]);
    if (v) entry[k] = v;
  }
  const ms = num(raw?.ms);
  if (ms != null) entry.ms = ms;
  const error = clip(raw?.error, LIMITS.error);
  if (error) entry.error = error;

  if (kind === "model") {
    entry.model = clip(raw?.model, LIMITS.model);
    const provider = clip(raw?.provider, LIMITS.provider);
    if (provider) entry.provider = provider;
    const endpoint = clip(raw?.endpoint, LIMITS.endpoint);
    if (endpoint) entry.endpoint = endpoint;
    entry.promptTokens = num(raw?.promptTokens) ?? 0;
    entry.completionTokens = num(raw?.completionTokens) ?? 0;
    entry.totalTokens = num(raw?.totalTokens) ?? entry.promptTokens + entry.completionTokens;
    const cached = num(raw?.cachedTokens);
    if (cached) entry.cachedTokens = cached;
    const reasoning = num(raw?.reasoningTokens);
    if (reasoning) entry.reasoningTokens = reasoning;
    if (raw?.stream) entry.stream = true;
    // The provider did not report usage and the caller counted the wire itself (tiktoken). Marked so
    // a total built from these reads as an estimate rather than a bill.
    if (raw?.estimated) entry.estimated = true;
  } else if (kind === "tool") {
    entry.name = clip(raw?.name, LIMITS.name) ?? "unknown";
    const args = redactArgs(raw?.args);
    if (args) entry.args = args;
    const chars = num(raw?.resultChars);
    if (chars != null) entry.resultChars = chars;
    // Estimated tokens the result adds to the context. Kept separate from the model entries' token
    // fields and never summed into them: this is context weight the *next* request pays for, not a
    // charge the provider billed for this call, and merging the two would inflate the day's total.
    const resultTokens = num(raw?.resultTokens);
    if (resultTokens != null) entry.resultTokens = resultTokens;
    const preview = clip(raw?.resultPreview, LIMITS.preview);
    if (preview) entry.resultPreview = preview;
    if (raw?.blocked) entry.blocked = true;
  } else if (kind === "subagent") {
    entry.agent = clip(raw?.agent, LIMITS.agent) ?? "unknown";
    const task = clip(raw?.task, LIMITS.task);
    if (task) entry.task = task;
    const rounds = num(raw?.rounds);
    if (rounds != null) entry.rounds = rounds;
    const steps = num(raw?.steps);
    if (steps != null) entry.steps = steps;
    entry.totalTokens = num(raw?.totalTokens) ?? 0;
    entry.promptTokens = num(raw?.promptTokens) ?? 0;
    entry.completionTokens = num(raw?.completionTokens) ?? 0;
  } else if (kind === "context") {
    // Per-round wire composition snapshot (diagnostics). Numeric allowlist only.
    const model = clip(raw?.model, LIMITS.model);
    if (model) entry.model = model;
    for (const key of [
      "ctxSystem",
      "ctxToolSchemas",
      "ctxHistory",
      "ctxToolOutputs",
      "ctxSubagent",
      "ctxTotal",
      "ctxWire",
      "ctxWindow",
      "rereads",
      "msgCount",
    ]) {
      const v = num(raw?.[key]);
      if (v != null) entry[key] = v;
    }
  }
  return entry;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushUsageLog();
  }, FLUSH_MS);
}

/**
 * Record one event. A no-op while logging is disabled -- which is the default, and the reason this
 * can be called from the hot path of every request and every tool call.
 */
export function appendEntry(raw) {
  if (!isUsageLogEnabled()) return null;
  let line;
  try {
    line = JSON.stringify(normalize(raw));
  } catch {
    return null; // an entry that cannot be serialized is dropped, never thrown at the caller
  }
  pending.push(line);
  pendingBytes += line.length + 1;
  if (pendingBytes >= FLUSH_BYTES) void flushUsageLog();
  else scheduleFlush();
  return true;
}

/** Write everything buffered. Safe to call at any time; called on quit so a session ends complete. */
export async function flushUsageLog() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;
  const lines = pending;
  pending = [];
  pendingBytes = 0;

  const day = dayKey();
  const file = dayFile(day);
  const chunk = `${lines.join("\n")}\n`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let size = dayBytes.get(day);
    if (size == null) {
      size = await fsp.stat(file).then((s) => s.size, () => 0);
    }
    // Past the ceiling the day is closed: dropping the write keeps a stuck loop from filling the disk.
    // Recorded once per day rather than per dropped line, so the notice itself cannot flood the file.
    if (size >= MAX_FILE_BYTES) {
      if (size === MAX_FILE_BYTES) return;
      dayBytes.set(day, MAX_FILE_BYTES);
      await fsp.appendFile(
        file,
        `${JSON.stringify({ ts: Date.now(), kind: "notice", source: "logger", actor: "system", ok: false, error: `daily log limit reached (${MAX_FILE_BYTES} bytes); further entries for ${day} were dropped` })}\n`,
        "utf8",
      );
      return;
    }
    await fsp.appendFile(file, chunk, "utf8");
    dayBytes.set(day, size + chunk.length);
  } catch (e) {
    console.error("[usage-log] append failed:", e?.message || e);
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────

/** The days that have a log file, newest first: [{ day, bytes, mtime }]. */
export async function listUsageLogDays() {
  try {
    const dir = usageLogDir();
    const names = await fsp.readdir(dir);
    const days = [];
    for (const name of names) {
      const day = name.endsWith(".jsonl") ? name.slice(0, -6) : null;
      if (!isValidDay(day)) continue;
      const st = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (st) days.push({ day, bytes: st.size, mtime: st.mtimeMs });
    }
    return days.sort((a, b) => (a.day < b.day ? 1 : -1));
  } catch {
    return []; // no directory yet == no logs
  }
}

/** Parse a day file into entries, oldest first. A truncated final line is skipped, not fatal. */
async function parseDay(day) {
  if (!isValidDay(day)) return [];
  let text;
  try {
    text = await fsp.readFile(dayFile(day), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a line lost to a crash mid-write */
    }
  }
  return out;
}

/**
 * Read one day, newest first, with optional filtering.
 * @param {{day?:string, kind?:string, actor?:string, convId?:string, turnId?:string, q?:string,
 *          limit?:number, offset?:number, order?:"asc"|"desc"}} opts
 * @returns {Promise<{day:string, total:number, matched:number, entries:object[]}>}
 */
export async function readUsageLog(opts = {}) {
  const day = isValidDay(opts.day) ? opts.day : dayKey();
  // Anything still buffered belongs to today and would otherwise be missing from the view for up to
  // FLUSH_MS -- long enough for "I just ran something and the log is empty".
  if (day === dayKey()) await flushUsageLog();
  const all = await parseDay(day);
  const q = String(opts.q ?? "").trim().toLowerCase();
  const filtered = all.filter((e) => {
    if (opts.kind && e.kind !== opts.kind) return false;
    if (opts.actor && e.actor !== opts.actor) return false;
    if (opts.convId && e.convId !== opts.convId) return false;
    if (opts.turnId && e.turnId !== opts.turnId) return false;
    if (!q) return true;
    return [e.model, e.name, e.agent, e.actor, e.task, e.args, e.error, e.source]
      .some((v) => typeof v === "string" && v.toLowerCase().includes(q));
  });
  const ordered = opts.order === "asc" ? filtered : [...filtered].reverse();
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 200), 2000);
  return {
    day,
    total: all.length,
    matched: ordered.length,
    entries: ordered.slice(offset, offset + limit),
  };
}

/**
 * Aggregate one day: totals, plus a breakdown by model, by actor and by tool.
 * Computed here rather than in the renderer so the whole day never has to cross IPC to be summed.
 */
export async function usageLogStats(day) {
  const key = isValidDay(day) ? day : dayKey();
  if (key === dayKey()) await flushUsageLog();
  const all = await parseDay(key);
  const stats = {
    day: key,
    entries: all.length,
    calls: 0,
    toolCalls: 0,
    subagentRuns: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    /** Estimated context weight of every tool result this day; deliberately not part of totalTokens. */
    toolResultTokens: 0,
    estimated: false,
    errors: 0,
    byModel: {},
    byActor: {},
    byTool: {},
    firstTs: null,
    lastTs: null,
  };
  for (const e of all) {
    if (e.ts) {
      stats.firstTs = stats.firstTs == null ? e.ts : Math.min(stats.firstTs, e.ts);
      stats.lastTs = stats.lastTs == null ? e.ts : Math.max(stats.lastTs, e.ts);
    }
    if (e.ok === false) stats.errors++;
    if (e.kind === "model") {
      stats.calls++;
      stats.promptTokens += e.promptTokens ?? 0;
      stats.completionTokens += e.completionTokens ?? 0;
      stats.totalTokens += e.totalTokens ?? 0;
      stats.cachedTokens += e.cachedTokens ?? 0;
      if (e.estimated) stats.estimated = true;
      const m = (stats.byModel[e.model || "unknown"] ??= { calls: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 });
      m.calls++;
      m.totalTokens += e.totalTokens ?? 0;
      m.promptTokens += e.promptTokens ?? 0;
      m.completionTokens += e.completionTokens ?? 0;
      const a = (stats.byActor[e.actor || "main"] ??= { calls: 0, totalTokens: 0, toolCalls: 0 });
      a.calls++;
      a.totalTokens += e.totalTokens ?? 0;
    } else if (e.kind === "tool") {
      stats.toolCalls++;
      // Tracked apart from totalTokens (see normalize): context weight, not a provider charge.
      stats.toolResultTokens += e.resultTokens ?? 0;
      const tool = (stats.byTool[e.name || "unknown"] ??= { calls: 0, ms: 0, errors: 0, resultTokens: 0 });
      tool.calls++;
      tool.ms += e.ms ?? 0;
      tool.resultTokens += e.resultTokens ?? 0;
      if (e.ok === false) tool.errors++;
      const a = (stats.byActor[e.actor || "main"] ??= { calls: 0, totalTokens: 0, toolCalls: 0 });
      a.toolCalls++;
    } else if (e.kind === "subagent") {
      stats.subagentRuns++;
    }
  }
  return stats;
}

/** Delete one day's file, or every day when `day` is omitted. Returns how many files were removed. */
export async function clearUsageLog(day) {
  await flushUsageLog();
  pending = [];
  pendingBytes = 0;
  dayBytes = new Map();
  if (day) {
    if (!isValidDay(day)) return 0;
    try {
      await fsp.unlink(dayFile(day));
      return 1;
    } catch {
      return 0;
    }
  }
  const days = await listUsageLogDays();
  let removed = 0;
  for (const d of days) {
    try {
      await fsp.unlink(dayFile(d.day));
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/**
 * Drop day files older than the retention window. Called once at startup: a log the user forgot they
 * enabled should not still be growing a year later.
 */
export async function pruneUsageLog() {
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 86400_000);
  const days = await listUsageLogDays();
  for (const d of days) {
    if (d.day >= cutoff) continue;
    try {
      await fsp.unlink(dayFile(d.day));
    } catch {
      /* best effort */
    }
  }
}

/** Ensure the directory exists so "open log folder" works before the first entry is ever written. */
export function ensureUsageLogDir() {
  const dir = usageLogDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the open action reports its own failure */
  }
  return dir;
}
