/**
 * The chat-facing half of MCP: letting a user connect to a server by asking for it in words.
 *
 * Everything under electron/mcp/ assumes you already know what you want to connect to -- the settings
 * panel is a form, and a form is useless to someone who does not know that the thing they want is
 * called `@playwright/mcp` and is started with `npx -y`. These two tools close that gap:
 *
 *   mcp_discover  -- "what could I connect to for GitHub?"  Read-only. Proposes complete configs.
 *   mcp_connect   -- "connect that one."                    Writes config, approves, connects.
 *
 * THE TRUST MODEL, which is the whole reason this is split in two:
 *
 * An MCP server is arbitrary third-party code running as the user, and config.mjs therefore refuses
 * to connect anything whose `approved` flag is not set -- a flag that, until now, only a human
 * clicking in settings could set. `mcp_connect` sets it, so it is the point where a chat message
 * turns into a process on someone's machine, and it is gated twice:
 *
 *   1. `mcp_discover` returns candidates and instructs the model to put them to the user through
 *      `ask_user`. The user picks the server they want, having seen what it is and what it runs.
 *   2. `mcp_connect` is in ALWAYS_CONFIRM_TOOLS (src/app/agent/chat/constants.ts), so the chat shows
 *      its confirmation panel with the exact command line before the call executes.
 *
 * The second gate is the one that is actually load-bearing. The first is a convention the model
 * follows; the second is enforced by the run loop and holds even if the model was talked into
 * calling `mcp_connect` directly by something it read on a web page. Neither is available to a
 * headless automation run: both tools are in INTERACTIVE_TOOLS (electron/agent/turn.mjs), because a
 * 3am unattended run has nobody to ask and must not be able to install a server.
 */
import { getServer, isValidServerId, listServers, publicServer, removeServer, setServerFlag, upsertServer } from "../mcp/config.mjs";
import { connectServer, disconnectServer, mcpStatus } from "../mcp/client.mjs";
import { listPinned, searchServers } from "../mcp/registry.mjs";

/** Shell-ish rendering of a stdio config, purely so the user can read what will run. Never executed. */
function commandLine(cfg) {
  const parts = [cfg.command, ...(cfg.args ?? [])];
  return parts.map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(" ");
}

/** One-line "what does this server run" summary, shared by discovery and status output. */
function targetOf(cfg) {
  return cfg.url ? `HTTP ${cfg.url}` : commandLine(cfg);
}

/** Render the `needs` list: what the user must still supply before the server can start. */
function renderNeeds(needs) {
  if (!needs.length) return "  needs: nothing — can be connected as-is";
  const lines = needs.map((n) => {
    const where = n.kind === "env" ? "env var" : n.kind === "header" ? "HTTP header" : "argument";
    const req = n.required ? "required" : "optional";
    const secret = n.secret ? ", SECRET" : "";
    return `    - ${n.name} (${where}, ${req}${secret}): ${n.description}`;
  });
  return `  needs from the user:\n${lines.join("\n")}`;
}

/**
 * Candidates as the model reads them.
 *
 * The config is spelled out as the literal argument object `mcp_connect` expects, because the model's
 * next call should be a transcription rather than a reconstruction -- rebuilding an npx invocation
 * from prose is exactly where a wrong package name gets invented.
 */
