"use client";

import FilesTree from "./FilesTree";
import { TITLE_BAR_HEIGHT_PX } from "./titleBar";

/** The card is inset by 8px (m-2), so this much of it makes up the rest of the title-bar band. */
const TOP_STRIP = TITLE_BAR_HEIGHT_PX - 8;

/**
 * Standalone "Files" sidebar: surfaces in the same spot after the main sidebar collapses, showing the file tree of the current working directory.
 * The card appearance matches the main sidebar (AgentSidebar).
 *
 * It carries no title row of its own. The title bar's Files button is the only control — it opens this panel and closes
 * it again — so a heading repeating the word and a second way to close it were both redundant.
 */
export default function FilesSidebar() {
  return (
    <aside className="m-2 flex h-[calc(100%_-_16px)] w-[260px] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0px_4px_12.3px_0px_#0000000A]">
      {/* Empty top band, as tall as the window's title bar. Not decoration: this strip is where macOS puts the
          traffic lights and where the frameless window expects to be dragged from, so anything laid out in it is
          unclickable. The tree starts below it. */}
      <div
        className="shrink-0"
        style={{ height: TOP_STRIP, WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* File tree: the whole block scrolls */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <FilesTree />
      </div>
    </aside>
  );
}
