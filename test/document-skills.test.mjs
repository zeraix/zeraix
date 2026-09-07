/**
 * The built-in document skills (docx / xlsx / pptx / pdf) and the helper scripts they point at.
 *
 * The skill text is what the model acts on, and it names scripts by path through the `{{SKILLS_DIR}}`
 * placeholder. A path that does not exist in resources/skills is a recipe that fails at the moment a user
 * needs it — so every referenced script is checked here, along with the frontmatter the catalog parser
 * relies on and the host-folder resolution the sandbox bind and the IPC share.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GUEST_SKILLS_DIR, resolveSkillsHostDir, skillsHostDirExists } from "../electron/tools/builtinSkills.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillsMd = path.join(root, "src", "skills", "builtin");
const scriptsDir = path.join(root, "resources", "skills");
const SKILLS = ["docx", "xlsx", "pptx", "pdf"];

function frontmatter(raw) {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  assert.ok(m, "frontmatter block present");
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: raw.slice(m[0].length) };
}

test("host folder: packaged under resourcesPath, dev under the repo", () => {
  assert.equal(
    resolveSkillsHostDir({ isPackaged: true, resourcesPath: "/app/resources", appPath: "/app/resources/app.asar" }),
    path.join("/app/resources", "skills"),
  );
  assert.equal(
    resolveSkillsHostDir({ isPackaged: false, appPath: "/repo" }),
    path.join("/repo", "resources", "skills"),
  );
  assert.equal(GUEST_SKILLS_DIR, "/mnt/skills");
  assert.ok(skillsHostDirExists(scriptsDir), "resources/skills exists in the repo");
  assert.equal(skillsHostDirExists(path.join(root, "no-such-folder")), false);
});

test("every built-in skill has the frontmatter the catalog needs and uses the placeholder", () => {
  for (const id of SKILLS) {
    const raw = fs.readFileSync(path.join(skillsMd, `${id}.md`), "utf8");
    const { data, body } = frontmatter(raw);
    assert.equal(data.id, id, `${id}: id matches the file name`);
    assert.ok(data.name, `${id}: name`);
    assert.ok(data.description && data.description.length > 80, `${id}: a trigger-rich description`);
    assert.ok(body.includes("{{SKILLS_DIR}}"), `${id}: refers to its helper scripts through the placeholder`);
    assert.ok(!/\/mnt\/skills|resources\/skills/.test(body), `${id}: never hard-codes a scripts path`);
  }
});

test("every script a skill refers to ships in resources/skills", () => {
  const missing = [];
  for (const id of SKILLS) {
    const raw = fs.readFileSync(path.join(skillsMd, `${id}.md`), "utf8");
    for (const m of raw.matchAll(/\{\{SKILLS_DIR\}\}\/([\w./-]+\.py)/g)) {
      if (!fs.existsSync(path.join(scriptsDir, m[1]))) missing.push(`${id}.md → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the helper scripts are valid Python (skipped when python3 is absent)", (t) => {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("python3 not available");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".py")) files.push(p);
    }
  };
  walk(scriptsDir);
  assert.ok(files.length >= 10, `found ${files.length} scripts`);
  const r = spawnSync("python3", ["-m", "py_compile", ...files], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("packaging stages the folder next to the other resources", () => {
  const yml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
  assert.match(yml, /from: resources\/skills\n\s+to: skills/);
});
