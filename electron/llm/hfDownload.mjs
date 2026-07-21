/**
 * Download GGUF models from Hugging Face ourselves (replacing llama.cpp's black-box `-hf` download), in order to:
 *   ① report aggregated download progress (%); ② resume interrupted downloads; ③ use the mirror endpoint chosen by reachability probing; ④ have fully controllable failure handling.
 * After the download finishes, localServer launches with `llama-server -m <first shard>` (+ `--mmproj <file>` when vision), no longer letting llama fetch on its own.
 *
 * Public repos (e.g. unsloth's GGUF) need no token; for gated/private repos or to raise the anonymous rate limit, set the HF_TOKEN environment variable.
 * The endpoint is passed in by the caller (huggingface.co or hf-mirror.com); both support /api/models/<repo>/tree and /<repo>/resolve.
 */
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { MIN_CTX } from "./localModels.mjs";

/** Request headers with an optional token: not needed for public repos, but HF_TOKEN helps for gated repos / rate limits. */
function authHeaders() {
  const tok = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

const isMmproj = (p) => /(^|\/)mmproj[^/]*\.gguf$/i.test(p);
// MTP / speculative-decoding drafter file: unsloth names them like MTP/gemma-4-12B-it-Q4_0-MTP.gguf or a top-level mtp-<name>.gguf.
const isMtp = (p) => /(^|\/)mtp-[^/]*\.gguf$/i.test(p) || /-mtp\.gguf$/i.test(p);

/**
 * Standalone chat-template files, in priority order. Most GGUF repos bake the template into the GGUF header instead, so
 * these are rare — but when a repo does ship one it is the authoritative template, and llama-server can load it directly
 * with --chat-template-file (see localModels.buildServerArgs).
 *   1. chat_template.jinja — the transformers convention, unambiguous.
 *   2. any other *.jinja at the repo root — some conversions name it after the model.
 *   3. a bare file named `template` — the unsloth/gemma-style convention (e.g. unsloth/gemma-3-12b-it-GGUF ships a 476-byte `template`).
 * Root-level only: a .jinja nested in a subdirectory is more likely a build artifact than the model's template.
 */
const TEMPLATE_MATCHERS = [
  (p) => /^chat_template\.jinja$/i.test(p),
  (p) => /^[^/]+\.jinja$/i.test(p),
  (p) => /^template$/i.test(p),
];
/** Pick the highest-priority chat-template file from a repo file listing; null when the repo ships none. */
function pickTemplateFile(files) {
  for (const match of TEMPLATE_MATCHERS) {
    const hit = files.find((x) => match(x.path));
    if (hit) return hit;
  }
  return null;
}

/** Match a quant tag at a token boundary (e.g. "Q4_K" must not match "…-Q4_K_M.gguf"; "Q4_K_M" must not match "UD-Q4_K_XL").
 *  Underscore counts as a tag character (tags contain them), so it cannot serve as a boundary. */
function hasQuantTag(p, quant) {
  const esc = String(quant).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, "i").test(p.split("/").pop());
}

// Sources whose GGUF conversions are consistently reliable; the Browse tab filters to these by default (toggleable to "all").
export const TRUSTED_AUTHORS = ["ggml-org", "unsloth", "bartowski", "Qwen", "google", "deepseek-ai", "microsoft", "mistralai", "openbmb"];

// First-party model publishers — the "standard" original model sources (not GGUF repackagers). Search results from these
// rank above third-party GGUF conversion repos (unsloth / bartowski / ggml-org / TheBloke / …), so the canonical model
// shows before its community repackages. Author = the part of the repo id before "/", matched case-insensitively.
export const FIRST_PARTY_AUTHORS = [
  "Qwen", "google", "deepseek-ai", "microsoft", "mistralai", "openbmb", "meta-llama", "ai21labs", "HuggingFaceTB",
  "allenai", "01-ai", "internlm", "THUDM", "zai-org", "CohereForAI", "cohere", "nvidia", "ibm-granite", "moonshotai",
  "tencent", "baidu", "inclusionAI", "LiquidAI", "arcee-ai", "NousResearch",
];
const FIRST_PARTY_SET = new Set(FIRST_PARTY_AUTHORS.map((a) => a.toLowerCase()));
// A "standard" (first-party) repo outranks a "GGUF" (repackaged) one; within each group, higher downloads win.
const isFirstParty = (repoId) => FIRST_PARTY_SET.has(String(repoId).split("/")[0].toLowerCase());

