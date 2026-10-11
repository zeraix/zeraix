/**
 * The OpenAI-compatible model client, driven through the anonymous sub-agent runner.
 *
 * Split out of orchestration.test.mjs, whose header says what these tests defend. The last case makes
 * the same claim against this seam: whatever a provider sends back, the adapter cannot widen a grant.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The modules under test come through the helper, which registers the src/ hook before loading them.
import {
  assistantCalls,
  assistantSays,
  createOpenAiCompatibleClient,
  fakeTransport,
  grantReq,
  makeBroker,
  MalformedChatResponseError,
  runAnonymousSubAgent,
  TOOLS_OPT,
  ToolUseViolationError,
} from "./helpers/orchestrationFixtures.mjs";

// ── OpenAI-compatible adapter ─────────────────────────────────────────────────────────────

test("one turn of tool results fans out into one tool message per call", async () => {
  const { broker } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file", "check_project"]));

  const t = fakeTransport([
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
              { id: "b", type: "function", function: { name: "check_project", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    assistantSays("both done"),
  ]);
  const client = createOpenAiCompatibleClient({ model: "some-model", send: t.send });

  const out = await runAnonymousSubAgent(grant, "do two things", broker, { client, ...TOOLS_OPT });
  assert.match(out, /both done/);

  // The neutral history holds one tool_results entry; the wire needs one message per call, each keyed
  // back to its tool_call_id.
  const second = t.bodies[1].messages;
  assert.deepEqual(
    second.map((m) => m.role),
    ["system", "user", "assistant", "tool", "tool"],
  );
  assert.deepEqual(
    second.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["a", "b"],
  );
});

test("the assistant turn is echoed back exactly as the provider sent it", async () => {
  const { broker } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file"]));

  // A field this adapter does not model. It must survive the round trip.
  const original = {
    role: "assistant",
    content: null,
    reasoning_content: "vendor-specific payload",
    tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
  };
  const t = fakeTransport([
    { choices: [{ finish_reason: "tool_calls", message: original }] },
    assistantSays("done"),
  ]);

  await runAnonymousSubAgent(grant, "read x", broker, {
    client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
    ...TOOLS_OPT,
  });

  const echoed = t.bodies[1].messages.find((m) => m.role === "assistant");
  assert.deepEqual(echoed, original);
  assert.equal(echoed.reasoning_content, "vendor-specific payload");
});

test("tools are omitted entirely when the grant is empty", async () => {
  const { broker } = makeBroker({ maxDepth: 0 });
  const grant = await broker.requestGrant(grantReq(["read_file"], { generation: 1 }));
  assert.deepEqual([...grant.tools], []);

  const t = fakeTransport([assistantSays("I had no tools for this.")]);
  await runAnonymousSubAgent(grant, "try", broker, {
    client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
    ...TOOLS_OPT,
  });

  // Not `tools: []` — several providers reject that outright rather than reading it as "no tools".
  assert.equal("tools" in t.bodies[0], false);
  assert.equal("tool_choice" in t.bodies[0], false);
});

test("granted tools reach the wire in OpenAI function shape", async () => {
  const { broker } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file"]));
  const t = fakeTransport([assistantSays("ok")]);

  await runAnonymousSubAgent(grant, "x", broker, {
    client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
    ...TOOLS_OPT,
  });

  assert.deepEqual(
    t.bodies[0].tools.map((x) => [x.type, x.function.name]),
    [["function", "read_file"]],
  );
  assert.equal(t.bodies[0].tools[0].function.parameters.type, "object");
  assert.equal(t.bodies[0].tool_choice, "auto");
});

test("a truncated turn drops its tool calls instead of running them on half their input", async () => {
  const { broker, audit } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file"]));

  // finish_reason "length" means the arguments may have been cut mid-object.
  const t = fakeTransport([assistantCalls("read_file", '{"path":"/very/long/pa', "length")]);
  const out = await runAnonymousSubAgent(grant, "fetch", broker, {
    client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
    ...TOOLS_OPT,
  });

  assert.match(out, /truncated at the token limit/);
  assert.equal(t.bodies.length, 1, "the run ended rather than continuing on truncated input");
  assert.equal(
    (await audit.query()).some((r) => r.type === "tool_call"),
    false,
  );
});

test("unparseable arguments become an empty input the tool itself rejects", async () => {
  const { broker } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file"]));

  // Not valid JSON, and finish_reason says the model considered the call complete.
  const t = fakeTransport([
    assistantCalls("read_file", "sure! {path: /etc/hosts}"),
    assistantSays("I will retry with valid arguments."),
  ]);
  const out = await runAnonymousSubAgent(grant, "fetch", broker, {
    client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
    ...TOOLS_OPT,
  });

  // Recoverable formatting slip, not a security event: the tool's own validation rejects it and the model
  // gets the error back. Nothing was invented to make the call succeed.
  const toolMsg = t.bodies[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /read_file requires a "path" argument/);
  assert.match(out, /retry with valid arguments/);
});

test("finish_reason maps onto the neutral stop reasons", async () => {
  const cases = [
    ["stop", /all good/],
    ["content_filter", /declined to continue/],
    ["some_vendor_reason", /unrecognised reason/],
  ];
  for (const [finish, expected] of cases) {
    const { broker } = makeBroker();
    const grant = await broker.requestGrant(grantReq(["read_file"]));
    const t = fakeTransport([assistantSays("all good", finish)]);
    const out = await runAnonymousSubAgent(grant, "x", broker, {
      client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
      ...TOOLS_OPT,
    });
    assert.match(out, expected);
  }
});

test("an unreadable response fails loudly rather than becoming an empty answer", async () => {
  const { broker } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file"]));

  for (const bad of [null, {}, { choices: [] }, { choices: [{ finish_reason: "stop" }] }]) {
    const t = fakeTransport([bad]);
    await assert.rejects(
      () =>
        runAnonymousSubAgent(grant, "x", broker, {
          client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
          ...TOOLS_OPT,
        }),
      MalformedChatResponseError,
    );
  }
});

test("the adapter still cannot widen a grant, whatever the provider returns", async () => {
  const { broker, audit } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file"]));

  // A hostile or broken provider returning a call for a tool that was never declared on the wire.
  const t = fakeTransport([assistantCalls("run_command", '{"command":"whoami"}')]);

  await assert.rejects(
    () =>
      runAnonymousSubAgent(grant, "x", broker, {
        client: createOpenAiCompatibleClient({ model: "m", send: t.send }),
        ...TOOLS_OPT,
      }),
    ToolUseViolationError,
  );
  await broker.whenAuditSettled();
  assert.equal(
    (await audit.query()).some((r) => r.type === "tool_call"),
    false,
  );
});
