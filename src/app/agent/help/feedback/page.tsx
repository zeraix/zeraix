"use client";

/**
 * Feedback page (/agent/help/feedback): write a report once, then send it through whichever channel suits.
 *
 * There is no feedback endpoint on the backend, so nothing here posts anywhere by itself — the two channels
 * are the two places a human actually reads:
 *  - GitHub: the report becomes a prefilled issue URL. It still takes a click on "Submit new issue" over
 *    there to publish anything, which is what the note under the picker promises.
 *  - Website: zeraix.com's contact form is not ours to prefill, so the report goes to the clipboard and the
 *    site opens — the user pastes it in. Copying is the point of the button, so the toast says so.
 *
 * The report scaffolding ("System info") is deliberately English: it is read by maintainers, the same reason
 * model-facing strings are not translated. Only the UI around it is i18n'd.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bug,
  Copy,
  Github,
  Globe,
  ImagePlus,
  Info,
  Lightbulb,
  Loader2,
  MessageCircleQuestion,
  Send,
  X,
} from "lucide-react";
import { useT, useLocaleStore } from "@/lib/i18n";
import { APP_NAME, APP_VERSION, GITHUB_URL, WEBSITE_URL } from "@/constants/App";
import { updaterBridge } from "@/lib/updater";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { MAX_IMAGE_BYTES, uploadFileToOSS } from "@/lib/ai/attachments";
import { useLoginModalStore } from "@/store/loginModalStore";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { CARD, FIELD, openExternal } from "../ui";

/** Where the report is headed. */
const CHANNELS = [
  { id: "github", titleKey: "help.channelGithub", descKey: "help.channelGithubDesc", icon: Github },
  { id: "website", titleKey: "help.channelWebsite", descKey: "help.channelWebsiteDesc", icon: Globe },
] as const;
type Channel = (typeof CHANNELS)[number]["id"];

