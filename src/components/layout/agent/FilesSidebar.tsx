"use client";

import { ChevronLeft } from "lucide-react";
import { useT } from "@/lib/i18n";
import FilesTree from "./FilesTree";

/**
 * Standalone "Files" sidebar: surfaces in the same spot after the main sidebar collapses, showing the file tree of the current working directory.
 * The top back button collapses this sidebar and restores the main sidebar (open/close state coordinated by AgentShell).
 * The card appearance matches the main sidebar (AgentSidebar).
 */
export default function FilesSidebar({ onClose }: { onClose?: () => void }) {
  const t = useT();
  return (
    <aside className="m-2 flex h-[calc(100%_-_16px)] w-[260px] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0px_4px_12.3px_0px_#0000000A]">
      {/* Top: back + title (the whole block is a frameless-window drag region; interactive elements are no-drag) */}
      <div
        className="flex items-center gap-1.5 px-3 pt-4 pb-3"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <button
          type="button"
          aria-label={t("files.close")}
          title={t("files.close")}
          onClick={onClose}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:hover:bg-white/[0.04]"
        >
          <ChevronLeft className="size-[18px]" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {t("files.section")}
        </span>
      </div>

      {/* File tree: the whole block scrolls */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <FilesTree />
      </div>
    </aside>
  );
}
