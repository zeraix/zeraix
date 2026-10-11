/**
 * AI toolkit (executed in the main process).
 *
 * Exposes a set of "file / directory / command" tools for the LLM to call by name: the renderer
 * (sandboxed, no Node) calls `runTool(name, args)` via preload + IPC, while the actual fs /
 * child-process operations happen in the main process.
 *
 * Security constraints: all paths are confined to the "working directory" (WORKDIR); out-of-bounds
 * access is rejected. `run_command` also runs under WORKDIR, with a timeout and an output cap.
 * Call setWorkingDir when a broader scope is needed.
 *
 * Tool declarations follow the caller-provided fn(name, description, params, required) shape;
 * `list(format)` can directly produce the OpenAI / Anthropic tools structure.
 *
 * The toolkit outgrew one file, so it lives in several, and this file stays the one import path for all of it —
 * every caller's import is unchanged:
 *
 * - aiToolkit/workdir.mjs      the working directory and the read-only asset root (it owns both), the path guard
 *                             every tool goes through, and the sidebar's workspace file browsing.
 * - aiToolkit/llm.mjs          the helper-model config and the bounded calls made with it (owns LLM_CONFIG).
 * - aiToolkit/command.mjs      run_command, sandbox_tools, stop_service.
 * - aiToolkit/check.mjs        check_project, and the project-type detection project memory shares.
 * - aiToolkit/web.mjs          web_search, fetch_url, and the headless HTTP / HTML helpers behind them.
 * - aiToolkit/attachments.mjs  saving a chat attachment into the working directory.
 *
 * What stays here: the handler table and runTool, listTools, and the handlers that reach the host or the app
 * (project memory, open_path, page_console, MCP admin, plugins). The parts never import this file, so there
 * is no cycle; state lives in the part that owns it, and the others read it through that part's getters.
 */

import fs from "node:fs/promises";
import { constants as FS } from "node:fs";
import { pathToFileURL } from "node:url";
import { shell } from "electron";

// The toolkit's parts (see the header).
import { projectMemoryLlm, refineQuestion } from "./aiToolkit/llm.mjs";
import { ensureWorkdir, getAssetDir, getWorkingDir, resolveInside } from "./aiToolkit/workdir.mjs";
import { commandHandlers } from "./aiToolkit/command.mjs";
import { checkHandlers, detectCheckSteps } from "./aiToolkit/check.mjs";
import { throwIfAborted, webHandlers } from "./aiToolkit/web.mjs";

import { initEngine as engineInit } from "./sandbox/engine.mjs";
import { ensureProjectMemory, summarise as summariseMemory } from "./projectMemory/index.mjs";
import { rememberProject } from "./projectMemory/remember.mjs";
import { noteFileRead } from "./projectMemory/observations.mjs";
import { noteUserMessage } from "./projectMemory/conversation.mjs";
// MCP tools join the registry here rather than at each call site: the chat IPC (ipc/aiToolsIpc.mjs), the agent
// loop (agent/turn.mjs) and the automation dispatcher (automation/paths.mjs) all already go through
// listTools/runTool, so one merge lights MCP up in all three. See docs/mcp-integration.md.
import { callMcpTool, isMcpTool, listMcpTools } from "../mcp/client.mjs";
import { callPluginTool, describePluginTools, isPluginTool, listPluginTools } from "../plugins/tools.mjs";
// The other direction: tools for MANAGING MCP servers, so a user can connect one by asking in chat
// instead of filling in the settings form. Kept in its own module because it is the only part of the
// toolkit that writes app configuration and grants trust -- see its header for the two-gate model.
import { mcpAdminHandlers } from "./mcpAdmin.mjs";
// Rust Agent Runtime sidecar. Fails open on every path: a missing binary, a refused spawn, a protocol
// mismatch or a tool it does not implement all resolve to "the JS handler serves this call", so the
// only observable difference when it is unavailable is that it is not used. See its header and
// docs/agent-runtime-migration.md.
import {
  invalidateFileList as invalidateRustFileList,
  isReady as isRuntimeReady,
  missingRuntimeTools,
  tryRunTool,
} from "./rustRuntime.mjs";
// page_console's window lifecycle. Its own module because this one was already far past the file-size
// ceiling, and because a hidden BrowserWindow has to be leak-proof on every exit path.
import { capturePageConsole } from "./pageConsole.mjs";

