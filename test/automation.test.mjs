/**
 * Automation schema + database tests.
 *
 * Run with:  npm test          (node --test, no extra dependencies)
 *
 * These cover the two pieces that are a real trust boundary: hand-editable definition files, and a
 * database migration that would otherwise only be exercised on a user's first launch. Both modules
 * under test deliberately avoid importing `electron`, which is what makes them runnable here --
 * db.mjs keeps the Electron-specific concerns (where the file lives, when it opens) separate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate, MIGRATIONS } from "../electron/automation/migrations.mjs";
import { validateDefinition, linearOrder } from "../electron/automation/schema.mjs";
import { setAutomationRoot } from "../electron/automation/storage.mjs";
import {
  saveWorkflow,
  getWorkflow,
  listWorkflows,
  listVersions,
  currentVersion,
  deleteWorkflow,
} from "../electron/automation/definitions.mjs";
import { openDb, closeDb } from "../electron/automation/db.mjs";

/** Point the subsystem at a throwaway directory; returns it. */
function useTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-automation-"));
  setAutomationRoot(dir);
  return dir;
}

/** A minimal definition that must always validate; each test mutates a fresh copy. */
const valid = () => ({
  id: "wf-demo",
  version: 1,
  name: "Demo",
  triggers: [
    { id: "t1", type: "cron", config: { expression: "0 9 * * *" }, missedRunPolicy: "skip" },
  ],
  variables: [{ key: "greeting", type: "string", default: "hi" }],
  limits: { concurrency: "single", maxCostUsd: 1 },
  nodes: [
    { id: "a", runtime: "shell", config: { command: "echo hi" }, inputs: [] },
    {
      id: "b",
      runtime: "shell",
      config: { command: "echo bye" },
      inputs: [{ as: "prev", ref: "run://a/stdout" }],
    },
  ],
  edges: [{ from: "a", to: "b" }],
});

/* -------------------------------------------------------------------- migrations */

test("migrations", async (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  await t.test("applies every migration", () => {
    const r = migrate(db);
    assert.equal(r.from, 0);
    assert.equal(r.to, MIGRATIONS.length);
  });

  await t.test("creates every table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const want of [
      "checkpoints",
      "events",
      "node_attempts",
      "reactor_marks",
      "run_processes",
      "runs",
      "trigger_state",
    ]) {
      assert.ok(tables.includes(want), `missing table ${want}`);
    }
  });

  await t.test("re-running is a no-op", () => {
    const again = migrate(db);
    assert.equal(again.from, MIGRATIONS.length);
  });

  await t.test("ON DELETE CASCADE is actually enforced", () => {
    // Easy silent bug: SQLite ignores the FK declarations unless PRAGMA foreign_keys is on.
    db.prepare(
      "INSERT INTO runs (id,workflow_id,definition_version,state,trigger_type,created_at) VALUES (?,?,?,?,?,?)",
    ).run("r1", "wf1", 1, "QUEUED", "manual", 1);
    db.prepare(
      "INSERT INTO node_attempts (id,run_id,node_id,attempt,state) VALUES (?,?,?,?,?)",
    ).run("a1", "r1", "n1", 1, "RUNNING");
    db.prepare("INSERT INTO checkpoints (run_id,node_id,inputs,at) VALUES (?,?,?,?)").run(
      "r1",
      "n1",
      "{}",
      1,
    );

    db.prepare("DELETE FROM runs WHERE id='r1'").run();
    assert.equal(db.prepare("SELECT COUNT(*) c FROM node_attempts").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM checkpoints").get().c, 0);
  });

  await t.test("rejects a duplicate (run, node, attempt)", () => {
    db.prepare(
      "INSERT INTO runs (id,workflow_id,definition_version,state,trigger_type,created_at) VALUES (?,?,?,?,?,?)",
    ).run("r2", "wf1", 1, "QUEUED", "manual", 1);
    const ins = db.prepare(
      "INSERT INTO node_attempts (id,run_id,node_id,attempt,state) VALUES (?,?,?,?,?)",
    );
    ins.run("a2", "r2", "n1", 1, "OK");
    assert.throws(() => ins.run("a3", "r2", "n1", 1, "OK"));
  });

  await t.test("event seq is monotonic (projections depend on the ordering)", () => {
    const ins = db.prepare(
      "INSERT INTO events (run_id,node_id,type,payload,at) VALUES (?,?,?,?,?)",
    );
    ins.run("r2", "n1", "log", "{}", 1);
    ins.run("r2", "n1", "log", "{}", 2);
    const seqs = db.prepare("SELECT seq FROM events ORDER BY seq").all().map((r) => r.seq);
    assert.equal(seqs.length, 2);
    assert.ok(seqs[1] > seqs[0]);
  });

  db.close();
});

