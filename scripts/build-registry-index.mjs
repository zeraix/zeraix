#!/usr/bin/env node
/**
 * Build the registry feeds. See docs/plugin-marketplace-design.md §5.1, §5.4.
 *
 * Runs in the `zeraix/registry` repo's CI: it walks the submitted manifests, hashes their artifacts,
 * validates every one in STRICT mode, and emits the two JSON documents the app fetches. There is no
 * signing step and no key of any kind -- the repo's review history is the provenance, and the
 * mirror serves the result over https (§5.1).
 *
 * Expected layout of the registry repo:
 *
 *   plugins/<publisher>/<name>/<version>/plugin.json   manifest source (sha512 may be omitted)
 *   plugins/<publisher>/<name>/<version>/files/…       the artifacts themselves
 *   killlist.json                                      { "entries": [ … ] }, hand-maintained
 *   dist/index.json, dist/killlist.json                output
 *
 * Publishers do not hand-compute digests. They ship files; this computes `sha512` from the bytes and
 * injects it before validating -- a hand-written base64 sha512 is a transcription error waiting to
 * break an install for everyone, and the whole point of content addressing is that the tooling owns it.
 *
 *   node scripts/build-registry-index.mjs --root . --check
 *       Validate only, write nothing. Runs on pull requests from forks -- which is where a bad
 *       manifest is supposed to be caught (§5.4).
 *
 *   node scripts/build-registry-index.mjs --root . --base-url https://cdn.example.com/plugins
 *       Build dist/index.json and dist/killlist.json.
 *
 *   --allow-reserved
 *       Permit plugins under a reserved publisher (manifest.mjs RESERVED_PUBLISHERS -- "zeraix" and
 *       friends). Off by default, so a submission cannot claim to be official. The publish workflow
 *       sets it; a fork's pull request cannot.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateManifest, RESERVED_PUBLISHERS } from "../electron/plugins/manifest.mjs";

const sha512 = (buf) => crypto.createHash("sha512").update(buf).digest("base64");

/* ------------------------------------------------------------------ collect */

/** Every `<publisher>/<name>/<version>/plugin.json` under `<root>/plugins`, sorted for a stable index. */
export function collectPluginDirs(root) {
  const base = path.join(root, "plugins");
  const found = [];
  const dirs = (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  for (const publisher of dirs(base)) {
    for (const name of dirs(path.join(base, publisher))) {
      for (const version of dirs(path.join(base, publisher, name))) {
        const dir = path.join(base, publisher, name, version);
        if (fs.existsSync(path.join(dir, "plugin.json"))) found.push({ publisher, name, version, dir });
      }
    }
  }
  return found;
}

/**
 * Fill in `sha512` for everything the manifest references, reading the bytes from `files/`.
 *
 * Also the point where a manifest referencing a file that does not exist is caught. Shipping that
 * would produce an entry every user can see and no user can install.
 */
export function resolveArtifacts(source, filesDir) {
  const problems = [];
  const manifest = structuredClone(source);
  const referenced = new Set();

  const hashOf = (relPath, at) => {
    if (typeof relPath !== "string" || !relPath) {
      problems.push(`${at}: path must be a string`);
      return null;
    }
    const abs = path.join(filesDir, relPath);
    if (!abs.startsWith(filesDir + path.sep)) {
      problems.push(`${at}: "${relPath}" escapes files/`);
      return null;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      problems.push(`${at}: files/${relPath} does not exist`);
      return null;
    }
    referenced.add(path.relative(filesDir, abs));
    return sha512(buf);
  };

  for (const [i, cap] of (manifest.capabilities ?? []).entries()) {
    if (!cap || typeof cap !== "object" || !("path" in cap)) continue;
    const digest = hashOf(cap.path, `capabilities[${i}]`);
    if (digest) {
      // A declared hash that disagrees with the bytes is not a warning: it means the manifest and
      // the artifact came from different builds, and one of them is not what the publisher reviewed.
      if (typeof cap.sha512 === "string" && cap.sha512 !== digest) {
        problems.push(`capabilities[${i}]: declared sha512 does not match files/${cap.path}`);
      }
      cap.sha512 = digest;
    }
  }
  for (const [id, provider] of Object.entries(manifest.providers ?? {})) {
    if (!provider || typeof provider !== "object" || !provider.entry) continue;
    const digest = hashOf(provider.entry, `providers.${id}`);
    if (digest) {
      if (typeof provider.sha512 === "string" && provider.sha512 !== digest) {
        problems.push(`providers.${id}: declared sha512 does not match files/${provider.entry}`);
      }
      provider.sha512 = digest;
    }
  }

  return { manifest, problems, referenced };
}

/** Files present in files/ that nothing references. Dead weight, and usually a rename someone missed. */
function unreferencedFiles(filesDir, referenced) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (!referenced.has(path.relative(filesDir, abs))) out.push(path.relative(filesDir, abs));
    }
  };
  walk(filesDir);
  return out;
}

