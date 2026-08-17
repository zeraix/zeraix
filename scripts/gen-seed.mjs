#!/usr/bin/env node
/**
 * Generate resident KV seeds for every allowlisted model.
 *
 * A seed is pre-computed KV for the `[messages[0] + tools]` prefix. Ship it and a user's very first request skips prefilling that
 * whole region — measured at 99.8–99.9% of ~10k tokens served from the seed.
 *
 * One call does the whole matrix, because the matrix is the unit that has to stay consistent: every model needs a seed for every
 * KV quantisation the app offers, and a half-published set means some users silently get a cold prefill with nothing to indicate
 * why. There used to be a second axis, the daily/dev mode; the tags merged into one, so "dev" is now simply the name the single
 * prefix is published under.
 *
 *   npm run seed:capture -- --out /tmp/px     # writes prefix-dev.json
 *   npm run seed:gen -- --prefix-dir /tmp/px --server <llama-server> --out dist/seeds
 *
 *   --model <id>   restrict to one model      --mode <dev>   restrict to one mode
 *
 * Per model+mode:
 *   llama-server --kv-disk-path <tmp>  ->  POST with X-KV-Pin: 1  ->  tar <tmp>/<model_key>/
 *   ->  <key>/seed-<model>-<mode>-<prefixHash>.{tar.gz,json},  key = seeds.seedKey (prefix + revision + kvd + KV quant)
 *
 * The prefix is an INPUT, never rebuilt here. It comes from src/lib/ai/promptPrefix.ts via seed:capture, which is the same code
 * path send() uses; a generator holding its own copy of the composition would drift and publish a seed that silently never matches.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MODELS, SEED_MODELS, KV_BITS_OFFERED, kvTypeName, buildServerArgs } from "../electron/llm/localModels.mjs";
import { seedKey } from "../electron/llm/seeds.mjs";

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const die = (m) => { console.error(`gen-seed: ${m}`); process.exit(1); };

const only = arg("model", null);
const onlyMode = arg("mode", null);
const prefixDir = arg("prefix-dir") || die("--prefix-dir <dir> is required (from 'npm run seed:capture -- --out <dir>')");
const serverBin = arg("server") || die("--server <path to llama-server> is required");
const outDir = arg("out", path.join(process.cwd(), "dist", "seeds"));
const kvd = arg("kvd", "5");
const modelsRoot = arg("models-root", path.join(os.homedir(), "Library/Application Support/Zeraix/llama/models"));
const basePort = Number(arg("port", "18090"));

if (!fs.existsSync(serverBin)) die(`${serverBin} not found`);

/**
 * Locate the installed GGUF for the model's PINNED revision: <root>/<hf with / -> _>/<rev8>/<quant>/<name>.gguf, excluding the
 * mmproj and MTP sidecars.
 *
 * The revision directory is required, not searched around. A seed is only valid for the exact GGUF it was built against — the
 * chat template ships inside the file and model_key does not cover it — so building from whatever GGUF happened to be on disk is
 * how a seed gets published that no install can ever match. Missing means "download the pinned revision first", not "use another".
 */
