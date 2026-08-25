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
const { buildSystemPrompt, buildToolSet } = await import("../src/lib/ai/promptPrefix.ts");
const { isMcpToolName, isRouted, ROUTED_TOOLS, DISPATCHER_NAME } = await import(
  "../src/lib/ai/toolRouter.ts"
);

const wrap = (list) => list.map((t) => ({ type: "function", function: t }));
const names = (tools) => tools.map((t) => t.function?.name ?? "");

/** The toolkit list as the renderer sees it: built-ins plus whatever MCP servers are connected. */
const mcpTool = (name) => ({
  name,
  description: `a tool from a connected server (${name})`,
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
});

/**
 * The goal tools are gone from every layer, not merely undeclared.
 *
 * Removing a tool from the declared set only stops it being ADVERTISED. `call_tool` resolves any name it is
 * given, and the loop then looks that name up in the renderer's dispatch table — so a tool removed from the
 * schema and the catalog but left in the table is still fully callable by a model that remembers it. The goal
 * belongs to the user (`/goal`), so all three layers were closed together, and this pins that.
 */
test("the model cannot reach set_goal or update_plan by any route", async () => {
  const { RENDERER_HANDLED_TOOLS } = await import("../src/app/agent/chat/constants.ts");
  const declared = names(buildToolSet(wrap(TOOLS)));

  for (const tool of ["set_goal", "update_plan"]) {
    assert.equal(declared.includes(tool), false, `${tool} must not be declared on the wire`);
    assert.equal(ROUTED_TOOLS.has(tool), false, `${tool} must not be advertised through the catalog`);
    // The one that actually decides whether it runs.
    assert.equal(
      RENDERER_HANDLED_TOOLS.has(tool),
      false,
      `${tool} must not be dispatchable — call_tool resolves names regardless of what is declared`,
    );
  }

  // Control: the neighbouring tools that were deliberately kept.
  assert.equal(declared.includes("update_todos"), true, "the user's checklist tool must survive");
  assert.equal(ROUTED_TOOLS.has("set_task_state"), true, "the mission brief must survive");
});

/** The prompt must not advertise a tool that no longer exists, or the model spends rounds calling it. */
test("no prompt text tells the model to call a removed goal tool", async () => {
  const { GOAL_EXPLAINER, goalContinuationPrompt, startGoal } = await import(
    "../src/app/agent/chat/goalState.ts"
  );
  const goal = startGoal("ship it", { now: 0 });
  const surfaces = [GOAL_EXPLAINER, goalContinuationPrompt(goal, "not yet"), buildSystemPrompt()];

  for (const text of surfaces) {
    const body = typeof text === "string" ? text : JSON.stringify(text);
    assert.doesNotMatch(body, /set_goal/, "prompt still names set_goal");
    assert.doesNotMatch(body, /update_plan/, "prompt still names update_plan");
  }
});

test("MCP tool names are recognised as routed", () => {
  assert.equal(isMcpToolName("mcp__github__create_issue"), true);
  assert.equal(isMcpToolName("read_file"), false);
  assert.equal(isRouted("mcp__github__create_issue"), true);
  assert.equal(isRouted("run_command"), false, "the declared core must stay declared");
});

test("no MCP tool is ever declared", () => {
  const connected = [mcpTool("mcp__github__create_issue"), mcpTool("mcp__pg__query")];
  const declared = names(buildToolSet(wrap([...TOOLS, ...connected])));
  assert.equal(declared.some(isMcpToolName), false, "MCP schemas must not reach the tools payload");
});

test("connecting a server does not change the declared set", () => {
  // The property that actually matters. Tools precede `messages` in the cached prefix, so if this array
  // differs before and after a mid-conversation `mcp_connect`, the next request re-prefills from token 0
  // — which costs far more than the schemas it was carrying.
  const before = buildToolSet(wrap(TOOLS));
  const after = buildToolSet(
    wrap([...TOOLS, mcpTool("mcp__blender__get_scene_info"), mcpTool("mcp__blender__execute_code")]),
  );
  assert.deepEqual(after, before, "the declared block must be unaffected by MCP state");
});

test("the declared set is byte-identical across installs with different servers", () => {
  const userA = buildToolSet(wrap([...TOOLS, mcpTool("mcp__notion__search")]));
  const userB = buildToolSet(wrap([...TOOLS, mcpTool("mcp__pg__query"), mcpTool("mcp__pg__schema")]));
  assert.equal(JSON.stringify(userA), JSON.stringify(userB), "per-install prefix divergence");
});

test("every routed tool is named in the system prompt", () => {
  // The invariant that matters, and the one that generalises. A routed tool ships no schema, so the prompt's
  // catalog is the ONLY thing that tells the model it exists and what to pass — a routed tool missing from the
  // prompt is simply unreachable, silently, with nothing in the wire to show it.
  //
  // This replaces a narrower test that pinned `mcp_tools` as declared on the grounds that it was the one thing
  // telling the model integrations exist. It is routed now, and that job moved to the catalog's MCP section —
  // which is exactly the move this test verifies was actually made, for it and for everything else.
  const prompt = buildSystemPrompt();
  const missing = [...ROUTED_TOOLS].filter((n) => !new RegExp("`" + n + "[`(]").test(prompt));
  assert.deepEqual(missing, [], `routed but undocumented, so unreachable: ${missing.join(", ")}`);
});

test("the dispatcher is present, last, and exactly once", () => {
  const declared = names(buildToolSet(wrap([...TOOLS, mcpTool("mcp__x__y")])));
  assert.equal(declared.filter((n) => n === DISPATCHER_NAME).length, 1);
  assert.equal(declared[declared.length - 1], DISPATCHER_NAME, "position is prefix bytes");
});

test("an MCP-only toolkit still yields the same declared set as none at all", () => {
  // `native.length` gates the delegation tools, and MCP entries inflate that length. A toolkit consisting
  // only of MCP tools must not switch delegation on, or the declared set would again depend on what the
  // user connected.
  assert.deepEqual(
    buildToolSet(wrap([mcpTool("mcp__pg__query")])),
    buildToolSet([]),
    "MCP tools must not count as native tools",
  );
});
