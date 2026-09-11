/**
 * The `skin://` protocol: files of an installed skin package, served to the renderer.
 *
 *   skin://current/tokens.css          the active package's stylesheet
 *   skin://current/assets/bg.png       one of its assets
 *   skin://<id>/preview.png            a specific package (the gallery's previews)
 *
 * No `electron` import on purpose: `serveSkinRequest` is a plain function of a URL string and two
 * values (where packages live, which one is active), so test/skin-protocol.test.mjs can drive the
 * exact code the app registers with a traversal URL and read the 404 back.
 *
 * What a request may name is decided in this order, and the first failure is a 404 -- never an
 * exception, never a different status that would tell a probe which check it hit:
 *   1. the raw URL contains no `..`, no backslash, no NUL and no encoded form of them;
 *   2. the host is `current` (resolved to the active id) or a valid package id;
 *   3. the path is a plain relative path whose extension is one the engine allows into a package;
 *   4. the resolved file is inside that package's directory and is a regular file.
 */
import fsp from "node:fs/promises";
import path from "node:path";

export const SKIN_SCHEME = "skin";

/** For protocol.registerSchemesAsPrivileged, which must run once, before app.whenReady. */
export const SKIN_SCHEME_PRIVILEGES = Object.freeze({
  scheme: SKIN_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
});

const MIME = Object.freeze({
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  woff2: "font/woff2",
});

/** Same shape the engine enforces on manifest ids (manifest.rs::is_kebab_case). */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_MAX = 40;
const RESERVED = new Set(["default", "current", "none", "light", "dark", "system"]);

const isPackageId = (id) => typeof id === "string" && id.length >= 2 && id.length <= ID_MAX && ID_RE.test(id) && !RESERVED.has(id) && !id.startsWith("builtin-");

/**
 * Resolve a request to a file on disk, or null. Pure and synchronous: no filesystem access here,
 * only string checks, so it can be exercised exhaustively.
 */
export function resolveSkinRequest(rawUrl, { skinsDir, activeId }) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) return null;
  const lower = rawUrl.toLowerCase();
  if (lower.includes("..") || lower.includes("\\") || lower.includes("\0") || lower.includes("%2e") || lower.includes("%5c") || lower.includes("%00")) {
    return null;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${SKIN_SCHEME}:`) return null;
  const host = url.hostname.toLowerCase();
  const id = host === "current" ? activeId : host;
  if (!isPackageId(id)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, "");
  if (!rel || rel.length > 512) return null;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) return null;
  const ext = path.posix.extname(rel).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;

  const base = path.resolve(skinsDir, id);
  const file = path.resolve(base, ...segments);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  if (file === base) return null;
  return { id, rel, file, mime };
}

const NOT_FOUND = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });

/**
 * The handler behind protocol.handle('skin', ...). Never throws: every failure is a 404 response.
 *
 * What this serves is what ELEMENT loads ask for: the <link rel="stylesheet"> and <img> requests.
 * It is not reachable by fetch() from the renderer -- Chromium refuses a cross-origin fetch to any
 * custom scheme ("Cross origin requests are only supported for protocol schemes: chrome, ...,
 * http, https"), whatever CORS headers come back -- so layout.json and friends travel over IPC
 * (engine.mjs `skinpkg:read-text`, store.rs::read_text). Verified in a real Electron: the fetch is
 * blocked, the same URL as a stylesheet loads.
 */
export async function serveSkinRequest(rawUrl, ctx) {
  try {
    const hit = resolveSkinRequest(rawUrl, ctx);
    if (!hit) return NOT_FOUND();
    const st = await fsp.lstat(hit.file);
    if (!st.isFile()) return NOT_FOUND();
    const data = await fsp.readFile(hit.file);
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": hit.mime,
        "content-length": String(data.byteLength),
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NOT_FOUND();
  }
}
