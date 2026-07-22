/**
 * Starter template tests.
 *
 * A shipped template that fails validation is a bad first impression — the user clicks "New
 * workflow", gets a wall of schema errors, and concludes the feature is broken. These run the
 * templates through the same validateDefinition() that gates every save.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TEMPLATE_IDS, buildTemplate } from "../electron/automation/templates.mjs";
import { validateDefinition, linearOrder } from "../electron/automation/schema.mjs";

test("every template validates and is runnable", async (t) => {
  for (const id of TEMPLATE_IDS) {
    await t.test(id, () => {
      const def = buildTemplate(id, { id: `wf-${id}`, name: `Test ${id}` });
      assert.ok(def, `buildTemplate("${id}") returned null`);

      // saveWorkflow assigns the version, so validate the shape it will actually persist.
      const res = validateDefinition({ ...def, version: 1 });
      assert.ok(res.ok, `${id}: ${JSON.stringify(res.errors)}`);

      // The runtime executes a single chain; a template that branches would save and then fail on
      // its first run, which is worse than not shipping it.
      const chain = linearOrder(def);
      assert.ok(chain.ok, `${id} is not a runnable chain: ${chain.error}`);
    });
  }
});

test("an unknown template id returns null rather than a broken definition", () => {
  assert.equal(buildTemplate("nope", { id: "x", name: "x" }), null);
});

test("templates carry a spend ceiling", () => {
  // A starter workflow is exactly what gets edited into something bigger and left running.
  for (const id of TEMPLATE_IDS) {
    const def = buildTemplate(id, { id: `wf-${id}`, name: id });
    assert.ok(def.limits?.maxTokens, `${id} has no maxTokens ceiling`);
  }
});

test("templates use AI steps, not shell commands", () => {
  // Most people cannot write shell; an example built from commands teaches the wrong default.
  for (const id of TEMPLATE_IDS) {
    const def = buildTemplate(id, { id: `wf-${id}`, name: id });
    const shellNodes = def.nodes.filter((n) => n.runtime === "shell");
    assert.deepEqual(shellNodes, [], `${id} uses a shell node`);
  }
});

test("the actions template demonstrates fan-out, a required input and approval", () => {
  // This is the template that has to carry the concepts; if it loses them it stops being the
  // worked example the empty canvas could not provide.
  const def = buildTemplate("actions", { id: "wf-actions", name: "Actions" });

  const required = def.variables.filter((v) => v.required);
  assert.equal(required.length, 1);
  assert.equal(required[0].type, "file");

  const fanOut = def.nodes.find((n) => n.forEach);
  assert.ok(fanOut, "no fan-out node");
  assert.ok(fanOut.maxItems >= 1, "fan-out must be capped");

  const gated = def.nodes.find((n) => n.requiresApproval);
  assert.ok(gated, "no approval gate");
  assert.ok(gated.approvalTimeoutMs, "the gate must have a deadline");
});

test("the article template keeps platform layout rules in an editable variable", () => {
  // The whole point of the json variable: adding LinkedIn, or fixing a character limit that changed,
  // must be an edit to data. Move these into the prompt and nobody will ever find them again.
  const def = buildTemplate("article", { id: "wf-article", name: "Article" });

  const platforms = def.variables.find((v) => v.key === "platforms");
  assert.equal(platforms.type, "json");
  assert.ok(Array.isArray(platforms.default) && platforms.default.length >= 2);
  assert.ok(platforms.default.every((p) => p.platform && p.rules));

  const adapt = def.nodes.find((n) => n.id === "adapt");
  assert.equal(adapt.forEach, "var://platforms");
  assert.ok(adapt.maxItems >= platforms.default.length);

  // It saves drafts; it has no way to post. A step claiming otherwise would be a step that lies.
  const writers = def.nodes.filter((n) => n.config.toolPolicy?.allow?.includes("write_file"));
  assert.deepEqual(writers.map((n) => n.id), ["save"]);
  assert.equal(writers[0].requiresApproval, true);
});

test("the stocks template forces every figure through a verification step", () => {
  // A model asked for a share price will produce one. The audit step, and its read-only policy, are
  // the difference between research and confident fiction.
  const def = buildTemplate("stocks", { id: "wf-stocks", name: "Stocks" });

  const gather = def.nodes.find((n) => n.id === "gather");
  assert.equal(gather.forEach, "var://tickers");
  assert.equal(gather.onItemError, "continue");

  const verify = def.nodes.find((n) => n.id === "verify");
  assert.ok(verify.inputs.some((i) => i.ref === "run://gather/items"));
  // An auditor that can write is an auditor that can rewrite what it audited.
  assert.deepEqual(verify.config.toolPolicy.allow, ["fetch_url"]);

  // The brief reads the audit, never the raw gather output.
  const brief = def.nodes.find((n) => n.id === "brief");
  assert.ok(brief.inputs.some((i) => i.ref === "run://verify/text"));
  assert.ok(!brief.inputs.some((i) => i.ref.startsWith("run://gather/")));
  assert.match(brief.config.prompt, /not\s+\n?investment advice|not investment advice/);
});

test("the intel template exercises the whole engine", () => {
  // The advanced example. Its value is coverage: if a feature quietly stops being demonstrated here,
  // nothing in the product shows a user what it looks like in a real chain.
  const def = buildTemplate("intel", { id: "wf-intel", name: "Intel" });

  const byId = Object.fromEntries(def.nodes.map((n) => [n.id, n]));

  // Capped fan-out that survives one bad item.
  assert.equal(byId.dig.forEach, "run://scope/text");
  assert.ok(byId.dig.maxItems >= 1);
  assert.equal(byId.dig.onItemError, "continue");

  // Cross-item synthesis: the step after a fan-out reads the whole batch, not one item.
  assert.ok(byId.synthesize.inputs.some((i) => i.ref === "run://dig/items"));

  // A wait with a deadline and a stated policy. An unbounded wait would hold the run open forever.
  assert.ok(byId.review.waitFor.timeoutMs > 0);
  assert.equal(byId.review.waitFor.onTimeout, "continue");
  // The key is interpolated against resolved inputs directly, so `{{market}}` -- not `{{inputs.market}}`,
  // which would never substitute and would leave every run waiting on the same literal key.
  assert.match(byId.review.waitFor.key, /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/);
  assert.ok(!byId.review.waitFor.key.includes("inputs."), "wait keys resolve against inputs, not `inputs.x`");
  assert.ok(byId.review.inputs.some((i) => i.as === byId.review.waitFor.key.replace(/^.*\{\{\s*|\s*\}\}.*$/g, "")));

  // Retries where the network is, not everywhere.
  assert.ok(byId.scope.retry.attempts >= 2);
  assert.ok(byId.dig.retry.attempts >= 2);

  // Least privilege per step: only the publishing step may write.
  const writers = def.nodes.filter((n) => n.config.toolPolicy?.allow?.includes("write_file"));
  assert.deepEqual(writers.map((n) => n.id), ["publish"]);

  // The only irreversible step is gated, with a deadline that refuses rather than publishes.
  assert.equal(byId.publish.requiresApproval, true);
  assert.ok(byId.publish.approvalTimeoutMs > 0);
  assert.equal(byId.publish.onApprovalTimeout, "reject");

  // A duration ceiling would fire while the review step is legitimately idle for two days.
  assert.equal(def.limits.maxDurationMs, undefined);
});

test("chained templates bind one step's output to the next", () => {
  // The binding is the concept the example exists to teach.
  const def = buildTemplate("digest", { id: "wf-digest", name: "Digest" });
  const second = def.nodes[1];
  assert.ok(
    second.inputs.some((i) => i.ref.startsWith(`run://${def.nodes[0].id}/`)),
    "the second step does not read the first step's output",
  );
});
