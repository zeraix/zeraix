/**
 * Installed plugin tools, as the agent sees them.
 *
 * Modelled on the MCP surface next door, and for the same reason (see src/lib/ai/toolRouter.ts): these
 * are NOT declared in the tool block. A single plugin can carry the whole of an HTTP API — the Gmail
 * one is 79 methods — and tools sit ahead of `messages` in the cached prefix, so declaring them would
 * both bloat every request and re-prefill from token 0 whenever a plugin is installed mid-conversation.
 * Discovery goes through `plugin_tools`, invocation through `call_tool`, and the declared block never
 * moves.
 *
 * The name carries the routing: `plugin__<publisher>_<name>__<capability>`. Namespaced so it cannot
 * collide with a native handler, and resolvable back to exactly one installed capability — a tool call
 * must reach the plugin the user installed, never whichever plugin happens to claim the id, because
 * each holds its own OAuth grant.
 */
import { activeCapabilities, getInstalled, listInstalled } from "./store.mjs";
import { authStatus } from "./auth.mjs";
import { callTool } from "./executor.mjs";

export const TOOL_PREFIX = "plugin";
export const NAME_SEP = "__";

/** `zeraix/gmail` -> `zeraix_gmail`. Unambiguous because a plugin id is `[a-z0-9-]` on both sides. */
const flatten = (pluginId) => pluginId.replace("/", "_");

export function isPluginTool(name) {
  return typeof name === "string" && name.startsWith(`${TOOL_PREFIX}${NAME_SEP}`);
}

export function toolName(pluginId, capabilityId) {
  return `${TOOL_PREFIX}${NAME_SEP}${flatten(pluginId)}${NAME_SEP}${capabilityId}`;
}

/**
 * Resolve a wire name back to an installed capability.
 *
 * Matched against what is installed rather than parsed. A capability id may itself contain `__`
 * (LOCAL_ID_RE allows it), so any rule for where the separator falls is a rule that is sometimes
 * wrong — and "sometimes resolves to a different plugin" is a credential boundary, not a cosmetic
 * one. Comparing whole names has no such case, and the set is small: one pass over what is enabled.
 */
export function resolvePluginTool(name) {
  if (!isPluginTool(name)) return null;
  for (const cap of activeCapabilities()) {
    if (toolName(cap.pluginId, cap.id) === name) return { pluginId: cap.pluginId, capabilityId: cap.id, cap };
  }
  return null;
}

/** Every callable tool an enabled, unrevoked plugin currently offers. */
function callableCapabilities() {
  return activeCapabilities().filter((c) => c.type === "tool" && c.request);
}

/**
 * Tool declarations in runTool's `{ name, description, parameters }` shape.
 *
 * Merged into listTools() so the toolkit can EXECUTE them; what keeps them out of the wire block is
 * toolRouter's routing, not their absence here.
 */
export function listPluginTools() {
  return callableCapabilities().map((c) => ({
    name: toolName(c.pluginId, c.id),
    description: c.description ?? c.name ?? c.id,
    parameters: c.input_schema ?? { type: "object", properties: {} },
  }));
}

/**
 * The `plugin_tools` answer: an inventory by default, schemas on request.
 *
 * Two levels because of the same volume problem — dumping 79 parameter schemas into a turn is most of
 * what declaring them would have cost. The inventory is one line each, and the model asks for the
 * handful it actually needs.
 */
