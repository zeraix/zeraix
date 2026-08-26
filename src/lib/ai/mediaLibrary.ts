/**
 * The media library — an index of every asset the agent has produced, been given, or worked with.
 *
 * ── What it is, and what it deliberately is not ──────────────────────────────────────────────────────────────
 *
 * Assets live together in one folder (`MEDIA_DIR`) with the index at its root, instead of being scattered
 * through the project root as they were. The folder stays inside the WORKING DIRECTORY, which is not an
 * arbitrary choice — it is what lets the model process its own output ("generate the frames, then stitch them
 * with ffmpeg"), because the sandbox mounts a command's cwd at /workspace and nothing else.
 *
 * What the index adds is what a folder listing cannot: origin, the prompt that produced it, which
 * conversation it belongs to, and what it is actually of.
 *
 * ── Who writes it ───────────────────────────────────────────────────────────────────────────────────────────
 *
 * The runtime writes the mapping; the model writes the meaning.
 *
 * Registration happens in code, at the moment an asset comes into existence — the same statement that saves
 * the file. That is deterministic and free, and it is the only way the mapping can be trusted: a model-owned
 * index can hallucinate an entry (the UI then renders a broken asset), forget one (a generated video that
 * exists on disk becomes unreachable), or lose the lot to compaction, and two conversations generating at
 * once would race on it. The same reasoning already removed `set_goal` / `update_plan` from this codebase and
 * keeps goal completion unreachable by any tool.
 *
 * What the model IS good at is describing and tagging, so that is what it may write (`annotate`). A wrong
 * description is cosmetic; a wrong path is not.
 */
/**
 * The library's own bridge (electron/mediaStore.mjs), not the workspace file tools.
 *
 * The media folder is the model's READ-ONLY root, so `wsWriteFile` would be refused there — correctly. The
 * app writes through its own channel, because it is the thing that creates these files and maintains the
 * index describing them; the guard exists to stop the MODEL altering originals, not the app.
 */
interface MediaBridge {
  dir(): Promise<string>;
  readIndex(): Promise<string>;
  writeIndex(json: string): Promise<boolean>;
  save(payload: { name: string; srcPath?: string; bytes?: ArrayBuffer; url?: string }): Promise<{ path: string; bytes: number }>;
  open(): Promise<{ ok: boolean; path?: string; error?: string }>;
}

const media = (): MediaBridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { mediaStore?: MediaBridge }).mediaStore ?? null);

/** Whether the library is available at all (Electron only). */
export const isMediaStoreAvailable = (): boolean => !!media();

/** Absolute path of the media folder, or "" outside Electron. */
export const mediaDir = (): Promise<string> => media()?.dir() ?? Promise.resolve("");

/**
 * A renderable source for a file in the library.
 *
 * A local path is not a source: `<img src="C:\\Users\\…">` renders nothing, which is what a broken tile in
 * the library actually was. The app serves its own UI over a custom scheme, so library files are served from
 * the same origin — no `file://`, which the renderer refuses cross-origin, and no data: URI, which would mean
 * reading a whole video into memory to show a thumbnail.
 *
 * Only files INSIDE the library are addressable this way; anything else (an attachment left in the working
 * directory) has no renderable form and returns "", so the tile falls back to its type icon rather than
 * showing a broken image.
 */
export function mediaSrcFor(absPath: string, inLibrary: boolean): string {
  if (!absPath || !inLibrary) return "";
  // The basename alone: the library is flat, and the main process resolves it against the media folder —
  // so a path traversal in the stored entry cannot reach outside it.
  const name = absPath.split(/[\\/]/).pop() ?? "";
  return name ? `${MEDIA_URL_PREFIX}${encodeURIComponent(name)}` : "";
}

/** Where the app serves library files from. Matches the handler in electron/main.mjs. */
export const MEDIA_URL_PREFIX = "app://localhost/__media/";

/**
 * The source a viewer should use for an entry.
 *
 * Prefers the library copy, because a vendor URL expires and the local file does not — a generated clip that
 * still plays a month later is the whole point of saving it.
 */
