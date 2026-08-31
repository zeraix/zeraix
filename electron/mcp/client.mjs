/**
 * MCP client manager -- the outbound half of the Model Context Protocol integration.
 *
 * One connection pool for the whole app, owned by the main process. The renderer never speaks MCP:
 * it is sandboxed (no child_process, no raw sockets) and an HTTP server's bearer token has no
 * business living in a window. See docs/mcp-integration.md.
 *
 * Everything a caller needs is two functions that mirror aiToolkit's own registry contract:
 *   listMcpTools() -> [{ name, description, parameters }]     merged into listTools()
 *   callMcpTool(name, args) -> { ok, content }                 dispatched from runTool()
 * which is why no consumer (chat IPC, agent loop, automation dispatcher) needs to know MCP exists.
 *
 * Tool names are `mcp__<serverId>__<tool>`. The prefix is part of the name rather than side-channel
 * metadata because two servers may both expose `search`, and the model has to be able to say which
 * one it means in the only field it controls. A reverse index resolves the name back to a connection,
 * so a server whose tool names contain characters providers reject can still be addressed.
 */
import { CONNECT_TIMEOUT_DOWNLOAD_MS, CONNECT_TIMEOUT_MS, getServer, listServers, usesPackageRunner } from "./config.mjs";
import { pluginAuthHeaders } from "../plugins/auth.mjs";
import {
  EVENT_RUNTIME_DISCONNECTED,
  hasFeature,
  mcpCall,
  mcpConnect,
  mcpDisconnect,
  onEvent,
} from "../tools/rustRuntime.mjs";

/**
 * The SDK is loaded on first connect, not at import time. aiToolkit imports this module, and
 * aiToolkit is imported by main.mjs -- a static import would mean a missing or half-installed
 * @modelcontextprotocol/sdk takes the whole app down at startup rather than disabling one feature.
 * Everything except connecting (name checks, the empty tool list, error results) works without it.
 */
let sdkPromise = null;
function loadSdk() {
  sdkPromise ??= (async () => {
    const [client, stdio, http, types] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    return {
      Client: client.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      getDefaultEnvironment: stdio.getDefaultEnvironment,
      StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
      ToolListChangedNotificationSchema: types.ToolListChangedNotificationSchema,
    };
  })().catch((e) => {
    sdkPromise = null; // a later attempt should retry rather than cache the failure forever
    throw new Error(`MCP SDK unavailable (${e?.message ?? e}). Run a dependency install.`);
  });
  return sdkPromise;
}

export const TOOL_PREFIX = "mcp";
export const NAME_SEP = "__";
/** Keep the last of a server's stderr for the settings panel: enough to see a stack, bounded. */
const STDERR_KEEP = 8_000;

/** id -> { id, status, error, tools, client, transport, connecting, stderr, pid, connectedAt } */
const conns = new Map();
/** safe tool name -> { serverId, toolName } */
const toolIndex = new Map();

let listeners = new Set();

/** Subscribe to status changes (the IPC layer broadcasts these to the settings UI). */
export function onMcpEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const snapshot = mcpStatus();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* a bad listener must not break the connection path */
    }
  }
}

function entry(id) {
  let e = conns.get(id);
  if (!e) {
    e = { id, status: "idle", error: "", tools: [], client: null, transport: null, connecting: null, stderr: "", pid: null, connectedAt: 0 };
    conns.set(id, e);
  }
  return e;
}

// ── Names ─────────────────────────────────────────────────────────────────────

/** Providers accept [A-Za-z0-9_-] in tool names; anything else becomes '_'. */
function safeSegment(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function isMcpTool(name) {
  return typeof name === "string" && name.startsWith(`${TOOL_PREFIX}${NAME_SEP}`);
}

// ── Schema / result conversion ────────────────────────────────────────────────

/**
 * MCP `inputSchema` is plain JSON Schema and maps straight onto our `parameters`, but servers ship
 * keywords that strict function-calling modes reject outright. Drop the ones that are pure metadata
 * and guarantee the object shape the callers assume.
 */
function toParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} };
  }
  const rest = { ...inputSchema };
  // Pure metadata to a tool declaration, and $schema in particular is rejected outright by some
  // strict function-calling modes.
  delete rest.$schema;
  delete rest.$id;
  delete rest.title;
  return {
    type: "object",
    properties: {},
    ...rest,
    // A server may declare `required` naming a property it then does not define; that combination is
    // rejected by strict schema validators, so keep only the ones that exist.
    ...(Array.isArray(rest.required) && rest.properties
      ? { required: rest.required.filter((k) => k in rest.properties) }
      : {}),
  };
}

