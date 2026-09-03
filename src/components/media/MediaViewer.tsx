"use client";

/**
 * A full-window viewer for pictures, clips, sound, documents and text — what opens when someone clicks a
 * thumbnail anywhere in the app.
 *
 * Controlled: `items` / `index` / `open` come from the caller, and the viewer only reports what it wants
 * (`onClose`, `onIndexChange`). The app-wide instance is `MediaViewerHost`, fed by `useMediaViewerStore`;
 * this component knows nothing about that store.
 *
 * One stage per item, remounted whenever the item changes, so a picture's zoom or a text file's fetch never
 * leaks into its neighbour and nothing has to be reset by hand.
 */
import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/ai/attachments";
import { cn } from "@/lib/utils";
import { isShellAvailable, openPathInShell } from "@/lib/electron/shell";
import type { MediaViewerItem } from "@/store/mediaViewerStore";
import { downloadMedia, fileNameOf } from "./mediaDownload";
import { MediaStage } from "./MediaStage";

export interface MediaViewerProps {
  open: boolean;
  items: MediaViewerItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

function ToolbarButton({
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
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-white/80 transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function NavButton({ side, title, onClick }: { side: "left" | "right"; title: string; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur transition hover:bg-black/70 hover:text-white",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      <Icon className="size-6" />
    </button>
  );
}

export function MediaViewer({ open, items, index, onClose, onIndexChange }: MediaViewerProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const count = items.length;
  const item = items[index];

  /** Move `delta` items along, wrapping at both ends. */
  const step = useCallback(
    (delta: number) => {
      if (count > 1) onIndexChange((index + delta + count) % count);
    },
    [count, index, onIndexChange],
  );

  useEffect(() => {
    if (!open) return;
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // A focused player seeks with the arrows; that wins over paging, which the on-screen arrows still do.
      if (e.key !== "Escape" && e.target instanceof HTMLMediaElement) return;
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowLeft":
          step(-1);
          break;
        case "ArrowRight":
          step(1);
          break;
        default:
          return;
      }
      e.preventDefault();
      // Capture phase, and stopped here: the viewer sits above everything, and the sheet under it also
      // closes on Escape — one press must close only the viewer.
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, step]);

  const download = async () => {
    if (!item) return;
    try {
      await downloadMedia(item);
    } catch {
      toast.error(t("viewer.downloadFailed"));
    }
  };

  const openExternal = async () => {
    if (!item?.path) return;
    const res = await openPathInShell(item.path);
    if (!res.ok) toast.error(res.error || t("viewer.openFailed"));
  };

  const title = item ? item.name || fileNameOf(item) : "";
  const meta = item
    ? [
        item.bytes ? formatBytes(item.bytes) : "",
        item.mime ?? "",
        item.description && item.description !== item.name ? item.description : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <AnimatePresence>
      {open && item && (
        <motion.div
          key="media-viewer"
          ref={rootRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={t("viewer.title")}
          className="fixed inset-0 z-[70] flex flex-col bg-black/95 text-white outline-none"
          // Covers the frameless window's title bar, which is a drag region. Electron carves that region out
          // by geometry alone, so without this every button on the top row would move the window instead of
          // working — see SubAgentInspector for the full story.
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-white/10 px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={title}>
                {title}
              </p>
              {meta && <p className="truncate text-[11px] text-white/55">{meta}</p>}
            </div>
            {count > 1 && (
              <span className="shrink-0 px-2 text-xs tabular-nums text-white/70">
                {t("viewer.counter", { i: index + 1, n: count })}
              </span>
            )}
            <ToolbarButton title={t("viewer.download")} onClick={() => void download()}>
              <Download className="size-4" />
            </ToolbarButton>
            {item.path && isShellAvailable() && (
              <ToolbarButton title={t("viewer.openExternal")} onClick={() => void openExternal()}>
                <ExternalLink className="size-4" />
              </ToolbarButton>
            )}
            <ToolbarButton title={t("viewer.close")} onClick={onClose}>
              <X className="size-5" />
            </ToolbarButton>
          </div>

          <div className="relative min-h-0 flex-1">
            <MediaStage key={`${index}:${item.src}`} item={item} onBackdropClick={onClose} hotkeys />
            {count > 1 && (
              <>
                <NavButton side="left" title={t("viewer.prev")} onClick={() => step(-1)} />
                <NavButton side="right" title={t("viewer.next")} onClick={() => step(1)} />
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
