/**
 * Naming and saving a viewer item.
 *
 * Kept apart from the viewer so the rules can be tested without a DOM: which name a download gets is the
 * kind of thing only ever noticed when it is wrong ("download (3).bin" for a generated picture).
 */
import type { MediaViewerItem } from "@/store/mediaViewerStore";

const EXT_OF_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "application/json": "json",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
};

const basename = (p?: string): string => (p ? (p.split(/[\\/]/).pop() ?? "") : "");

/** The mime a data: URL declares, or "" for anything else. */
export function mimeOfDataUrl(src: string): string {
  const m = /^data:([^;,]+)[;,]/i.exec(src);
  return m ? m[1].toLowerCase() : "";
}

/** The item's mime: what it says, else what its data: URL says, else "". */
export const mimeOf = (item: MediaViewerItem): string =>
  (item.mime || mimeOfDataUrl(item.src)).toLowerCase();

/** The last path segment of an http(s)/app URL, when it looks like a file name (has an extension). */
function urlBasename(src: string): string {
  if (!/^(https?|app):/i.test(src)) return "";
  try {
    const name = decodeURIComponent(basename(new URL(src).pathname));
    return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : "";
  } catch {
    return "";
  }
}

/**
 * The file name a download gets.
 *
 * The disk name first, then the URL's, because those ARE file names. The display name last, because it is
 * usually a prompt or a caption, and only becomes a file name once it is cleaned of path characters and
 * given the extension its mime implies.
 */
export function fileNameOf(item: MediaViewerItem): string {
  const known = basename(item.path) || urlBasename(item.src);
  if (known) return known;
  const base =
    (item.name || "media")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "media";
  const ext = EXT_OF_MIME[mimeOf(item)] ?? "";
  return ext && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base;
}

function clickDownload(href: string, name: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save the item through the browser's download path — which, in Electron, is the OS "Save as" dialog.
 *
 * data: and blob: sources download as they are. Anything remote is fetched into a blob first, because
 * `download` is ignored on a cross-origin link and the click would NAVIGATE the app to the picture instead.
 * When even that fails (a vendor URL without CORS), the file is opened in a new window — which the main
 * process hands to the system browser — so the user still ends up somewhere they can save it from.
 */
export async function downloadMedia(item: MediaViewerItem): Promise<"saved" | "opened"> {
  const name = fileNameOf(item);
  const src = item.src;
  if (/^(data|blob):/i.test(src)) {
    clickDownload(src, name);
    return "saved";
  }
  try {
    const res = await fetch(src, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    clickDownload(url, name);
    // Not revoked straight away: the click only STARTS the download, and pulling the URL from under it can
    // abort it. A minute is far longer than the browser needs to open the stream.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "saved";
  } catch {
    window.open(src, "_blank", "noopener");
    return "opened";
  }
}