/* ------------------------------------------------------------------ index */

/**
 * Assemble the index payload.
 *
 * Validation runs in `registry` mode and AFTER hash injection -- strict mode is the whole reason the
 * validator has two modes, and this is its only caller. A manifest a client would silently skip
 * fails the build here, which is the difference between a reviewer seeing it and a user not.
 *
 * @returns {{payload: object|null, problems: string[], warnings: string[]}}
 */
export function buildIndex(root, { baseUrl, sequence, issuedAt, allowReserved = false }) {
  const problems = [];
  const warnings = [];
  const plugins = [];

  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) {
    return { payload: null, problems: [`--base-url must be an https URL, got "${baseUrl}"`], warnings };
  }

  for (const entry of collectPluginDirs(root)) {
    const at = `plugins/${entry.publisher}/${entry.name}/${entry.version}`;

    // Reserved namespaces (manifest.mjs RESERVED_PUBLISHERS) mean "official", and the consent sheet
    // says so. Nothing enforced that until this check: the constant was exported and never read,
    // its comment claimed registry CI checked ownership, and CI did not -- so a pull request adding
    // plugins/zeraix/<anything> validated and published as ours. That mattered more once feeds
    // stopped being signed (design doc §5.1), because human review became the only gate and this is
    // exactly the submission a reviewer skims past.
    //
    // Only builds that are ALLOWED to speak for us pass --allow-reserved: the publish workflow, and
    // pull requests raised from the registry repo itself. A fork cannot set it.
    if (!allowReserved && RESERVED_PUBLISHERS.includes(entry.publisher)) {
      problems.push(
        `${at}: "${entry.publisher}" is a reserved publisher — a submission may not claim it. ` +
          `(Maintainers publishing an official plugin: pass --allow-reserved.)`,
      );
      continue;
    }
    let source;
    try {
      source = JSON.parse(fs.readFileSync(path.join(entry.dir, "plugin.json"), "utf8"));
    } catch (e) {
      problems.push(`${at}/plugin.json: ${e.message}`);
      continue;
    }

    const filesDir = path.join(entry.dir, "files");
    const resolved = resolveArtifacts(source, filesDir);
    resolved.problems.forEach((p) => problems.push(`${at}: ${p}`));
    if (resolved.problems.length > 0) continue;

    const result = validateManifest(resolved.manifest, { mode: "registry" });
    result.warnings.forEach((w) => warnings.push(`${at}: ${w}`));
    if (!result.ok) {
      result.errors.forEach((e) => problems.push(`${at}: ${e}`));
      continue;
    }

    // The directory is the source of truth for identity: a manifest claiming a different id or
    // version than its path would publish under one name and install under another.
    const expectedId = `${entry.publisher}/${entry.name}`;
    if (result.manifest.id !== expectedId) {
      problems.push(`${at}: manifest id "${result.manifest.id}" does not match its directory (${expectedId})`);
      continue;
    }
    if (result.manifest.version !== entry.version) {
      problems.push(`${at}: manifest version "${result.manifest.version}" does not match its directory`);
      continue;
    }

    unreferencedFiles(filesDir, resolved.referenced).forEach((f) => warnings.push(`${at}: files/${f} is not referenced`));

    plugins.push({
      manifest: result.manifest,
      dist: { baseUrl: `${base}/${entry.publisher}/${entry.name}/${entry.version}/` },
    });
  }

  // One version per plugin in the index: the client installs "the" version of an id, so publishing
  // two would make which one a user gets depend on array order.
  const byId = new Map();
  for (const p of plugins) {
    const seen = byId.get(p.manifest.id);
    if (seen) problems.push(`${p.manifest.id}: published twice (${seen} and ${p.manifest.version}) — remove the older directory`);
    else byId.set(p.manifest.id, p.manifest.version);
  }

  return {
    payload: problems.length > 0 ? null : { type: "index", sequence, issuedAt, plugins },
    problems,
    warnings,
  };
}