export function describePluginTools({ name = "", plugin = "" } = {}) {
  const caps = callableCapabilities();
  if (caps.length === 0) return noToolsExplanation();

  const wanted = caps.filter((c) => {
    if (name) return toolName(c.pluginId, c.id) === name;
    if (plugin) return c.pluginId === plugin || flatten(c.pluginId) === plugin;
    return false;
  });

  if (wanted.length > 0) {
    return wanted
      .map((c) => {
        const schema = JSON.stringify(c.input_schema ?? { type: "object", properties: {} }, null, 2);
        return `${toolName(c.pluginId, c.id)}\n${c.description ?? ""}\nparameters: ${schema}`;
      })
      .join("\n\n");
  }
  if (name || plugin) return `No plugin tool matches ${name ? `name "${name}"` : `plugin "${plugin}"`}.`;

  const byPlugin = new Map();
  for (const c of caps) {
    if (!byPlugin.has(c.pluginId)) byPlugin.set(c.pluginId, []);
    byPlugin.get(c.pluginId).push(c);
  }
  const lines = [];
  for (const [pluginId, list] of byPlugin) {
    const installed = getInstalled(pluginId);
    // Say up front when an account is not connected. Calling one of these tools will interrupt the
    // user with a consent screen, and a model that knows that can say so first instead of springing it.
    const disconnected = authStatus(pluginId).filter((a) => !a.authorized);
    const note = disconnected.length > 0 ? " — ACCOUNT NOT CONNECTED, the first call will prompt the user to authorize" : "";
    lines.push(`${pluginId}${installed?.name ? ` (${installed.name})` : ""} — ${list.length} tool(s)${note}`);
    for (const c of list) {
      const summary = (c.description ?? "").split(/(?<=[.!?])\s/)[0];
      lines.push(`  ${toolName(pluginId, c.id)} — ${summary}`);
    }
  }
  lines.push("", 'Call plugin_tools again with `name` or `plugin` for parameter schemas, then invoke through call_tool.');
  return lines.join("\n");
}

/**
 * Why there are no tools, stated per plugin rather than guessed.
 *
 * This used to say "plugins add tools once they are enabled and connected", which sounds helpful and
 * is a guess. It sent a user to the Plugins page to enable and connect a plugin that was ALREADY
 * enabled and connected — the real reason being that the plugin ships no callable tool at all. A model
 * relays whatever this returns as though it were a diagnosis, so it has to be one: read the actual
 * state of each install and name the actual reason.
 */
function noToolsExplanation() {
  const installed = listInstalled();
  if (installed.length === 0) {
    return "No plugins are installed, so there are no plugin tools. The user installs them from the Plugins page in the app; you cannot install one yourself.";
  }

  const lines = ["No plugin tool is currently callable. What is installed, and why each provides none:"];
  for (const p of installed) {
    const auth = authStatus(p.id);
    const disconnected = auth.filter((a) => !a.authorized);
    const tools = (p.capabilities ?? []).filter((c) => c.type === "tool");

    let reason;
    if (p.revoked) reason = `revoked by the registry (${p.revoked.reason}) — it cannot be re-enabled`;
    else if (!p.enabled) reason = "disabled by the user on the Plugins page";
    else if (tools.length === 0) {
      // BEFORE the connection check, deliberately. A plugin that ships no tools offers none whether or
      // not its account is connected, so leading with "not connected" would send the user to do
      // something that cannot change the outcome — the exact misdirection this function exists to end.
      // The common case and the one that was being misreported: a perfectly healthy install whose
      // capabilities are skills or prompts. Those reach you through load_skill, not through here.
      const kinds = [...new Set((p.capabilities ?? []).map((c) => c.type))];
      reason = `it provides no tools — it ships ${kinds.join(", ") || "nothing"}${kinds.includes("skill") ? ", which reach you through load_skill instead" : ""}`;
    } else if (disconnected.length > 0) {
      reason = `its account is not connected${disconnected[0].lastError ? ` (last attempt: ${disconnected[0].lastError})` : ""}`;
    } else reason = "its tools declare no request and cannot be called by this version of the app";

    const connected = auth.length > 0 && disconnected.length === 0 ? ", account connected" : "";
    lines.push(`  ${p.id} (${p.name}) v${p.version}${connected}: ${reason}`);
  }
  lines.push(
    "",
    "Do NOT tell the user to enable or connect a plugin unless a line above says it is disabled or not connected — several of these are working exactly as installed and simply have no tools to offer.",
  );
  return lines.join("\n");
}

/**
 * Execute one. Honours runTool's `{ ok, content }` for every failure, because a plugin must not be
 * able to abort a turn by throwing — the model should see what went wrong and be able to try again.
 */
export async function callPluginTool(name, args = {}) {
  const resolved = resolvePluginTool(name);
  if (!resolved) return { ok: false, content: `Unknown plugin tool: ${name}. Call plugin_tools for what is available.` };
  try {
    return await callTool(resolved.pluginId, resolved.capabilityId, args ?? {});
  } catch (e) {
    return { ok: false, content: `${name} failed: ${e?.message ?? String(e)}` };
  }
}
