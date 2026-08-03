/**
 * Renderer bridge to the MCP connection manager (main process: electron/mcp/*).
 *
 * Scope on purpose: this file configures servers and reports their connection state. It never sees a
 * tool call -- an MCP server's tools reach the model through the ordinary listTools/runTool path in
 * aiToolkit, so nothing in the chat loop imports this.
 *
 * Secrets never arrive here. `envKeys` / `headerKeys` say *which* variables and headers are set so the
 * UI can show "2 variables set"; the values stay in the main process.
 *
 * Outside Electron (browser build) every call is an inert no-op returning empty state, matching how
 * usageLog.ts and localModel.ts degrade.
 */

/** stdio spawns a child process; http talks Streamable HTTP to a hosted service. */
export type McpKind = "stdio" | "http";

/** Configuration as the UI sees it -- see electron/mcp/config.mjs publicServer(). */
export interface McpServer {
  id: string;
  kind: McpKind;
  url: string;
  command: string;
  args: string[];
  cwd: string;
  envKeys: string[];
  headerKeys: string[];
  disabled: boolean;
  /** The user has seen this exact command line / URL and accepted that it may run. */
  approved: boolean;
  timeoutMs: number;
}

export type McpConnStatus = "idle" | "connecting" | "ready" | "error" | "disabled";

export interface McpTool {
  /** Namespaced name as the model sees it: mcp__<server>__<tool>. */
  name: string;
  /** The server's own name for it. */
  raw: string;
  description: string;
}

/** Live connection state, pushed from the main process whenever it changes. */
export interface McpStatus {
  id: string;
  status: McpConnStatus;
  error: string;
  /** Tail of the server's stderr -- usually the real reason a stdio server failed to start. */
  stderr: string;
  pid: number | null;
  connectedAt: number;
  tools: McpTool[];
}

export interface McpSnapshot {
  servers: McpServer[];
  status: McpStatus[];
}

/** What upsert accepts. Exactly one of `command` / `url`. */
export interface McpServerInput {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

type Result = { ok: boolean; error?: string } & Partial<McpSnapshot>;

interface McpBridge {
  list(): Promise<McpSnapshot>;
  upsert(id: string, config: McpServerInput): Promise<Result>;
  remove(id: string): Promise<Result>;
  approve(id: string, approved: boolean): Promise<Result>;
  setEnabled(id: string, enabled: boolean): Promise<Result>;
  connect(id: string): Promise<Result>;
  disconnect(id: string): Promise<Result>;
  import(blob: unknown): Promise<{ ok: boolean; error?: string; added?: string[]; skipped?: string[] } & Partial<McpSnapshot>>;
  configPath(): Promise<string>;
  openConfig(): Promise<{ ok: boolean; path: string; error?: string }>;
  onStatus(cb: (status: McpStatus[]) => void): () => void;
}

declare global {
  interface Window {
    mcp?: McpBridge;
  }
}

const EMPTY: McpSnapshot = { servers: [], status: [] };

function bridge(): McpBridge | null {
  return typeof window !== "undefined" && window.mcp ? window.mcp : null;
}

/** Whether the MCP panel has anything to talk to (false in the browser build). */
export function isMcpAvailable(): boolean {
  return bridge() !== null;
}

/**
 * Call the bridge, falling back instead of throwing. preload.cjs is re-read on every window reload
 * while main.mjs is not, so a dev reload can leave `window.mcp` present with no handler behind it;
 * that skew has to render as an empty panel, not a rejected promise.
 */
async function call<T>(fn: (b: McpBridge) => Promise<T>, fallback: T): Promise<T> {
  const b = bridge();
  if (!b) return fallback;
  try {
    return await fn(b);
  } catch {
    return fallback;
  }
}

export function listMcp(): Promise<McpSnapshot> {
  return call((b) => b.list(), EMPTY);
}

export function upsertMcpServer(id: string, config: McpServerInput): Promise<Result> {
  return call((b) => b.upsert(id, config), { ok: false, error: "unavailable" });
}

export function removeMcpServer(id: string): Promise<Result> {
  return call((b) => b.remove(id), { ok: false, error: "unavailable" });
}

export function approveMcpServer(id: string, approved: boolean): Promise<Result> {
  return call((b) => b.approve(id, approved), { ok: false, error: "unavailable" });
}

export function setMcpServerEnabled(id: string, enabled: boolean): Promise<Result> {
  return call((b) => b.setEnabled(id, enabled), { ok: false, error: "unavailable" });
}

export function connectMcpServer(id: string): Promise<Result> {
  return call((b) => b.connect(id), { ok: false, error: "unavailable" });
}

export function disconnectMcpServer(id: string): Promise<Result> {
  return call((b) => b.disconnect(id), { ok: false, error: "unavailable" });
}

export function importMcpServers(blob: unknown) {
  return call((b) => b.import(blob), { ok: false as boolean, error: "unavailable" as string | undefined });
}

export function openMcpConfig() {
  return call((b) => b.openConfig(), { ok: false, path: "", error: "unavailable" });
}

/** Subscribe to connection-state pushes; no-op unsubscribe outside Electron. */
export function onMcpStatus(cb: (status: McpStatus[]) => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onStatus(cb);
}

/**
 * Parse the command line a user types into `command` + `args`, honouring quotes so a Windows path
 * with spaces survives. Deliberately not a shell: no globbing, no operators -- the string goes to
 * spawn(), and pretending otherwise would make `rm -rf x && y` look like it works.
 */
export function parseCommandLine(input: string): { command: string; args: string[] } {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map((p) => (/^["']/.test(p) ? p.slice(1, -1) : p));
  return { command: clean[0] ?? "", args: clean.slice(1) };
}

/** `KEY=value` lines -> an env/header map. Blank lines and comments are ignored. */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