/** Assemble the kill-list payload from the repo's hand-maintained killlist.json. */
export function buildKillList(root, { sequence, issuedAt }) {
  const file = path.join(root, "killlist.json");
  if (!fs.existsSync(file)) return { payload: { type: "killlist", sequence, issuedAt, entries: [] }, problems: [] };

  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { payload: null, problems: [`killlist.json: ${e.message}`] };
  }
  if (!Array.isArray(source?.entries)) return { payload: null, problems: ["killlist.json: entries must be an array"] };

  return { payload: { type: "killlist", sequence, issuedAt, entries: source.entries }, problems: [] };
}

/* ------------------------------------------------------------------ sequence */

/**
 * Next sequence number for a feed.
 *
 * Clients refuse a feed whose sequence is below the one they hold (feed.mjs), so a sequence that
 * goes backwards is not a cosmetic mistake -- it makes every existing install ignore the registry
 * until the number climbs past where it was. Derived from the last published output rather than
 * from a counter someone maintains by hand, and an explicit lower value is refused.
 */
export function nextSequence(root, name, explicit = null) {
  const previous = path.join(root, "dist", `${name}.json`);
  let last = 0;
  if (fs.existsSync(previous)) {
    try {
      const payload = JSON.parse(fs.readFileSync(previous, "utf8"));
      if (Number.isInteger(payload.sequence)) last = payload.sequence;
    } catch {
      /* unreadable previous output: fall through to last = 0 */
    }
  }
  if (explicit !== null) {
    if (explicit <= last) throw new Error(`--sequence ${explicit} would roll back ${name} from ${last}`);
    return explicit;
  }
  return last + 1;
}

/* ------------------------------------------------------------------ cli */

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function main() {
  const root = path.resolve(arg("root", "."));
  const check = flag("check");
  const issuedAt = new Date().toISOString();

  // `dist/` is gitignored, so in CI there is never a previous build to count from and nextSequence
  // would hand out 1 on every publish — a sequence that never advances is a rollback check that
  // never fires. CI passes --sequence from a counter that does survive a fresh checkout
  // (github.run_number); nextSequence still refuses a value that would go backwards, which is what
  // catches a counter that was reset or a hand-typed mistake. Both feeds take the same number:
  // sequences only have to be monotonic per feed, and one publish is one number.
  const explicit = arg("sequence") ? Number(arg("sequence")) : null;
  if (explicit !== null && !Number.isInteger(explicit)) {
    console.error(`--sequence must be an integer, got "${arg("sequence")}"`);
    process.exit(1);
  }
  const indexSeq = check ? 0 : nextSequence(root, "index", explicit);
  const killSeq = check ? 0 : nextSequence(root, "killlist", explicit);

  const index = buildIndex(root, {
    baseUrl: arg("base-url", "https://example.invalid"),
    sequence: indexSeq,
    issuedAt,
    allowReserved: flag("allow-reserved"),
  });
  const kill = buildKillList(root, { sequence: killSeq, issuedAt });

  for (const w of index.warnings) console.warn(`warning: ${w}`);
  const problems = [...index.problems, ...kill.problems];
  if (problems.length > 0) {
    for (const p of problems) console.error(`error: ${p}`);
    console.error(`\n${problems.length} problem(s) — nothing was written.`);
    process.exit(1);
  }

  const count = index.payload.plugins.length;
  if (check) {
    console.log(`ok: ${count} plugin(s) validated, ${kill.payload.entries.length} kill-list entr(ies)`);
    return;
  }

  const outDir = path.join(root, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, payload] of [["index", index.payload], ["killlist", kill.payload]]) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }

  console.log(`wrote dist/index.json (seq ${indexSeq}, ${count} plugin(s)) and dist/killlist.json (seq ${killSeq})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