export const srcOf = (e: MediaEntry): string =>
  (e.path ? mediaSrcFor(e.path, true) : "") || e.src;

/**
 * Put a file into the library and return its absolute path, or "" when there is no store.
 *
 * The caller's own copy of `storeArtifact`'s save half, exposed because attachments follow a different route
 * to the same folder: they are already local, so there is nothing to download and no artifact to index here.
 */
export async function saveToLibrary(payload: {
  name: string;
  srcPath?: string;
  bytes?: ArrayBuffer;
  url?: string;
}): Promise<string> {
  try {
    const saved = await media()?.save(payload);
    return saved?.path ?? "";
  } catch (e) {
    console.warn("[media] could not save an attachment into the library", e);
    return "";
  }
}

/** Reveal the folder in the system file manager. */
export const openMediaFolder = (): Promise<{ ok: boolean; path?: string; error?: string }> =>
  media()?.open() ?? Promise.resolve({ ok: false, error: "not available" });

/**
 * The name the media folder is mounted at inside the sandbox (GUEST_ASSETS in sandbox/qemu.mjs, ASSET_ALIAS
 * in tools/paths.mjs — keep all three in step).
 *
 * This is what the MODEL is told, and the only name that works for it in both places: the host path differs
 * per machine and does not exist inside the guest.
 */
export const ASSET_MOUNT = "/assets";

/**
 * The name a library file answers to FOR THE MODEL, which is not always the name it has on this machine.
 *
 * The library has two names and only one of them resolves at a time: inside the sandbox it is mounted at
 * /assets and the host path exists on neither side of the boundary; natively there is no mount, so the host
 * path is the only name that works. Every place that hands the model a library path has to make this choice,
 * and each one that made it independently got it wrong — hence one function rather than three conditionals.
 */
export const modelPathFor = (hostPath: string, sandboxed: boolean): string =>
  !hostPath ? "" : sandboxed ? `${ASSET_MOUNT}/${hostPath.split(/[\\/]/).pop() ?? ""}` : hostPath;

/**
 * How many entries are kept.
 *
 * The index is one JSON file that is read and rewritten whole, so it cannot grow without bound. Oldest
 * entries are dropped first, which
 * is the right end: the bytes are still on disk, and what is lost is a search result for something the user
 * has not touched in a long time — not the asset itself. Stated as a number rather than a byte budget because
 * an entry's size is dominated by a model-written description, which nothing here can predict.
 */
export const MAX_ENTRIES = 500;

/** Broad categories, derived from the mime rather than declared — a caller cannot mislabel what it stores. */
export type MediaKind = "image" | "video" | "audio" | "document" | "other";

/** Where an asset came from. Origin decides nothing here; it is what makes the library legible to a human. */
export type MediaOrigin = "generated" | "upload" | "tool";

export interface MediaEntry {
  id: string;
  kind: MediaKind;
  mime: string;
  /** Absolute path on disk, when the asset was written there. Absent for an asset that only ever had a URL. */
  path?: string;
  /** Directly renderable: an https: or data: URL, or a file path the viewer can resolve. */
  src: string;
  bytes?: number;
  /**
   * Pixel dimensions, when they could be measured.
   *
   * Optional because measuring needs the asset to actually load — a vendor URL that has expired, a format the
   * renderer cannot decode, or a document rather than a picture all leave this absent. Absent means "not
   * known", never "zero": a tile shows the size and skips the resolution rather than claiming 0×0.
   */
  width?: number;
  height?: number;
  /** Video only, in milliseconds. Same rule: absent when it could not be read. */
  durationMs?: number;
  createdAt: number;
  origin: MediaOrigin;
  /** The conversation that produced or received it. Absent for assets registered outside a conversation. */
  convId?: string;
  /** Generation only: the prompt that produced it — usually the best description anyone will ever write. */
  prompt?: string;
  /** Uploads: the name the user's file had. */
  filename?: string;
  /** Model-written. See the header: the model owns meaning, never the mapping. */
  description?: string;
  tags?: string[];
}

