/**
 * Serving files to the renderer over the app's own scheme.
 *
 * The renderer cannot show a disk path — `<img src="C:\\…">` renders nothing — and refuses `file://`
 * cross-origin. So anything the UI wants to display from disk is served from `app://localhost/`, the same
 * origin as the UI itself, and becomes an ordinary <img>, <video> or <iframe>. Two folders are served this
 * way: the media library (by basename, see handleAppRequest in main.mjs) and, here, the WORKING DIRECTORY,
 * so the Files panel can show a picture or a PDF the tree was clicked on.
 *
 * The workspace route resolves through the same boundary as the file tools (tools/paths.mjs): a path is
 * served only if it is inside the working directory or the read-only asset folder, and a request that
 * escapes either is refused rather than resolved. A stored or typed path is data, and data that can name
 * `../../.ssh/id_rsa` would turn a preview into a file-read primitive.
 */
import { net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePath } from "./tools/paths.mjs";

/** Extension → content type, for everything served over the app scheme (the static export included). */
export const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  // Chromium's built-in PDF viewer only engages when the response says so; as octet-stream it downloads instead.
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** The content type for a file, by its extension; unknown is octet-stream, which the browser will not try to render. */
export const mimeOfPath = (file) => MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** Route prefix for workspace files: `app://localhost/__ws/<path relative to the working directory>`. Mirrored by WORKSPACE_URL_PREFIX in src/lib/fileViewer.ts. */
export const WS_PREFIX = "/__ws/";

/**
 * Serve one workspace file for `request`.
 *
 * Streamed through Chromium's own file loader (net.fetch) rather than read into memory: a clip in the
 * workspace can be large, and a Range request forwarded here is what lets a <video> seek without pulling
 * the whole file first. Only the content type is overridden — the loader guesses it from the platform's
 * registry, which is not the same answer on every machine.
 */
export async function serveWorkspaceFile(rel, request, roots) {
  let abs;
  try {
    abs = resolvePath(rel, roots);
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  let st;
  try {
    st = await fs.promises.stat(abs);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!st.isFile()) return new Response("not found", { status: 404 });

  const range = request.headers.get("range");
  const upstream = await net.fetch(pathToFileURL(abs).toString(), range ? { headers: { range } } : undefined);
  const headers = new Headers(upstream.headers);
  headers.set("content-type", mimeOfPath(abs));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