// Non-conversational model types that pollute a chat-model browser (embeddings / rerankers / classifiers …). Even though
// they ship GGUF (embeddinggemma etc.), they can't be used as a chat model here, so they're dropped from search results.
const NON_CHAT_PIPELINES = new Set([
  "sentence-similarity", "feature-extraction", "fill-mask", "text-ranking", "text-classification",
  "token-classification", "zero-shot-classification", "table-question-answering", "translation", "summarization",
]);
// Name-based fallback: many embedding/reranker GGUF repos (e.g. ggml-org/embeddinggemma-300M-GGUF) carry NO pipeline_tag
// or tags on the Hub, so metadata alone can't exclude them — the repo name is the only signal. Matched at a token boundary
// on the repo name (not the author), so an "embed"/"rerank" token is required, avoiding false hits inside a longer word.
const NON_CHAT_NAME = /(^|[-_.])(embed|rerank)/i;
const isChatModel = (item) => {
  if (NON_CHAT_NAME.test(String(item.id).split("/").pop() || "")) return false;
  if (item.pipeline_tag) return !NON_CHAT_PIPELINES.has(item.pipeline_tag);
  // Some GGUF repos omit pipeline_tag; fall back to the tags array, keeping the repo unless it carries a non-chat tag.
  return !(Array.isArray(item.tags) ? item.tags : []).some((t) => NON_CHAT_PIPELINES.has(t));
};

/** Extract the quant tag from a GGUF filename (UD-Q4_K_XL / Q4_K_M / IQ4_XS / Q8_0 / F16 / BF16 …). Returns null when unrecognized. */
function quantTagOf(p) {
  const base = p.split("/").pop();
  const m = base.match(/(UD-)?(I?Q[1-8](?:_[A-Z0-9]+)*|F16|BF16|F32|MXFP4)/i);
  return m ? `${m[1] ? "UD-" : ""}${m[2].toUpperCase()}` : null;
}

/**
 * Search GGUF repos on the Hub: single query, or fan out per author (authors[]) and merge sorted by downloads.
 * Returns [{ repo, downloads, likes, updatedAt, gated, tags }]. Anonymous access is fine (HF_TOKEN raises the rate limit, see authHeaders).
 */
export async function searchModels(endpoint, { query = "", authors = null, limit = 30 } = {}) {
  const one = async (author) => {
    const p = new URLSearchParams({ filter: "gguf", sort: "downloads", direction: "-1", limit: String(Math.min(limit, 50)) });
    if (query) p.set("search", query);
    if (author) p.set("author", author);
    // expand[]=gguf surfaces the parsed GGUF header (context_length) in the *list* response, so sub-32K models can be
    // dropped here rather than only at the detail dialog. Caveat: passing any expand[] switches the API to
    // "return only what was asked for" — tags/likes/lastModified/gated must be requested explicitly or the
    // isChatModel filter and the result cards silently lose their data.
    for (const f of ["gguf", "tags", "pipeline_tag", "likes", "downloads", "lastModified", "gated"]) p.append("expand[]", f);
    const res = await fetch(`${endpoint}/api/models?${p}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HF search ${res.status}`);
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  };
  // Trusted mode: the list API accepts a single author only → query each in parallel and merge (a failed author is skipped, not fatal).
  const raw = authors && authors.length
    ? (await Promise.allSettled(authors.map(one))).flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    : await one(null);
  const seen = new Set();
  return raw
    .filter((x) => x && typeof x.id === "string" && !seen.has(x.id) && seen.add(x.id))
    .filter(isChatModel) // drop embeddings / rerankers / classifiers that ship GGUF but aren't chat models
    // Drop models whose native window is too small to be usable (see MIN_CTX). Fail open: a missing/zero context_length
    // means HF has no parsed header for the repo, which is common — keep those and let the detail dialog decide.
    .filter((x) => { const c = x.gguf && x.gguf.context_length; return !c || c >= MIN_CTX; })
    // Default browse (no query) shows only standard first-party models; third-party GGUF-repackager repos
    // (unsloth / bartowski / ggml-org / …) surface only once the user explicitly types a search.
    .filter((x) => query ? true : isFirstParty(x.id))
    // Standard (first-party) model repos first, then GGUF-repackager repos; ties broken by downloads.
    .sort((a, b) => (isFirstParty(b.id) - isFirstParty(a.id)) || (b.downloads || 0) - (a.downloads || 0))
    .slice(0, limit)
    .map((x) => ({ repo: x.id, downloads: x.downloads || 0, likes: x.likes || 0, updatedAt: x.lastModified || null, gated: x.gated || false, tags: x.tags || [], ctx: (x.gguf && x.gguf.context_length) || null }));
}

/** Keep only the small scalar fields of HF's gguf header (architecture / context_length / total / head dims …):
 *  the raw object embeds the full Jinja chat template (multi-KB), which would bloat manifest.json and every IPC status push. */
function pruneGguf(g) {
  if (!g || typeof g !== "object") return null;
  const keep = {};
  for (const [k, v] of Object.entries(g)) {
    if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 64)) keep[k] = v;
  }
  return keep;
}