// Command execution is abstracted into a pluggable engine (native = run directly on the host
// (legacy behavior); qemu = hardware-isolated VM, see the probing/selection in
// ./sandbox/engine.mjs). Here we re-export the engine layer's public interface unchanged, so
// existing imports in ipc/aiToolsIpc.mjs and main/shutdown.mjs (setServiceEventHandler / stopProcess / listProcesses /
// stopBackgroundProcs) keep working.
export {
  setServiceEventHandler,
  listProcesses,
  stopProcess,
  stopBackgroundProcs,
  disposeEngines,
  getEngineInfo,
  getSandboxStatus,
  setSandboxMode,
  onSandboxStatus,
  restartSandbox,
  sandboxVmInfo,
} from "./sandbox/engine.mjs";

/** Start the sandbox's background initialization (injecting a working-directory reader: on init it
 *  mounts and starts a long-lived sandbox for the current WORKDIR). */
export function initEngine() {
  return engineInit({ getWorkdir: getWorkingDir });
}

// The parts' public surface, re-exported unchanged.
export {
  setWorkingDir,
  getWorkingDir,
  wsReadDir,
  wsReadFile,
  wsWriteFile,
  setAssetDir,
  getAssetDir,
} from "./aiToolkit/workdir.mjs";
export { saveAttachment } from "./aiToolkit/attachments.mjs";
export { setLLMConfig, getLLMConfig, chatComplete, refineQuestion } from "./aiToolkit/llm.mjs";

// The encoding / line-ending preservation helpers and the unified-diff builder were here.
//
// They existed for write_file / edit_file / append_file, and every one of those is served by the Rust runtime
// now — agent-tools keeps the same guarantees in edittext.rs (BOM, CRLF, and the refusal to rewrite a
// non-UTF-8 file as UTF-8) and builds the diff there too. Nothing in this module edits file text any more.

