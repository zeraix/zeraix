"use client";

/**
 * Library (/agent/library) — every asset the agent has produced or been given.
 *
 * Reads `index.json` at the root of the media folder and renders from it. Nothing here scans the filesystem:
 * the index is the map, and if a row is missing so is the tile. That is deliberate — a view that fell back to
 * a directory listing would quietly disagree with the index whenever one of them was wrong, and neither would
 * be obviously at fault.
 *
 * ── The two things a library has to get right ───────────────────────────────────────────────────────────────
 *
 * **Provenance.** An asset the AI generated and one the user supplied are different things, and confusing them
 * is worse than showing neither: a generated image presented as the user's own is a claim about where it came
 * from. Origin is therefore a filter AND a badge on every tile, never inferred from the file type.
 *
 * **Work in progress.** A video takes minutes, so for most of its life it exists only as a running job. If the
 * library showed only finished files, the thing the user just asked for would be missing from the place they
 * were sent to look for it. In-flight jobs are listed first, with elapsed time.
 */
import { useCallback, useEffect, useState } from "react";
import { Image as ImageIcon, Film, FileText, Music, File as FileIcon, Loader2, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  describeEntry,
  srcOf,
  isMediaStoreAvailable,
  loadLibrary,
  openMediaFolder,
  type MediaEntry,
  type MediaKind,
  type MediaOrigin,
} from "@/lib/ai/mediaLibrary";
import { allJobs, onGenerationJobEvent, type GenerationJob } from "@/lib/ai/generation/jobs";

/** How often the elapsed time on an in-flight tile is refreshed. Seconds are enough for a minutes-long job. */
const TICK_MS = 1000;

const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  document: FileText,
  other: FileIcon,
};

type OriginFilter = "all" | MediaOrigin;
type KindFilter = "all" | MediaKind;

/**
 * A row of pill filters.
 *
 * Module scope, not inside the page: a component declared during render is a new type each time, so React
 * remounts its subtree on every render — which for a row sitting beside a search box means it is rebuilt on
 * every keystroke.
 */