/**
 * Flatten MCP content blocks into the single string runTool's contract returns.
 * Binary blocks are named, not inlined: a base64 image in the transcript is thousands of tokens the
 * model cannot see anyway (the chat's own image path is separate).
 */
function flattenContent(result) {
  const parts = [];
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    // When the server declares an outputSchema this is the higher-signal half of the response, so it
    // goes first -- the text blocks are usually a prose rendering of the same data.
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      /* unserializable -> fall through to the text blocks */
    }
  }
  for (const b of result?.content ?? []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") parts.push(String(b.text ?? ""));
    else if (b.type === "resource") parts.push(b.resource?.text ?? `[resource ${b.resource?.uri ?? "?"}]`);
    else if (b.type === "resource_link") parts.push(`[resource ${b.uri}${b.name ? ` (${b.name})` : ""}]`);
    else if (b.type === "image" || b.type === "audio") parts.push(`[${b.type} ${b.mimeType ?? ""}]`.trim());
    else parts.push(`[${b.type}]`);
  }
  const text = parts.filter(Boolean).join("\n").trim();
  // Never the empty string: to a model that reads as a broken tool rather than an empty answer.
  return text || "(empty result)";
}

// ── Connecting ────────────────────────────────────────────────────────────────

/**
 * A fetch that attaches the plugin's credential to every request.
 *
 * Failures are surfaced as a thrown error rather than an unauthenticated request: sending the call
 * anyway would reach the server as an anonymous 401, and the user would be told their server is
 * broken when what actually happened is that their account is not connected.
 */
function pluginAuthedFetch(auth) {
  return async (url, init = {}) => {
    const headers = await pluginAuthHeaders(Object.fromEntries(new Headers(init.headers ?? {}).entries()), {
      pluginId: auth.plugin,
      providerId: auth.provider,
    });
    return fetch(url, { ...init, headers });
  };
}

function buildTransport(sdk, cfg, e) {
  if (cfg.kind === "http") {
    return new sdk.StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: Object.keys(cfg.headers).length ? { headers: { ...cfg.headers } } : undefined,
      // A server backed by an installed plugin spends that plugin's OAuth grant. Resolved PER
      // REQUEST rather than folded into requestInit once: an access token outlives neither the
      // connection nor the turn, so a header fixed at connect time would work until the first
      // refresh and then 401 for the rest of the session. This also means a revoked grant stops
      // working on the next call instead of whenever the transport is next rebuilt.
      ...(cfg.auth ? { fetch: pluginAuthedFetch(cfg.auth) } : {}),
    });
  }
  const transport = new sdk.StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    cwd: cfg.cwd || undefined,
    // getDefaultEnvironment() is an allowlist (HOME/PATH/SHELL/... only), which is also what keeps
    // Electron's ELECTRON_RUN_AS_NODE and NODE_OPTIONS out of the child -- both of which break a
    // node-based server in confusing ways. Never spread process.env here.
    env: { ...sdk.getDefaultEnvironment(), ...patchPath(), ...cfg.env },
    // Default is "inherit", which throws a failing server's only diagnostic into a console the user
    // cannot see. Piped, it becomes the error text in the settings panel.
    stderr: "pipe",
  });
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk) => {
      e.stderr = (e.stderr + String(chunk)).slice(-STDERR_KEEP);
    });
  }
  return transport;
}

/**
 * A packaged macOS app launched from Finder inherits a minimal PATH, so a config that says `npx`
 * cannot resolve it. Widen PATH with the usual install locations rather than making every user write
 * absolute paths in their config.
 */
function patchPath() {
  if (process.platform !== "darwin") return {};
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  return { PATH: [...new Set([...current, ...extra])].join(":") };
}

