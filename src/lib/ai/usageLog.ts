/**
 * Renderer bridge to the token-usage log (main process: electron/store/usageLogStore.mjs).
 *
 * Two directions:
 *  - writing: the renderer is the only layer that knows *who* is acting -- the main agent or a
 *    specific sub-agent -- so tool calls and delegations are recorded here. Model invocations are NOT:
 *    they are logged by the LLM proxy in the main process, which every request already passes through.
 *    What the renderer contributes to those is `meta` on the request (see buildLogMeta), the
 *    attribution the proxy has no way to derive.
 *  - reading: the settings viewer lists days, reads entries and asks for per-day aggregates.
 *
 * Logging is ON by default (docs/TODO). `enabledSync()` is a cached mirror of the main-process switch so the
 * hot path (a log call per tool call) costs a boolean rather than an IPC round trip; the main process
 * re-checks the real switch anyway, so a stale mirror can only cost a dropped entry, never a rogue write.
 * Outside Electron every function here is an inert no-op.
 */

export type UsageLogKind = "model" | "tool" | "subagent" | "notice" | "context";

/** One stored line. Which fields are present depends on `kind` -- see the store's normalize(). */
export interface UsageLogEntry {
  id?: string;
  ts: number;
  kind: UsageLogKind;
  /** Where the call came from: chat / automation / workflow-builder / tool. */
  source: string;
  /** Who made it: "main", "sub:<agentId>", "compact", "node:<nodeId>". */
  actor: string;
  ok: boolean;
  ms?: number;
  error?: string;
  convId?: string;
  /** Groups one user turn's model calls, tool calls and delegations -- the timeline's unit. */
  turnId?: string;
  runId?: string;
  nodeId?: string;
  // kind: "model"
  model?: string;
  provider?: string;
  endpoint?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  stream?: boolean;
  /** The provider returned no usage and the caller counted the wire itself. */
  estimated?: boolean;
  // kind: "tool"
  name?: string;
  args?: string;
  resultChars?: number;
  /** Estimated tokens the result adds to the context — a tool call's real cost to the conversation. */
  resultTokens?: number;
  resultPreview?: string;
  blocked?: boolean;
  // kind: "subagent"
  agent?: string;
  task?: string;
  rounds?: number;
  steps?: number;
  // kind: "context" — one per-round wire composition snapshot (diagnostics; Phase 1 measurement).
  ctxSystem?: number;
  ctxToolSchemas?: number;
  ctxHistory?: number;
  ctxToolOutputs?: number;
  ctxSubagent?: number;
  /** Messages-only total (excludes tool schemas) — matches the app's own context estimate. */
  ctxTotal?: number;
  /** What the provider actually prices this round: messages + tool schemas. */
  ctxWire?: number;
  /** The active model's context window, so a snapshot is legible without joining to the model entry. */
  ctxWindow?: number;
  /** Redundant re-reads so far in the conversation (attention-quality proxy). */
  rereads?: number;
  msgCount?: number;
}

export interface UsageLogDay {
  day: string;
  bytes: number;
  mtime: number;
}

export interface UsageLogPage {
  day: string;
  /** Entries in the file, before filtering. */
  total: number;
  /** Entries matching the filters. */
  matched: number;
  entries: UsageLogEntry[];
}

export interface UsageLogBucket {
  calls: number;
  totalTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: number;
  resultTokens?: number;
  ms?: number;
  errors?: number;
}

export interface UsageLogStats {
  day: string;
  entries: number;
  calls: number;
  toolCalls: number;
  subagentRuns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** Estimated context weight of the day's tool results. Not included in totalTokens. */
  toolResultTokens: number;
  estimated: boolean;
  errors: number;
  byModel: Record<string, UsageLogBucket>;
  byActor: Record<string, UsageLogBucket>;
  byTool: Record<string, UsageLogBucket>;
  firstTs: number | null;
  lastTs: number | null;
}

