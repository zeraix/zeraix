/**
 * MCP server DISCOVERY -- turning "connect me to something for GitHub" into a config a user can approve.
 *
 * This exists because of the single biggest gap in the settings-panel flow: a user who wants an MCP
 * server has to already know its command line, its package name, and which API keys it wants. Almost
 * nobody does. So the chat tool (electron/tools/mcpAdmin.mjs) needs to be able to *propose* concrete,
 * ready-to-run candidates, and this module is where a proposal comes from.
 *
 * Two sources, in this order:
 *
 *  1. PINS -- a short hand-maintained shortlist (below). Not a competing catalogue: it exists purely
 *     because the registry's relevance ranking is weak on exactly the queries users actually type.
 *     Searching the live registry for "github" returns neither the official GitHub server nor
 *     anything close to it in the first page, which would have us proposing a random third-party
 *     server for the most common request there is.
 *  2. The official registry at registry.modelcontextprotocol.io -- the canonical, always-current
 *     index. It covers the long tail the pins never will, and it is the reason this feature does not
 *     rot: a server published last week is discoverable without an app update.
 *
 * The output of both is one shape, `Candidate`, which is deliberately *config-complete*: it carries
 * the exact command/args or URL that will be written to servers.json, plus `needs` -- everything the
 * user still has to supply (an API key, a directory path). A candidate with an unsatisfied `needs`
 * entry must never be connected silently; that list is what the model turns into a question.
 *
 * `setup` covers the case `needs` cannot: servers that bridge to a DESKTOP APPLICATION already
 * running on the machine (Blender, Ableton, Unity). These are ordinary stdio servers as far as the
 * transport is concerned, but the command only works once an add-on has been installed inside the
 * host app and that app is open with its bridge switched on. Connecting without that succeeds at
 * the handshake and then fails on every tool call, or hangs -- a failure mode nobody diagnoses from
 * an error message. So the prerequisite travels with the candidate and gets read out to the user
 * BEFORE the connect, which is the only point where telling them is still useful.
 *
 * What this module does NOT do: connect, write config, or decide trust. It only proposes.
 */

/** Registry base. v0 is the current API surface; the shape it returns is documented at modelcontextprotocol.io. */
const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
/** Discovery happens while the user waits in a chat turn, so it fails fast rather than hanging the turn. */
const REGISTRY_TIMEOUT_MS = 12_000;

/**
 * Hand-picked shortcuts for the servers users ask for by name.
 *
 * `keywords` are matched against the user's query, so they should read like what someone would
 * actually type ("github", "browser", "docs"). `needs` is the honest list of what the user must
 * still provide -- getting this wrong is worse than omitting the pin, because it produces a server
 * that is approved and then immediately fails to start.
 *
 * These are a convenience, not a source of truth. If one goes stale the connect fails with the
 * server's own stderr surfaced (see client.mjs), and the registry path still finds a working entry.
 */
