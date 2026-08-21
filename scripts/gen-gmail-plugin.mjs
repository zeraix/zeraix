#!/usr/bin/env node
/**
 * Generate the zeraix/gmail plugin from Google's own Gmail API discovery document.
 *
 *   node scripts/gen-gmail-plugin.mjs --out registry [--discovery <file|url>]
 *
 * Hand-writing 79 tools would be 79 chances to mistype a path, a required parameter or an HTTP verb,
 * and every one of those is a failure the user meets at run time as an unexplained 404. The discovery
 * document is what Google publishes as the definition of the API, so it is what the manifest is built
 * from — regenerating after a revision picks up new methods for free, and the diff shows exactly what
 * Google changed.
 *
 * What is NOT taken from the document: the OAuth block, the tier, and the permitted hosts. Those are
 * trust decisions, and they belong to whoever reviews the plugin rather than to an upstream file that
 * can change without anyone here reading it.
 */
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DISCOVERY = arg("discovery", "https://gmail.googleapis.com/$discovery/rest?version=v1");
const outRoot = path.resolve(arg("out", "registry"));
const VERSION = "1.0.0";
const PLUGIN_ID = "zeraix/gmail";

/**
 * The scopes this plugin asks for.
 *
 * `https://mail.google.com/` is full mailbox access and it is what "all Gmail APIs" costs — the
 * read-only and send-only scopes cannot reach modify, delete, or history. The two settings scopes are
 * separate because Google keeps them separate; without them the settings.* methods 403 even with full
 * mail access. Written here rather than derived from the document so that widening what the plugin can
 * do is always a visible edit in this file, never a side effect of regenerating.
 */
const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

async function loadDiscovery(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`discovery fetch failed: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(src, "utf8"));
}

/** Every method in the document, depth-first, with its dotted id. */
function collectMethods(node, out = []) {
  for (const m of Object.values(node.methods ?? {})) out.push(m);
  for (const r of Object.values(node.resources ?? {})) collectMethods(r, out);
  return out;
}

/** `gmail.users.messages.send` -> `users_messages_send`, which is what the tool name ends in. */
const capabilityId = (methodId) => methodId.replace(/^gmail\./, "").replace(/\./g, "_");

/** Discovery marks reserved expansion as `{+name}`; the executor's placeholders are plain `{name}`. */
const normalizePath = (p) => `/${p}`.replace(/\{\+?([A-Za-z0-9_]+)\}/g, "{$1}");

/** One discovery parameter -> one JSON Schema property the model can fill. */
function property(spec) {
  const type = spec.type === "integer" || spec.type === "number" ? "number" : spec.type === "boolean" ? "boolean" : "string";
  const out = { type, description: (spec.description ?? "").replace(/\s+/g, " ").trim() };
  if (Array.isArray(spec.enum) && spec.enum.length > 0) out.enum = spec.enum;
  if (spec.default !== undefined) out.description += ` Defaults to "${spec.default}".`;
  return out;
}

const discovery = await loadDiscovery(DISCOVERY);
const methods = collectMethods(discovery).sort((a, b) => a.id.localeCompare(b.id));

const capabilities = [];
const unreachable = [];

for (const m of methods) {
  // A method none of our scopes satisfy would install as a tool that always 403s. Reported, not
  // silently dropped: a gap in coverage is exactly the thing to know about at generation time.
  if (Array.isArray(m.scopes) && !m.scopes.some((s) => SCOPES.includes(s))) {
    unreachable.push(`${m.id} (needs one of: ${m.scopes.join(", ")})`);
    continue;
  }

  const params = m.parameters ?? {};
  const properties = {};
  const required = [];
  const query = {};

  for (const [name, spec] of Object.entries(params)) {
    properties[name] = property(spec);
    if (spec.required && spec.location === "path") required.push(name);
    if (spec.location === "query") query[name] = `{${name}}`;
  }

  // `userId` is required by every path and is always `me` for an OAuth grant, so it is filled in
  // rather than asked for. Leaving it to the model means 79 tools that can each be called against
  // somebody else's mailbox id by mistake.
  const requestPath = normalizePath(m.flatPath ?? m.path).replace("{userId}", "me");
  delete properties.userId;
  const requiredParams = required.filter((r) => r !== "userId");

  const request = { method: m.httpMethod, path: requestPath };
  if (Object.keys(query).length > 0) request.query = query;
  if (m.request) {
    // The API's own resource, passed through whole. Modelling every Gmail schema as JSON Schema here
    // would be a second, drifting copy of the document; the API validates it and says what is wrong.
    properties.body = {
      type: "object",
      description: `The ${m.request.$ref} resource for this request, as the Gmail API defines it.`,
    };
    request.body = "{body}";
  }

  capabilities.push({
    type: "tool",
    id: capabilityId(m.id),
    name: m.id.replace(/^gmail\./, ""),
    description: `${(m.description ?? "").replace(/\s+/g, " ").trim()} (${m.httpMethod} ${requestPath})`,
    provider: "gmail_api",
    input_schema: { type: "object", properties, ...(requiredParams.length ? { required: requiredParams } : {}) },
    request,
  });
}

const manifest = {
  schemaVersion: 1,
  id: PLUGIN_ID,
  version: VERSION,
  name: "Gmail",
  description: "The full Gmail API — read, search, send, label, thread, draft and configure mail in the user's own account.",
  license: "Apache-2.0",
  homepage: "https://github.com/zeraix/registry/tree/main/plugins/zeraix/gmail",
  pricing: { model: "free" },
  providers: {
    google_auth: {
      kind: "oauth",
      tier: "host",
      oauth: {
        known_provider: "google",
        scopes: SCOPES,
        client: { type: "host" },
        redirect: { method: "loopback" },
        mints: "gmail_oauth",
      },
      permissions: { network: ["accounts.google.com", "oauth2.googleapis.com"], credentials: [] },
    },
    gmail_api: {
      kind: "http",
      tier: "sandboxed",
      url: "https://gmail.googleapis.com",
      auth: "google_auth",
      permissions: { network: ["gmail.googleapis.com"], credentials: ["gmail_oauth"] },
    },
  },
  capabilities,
};

const dir = path.join(outRoot, "plugins", PLUGIN_ID, VERSION);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Gmail API v${discovery.version} revision ${discovery.revision}`);
console.log(`${capabilities.length} of ${methods.length} methods -> ${path.join(dir, "plugin.json")}`);
if (unreachable.length > 0) {
  // Never silent about incomplete coverage: "79 tools" that is really 74 reads as complete.
  console.log(`\n${unreachable.length} method(s) NOT included, no declared scope covers them:`);
  for (const u of unreachable) console.log(`  ${u}`);
}