export interface UsageLogReadOptions {
  day?: string;
  kind?: UsageLogKind;
  actor?: string;
  convId?: string;
  turnId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

interface UsageLogBridge {
  isEnabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<boolean>;
  append(entries: unknown): void;
  days(): Promise<UsageLogDay[]>;
  read(opts?: UsageLogReadOptions): Promise<UsageLogPage>;
  stats(day?: string): Promise<UsageLogStats>;
  clear(day?: string): Promise<number>;
  flush(): Promise<void>;
  dir(): Promise<string>;
  openDir(): Promise<{ ok: boolean; path: string; error?: string }>;
}

declare global {
  interface Window {
    usageLog?: UsageLogBridge;
  }
}

function bridge(): UsageLogBridge | null {
  return typeof window !== "undefined" && window.usageLog ? window.usageLog : null;
}

/**
 * Call the bridge, falling back instead of throwing.
 *
 * preload.cjs is re-read whenever the window reloads, but main.mjs is only read when the process
 * starts -- so a dev reload (or an in-place upgrade) can leave a window whose `window.usageLog` exists
 * while the handlers behind it do not ("No handler registered for 'usagelog:…'"). That skew must show
 * up as an empty log panel, not as a rejected promise on every settings render.
 */
async function call<T>(fn: (b: UsageLogBridge) => Promise<T>, fallback: T): Promise<T> {
  const b = bridge();
  if (!b) return fallback;
  try {
    return await fn(b);
  } catch {
    return fallback;
  }
}

/** Whether the log exists at all (Electron only; a web build has no main process to write to). */
export function isUsageLogAvailable(): boolean {
  return !!bridge();
}

let cachedEnabled = true;
let primed: Promise<boolean> | null = null;

/**
 * The cached switch, optimistic until primeUsageLog() has resolved.
 *
 * It started `false` while logging was off by default, on the reasoning that dropping the first few entries of
 * a session was safer than a user who left logging off starting to write to disk. Flipping the default
 * inverted that: `false` now drops entries from exactly the start of the session someone is most likely to be
 * investigating, and it does so for every user rather than the few who opted in.
 *
 * Optimism is safe in either direction because this mirror is not authoritative — the main process re-checks
 * the real switch on every write, so a user who HAS turned logging off still writes nothing. The only thing
 * this value can change is whether an entry is offered, never whether it is stored.
 */
export function isUsageLogEnabledSync(): boolean {
  return cachedEnabled;
}

/** Read the real switch once and cache it. Idempotent; safe to call from several components. */
export function primeUsageLog(): Promise<boolean> {
  const b = bridge();
  if (!b) {
    // No bridge means no main process to write to — in the browser, logging is not "off", it is absent. The
    // optimistic default above is about a switch whose value is not known yet; here it is known.
    cachedEnabled = false;
    return Promise.resolve(false);
  }
  primed ??= b
    .isEnabled()
    .then((on) => {
      cachedEnabled = !!on;
      return cachedEnabled;
    })
    .catch(() => false);
  return primed;
}

/** Flip the switch (persisted in app.config by the main process) and update the cached mirror. */
export async function setUsageLogEnabled(on: boolean): Promise<boolean> {
  // `false` on failure rather than the requested value: the toggle must reflect what the main process
  // actually applied, and a call that never landed applied nothing.
  const applied = await call((b) => b.setEnabled(on), false);
  cachedEnabled = !!applied;
  primed = Promise.resolve(cachedEnabled);
  return cachedEnabled;
}

/** Attribution attached to an LLM request so the proxy can log *which* agent spent the tokens. */
export interface UsageLogMeta {
  source?: string;
  actor?: string;
  convId?: string;
  turnId?: string;
  model?: string;
  provider?: string;
  /**
   * The caller records this invocation itself, so the proxy must not record it a second time.
   *
   * The chat loop sets this because it cannot rely on the proxy at all: in the desktop app a cloud
   * model is called with a direct fetch from the renderer (only local endpoints and the non-Electron
   * fallback go through the proxy), so a proxy-only hook would miss exactly the requests that cost
   * the most. The renderer also has the better numbers — it falls back to counting the wire with
   * tiktoken when a provider reports no usage, which the proxy cannot do.
   */
  selfLogged?: boolean;
}

/**
 * Build the `meta` bag for an LLM request, or undefined when logging is off — an undefined field is
 * dropped by the structured clone, so a disabled log adds nothing to the IPC payload at all.
 */
export function buildLogMeta(meta: UsageLogMeta): UsageLogMeta | undefined {
  if (!cachedEnabled || !bridge()) return undefined;
  return meta;
}

/** Loosely typed on purpose: `args` goes over as an object and is serialized + redacted main-side. */
type PendingEntry = Record<string, unknown> & { kind: UsageLogKind };

/**
 * Queue one entry. Fire-and-forget by design: the chat loop must not await a disk write, and losing a
 * log line is always preferable to delaying the turn that produced it.
 */
function push(entry: PendingEntry): void {
  const b = bridge();
  if (!b || !cachedEnabled) return;
  try {
    b.append({ ts: Date.now(), ...entry });
  } catch {
    /* a log that fails must not surface in the conversation */
  }
}

/**
 * Record one model invocation from the renderer.
 *
 * Used by the chat loop for every request it makes, whichever transport it took (see
 * UsageLogMeta.selfLogged). Requests that never pass through the renderer -- automation nodes, the
 * toolkit's own LLM-backed tools -- are recorded by the proxy in the main process instead.
 */
export function logModelCall(entry: {
  actor: string;
  model?: string;
  provider?: string;
  endpoint?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  estimated?: boolean;
  stream?: boolean;
  ms?: number;
  ok: boolean;
  error?: string;
  convId?: string;
  turnId?: string;
  source?: string;
}): void {
  push({ kind: "model", source: entry.source ?? "chat", ...entry });
}

/** Record one tool call. `actor` is "main" for the primary agent, "sub:<id>" for a delegation. */
export function logToolCall(entry: {
  actor: string;
  name: string;
  args?: Record<string, unknown>;
  ok: boolean;
  ms?: number;
  result?: string;
  resultTokens?: number;
  blocked?: boolean;
  error?: string;
  convId?: string;
  turnId?: string;
  source?: string;
}): void {
  push({
    kind: "tool",
    resultTokens: entry.resultTokens,
    source: entry.source ?? "chat",
    actor: entry.actor,
    name: entry.name,
    args: entry.args, // serialized + redacted by the main-process store
    ok: entry.ok,
    ms: entry.ms,
    blocked: entry.blocked,
    error: entry.error,
    convId: entry.convId,
    turnId: entry.turnId,
    resultChars: entry.result?.length,
    resultPreview: entry.result?.slice(0, 2000),
  });
}

/**
 * Record one per-round context-composition snapshot (Phase 1 diagnostics: measurement only).
 *
 * Emitted from the chat loop just before a request goes out, so the buckets reflect exactly what the
 * model was about to receive — including the tool-schema tax that the app's own context estimate never
 * counts. Off unless the usage-log flag is on, like every other writer here.
 */
export function logContextDiag(entry: {
  actor?: string;
  convId?: string;
  turnId?: string;
  model?: string;
  ctxWindow?: number;
  ctxSystem: number;
  ctxToolSchemas: number;
  ctxHistory: number;
  ctxToolOutputs: number;
  ctxSubagent: number;
  ctxTotal: number;
  ctxWire: number;
  rereads: number;
  msgCount: number;
}): void {
  push({ kind: "context", source: "chat", actor: entry.actor ?? "main", ...entry });
}

/** Record one completed delegation: what it was asked to do, and what it cost. */
export function logSubagentRun(entry: {
  agent: string;
  task: string;
  rounds: number;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ms: number;
  ok: boolean;
  error?: string;
  convId?: string;
  turnId?: string;
}): void {
  push({ kind: "subagent", source: "chat", actor: `sub:${entry.agent}`, ...entry });
}

// ── Reading (settings viewer) ──────────────────────────────────────────────────────────────────

export async function listUsageLogDays(): Promise<UsageLogDay[]> {
  return call((b) => b.days(), []);
}

export async function readUsageLog(opts: UsageLogReadOptions = {}): Promise<UsageLogPage> {
  return call((b) => b.read(opts), { day: opts.day ?? "", total: 0, matched: 0, entries: [] });
}

export async function getUsageLogStats(day?: string): Promise<UsageLogStats | null> {
  return call((b) => b.stats(day), null);
}

export async function clearUsageLog(day?: string): Promise<number> {
  return call((b) => b.clear(day), 0);
}

export async function getUsageLogDir(): Promise<string> {
  return call((b) => b.dir(), "");
}

export async function openUsageLogDir(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const b = bridge();
  if (!b) return { ok: false, error: "unavailable" };
  try {
    return await b.openDir();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