function renderCandidates(candidates) {
  return candidates
    .map((c, i) => {
      const cfgJson = JSON.stringify(c.config);
      const setup = c.setup?.length
        ? `  SETUP REQUIRED IN THE APP ITSELF, before connecting:\n${c.setup.map((s, n) => `    ${n + 1}. ${s}`).join("\n")}`
        : "";
      return [
        `${i + 1}. id: ${c.id}  —  ${c.title}${c.version ? ` (v${c.version})` : ""} [${c.source}]`,
        `  ${c.description || "(no description)"}`,
        `  runs: ${targetOf(c.config)}`,
        renderNeeds(c.needs),
        setup,
        c.homepage ? `  homepage: ${c.homepage}` : "",
        `  to connect: mcp_connect with id "${c.id}" and ${cfgJson}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** Configured servers plus their live connection state, for the "what do I already have" half. */
function renderConfigured() {
  const servers = listServers();
  if (!servers.length) return "No MCP servers are configured yet.";
  const status = new Map(mcpStatus().map((s) => [s.id, s]));
  return servers
    .map((cfg) => {
      const s = status.get(cfg.id);
      const bits = [`- ${cfg.id}: ${s?.status ?? "idle"}`];
      if (!cfg.approved) bits.push("(not approved — the user has not authorised this one yet)");
      if (cfg.disabled) bits.push("(disabled)");
      if (s?.status === "ready") bits.push(`— ${s.tools.length} tool(s): ${s.tools.map((t) => t.name).join(", ") || "none"}`);
      if (s?.error) bits.push(`— error: ${s.error}`);
      return `${bits.join(" ")}\n    runs: ${targetOf(cfg)}`;
    })
    .join("\n");
}

/**
 * Split the caller's flat argument object into the shape config.upsertServer expects.
 *
 * Returns `{ cfg, error }` rather than picking a winner when both transports are given. config.mjs
 * rejects that combination on purpose -- guessing wrong means silently talking to something other
 * than what was approved -- and quietly preferring one here would reintroduce exactly the guess it
 * refuses to make, one layer up where nothing checks it.
 */
function configFromArgs({ command, args, env, cwd, url, headers, timeoutMs } = {}) {
  const hasUrl = typeof url === "string" && url.trim() !== "";
  const hasCommand = typeof command === "string" && command.trim() !== "";
  if (hasUrl && hasCommand) {
    return { cfg: null, error: "Give exactly one transport: `command` (plus `args`) for a local server, or `url` for a hosted one — not both. Pass the configuration exactly as mcp_discover printed it." };
  }
  const cfg = {};
  if (hasUrl) {
    cfg.url = url.trim();
    if (headers && typeof headers === "object") cfg.headers = headers;
  } else if (hasCommand) {
    cfg.command = command.trim();
    if (Array.isArray(args)) cfg.args = args.map(String);
    if (env && typeof env === "object") cfg.env = env;
    if (typeof cwd === "string" && cwd.trim()) cfg.cwd = cwd.trim();
  }
  if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) cfg.timeoutMs = Number(timeoutMs);
  return { cfg, error: "" };
}

export const mcpAdminHandlers = {
  /**
   * Propose servers for a plain-language need, and report what is already configured.
   *
   * Read-only and un-gated on purpose: the whole point is that the user gets to see real options
   * before anything is written or run, so making them confirm a *search* would train them to click
   * through the confirmation that actually matters.
   */
  async mcp_discover({ query } = {}) {
    const q = String(query ?? "").trim();
    const configured = renderConfigured();

    if (!q) {
      return [
        "Currently configured MCP servers:",
        configured,
        "",
        "Commonly used servers that can be connected (pass a `query` to search the full public registry for anything else):",
        renderCandidates(listPinned()),
        "",
        "NEXT STEP: do not connect anything yet. Show the user the options that fit what they asked for " +
          "using `ask_user` — one option per server, naming the server and what it does — and connect only the one they pick.",
      ].join("\n");
    }

    const { candidates, warning } = await searchServers(q, { limit: 6 });
    if (!candidates.length) {
      return [
        `No MCP server matching "${q}" was found in the built-in list or the public registry.`,
        warning,
        "",
        "You can still search the web for one (`web_search` / `fetch_url`) and connect it by passing its " +
          "command and arguments to `mcp_connect` directly. Tell the user where the configuration came from before connecting it.",
        "",
        "Currently configured MCP servers:",
        configured,
      ]
        .filter(Boolean)
        .join("\n");
    }

    return [
      `MCP servers matching "${q}":`,
      warning,
      "",
      renderCandidates(candidates),
      "",
      "Currently configured MCP servers:",
      configured,
      "",
      "NEXT STEP: do not connect anything yet. Put these to the user with `ask_user` — one option per " +
        "candidate, each naming the server and, in a few words, what it does. Then call `mcp_connect` for " +
        "the one they choose, passing the id and config shown above verbatim. If the chosen server lists " +
        "anything under `needs from the user`, ask for those values first; for a SECRET value, tell the " +
        "user it will be stored in the app's MCP configuration file and will appear in this conversation, " +
        "and offer Settings → MCP as the alternative place to enter it. If it lists SETUP REQUIRED, walk " +
        "the user through those steps and get their confirmation that the application is open and connected " +
        "BEFORE calling mcp_connect — a bridge to a desktop app connects and then fails on every call if its " +
        "add-on is not running, which is very hard to diagnose afterwards.",
    ]
      .filter(Boolean)
      .join("\n");
  },

  /**
   * Configure, authorise and connect one server -- the point where chat turns into a running process.
   *
   * Approval is set here rather than left to the settings panel because the user has just chosen this
   * server from `ask_user` and confirmed the command line in the chat's consent panel; sending them to
   * a settings screen to tick a third box would be ceremony, not safety. What is NOT relaxed: the
   * config is written first and approved second, so servers.json always reflects exactly what was
   * approved, and re-approval is still required if the command line later changes (upsertServer
   * clears the flag when the target moves).
   */
  async mcp_connect({ id, action = "connect", ...rest } = {}) {
    const serverId = String(id ?? "").trim();
    if (!isValidServerId(serverId)) {
      // The example uses a fixed id, never the rejected one: echoing the invalid text back into a
      // sample tool name shows a name that is itself invalid, which reads as though it were allowed.
      return `Invalid server id "${serverId}". Use 1–32 characters from A–Z, a–z, 0–9, "_" or "-" — no spaces or punctuation — because the id becomes part of every tool name this server exposes (e.g. id "github" gives mcp__github__search).`;
    }

    if (action === "disconnect" || action === "remove") {
      if (!getServer(serverId)) return `No MCP server called "${serverId}" is configured.`;
      await disconnectServer(serverId);
      if (action === "remove") {
        removeServer(serverId);
        return `Removed the MCP server "${serverId}" and disconnected it. Its tools are no longer available.`;
      }
      return `Disconnected the MCP server "${serverId}". Its configuration is kept, so it can be reconnected later.`;
    }

    const { cfg: incoming, error: cfgError } = configFromArgs(rest);
    if (cfgError) return cfgError;
    const existing = getServer(serverId);
    if (!existing && !incoming.command && !incoming.url) {
      return `"${serverId}" is not configured yet, so connecting it needs its configuration too: pass either \`command\` (plus \`args\`) for a local server, or \`url\` for a hosted one. Call mcp_discover first to find them.`;
    }

    // Writing before approving keeps servers.json honest about what was authorised. Re-running with
    // the same target is a no-op that preserves an existing approval (see config.upsertServer).
    if (incoming.command || incoming.url) {
      const res = upsertServer(serverId, incoming);
      if (!res.ok) {
        return res.error === "invalid-server-config"
          ? `That configuration is not usable: give exactly one of \`command\` (local process) or \`url\` (hosted server), not both and not neither.`
          : `Could not save "${serverId}": ${res.error}`;
      }
    }

    const cfg = getServer(serverId);
    if (cfg.disabled) setServerFlag(serverId, "disabled", false);
    setServerFlag(serverId, "approved", true);

    const e = await connectServer(serverId);
    if (e.status !== "ready") {
      // The stderr tail is folded into e.error by client.mjs and is usually the real cause
      // ("command not found", a rejected token), so it is worth more to the model than a retry.
      return [
        `Could not connect to the MCP server "${serverId}": ${e.error || "unknown error"}.`,
        `It runs: ${targetOf(cfg)}`,
        "It stays configured, so it can be fixed and retried. Common causes: the command is not installed " +
          "(npx needs Node, uvx needs uv); the very first connect timed out while npx/uvx downloaded the " +
          "package, in which case simply calling mcp_connect again usually succeeds now the download is " +
          "cached; a required API key or environment variable is missing or wrong; " +
          "a required argument such as a directory path was not supplied, or — for a server that bridges to " +
          "a desktop application such as Blender or Ableton — that application is not running, or is running " +
          "without its MCP add-on installed and switched on. Tell the user what went wrong and what you need " +
          "from them; do not silently try a different server.",
      ].join("\n");
    }

    const tools = mcpStatus().find((s) => s.id === serverId)?.tools ?? [];
    return [
      `Connected to the MCP server "${serverId}" (${targetOf(cfg)}).`,
      tools.length
        ? `Its ${tools.length} tool(s) are now available to you and can be called directly: ${tools.map((t) => t.name).join(", ")}.`
        : "It connected but exposes no tools.",
      "It is saved and approved, so it reconnects automatically on future launches. " +
        "Tell the user it is connected and what it can now do, then carry on with what they originally asked for.",
    ].join("\n");
  },
};
