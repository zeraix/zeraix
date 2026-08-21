/**
 * The tool surface installed plugins present to the agent. See electron/plugins/tools.mjs.
 *
 * The property that matters most here is that a wire name resolves back to exactly ONE installed
 * capability. Tool names are how a call is attributed, and each plugin holds its own OAuth grant, so
 * resolving to the wrong plugin is not a mislabelled call — it is one account's credential spending
 * on another's request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setPluginRoot } from "../electron/plugins/storage.mjs";
import { installPlugin, resetCache, setEnabled, sha512 } from "../electron/plugins/store.mjs";
import { validateManifest } from "../electron/plugins/manifest.mjs";
import { callPluginTool, describePluginTools, isPluginTool, listPluginTools, resolvePluginTool, toolName } from "../electron/plugins/tools.mjs";
import { removeRoot } from "./helpers/tempRoot.mjs";

const SKILL = "# notes\n";

function entry(id, caps) {
  const raw = {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: id.split("/")[1],
    description: "Test plugin.",
    license: "MIT",
    providers: {
      api: {
        kind: "http",
        tier: "sandboxed",
        url: "https://api.example.com",
        permissions: { network: ["api.example.com"], credentials: [] },
      },
    },
    capabilities: caps,
  };
  const r = validateManifest(raw, { mode: "client" });
  assert.equal(r.ok, true, r.errors.join("; "));
  return { manifest: r.manifest, dist: { baseUrl: `https://cdn.example.com/${id}/1.0.0/` } };
}

const tool = (id, description) => ({
  type: "tool",
  id,
  description,
  provider: "api",
  input_schema: { type: "object", properties: { q: { type: "string" } } },
  request: { method: "GET", path: `/${id}` },
});

const io = { fetchFile: async () => Buffer.from(SKILL, "utf8") };

function withRoot(fn) {
  return async (t) => {
    resetCache();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zx-ptools-"));
    setPluginRoot(root);
    try {
      await fn(t);
    } finally {
      removeRoot(root);
    }
  };
}

test(
  "a tool is named for its plugin and capability, and resolves back to both",
  withRoot(async () => {
    await installPlugin(entry("alice/gmail", [tool("messages_list", "List messages.")]), io);
    const [t] = listPluginTools();

    assert.equal(t.name, "plugin__alice_gmail__messages_list");
    assert.equal(isPluginTool(t.name), true);
    assert.deepEqual(t.parameters, { type: "object", properties: { q: { type: "string" } } });

    const resolved = resolvePluginTool(t.name);
    assert.equal(resolved.pluginId, "alice/gmail");
    assert.equal(resolved.capabilityId, "messages_list");
  }),
);

test(
  "a capability id containing the separator still resolves",
  withRoot(async () => {
    // A plugin id is [a-z0-9-] on both sides, so the plugin half of the name is never ambiguous. A
    // capability id is not so restricted — LOCAL_ID_RE permits `__` — so any rule for where the
    // separator falls is wrong for some real id, and the cost of being wrong is reaching a different
    // plugin's grant. Whole-name matching has no such case.
    await installPlugin(entry("alice/gmail", [tool("users__messages__send", "Send.")]), io);

    const name = toolName("alice/gmail", "users__messages__send");
    assert.equal(name, "plugin__alice_gmail__users__messages__send");
    const resolved = resolvePluginTool(name);
    assert.equal(resolved.pluginId, "alice/gmail");
    assert.equal(resolved.capabilityId, "users__messages__send");
  }),
);

test(
  "two plugins offering the same capability id stay distinct",
  withRoot(async () => {
    await installPlugin(entry("alice/mail", [tool("send", "Send.")]), io);
    await installPlugin(entry("bob/mail", [tool("send", "Send.")]), io);

    assert.equal(resolvePluginTool(toolName("alice/mail", "send")).pluginId, "alice/mail");
    assert.equal(resolvePluginTool(toolName("bob/mail", "send")).pluginId, "bob/mail");
  }),
);

test(
  "a disabled plugin offers nothing",
  withRoot(async () => {
    await installPlugin(entry("alice/gmail", [tool("messages_list", "List messages.")]), io);
    setEnabled("alice/gmail", false);

    assert.deepEqual(listPluginTools(), []);
    assert.equal(resolvePluginTool("plugin__alice_gmail__messages_list"), null);
    assert.match(await callPluginTool("plugin__alice_gmail__messages_list", {}).then((r) => r.content), /Unknown plugin tool/);
  }),
);

test(
  "content capabilities are not tools",
  withRoot(async () => {
    await installPlugin(
      entry("alice/mixed", [
        tool("search", "Search."),
        { type: "skill", id: "guide", path: "skill.md", sha512: sha512(Buffer.from(SKILL, "utf8")) },
      ]),
      io,
    );
    assert.deepEqual(listPluginTools().map((t) => t.name), ["plugin__alice_mixed__search"]);
  }),
);

test(
  "discovery is an inventory first and schemas on request",
  withRoot(async () => {
    await installPlugin(entry("alice/gmail", [tool("messages_list", "List messages. Supports a query."), tool("messages_get", "Get one message.")]), io);

    // The inventory has to stay small: this exists so 79 schemas do not enter a turn uninvited.
    const inventory = describePluginTools();
    assert.match(inventory, /alice\/gmail/);
    assert.match(inventory, /plugin__alice_gmail__messages_list — List messages\./);
    assert.ok(!inventory.includes('"properties"'), "the inventory carries no schemas");

    const one = describePluginTools({ name: "plugin__alice_gmail__messages_get" });
    assert.match(one, /"properties"/);
    assert.ok(!one.includes("messages_list"), "asking for one tool returns one tool");

    const all = describePluginTools({ plugin: "alice/gmail" });
    assert.match(all, /messages_list/);
    assert.match(all, /messages_get/);
  }),
);

test(
  "with nothing installed the model is told so plainly",
  withRoot(async () => {
    assert.match(describePluginTools(), /No plugins are installed/);
    assert.match(describePluginTools({ name: "plugin__x_y__z" }), /No plugins are installed/);
  }),
);

test(
  "a healthy plugin with no tools is not reported as needing to be connected",
  withRoot(async () => {
    // The bug this pins: zeraix/gmail-send is enabled, connected, and ships only a skill. Telling the
    // user to go and connect it sends them to do something they have already done, and leaves the
    // actual reason unsaid.
    await installPlugin(
      entry("alice/notes", [{ type: "skill", id: "guide", path: "skill.md", sha512: sha512(Buffer.from(SKILL, "utf8")) }]),
      io,
    );
    const out = describePluginTools();

    // Scoped to this plugin's own line: the closing guidance legitimately contains "not connected".
    const line = out.split("\n").find((l) => l.includes("alice/notes"));
    assert.match(line, /provides no tools/);
    assert.match(line, /load_skill/);
    assert.ok(!/not connected/.test(line), "must not claim a connection problem that does not exist");
    assert.ok(!/disabled/.test(line), "must not claim it is disabled either");
    assert.match(out, /Do NOT tell the user to enable or connect/);
  }),
);

test(
  "a disabled plugin is reported as disabled, not as toolless",
  withRoot(async () => {
    await installPlugin(entry("alice/gmail", [tool("send", "Send.")]), io);
    setEnabled("alice/gmail", false);

    assert.match(describePluginTools(), /disabled by the user/);
  }),
);

test(
  "a toolless plugin is never blamed on its connection",
  withRoot(async () => {
    // Both true at once: no tools AND no grant. Only one of them is worth acting on — connecting the
    // account cannot conjure a tool that the plugin does not ship.
    const raw = {
      schemaVersion: 1,
      id: "alice/mailskill",
      version: "1.0.0",
      name: "Mail skill",
      description: "Guidance only.",
      license: "MIT",
      providers: {
        auth: {
          kind: "oauth",
          tier: "host",
          oauth: {
            authorize_url: "https://accounts.example.com/a",
            token_url: "https://accounts.example.com/t",
            scopes: ["s"],
            client: { type: "public", id: "c" },
            redirect: { method: "loopback" },
            mints: "cred",
          },
          permissions: { network: ["accounts.example.com"], credentials: [] },
        },
      },
      capabilities: [{ type: "skill", id: "guide", path: "skill.md", sha512: sha512(Buffer.from(SKILL, "utf8")) }],
    };
    const v = validateManifest(raw, { mode: "client" });
    assert.equal(v.ok, true, v.errors.join("; "));
    await installPlugin({ manifest: v.manifest, dist: { baseUrl: "https://cdn.example.com/alice/mailskill/1.0.0/" } }, io);

    const line = describePluginTools().split("\n").find((l) => l.includes("alice/mailskill"));
    assert.match(line, /provides no tools/);
    assert.ok(!/not connected/.test(line), "the connection is not why it has no tools");
  }),
);