/**
 * Full detail of one GGUF repo, for the Browse tab and for launching non-catalog models:
 *   gguf   — HF-parsed GGUF header (architecture / context_length / total = parameter count …), null when the Hub has none;
 *   quants — every quant offering with aggregated bytes (shards summed; mmproj/MTP not counted, they download alongside any quant);
 *   mmproj/mtp — whether the repo ships a vision projector / MTP drafter.
 * Two parallel calls: model info (metadata) + tree (files with real sizes) — the same endpoints listRepoFiles already relies on.
 */
export async function repoDetail(endpoint, repo) {
  const [infoRes, treeRes] = await Promise.all([
    fetch(`${endpoint}/api/models/${repo}`, { headers: authHeaders() }),
    fetch(`${endpoint}/api/models/${repo}/tree/main?recursive=1`, { headers: authHeaders() }),
  ]);
  if (!infoRes.ok) throw new Error(`HF model info ${infoRes.status}`);
  if (!treeRes.ok) throw new Error(`HF tree ${treeRes.status}`);
  const info = await infoRes.json();
  const tree = await treeRes.json();
  const files = (Array.isArray(tree) ? tree : []).filter((x) => x && x.type === "file" && typeof x.path === "string");
  const sizeOf = (x) => Number((x.lfs && x.lfs.size) || x.size || 0);

  const quants = new Map(); // tag -> { id, bytes, shards }
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path) || isMmproj(f.path) || isMtp(f.path)) continue;
    const tag = quantTagOf(f.path);
    if (!tag) continue;
    const q = quants.get(tag) || { id: tag, bytes: 0, shards: 0 };
    q.bytes += sizeOf(f);
    q.shards += 1;
    quants.set(tag, q);
  }
  return {
    repo,
    downloads: info.downloads || 0,
    likes: info.likes || 0,
    gated: info.gated || false,
    gguf: pruneGguf(info.gguf),
    quants: [...quants.values()].sort((a, b) => b.bytes - a.bytes),
    mmproj: files.some((x) => isMmproj(x.path)),
    mtp: files.some((x) => isMtp(x.path)),
    // Path of the standalone chat template, when the repo ships one; downloaded alongside the weights and passed
    // to llama-server as --chat-template-file, taking priority over the GGUF's embedded template.
    templateFile: pickTemplateFile(files)?.path || null,
  };
}

/**
 * List the GGUF weight shards under a repo matching the quant (with real byte sizes), plus an optional vision projector (mmproj) and MTP drafter.
 * Uses the HF tree API (recursive to cover subdirectories, e.g. unsloth puts some tiers in a <QUANT>/ subdirectory). Mirrors support this path too.
 * Returns { weights:[{path,size}], mmproj:{path,size}|null, mtp:{path,size}|null }; throws on no match (the caller falls back to -hf).
 */