function findGguf(model) {
  const dir = path.join(modelsRoot, model.hf.replace(/\//g, "_"), model.revision.slice(0, 8));
  if (!fs.existsSync(dir)) return null;
  for (const quant of fs.readdirSync(dir)) {
    const qd = path.join(dir, quant);
    try { if (!fs.statSync(qd).isDirectory()) continue; } catch { continue; }
    const hit = fs.readdirSync(qd).find((f) => f.endsWith(".gguf") && !/mmproj|^mtp-/i.test(f));
    if (hit) return path.join(qd, hit);
  }
  return null;
}

const MODES = onlyMode ? [onlyMode] : ["dev"];
for (const m of MODES) if (!["dev"].includes(m)) die(`--mode must be dev (got ${m})`);

// Every KV quantisation the app offers needs its own seed: the server's model_key covers the
// KV cache types, so a machine running a quantisation we did not build for finds nothing and prefills cold. Taking the list from
// localModels rather than a flag here is what keeps "what the app can select" and "what we published" from drifting apart.
const KV_BITS = arg("kv-bits") ? [Number(arg("kv-bits"))] : KV_BITS_OFFERED;
for (const b of KV_BITS) if (!KV_BITS_OFFERED.includes(b)) die(`--kv-bits ${b} is not offered by the app (KV_BITS_OFFERED = ${KV_BITS_OFFERED.join(",")})`);

const targets = MODELS.filter((m) => SEED_MODELS.has(m.id) && (!only || m.id === only));
if (!targets.length) die(only ? `${only} is not on SEED_MODELS` : "no allowlisted models");

const prefixes = {};
for (const mode of MODES) {
  const f = path.join(prefixDir, `prefix-${mode}.json`);
  if (!fs.existsSync(f)) die(`${f} not found — run 'npm run seed:capture -- --out ${prefixDir}' first`);
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!p.system || !Array.isArray(p.tools)) die(`${f} must be { mode, system, tools }`);
  p.hash = crypto.createHash("sha256").update(JSON.stringify({ system: p.system, tools: p.tools })).digest("hex").slice(0, 16);
  prefixes[mode] = p;
}

fs.mkdirSync(outDir, { recursive: true });
const results = [];
let port = basePort;

for (const model of targets) {
  const gguf = findGguf(model);
  if (!gguf) { console.error(`gen-seed: SKIP ${model.id} — no GGUF installed under ${modelsRoot}`); continue; }
  // Required, not optional: a seed is only valid for the exact GGUF it was built against, because the chat template ships inside
  // the file and model_key does not cover it. Taking this as a flag is how earlier manifests ended up with a null version.
  if (!model.revision) { console.error(`gen-seed: SKIP ${model.id} — no pinned revision in MODELS`); continue; }

  for (const kvBits of KV_BITS) for (const mode of MODES) {
    const prefix = prefixes[mode];
    // Same seedKey the app resolves with, imported rather than re-templated here — a generator holding its own copy would publish
    // to a path the downloader never asks for, and the only symptom would be a 404 nobody sees.
    const key = seedKey({ prefixHash: prefix.hash, revision: model.revision, kvdVersion: kvd, kvBits });
    const base = `seed-${model.id}-${mode}-${prefix.hash}`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-seed-"));
    const kvDir = path.join(workDir, "kv");
    fs.mkdirSync(kvDir, { recursive: true });
    const p = port++;

    console.error(`gen-seed: ${model.id} ${mode} kv=${kvTypeName(kvBits)} | key ${key} | port ${p}`);
    const args = buildServerArgs({
      modelPath: gguf, hw: { backend: process.platform === "darwin" ? "metal" : "cpu" },
      ctx: Number(arg("ctx", "32768")), port: p, kvBits, kvDiskDir: kvDir, parallel: 2, noMmproj: true,
    });
    const srv = spawn(serverBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    srv.stdout.on("data", (d) => { log += d; });
    srv.stderr.on("data", (d) => { log += d; });
    const stop = () => { try { srv.kill("SIGTERM"); } catch { /* gone */ } };

    let healthy = false;
    for (let i = 0; i < 300 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (srv.exitCode != null) break;
      try { healthy = (await fetch(`http://127.0.0.1:${p}/health`)).ok; } catch { /* still booting */ }
    }
    if (!healthy) { stop(); console.error(`gen-seed: FAIL ${model.id} ${mode} — server never became healthy:\n${log.slice(-400)}`); continue; }

    // model_key is the server's own content-address of the KV layout; read it back rather than recomputing, so the archive is
    // filed exactly where the server will look for it.
    const modelKey = (log.match(/model_key = (\d+)/) || [])[1];
    if (!modelKey) { stop(); console.error(`gen-seed: FAIL ${model.id} ${mode} — no model_key in the server log`); continue; }

    let tokens = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-KV-Pin": "1", "X-Conversation-Id": `seed-${model.id}-${mode}-${key}` },
        body: JSON.stringify({
          model: "local",
          messages: [{ role: "system", content: prefix.system }, { role: "user", content: "ok" }],
          tools: prefix.tools, tool_choice: "auto", max_tokens: 1, stream: false,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      tokens = (await res.json()).usage?.prompt_tokens ?? 0;
    } catch (e) { stop(); console.error(`gen-seed: FAIL ${model.id} ${mode} — pin request: ${e.message}`); continue; }

    stop();
    await new Promise((r) => setTimeout(r, 2000)); // let the tip flush before archiving

    const seedDir = path.join(kvDir, modelKey);
    const files = fs.existsSync(seedDir) ? fs.readdirSync(seedDir) : [];
    if (!files.some((f) => f.startsWith("tip_"))) { console.error(`gen-seed: FAIL ${model.id} ${mode} — no pinned tip written`); continue; }
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(seedDir, f)).size, 0);

    const manifest = {
      modelId: model.id, mode, modelKey, prefixHash: prefix.hash, key,
      hfRepo: model.hf, modelVersion: model.revision, modelVersionShort: model.revision.slice(0, 8),
      kvdVersion: Number(kvd), kvBits, kvType: kvTypeName(kvBits), tokens, files: files.length, bytes,
      systemChars: prefix.system.length, toolCount: prefix.tools.length,
    };
    const keyDir = path.join(outDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, `${base}.json`), JSON.stringify(manifest, null, 2));
    await new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-czf", path.join(keyDir, `${base}.tar.gz`), "-C", kvDir, modelKey], { stdio: "inherit" });
      tar.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    });
    fs.rmSync(workDir, { recursive: true, force: true });

    console.error(`gen-seed:   -> ${key}/${base}.tar.gz (${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, ${tokens} tokens)`);
    results.push(manifest);
  }
}

const expected = targets.length * MODES.length * KV_BITS.length;
console.error(`gen-seed: ${results.length}/${expected} seeds written to ${outDir}`);
// A partial set is worth a non-zero exit: publishing some modes or some models leaves the rest silently falling back to a cold
// prefill, with nothing on the client to say why.
if (results.length !== expected) process.exit(1);
console.log(JSON.stringify(results, null, 2));