const PINS = [
  {
    id: "filesystem",
    title: "Filesystem",
    description: "Read and write files under directories you explicitly allow.",
    keywords: ["file", "files", "filesystem", "folder", "directory", "disk"],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    needs: [{ kind: "arg", name: "path", description: "Absolute path of the directory the server may access. Repeat for more than one.", required: true, secret: false }],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "playwright",
    title: "Playwright browser",
    description: "Drive a real browser: navigate, click, fill forms, read pages, take screenshots.",
    keywords: ["playwright", "browser", "web", "automation", "scrape", "screenshot"],
    config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    needs: [],
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "github",
    title: "GitHub (official)",
    description: "Repositories, issues, pull requests and code search on GitHub.",
    keywords: ["github", "repo", "repository", "issue", "pull request", "pr", "git"],
    config: { url: "https://api.githubcopilot.com/mcp/" },
    needs: [{ kind: "header", name: "Authorization", description: "GitHub personal access token, sent as `Bearer <token>`. Create one at github.com/settings/tokens.", required: true, secret: true }],
    homepage: "https://github.com/github/github-mcp-server",
  },
  {
    id: "context7",
    title: "Context7 docs",
    description: "Up-to-date API documentation and code examples for libraries and frameworks.",
    keywords: ["context7", "docs", "documentation", "library", "api reference"],
    config: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    needs: [],
    homepage: "https://github.com/upstash/context7",
  },
  {
    id: "git",
    title: "Git (local repository)",
    description: "Read history, diffs and branches of a local Git repository.",
    keywords: ["git", "commit", "diff", "branch", "history", "version control"],
    config: { command: "uvx", args: ["mcp-server-git"] },
    needs: [{ kind: "arg", name: "--repository <path>", description: "Path of the local Git repository to expose.", required: false, secret: false }],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "memory",
    title: "Knowledge graph memory",
    description: "A persistent knowledge graph the assistant can write facts to and recall later.",
    keywords: ["memory", "knowledge graph", "remember", "notes", "recall"],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    needs: [],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "fetch",
    title: "Fetch (web pages as markdown)",
    description: "Fetch a URL and convert it to markdown for reading.",
    keywords: ["fetch", "url", "web page", "http", "markdown", "read page"],
    config: { command: "uvx", args: ["mcp-server-fetch"] },
    needs: [],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "everything",
    title: "Everything (reference test server)",
    description: "The protocol's own demo server: exercises every MCP feature. Useful to verify the connection works at all.",
    keywords: ["everything", "test", "demo", "example", "reference", "try"],
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
    needs: [],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
  },
  // ── Servers that bridge to an application running on this machine ───────────
  // These are why `setup` exists. The command is only half the story: the other half is an add-on
  // inside the host app, which the user installs once and switches on per session.
  {
    id: "blender",
    title: "Blender (3D modelling)",
    description: "Drive Blender: create and modify objects and materials, run Python in the scene, inspect it, and download assets from PolyHaven / Sketchfab.",
    keywords: ["blender", "3d", "model", "modelling", "modeling", "render", "scene", "mesh", "draw", "sculpt", "animation"],
    config: { command: "uvx", args: ["blender-mcp"] },
    needs: [],
    setup: [
      "Blender must be installed, and `uv` must be installed (this server runs via `uvx`).",
      "Download `addon.py` from the project page and install it in Blender: Edit → Preferences → Add-ons → Install from Disk, then tick \"Interface: Blender MCP\".",
      "In Blender's 3D viewport press N to open the sidebar, choose the \"BlenderMCP\" tab, and click \"Connect to MCP server\".",
      "Leave Blender open. The bridge only works while Blender is running with that panel connected.",
    ],
    homepage: "https://github.com/ahujasid/blender-mcp",
  },
  {
    id: "ableton",
    title: "Ableton Live (music production)",
    description: "Drive Ableton Live: create tracks and clips, edit MIDI notes, load instruments and effects, and control playback.",
    keywords: ["ableton", "live", "music", "midi", "daw", "audio", "track", "compose"],
    config: { command: "uvx", args: ["ableton-mcp"] },
    needs: [],
    setup: [
      "Ableton Live must be installed, and `uv` must be installed (this server runs via `uvx`).",
      "Install the AbletonMCP Remote Script: copy the project's `AbletonMCP_Remote_Script` folder into Ableton's MIDI Remote Scripts directory.",
      "In Ableton: Settings → Link, Tempo & MIDI → set a Control Surface to \"AbletonMCP\".",
      "Leave Ableton Live open while using it.",
    ],
    homepage: "https://github.com/ahujasid/ableton-mcp",
  },
];

// ── Candidate construction from a registry entry ──────────────────────────────

/** Tails that identify nothing: `com.notion/mcp` must not become the server called "mcp". */
const GENERIC_TAILS = new Set(["mcp", "server", "mcp-server", "server-mcp", "app", "api", "main", "default"]);
/**
 * Namespace segments that name a registrar or a hosting convention rather than the publisher, so the
 * fallback keeps walking left past them: `br.com.music360.app/mcp-server` is the Music360 server, not
 * "app", and `io.github.someone/x` belongs to someone, not to GitHub.
 */
const NAMESPACE_NOISE = new Set([
  "com", "io", "net", "org", "dev", "app", "ai", "co", "me", "sh", "gg", "xyz", "tech", "cloud", "tools", "run",
  "br", "uk", "us", "cn", "de", "fr", "jp", "in", "eu", "au", "ca", "nl", "es", "it", "ru",
  "github", "gitlab", "bitbucket", "inc", "llc", "ltd", "www",
]);

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Derive a readable server id from a reverse-DNS registry name (`io.github.owner/thing`).
 *
 * This matters more than it looks: the id is what the user types to refer to the server and what
 * every one of its tools is named after (`mcp__<id>__<tool>`), so a bad one is user-visible forever.
 * Two things the naive "take the part after the slash" gets wrong, both seen in live registry data:
 * `com.notion/mcp` yields "mcp" — a name that identifies nothing and reads as though it were THE MCP
 * server — and a long publisher-prefixed tail gets truncated mid-word at the 32-char limit.
 *
 * So: drop the redundant "mcp" decoration, fall back to the publisher segment when the tail says
 * nothing (`com.notion/mcp` -> "notion"), and truncate on a separator rather than mid-word.
 */