async function listRepoFiles(endpoint, repo, quant, { vision, mtp } = {}) {
  const url = `${endpoint}/api/models/${repo}/tree/main?recursive=1`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HF tree ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("HF tree: unexpected payload");
  const files = list.filter((x) => x && x.type === "file" && typeof x.path === "string");
  const sizeOf = (x) => Number((x.lfs && x.lfs.size) || x.size || 0); // an LFS file's real size is in lfs.size

  // Weights: name carries the quant tag at a token boundary (so Q4_K doesn't match Q4_K_M), ends with .gguf, and is not an mmproj / MTP
  // (e.g. :Q4_0 would wrongly match *-Q4_0-MTP.gguf). Shards are naturally sorted by path (00001-of-000NN in order).
  const weights = files
    .filter((x) => x.path.toLowerCase().endsWith(".gguf") && hasQuantTag(x.path, quant) && !isMmproj(x.path) && !isMtp(x.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((x) => ({ path: x.path, size: sizeOf(x) }));
  if (weights.length === 0) throw new Error(`No GGUF found matching ${quant}`);

  let mmproj = null;
  if (vision) {
    const cands = files.filter((x) => isMmproj(x.path));
    const pick = cands.find((x) => /f16/i.test(x.path)) || cands.find((x) => /bf16/i.test(x.path)) || cands[0] || null;
    if (pick) mmproj = { path: pick.path, size: sizeOf(pick) };
  }
  let mtpFile = null;
  if (mtp) {
    // The drafter is fully read for every draft token: prefer the smallest Q4_0 (halves the read, drafts faster), fall back to Q8_0, then to anything.
    const cands = files.filter((x) => isMtp(x.path));
    const pick = cands.find((x) => /q4_0/i.test(x.path)) || cands.find((x) => /q8_0/i.test(x.path)) || cands[0] || null;
    if (pick) mtpFile = { path: pick.path, size: sizeOf(pick) };
  }
  // Standalone chat template (a few KB at most): always fetched when present, so the launch path can prefer it over the
  // embedded template without a second round-trip. Absent in most GGUF repos, which bake the template into the header.
  const tpl = pickTemplateFile(files);
  const template = tpl ? { path: tpl.path, size: sizeOf(tpl) } : null;
  return { weights, mmproj, mtp: mtpFile, template };
}

/** Download a single file (resumable + per-chunk progress). Writes to <dest>.part and atomically renames to dest only once complete —
 *  so "final name exists" ⇔ "fully downloaded"; an interruption leaves only .part (never mistaken for downloaded). onBytes(delta) reports newly written bytes. */
async function downloadFile(endpoint, repo, file, dest, onBytes, signal) {
  if (file.size && fs.existsSync(dest) && fs.statSync(dest).size === file.size) { onBytes(file.size); return; } // final name already complete: skip
  const part = dest + ".part";
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (file.size && have > file.size) { fs.rmSync(part, { force: true }); have = 0; } // .part abnormally large → re-download
  if (file.size && have === file.size) { fs.renameSync(part, dest); onBytes(have); return; } // .part already full → finalize

  const url = `${endpoint}/${repo}/resolve/main/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { ...authHeaders() };
  if (have > 0 && file.size) headers.Range = `bytes=${have}-`;
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  if (!res.ok && res.status !== 206) throw new Error(`GET ${file.path} → HTTP ${res.status}`);
  const resuming = res.status === 206; // server accepts resume; otherwise (200) overwrite from the start
  if (resuming) onBytes(have);         // count the already-present portion toward progress
  if (!res.body) throw new Error(`GET ${file.path} → empty response body`);

  const ws = fs.createWriteStream(part, { flags: resuming ? "a" : "w" });
  try {
    for await (const chunk of Readable.fromWeb(res.body)) { // fetch's web stream → Node stream (stable for-await support)
      if (!ws.write(chunk)) await once(ws, "drain"); // backpressure: wait for drain before continuing
      onBytes(chunk.length);
    }
  } finally {
    await new Promise((resolve, reject) => { ws.on("error", reject); ws.end(resolve); });
  }
  fs.renameSync(part, dest); // for-await ended normally (no abort/error) → atomically finalize to the final name
}

/**
 * Download all weights for repo:quant (+ optional mmproj / MTP drafter) into destDir, reporting aggregated progress (integer 0–100, callback only on change).
 * Returns { modelPath, mmprojPath, mtpPath, templatePath }. Existing files auto-resume/skip. Cancellation (signal.abort) throws, keeping the downloaded portion for the next resume.
 * `manifest` (optional): extra fields (display name, gguf descriptor, catalog modelId …) persisted to destDir/manifest.json on completion —
 * the model library lists installed models off these manifests, so non-catalog downloads survive restarts (see localServer.listDownloaded).
 */
export async function downloadModel({ endpoint, repo, quant, vision, mtp, destDir, manifest = null }, onProgress = () => {}, signal) {
  const { weights, mmproj, mtp: mtpFile, template } = await listRepoFiles(endpoint, repo, quant, { vision, mtp });
  const all = [...weights, ...(mmproj ? [mmproj] : []), ...(mtpFile ? [mtpFile] : []), ...(template ? [template] : [])];
  const total = all.reduce((s, f) => s + (f.size || 0), 0);
  fs.mkdirSync(destDir, { recursive: true });

  let done = 0, lastPct = -1;
  const bump = (d) => {
    done += d;
    if (total > 0) { const p = Math.min(100, Math.floor((done / total) * 100)); if (p !== lastPct) { lastPct = p; onProgress(p); } }
  };
  for (const f of all) await downloadFile(endpoint, repo, f, path.join(destDir, path.basename(f.path)), bump, signal);
  if (lastPct !== 100) onProgress(100);

  // Written only after every file is finalized (same "complete ⇔ present" convention as the atomic rename above). Failure is non-fatal:
  // listDownloaded falls back to synthesizing an entry from the directory names.
  try {
    fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify({ repo, quant, vision: !!mmproj, mtp: !!mtpFile, templateFile: template ? path.basename(template.path) : null, bytes: total, ...(manifest || {}) }, null, 2));
  } catch { /* ignore */ }

  return {
    modelPath: path.join(destDir, path.basename(weights[0].path)), // first shard; llama.cpp auto-completes the rest of the shards in the same directory by -00001-of-000NN
    mmprojPath: mmproj ? path.join(destDir, path.basename(mmproj.path)) : null,
    mtpPath: mtpFile ? path.join(destDir, path.basename(mtpFile.path)) : null,
    templatePath: template ? path.join(destDir, path.basename(template.path)) : null,
  };
}