/* ------------------------------------------------------------- validateDefinition */

test("validateDefinition accepts a well-formed definition", () => {
  const res = validateDefinition(valid());
  assert.ok(res.ok, JSON.stringify(res.errors));
});

test("validateDefinition rejects malformed definitions", async (t) => {
  /** Mutate a valid definition and assert it fails with an error mentioning `needle`. */
  const rejects = (label, mutate, needle) =>
    t.test(label, () => {
      const def = valid();
      mutate(def);
      const res = validateDefinition(def);
      assert.ok(!res.ok, "expected validation to fail");
      assert.ok(
        res.errors.some((e) => e.includes(needle)),
        `expected an error containing "${needle}", got ${JSON.stringify(res.errors)}`,
      );
    });

  await rejects("bad id", (d) => { d.id = "bad id!"; }, "id must match");
  await rejects("empty name", (d) => { d.name = ""; }, "name is required");
  await rejects("empty triggers", (d) => { d.triggers = []; }, "non-empty array");
  await rejects("bad missedRunPolicy", (d) => { d.triggers[0].missedRunPolicy = "nope"; }, "missedRunPolicy");
  await rejects("cron without expression", (d) => { delete d.triggers[0].config.expression; }, "expression is required");
  // Run state in a definition would let an edit rewrite scheduling history (design doc §2.1).
  await rejects("lastFiredAt in the definition", (d) => { d.triggers[0].lastFiredAt = 123; }, "run state");
  await rejects("duplicate trigger id", (d) => { d.triggers.push({ ...d.triggers[0] }); }, "duplicated");
  await rejects("missing limits", (d) => { delete d.limits; }, "limits is required");
  await rejects("bad concurrency", (d) => { d.limits.concurrency = "lots"; }, "concurrency");
  await rejects("negative cost ceiling", (d) => { d.limits.maxCostUsd = -5; }, "maxCostUsd");
  // A literal secret would be committed, synced and exported in plain text (design doc §7.2).
  await rejects("inline secret default", (d) => { d.variables.push({ key: "k", type: "secret", default: "hunter2" }); }, "secretRef");
  await rejects("duplicate node id", (d) => { d.nodes[1].id = "a"; }, "duplicated");
  await rejects("unknown runtime", (d) => { d.nodes[0].runtime = "quantum"; }, "runtime must be one of");
  await rejects("edge to unknown node", (d) => { d.edges[0].to = "ghost"; }, "unknown node");
  await rejects("self-loop", (d) => { d.edges.push({ from: "a", to: "a" }); }, "self-loop");
  await rejects("input ref to unknown node", (d) => { d.nodes[1].inputs[0].ref = "run://ghost/x"; }, "unknown node");
  await rejects("malformed input ref", (d) => { d.nodes[1].inputs[0].ref = "ftp://x"; }, "must be run://");
  await rejects("retry attempts below 1", (d) => { d.nodes[1].retry = { attempts: 0 }; }, "attempts");
  // Canvas coordinates are presentational, but a malformed one must fail at save time rather than
  // breaking the visual editor when it next opens the file.
  await rejects("malformed node position", (d) => { d.nodes[0].position = { x: "left", y: 0 }; }, "position");
});

test("validateDefinition accepts canvas coordinates", () => {
  const def = valid();
  def.nodes[0].position = { x: 40, y: 0 };
  def.nodes[1].position = { x: 40, y: 110 };
  assert.ok(validateDefinition(def).ok);
});

test("validateDefinition detects a cycle", () => {
  // A cycle would mean the run never terminates, so it is a hard reject rather than a warning.
  const def = valid();
  def.nodes.push({ id: "c", runtime: "shell", config: {}, inputs: [] });
  def.edges.push({ from: "b", to: "c" }, { from: "c", to: "a" });
  const res = validateDefinition(def);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => e.includes("cycle")), JSON.stringify(res.errors));
});

test("validateDefinition reports every problem, not just the first", () => {
  // A hand-edited file with three mistakes should report three, not force three fix rounds.
  const def = valid();
  def.name = "";
  def.id = "!!";
  assert.ok(validateDefinition(def).errors.length >= 2);
});

test("validateDefinition does not demand missedRunPolicy for manual triggers", () => {
  // Only time-driven triggers can miss a fire while the app is closed (design doc §12.2).
  const def = valid();
  def.triggers = [{ id: "t1", type: "manual", config: {} }];
  const res = validateDefinition(def);
  assert.ok(res.ok, JSON.stringify(res.errors));
});

/* -------------------------------------------------------------------- linearOrder */

