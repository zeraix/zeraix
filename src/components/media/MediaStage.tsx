"use client";

/**
 * What the viewer puts on its stage for one item, by kind.
 *
 * Each stage owns its own state — a picture's zoom, a text file's fetch — and the viewer remounts the stage
 * for every item, so moving on resets everything without an effect that watches the index.
 *
 * A click on the empty stage (beside the media, not on it) dismisses the viewer, the way a backdrop does.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { File as FileIcon, FileText, Loader2, Music, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/ai/attachments";
import { cn } from "@/lib/utils";
import type { MediaViewerItem } from "@/store/mediaViewerStore";
import { mimeOf } from "./mediaDownload";
import { useZoomPan } from "./useZoomPan";

interface StageProps {
  item: MediaViewerItem;
  /** The empty stage was clicked. */
  onBackdropClick: () => void;
  /**
   * Take the zoom keys (+ - 0 r) from the window. Only the full-window viewer wants this: a stage shown
   * inline, beside a composer, would otherwise swallow the letters typed into it.
   */
  hotkeys?: boolean;
}

/** Something the user types into — a key pressed there is never a shortcut. */
const isEditable = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Mimes rendered as text although they do not say `text/`. */
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-yaml",
  "application/yaml",
  "application/csv",
  "application/x-ndjson",
  "application/sql",
]);
/** Extensions rendered as text when the mime says nothing useful (`other` is exactly that case). */
const TEXT_EXTS =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|ps1|sql|toml|ini|cfg|conf|log|html?|css|scss|env|gitignore)$/i;
/** Past this the stage shows the head of the file and says so: a log can run to hundreds of megabytes. */
const MAX_TEXT_CHARS = 512 * 1024;

export const isPdf = (item: MediaViewerItem): boolean =>
  mimeOf(item).includes("pdf") || /\.pdf$/i.test(item.path || item.name || "");

export const isTextLike = (item: MediaViewerItem): boolean => {
  const mime = mimeOf(item);
  if (mime.startsWith("text/") || TEXT_MIMES.has(mime)) return true;
  return (!mime || mime === "application/octet-stream") && TEXT_EXTS.test(item.path || item.name || "");
};

const onEmptyClick = (onBackdropClick: () => void) => (e: ReactMouseEvent) => {
  if (e.target === e.currentTarget) onBackdropClick();
};

function StageButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-full text-white/85 transition hover:bg-white/15 hover:text-white"
    >
      {children}
    </button>
  );
}

