#!/usr/bin/env node
/**
 * Build (and sign) the registry feeds. See docs/plugin-marketplace-design.md §5.1, §5.4.
 *
 * Runs in the `zeraix/registry` repo's CI: it walks the submitted manifests, hashes their artifacts,
 * validates every one in STRICT mode, and emits the two signed envelopes the app fetches.
 *
 * Expected layout of the registry repo:
 *
 *   plugins/<publisher>/<name>/<version>/plugin.json   manifest source (sha512 may be omitted)
 *   plugins/<publisher>/<name>/<version>/files/…       the artifacts themselves
 *   killlist.json                                      { "entries": [ … ] }, hand-maintained
 *   dist/index.json, dist/killlist.json                output (signed envelopes)
 *
 * Publishers do not hand-compute digests. They ship files; this computes `sha512` from the bytes and
 * injects it before validating -- a hand-written base64 sha512 is a transcription error waiting to
 * break an install for everyone, and the whole point of content addressing is that the tooling owns it.
 *
 *   node scripts/build-registry-index.mjs --root . --check
 *       Validate only. No key needed, so it runs on pull requests from forks -- which is where a bad
 *       manifest is supposed to be caught (§5.4).
 *
 *   node scripts/build-registry-index.mjs --root . --base-url https://cdn.example.com/plugins \
 *       --key-id rel-2026-08 --key ~/.zeraix-registry-keys/rel-2026-08.pem
 *       Build and sign with the RELEASE key. In CI pass it as base64 PEM in REGISTRY_SIGNING_KEY.
 *
 * The root key never comes near this script or the machine it runs on. What authorizes the release
 * key used here is dist/keys.json, produced offline by scripts/sign-delegation.mjs and published
 * alongside the output -- without it, clients reject everything built here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateManifest } from "../electron/plugins/manifest.mjs";
import { signEnvelope } from "../electron/plugins/signature.mjs";

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
export function buildIndex(root, { baseUrl, sequence, issuedAt }) {
  const problems = [];
  const warnings = [];
  const plugins = [];

  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) {
    return { payload: null, problems: [`--base-url must be an https URL, got "${baseUrl}"`], warnings };
  }

  for (const entry of collectPluginDirs(root)) {
    const at = `plugins/${entry.publisher}/${entry.name}/${entry.version}`;
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
      const envelope = JSON.parse(fs.readFileSync(previous, "utf8"));
      const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
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

function loadPrivateKey({ keyPath, keyBase64 }) {
  const pem = keyPath ? fs.readFileSync(keyPath, "utf8") : Buffer.from(keyBase64, "base64").toString("utf8");
  return crypto.createPrivateKey(pem);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function main() {
  const root = path.resolve(arg("root", "."));
  const check = flag("check");
  const issuedAt = new Date().toISOString();

  const indexSeq = check ? 0 : nextSequence(root, "index", arg("sequence") ? Number(arg("sequence")) : null);
  const killSeq = check ? 0 : nextSequence(root, "killlist");

  const index = buildIndex(root, { baseUrl: arg("base-url", "https://example.invalid"), sequence: indexSeq, issuedAt });
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

  const keyId = arg("key-id");
  const keyBase64 = process.env.REGISTRY_SIGNING_KEY;
  const keyPath = arg("key");
  if (!keyId || (!keyPath && !keyBase64)) {
    console.error("signing needs --key-id and either --key <pem> or REGISTRY_SIGNING_KEY (base64 PEM)");
    console.error("(use --check to validate without signing, e.g. on pull requests)");
    process.exit(1);
  }
  const privateKey = loadPrivateKey({ keyPath, keyBase64 });

  const outDir = path.join(root, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, payload] of [["index", index.payload], ["killlist", kill.payload]]) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(signEnvelope(payload, { keyId, privateKey }), null, 2)}\n`);
  }

  console.log(`wrote dist/index.json (seq ${indexSeq}, ${count} plugin(s)) and dist/killlist.json (seq ${killSeq}), signed by ${keyId}`);

  // The delegation is the only reason a client will accept the signatures just written. It is
  // produced offline and committed to the registry repo; publishing without it is a silent no-op
  // for every install.
  const delegation = path.join(root, "keys.json");
  if (fs.existsSync(delegation)) {
    fs.copyFileSync(delegation, path.join(outDir, "keys.json"));
    console.log("copied keys.json (root-signed release-key delegation) into dist/");
  } else {
    console.warn("warning: no keys.json at the registry root — clients will reject these feeds.");
    console.warn("         Produce one offline: node scripts/sign-delegation.mjs --root-key … --key <release>.pub");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
