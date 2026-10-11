/**
 * What stands between a requested tool and a run: the ceiling, derived from the fixed roles rather than
 * written by hand; the medium + medium escalations it lets through, on the record; the human prompt a
 * high-risk grant has to pass; and the per-call consent the toolkit provider asks for mid-run.
 *
 * Split out of orchestration.test.mjs, whose header says what these tests defend.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The modules under test come through the helper, which registers the src/ hook before loading them.
import {
  ALL_TOOL_NAMES,
  callsTool,
  CEILING_TOOLS,
  CODER_TOOLS,
  concludes,
  createConfiguredBroker,
  createToolkitProvider,
  CTX,
  deniedFor,
  fakeToolkit,
  findEscalations,
  grantReq,
  InMemoryAuditLog,
  issuedFor,
  makeBroker,
  READONLY_TOOLS,
  runAnonymousSubAgent,
  scriptedClient,
  SUBAGENTS,
  terminal,
  TOOL_RISK,
  WEB_TOOLS,
} from "./helpers/orchestrationFixtures.mjs";

// ── The ceiling is derived, not written ───────────────────────────────────────────────────

test("the ceiling is exactly the union of the fixed roles' tool lists", () => {
  const union = new Set(SUBAGENTS.flatMap((r) => r.tools ?? []));
  assert.deepEqual([...CEILING_TOOLS].sort(), [...union].sort());

  // Derived, so it moves when a role moves — and no dynamic sub-agent can exceed what a fixed role does.
  for (const t of CODER_TOOLS) assert.ok(CEILING_TOOLS.includes(t), `${t} should be on the ceiling`);
  for (const t of READONLY_TOOLS) assert.ok(CEILING_TOOLS.includes(t));
});

test("the derived ceiling is a real bound, not a restatement of the whole tool surface", () => {
  // If this ever became "everything", the ceiling would have stopped doing anything.
  assert.ok(CEILING_TOOLS.length < ALL_TOOL_NAMES.length);
  for (const excluded of ["delete_file", "open_path", "stop_service", "mcp_connect", "page_console"]) {
    assert.equal(CEILING_TOOLS.includes(excluded), false, `${excluded} must stay off the ceiling`);
  }
  // On it deliberately: every fixed role carries WEB_TOOLS, so a dynamic sub-agent may be granted them too.
  // Stated here so that removing them from the roles fails visibly rather than quietly narrowing the ceiling.
  for (const t of WEB_TOOLS) assert.ok(CEILING_TOOLS.includes(t), `${t} should be on the ceiling`);
  // And every tool it does permit has a classification, or the broker would deny it as unknown.
  for (const t of CEILING_TOOLS) assert.ok(TOOL_RISK.has(t), `${t} is on the ceiling but unclassified`);
});

// ── Known escalation: medium + medium adding up to high ───────────────────────────────────

test("write + check_project is flagged as equivalent to run_command", () => {
  const found = findEscalations(["write_file", "check_project"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].equivalentTo, "run_command");
});

test("the flag does not fire when the grant already holds the tool it escalates to", () => {
  // CODER_TOOLS contains write_file, check_project AND run_command, so the route grants that role nothing
  // it was not openly given. Flagging it would be noise, and a log full of noise is a log nobody reads.
  assert.deepEqual(findEscalations(CODER_TOOLS), []);
  // The reviewer role cannot write at all, so the pair is unreachable there.
  assert.deepEqual(findEscalations(READONLY_TOOLS), []);
});

test("a grant carrying the escalation records it, and is still issued", async () => {
  const { broker, audit } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["write_file", "check_project"]));

  // Not blocked: the ceiling that permitted the pair is itself a reviewed human decision. Recorded, so
  // that decision's consequence is visible to whoever reads the log later.
  assert.deepEqual([...grant.tools], ["write_file", "check_project"]);

  const issued = issuedFor(await audit.query(), grant.grantId);
  assert.equal(issued.escalations.length, 1);
  assert.match(issued.escalations[0], /write_file \+ check_project ≈ run_command/);
  assert.match(issued.escalations[0], /without passing through the high-risk approval path/);
});

test("an ordinary grant records no escalations", async () => {
  const { broker, audit } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file", "write_file"]));
  assert.deepEqual(issuedFor(await audit.query(), grant.grantId).escalations, []);
});

// ── The real approval path, end to end ────────────────────────────────────────────────────

test("run_command on the real ceiling reaches the real terminal prompt and is grantable", async () => {
  const audit = new InMemoryAuditLog();
  const t = terminal("y");
  // The real config ceiling and the real approver class — not a stubbed approveHighRisk.
  const broker = createConfiguredBroker({ audit, approver: t.approver });

  const pending = broker.requestGrant(grantReq(["read_file", "run_command"]));
  await t.answer();
  const grant = await pending;

  // The human actually saw a prompt naming the tool and the task.
  assert.match(t.shown, /HIGH-RISK CAPABILITY REQUEST/);
  assert.match(t.shown, /tools: run_command/);
  assert.match(t.shown, /grant these tools\? \[y\/N\]/);
  // ...and a warning not to trust the task text, which a model wrote.
  assert.match(t.shown, /attacker-controlled/);

  assert.deepEqual([...grant.tools].sort(), ["read_file", "run_command"]);
  const decision = (await audit.query()).find((r) => r.type === "high_risk_decision");
  assert.equal(decision.approved, true);
  assert.equal(decision.approver, "terminal:human");
  await broker.revoke(grant.grantId);
});

test("answering no at the real prompt strips run_command and keeps the rest", async () => {
  const audit = new InMemoryAuditLog();
  const t = terminal("n");
  const broker = createConfiguredBroker({ audit, approver: t.approver });

  const pending = broker.requestGrant(grantReq(["read_file", "run_command"]));
  await t.answer();
  const grant = await pending;

  assert.deepEqual([...grant.tools], ["read_file"]);
  const issued = issuedFor(await audit.query(), grant.grantId);
  assert.equal(deniedFor(issued, "run_command").reason, "high_risk_denied");
  await broker.revoke(grant.grantId);
});

test("a prompt nobody answers is a no", async () => {
  const audit = new InMemoryAuditLog();
  // Closed stdin: the case that matters on a server or in a headless job, where the "wait for a human"
  // design silently becomes "wait forever" or, if someone adds a timeout, "yes".
  const t = terminal(null);
  const broker = createConfiguredBroker({ audit, approver: t.approver });

  const pending = broker.requestGrant(grantReq(["read_file", "run_command"]));
  await t.answer();
  const grant = await pending;

  assert.deepEqual([...grant.tools], ["read_file"]);
  await broker.revoke(grant.grantId);
});

// ── The real ToolProvider: this app's tools behind the seam ───────────────────────────────

test("declarations are snapshotted and translated, and MCP tools never reach a sub-agent", async () => {
  const kit = fakeToolkit();
  const provider = await createToolkitProvider(kit);

  const decl = provider.declarationFor("read_file");
  assert.equal(decl.name, "read_file");
  assert.equal(decl.description, "Read a file.");
  // `parameters` in the toolkit, `input_schema` here — the only shape mapping this layer does.
  assert.deepEqual(decl.input_schema.required, ["path"]);

  // An MCP tool's schema comes from whatever server the user connected, and its name is unclassified, so
  // the broker could never grant it. Not declaring it keeps a sub-agent from being tempted by a tool it
  // cannot have.
  assert.equal(provider.declarationFor("mcp__github__create_issue"), undefined);
  assert.equal(provider.declarationFor("delete_file"), undefined, "not offered by this toolkit");
});

test("a read-only tool runs without asking anyone", async () => {
  const kit = fakeToolkit();
  const provider = await createToolkitProvider({ ...kit, confirm: async () => false });

  const out = await provider.execute("read_file", { path: "a.md" }, CTX);
  assert.equal(out.content, "ran read_file");
  assert.equal(out.isError, false);
  // The declining confirm was never consulted: read_file needs no consent.
  assert.deepEqual(kit.calls.map((c) => c.name), ["read_file"]);
});

test("with no confirm callback, a consent-requiring tool is refused and never reaches the bridge", async () => {
  const kit = fakeToolkit();
  const provider = await createToolkitProvider(kit); // no confirm — nobody is listening

  const out = await provider.execute("run_command", { command: "rm -rf /" }, CTX);

  assert.equal(out.isError, true);
  assert.match(out.content, /no way to ask/);
  assert.match(out.content, /retrying will be refused identically/);
  // The point of the whole gate: grant-time approval alone did not make this run.
  assert.deepEqual(kit.calls, []);
});

test("declining a call returns an error result rather than killing the run", async () => {
  const kit = fakeToolkit();
  const provider = await createToolkitProvider({ ...kit, confirm: async () => false });

  const out = await provider.execute("write_file", { path: "x", content: "y" }, CTX);
  assert.equal(out.isError, true);
  assert.match(out.content, /user declined/);
  assert.deepEqual(kit.calls, []);
});

test("approving a call lets it through, with the sub-agent identified to the approver", async () => {
  const kit = fakeToolkit();
  const seen = [];
  const provider = await createToolkitProvider({
    ...kit,
    confirm: async (req) => {
      seen.push(req);
      return true;
    },
  });

  const out = await provider.execute("run_command", { command: "npm test" }, CTX);
  assert.equal(out.content, "ran run_command");
  assert.deepEqual(kit.calls, [{ name: "run_command", args: { command: "npm test" } }]);

  // The user did not start this call, so the prompt has to say who did and how bad it could be.
  assert.equal(seen[0].name, "run_command");
  assert.equal(seen[0].riskLevel, "high");
  assert.equal(seen[0].agentId, "anon-1");
  assert.deepEqual(seen[0].input, { command: "npm test" });
});

test("consent is asked per call, not once per grant", async () => {
  const kit = fakeToolkit();
  let asked = 0;
  const provider = await createToolkitProvider({
    ...kit,
    confirm: async () => {
      asked++;
      return true;
    },
  });

  await provider.execute("run_command", { command: "one" }, CTX);
  await provider.execute("run_command", { command: "two" }, CTX);
  await provider.execute("run_command", { command: "three" }, CTX);

  // A yes given to the first must not authorise the twentieth — this is the gap grant-time approval leaves.
  assert.equal(asked, 3);
});

test("the host's own consent predicate is used, so the two paths cannot drift", async () => {
  const kit = fakeToolkit();
  // Stands in for `toolNeedsConsent` from the chat page: read_file gated, run_command not.
  const provider = await createToolkitProvider({
    ...kit,
    needsConsent: (name) => name === "read_file",
    confirm: async () => false,
  });

  assert.equal((await provider.execute("read_file", { path: "a" }, CTX)).isError, true);
  assert.equal((await provider.execute("run_command", { command: "x" }, CTX)).isError, false);
});

test("a bridge failure becomes an error result, not an exception", async () => {
  const provider = await createToolkitProvider({
    ...fakeToolkit({ callTool: async () => ({ ok: false, content: "ENOENT: no such file" }) }),
    confirm: async () => true,
  });

  const out = await provider.execute("read_file", { path: "nope" }, CTX);
  assert.equal(out.isError, true);
  assert.match(out.content, /ENOENT/);
});

test("an unclassified tool cannot be executed even if something asks for it", async () => {
  const provider = await createToolkitProvider(fakeToolkit());
  await assert.rejects(
    () => provider.execute("mcp__github__create_issue", {}, CTX),
    /not classified/,
  );
});

test("end to end: a sub-agent refused consent keeps working and reports back", async () => {
  const { broker } = makeBroker();
  const grant = await broker.requestGrant(grantReq(["read_file", "write_file"]));
  const kit = fakeToolkit();
  const provider = await createToolkitProvider(kit); // unattended: no confirm

  const client = scriptedClient([
    callsTool("write_file", { path: "out.md", content: "x" }),
    concludes("I could not write the file; nothing was changed."),
  ]);
  const out = await runAnonymousSubAgent(grant, "write a summary", broker, {
    client,
    tools: provider,
  });

  // The run continued — a declined call is data, not a boundary violation.
  assert.match(out, /could not write the file/);
  assert.deepEqual(kit.calls, [], "nothing was executed");
  const fed = client.requests[1].messages.at(-1);
  assert.equal(fed.results[0].isError, true);
  assert.match(fed.results[0].content, /no way to ask/);
});