test("linearOrder", async (t) => {
  await t.test("orders a chain", () => {
    const res = linearOrder(valid());
    assert.ok(res.ok);
    assert.deepEqual(res.order, ["a", "b"]);
  });

  await t.test("rejects a branch (v1 runs a single chain)", () => {
    const def = valid();
    def.nodes.push({ id: "c", runtime: "shell", config: {}, inputs: [] });
    def.edges.push({ from: "a", to: "c" });
    const res = linearOrder(def);
    assert.ok(!res.ok);
    assert.match(res.error, /branches/);
  });

  await t.test("rejects disconnected nodes", () => {
    const def = valid();
    def.nodes.push({ id: "z", runtime: "shell", config: {}, inputs: [] });
    assert.ok(!linearOrder(def).ok);
  });

  await t.test("rejects a graph with no start node", () => {
    const def = { nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    assert.ok(!linearOrder(def).ok);
  });
});

/* ------------------------------------------------------------------- definitions */

test("definition store", async (t) => {
  const root = useTempRoot();

  await t.test("save mints v1 and reads back", () => {
    const res = saveWorkflow(valid());
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.equal(res.version, 1);
    assert.equal(currentVersion("wf-demo"), 1);
    assert.equal(getWorkflow("wf-demo").name, "Demo");
  });

  await t.test("saving again mints a new version and never rewrites the old one", () => {
    // The core invariant: runs pin definitionVersion, so an existing v<N>.json must stay byte-stable
    // or old runs would be explained with a definition that never executed (design doc §2.1).
    const v1Before = fs.readFileSync(path.join(root, "workflows", "wf-demo", "v1.json"), "utf8");

    const edited = { ...valid(), name: "Demo renamed" };
    const res = saveWorkflow(edited);
    assert.equal(res.version, 2);

    const v1After = fs.readFileSync(path.join(root, "workflows", "wf-demo", "v1.json"), "utf8");
    assert.equal(v1After, v1Before, "v1.json must not be modified by a later save");

    assert.equal(getWorkflow("wf-demo").name, "Demo renamed"); // current
    assert.equal(getWorkflow("wf-demo", 1).name, "Demo"); // pinned
    assert.deepEqual(listVersions("wf-demo"), [1, 2]);
  });

  await t.test("the caller cannot choose the version number", () => {
    // Otherwise a caller could overwrite history simply by passing a stale version.
    const res = saveWorkflow({ ...valid(), version: 99 });
    assert.equal(res.version, 3);
    assert.equal(res.definition.version, 3);
  });

  await t.test("an invalid definition is rejected and writes nothing", () => {
    const before = listVersions("wf-demo");
    const res = saveWorkflow({ ...valid(), name: "" });
    assert.ok(!res.ok);
    assert.ok(res.errors.length > 0);
    assert.deepEqual(listVersions("wf-demo"), before, "a rejected save must not create a version");
  });

  await t.test("listWorkflows summarizes the current version", () => {
    const list = listWorkflows();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "wf-demo");
    assert.equal(list[0].version, 3);
    assert.equal(list[0].nodeCount, 2);
    assert.deepEqual(list[0].triggerTypes, ["cron"]);
  });

  await t.test("ids cannot escape the workflows directory", () => {
    // safeId strips separators, so a traversal attempt lands in a sanitized sibling directory
    // rather than writing outside the root.
    saveWorkflow({ ...valid(), id: "../../evil" });
    assert.equal(fs.existsSync(path.join(root, "..", "evil")), false);
  });

  await t.test("delete removes every version", () => {
    assert.ok(deleteWorkflow("wf-demo").ok);
    assert.equal(getWorkflow("wf-demo"), null);
    assert.deepEqual(listVersions("wf-demo"), []);
  });

  await t.test("reading a workflow that does not exist returns null", () => {
    assert.equal(getWorkflow("nope"), null);
    assert.equal(currentVersion("nope"), 0);
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test("database opens and migrates against a real file", async (t) => {
  const root = useTempRoot();

  await t.test("creates the file and applies the schema", () => {
    const db = openDb();
    assert.ok(fs.existsSync(path.join(root, "automation.db")));
    const v = Number(db.prepare("PRAGMA user_version").get().user_version);
    assert.equal(v, MIGRATIONS.length);
  });

  await t.test("uses WAL (so the scheduler can write while the UI reads)", () => {
    const mode = openDb().prepare("PRAGMA journal_mode").get().journal_mode;
    assert.equal(String(mode).toLowerCase(), "wal");
  });

  await t.test("reopening an existing database does not re-run migrations", () => {
    closeDb();
    const db = openDb();
    assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), MIGRATIONS.length);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM runs").get().c, 0);
  });

  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