/** Refresh a connection's tool list and rebuild its slice of the reverse index. */
/**
 * Turn a server's own tool list into declarations.
 *
 * Shared by both implementations -- the SDK path below and the Rust runtime path -- and that is the
 * point. These strings go into the prompt prefix ahead of `messages`, so a byte of difference between
 * the two re-prefills every conversation from token 0. The runtime therefore sends raw MCP values and
 * this is the one place they are converted.
 */
function mapTools(serverId, tools) {
  return (tools ?? []).map((t) => ({
    name: `${TOOL_PREFIX}${NAME_SEP}${safeSegment(serverId)}${NAME_SEP}${safeSegment(t.name)}`,
    raw: t.name,
    // The `[server]` prefix does more work than the name prefix: it is what the model actually
    // reads when two servers expose near-identical tools.
    description: `[${serverId}] ${t.description ?? t.name}`,
    parameters: toParameters(t.inputSchema),
  }));
}

async function refreshTools(e) {
  const { tools } = await e.client.listTools();
  e.tools = mapTools(e.id, tools);
  reindex();
}

function reindex() {
  toolIndex.clear();
  for (const e of conns.values()) {
    if (e.status !== "ready") continue;
    for (const t of e.tools) toolIndex.set(t.name, { serverId: e.id, toolName: t.raw });
  }
}

// ── Rust runtime ownership ────────────────────────────────────────────────────
//
// A stdio server can be owned by the Rust runtime instead of by the SDK in this process. Ownership is
// per server and all-or-nothing: whoever holds the connection does the discovery, the calls and the
// lifecycle. Two owners would mean two child processes for one server and two answers to "what does it
// declare", so there is no half state and no fallback once a connection is live.
//
// Everything a model or a user sees stays here regardless. The runtime sends raw MCP values; `mapTools`
// and `flattenContent` convert them, exactly as they do for the SDK path.

/** Servers whose readiness a caller is waiting on. id -> resolve. */
const runtimeWaiters = new Map();

/**
 * Whether the runtime should own this server.
 *
 * Both kinds now, which is the point of Stage 3c: a local program over stdio, and a remote or
 * cloud-hosted endpoint over Streamable HTTP.
 *
 * The one exception is a server backed by a plugin's OAuth grant. `pluginAuthedFetch` resolves its
 * token PER REQUEST on purpose — one fixed at connect time works until the first refresh and then 401s
 * for the rest of the session — and token storage and refresh live here, not in the runtime. Those stay
 * on this client until the runtime can ask for headers per call.
 */
async function runtimeOwns(cfg) {
  if (!cfg) return false;
  if (cfg.kind === "http") {
    if (cfg.auth) return false; // per-request OAuth; see above
    return hasFeature("mcp.http");
  }
  return hasFeature("mcp.stdio");
}

/** Map the runtime's connection states onto the vocabulary the settings panel already renders. */
function statusFromRuntime(state) {
  if (state === "ready") return "ready";
  if (state === "idle" || state === "connecting") return "connecting";
  // `closed` is a deliberate disconnect, which this file has always shown as idle rather than as a
  // failure; `degraded` and `failed` are both "cannot serve a call right now".
  return state === "closed" ? "idle" : "error";
}

/**
 * The runtime reports a connection change.
 *
 * This is the half the SDK path cannot have: there, a dead server is discovered by the next tool call
 * that fails. Here the supervisor notices on its own -- by heartbeat, or by the pipe closing -- and the
 * panel updates without anybody calling a tool.
 */
onEvent("mcp.state", (payload) => {
  const { id, state, reason, tools, stderr } = payload ?? {};
  const e = conns.get(id);
  if (!e?.remote) return; // not ours, or the SDK owns this one

  e.status = statusFromRuntime(state);
  e.error = e.status === "error" ? String(reason ?? "") : "";
  if (typeof stderr === "string" && stderr) e.stderr = stderr;
  // Declarations follow readiness exactly: a server that cannot serve a call must not be offering
  // tools to the model, which is also what keeps the declared set stable rather than flickering.
  e.tools = e.status === "ready" ? mapTools(id, tools) : [];
  if (e.status === "ready" && !e.connectedAt) e.connectedAt = Date.now();
  reindex();
  emit();

  // A caller inside connectServer is waiting for exactly this.
  if (state !== "connecting" && state !== "idle") {
    runtimeWaiters.get(id)?.();
  }
});

