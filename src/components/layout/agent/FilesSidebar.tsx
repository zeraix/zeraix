"use client";

import FilesTree from "./FilesTree";
import { TITLE_BAR_HEIGHT_PX } from "./titleBar";
import { TrafficLights, useTrafficLights } from "./WindowControls";

/** The rail runs to the window edge, so its top band is the full title-bar height. */
const TOP_STRIP = TITLE_BAR_HEIGHT_PX;

/** Without traffic lights to clear, the strip is only a grip for dragging the window — a hair of padding, not a band. */
const DRAG_STRIP = 8;

/**
 * Standalone "Files" sidebar: surfaces in the same spot after the main sidebar collapses, showing the file tree of the current working directory.
 * The card appearance matches the main sidebar (AgentSidebar).
 *
 * It carries no title row of its own. The title bar's Files button is the only control — it opens this panel and closes
 * it again — so a heading repeating the word and a second way to close it were both redundant.
 */
export default function FilesSidebar() {
  const lights = useTrafficLights();
  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar">
      {/* Top band. On macOS this is where the traffic lights sit and where the frameless window expects to be dragged
          from, so it has to be as tall as the title bar. Windows and Linux draw their buttons in the top right
          instead, so reserving the same band there only pushed the tree down behind a strip of nothing.

          The lights are drawn here, not merely cleared for. Opening this panel collapses the main sidebar (see
          AgentShell.openFiles), which is where they normally live — so a band reserved for them and left empty meant
          that on macOS, opening Files took the window's close, minimize and zoom buttons away with it. Positioned to
          match the main sidebar's, so they do not shift as the two panels swap. */}
      <div
        className="shrink-0 px-4 pt-4"
        style={
          {
            height: lights.show ? TOP_STRIP : DRAG_STRIP,
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
      >
        <TrafficLights />
      </div>

      {/* File tree: the whole block scrolls */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <FilesTree />
      </div>
    </aside>
  );
}