export function ImageStage({ item, onBackdropClick, hotkeys = false }: StageProps) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);
  const {
    state,
    dragging,
    canPan,
    zoomIn,
    zoomOut,
    reset,
    rotate,
    toggle,
    wasDrag,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = useZoomPan(stageRef);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // The zoom keys live beside the state they drive; the viewer handles the keys that outlive an item
  // (Escape, the arrows).
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      switch (e.key) {
        case "+":
        case "=":
          zoomIn();
          break;
        case "-":
        case "_":
          zoomOut();
          break;
        case "0":
          reset();
          break;
        case "r":
        case "R":
          rotate();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hotkeys, zoomIn, zoomOut, reset, rotate]);

  if (status === "error") {
    return <FallbackStage item={item} onBackdropClick={onBackdropClick} message={t("viewer.loadError")} />;
  }

  const { scale, x, y, rotation } = state;
  return (
    <div
      ref={stageRef}
      className={cn(
        "relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden",
        canPan ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
      )}
      onClick={(e) => {
        if (!wasDrag() && e.target === e.currentTarget) onBackdropClick();
      }}
      onDoubleClick={(e) => toggle(e.clientX, e.clientY)}
      // The browser makes every picture draggable and selectable; here a drag is a pan, and a drag that
      // started from a selection would still ship a ghost copy of the picture. Refused at the stage, so it
      // covers a drag that begins anywhere in it.
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {status === "loading" && (
        <Loader2 role="status" aria-label={t("viewer.loading")} className="absolute size-6 animate-spin text-white/60" />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- whatever URL the caller could render, which next/image cannot optimise */}
      <img
        src={item.src}
        alt={item.name ?? ""}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
        className={cn("max-h-full max-w-full select-none object-contain", status !== "ready" && "opacity-0")}
        style={
          {
            transform: `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: dragging ? "none" : "transform 120ms ease-out",
            WebkitUserDrag: "none",
          } as React.CSSProperties
        }
      />
      {/* Its own pointer boundary: a press on a button must not start a pan, and a double-click on one
          must not toggle the zoom. */}
      <div
        className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-1 text-white backdrop-blur"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <StageButton title={t("viewer.zoomOut")} onClick={zoomOut}>
          <ZoomOut className="size-4" />
        </StageButton>
        <button
          type="button"
          title={t("viewer.fit")}
          onClick={reset}
          className="min-w-12 rounded-full px-2 py-1 text-xs tabular-nums transition hover:bg-white/15"
        >
          {Math.round(scale * 100)}%
        </button>
        <StageButton title={t("viewer.zoomIn")} onClick={zoomIn}>
          <ZoomIn className="size-4" />
        </StageButton>
        <StageButton title={t("viewer.rotate")} onClick={rotate}>
          <RotateCw className="size-4" />
        </StageButton>
      </div>
    </div>
  );
}

export function VideoStage({ item, onBackdropClick }: StageProps) {
  const t = useT();
  return (
    <div className="flex h-full w-full items-center justify-center p-4" onClick={onEmptyClick(onBackdropClick)}>
      {/* Autoplay is right here, and nowhere else in the app: the user just clicked this clip to watch it. */}
      <video
        src={item.src}
        controls
        autoPlay
        playsInline
        className="max-h-full max-w-full rounded-lg bg-black outline-none"
      >
        {t("video.unsupported")}
      </video>
    </div>
  );
}

export function AudioStage({ item, onBackdropClick }: StageProps) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6" onClick={onEmptyClick(onBackdropClick)}>
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl bg-white/5 p-6">
        <Music className="size-10 text-white/70" />
        <p className="max-w-full truncate text-sm text-white/90">{item.name}</p>
        <audio src={item.src} controls autoPlay className="w-full" />
      </div>
    </div>
  );
}

/** Chromium's own PDF viewer — which needs the response to SAY it is a PDF; see MIME_TYPES in electron/main.mjs. */
function PdfStage({ item }: StageProps) {
  return <iframe src={item.src} title={item.name ?? "PDF"} className="h-full w-full border-0 bg-white" />;
}

function TextStage({ item, onBackdropClick }: StageProps) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(item.src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s) => {
        if (cancelled) return;
        setTruncated(s.length > MAX_TEXT_CHARS);
        setText(s.slice(0, MAX_TEXT_CHARS));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.src]);

  // A fetch the renderer is not allowed to make (a cross-origin URL without CORS) is not a broken file:
  // fall back to the plain card, whose toolbar still downloads and opens it.
  if (failed) return <FallbackStage item={item} onBackdropClick={onBackdropClick} />;

  return (
    <div className="h-full w-full overflow-auto p-4" onClick={onEmptyClick(onBackdropClick)}>
      <div className="mx-auto w-full max-w-4xl rounded-lg bg-neutral-900 p-4 text-neutral-100">
        {text === null ? (
          <Loader2 role="status" aria-label={t("viewer.loading")} className="mx-auto size-5 animate-spin text-white/60" />
        ) : (
          <>
            {truncated && (
              <p className="mb-2 text-[11px] text-white/50">
                {t("viewer.truncated", { kb: Math.round(MAX_TEXT_CHARS / 1024) })}
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{text}</pre>
          </>
        )}
      </div>
    </div>
  );
}

export function FallbackStage({
  item,
  onBackdropClick,
  message,
}: StageProps & { message?: string }) {
  const t = useT();
  const Icon = item.kind === "document" ? FileText : FileIcon;
  const facts = [item.mime ?? "", item.bytes ? formatBytes(item.bytes) : ""].filter(Boolean).join(" · ");
  return (
    <div className="flex h-full w-full items-center justify-center p-6" onClick={onEmptyClick(onBackdropClick)}>
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Icon className="size-12 text-white/60" />
        <p className="max-w-full truncate text-sm font-medium text-white/90">{item.name}</p>
        {facts && <p className="text-xs text-white/50">{facts}</p>}
        <p className="text-xs text-white/65">{message ?? t("viewer.noPreview")}</p>
      </div>
    </div>
  );
}

/** The stage for an item. Kind decides first; a document or an unknown is then told apart by what it actually is. */
export function MediaStage(props: StageProps) {
  switch (props.item.kind) {
    case "image":
      return <ImageStage {...props} />;
    case "video":
      return <VideoStage {...props} />;
    case "audio":
      return <AudioStage {...props} />;
    default:
      if (isPdf(props.item)) return <PdfStage {...props} />;
      if (isTextLike(props.item)) return <TextStage {...props} />;
      return <FallbackStage {...props} />;
  }
}