/** Feedback kinds. `prefix` tags the report so whoever triages it can sort from a list view. */
const KINDS = [
  { id: "bug", labelKey: "help.kind.bug", icon: Bug, prefix: "[Bug]" },
  { id: "idea", labelKey: "help.kind.idea", icon: Lightbulb, prefix: "[Idea]" },
  { id: "question", labelKey: "help.kind.question", icon: MessageCircleQuestion, prefix: "[Question]" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

/**
 * An attached screenshot. It is uploaded as soon as it is added, because both channels can only carry
 * text: the report links to `url`, so an image with no URL yet has nothing to contribute.
 */
type Shot = {
  id: number;
  name: string;
  /** Object URL for the local thumbnail; revoked when the shot is removed or the page unmounts. */
  previewUrl: string;
  /** OSS public URL, once the upload lands. */
  url?: string;
  uploading: boolean;
  failed?: boolean;
};

/** Longest prefilled issue URL we will hand to the browser before falling back to the clipboard. */
const MAX_PREFILL_URL = 7000;

/** Coarse OS name from the user agent — enough to triage a bug, and all the renderer can see. */
function platformName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

export default function AgentFeedbackPage() {
  const t = useT();
  const router = useRouter();
  const locale = useLocaleStore((s) => s.locale);

  const requireLogin = useLoginModalStore((s) => s.requireLogin);

  const [channel, setChannel] = useState<Channel>("github");
  const [kind, setKind] = useState<Kind>("bug");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");

  // The packaged app's authoritative version is app.getVersion(), reported by the updater bridge;
  // APP_VERSION is the build-time fallback for the browser and `next dev` (see constants/App.ts).
  const [version, setVersion] = useState(APP_VERSION);
  useEffect(() => {
    let cancelled = false;
    void updaterBridge()
      ?.getState()
      .then((s) => {
        if (!cancelled && s.currentVersion) setVersion(s.currentVersion);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Screenshots, in the order they will appear in the report.
  const [shots, setShots] = useState<Shot[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const shotIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<number | null>(null);
  // Mirrors `shots` so unmount can revoke the previews it never got to see removed.
  const shotsRef = useRef<Shot[]>([]);
  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.previewUrl)), []);

  const addImages = async (files: FileList | null) => {
    const images = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    // The presign endpoint is token-authenticated, so attaching is one of the account-bound actions
    // that prompt for sign-in rather than failing halfway through the upload.
    if (!(await requireLogin())) return;
    for (const file of images) {
      if (file.size > MAX_IMAGE_BYTES) {
        Toast.error(t("help.imageTooLarge", { name: file.name }));
        continue;
      }
      const id = ++shotIdRef.current;
      setShots((list) => [
        ...list,
        { id, name: file.name, previewUrl: URL.createObjectURL(file), uploading: true },
      ]);
      void uploadFileToOSS(file)
        .then((url) => setShots((l) => l.map((s) => (s.id === id ? { ...s, url, uploading: false } : s))))
        .catch(() => {
          setShots((l) => l.map((s) => (s.id === id ? { ...s, uploading: false, failed: true } : s)));
          Toast.error(t("help.imageFailed", { name: file.name }));
        });
    }
  };

  const removeShot = (id: number) =>
    setShots((list) => {
      const gone = list.find((s) => s.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return list.filter((s) => s.id !== id);
    });

  /** Reorder by dragging one thumbnail onto another — the report follows this order. */
  const moveShot = (from: number, to: number) =>
    setShots((list) => {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
      const next = [...list];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });

  const systemInfo = useMemo(
    () =>
      [`App: ${APP_NAME} ${version || "dev"}`, `Platform: ${platformName()}`, `Language: ${locale}`].join(
        "\n",
      ),
    [version, locale],
  );

  const prefix = KINDS.find((k) => k.id === kind)!.prefix;
  const title = `${prefix} ${summary.trim()}`;

  const body = () => {
    const parts = [details.trim() || "(no details provided)"];
    // Markdown image links, in the on-screen order. Only uploaded shots have a URL to link to.
    const links = shots.filter((s) => s.url).map((s, i) => `![${s.name || `image ${i + 1}`}](${s.url})`);
    if (links.length) parts.push(`Screenshots:\n${links.join("\n")}`);
    parts.push(`---\nSystem info:\n${systemInfo}`);
    return parts.join("\n\n");
  };
  const fullReport = () => `${title}\n\n${body()}`;

  /** Both channels need a summary — it is the only line a triager sees in a list. */
  const ready = () => {
    if (!summary.trim()) {
      Toast.error(t("help.needSummary"));
      return false;
    }
    // Sending mid-upload would drop the images from the report: they have no URL yet.
    if (shots.some((s) => s.uploading)) {
      Toast.error(t("help.imagesUploading"));
      return false;
    }
    return true;
  };

  const send = async () => {
    if (!ready()) return;
    if (channel === "github") {
      const url = `${GITHUB_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body())}`;
      // A pasted log can outgrow what a URL may carry; past the limit GitHub would silently truncate the
      // body, so hand the report over on the clipboard and open the empty form instead of losing half of it.
      if (url.length > MAX_PREFILL_URL) {
        await navigator.clipboard?.writeText(fullReport());
        Toast.info(t("help.tooLongCopied"));
        openExternal(`${GITHUB_URL}/issues/new`);
        return;
      }
      openExternal(url);
      return;
    }
    // The site's form can't be prefilled, so carry the report over on the clipboard.
    await navigator.clipboard?.writeText(fullReport());
    Toast.success(t("help.copiedForWebsite"));
    openExternal(WEBSITE_URL);
  };

  const copy = async () => {
    await navigator.clipboard?.writeText(fullReport());
    Toast.success(t("help.copied"));
  };

  return (
    <CustomScrollbar className="h-full" config={PAGE_SCROLLBAR}>
      <div className="mx-auto max-w-3xl px-8 py-10">
        {/* Header */}
        <button
          type="button"
          onClick={() => router.push("/agent/help")}
          className="mb-4 flex items-center gap-1.5 text-xs font-medium text-ink-muted transition hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          {t("help.back")}
        </button>
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-foreground">
            <Send className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{t("help.feedback")}</h1>
            <p className="mt-0.5 text-sm text-ink-subtle">{t("help.feedbackCardDesc")}</p>
          </div>
        </div>

        {/* Channel */}
        <h2 className="mb-2 mt-8 text-sm font-semibold text-ink">{t("help.channel")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {CHANNELS.map(({ id, titleKey, descKey, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setChannel(id)}
              aria-pressed={channel === id}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition",
                channel === id
                  ? "border-primary/40 bg-primary/[0.06] shadow-sm"
                  : "border-line bg-surface-muted/50 hover:bg-surface-muted",
              )}
            >
              <p
                className={cn(
                  "flex items-center gap-1.5 text-sm font-medium",
                  channel === id ? "text-primary" : "text-ink",
                )}
              >
                <Icon className="size-4" />
                {t(titleKey)}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-subtle">{t(descKey)}</p>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-subtle">
          {channel === "github" ? t("help.feedbackDesc") : t("help.noteWebsite")}
        </p>

        {/* Report. The whole card is a drop target for screenshots — dropping onto the details field is
            the natural gesture, and a strip-only target would be invisible until the first image exists. */}
        <div
          className={cn(
            CARD,
            "mt-4 px-4 py-4 transition",
            dropActive && "border-primary/50 bg-primary/[0.04]",
          )}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return; // a thumbnail being reordered, not a file
            e.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={(e) => {
            // Ignore the leave events fired while crossing the card's own children.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropActive(false);
            void addImages(e.dataTransfer.files);
          }}
        >
          {/* Kind */}
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setKind(id)}
                aria-pressed={kind === id}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                  kind === id
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-line-strong bg-surface text-ink-muted hover:bg-surface-muted",
                )}
              >
                <Icon className="size-3.5" />
                {t(labelKey)}
              </button>
            ))}
          </div>

          {/* Summary */}
          <label className="mb-1 mt-4 block text-xs font-medium text-ink">{t("help.summary")}</label>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={t("help.summaryPh")}
            className={FIELD}
          />

          {/* Details */}
          <label className="mb-1 mt-3 block text-xs font-medium text-ink">{t("help.details")}</label>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={t("help.detailsPh")}
            rows={6}
            className={cn(FIELD, "resize-y")}
          />

          {/* Screenshots */}
          <div className="mb-1 mt-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t("help.images")}</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted"
            >
              <ImagePlus className="size-3.5" />
              {t("help.addImages")}
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void addImages(e.target.files);
              e.target.value = ""; // let the same file be picked again after removing it
            }}
          />
          {shots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {shots.map((s, i) => (
                <div
                  key={s.id}
                  draggable
                  onDragStart={() => {
                    dragFrom.current = i;
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation(); // reorder, not a file drop on the card
                    moveShot(dragFrom.current ?? i, i);
                    dragFrom.current = null;
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                  }}
                  title={s.name}
                  className="group relative size-16 cursor-grab overflow-hidden rounded-lg border border-line active:cursor-grabbing"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- object URL for a local preview, nothing for the optimizer to do */}
                  <img src={s.previewUrl} alt={s.name} className="size-full object-cover" />
                  {s.uploading && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
                      <Loader2 className="size-4 animate-spin" />
                    </span>
                  )}
                  {s.failed && (
                    <span className="absolute inset-0 flex items-center justify-center bg-destructive/70 px-1 text-center text-[10px] font-semibold text-white">
                      {t("help.imageFailedBadge")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeShot(s.id)}
                    aria-label={t("help.imageRemove")}
                    title={t("help.imageRemove")}
                    className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-neutral-900/80 text-white opacity-0 transition group-hover:opacity-100"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-ink-subtle">{t("help.imagesHint")}</p>

          {/* System info: always attached — a report without a version and platform is rarely actionable.
              Shown in full so nothing is sent (or copied) that the user has not seen. */}
          <div className="mt-3 rounded-lg border border-line bg-surface/60 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <Info className="size-3.5 text-ink-muted" />
              {t("help.includeSystem")}
            </p>
            <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-subtle">{systemInfo}</p>
          </div>

          {/* Actions */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void send()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105"
            >
              {channel === "github" ? <Github className="size-3.5" /> : <Globe className="size-3.5" />}
              {channel === "github" ? t("help.openIssue") : t("help.openWebsite")}
            </button>
            <button
              onClick={() => void copy()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
            >
              <Copy className="size-3.5" />
              {t("help.copyReport")}
            </button>
          </div>
        </div>
      </div>
    </CustomScrollbar>
  );
}
