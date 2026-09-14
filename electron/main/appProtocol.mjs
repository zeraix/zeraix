/**
 * The app:// protocol: the app's own origin, serving the Next.js static export, the media library, skin images and
 * workspace files for the Files panel.
 *
 * Two halves on either side of app ready: registerAppSchemes() may run only once, before app.whenReady;
 * registerAppProtocol() installs the handler once the app is ready.
 */
import { app, protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getWorkingDir, getAssetDir } from "../tools/aiToolkit.mjs";
import { MIME_TYPES, mimeOfPath, serveWorkspaceFile, WS_PREFIX } from "../fileServing.mjs";
import { getMediaDir } from "../mediaStore.mjs";
import { serveSkinFile, SKINS_PREFIX } from "../skins/store.mjs";
import { SKIN_SCHEME_PRIVILEGES } from "../skins/engine.mjs";

/** Next.js static export directory (distDir: "Zeraix" in next.config.ts) */
const WEB_ROOT = path.join(app.getAppPath(), "Zeraix");

/** Custom protocol for loading static export files in production (file:// cannot handle absolute-path resources) */
const APP_SCHEME = "app";
export const APP_URL = `${APP_SCHEME}://localhost/`;

/** Declare app:// and skin:// privileged. Before app ready, and only once. */
export function registerAppSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
    // skin://current/tokens.css and friends: the active skin package's files (electron/skins/protocol.mjs).
    // Registered here because this call may run only once, before app.whenReady.
    SKIN_SCHEME_PRIVILEGES,
  ]);
}

/** Serve app:// requests. After app ready. */
export function registerAppProtocol() {
  protocol.handle(APP_SCHEME, handleAppRequest);
}

/**
 * Resolve the request path following Next.js static-export routing rules:
 * /foo -> foo | foo.html | foo/index.html, finally falling back to 404.html / index.html
 */
async function handleAppRequest(request) {
  const { pathname } = new URL(request.url);
  const decoded = decodeURIComponent(pathname);

  /**
   * Library files, served from the app's own origin.
   *
   * The renderer cannot show a local path — `<img src="C:\\…">` renders nothing — and refuses `file://`
   * cross-origin. Serving them here puts them on the same origin as the UI, so a thumbnail is an ordinary
   * <img> and a clip is an ordinary <video> with range requests.
   *
   * Only the BASENAME is honoured, resolved against the media folder: a stored entry is data, and data that
   * can name `../../.ssh/id_rsa` would turn the library into a file-read primitive.
   */
  // Skin images: checked by their bytes on the way in, served by fixed name on the way out. See skins/store.mjs.
  if (decoded.startsWith(SKINS_PREFIX)) return serveSkinFile(decoded.slice(SKINS_PREFIX.length));
  // Workspace files, for the Files panel: same origin, same boundary as the file tools. See fileServing.mjs.
  if (decoded.startsWith(WS_PREFIX)) {
    return serveWorkspaceFile(decoded.slice(WS_PREFIX.length), request, { workdir: getWorkingDir(), assetDir: getAssetDir() });
  }

  if (decoded.startsWith("/__media/")) {
    const dir = getMediaDir();
    const name = path.basename(decoded.slice("/__media/".length));
    if (!dir || !name) return new Response("not found", { status: 404 });
    try {
      const file = path.join(dir, name);
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { "content-type": mimeOfPath(file) } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  // Strip leading slashes and prevent path traversal
  const rel = path
    .normalize(decoded)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.([/\\]|$))+/, "");

  const candidates =
    rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
  candidates.push("404.html", "index.html");

  for (const candidate of candidates) {
    try {
      const data = await fs.promises.readFile(path.join(WEB_ROOT, candidate));
      let type =
        MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream";
      // Next.js static export writes RSC/segment-cache payloads as .txt (full-page `<route>.txt` and prefetch `__next.*.txt`).
      // The App Router client strictly validates that their content-type must be text/x-component, otherwise client navigation throws
      // (E394 "unexpected response"): router.push falls back to __pendingUrl for a full-page hard redirect and "looks normal",
      // but <Link>, which takes the prefetch/segment-cache path, has no such fallback and silently does nothing on click (exactly the case for the sidebar "Skills/Automation").
      // This directory is a pure Next export where all .txt files are RSC payloads, so return them uniformly as text/x-component.
      if (candidate.endsWith(".txt")) type = "text/x-component";
      return new Response(data, { headers: { "content-type": type } });
    } catch {
      // Try the next candidate path
    }
  }
  return new Response("Not Found", { status: 404 });
}
