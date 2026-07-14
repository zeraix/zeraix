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

/** Request headers with an optional token: not needed for public repos, but HF_TOKEN helps for gated repos / rate limits. */
function authHeaders() {
  const tok = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

const isMmproj = (p) => /(^|\/)mmproj[^/]*\.gguf$/i.test(p);
// MTP / speculative-decoding drafter file: unsloth names them like MTP/gemma-4-12B-it-Q4_0-MTP.gguf or a top-level mtp-<name>.gguf.
const isMtp = (p) => /(^|\/)mtp-[^/]*\.gguf$/i.test(p) || /-mtp\.gguf$/i.test(p);

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
  const q = String(quant).toLowerCase();

  // Weights: name contains the quant tag, ends with .gguf, and is not an mmproj / MTP (e.g. :Q4_0 would wrongly match *-Q4_0-MTP.gguf).
  // Shards are naturally sorted by path (00001-of-000NN in order).
  const weights = files
    .filter((x) => x.path.toLowerCase().endsWith(".gguf") && x.path.toLowerCase().includes(q) && !isMmproj(x.path) && !isMtp(x.path))
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
  return { weights, mmproj, mtp: mtpFile };
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
 * Returns { modelPath, mmprojPath, mtpPath }. Existing files auto-resume/skip. Cancellation (signal.abort) throws, keeping the downloaded portion for the next resume.
 */
export async function downloadModel({ endpoint, repo, quant, vision, mtp, destDir }, onProgress = () => {}, signal) {
  const { weights, mmproj, mtp: mtpFile } = await listRepoFiles(endpoint, repo, quant, { vision, mtp });
  const all = [...weights, ...(mmproj ? [mmproj] : []), ...(mtpFile ? [mtpFile] : [])];
  const total = all.reduce((s, f) => s + (f.size || 0), 0);
  fs.mkdirSync(destDir, { recursive: true });

  let done = 0, lastPct = -1;
  const bump = (d) => {
    done += d;
    if (total > 0) { const p = Math.min(100, Math.floor((done / total) * 100)); if (p !== lastPct) { lastPct = p; onProgress(p); } }
  };
  for (const f of all) await downloadFile(endpoint, repo, f, path.join(destDir, path.basename(f.path)), bump, signal);
  if (lastPct !== 100) onProgress(100);

  return {
    modelPath: path.join(destDir, path.basename(weights[0].path)), // first shard; llama.cpp auto-completes the rest of the shards in the same directory by -00001-of-000NN
    mmprojPath: mmproj ? path.join(destDir, path.basename(mmproj.path)) : null,
    mtpPath: mtpFile ? path.join(destDir, path.basename(mtpFile.path)) : null,
  };
}
