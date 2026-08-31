// Preload (sandboxed, CommonJS): safely exposes the main process's AI toolkit to the renderer.
// The renderer lists declarations / calls by name via window.aiTools; the actual fs / child-process operations all run in the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("aiTools", {
  /** List tool declarations. format: "raw" | "openai" | "anthropic" (default raw). */
  list: (format = "raw") => ipcRenderer.invoke("ai-tools:list", format),
  /** Call a tool by name; returns { ok, content }. content is the result text ready to feed back to the model.
   *  callId is optional and only needed by a caller that may want to cancel — pass the same id to cancelCall. */
  call: (name, args = {}, callId) => ipcRenderer.invoke("ai-tools:call", { name, args, callId }),
  /** Stop an in-flight tool call (the user's Stop button). A running command is killed, not just abandoned;
   *  ids that already finished are ignored. One-way, matching abortChatStream. */
  cancelCall: (callId) => ipcRenderer.send("ai-tools:cancel", callId),
  /** Read / set the working directory (all file operations are confined within it). */
  getWorkingDir: () => ipcRenderer.invoke("ai-tools:get-workdir"),
  setWorkingDir: (dir) => ipcRenderer.invoke("ai-tools:set-workdir", dir),
  /** Workspace file browsing: structured directory listing / read a file with an openability check / save a file (for the sidebar file tree + the right-hand editor). */
  wsReadDir: (relPath = "") => ipcRenderer.invoke("workspace:read-dir", relPath),
  wsReadFile: (relPath) => ipcRenderer.invoke("workspace:read-file", relPath),
  wsWriteFile: (relPath, content) => ipcRenderer.invoke("workspace:write-file", { path: relPath, content }),
  /** Get the host's real path of a dragged-in / selected File (Electron webUtils; returns an empty string for synthetic/clipboard files).
   *  Once the renderer has the path, it can have the main process copy by path, avoiding passing large file bytes through IPC structured clone. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  /** Save an attachment by host path into the current working directory (filename sanitization + de-duplication of name collisions); returns the saved absolute path.
   *  payload: { name, srcPath } — a kernel-level copy in the main process, bytes do not go through IPC. Synthetic files without a host path go through
   *  window.transfer.toMain("save-attachment", …) (see the transfer world below, which hands off bytes via transfer). */
  saveAttachment: (payload) => ipcRenderer.invoke("ai-tools:save-attachment", payload),
  /** Inject / read the LLM config used by tools such as refine_question when they call the model a second time. */
  setLLMConfig: (cfg) => ipcRenderer.invoke("ai-tools:set-llm-config", cfg),
  getLLMConfig: () => ipcRenderer.invoke("ai-tools:get-llm-config"),
  /** Pop up the native directory picker; if the user selects one, set it as the working directory and return the path; return null on cancel. */
  chooseWorkingDir: () => ipcRenderer.invoke("ai-tools:choose-workdir"),
  /** Daily mode: create and return the default working directory under the install directory (used when the user has not chosen a folder). */
  defaultWorkingDir: () => ipcRenderer.invoke("ai-tools:default-workdir"),
  /** Stop a background service (by pid). */
  stopProcess: (pid) => ipcRenderer.invoke("ai-tools:stop-process", pid),
  /** List current background services [{ pid, url, command }]. */
  listProcesses: () => ipcRenderer.invoke("ai-tools:list-processes"),
  /** Subscribe to background-service start/stop events { type:'started'|'stopped', pid, url?, command? }; returns an unsubscribe function. */
  onServiceEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("services:event", handler);
    return () => ipcRenderer.removeListener("services:event", handler);
  },
});

// Project-level skill discovery: detects skill files in directories such as .claude/.cursor/.zeraix, and manages the user's
// "add / ignore" decisions in .zeraix/config.json. See electron/tools/projectSkills.mjs for the main-process implementation.
contextBridge.exposeInMainWorld("projectSkills", {
  /** Discover skills in the current project (including decided / pending status): { workdir, skills:[{path,source,name,description,status}] }. */
  discover: () => ipcRenderer.invoke("project-skills:discover"),
  /** Record a decision for a skill: enabled=true to add, false to ignore. Written to .zeraix/config.json. */
  decide: (path, enabled) => ipcRenderer.invoke("project-skills:decide", { path, enabled }),
  /** Read the raw content of a skill file (for "view content"). */
  read: (path) => ipcRenderer.invoke("project-skills:read", path),
  /** Enabled project skills (including instruction body), for feeding to the agent: [{path,source,name,description,instructions}]. */
  loadEnabled: () => ipcRenderer.invoke("project-skills:load-enabled"),
});