/**
 * The sidecar went away, taking every server it owned with it.
 *
 * Those child processes died with it, so the honest report is "not connected" rather than leaving the
 * panel showing servers that no longer exist. They reconnect the next time anything asks for them,
 * through whichever implementation is available then.
 */
onEvent(EVENT_RUNTIME_DISCONNECTED, () => {
  let changed = false;
  for (const e of conns.values()) {
    if (!e.remote) continue;
    e.status = "idle";
    e.tools = [];
    e.remote = false;
    e.connectedAt = 0;
    changed = true;
    runtimeWaiters.get(e.id)?.();
  }
  if (changed) {
    reindex();
    emit();
  }
});

/**
 * Hand one server to the runtime and wait for it to settle.
 *
 * Waits, unlike `listMcpTools()` -- and the difference is deliberate. Listing feeds the prompt prefix
 * and can never block; connecting is already an awaited operation whose callers (including
 * `callMcpTool`'s lazy connect) depend on getting back an entry that is actually ready. Bounded by the
 * same ceilings the SDK path uses.
 */
async function connectViaRuntime(cfg, e) {
  // Marked BEFORE the call, not after. The runtime can report `ready` in the same stdout chunk as the
  // reply to this request, and the bridge handles both synchronously -- so an event that arrived while
  // this was still awaiting would be dropped by the `!e.remote` guard in the handler, and the server
  // would sit in `connecting` until the budget below expired. This is the same shape as the exit-event
  // race in sandbox/native.mjs; the fix is the same one: register first.
  e.remote = true;
  const started = await mcpConnect(
    cfg.kind === "http"
      ? { id: cfg.id, url: cfg.url, headers: cfg.headers ?? {} }
      : {
          id: cfg.id,
          command: cfg.command,
          args: cfg.args,
          cwd: cfg.cwd || undefined,
    // The identical environment the SDK path builds -- see buildTransport.
    //
    // Taken from the SDK rather than reimplemented, even though nothing else on this path needs the
    // SDK. `getDefaultEnvironment()` is an allowlist whose job is keeping ELECTRON_RUN_AS_NODE and
    // NODE_OPTIONS away from a node-based server, and a second copy of it here would be free to drift
    // from the one every existing user's servers run under. If it cannot be loaded, this throws and
    // the caller falls through to the SDK path -- which would fail for the same reason anyway.
          env: { ...(await loadSdk()).getDefaultEnvironment(), ...patchPath(), ...cfg.env },
        },
  );
  if (!started) {
    e.remote = false;
    return false;
  }

  e.pid = null; // the child belongs to the runtime; its pid is not this process's to report
  const budget = usesPackageRunner(cfg) ? CONNECT_TIMEOUT_DOWNLOAD_MS : CONNECT_TIMEOUT_MS;
  // Already settled while this was awaiting -- the same race again, one step later. Checked rather
  // than assumed, or a server that connected instantly would be waited on for the full budget.
  if (e.status !== "connecting") return true;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      runtimeWaiters.delete(cfg.id);
      resolve();
    }, budget);
    runtimeWaiters.set(cfg.id, () => {
      clearTimeout(timer);
      runtimeWaiters.delete(cfg.id);
      resolve();
    });
  });
  // Still connecting when the budget ran out: report it the way a slow SDK connect is reported.
  if (e.status === "connecting") {
    e.status = "error";
    e.error = `timed out after ${budget}ms`;
    emit();
  }
  return true;
}

/**
 * Connect one server. Idempotent and safe to call concurrently: parallel callers await the same
 * in-flight handshake rather than spawning a second child process.
 */
