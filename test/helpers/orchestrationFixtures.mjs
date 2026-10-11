/**
 * Shared fixtures for the orchestration tests: orchestration.test.mjs (broker, grants, runner, spawn
 * tool, audit), orchestration-adapter.test.mjs (the OpenAI-compatible client) and
 * orchestration-approval.test.mjs (derived ceiling, escalation, the terminal prompt, per-call consent).
 *
 * It also owns the module hook and the `src/` imports behind it. The hook has to be registered before
 * those imports run, and a test file's static imports are all resolved before any of its code runs, so
 * the test files take the modules under test from here instead of importing them themselves.
 * Not named *.test.mjs, so the test glob never runs it on its own.
 */
import { register } from "node:module";
import { PassThrough } from "node:stream";

// The modules under test import each other extensionlessly, which node does not resolve on its own.
// Registered before the dynamic imports below; a static import would hoist above this call and fail.
register("./srcResolve.mjs", import.meta.url);

export const { InMemoryAuditLog, buildCallTree, flattenCallTree } = await import(
  "../../src/lib/ai/orchestration/audit-log.ts"
);
export const {
  TOOL_RISK,
  ALL_TOOL_NAMES,
  MOCK_TOOL_PROVIDER,
  toAnthropicToolSchema,
  findEscalations,
} = await import("../../src/lib/ai/orchestration/capabilities.ts");
export const { CapabilityBroker, ConcurrencyLimitError, DenyAllApprover, TerminalApprover } = await import(
  "../../src/lib/ai/orchestration/capability-broker.ts"
);
export const { CEILING_TOOLS, createConfiguredBroker } = await import(
  "../../src/lib/ai/orchestration/config.ts"
);
export const { SUBAGENTS, CODER_TOOLS, READONLY_TOOLS, WEB_TOOLS } = await import("../../src/lib/ai/subagents.ts");
export const { runAnonymousSubAgent, ToolUseViolationError } = await import(
  "../../src/lib/ai/orchestration/sub-agent-runner.ts"
);
export const { createSpawnSubAgentHandler, formatSpawnResult, SPAWN_SUB_AGENT_TOOL } = await import(
  "../../src/lib/ai/orchestration/orchestrator-tool.ts"
);

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

// A stand-in ceiling for the unit tests: real tool names, deliberately narrower than the derived one so
// `delete_file` is available as a genuine off-ceiling tool to over-ask for.
const CEILING = ["read_file", "write_file", "check_project", "run_command"];

/** Every runner/handler call in these tests goes through the mock provider. */
export const TOOLS_OPT = { tools: MOCK_TOOL_PROVIDER };

/** A broker with everything injected, so time and identity are deterministic. */
export function makeBroker(overrides = {}) {
  const audit = overrides.audit ?? new InMemoryAuditLog();
  let n = 0;
  const clock = overrides.clock ?? { t: 1_000_000 };
  const broker = new CapabilityBroker({
    ceiling: overrides.ceiling ?? CEILING,
    audit,
    approver: overrides.approver ?? new DenyAllApprover(),
    ttlMs: overrides.ttlMs ?? 600_000,
    maxDepth: overrides.maxDepth ?? 3,
    maxConcurrent: overrides.maxConcurrent ?? 20,
    now: () => clock.t,
    newId: () => `id${++n}`,
  });
  return { broker, audit, clock };
}

/** Approves every high-risk request. Only ever used to prove the approved branch works. */
export const approveAll = { id: "test:approve-all", approve: async () => true };
/** Refuses every high-risk request, while low-risk tools go through untouched. */
export const refuseAll = { id: "test:refuse-all", approve: async () => false };

/**
 * A model that plays a fixed script.
 *
 * Turns are consumed in order; once the script runs out it concludes, so a test that mis-counts turns
 * fails on the assertion rather than hanging.
 */
export function scriptedClient(turns) {
  const requests = [];
  let i = 0;
  return {
    requests,
    get calls() {
      return i;
    },
    async send(req) {
      requests.push(req);
      return turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
    },
  };
}

export const callsTool = (name, input = {}, id = `call-${name}`) => ({
  text: "",
  toolCalls: [{ id, name, input }],
  stopReason: "tool_use",
});
export const concludes = (text) => ({ text, toolCalls: [], stopReason: "end" });

export const grantReq = (requestedTools, extra = {}) => ({
  requestedTools,
  taskDescription: "summarise the release notes",
  requesterId: "orchestrator-1",
  parentGrantId: null,
  generation: 1,
  ...extra,
});

export const deniedFor = (record, name) => record.denied.find((d) => d.name === name);
export const issuedFor = (records, grantId) =>
  records.find((r) => r.type === "grant_issued" && r.grantId === grantId);

// ── OpenAI-compatible adapter ─────────────────────────────────────────────────────────────

export const { createOpenAiCompatibleClient, MalformedChatResponseError } = await import(
  "../../src/lib/ai/orchestration/openai-adapter.ts"
);

/** Records the bodies it was handed and replays scripted responses. */
export function fakeTransport(responses) {
  const bodies = [];
  let i = 0;
  const send = async (body) => {
    bodies.push(body);
    return responses[i++];
  };
  return { bodies, send };
}

export const assistantSays = (content, finish = "stop") => ({
  choices: [{ finish_reason: finish, message: { role: "assistant", content } }],
});
export const assistantCalls = (name, args, finish = "tool_calls") => ({
  choices: [
    {
      finish_reason: finish,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }],
      },
    },
  ],
});

// ── The real approval path, end to end ────────────────────────────────────────────────────

/** Drives TerminalApprover over real streams: answer, then read what the human was shown. */
export function terminal(answer) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (c) => {
    shown += String(c);
  });
  return {
    approver: new TerminalApprover(input, output),
    get shown() {
      return shown;
    },
    async answer() {
      // Let readline print the prompt and register its listener before replying.
      await new Promise((r) => setTimeout(r, 10));
      if (answer === null) input.end();
      else input.write(`${answer}\n`);
    },
  };
}

// ── The real ToolProvider: this app's tools behind the seam ───────────────────────────────

export const { createToolkitProvider } = await import("../../src/lib/ai/orchestration/toolkit-provider.ts");

/** A stand-in for the Electron bridge: records what it was asked to run. */
export function fakeToolkit(overrides = {}) {
  const calls = [];
  return {
    calls,
    listTools: overrides.listTools ??
      (async () => [
        { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] } },
        { name: "write_file", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string", description: "p" }, content: { type: "string", description: "c" } }, required: ["path", "content"] } },
        { name: "run_command", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string", description: "c" } }, required: ["command"] } },
        // An MCP tool, as listTools would really return once a server is connected.
        { name: "mcp__github__create_issue", description: "From a connected server.", parameters: { type: "object", properties: {}, required: [] } },
      ]),
    callTool: overrides.callTool ??
      (async (name, args) => {
        calls.push({ name, args });
        return { ok: true, content: `ran ${name}` };
      }),
  };
}

export const CTX = { agentId: "anon-1", grantId: "grant-1" };
