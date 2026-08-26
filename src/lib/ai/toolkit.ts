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
  call(name: string, args?: Record<string, unknown>, callId?: string): Promise<ToolResult>;
  cancelCall?(callId: string): void;
  getWorkingDir(): Promise<string>;
  setWorkingDir(dir: string): Promise<string>;
  chooseWorkingDir(): Promise<string | null>;
  defaultWorkingDir(): Promise<string>;
  getPathForFile?(file: File): string;
  saveAttachment?(payload: { name: string; srcPath?: string; url?: string; bytes?: ArrayBuffer; subdir?: string }): Promise<string>;
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

/** Monotonic id per tool call, used only to address a cancellation at the other end of the IPC. */
let toolCallSeq = 0;

/**
 * Call a tool by name. On error it does not throw; it uniformly returns { ok:false, content } for easy feeding back to the model.
 *
 * `signal` makes the call interruptible. The IPC promise itself cannot be cancelled, so aborting sends a
 * separate ai-tools:cancel message carrying this call's id; the main process kills the work (for
 * run_command, the child process itself) and this promise then resolves normally with whatever the command
 * managed to produce. That is deliberate — the model still gets a tool result explaining that the user
 * stopped it, rather than a dangling tool_call the next request would have to be repaired around.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!isToolkitAvailable()) {
    return { ok: false, content: "AI toolkit is only available inside the Electron app" };
  }
  const b = bridge();
  if (!signal || !b.cancelCall) return b.call(name, args);
  const callId = `t${++toolCallSeq}`;
  // Already stopped before we got here: nothing has been started, so say so without touching the tool.
  if (signal.aborted) return { ok: false, content: "The user stopped this operation before it started." };
  const cancel = () => b.cancelCall?.(callId);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await b.call(name, args, callId);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** List the direct children of a workspace directory (relative to the working dir), for expanding the file tree level by level. Returns empty outside Electron. */
export function wsReadDir(relPath = ""): Promise<WsEntry[]> {
  return window.aiTools?.wsReadDir?.(relPath) ?? Promise.resolve([]);
}
/** Read a workspace file for viewing / editing (including an openability check). Returns not-openable outside Electron. */
export function wsReadFile(relPath: string): Promise<WsReadFileResult> {
  return (
    window.aiTools?.wsReadFile?.(relPath) ??
    Promise.resolve({ ok: false as const, reason: "Only available in the Electron app" })
  );
}
/** Save a workspace file (the user's direct edit in the editor). Returns failure outside Electron. */
export function wsWriteFile(relPath: string, content: string): Promise<WsWriteResult> {
  return (
    window.aiTools?.wsWriteFile?.(relPath, content) ??
    Promise.resolve({ ok: false, error: "Only available in the Electron app" })
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
  url?: string;
  /** Optional folder under the working directory (the media library uses `.zeraix-media`). Guarded in main. */
  subdir?: string;
}): Promise<string> {
  // Threaded through every branch below rather than spread once, because each rebuilds the payload by hand —
  // a field added to only some of them is a save that silently lands in the wrong place for pasted images
  // but not dragged ones, which is exactly the kind of bug nobody reproduces on purpose.
  const subdir = payload.subdir;
  if (payload.srcPath) {
    const b = bridge();
    if (!b.saveAttachment) return Promise.reject(new Error("saveAttachment is unavailable (the preload version is too old)"));
    return b.saveAttachment({ name: payload.name, srcPath: payload.srcPath, subdir });
  }
  if (payload.bytes) {
    // Byte-only attachments (pasted screenshots, web-uploaded images) hand their bytes to the main
    // process. Prefer the zero-copy MessagePort transfer channel, but fall back to the plain invoke
    // channel (a structured-clone copy) when that channel is missing or fails — otherwise the save is
    // silently lost and the model later reports the image "isn't in the working directory" and fabricates
    // a replacement. This is why paste / web uploads failed while Electron file drags (srcPath) worked.
    const bytes = payload.bytes;
    if (window.transfer) {
      return transferToMain<string>("save-attachment", { name: payload.name, subdir }, bytes).catch((e) => {
        const b = bridge();
        // Retry via invoke only if the bytes are still intact (transfer neuters the buffer once it posts;
        // an up-front failure leaves byteLength untouched).
        if (b.saveAttachment && bytes.byteLength > 0) return b.saveAttachment({ name: payload.name, bytes, subdir });
        throw e;
      });
    }
    const b = bridge();
    if (!b.saveAttachment) return Promise.reject(new Error("saveAttachment is unavailable (the preload version is too old)"));
    return b.saveAttachment({ name: payload.name, bytes, subdir });
  }
  if (payload.url) {
    // A URL-only image (edit/resend, home-page handoff, restored history) — no local bytes to hand over.
    // The main process downloads the link itself (no renderer CORS, no large base64 over IPC) and writes
    // it into the working directory, so it becomes an editable file, not just something the model can view.
    const b = bridge();
    if (!b.saveAttachment) return Promise.reject(new Error("saveAttachment is unavailable (the preload version is too old)"));
    return b.saveAttachment({ name: payload.name, url: payload.url, subdir });
  }
  return Promise.reject(new Error("saveAttachment requires srcPath, bytes, or url"));
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