function idFromName(name) {
  const raw = String(name);
  const [namespace, tail] = raw.includes("/") ? [raw.slice(0, raw.indexOf("/")), raw.slice(raw.indexOf("/") + 1)] : ["", raw];

  // "foo-mcp" / "mcp-foo" / "foo-mcp-server" all identify the same thing as plain "foo".
  let base = slug(tail).replace(/^mcp[-_]/, "").replace(/[-_]mcp([-_]server)?$/, "").replace(/[-_]server$/, "");
  if (!base || GENERIC_TAILS.has(base)) {
    // The publisher is the only remaining signal: com.notion -> notion, br.com.music360.app -> music360.
    // Walk right-to-left past registrar/hosting segments to the first one that actually names someone.
    const segs = namespace.split(".").map(slug).filter(Boolean);
    const seg = [...segs].reverse().find((s) => !NAMESPACE_NOISE.has(s) && !GENERIC_TAILS.has(s));
    base = seg || segs[segs.length - 1] || base;
  }
  if (!base) return "server";
  if (base.length <= 32) return base;
  // Cut at the last separator inside the limit so the id stays a whole word.
  const cut = base.slice(0, 32);
  const lastSep = Math.max(cut.lastIndexOf("-"), cut.lastIndexOf("_"));
  return (lastSep >= 8 ? cut.slice(0, lastSep) : cut).replace(/[-_]+$/, "");
}

/**
 * Render one registry `arguments` entry into argv.
 *
 * A registry argument carries either a concrete `value` or only a `valueHint` -- the latter meaning
 * "the user has to fill this in". Hints are NOT guessed at: they come back through `needs` so the
 * question reaches the user, because a filesystem server started against the wrong directory is
 * both useless and alarming.
 */
function renderArgs(list, needs) {
  const argv = [];
  for (const a of list ?? []) {
    const named = a?.type === "named";
    const value = typeof a?.value === "string" ? a.value : "";
    if (named) {
      if (!a?.name) continue;
      if (value) argv.push(a.name, value);
      else if (a?.isRequired) needs.push({ kind: "arg", name: a.name, description: a.description || a.valueHint || "Required value.", required: true, secret: false });
      continue;
    }
    if (value) argv.push(value);
    else if (a?.isRequired) needs.push({ kind: "arg", name: a?.valueHint || a?.name || "value", description: a?.description || "Required positional argument.", required: true, secret: false });
  }
  return argv;
}

/** Environment variables / headers a package declares, as `needs` entries plus any preset values. */
function renderVars(list, kind, needs) {
  const preset = {};
  for (const v of list ?? []) {
    if (!v?.name) continue;
    // A `value` containing a {placeholder} is a template for the user to fill, not a usable default.
    const value = typeof v.value === "string" && !/\{[^}]+\}/.test(v.value) ? v.value : "";
    if (value) preset[v.name] = value;
    else if (v.isRequired || v.isSecret) {
      needs.push({ kind, name: v.name, description: v.description || (v.isSecret ? "Secret value." : "Required value."), required: v.isRequired === true, secret: v.isSecret === true });
    }
  }
  return preset;
}

/** npx/uvx/docker invocation for a registry package entry, or null if we cannot run it. */
function commandFor(pkg, needs) {
  const id = pkg?.identifier;
  if (!id) return null;
  const runtimeArgs = renderArgs(pkg.runtimeArguments, needs);
  const pkgArgs = renderArgs(pkg.packageArguments, needs);
  const type = pkg.registryType;
  const hint = pkg.runtimeHint;

  if (type === "npm" || hint === "npx") {
    // `-y` suppresses npx's install prompt, which would otherwise look like a hung server: the
    // handshake times out with no output while npx silently waits on stdin for a confirmation.
    const spec = pkg.version ? `${id}@${pkg.version}` : id;
    const args = runtimeArgs.includes("-y") ? [...runtimeArgs, spec] : ["-y", ...runtimeArgs, spec];
    return { command: "npx", args: [...args, ...pkgArgs] };
  }
  if (type === "pypi" || hint === "uvx") {
    return { command: "uvx", args: [...runtimeArgs, id, ...pkgArgs] };
  }
  if (type === "oci" || hint === "docker") {
    return { command: "docker", args: ["run", "-i", "--rm", ...runtimeArgs, id, ...pkgArgs] };
  }
  return null;
}

/**
 * One registry entry -> at most one Candidate.
 *
 * Preference order across the transports an entry may offer: npm, then pypi, then a hosted remote,
 * then docker. npm first because it is what the overwhelming majority of desktop MCP configs use and
 * it needs no daemon; docker last because requiring Docker to be installed and running is the most
 * likely way for a connection to fail on a machine we know nothing about.
 */