// Generic "renderer → main process" large-data transfer: hands off ArrayBuffer ownership via MessagePort transfer,
// avoiding the wholesale copy of ipcRenderer.invoke's structured clone. See electron/transferBridge.mjs on the main-process side.
// Each call spins up a one-shot MessageChannel: port2 is handed to the main process along with the metadata, port1 sends the bytes via transfer,
// the main process routes and handles by kind, then returns the result over the same port, after which both ends close.
contextBridge.exposeInMainWorld("transfer", {
  /** Hand off an ArrayBuffer to the main process's kind handler via transfer and await the result (Promise).
   *  @param {string} kind Handler identifier (matching the name registered by the main process's onTransfer)
   *  @param {object} meta Small structured metadata (structured-cloned along with the port; do not put large objects here)
   *  @param {ArrayBuffer} buffer The bytes to hand off (invalidated in the renderer after the call; do not reference it again)
   *  @param {number} [timeoutMs=60000] Timeout (prevents hanging when the main process does not respond). */
  toMain: (kind, meta, buffer, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      const finish = (fn, arg) => {
        clearTimeout(timer);
        try {
          port1.close();
        } catch {
          /* already closed */
        }
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`transfer "${kind}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      port1.onmessage = (e) => {
        const r = e.data || {};
        if (r.ok) finish(resolve, r.value);
        else finish(reject, new Error(r.error || `transfer "${kind}" failed`));
      };
      try {
        ipcRenderer.postMessage("transfer:port", { kind, meta }, [port2]); // hand off the port + metadata
        port1.postMessage(buffer, [buffer]); // transfer hands off byte ownership (zero-copy semantics)
      } catch (err) {
        finish(reject, err instanceof Error ? err : new Error(String(err)));
      }
    }),
});

// LLM request proxy: the main process forwards OpenAI-compatible requests, bypassing renderer CORS.
contextBridge.exposeInMainWorld("llm", {
  chat: (req) => ipcRenderer.invoke("llm:chat", req),
  // Streaming: chatStream initiates (resolves when the stream ends); onChatChunk subscribes to increments (returns an unsubscribe function); abortChatStream interrupts.
  chatStream: (id, req) => ipcRenderer.invoke("llm:chat:stream", { id, req }),
  onChatChunk: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("llm:chat:chunk", listener);
    return () => ipcRenderer.removeListener("llm:chat:chunk", listener);
  },
  abortChatStream: (id) => ipcRenderer.send("llm:chat:abort", id),
});

// Sub-agent scheduling in the Rust runtime (Stage 4b). The runtime decides whether/when/how many; this
// window still runs each delegation, because that means holding a model conversation.
//
// `onRun` is the inbound half and the reason this is not just three invokes: the runtime ASKS for work
// and blocks a job on the answer, so every delegation handed over here must end in exactly one `reply`.
// Exposed ONLY when opted in. The renderer decides which scheduler to use by asking whether this
// object exists, so gating here is what actually keeps the runtime path off -- a flag that merely
// changed a log line would leave the most-used path in the app switched on by default, which is the
// opposite of what subagentBridge.mjs promises.
const SUBAGENTS_ENABLED = ["1", "on", "true"].includes(
  String(process.env.ZERAIX_RUST_SUBAGENTS ?? "").trim().toLowerCase(),
);
if (SUBAGENTS_ENABLED) contextBridge.exposeInMainWorld("subagents", {
  spawn: (turnId, jobs) => ipcRenderer.invoke("subagent:spawn", { turnId, jobs }),
  join: (turnId, opts) => ipcRenderer.invoke("subagent:join", { turnId, ...opts }),
  cancel: (turnId, reason) => ipcRenderer.invoke("subagent:cancel", { turnId, reason }),
  onRun: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("subagent:run", listener);
    return () => ipcRenderer.removeListener("subagent:run", listener);
  },
  // One-way, like llm:chat:abort: this settles a promise created by a different call, so there is no
  // invoke to reply to.
  reply: (requestId, body) => ipcRenderer.send("subagent:reply", { requestId, ...body }),
});

// OSS upload proxy: the main process PUTs to a presigned URL, bypassing the CORS preflight block on the app:// origin.
// payload = { url, contentType, data:ArrayBuffer }.
contextBridge.exposeInMainWorld("upload", {
  putOSS: (payload) => ipcRenderer.invoke("upload:put-oss", payload),
});

// Open a path (file or folder) in the system file manager / default application.
contextBridge.exposeInMainWorld("shellApi", {
  openPath: (path) => ipcRenderer.invoke("shell:open-path", path),
});

// Local llama.cpp model: hardware probing / hardware-based recommendation / start-stop / status subscription.
// Once ready, the renderer registers a "local" model based on status().endpoint and sets it as the default (see src/lib/ai/localModel.ts).
contextBridge.exposeInMainWorld("localLlm", {
  /** Roughly probe hardware { hw, cuda, supported, minMemGB }. */
  hardware: () => ipcRenderer.invoke("llm:local:hardware"),
  /** Local file storage location { dir, custom, freeGB, suggestion } (llama runtime + GGUF models). */
  storageInfo: () => ipcRenderer.invoke("llm:local:storageInfo"),
  /** Set the storage location (empty = restore default); returns the latest storageInfo. */
  setStorageDir: (dir) => ipcRenderer.invoke("llm:local:setStorageDir", dir),
  /** Pop up the native directory picker and save; returns null on cancel, otherwise the latest storageInfo. */
  chooseStorageDir: () => ipcRenderer.invoke("llm:local:chooseStorageDir"),
  /** The build variant selected by useCuda and whether it is installed { variant, installed, version }. opts?: { useCuda? }. */
  installInfo: (opts) => ipcRenderer.invoke("llm:local:installInfo", opts),
  /** Installation status of the two candidate variants with/without CUDA { version, cuda, variants } (so the already-installed one is selected by default, avoiding redundant downloads). */
  installStatus: () => ipcRenderer.invoke("llm:local:installStatus"),
  /** Step 1: install the runtime bundle (skips the download if already installed). opts?: { useCuda? }. Progress is pushed via onStatus. */
  install: (opts) => ipcRenderer.invoke("llm:local:install", opts),
  /** Step 2: probe VRAM using the installed binary { vramGB, device, gpuPresent }. opts?: { useCuda? }. */
  probe: (opts) => ipcRenderer.invoke("llm:local:probe", opts),
  /** Recommend models based on the probed VRAM { primary, options }. opts?: { vramGB?, device?, budgetGB?, ctx? }. */
  recommend: (opts) => ipcRenderer.invoke("llm:local:recommend", opts),
  /** Step 3: start the local model. opts: { modelId?, quantId?, hf?, ctx?, useCuda? }. ready arrives later via onStatus. */
  start: (opts) => ipcRenderer.invoke("llm:local:start", opts),
  /** Stop the local model. */
  stop: () => ipcRenderer.invoke("llm:local:stop"),
  /** "Start over": stop the service + clear probe/model, back to step 1 (keeps the installed runtime). */
  reset: () => ipcRenderer.invoke("llm:local:reset"),
  /** Current status { running, ready, phase, port, endpoint, model, installed, probe, error }. */
  status: () => ipcRenderer.invoke("llm:local:status"),
  /** List of downloaded local models [{ repo, quant, dir, sizeBytes, running }]. */
  listModels: () => ipcRenderer.invoke("llm:local:models"),
  /** Delete a downloaded model { dir } → { ok, error? }. */
  deleteModel: (opts) => ipcRenderer.invoke("llm:local:delete", opts),
  /** Forget a deleted conversation's KV on the local server. Best-effort; resolves even when no server is running. */
  eraseConversationKv: (id) => ipcRenderer.invoke("llm:local:eraseConversationKv", id),
  eraseConversationsKv: (ids) => ipcRenderer.invoke("llm:local:eraseConversationsKv", ids),
  /** GGUF model download directory. */
  modelsDir: () => ipcRenderer.invoke("llm:local:models-dir"),
  /** Estimate memory usage based on options { totalGB, weightGB, kvGB }. opts: { modelId, quant, ctx, kvBits, vision }. */
  estimate: (opts) => ipcRenderer.invoke("llm:local:estimate", opts),
  /** llama runtime info { version, installed, upToDate, updatable, binDir, root, variant }. */
  llamaInfo: () => ipcRenderer.invoke("llm:local:llama-info"),
  /** Browse tab: search GGUF repos on the Hub { ok, items, error? }. opts?: { query?, trusted?, limit? }. */
  hfSearch: (opts) => ipcRenderer.invoke("llm:local:hf-search", opts),
  /** Browse tab: one repo's quants + gguf metadata + compat verdict { ok, quants, gguf, arch, compat, mmproj, mtp }. opts: { repo }. */
  hfRepo: (opts) => ipcRenderer.invoke("llm:local:hf-repo", opts),
  /** Subscribe to status changes (loading / ready / exited / error); returns an unsubscribe function. */
  onStatus: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on("llm:local:status", handler);
    return () => ipcRenderer.removeListener("llm:local:status", handler);
  },
});

// Sandbox (QEMU VM command execution engine): status query / preference sync / initialization progress subscription.
// The sandbox initializes in the background of the main process (install runtime → pull image → verify startup), never blocking command execution;
// when ready and the active session asked for the secure environment, commands run inside the VM, otherwise directly on the host.
contextBridge.exposeInMainWorld("sandbox", {
  /** Current status { phase, reason, image, pct, preference, active }. */
  getStatus: () => ipcRenderer.invoke("sandbox:get-status"),
  /** Mirror the active session's secure-environment switch ("sandbox" | "host"). Per conversation, not global. */
  setMode: (preference) => ipcRenderer.invoke("sandbox:set-mode", preference),
  /** VM image directory (where rootfs.qcow2 etc. live): for the startup dialog to display / open the folder. */
  vmDir: () => ipcRenderer.invoke("sandbox:vm-dir"),
  /** VM image version / installation info (version / complete / updatable / otherVersions / dir). */
  vmInfo: () => ipcRenderer.invoke("sandbox:vm-info"),
  /** Update / restart the runtime environment (download the target version from versions.json); progress is pushed via onStatus. */
  update: () => ipcRenderer.invoke("sandbox:update"),
  /** Restart the runtime environment (no forced download, uses the existing image): re-launch after a VM crash; progress is pushed via onStatus. */
  restart: () => ipcRenderer.invoke("sandbox:restart"),
  /** Subscribe to initialization progress / ready / error events; returns an unsubscribe function. */
  onStatus: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on("sandbox:status", handler);
    return () => ipcRenderer.removeListener("sandbox:status", handler);
  },
});

// Auto-update (electron-updater over GitHub Releases). The main process reports state only; all
// user-facing copy is localized here in the renderer from src/locales/*.json.
// `supported` is false in dev (unpackaged) — there is no app-update.yml, so nothing can be checked.
// On macOS an unsigned build reports status "error": Squirrel.Mac refuses updates whose code
// signature does not match the running app, and there is no way around that without a Developer ID.
contextBridge.exposeInMainWorld("updater", {
  /** Current state { status, version, percent, error, supported, currentVersion }. */
  getState: () => ipcRenderer.invoke("updater:state"),
  /** Ask the feed whether a newer version exists; result arrives via onState. */
  check: () => ipcRenderer.invoke("updater:check"),
  /** Download the pending update; progress arrives via onState (status "downloading", percent). */
  download: () => ipcRenderer.invoke("updater:download"),
  /** Quit and install a downloaded update (no-op unless status is "downloaded"). */
  install: () => ipcRenderer.invoke("updater:install"),
  /** Subscribe to state transitions incl. download progress; returns an unsubscribe function. */
  onState: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on("updater:state", handler);
    return () => ipcRenderer.removeListener("updater:state", handler);
  },
});

// <webview> automation: runs puppeteer-core (CDP) in a separate utilityProcess; start begins monitoring,
// onEvent subscribes to status / trigger events (such as detecting an on-site search).
contextBridge.exposeInMainWorld("automation", {
  start: (config) => ipcRenderer.invoke("automation:start", config),
  stop: () => ipcRenderer.invoke("automation:stop"),
  /** Dispatch a page operation (read / links / click / type / navigate); returns { ok, result?, error? }. */
  action: (payload) => ipcRenderer.invoke("automation:action", payload),
  onEvent: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("automation:event", handler);
    return () => ipcRenderer.removeListener("automation:event", handler);
  },
  /** Subscribe to "open new tab within the site" (forwarded after the main process intercepts the webview popup). */
  onNewTab: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("webview:new-tab", handler);
    return () => ipcRenderer.removeListener("webview:new-tab", handler);
  },
  /** Inform of the current active tab URL (determines which webview CDP operates on). */
  setActiveUrl: (url) => ipcRenderer.invoke("automation:set-active-url", url),
  saveShot: (dataUrl) => ipcRenderer.invoke("browser:save-shot", dataUrl),
});

// Conversation / project record persistence: the main process reads/writes per-project files (the directory can be customized in settings).
contextBridge.exposeInMainWorld("agentStore", {
  /** Read the project index { projects }. */
  loadIndex: () => ipcRenderer.invoke("agent-store:load-index"),
  /** Read the conversations of a single project { conversations }. */
  loadProject: (id) => ipcRenderer.invoke("agent-store:load-project", id),
  /** Overwrite the project index. */
  saveIndex: (projects) => ipcRenderer.invoke("agent-store:save-index", projects),
  /** Overwrite the conversations of a single project. */
  saveProject: (id, conversations) => ipcRenderer.invoke("agent-store:save-project", { id, conversations }),
  /** Delete the conversation file of a single project. */
  deleteProject: (id) => ipcRenderer.invoke("agent-store:delete-project", id),
  /** Current storage directory. */
  getPath: () => ipcRenderer.invoke("agent-store:get-path"),
  /** Set the storage directory (migrate data and persist); returns the new directory. */
  setPath: (dir) => ipcRenderer.invoke("agent-store:set-path", dir),
  /** Pop up the native directory picker to set the storage directory; returns the new directory, or null on cancel. */
  choosePath: () => ipcRenderer.invoke("agent-store:choose-path"),
});

// Chat integrity: device identifier, encryption status, and reading/writing of the per-session integrity metadata sidecar.
// Encryption is transparent to the renderer (body encryption/decryption happens automatically in the main process as it is written to disk); only metadata and identifiers are exposed here.
contextBridge.exposeInMainWorld("chatIntegrity", {
  /** Get the stable local deviceId (generated and persisted on first use). */
  getDeviceId: () => ipcRenderer.invoke("integrity:get-device-id"),
  /** Encryption status { enabled, mode: "keychain" | "plain" | "disabled" }. */
  encryptionStatus: () => ipcRenderer.invoke("integrity:encryption-status"),
  /** Read the integrity metadata of a session (returns null if it does not exist). */
  loadMeta: (chatId) => ipcRenderer.invoke("integrity:load-meta", chatId),
  /** Overwrite the integrity metadata of a session. */
  saveMeta: (chatId, meta) => ipcRenderer.invoke("integrity:save-meta", { chatId, meta }),
  /** Delete the integrity metadata of a session. */
  deleteMeta: (chatId) => ipcRenderer.invoke("integrity:delete-meta", chatId),
  /** List the integrity metadata of all sessions (for bulk reconciliation at startup). */
  listMeta: () => ipcRenderer.invoke("integrity:list-meta"),
});

// The media library: <data storage location>/media, with index.json at its root. Written by the APP (a
// generated asset, an attachment) — the folder is read-only to the AI's own file tools and to the sandbox.
contextBridge.exposeInMainWorld("mediaStore", {
  /** Absolute path of the media folder. */
  dir: () => ipcRenderer.invoke("media:dir"),
  /** index.json as text, or "" when there is not one yet. */
  readIndex: () => ipcRenderer.invoke("media:read-index"),
  /** Replace index.json (written atomically). */
  writeIndex: (json) => ipcRenderer.invoke("media:write-index", json),
  /** Put a file in the library: { name, srcPath | bytes | url } -> { path, bytes }. */
  save: (payload) => ipcRenderer.invoke("media:save", payload),
  /** Reveal the folder in the system file manager. */
  open: () => ipcRenderer.invoke("media:open"),
});

// File-based memory: one Markdown file per memory (userData/memories/<id>.md). Written by the AI's save_memory tool.
contextBridge.exposeInMainWorld("memoryFiles", {
  /** Save/update a memory { title, content, id? } → { id, title, file, created, updated }. */
  save: (input) => ipcRenderer.invoke("memory-md:save", input),
  /** List all memories (in reverse order of update time). */
  list: () => ipcRenderer.invoke("memory-md:list"),
  /** Delete a memory (by id). */
  remove: (id) => ipcRenderer.invoke("memory-md:delete", id),
  /** Open the memory directory in the system file manager. */
  openDir: () => ipcRenderer.invoke("memory-md:open-dir"),
  /** Pop up the file picker to import .md/.txt as memories; returns { imported }. */
  import: () => ipcRenderer.invoke("memory-md:import"),
  /** Download a memory template .md (random id, timestamp being the download moment); returns { ok, path? }. */
  downloadTemplate: () => ipcRenderer.invoke("memory-md:download-template"),
  /** Export all memories to a ZIP in one click; returns { ok, path?, count?, empty? }. */
  exportZip: () => ipcRenderer.invoke("memory-md:export-zip"),
});

// app.config: an INI config file alongside the executable ([llm] / [limits] / [ui]).
// getAllSync uses the synchronous channel, for injecting file values into the renderer store at startup, avoiding async races.
contextBridge.exposeInMainWorld("appConfig", {
  /** Synchronously get a full config snapshot { section: { key: value } }. */
  getAllSync: () => ipcRenderer.sendSync("appconfig:get-all-sync"),
  /** Write a key (empty value means delete), persisted to disk. */
  set: (section, key, value) => ipcRenderer.invoke("appconfig:set", { section, key, value }),
  /** Delete a key. */
  remove: (section, key) => ipcRenderer.invoke("appconfig:remove", { section, key }),
  /** Open app.config in the system default editor (creates it first if it does not exist); returns { ok, path, error? }. */
  openFile: () => ipcRenderer.invoke("appconfig:open-file"),
  /** Get the absolute path of app.config. */
  getPath: () => ipcRenderer.invoke("appconfig:get-path"),
});

// Token-usage log (electron/store/usageLogStore.mjs). Model invocations are recorded by the LLM proxy
// in the main process; the renderer contributes what only it knows — which actor made a tool call, and
// what a sub-agent was delegated. Off by default; `append` is fire-and-forget so the chat loop never
// waits on a disk write.
contextBridge.exposeInMainWorld("usageLog", {
  /** Whether logging is currently on. */
  isEnabled: () => ipcRenderer.invoke("usagelog:enabled"),
  /** Turn logging on/off (persisted to app.config [logging] usage); returns the applied value. */
  setEnabled: (on) => ipcRenderer.invoke("usagelog:set-enabled", on),
  /** Record one entry or an array of them. Fire-and-forget; a no-op while logging is off. */
  append: (entries) => ipcRenderer.send("usagelog:append", entries),
  /** Days that have a log file, newest first: [{ day, bytes, mtime }]. */
  days: () => ipcRenderer.invoke("usagelog:days"),
  /** Read one day with optional filters; returns { day, total, matched, entries }. */
  read: (opts) => ipcRenderer.invoke("usagelog:read", opts),
  /** Aggregate one day (totals + breakdown by model / actor / tool). */
  stats: (day) => ipcRenderer.invoke("usagelog:stats", day),
  /** Delete one day's file, or every day when `day` is omitted; returns how many were removed. */
  clear: (day) => ipcRenderer.invoke("usagelog:clear", day),
  /** Force the buffered entries to disk (the viewer does this before reading today). */
  flush: () => ipcRenderer.invoke("usagelog:flush"),
  /** Absolute path of the log directory. */
  dir: () => ipcRenderer.invoke("usagelog:dir"),
  /** Open the log directory in the system file manager; returns { ok, path, error? }. */
  openDir: () => ipcRenderer.invoke("usagelog:open-dir"),
});

// External MCP servers (electron/mcp/*). Configuration and trust only: the protocol itself never
// crosses this boundary, and neither do secrets — env values and Authorization headers stay in the
// main process, so a server object here reports only *which* keys are set. The tools an MCP server
// exposes reach the model through the ordinary window.aiTools.list/call path, not through here.
contextBridge.exposeInMainWorld("mcp", {
  /** Full snapshot { servers, status } — configuration plus live connection state. */
  list: () => ipcRenderer.invoke("mcp:list"),
  /** Create or replace a server. Changing its command/URL clears approval. */
  upsert: (id, config) => ipcRenderer.invoke("mcp:upsert", { id, config }),
  /** Delete a server (disconnects it first). */
  remove: (id) => ipcRenderer.invoke("mcp:remove", id),
  /** Record that the user has seen and accepted this server's exact command line / URL. */
  approve: (id, approved) => ipcRenderer.invoke("mcp:approve", { id, approved }),
  /** Enable/disable without forgetting the configuration. */
  setEnabled: (id, enabled) => ipcRenderer.invoke("mcp:set-enabled", { id, enabled }),
  /** Connect now (fails with "not-approved" until the user has approved it). */
  connect: (id) => ipcRenderer.invoke("mcp:connect", id),
  disconnect: (id) => ipcRenderer.invoke("mcp:disconnect", id),
  /** Import a Claude-Desktop style { mcpServers: {...} } blob; imported servers start unapproved. */
  import: (blob) => ipcRenderer.invoke("mcp:import", blob),
  /** Absolute path of servers.json. */
  configPath: () => ipcRenderer.invoke("mcp:config-path"),
  /** Open servers.json in the system default editor. */
  openConfig: () => ipcRenderer.invoke("mcp:open-config"),
  /** Subscribe to connection-state changes; returns an unsubscribe function. */
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on("mcp:status", handler);
    return () => ipcRenderer.removeListener("mcp:status", handler);
  },
});

// Plugin marketplace (electron/plugins/*). See docs/plugin-marketplace-design.md.
//
// The renderer drives intent only. Signature verification, rollback refusal, hash checking and
// revocation all happen on the other side of this boundary, so the worst a compromised renderer can
// do is ask for something — never install unverified bytes. `install` deliberately takes only an id
// that must already be in the verified catalogue, not a manifest: accepting a manifest from here
// would let the caller choose its own hashes, which is the same as having none.
//
// There is no agent-callable install (design doc §2.3): browsing is safe for the model to reach,
// installing is a click.
contextBridge.exposeInMainWorld("plugins", {
  /** Point the client at the registry, using the API origin this build was compiled against. */
  configure: (origin) => ipcRenderer.invoke("plugins:configure", origin),
  /** Installed plugins, with their enabled/revoked state. */
  installed: () => ipcRenderer.invoke("plugins:installed"),
  /** Capabilities that should be offered right now: installed, enabled, not revoked. */
  active: () => ipcRenderer.invoke("plugins:active"),
  /** The last verified catalogue. No network, so opening the page is instant. */
  catalogue: () => ipcRenderer.invoke("plugins:catalogue"),
  /** Fetch and verify the feeds now; applies any new revocations. Never rejects. */
  refresh: () => ipcRenderer.invoke("plugins:refresh"),
  /** Catalogue entry plus installed record for one plugin. */
  detail: (id) => ipcRenderer.invoke("plugins:detail", id),
  /**
   * Install from the verified catalogue, then connect any account the plugin needs.
   * Returns { ok, error, auth: [{ providerId, authorized, error }] } — `ok` is the install; a plugin
   * can install successfully and still come back with an unauthorized provider.
   */
  install: (id) => ipcRenderer.invoke("plugins:install", id),
  /** Per-provider grant state: authorized, when it lapses, and why the last attempt failed. */
  authStatus: (id) => ipcRenderer.invoke("plugins:auth-status", id),
  /** Re-run the authorization flow. Omit providerId to do every oauth provider the plugin has. */
  authorize: (id, providerId = null) => ipcRenderer.invoke("plugins:authorize", { id, providerId }),
  uninstall: (id) => ipcRenderer.invoke("plugins:uninstall", id),
  /** Enable/disable without uninstalling. Refused for a revoked plugin. */
  setEnabled: (id, enabled) => ipcRenderer.invoke("plugins:set-enabled", { id, enabled }),
  /** Read an installed capability's content, re-verified against its pinned hash. */
  read: (id, capabilityId) => ipcRenderer.invoke("plugins:read", { id, capabilityId }),
  /** Subscribe to installed-state changes; returns an unsubscribe function. */
  onChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("plugins:changed", handler);
    return () => ipcRenderer.removeListener("plugins:changed", handler);
  },
});

// Automation workflows (electron/automation/*). Named `workflows`, NOT `automation` — that global is
// already the <webview> CDP browser panel above, and its `automation:event` channel is broadcast to
// every window, so sharing the namespace would cross-wire the two features.
contextBridge.exposeInMainWorld("workflows", {
  /** Workflow summaries for the list view. */
  list: () => ipcRenderer.invoke("wf:list"),
  /** One definition; omit version for the current one, pass it to read exactly what a run executed. */
  get: (id, version) => ipcRenderer.invoke("wf:get", { id, version }),
  /** Every stored version number for a workflow. */
  versions: (id) => ipcRenderer.invoke("wf:versions", id),
  /** Ids of the available starter templates. */
  templates: () => ipcRenderer.invoke("wf:templates"),
  /** One row per workflow: run totals, how it went last time, and when it next fires by itself. */
  overview: () => ipcRenderer.invoke("wf:overview"),
  /**
   * { path, exists } — the folder a run's file-touching steps write into (<automation>/runs/<runId>),
   * or the runs root when runId is omitted. Open it with window.shellApi.openPath, but check `exists`
   * first: a queued run's folder is only created when its first node executes.
   */
  workdir: (runId) => ipcRenderer.invoke("wf:workdir", { runId }),
  /** Create a workflow from a starter template; returns { ok, version } or { ok:false, errors }. */
  createFromTemplate: (templateId, name) =>
    ipcRenderer.invoke("wf:create-from-template", { templateId, name }),
  /** Save as a NEW version; returns { ok, version } or { ok:false, errors }. */
  save: (definition) => ipcRenderer.invoke("wf:save", definition),
  /** Delete a workflow and all of its versions. */
  remove: (id) => ipcRenderer.invoke("wf:delete", id),

  /** Start a run; resolves as soon as it is queued, with { ok, runId }. Follow it via onEvent. */
  run: (workflowId, variables) => ipcRenderer.invoke("wf:run", { workflowId, variables }),
  /** Cancel an in-flight run. */
  cancel: (runId) => ipcRenderer.invoke("wf:cancel", runId),
  /** Recent runs, newest first: { workflowId?, state?, limit? }. */
  runs: (query) => ipcRenderer.invoke("wf:runs", query ?? {}),
  /** Full detail for one run (run, attempts, events, outputs); sinceSeq fetches only the delta. */
  runDetail: (runId, sinceSeq) => ipcRenderer.invoke("wf:run-detail", { runId, sinceSeq }),

  /** Runs suspended waiting on an external event. */
  waits: () => ipcRenderer.invoke("wf:waits"),
  /** Deliver an inbound event by match key; resumes whichever run is waiting on it. */
  deliverEvent: (key, payload) => ipcRenderer.invoke("wf:deliver", { key, payload }),
  /** Native file picker for a `file` workflow input; resolves to an absolute path or null. */
  pickFile: () => ipcRenderer.invoke("wf:pick-file"),
  /** Runs waiting on a human decision, oldest first. */
  approvals: () => ipcRenderer.invoke("wf:approvals"),
  /** Approve or reject a pending gate; approving resumes the run in the background. */
  decide: (approvalId, approved, note) =>
    ipcRenderer.invoke("wf:decide", { approvalId, approved, note }),
  /**
   * Push translated strings for the approval OS-notification. The main process has no i18n runtime,
   * and the notification may need to fire when no window is open, so the strings are cached there.
   */
  setApprovalStrings: (strings) => ipcRenderer.send("wf:approval-strings", strings),

  /** Subscribe to live run events; returns an unsubscribe function. */
  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("wf:event", handler);
    return () => ipcRenderer.removeListener("wf:event", handler);
  },
  /** Subscribe to run state transitions; returns an unsubscribe function. */
  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("wf:state", handler);
    return () => ipcRenderer.removeListener("wf:state", handler);
  },
});

// Background / tray mode: keeps the app resident after the last window closes so the automation
// scheduler keeps running (see electron/services/background.mjs).
contextBridge.exposeInMainWorld("background", {
  /** Current state { enabled, openAtLogin, paused, traySupported }. */
  get: () => ipcRenderer.invoke("background:get"),
  /** Stay resident after the last window closes (creates/removes the tray to match). */
  setEnabled: (on) => ipcRenderer.invoke("background:set-enabled", on),
  /** Register/unregister the login item (launches hidden, tray only). */
  setOpenAtLogin: (on) => ipcRenderer.invoke("background:set-open-at-login", on),
  /** Pause all automations (runtime only — a restart always resumes). */
  setPaused: (on) => ipcRenderer.invoke("background:set-paused", on),
  /**
   * Push translated tray-menu labels { open, pause, quit, running } to the main process, which has no
   * i18n runtime of its own. Persisted so an autostart launch — which renders the tray before any
   * renderer exists — still uses the user's language from the previous session.
   */
  setTrayLabels: (labels) => ipcRenderer.send("background:set-tray-labels", labels),
});

// System-level notifications: renderer → main-process notification service (queue / merge / rate-limit / OS popup), with click routing sent back.
contextBridge.exposeInMainWorld("notification", {
  /** Send a system notification; returns { ok, id?, merged?, supported }. See NotificationItem for payload. */
  send: (payload) => ipcRenderer.invoke("notify:send", payload),
  /** Whether the current system supports native notifications. */
  isSupported: () => ipcRenderer.invoke("notify:supported"),
  /** List notification history (reverse order) [{ id, item, read, createdAt }]. */
  list: () => ipcRenderer.invoke("notify:list"),
  /** Unread count (for the badge). */
  unreadCount: () => ipcRenderer.invoke("notify:unread-count"),
  /** Mark a single / all as read. */
  markRead: (id) => ipcRenderer.invoke("notify:mark-read", id),
  markAllRead: () => ipcRenderer.invoke("notify:mark-all-read"),
  /** Delete a single / clear the history. */
  remove: (id) => ipcRenderer.invoke("notify:remove", id),
  clear: () => ipcRenderer.invoke("notify:clear"),
  /** Subscribe to in-app navigation triggered by clicking a notification (Deep Link); returns an unsubscribe function. */
  onNavigate: (cb) => {
    const handler = (_e, route) => cb(route);
    ipcRenderer.on("route:navigate", handler);
    return () => ipcRenderer.removeListener("route:navigate", handler);
  },
  /** Subscribe to action-button clicks { id, index, actionId }; returns an unsubscribe function. */
  onAction: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("notify:action", handler);
    return () => ipcRenderer.removeListener("notify:action", handler);
  },
  /** Subscribe to history changes (new notification / read / delete), for refreshing the notification center; returns an unsubscribe function. */
  onChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("notify:changed", handler);
    return () => ipcRenderer.removeListener("notify:changed", handler);
  },
});

// Google sign-in: the renderer triggers the main process's RFC 8252 native flow (system browser + loopback + PKCE),
// the main process obtains the Google id_token and hands it back; the renderer then POSTs /auth/google to complete sign-in.
contextBridge.exposeInMainWorld("googleAuth", {
  /** Start the Google sign-in flow; returns { ok, idToken?, canceled?, error? }. */
  signIn: () => ipcRenderer.invoke("google-auth:signin"),
});

// Custom protocol (Deep Link): the user clicks the "Open Zeraix" button on the callback page in the system browser → the OS brings the app to the foreground,
// the main process forwards the parsed zeraix://… here. The renderer can subscribe for optional in-app routing (sign-in is already completed in-app).
contextBridge.exposeInMainWorld("deepLink", {
  /** Subscribe to deep-link activations { url, host, pathname, params }; returns an unsubscribe function. */
  onOpen: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
});

// Window controls: the renderer's self-drawn macOS-style traffic-light buttons call the main process to control the window.
contextBridge.exposeInMainWorld("windowControls", {
  /** Minimize the window. */
  minimize: () => ipcRenderer.invoke("window:minimize"),
  /** Toggle maximize / restore; returns the maximized state after toggling. */
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  /** Close the window. */
  close: () => ipcRenderer.invoke("window:close"),
  /** Query whether the window is currently maximized. */
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  /** Subscribe to maximized-state changes; returns an unsubscribe function. */
  onMaximizeChange: (cb) => {
    const handler = (_e, maximized) => cb(maximized);
    ipcRenderer.on("window:maximize-changed", handler);
    return () => ipcRenderer.removeListener("window:maximize-changed", handler);
  },
  /** macOS only: hide / restore the native traffic-light buttons (called when the self-drawn buttons take over). */
  setNativeButtons: (visible) => ipcRenderer.invoke("window:set-native-buttons", visible),
  /** Query whether the window is always-on-top. */
  isAlwaysOnTop: () => ipcRenderer.invoke("window:is-always-on-top"),
  /** Set the window always-on-top; returns the state after setting. */
  setAlwaysOnTop: (on) => ipcRenderer.invoke("window:set-always-on-top", on),
  /** Toggle the window always-on-top; returns the state after toggling. */
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  /** Subscribe to always-on-top state changes; returns an unsubscribe function. */
  onAlwaysOnTopChange: (cb) => {
    const handler = (_e, on) => cb(on);
    ipcRenderer.on("window:always-on-top-changed", handler);
    return () => ipcRenderer.removeListener("window:always-on-top-changed", handler);
  },
});

// Built-in terminal: renderer xterm.js ⇄ main-process node-pty session (see electron/tools/terminal.mjs).
contextBridge.exposeInMainWorld("terminal", {
  /** Create a new PTY session; returns the session id. opts?: { cols, rows, cwd } (cwd defaults to the current working directory). */
  create: (opts) => ipcRenderer.invoke("terminal:create", opts || {}),
  /** Write user input (passed through as-is, including control characters). */
  write: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  /** Sync the terminal size (called after xterm fit). */
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  /** End the session. */
  kill: (id) => ipcRenderer.send("terminal:kill", id),
  /** End all sessions under this window (fully terminate all terminals when the file sidebar is closed). */
  killAll: () => ipcRenderer.send("terminal:kill-all"),
  /** Subscribe to PTY output { id, data }; returns an unsubscribe function. */
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  /** Subscribe to session exit { id, exitCode, signal }; returns an unsubscribe function. */
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("terminal:exit", handler);
    return () => ipcRenderer.removeListener("terminal:exit", handler);
  },
});