// ── Tool implementations ──────────────────────────────────────────────────────
// Each implementation returns a "string" as the tool result text for the model; exceptions are caught uniformly by runTool.
const handlers = {
  /**
   * Question refinement: rewrite the session's vague / colloquial original question, together with
   * optional context, into a clear, specific, unambiguous question that is easy to search and answer.
   * Returns only the refined question text.
   */
  async refine_question(args = {}, { signal } = {}) {
    return refineQuestion(args, { signal });
  },

  /**
   * Project memory: bring ZERAIX.md at the working-directory root up to date, and return it.
   *
   * Freshness is pulled, not pushed: every section of the document declares which files it is a
   * function of, and only sections whose declared inputs actually moved get rebuilt (see
   * ./projectMemory/). An unchanged project costs a handful of stat/read calls and no write at
   * all. Hand-authored sections are seeded once and never machine-written after that.
   */
  async init_command({ refresh } = {}) {
    const result = await ensureProjectMemory({
      workdir: getWorkingDir(),
      mode: refresh ? "full" : "auto",
      llm: projectMemoryLlm(),
      detectCheckSteps,
    });
    return `${summariseMemory(result)}\n\n${result.markdown}`;
  },

  /**
   * Offer a user message to conversational capture.
   *
   * Deliberately absent from TOOLS: the chat page calls this over IPC after the user sends, not the
   * model. Returns at once — the gate and any extraction run in the background, so a slow or failing
   * capture can never delay a message.
   */
  async note_conversation({ text } = {}) {
    noteUserMessage({
      workdir: getWorkingDir(),
      text,
      llm: projectMemoryLlm(),
    });
    return "ok";
  },

  /**
   * Write back into project memory what this session learned.
   *
   * The generated sections can only ever describe what is derivable from the repository's shape.
   * Anything the model works out by actually reading code — or anything the user explains — dies
   * with the turn unless it is recorded here.
   */
  async remember_project({ note, module: mod } = {}) {
    const result = await rememberProject({
      workdir: getWorkingDir(),
      note,
      module: mod,
      ensure: () =>
        ensureProjectMemory({
          workdir: getWorkingDir(),
          mode: "auto",
          llm: projectMemoryLlm(),
          detectCheckSteps,
        }),
    });
    if (!result.ok) throw new Error(result.message);
    return result.message;
  },

  // Returns a line range rather than always the whole file: a targeted read keeps the model's context
  // small, and — unlike a downstream character cap — never removes the middle of a file it is reasoning about.

  // Open a file / folder in the HOST's default application (always runs on the host, never the sandbox).
  // "Opening" is a host GUI action; run_command in daily mode runs inside a headless Linux VM and cannot
  // launch host apps — so this is the correct tool for "open / show / play this file for the user".
  async open_path({ path: p }) {
    const abs = resolveInside(p);
    await fs.access(abs); // exists? (throws a clear error otherwise, incl. "outside working directory")
    const err = await shell.openPath(abs); // "" on success; a non-empty string is the failure reason
    if (err) throw new Error(`failed to open in the default application: ${err}`);
    return `Opened in the host's default application: ${abs}`;
  },



  // append_file / delete_file / copy_file / move_file / create_directory were here. They are served by the
  // Rust runtime now (agent-tools: append_file.rs, fsops.rs), which is what put every path a tool touches
  // behind one Workspace — and with it the read-only asset root these handlers enforced through
  // resolveInside({ write: true }) and the migrated tools had lost.

  // run_command / sandbox_tools / stop_service (./aiToolkit/command.mjs), check_project (./aiToolkit/check.mjs) and
  // web_search / fetch_url (./aiToolkit/web.mjs) live with the helpers only they use, and are spread in here in
  // the order they were written before the split.
  ...commandHandlers,
  ...checkHandlers,
  ...webHandlers,

  /**
   * Load a page headlessly (JavaScript runs) and return what it logged: console output, uncaught errors,
   * unhandled rejections, failed requests. The window lifecycle lives in ./pageConsole.mjs; what belongs
   * here is turning the model's `url` into something safe to load — an http(s) URL, or a path resolved
   * inside the working directory like every other path this toolkit accepts, never a raw file:// the model
   * composed itself.
   */
  async page_console({ url, wait_ms, level, max } = {}, { signal } = {}) {
    const raw = String(url ?? "").trim();
    if (!raw) throw new Error("url is required");
    let target = raw;
    if (!/^https?:\/\//i.test(raw)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        throw new Error("url must be an http(s) URL, or a file path inside the working directory");
      }
      const abs = resolveInside(raw);
      await fs.access(abs, FS.R_OK); // fail with "no such file" rather than a blank about:blank capture
      target = pathToFileURL(abs).href;
    }
    throwIfAborted(signal);
    return capturePageConsole({ url: target, waitMs: wait_ms, level, max, signal });
  },

  // mcp_discover / mcp_connect. Spread rather than written inline: they operate on app configuration
  // and the MCP connection pool, not on the working directory like everything above them.
  ...mcpAdminHandlers,

  /**
   * Discovery for installed plugin tools. The counterpart of mcp_tools, and declared for the same
   * reason: the tools themselves are routed, so without this the model has no way to learn that the
   * user has installed anything at all.
   */
  plugin_tools({ name, plugin } = {}) {
    return describePluginTools({ name: String(name ?? ""), plugin: String(plugin ?? "") });
  },
};

/**
 * Execute a tool. Catches exceptions uniformly and returns { ok, content }, where content is the
 * result text that can be fed back to the model.
 */
/** Tools that change the working directory's file list (add / delete / move / possibly create files): invalidate the file-list cache after running. */
const FILE_LIST_MUTATORS = new Set([
  "write_file",
  "append_file",
  "delete_file",
  "copy_file",
  "move_file",
  "create_directory",
  "run_command",
  "init_command",
  "remember_project",
]);

/**
 * `signal` is the caller's cancellation (the renderer's Stop button, relayed over IPC — see
 * ai-tools:cancel in ipc/aiToolsIpc.mjs). It is handed to the handler as a second argument rather than folded into
 * `args`, because `args` is the model's own JSON and nothing from the model may be mistaken for a
 * cancellation. Handlers that cannot be interrupted simply ignore it; today only run_command reads it,
 * since it is the only one that can block for minutes.
 */