function candidateFromRegistry(entry) {
  const s = entry?.server;
  if (!s?.name) return null;
  const needs = [];
  const packages = Array.isArray(s.packages) ? s.packages : [];
  const rank = (p) => (p?.registryType === "npm" || p?.runtimeHint === "npx" ? 0 : p?.registryType === "pypi" || p?.runtimeHint === "uvx" ? 1 : 3);
  const stdio = [...packages].sort((a, b) => rank(a) - rank(b))[0];

  let config = null;
  let transport = "";
  const cmd = stdio ? commandFor(stdio, needs) : null;
  if (cmd) {
    const env = renderVars(stdio.environmentVariables, "env", needs);
    config = { ...cmd, ...(Object.keys(env).length ? { env } : {}) };
    transport = "stdio";
  } else {
    const remote = (Array.isArray(s.remotes) ? s.remotes : []).find((r) => r?.url);
    if (!remote) return null;
    const headers = renderVars(remote.headers, "header", needs);
    config = { url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) };
    transport = "http";
  }

  return {
    id: idFromName(s.name),
    title: s.title || s._meta?.["io.modelcontextprotocol.registry/publisher-provided"]?.title || idFromName(s.name),
    description: String(s.description ?? "").trim(),
    source: "registry",
    registryName: s.name,
    version: s.version ?? "",
    transport,
    config,
    needs,
    // The registry has no field for "install an add-on in the host app first", so a registry-sourced
    // desktop bridge arrives without its prerequisite. mcpAdmin says so rather than implying there is
    // nothing to do; pinning such a server is how it gets real steps.
    setup: [],
    homepage: s.repository?.url ?? s.websiteUrl ?? "",
  };
}

/** A pin, in the same shape a registry entry produces. */
function candidateFromPin(pin) {
  return {
    id: pin.id,
    title: pin.title,
    description: pin.description,
    source: "pinned",
    registryName: "",
    version: "",
    transport: pin.config.url ? "http" : "stdio",
    config: { ...pin.config },
    needs: pin.needs.map((n) => ({ ...n })),
    setup: [...(pin.setup ?? [])],
    homepage: pin.homepage,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

function matchesPin(pin, query) {
  const q = query.toLowerCase();
  if (!q) return false;
  if (pin.id.includes(q) || pin.title.toLowerCase().includes(q)) return true;
  return pin.keywords.some((k) => k.includes(q) || q.includes(k));
}

async function queryRegistry(query, limit) {
  const url = `${REGISTRY_URL}?search=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 30)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.servers) ? body.servers : [];
}

/**
 * Find installable servers matching a plain-language query.
 *
 * Returns `{ candidates, warning }` rather than throwing when the registry is unreachable: a user
 * behind a firewall should still get the pinned results, with the degradation stated, instead of an
 * error that reads as "MCP is broken".
 */
export async function searchServers(query, { limit = 6 } = {}) {
  const q = String(query ?? "").trim();
  const pinned = PINS.filter((p) => matchesPin(p, q)).map(candidateFromPin);

  let remote = [];
  let warning = "";
  if (q) {
    try {
      remote = (await queryRegistry(q, limit + 4))
        // Deleted/deprecated entries stay queryable; proposing one produces a server that cannot start.
        .filter((e) => (e?._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active") === "active")
        .map(candidateFromRegistry)
        .filter(Boolean);
    } catch (e) {
      warning = `The public MCP registry could not be reached (${e?.message ?? e}); showing built-in suggestions only.`;
    }
  }

  // Pins first: they were chosen precisely because registry ranking puts the obvious answer far down.
  const seen = new Set();
  const usedIds = new Set();
  const candidates = [];
  for (const c of [...pinned, ...remote]) {
    const key = c.registryName || `pin:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Distinct servers can derive the same id (`com.notion/mcp` and `com.mcparmory/notion` both want
    // "notion"). Left alone that is not a cosmetic clash: the id is the key servers.json is stored
    // under, so connecting the second would overwrite the first — the user would pick one server from
    // the list and silently replace another. Suffix instead, so every proposal is separately addressable.
    if (usedIds.has(c.id)) {
      let n = 2;
      while (usedIds.has(`${c.id}-${n}`)) n++;
      c.id = `${c.id}-${n}`;
    }
    usedIds.add(c.id);
    candidates.push(c);
    if (candidates.length >= limit) break;
  }
  return { candidates, warning };
}

/** Everything on the shortlist, for "what can I connect to?" with no particular target in mind. */
export function listPinned() {
  return PINS.map(candidateFromPin);
}