/** mime → category. Unknown mimes are `other` rather than being guessed into a category that renders wrongly. */
export function kindOfMime(mime: string): MediaKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (
    m.startsWith("text/") ||
    m.includes("pdf") ||
    m.includes("word") ||
    m.includes("spreadsheet") ||
    m.includes("presentation") ||
    m.includes("json") ||
    m.includes("csv")
  ) {
    return "document";
  }
  return "other";
}

const isEntry = (v: unknown): v is MediaEntry => {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.src === "string" && typeof e.createdAt === "number";
};

/**
 * Read a stored index.
 *
 * Pure, and separate from the file read below, so the validation can be tested without a filesystem.
 *
 * A malformed entry is dropped rather than repaired: the asset it described is still on disk, so what is lost
 * is an index row, and a half-built row would render as a broken tile the user cannot act on.
 */
export function parseLibrary(raw: unknown): MediaEntry[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map((e) => ({ ...e, kind: e.kind ?? kindOfMime(e.mime ?? "") }));
  } catch {
    return [];
  }
}

/**
 * Read the index.
 *
 * A missing file is an empty library, not an error: the folder does not exist until the first asset is
 * registered, and every caller would otherwise have to special-case the first run.
 */
export async function loadLibrary(): Promise<MediaEntry[]> {
  const raw = await media()?.readIndex().catch(() => "");
  return parseLibrary(raw ?? "");
}

/** Write the index. Pretty-printed: it is a file a human — or the model — may open and read. */
export async function saveLibrary(entries: MediaEntry[]): Promise<boolean> {
  const ok = await media()?.writeIndex(JSON.stringify(entries, null, 2)).catch(() => false);
  return !!ok;
}

/**
 * Add an entry, replacing any earlier one for the same asset.
 *
 * Identity is the PATH when there is one, and the src otherwise. Re-registering the same file — the user
 * sends the same attachment twice, a generation is re-run to the same name — updates the row instead of
 * accumulating duplicates that all point at one file. Newest first, because the library is browsed from the
 * most recent thing backwards.
 *
 * Pure: the caller decides whether to persist. That is what makes the trimming and the dedupe testable.
 */
export function addEntry(entries: MediaEntry[], entry: MediaEntry): MediaEntry[] {
  const identity = (e: MediaEntry) => e.path || e.src;
  const kept = entries.filter((e) => identity(e) !== identity(entry));
  // A re-registered asset keeps whatever the model had written about it: the description describes the
  // picture, and the picture has not changed just because the row was rewritten.
  const previous = entries.find((e) => identity(e) === identity(entry));
  const merged: MediaEntry = {
    ...entry,
    description: entry.description ?? previous?.description,
    tags: entry.tags ?? previous?.tags,
  };
  return [merged, ...kept].slice(0, MAX_ENTRIES);
}

/** Attach the model's description / tags to an existing entry. Unknown id is a no-op, never an insert. */
export function annotateEntry(
  entries: MediaEntry[],
  id: string,
  patch: { description?: string; tags?: string[] },
): MediaEntry[] {
  return entries.map((e) =>
    e.id === id
      ? {
          ...e,
          description: patch.description?.trim() || e.description,
          tags: patch.tags?.length ? patch.tags.map((t) => t.trim()).filter(Boolean) : e.tags,
        }
      : e,
  );
}

export interface MediaQuery {
  kind?: MediaKind;
  convId?: string;
  /** Matched case-insensitively against the description, prompt, filename and tags. */
  text?: string;
  limit?: number;
}

/**
 * Search the index.
 *
 * Substring matching over the fields a human would search by. Deliberately not fuzzy: this answers a model's
 * "find the lighthouse video I made earlier", where a near-miss returning the wrong clip is worse than
 * returning nothing and being asked again.
 */
export function searchLibrary(entries: MediaEntry[], q: MediaQuery = {}): MediaEntry[] {
  const text = q.text?.trim().toLowerCase();
  const hit = (e: MediaEntry) =>
    !text ||
    [e.description, e.prompt, e.filename, ...(e.tags ?? [])]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(text));
  return entries
    .filter((e) => (!q.kind || e.kind === q.kind) && (!q.convId || e.convId === q.convId) && hit(e))
    .slice(0, Math.max(1, q.limit ?? 50));
}

