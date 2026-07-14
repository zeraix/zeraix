/**
 * Renderer-side wrapper for accessing the AI tool set.
 *
 * The tools run in the Electron main process (see electron/tools/aiToolkit.mjs) and are exposed via preload as
 * `window.aiTools`. Available only inside Electron; in a browser / Web deployment `isToolkitAvailable()` is false.
 *
 * Typical usage:
 *   const tools = await listTools("anthropic");   // the tools declaration sent to the LLM
 *   // after the model returns tool_use:
 *   const { content } = await callTool(name, input); // feed content back as tool_result
 */

/** A single tool declaration (raw form: name / description / JSON-Schema parameters). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export type ToolFormat = "raw" | "openai" | "anthropic";

/** Tool execution result: content is text that can be fed straight back to the model; ok=false means an error occurred (content is the error message). */
export interface ToolResult {
  ok: boolean;
  content: string;
}

interface AiToolsBridge {
  list(format?: ToolFormat): Promise<unknown[]>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  getWorkingDir(): Promise<string>;
  setWorkingDir(dir: string): Promise<string>;
  chooseWorkingDir(): Promise<string | null>;
  defaultWorkingDir(): Promise<string>;
  getPathForFile?(file: File): string;
  saveAttachment?(payload: { name: string; srcPath: string }): Promise<string>;
  wsReadDir?(relPath?: string): Promise<WsEntry[]>;
  wsReadFile?(relPath: string): Promise<WsReadFileResult>;
  wsWriteFile?(relPath: string, content: string): Promise<WsWriteResult>;
}

/** Workspace directory entry (for the file tree). */
export interface WsEntry {
  name: string;
  isDir: boolean;
}
/** Result of reading a file (including an openability check). */
export type WsReadFileResult =
  | { ok: true; editable: true; content: string; size: number }
  | { ok: false; reason: string; size?: number };
/** Result of saving a file. */
export type WsWriteResult = { ok: boolean; error?: string };

/** Generic "renderer → main process" bulk-data transfer (MessagePort transfer, avoiding a full structured-clone copy). */
interface TransferBridge {
  toMain(kind: string, meta: unknown, buffer: ArrayBuffer, timeoutMs?: number): Promise<unknown>;
}

declare global {
  interface Window {
    aiTools?: AiToolsBridge;
    transfer?: TransferBridge;
  }
}

/** Whether the current environment provides the tool set (Electron only). */
export function isToolkitAvailable(): boolean {
  return typeof window !== "undefined" && !!window.aiTools;
}

function bridge(): AiToolsBridge {
  if (!isToolkitAvailable()) {
    throw new Error("AI toolkit is only available inside the Electron app");
  }
  return window.aiTools!;
}

/** List the tool declarations in the target LLM's format. The raw form can be asserted as ToolSchema[]. */
export function listTools(format: "raw"): Promise<ToolSchema[]>;
export function listTools(format?: ToolFormat): Promise<unknown[]>;
export function listTools(format: ToolFormat = "raw"): Promise<unknown[]> {
  return bridge().list(format);
}

/** Call a tool by name. On error it does not throw; it uniformly returns { ok:false, content } for easy feeding back to the model. */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  if (!isToolkitAvailable()) {
    return { ok: false, content: "AI toolkit is only available inside the Electron app" };
  }
  return bridge().call(name, args);
}

/** List the direct children of a workspace directory (relative to the working dir), for expanding the file tree level by level. Returns empty outside Electron. */
export function wsReadDir(relPath = ""): Promise<WsEntry[]> {
  return window.aiTools?.wsReadDir?.(relPath) ?? Promise.resolve([]);
}
/** Read a workspace file for viewing / editing (including an openability check). Returns not-openable outside Electron. */
export function wsReadFile(relPath: string): Promise<WsReadFileResult> {
  return (
    window.aiTools?.wsReadFile?.(relPath) ??
    Promise.resolve({ ok: false as const, reason: "仅 Electron 应用内可用" })
  );
}
/** Save a workspace file (the user's direct edit in the editor). Returns failure outside Electron. */
export function wsWriteFile(relPath: string, content: string): Promise<WsWriteResult> {
  return (
    window.aiTools?.wsWriteFile?.(relPath, content) ??
    Promise.resolve({ ok: false, error: "仅 Electron 应用内可用" })
  );
}

