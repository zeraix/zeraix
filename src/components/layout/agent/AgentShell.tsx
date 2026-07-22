"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { PanelLeft } from "lucide-react";
import { shouldHideAgentSidebar } from "@/constants/Agent";
import AgentSidebar from "./AgentSidebar";
import FilesSidebar from "./FilesSidebar";
import FilesPanel from "@/app/agent/chat/FilesPanel";
import { ChatAgentView } from "@/app/agent/chat/page";
import WindowControls from "./WindowControls";
import LocalModelSync from "@/components/ai/LocalModelSync";
import TrayLabelSync from "@/components/ai/TrayLabelSync";
import { requestCloseFile } from "@/lib/fileViewer";

/** Sidebar outer frame width: card 260 + m-2 on each side (8 each). */
const SIDEBAR_WIDTH = 276;
const EASE = [0.4, 0, 0.2, 1] as const;

/**
 * Agent module shell: new sidebar on the left + content area on the right.
 * Applied to all `/agent` subpages by `src/app/agent/layout.tsx`.
 * `relative` hosts the Windows/Linux top-right window controls (absolutely positioned).
 */
export default function AgentShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  // Files sidebar: when open, collapse the main sidebar and surface the file tree in the same spot; when closed, restore the main sidebar.
  const [filesOpen, setFilesOpen] = useState(false);
  // Full-screen pages (e.g. settings) hide the left main sidebar; the page provides its own back entry. See AGENT_FULLSCREEN_PATHS.
  const pathname = usePathname();
  const hideSidebar = shouldHideAgentSidebar(pathname ?? "");
  // The conversation page stays mounted: shown only on /agent/chat, hidden (display:none) on other /agent routes
  // but not unmounted -- so its generation loop, message queue and "stop" control keep working across page switches.
  // See ChatAgentView / page.tsx.
  const isChatRoute = pathname === "/agent/chat";

  const openFiles = () => {
    setFilesOpen(true);
    setCollapsed(true);
  };
  const closeFiles = () => {
    setFilesOpen(false);
    setCollapsed(false);
    requestCloseFile(); // When collapsing the file-tree sidebar, also close the right-side file view/edit panel
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-surface">
      {/* Global: local model ready/stopped -> sync the chat model list (persists across pages, so leaving the model-library page doesn't lose the ready event). */}
      <LocalModelSync />
      <TrayLabelSync />
      {/* Outer layer only animates width and clips; the inner aside stays 260 wide so text isn't squeezed while collapsing */}
      {!hideSidebar && (
        <motion.div
          initial={false}
          animate={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
          transition={{ duration: 0.28, ease: EASE }}
          className="h-full shrink-0 overflow-hidden"
        >
          <AgentSidebar onToggle={() => setCollapsed(true)} onOpenFiles={openFiles} />
        </motion.div>
      )}

      {/* Files sidebar: after the main sidebar collapses, surfaces in the same spot (width animates in/out) */}
      <AnimatePresence>
        {filesOpen && !hideSidebar && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: SIDEBAR_WIDTH }}
            exit={{ width: 0 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="h-full shrink-0 overflow-hidden"
          >
            <FilesSidebar onClose={closeFiles} />
          </motion.div>
        )}
      </AnimatePresence>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top title bar: reserves height and is draggable (top-right window controls float over it), keeping content off the window's top edge */}
        <div
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          className="h-8 shrink-0 bg-surface"
        />
        {/* Content row below the top bar: page content + right-side file panel side by side. The file panel sits
            here (below the top bar) rather than outside main, so its header doesn't overlap the top-right window
            controls (which float over the top bar). */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            {/* Persistent conversation page: always mounted, shown only on the chat route; other routes render their own children while the conversation page stays hidden but keeps running. */}
            <div className={isChatRoute ? "h-full" : "hidden"}>
              <ChatAgentView />
            </div>
            {!isChatRoute && children}
          </div>
          {/* File view/edit panel: clicking a file in the sidebar file tree -> OPEN_FILE_EVENT -> this panel loads and displays it.
              Placed at the Shell level (not just the conversation page), so clicking a file on any /agent page can show its content.
              Manages its own open/close; renders as null when closed, taking no space. */}
          <FilesPanel />
        </div>
      </main>

      {/* Expand button that appears at the top-left when collapsed (not shown on full-screen pages, which have no sidebar) */}
      <AnimatePresence>
        {collapsed && !hideSidebar && !filesOpen && (
          <motion.button
            type="button"
            aria-label="Expand sidebar"
            onClick={() => setCollapsed(false)}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className="absolute left-3 top-3 z-[60] flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-foreground/70 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelLeft className="size-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Windows / Linux: top-right window controls (not rendered on macOS, which uses the sidebar traffic lights) */}
      <WindowControls />
    </div>
  );
}
