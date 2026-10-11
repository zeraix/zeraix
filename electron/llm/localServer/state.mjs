/**
 * Shared state of the local llama-server (main process): the status object every part reads and mutates, the status
 * listeners, the run-log file, and the uma cache the probe and a real model run both feed.
 *
 * Owned here so the other localServer parts share ONE instance — they import from this module, never from localServer.mjs.
 * No reassignable binding is exported: `state` and `umaCache` are mutated in place, and the log stream (which is reassigned)
 * stays private behind openLog / closeLog / pushLog.
 */
import path from "node:path";
import fs from "node:fs";
import { installedBin, llamaVersionDir, localFilesBase } from "../llamaInstaller.mjs";
import { resolveHfEndpoint as resolveHfEndpointShared } from "../hfEndpoint.mjs";

const DEFAULT_PORT = Number(process.env.LLAMA_PORT || 8080);
// KV disk tier + resident seeds. Deliberately NOT under tmpdir: the point of the tier is to survive a restart,
// and downloaded seeds live here too (in a <model_key>/ sub-folder the server creates). Sibling of models/, so version pruning —
// which scans only bin/ — leaves it alone.
export const kvDiskDir = () => path.join(localFilesBase(), "kv");

// Hugging Face endpoint used by -hf to fetch GGUF: huggingface.co, or hf-mirror.com when it is unreachable (blocked / DNS
// poisoning / timeout). Shared with the seed and llama-runtime downloads, so the probe runs once per process — see
// hfEndpoint.mjs, which owns it because llamaInstaller needs the same answer and cannot import this module back.
export const resolveHfEndpoint = () => resolveHfEndpointShared((line) => pushLog(`[llama] ${line}\n`));

export const state = {
  proc: null,
  ready: false,
  phase: "idle", // idle | downloading | extracting | fetching | probing | loading | ready | error
  pct: 0, // download progress percentage (downloading = llama runtime; fetching = model weights)
  port: DEFAULT_PORT,
  model: null, // { hf, label, multimodal, id, name }
  variant: null, // llama build variant currently installed/started
  installedVariant: null, // installed variant (reused for probe/startup to avoid re-downloading)
  probe: null, // { vramGB, device, gpuPresent } -- --list-devices result
  ctx: 16384,
  error: null,
  log: [],
  dlAbort: null, // AbortController for the model self-download (aborted on stop/reset)
};

const listeners = new Set();
// Run-log file: persist all install/probe/download/llama-server output to disk for user troubleshooting (only the most recent 300 lines are kept in memory, see pushLog).
// start() opens a new session and writes a header, pushLog appends in sync, stop()/exit closes it; auto-cleared and restarted when it exceeds 5MB.
let logStream = null;
function logFilePath() { return path.join(localFilesBase(), "logs", "llama-server.log"); }
// Lazily open the append stream: created on the first pushLog, so output from the "install / probe / download" phases (before start) is persisted too. Cleared and restarted past 5MB.
function ensureLog() {
  if (logStream) return;
  try {
    const p = logFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try { if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    logStream = fs.createWriteStream(p, { flags: "a" });
  } catch { logStream = null; }
}
export function openLog(header) { ensureLog(); if (logStream) { try { logStream.write(`\n===== ${header} =====\n`); } catch { /* ignore */ } } }
export function closeLog() { if (logStream) { try { logStream.end(); } catch { /* ignore */ } logStream = null; } }
// Ensure the log file exists (even if no model has run yet), so the "run log" button can always open it (it opens the log under the current folder).
export function ensureLogFile() {
  try { const p = logFilePath(); fs.mkdirSync(path.dirname(p), { recursive: true }); if (!fs.existsSync(p)) fs.writeFileSync(p, ""); } catch { /* ignore */ }
  return logFilePath();
}
// device name (lowercase) -> uma truth value: once a real model run reads the authoritative uma: from stderr, cache it for later probe/recommend to use directly
// (more accurate than the name heuristic when --list-devices has no uma). See docs/vulkan-uma-windows.md.
export const umaCache = new Map();

/** Current outward-facing status snapshot (structured-cloneable, for IPC to the renderer). */
export function status() {
  return {
    running: !!state.proc,
    ready: state.ready,
    phase: state.phase,
    pct: state.pct,
    port: state.port,
    model: state.model,
    endpoint: `http://127.0.0.1:${state.port}/v1/chat/completions`,
    installed: !!installedBin(state.installedVariant || undefined),
    installedVariant: state.installedVariant,
    version: llamaVersionDir(),
    variant: state.variant,
    probe: state.probe,
    error: state.error,
    tail: state.log.slice(-12).join(""),
    logFile: logFilePath(), // full run-log file path (for the UI "run log" button to open)
  };
}

export function emit() { const st = status(); for (const cb of listeners) { try { cb(st); } catch { /* ignore */ } } }
/** Main process registers a status listener (forwarded to the renderer). Returns an unsubscribe function. */
export function onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export function pushLog(s) { state.log.push(s); if (state.log.length > 300) state.log.shift(); ensureLog(); if (logStream) { try { logStream.write(s); } catch { /* ignore */ } } }