export function getWorkingDir(): Promise<string> {
  return bridge().getWorkingDir();
}
export function setWorkingDir(dir: string): Promise<string> {
  return bridge().setWorkingDir(dir);
}
/** Pop up the native directory picker so the user can choose the working directory. Returns the selected path; returns null if the user cancels. */
export function chooseWorkingDir(): Promise<string | null> {
  return bridge().chooseWorkingDir();
}
/** Everyday mode: create and set a default working directory under the install directory (used when the user hasn't picked a folder), returning its absolute path. */
export function defaultWorkingDir(): Promise<string> {
  return bridge().defaultWorkingDir();
}
/** Get the host's real path for a dropped / selected file (empty string if none). Used to persist efficiently by path, avoiding byte transfer.
 *  Must be called in the renderer with the original File object (Electron webUtils); returns an empty string in a non-Electron environment. */
export function getPathForFile(file: File): string {
  try {
    return window.aiTools?.getPathForFile?.(file) ?? "";
  } catch {
    return "";
  }
}
/** Generic "renderer → main process" bulk-data transfer: hand over ArrayBuffer ownership to the main process's
 *  kind handler via MessagePort transfer (see electron/transferBridge.mjs), avoiding ipcRenderer.invoke's full structured-clone copy.
 *  Returns the handler's result. Suited for transferring data whose bytes live only in renderer memory (synthesized files / generated Blobs, etc.). Electron only. */
export function transferToMain<T = unknown>(
  kind: string,
  meta: unknown,
  buffer: ArrayBuffer,
  timeoutMs?: number,
): Promise<T> {
  const t = window.transfer;
  if (!t) return Promise.reject(new Error("transfer channel unavailable (not Electron, or the preload version is too old)"));
  return t.toMain(kind, meta, buffer, timeoutMs) as Promise<T>;
}

/** Save an attachment into the current working directory (filename sanitization + de-duplication of name clashes), returning the saved absolute path. Call before sending:
 *  once on disk, the model can process the file directly with file tools / sandbox commands (the workdir is already mounted into the sandbox).
 *   - srcPath (real on-disk files and very large files): the main process does a kernel-level copy by host path, with bytes not going through IPC;
 *   - bytes (synthesized files with no host path, dragged out of a webview / generated Blobs): hand over the bytes via the generic transfer channel using MessagePort
 *     (zero-copy semantics), not via ipcRenderer.invoke which would make a full copy. */
export function saveAttachment(payload: {
  name: string;
  srcPath?: string;
  bytes?: ArrayBuffer;
}): Promise<string> {
  if (payload.srcPath) {
    const b = bridge();
    if (!b.saveAttachment) return Promise.reject(new Error("saveAttachment is unavailable (the preload version is too old)"));
    return b.saveAttachment({ name: payload.name, srcPath: payload.srcPath });
  }
  if (payload.bytes) {
    return transferToMain<string>("save-attachment", { name: payload.name }, payload.bytes);
  }
  return Promise.reject(new Error("saveAttachment requires srcPath or bytes"));
}

/** Run the tool calls returned by the model in batch, preserving order, returning each one's result. */
export async function runToolCalls(
  calls: Array<{ id?: string; name: string; args?: Record<string, unknown> }>,
): Promise<Array<{ id?: string; name: string; result: ToolResult }>> {
  const out: Array<{ id?: string; name: string; result: ToolResult }> = [];
  for (const c of calls) {
    out.push({ id: c.id, name: c.name, result: await callTool(c.name, c.args ?? {}) });
  }
  return out;
}