function FilterRow<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            value === o.id
              ? "border-primary/40 bg-primary/10 font-medium text-primary"
              : "border-line text-ink-muted hover:bg-surface-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function LibraryPage() {
  const t = useT();
  const [entries, setEntries] = useState<MediaEntry[]>([]);
  // Read during state initialisation rather than in an effect: `allJobs` is a synchronous read of a module
  // map, and setting it from an effect body is a cascading render for a value that was available all along.
  const [jobs, setJobs] = useState<GenerationJob[]>(() => allJobs());
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  // Electron only. Hidden rather than disabled in the browser: a button that can never work is worse than no
  // button, and there is nothing to explain to a user who has no file manager to open.
  const canOpenFolder = isMediaStoreAvailable();

  const readIndex = useCallback(() => {
    void loadLibrary().then((list) => {
      setEntries(list);
      setLoading(false);
    });
  }, []);

  useEffect(() => readIndex(), [readIndex]);

  // A job finishing rewrites index.json, so the library is re-read rather than patched in place — the file is
  // the source of truth, and reconstructing a row here would be a second implementation of the mapping.
  // Called from a subscription rather than an effect body, so the state update is not a cascading render.
  useEffect(
    () =>
      onGenerationJobEvent(() => {
        readIndex();
        setJobs(allJobs());
      }),
    [readIndex],
  );

  // Only ticks while something is actually running: a timer left going behind an idle library would re-render
  // the whole grid once a second for nothing.
  useEffect(() => {
    if (jobs.length === 0) return;
    const id = setInterval(() => {
      setNow(Date.now());
      setJobs(allJobs());
    }, TICK_MS);
    return () => clearInterval(id);
  }, [jobs.length]);

  /**
   * Reveal the library folder in the system file manager.
   *
   * The path is the store's to know, not this page's: it follows the data storage location (Settings →
   * General), which the user can move while this page is open. Asking at click time means the button always
   * opens the folder the library is actually reading from.
   */
  const openFolder = async () => {
    const res = await openMediaFolder();
    // The store creates the folder before revealing it, so an empty library opens an empty folder rather
    // than failing — a failure here is a real one and says so.
    if (!res.ok) toast.message(res.error ?? t("library.openFolderUnavailable"));
  };

  const text = query.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      (origin === "all" || e.origin === origin) &&
      (kind === "all" || e.kind === kind) &&
      (!text ||
        [e.description, e.prompt, e.filename, ...(e.tags ?? [])]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(text))),
  );
  // In-flight jobs are generations, so they belong to the generated side and disappear under "uploaded".
  const showJobs = origin !== "upload" && (kind === "all" || kind === "video" || kind === "image");

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-xl font-bold text-ink">{t("library.title")}</h2>
          <p className="text-sm text-ink-subtle">{t("library.subtitle")}</p>
        </div>
        {canOpenFolder && (
          <button
            type="button"
            onClick={() => void openFolder()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <FolderOpen className="size-3.5" />
            {t("library.openFolder")}
          </button>
        )}
      </div>

      <div className="mb-4 space-y-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("library.search")}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary/50"
        />
        <FilterRow
          value={origin}
          onChange={setOrigin}
          options={[
            { id: "all", label: t("library.originAll") },
            { id: "generated", label: t("library.originGenerated") },
            { id: "upload", label: t("library.originUpload") },
          ]}
        />
        <FilterRow
          value={kind}
          onChange={setKind}
          options={[
            { id: "all", label: t("library.kindAll") },
            { id: "image", label: t("library.kindImage") },
            { id: "video", label: t("library.kindVideo") },
            { id: "document", label: t("library.kindDocument") },
          ]}
        />
      </div>

      {loading ? (
        <p className="py-16 text-center text-sm text-ink-subtle">{t("library.loading")}</p>
      ) : shown.length === 0 && !(showJobs && jobs.length > 0) ? (
        <div className="py-16 text-center">
          <FolderOpen className="mx-auto mb-3 size-8 text-ink-subtle" />
          <p className="text-sm text-ink-muted">{t("library.empty")}</p>
          <p className="mt-1 text-xs text-ink-subtle">{t("library.emptyHint")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {/* Running jobs first: for most of its life a video IS a running job, and the library is where the
              user was sent to find the thing they just asked for. */}
          {showJobs &&
            jobs.map((j) => (
              <div
                key={j.id}
                className="flex flex-col overflow-hidden rounded-xl border border-dashed border-line bg-surface-muted/40"
              >
                <div className="flex aspect-square items-center justify-center">
                  <Loader2 className="size-6 animate-spin text-ink-subtle" />
                </div>
                <div className="border-t border-line/60 px-2.5 py-2">
                  <p className="truncate text-xs font-medium text-ink">{j.prompt}</p>
                  <p className="mt-0.5 text-[11px] text-ink-subtle">
                    {t("library.working", { seconds: String(Math.max(0, Math.round((now - j.startedAt) / 1000))) })}
                  </p>
                </div>
              </div>
            ))}

          {shown.map((e) => {
            const Icon = KIND_ICON[e.kind] ?? FileIcon;
            return (
              <div key={e.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
                <div className="flex aspect-square shrink-0 items-center justify-center bg-surface-muted/50">
                  {e.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a vendor URL or a local path; next/image can optimise neither
                    <img src={srcOf(e)} alt={e.description ?? e.prompt ?? ""} className="size-full object-cover" loading="lazy" />
                  ) : e.kind === "video" ? (
                    // No autoplay and no preload: a grid that fetched every clip would spend the user's
                    // bandwidth on videos they are scrolling past.
                    <video src={srcOf(e)} controls preload="none" className="size-full object-cover" />
                  ) : (
                    <Icon className="size-7 text-ink-subtle" />
                  )}
                </div>
                <div className="space-y-1 border-t border-line/60 px-2.5 py-2">
                  {/* The full text on hover: a prompt is usually a sentence, and the tile has one line. */}
                  <p
                    className="truncate text-xs font-medium text-ink"
                    title={e.description || e.prompt || e.filename || ""}
                  >
                    {e.description || e.prompt || e.filename || t("library.untitled")}
                  </p>

                  {/* Resolution · duration · size — whichever were measured. Absent facts are simply not
                      shown, rather than standing in as zeros. */}
                  {describeEntry(e) && (
                    <p className="truncate text-[10px] tabular-nums text-ink-muted">{describeEntry(e)}</p>
                  )}

                  <div className="flex items-center gap-1.5">
                    {/* Provenance is a badge, not an inference: presenting a generated image as the user's
                        own would be a claim about where it came from. */}
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                        e.origin === "generated"
                          ? "bg-primary/10 text-primary"
                          : "bg-surface-muted text-ink-muted",
                      )}
                    >
                      {t(e.origin === "generated" ? "library.badgeGenerated" : "library.badgeUpload")}
                    </span>
                    <span className="truncate text-[10px] text-ink-subtle" title={e.mime}>
                      {e.mime}
                    </span>
                  </div>

                  {/* The path is what makes an asset findable outside the app, so it is shown rather than
                      hidden behind the folder button — truncated from the LEFT, because the filename is the
                      part that identifies it and a long directory would push it out of view. */}
                  {e.path && (
                    <p className="truncate text-[10px] text-ink-subtle" dir="rtl" title={e.path}>
                      {e.path}
                    </p>
                  )}

                  <p className="text-[10px] text-ink-subtle" title={new Date(e.createdAt).toLocaleString()}>
                    {new Date(e.createdAt).toLocaleDateString()}
                  </p>

                  {e.tags && e.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {e.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-ink-muted">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