export async function runTool(name, args = {}, { signal } = {}) {
  // Before the native lookup: an MCP tool is namespaced (`mcp__<server>__<tool>`) so it can never
  // collide with a handler, and callMcpTool honours runTool's { ok, content } contract for every
  // failure mode -- an external server must not be able to abort a turn by throwing.
  if (isMcpTool(name)) return callMcpTool(name, args ?? {});
  // Same arrangement for installed plugins: `plugin__<publisher>_<name>__<capability>` cannot collide
  // with a handler, and callPluginTool honours the { ok, content } contract for every failure mode.
  if (isPluginTool(name)) return callPluginTool(name, args ?? {});
  try {
    await ensureWorkdir();
    // The Rust Agent Runtime is asked FIRST, and for most tools it is the only implementation there is.
    //
    // The order matters now in a way it did not before. While every tool had a JS handler, the handler lookup
    // could come first and the sidecar was an optional shortcut. The handlers for the migrated tools are gone
    // (TODO §0.2 F1), so looking them up first would report `read_file` as an unknown tool and never reach the
    // runtime that implements it.
    //
    // What is left below this line is for the tools the runtime does NOT serve — `append_file`, the ones that
    // touch app state, MCP and plugin tools — which still have handlers of their own.
    // ASSET_DIR travels with WORKDIR: the runtime's Workspace enforces both roots, and without this the
    // media library is simply not reachable — which is how reads of it broke when the file tools moved
    // into Rust and left the second root behind in resolvePath.
    const offloaded = await tryRunTool(name, args ?? {}, { signal, workdir: getWorkingDir(), assetDir: getAssetDir() });
    if (offloaded) {
      if (FILE_LIST_MUTATORS.has(name)) {
        invalidateRustFileList(getWorkingDir());
      }
      if (name === "read_file" && offloaded.ok) {
        noteFileRead({
          workdir: getWorkingDir(),
          relPath: args?.path,
          text: offloaded.content,
          llm: projectMemoryLlm(),
        });
      }
      return offloaded;
    }

    const handler = handlers[name];
    if (!handler) {
      // No handler, and the runtime did not serve it. There are THREE ways to get here and they need
      // different answers — an earlier version collapsed two of them into "Unknown tool", which told a model
      // that `write_file` does not exist while it was staring at the declaration for it, and told the user
      // nothing at all about the actual cause.
      if (!isRuntimeReady()) {
        return {
          ok: false,
          content:
            `${name} is served by the Zeraix agent runtime, which is not running. No fallback exists for it — ` +
            `the JS implementations were removed at 2.0. Check the runtime binary is installed and see the ` +
            `logs for why it did not start.`,
        };
      }
      // The runtime is up but does not implement this tool, while the app has no handler either. In practice
      // that means the binary predates the tool: it was built when this name still lived in JavaScript.
      if (missingRuntimeTools().includes(name)) {
        return {
          ok: false,
          content:
            `${name} exists but the running agent runtime does not serve it — the runtime binary is older ` +
            `than the app. This is a build problem, not a mistake in the call: rebuilding the runtime ` +
            `(\`npm run build:runtime\`) fixes it. Do not retry this call or work around it; tell the user.`,
        };
      }
      return { ok: false, content: `Unknown tool: ${name}` };
    }
    const content = await handler(args ?? {}, { signal });
    if (FILE_LIST_MUTATORS.has(name)) {
      invalidateRustFileList(getWorkingDir());
    }
    // Observe reads so project memory can learn from what was actually opened. This is the right
    // layer for it: sub-agent tool calls come through here too, and sub-agents do most of the
    // exploring. Fire-and-forget — it can neither delay nor fail this call.
    if (name === "read_file") {
      noteFileRead({
        workdir: getWorkingDir(),
        relPath: args?.path,
        text: content,
        llm: projectMemoryLlm(),
      });
    }
    return { ok: true, content: String(content) };
  } catch (e) {
    return { ok: false, content: `Error in ${name}: ${e?.message ?? String(e)}` };
  }
}

// ── Tool declarations (JSON Schema) ────────────────────────────────────────────

/** Corresponds one-to-one with the caller's C++ declarations. */
import { TOOLS } from "./toolSchemas.mjs";

/**
 * Return the tool declarations in the target LLM format:
 *  - "raw"       : { name, description, parameters }
 *  - "openai"    : { type: "function", function: { name, description, parameters } }
 *  - "anthropic" : { name, description, input_schema }
 */
export function listTools(format = "raw") {
  // Native tools first, then whatever the connected MCP servers currently expose. listMcpTools() is
  // synchronous and cache-backed: this runs once per turn, and a server that is still connecting
  // simply contributes nothing this time round rather than delaying the request.
  const all = [...TOOLS, ...listMcpTools(), ...listPluginTools()];
  if (format === "openai") {
    return all.map((t) => ({ type: "function", function: t }));
  }
  if (format === "anthropic") {
    return all.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return all;
}
