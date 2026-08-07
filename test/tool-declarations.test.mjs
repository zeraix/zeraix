/**
 * What is allowed onto the wire as a tool DECLARATION.
 *
 * The declared block sits ahead of `messages` in the cached prefix, so it has to be identical on every
 * install and on every turn of a conversation. Nothing enforced that: `buildToolSet` filtered against a
 * static set of built-in names, which MCP tools — named `mcp__<serverId>__<tool>` from whatever the user
 * connected — could never match, so they were declared in full. That cost schema tokens on every request
 * and, worse, changed the prefix mid-conversation whenever a server connected or altered its tool list.
 *
 * These tests pin the invariant itself rather than the fix, so any future source of dynamic declarations
 * fails here too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { TOOLS } from "../electron/tools/toolSchemas.mjs";

// promptPrefix reaches the system prompts through `@/…` and imports them as raw markdown, neither of
// which node resolves on its own. Registered before the dynamic import below, because a static one would
// be hoisted above this call and fail exactly as it did before the hook existed.
register("./helpers/srcResolve.mjs", import.meta.url);
const { buildToolSet } = await import("../src/lib/ai/promptPrefix.ts");
const { isMcpToolName, isRouted, ROUTED_TOOLS, DISPATCHER_NAME } = await import(
  "../src/lib/ai/toolRouter.ts"
);

const MODES = ["daily", "dev"];
const wrap = (list) => list.map((t) => ({ type: "function", function: t }));
const names = (tools) => tools.map((t) => t.function?.name ?? "");

/** The toolkit list as the renderer sees it: built-ins plus whatever MCP servers are connected. */
const mcpTool = (name) => ({
  name,
  description: `a tool from a connected server (${name})`,
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
});

test("MCP tool names are recognised as routed in every mode", () => {
  assert.equal(isMcpToolName("mcp__github__create_issue"), true);
  assert.equal(isMcpToolName("read_file"), false);
  for (const mode of MODES) {
    assert.equal(isRouted(mode, "mcp__github__create_issue"), true);
    assert.equal(isRouted(mode, "run_command"), false, "the declared core must stay declared");
  }
});

test("no MCP tool is ever declared", () => {
  const connected = [mcpTool("mcp__github__create_issue"), mcpTool("mcp__pg__query")];
  for (const mode of MODES) {
    const declared = names(buildToolSet(mode, wrap([...TOOLS, ...connected])));
    assert.equal(
      declared.some(isMcpToolName),
      false,
      `${mode}: MCP schemas must not reach the tools payload`,
    );
  }
});

test("connecting a server does not change the declared set", () => {
  // The property that actually matters. Tools precede `messages` in the cached prefix, so if this array
  // differs before and after a mid-conversation `mcp_connect`, the next request re-prefills from token 0
  // — which costs far more than the schemas it was carrying.
  for (const mode of MODES) {
    const before = buildToolSet(mode, wrap(TOOLS));
    const after = buildToolSet(
      mode,
      wrap([...TOOLS, mcpTool("mcp__blender__get_scene_info"), mcpTool("mcp__blender__execute_code")]),
    );
    assert.deepEqual(after, before, `${mode}: the declared block must be unaffected by MCP state`);
  }
});

test("the declared set is byte-identical across installs with different servers", () => {
  for (const mode of MODES) {
    const userA = buildToolSet(mode, wrap([...TOOLS, mcpTool("mcp__notion__search")]));
    const userB = buildToolSet(mode, wrap([...TOOLS, mcpTool("mcp__pg__query"), mcpTool("mcp__pg__schema")]));
    assert.equal(JSON.stringify(userA), JSON.stringify(userB), `${mode}: per-install prefix divergence`);
  }
});

test("mcp_tools stays declared — it is the only way to discover the routed ones", () => {
  // Deliberately NOT routed. Everything else about MCP is reachable only if the model knows to look, and
  // this declaration is the single thing in a cache-stable prompt that tells it integrations can exist.
  for (const mode of MODES) {
    const declared = names(buildToolSet(mode, wrap(TOOLS)));
    assert.ok(declared.includes("mcp_tools"), `${mode}: mcp_tools must be declared`);
    assert.equal(ROUTED_TOOLS[mode].has("mcp_tools"), false);
  }
});

test("the dispatcher is present, last, and exactly once", () => {
  for (const mode of MODES) {
    const declared = names(buildToolSet(mode, wrap([...TOOLS, mcpTool("mcp__x__y")])));
    assert.equal(declared.filter((n) => n === DISPATCHER_NAME).length, 1);
    assert.equal(declared[declared.length - 1], DISPATCHER_NAME, "position is prefix bytes");
  }
});

test("an MCP-only toolkit still yields the same declared set as none at all", () => {
  // `native.length` gates the delegation tools, and MCP entries inflate that length. A toolkit consisting
  // only of MCP tools must not switch delegation on, or the declared set would again depend on what the
  // user connected.
  for (const mode of MODES) {
    assert.deepEqual(
      buildToolSet(mode, wrap([mcpTool("mcp__pg__query")])),
      buildToolSet(mode, []),
      `${mode}: MCP tools must not count as native tools`,
    );
  }
});