export function connectServer(id) {
  const cfg = getServer(id);
  const e = entry(id);
  if (!cfg) {
    e.status = "error";
    e.error = "not-found";
    emit();
    return Promise.resolve(e);
  }
  if (e.status === "ready") return Promise.resolve(e);
  if (e.connecting) return e.connecting;

  e.status = "connecting";
  e.error = "";
  e.stderr = "";
  emit();

  e.connecting = (async () => {
    // The Rust runtime owns stdio servers when it is available. It declines before anything has been
    // started, so falling through to the SDK below costs nothing and starts nothing twice.
    if (await runtimeOwns(cfg)) {
      try {
        if (await connectViaRuntime(cfg, e)) {
          e.connecting = null;
          emit();
          return e;
        }
      } catch (err) {
        // A bridge failure is not a server failure: fall through and connect it here instead.
        console.warn(`[mcp] runtime connect for "${cfg.id}" failed, using the SDK:`, err?.message ?? err);
      }
    }

    let sdk;
    try {
      sdk = await loadSdk();
    } catch (err) {
      e.status = "error";
      e.error = err?.message ?? String(err);
      e.connecting = null;
      emit();
      return e;
    }
    const client = new sdk.Client(
      { name: "zeraix", version: process.env.npm_package_version || "1.0.0" },
      // Declare only what is actually wired. A declared-but-unimplemented capability is worse than
      // an absent one: the server will use it and every call fails.
      { capabilities: { roots: { listChanged: false } } },
    );
    try {
      // Inside the try: `new URL()` on a malformed address throws here, and this function's contract
      // is that it never rejects -- a caller awaiting it would otherwise get an unhandled rejection
      // instead of a server marked `error`.
      const transport = buildTransport(sdk, cfg, e);
      // npx/uvx download the package — and possibly a runtime — before the server says a word, so they
      // get the longer ceiling. Everything else keeps the short one. See config.mjs for the reasoning.
      await client.connect(transport, {
        timeout: usesPackageRunner(cfg) ? CONNECT_TIMEOUT_DOWNLOAD_MS : CONNECT_TIMEOUT_MS,
      });
      e.client = client;
      e.transport = transport;
      e.pid = cfg.kind === "stdio" ? (transport.pid ?? null) : null;

      // Servers add and remove tools at runtime; a cache with no invalidation hands the model tools
      // that no longer exist. listTools() also re-primes the SDK's argument validators.
      client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, async () => {
        try {
          await refreshTools(e);
          emit();
        } catch {
          /* keep the previous list rather than dropping every tool on a transient failure */
        }
      });
      client.onclose = () => {
        // Streamable HTTP reconnects its own stream; a closed stdio pipe means the child is gone.
        if (e.client !== client) return;
        e.status = "idle";
        e.client = null;
        e.transport = null;
        e.tools = [];
        e.pid = null;
        reindex();
        emit();
      };

      await refreshTools(e);
      e.status = "ready";
      e.connectedAt = Date.now();
      e.error = "";
      // reindex() only takes tools from `ready` connections, and the refresh above ran while this one
      // was still `connecting` -- so the index has to be rebuilt once the status is true. Without
      // this the tools are listed to the model but every call resolves to "unknown tool".
      reindex();
    } catch (err) {
      e.status = "error";
      // The stderr tail is usually the real reason ("command not found", a missing API key);
      // err.message alone is often just "connection closed".
      e.error = [err?.message ?? String(err), e.stderr.trim().split("\n").slice(-3).join("\n")]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 600);
      e.tools = [];
      e.client = null;
      e.transport = null;
      try {
        await client.close();
      } catch {
        /* already down */
      }
      reindex();
    } finally {
      e.connecting = null;
      emit();
    }
    return e;
  })();

  return e.connecting;
}

