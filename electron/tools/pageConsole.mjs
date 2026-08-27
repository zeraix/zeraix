/**
 * Headless page console capture (main process).
 *
 * Loads a URL in a hidden BrowserWindow, lets its JavaScript run for a moment, and returns what the page
 * itself reported: console.* output, uncaught exceptions, unhandled rejections and failed loads. It is the
 * no-panel counterpart of `browser → console` (BrowserPanel.tsx) — the model can check that a page it just
 * changed actually renders without errors, without the visible browser opening in the user's face and
 * without needing openBrowser, which is deliberately off-limits for investigation.
 *
 * Its own module rather than another handler in aiToolkit.mjs: that file is long past the 1000-line
 * ceiling, and this one owns a window lifecycle (create → load → settle → destroy) that must not leak a
 * hidden window on any path, including a throw.
 */
import { BrowserWindow } from "electron";

const DEFAULT_WAIT_MS = 2500; // settle time after load, for client-side JS to run and throw
const MAX_WAIT_MS = 15_000;
const LOAD_TIMEOUT_MS = 20_000; // hard cap on loadURL itself (a server that accepts but never answers)
const MAX_ENTRIES = 500; // ring buffer per capture
const MAX_MESSAGE_CHARS = 600; // one message; a stringified object can be enormous
const DEFAULT_MAX = 50; // messages returned when the caller does not say
const MAX_CONCURRENT = 2; // hidden windows alive at once, across all callers

let active = 0;

/** Chromium's numeric console levels, in Electron's order. Only the old-style event uses them. */
const NUMERIC_LEVELS = ["debug", "info", "warn", "error"];

/** Normalise both console-message event shapes to one of debug / info / warn / error. */
function normLevel(level) {
  if (typeof level === "number") return NUMERIC_LEVELS[level] ?? "info";
  const s = String(level ?? "").toLowerCase();
  if (s === "warning" || s === "warn") return "warn";
  if (s === "error" || s === "debug" || s === "info") return s;
  return "info";
}

/** Keep only entries at or above the requested severity. */
function atLeast(entries, want) {
  if (want === "error") return entries.filter((e) => e.level === "error");
  if (want === "warn") return entries.filter((e) => e.level === "error" || e.level === "warn");
  return entries;
}

/**
 * Load `url` headlessly and return the console output as text for the model.
 *
 * `url` must already be absolute (http/https, or a file:// URL the caller resolved inside the working
 * directory — this module does no path resolution and must never be handed a raw model-supplied path).
 */
export async function capturePageConsole({ url, waitMs, level, max } = {}) {
  const target = String(url ?? "").trim();
  if (!/^(https?|file):\/\//i.test(target)) throw new Error("url must be an absolute http(s) URL");
  if (active >= MAX_CONCURRENT) {
    throw new Error(
      `${MAX_CONCURRENT} headless page captures are already running; wait for one to finish before starting another`,
    );
  }

  const settle = Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs ?? DEFAULT_WAIT_MS) || DEFAULT_WAIT_MS));
  const want = String(level ?? "all").toLowerCase();
  const limit = Math.max(1, Number(max ?? DEFAULT_MAX) || DEFAULT_MAX);

  const entries = [];
  const push = (entry) => {
    if (entries.length >= MAX_ENTRIES) return;
    entries.push(entry);
  };

  active += 1;
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      // A non-persistent, in-memory session (no "persist:" prefix): this page must not read or write the
      // user's cookies, and nothing it stores survives the app. One fixed name rather than a fresh one per
      // call — Electron caches a Session object per partition name for the app's lifetime, so unique names
      // would pile them up, and successive captures of the same dev server sharing a cookie jar is useful.
      partition: "headless-page-console",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A window that is never shown is a background window, and Chromium throttles timers and rAF in one.
      // Without this a page whose error surfaces from a timeout would look clean.
      backgroundThrottling: false,
    },
  });

  try {
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" })); // a popup would escape the capture and outlive it

    // Electron ≥ 35 passes one details object; older builds pass (event, level, message, line, sourceId).
    // Accept both rather than pin the capture to a version of the signature.
    wc.on("console-message", (a, b, c, d) => {
      const details = a && typeof a === "object" && "message" in a ? a : null;
      const message = details ? details.message : c;
      const lineNumber = details ? details.lineNumber : d;
      push({
        level: normLevel(details ? details.level : b),
        text: String(message ?? "").slice(0, MAX_MESSAGE_CHARS),
        source: details?.sourceId ? `${details.sourceId}${lineNumber ? `:${lineNumber}` : ""}` : "",
      });
    });
    // A navigation that never produced a page has no console to report it — including the common case of a
    // dev server that has not finished starting (ERR_CONNECTION_REFUSED).
    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return; // ERR_ABORTED: superseded by a newer navigation, not a failure
      push({
        level: "error",
        text: `load failed: ${errorDescription || "unknown error"} (${errorCode})`,
        source: validatedURL ?? "",
      });
    });
    wc.on("render-process-gone", (_e, d) => {
      push({ level: "error", text: `the page crashed (${d?.reason ?? "unknown"})`, source: "" });
    });

    let loadError = "";
    let loadTimer = null;
    await Promise.race([
      win.loadURL(target).catch((e) => {
        loadError = e?.message ?? String(e);
      }),
      new Promise((r) => {
        loadTimer = setTimeout(() => {
          loadError ||= `timed out after ${LOAD_TIMEOUT_MS}ms`;
          r();
        }, LOAD_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(loadTimer); // the race is settled either way; leaving it armed holds a timer for 20s
    // Settle even after a load error: an error page still finished loading, and a partially loaded page
    // often throws right afterwards — that throw is exactly what the caller is asking about.
    if (settle > 0 && !win.isDestroyed()) await new Promise((r) => setTimeout(r, settle));

    const finalUrl = win.isDestroyed() ? target : wc.getURL() || target;
    const title = win.isDestroyed() ? "" : wc.getTitle();
    const kept = atLeast(entries, want);
    const shown = kept.slice(-limit);
    const errors = entries.filter((e) => e.level === "error").length;
    const warns = entries.filter((e) => e.level === "warn").length;

    const head =
      `Loaded ${finalUrl}${title ? ` — "${title}"` : ""} headlessly` +
      `${loadError ? ` (load error: ${loadError})` : ""}, waited ${settle}ms. ` +
      `${entries.length} console message(s): ${errors} error, ${warns} warning.`;
    if (shown.length === 0) {
      return (
        `${head}\n\nNothing to report at level "${want}". ` +
        (entries.length === 0 && !loadError
          ? "The page loaded and logged nothing at all — no runtime errors reached the console. " +
            "If you expected output that appears only after an interaction, this tool cannot produce it; it just loads the page."
          : "")
      ).trim();
    }
    const body = shown.map((e) => `[${e.level}] ${e.text}${e.source ? ` — ${e.source}` : ""}`).join("\n");
    const more = kept.length > shown.length ? `\n… ${kept.length - shown.length} earlier message(s) not shown` : "";
    return `${head}\n\n${body}${more}`;
  } finally {
    active -= 1;
    if (!win.isDestroyed()) win.destroy();
  }
}
