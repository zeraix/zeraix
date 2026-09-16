/**
 * The MCP half of the Rust runtime bridge: connect, call, disconnect, and tell the runtime which servers
 * the user has approved.
 *
 * Split out of rustRuntime.mjs, which owns spawning the sidecar and speaking its protocol; this file only
 * shapes the `mcp.*` requests. Its one consumer is electron/mcp/client.mjs.
 */
import { CALL_TIMEOUT_MS, ensureStarted, notify, readyState, request } from "./rustRuntime.mjs";

/**
 * Ids for `mcp.call`. A counter of its own is safe because the `m` prefix is unique to this file:
 * rustRuntime.mjs mints `h…` for tools and `p…` for processes.
 */
let callSeq = 0;

/**
 * Hand one stdio MCP server to the runtime to own.
 *
 * Returns true once the supervisor is running — NOT once the server is ready. Readiness, failure and
 * every later transition arrive as `mcp.state` events, which is the only arrangement compatible with
 * `listMcpTools()` staying synchronous.
 *
 * `env` is the child's complete environment and the host's responsibility: it is built from the MCP
 * SDK's allowlist precisely to keep `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` out of a node-based
 * server, and the sidecar carries both.
 */
export async function mcpConnect({ id, command, args, cwd, env, url, headers }) {
  const s = await ensureStarted();
  // A local program and a remote endpoint are separate capabilities: a runtime that serves one may not
  // serve the other, and routing on the wrong one is how a server silently stops connecting.
  const needed = url ? "mcp.http" : "mcp.stdio";
  if (!s || !s.features.has(needed)) return false;
  try {
    await request(
      s,
      "mcp.connect",
      url
        ? { id, url, headers: Object.entries(headers ?? {}) }
        : { id, command, args: args ?? [], cwd: cwd ?? null, env: Object.entries(env ?? {}) },
      CALL_TIMEOUT_MS,
    );
    return true;
  } catch (e) {
    console.warn(`[rust-runtime] mcp.connect(${id}) failed:`, e?.message ?? e);
    return false;
  }
}

/**
 * Tell the runtime exactly which MCP servers the user has approved, replacing whatever it last heard.
 *
 * The runtime refuses every `mcp.call` to a server outside this list ("outside the configured ceiling"),
 * and it cannot learn the list any other way: approvals live in servers.json, and a user approves a server
 * whenever they add one — usually long after the sidecar started. Sending the whole list rather than a
 * change means a restarted sidecar or a lost reply is settled by the next send.
 *
 * Never starts the runtime: there is nothing to approve on a runtime that is not running, and a runtime
 * started later hears the list before its first `mcp.connect`. Returns false when the list was not
 * delivered, including on a runtime too old to accept it (no `mcp.approval` feature).
 */
export async function mcpSetApproved(servers) {
  const s = readyState();
  if (!s?.features.has("mcp.approval")) return false;
  try {
    const r = await request(s, "mcp.set_approved", { servers: [...servers] }, 10_000);
    return r?.applied === true;
  } catch (e) {
    console.warn("[rust-runtime] mcp.set_approved failed:", e?.message ?? e);
    return false;
  }
}

/**
 * Call one tool on a runtime-owned server.
 *
 * Returns the server's reply **untouched** (`{ delivered, raw }`), or null if the runtime could not be
 * reached at all. The caller converts: the `[server]` description prefix, the schema normalisation and
 * the content flattening are all its own, and keeping them there is what stops the declarations and
 * results a model sees from shifting under this migration.
 */
export async function mcpCall(server, tool, args, { signal } = {}) {
  const s = await ensureStarted();
  if (!s || !s.features.has("mcp.stdio")) return null;

  const id = `m${++callSeq}`;
  const onAbort = () => notify(s, "call.cancel", { call_id: id });
  if (signal?.aborted) return { delivered: false, error: "the user stopped this operation" };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await request(s, "mcp.call", { server, tool, args: args ?? {}, call_id: id }, CALL_TIMEOUT_MS);
    return r ?? null;
  } catch (e) {
    // Unlike a command, an MCP call has no "it may already have run" hazard worth protecting: the
    // caller's fallback is its own SDK connection, which this server does not have. Report it.
    return { delivered: false, error: e?.message ?? String(e) };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Stop supervising one server. */
export async function mcpDisconnect(id) {
  const s = readyState();
  if (!s?.features.has("mcp.stdio")) return false;
  try {
    const r = await request(s, "mcp.disconnect", { id }, 10_000);
    return Boolean(r?.disconnected);
  } catch {
    return false;
  }
}