/** Build an entry. Separate from storage so a caller can register without knowing where the index lives. */
export function makeEntry(input: {
  src: string;
  mime: string;
  origin: MediaOrigin;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  convId?: string;
  prompt?: string;
  filename?: string;
  now?: () => number;
}): MediaEntry {
  const createdAt = (input.now ?? (() => Date.now()))();
  return {
    id: `media_${createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: kindOfMime(input.mime),
    mime: input.mime,
    src: input.src,
    createdAt,
    origin: input.origin,
    ...(input.path ? { path: input.path } : {}),
    ...(input.bytes ? { bytes: input.bytes } : {}),
    // Written only when measured. A zero would render as "0×0", which reads as a broken asset rather than as
    // a detail nobody could obtain.
    ...(input.width && input.height ? { width: input.width, height: input.height } : {}),
    ...(input.durationMs ? { durationMs: input.durationMs } : {}),
    ...(input.convId ? { convId: input.convId } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
  };
}

/**
 * Serialise index writes.
 *
 * Every write is read-modify-write over one file, so two that overlap both read the same list and both write
 * it back — and the second silently erases the first. That is not a rare interleaving: sending three
 * attachments registers three assets in a loop, and a generation finishing while an upload is being indexed
 * is ordinary. Chaining them costs nothing (the writes are tiny and rare) and removes the whole class.
 *
 * The chain never rejects: a failed write must not stop every later one from being attempted.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * Register an asset. The one call sites use.
 *
 * Never throws: registration is bookkeeping that rides alongside real work, and an index write that fails
 * must not turn a successfully generated video into a failed one.
 */
export async function registerMedia(input: Parameters<typeof makeEntry>[0]): Promise<MediaEntry | null> {
  return serialise(async () => {
    try {
      const entry = makeEntry(input);
      // Re-read INSIDE the queued task, never before it: a list read before waiting for the turn is a list
      // that may already be stale by the time this write lands, which is the very race the queue exists for.
      await saveLibrary(addEntry(await loadLibrary(), entry));
      return entry;
    } catch (e) {
      console.warn("[media] could not index an asset; the file itself is unaffected", e);
      return null;
    }
  });
}

/** Model-facing annotate, by id. Returns whether anything matched. */
export async function describeMedia(
  id: string,
  patch: { description?: string; tags?: string[] },
): Promise<boolean> {
  return serialise(async () => {
    const entries = await loadLibrary();
    if (!entries.some((e) => e.id === id)) return false;
    await saveLibrary(annotateEntry(entries, id, patch));
    return true;
  });
}

/** Model-facing search. */
export async function findMedia(q: MediaQuery = {}): Promise<MediaEntry[]> {
  return searchLibrary(await loadLibrary(), q);
}


/**
 * How long to wait for an asset to report its dimensions before giving up.
 *
 * A vendor URL can be slow, expired, or served by a host that never answers. The measurement is a nicety, so
 * it must never be the reason a generated video takes longer to appear in the library than it took to make.
 */
export const PROBE_TIMEOUT_MS = 6_000;

/**
 * Measure an asset's pixel dimensions, and a video's duration.
 *
 * Done in the renderer because that is where a decoder lives: an `<img>` reports naturalWidth once it has
 * loaded, a `<video>` reports videoWidth and duration at `loadedmetadata` — which arrives after the header,
 * not after the whole file, so this costs a range request rather than a download.
 *
 * Always resolves. Every failure mode here (an expired link, an undecodable format, a document, no DOM at
 * all) means "not known", and the caller stores the asset without it.
 */
export async function probeDimensions(
  src: string,
  kind: MediaKind,
): Promise<{ width?: number; height?: number; durationMs?: number }> {
  if (typeof document === "undefined" || !src) return {};
  if (kind !== "image" && kind !== "video") return {};

  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { width?: number; height?: number; durationMs?: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done({}), PROBE_TIMEOUT_MS);

    if (kind === "image") {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = src;
      return;
    }
    const video = document.createElement("video");
    // Metadata only: the header carries the dimensions and the duration, and pulling the whole clip to learn
    // them would spend the user's bandwidth twice on every generation.
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      done({
        width: video.videoWidth,
        height: video.videoHeight,
        // Infinity for a stream, NaN when unknown — neither is a duration, so both are dropped.
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
      });
    video.onerror = () => done({});
    video.src = src;
  });
}

/**
 * Put a generated artifact into the library: write the bytes, then index them.
 *
 * One function because both paths need both halves, and a path that did only one of them is what a bug looks
 * like from the outside — a background video that existed as a vendor URL and nothing else did not appear in
 * the library at all, and would have stopped rendering entirely once the vendor's link expired.
 *
 * Written to disk BEFORE the index row, so a row never points at a file that is not there yet. Both are
 * best-effort: the user already has the artifact on screen, so a failure here is a degraded outcome rather
 * than a failed generation, and it is logged rather than thrown.
 */
export async function storeArtifact(input: {
  src: string;
  mime: string;
  origin: MediaOrigin;
  convId?: string;
  prompt?: string;
}): Promise<{ path: string | null; entry: MediaEntry | null }> {
  let path: string | null = null;
  let bytes: number | undefined;
  // Measured from the src rather than from the saved file: the renderer can decode a URL or a data: URI, and
  // it has no way to read a path off disk. Started before the save so the two overlap.
  const measured = probeDimensions(input.src, kindOfMime(input.mime));
  try {
    // Named from the prompt so a folder of assets stays readable; saveAttachment sanitises and de-duplicates
    // the name, so no timestamp is needed.
    const slug =
      (input.prompt ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .filter(Boolean)
        .slice(0, 6)
        .join("-") || "asset";
    // Video mimes are checked first: "video/mp4" contains no image extension, and a bare fallback to png
    // would name a video file .png — every later tool that reads it by extension would then misjudge it.
    const ext =
      /mp4|webm|quicktime/.exec(input.mime)?.[0].replace("quicktime", "mov") ??
      /png|jpeg|jpg|webp|gif/.exec(input.mime)?.[0].replace("jpeg", "jpg") ??
      "bin";
    const saved = await media()?.save({ name: `generated-${slug}.${ext}`, url: input.src });
    path = saved?.path ?? null;
    bytes = saved?.bytes;
  } catch (e) {
    console.warn("[media] could not write a generated artifact to the library folder", e);
  }
  const entry = await registerMedia({
    ...input,
    ...(path ? { path } : {}),
    // The vendor URL stays as `src` so a failed save still renders something; `srcOf` prefers the local copy
    // when there is one, which is what keeps a clip playable after the vendor's link expires.
    ...(bytes ? { bytes } : {}),
    ...(await measured),
  });
  return { path, entry };
}

// ── Display helpers ─────────────────────────────────────────────────────────────────────────────────────
//
// Here rather than in the page, because "what an entry says about itself" is a property of the entry. A
// second view (a picker, a tooltip in chat) must describe an asset the same way this one does.

/** `1920×1080`, or "" when the dimensions were never measured. */
export const formatResolution = (e: Pick<MediaEntry, "width" | "height">): string =>
  e.width && e.height ? `${e.width}×${e.height}` : "";

/**
 * A short size. Deliberately coarse — a library tile answers "is this big?", not "how many bytes?".
 * Returns "" for an unknown or zero size rather than "0 B", which reads as an empty file.
 */
export function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** `0:07`, `1:23`, `1:02:03`. "" when the duration is unknown. */
export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The one-line summary under a tile: resolution, duration, size — whichever are known.
 *
 * Joined rather than laid out in fixed slots, so an asset that could not be measured shows a shorter line
 * instead of a row of dashes standing in for facts nobody has.
 */
export const describeEntry = (e: MediaEntry): string =>
  [formatResolution(e), formatDuration(e.durationMs), formatSize(e.bytes)].filter(Boolean).join(" · ");