export async function disconnectServer(id) {
  const e = conns.get(id);
  if (!e) return { ok: true };

  // A runtime-owned server has no client here to close; the child belongs to the sidecar and only it
  // can stop it. The state event that follows clears the entry, but the local state is cleared now
  // regardless so the panel and the tool index never show a server this function has already ended.
  const remote = e.remote;
  e.remote = false;

  const client = e.client;
  e.client = null;
  e.transport = null;
  e.tools = [];
  e.pid = null;
  e.status = "idle";
  reindex();
  emit();
  try {
    if (remote) await mcpDisconnect(id);
    // Closing the client closes the transport, which kills a stdio child process.
    else await client?.close();
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/**
 * Connect every approved, enabled server in the background. Called once after the app is ready:
 * startup must never wait on a handshake (a wedged server would delay the window), but a user who
 * opens a chat a few seconds later should find their tools already there.
 */
export function autoConnectApproved() {
  for (const cfg of listServers()) {
    if (cfg.disabled || !cfg.approved) continue;
    void connectServer(cfg.id).catch(() => {
      /* connectServer never rejects; this is belt and braces */
    });
  }
}

// ── The registry surface aiToolkit merges ─────────────────────────────────────

/** Synchronous and cache-backed: listTools() is on the hot path of every turn. */
export function listMcpTools() {
  const out = [];
  for (const e of conns.values()) {
    if (e.status !== "ready") continue;
    for (const t of e.tools) out.push({ name: t.name, description: t.description, parameters: t.parameters });
  }
  return out;
}

/**
 * Execute one MCP tool. Returns runTool's `{ ok, content }` contract -- including for every failure
 * mode, because a thrown error here would abort the turn instead of letting the model see what
 * went wrong and try something else.
 */
export async function callMcpTool(name, args = {}, { signal } = {}) {
  let target = toolIndex.get(name);
  if (!target) {
    // Not connected yet (lazy start, or the server dropped): resolve the server from the name and
    // connect on demand before giving up.
    const [, serverId] = name.split(NAME_SEP);
    const cfg = listServers().find((c) => safeSegment(c.id) === serverId);
    if (!cfg) return { ok: false, content: `Unknown MCP tool: ${name}` };
    if (cfg.disabled) return { ok: false, content: `MCP server "${cfg.id}" is disabled.` };
    if (!cfg.approved) return { ok: false, content: `MCP server "${cfg.id}" has not been approved by the user yet.` };
    const e = await connectServer(cfg.id);
    if (e.status !== "ready") return { ok: false, content: `MCP server "${cfg.id}" is unavailable: ${e.error || "not connected"}` };
    target = toolIndex.get(name);
    if (!target) return { ok: false, content: `Unknown MCP tool: ${name}` };
  }

  const e = conns.get(target.serverId);
  const cfg = getServer(target.serverId);

  // A server the Rust runtime owns. The reply comes back untouched and is converted here, by the same
  // `flattenContent` and the same `isError` rule the SDK path uses -- so what the model reads does not
  // depend on which implementation held the connection.
  if (e?.remote) {
    const res = await mcpCall(target.serverId, target.toolName, args ?? {}, { signal });
    if (!res) return { ok: false, content: `MCP server "${target.serverId}" is not connected.` };
    if (!res.delivered) return { ok: false, content: `Error in ${name}: ${res.error ?? "the call was not delivered"}` };
    return { ok: res.raw?.isError !== true, content: flattenContent(res.raw) };
  }

  if (!e?.client) return { ok: false, content: `MCP server "${target.serverId}" is not connected.` };

  try {
    const res = await e.client.callTool(
      { name: target.toolName, arguments: args ?? {} },
      undefined,
      // The signal cancels the JSON-RPC request when the turn is aborted; the timeout is what stops
      // a silent server from holding the turn open forever.
      { signal, timeout: cfg?.timeoutMs ?? undefined },
    );
    return { ok: res?.isError !== true, content: flattenContent(res) };
  } catch (err) {
    return { ok: false, content: `Error in ${name}: ${err?.message ?? String(err)}` };
  }
}

// ── Status / teardown ─────────────────────────────────────────────────────────

/** What the settings panel renders. Never includes secrets -- see config.publicServer(). */
export function mcpStatus() {
  return listServers().map((cfg) => {
    const e = conns.get(cfg.id);
    return {
      id: cfg.id,
      status: cfg.disabled ? "disabled" : (e?.status ?? "idle"),
      error: e?.error ?? "",
      stderr: e?.stderr ?? "",
      pid: e?.pid ?? null,
      connectedAt: e?.connectedAt ?? 0,
      tools: (e?.status === "ready" ? e.tools : []).map((t) => ({ name: t.name, raw: t.raw, description: t.description })),
    };
  });
}

/** Close every connection. Called from before-quit, alongside disposeEngines(). */
export async function disposeMcp() {
  const ids = [...conns.keys()];
  await Promise.allSettled(ids.map((id) => disconnectServer(id)));
  conns.clear();
  toolIndex.clear();
}
