"use client";

import { useMemo, useRef, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Conversation, Project } from "@/lib/ai/conversation";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import CustomScrollbar from "@/components/CustomScrollbar";
import { openPathInShell } from "@/lib/electron/shell";
import SidebarLeaf, { formatAge } from "./SidebarLeaf";

/**
 * The sidebar's project / chat tree: a project row expands to reveal its own chats.
 *
 * Virtualized, which is the whole reason it is its own file. A folder holding hundreds of chats used to mount every one
 * of those rows at once — each carrying its own Radix context menu — and then animate the group's height open, which
 * re-lays-out all of them once per frame. Expanding such a folder froze the window for as long as it took. Here the
 * tree is flattened to one row list and only the visible slice is mounted, so expanding costs the same whether the
 * folder holds five chats or five hundred.
 *
 * The open/close still animates, but as CSS on the handful of mounted rows rather than as a height animation over the
 * whole group: the rows below a folder slide to their new offsets, and the revealed rows fade in behind them. Both are
 * composited properties, so the cost does not grow with the size of the folder. See TreeRow.
 */

type Row =
  | { kind: "project"; key: string; project: Project }
  | { kind: "chat"; key: string; project: Project; conv: Conversation }
  /** Placeholder under an expanded but empty project. */
  | { kind: "empty"; key: string };

/** Starting guess for a row height (20px of text + py-1.5 + the 2px gap); every mounted row is then measured for real. */
const ROW_ESTIMATE = 34;

export interface SidebarTreeProps {
  projects: Project[];
  /** Chats grouped by project, already ordered most-recently-updated first. */
  conversationsByProject: Map<string, Conversation[]>;
  expandedIds: Set<string>;
  currentProjectId: string | null;
  activeConversationId: string | null;
  generating: Record<string, boolean>;
  pendingConsent: Record<string, boolean>;
  pendingQuestion: Record<string, boolean>;
  unread: Record<string, boolean>;
  /** Clock shared by every age label, ticked once a minute by the sidebar. */
  now: number;
  locale: string;
  onToggleProject: (p: Project) => void;
  onOpenConversation: (id: string, projectId: string) => void;
  /** Right-click "New chat" — takes the directory the new conversation should start in. */
  onNewChat: (workdir: string) => void;
  /** The project's actual folder on disk ("" when it has none), for "Open folder". */
  folderOf: (p: Project) => string;
  onRename: (kind: "project" | "conversation", id: string, value: string) => void;
  onDelete: (kind: "project" | "conversation", id: string, name: string) => void;
}

export default function SidebarTree({
  projects,
  conversationsByProject,
  expandedIds,
  currentProjectId,
  activeConversationId,
  generating,
  pendingConsent,
  pendingQuestion,
  unread,
  now,
  locale,
  onToggleProject,
  onOpenConversation,
  onNewChat,
  folderOf,
  onRename,
  onDelete,
}: SidebarTreeProps) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Projects and their chats as one flat list — what the virtualizer indexes into.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const p of projects) {
      out.push({ kind: "project", key: `p:${p.id}`, project: p });
      if (!expandedIds.has(p.id)) continue;
      const convs = conversationsByProject.get(p.id) ?? [];
      if (convs.length === 0) out.push({ kind: "empty", key: `e:${p.id}` });
      else for (const c of convs) out.push({ kind: "chat", key: `c:${c.id}`, project: p, conv: c });
    }
    return out;
  }, [projects, expandedIds, conversationsByProject]);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_ESTIMATE,
    // Enough off-screen rows that a flick of the wheel does not reach blank space before the next render lands.
    overscan: 10,
    // Key by row identity, not index: expanding a folder shifts everything below it, and index keys would remount
    // (and re-measure) rows that never actually changed.
    getItemKey: (i) => rows[i].key,
  });

  if (projects.length === 0) {
    return <p className="mt-2 px-2 py-1 text-xs text-muted-foreground">{t("sidebar.autoCreated")}</p>;
  }

  return (
    <CustomScrollbar className="mt-2 min-h-0 flex-1" viewportRef={viewportRef} viewportClassName="pr-0.5">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <TreeRow
              key={item.key}
              index={item.index}
              start={item.start}
              measureRef={virtualizer.measureElement}
              // A row scrolled into view must not fade — only one revealed by a folder opening (or by the tree first
              // appearing) should. `isScrolling` is the difference between the two.
              fadeIn={!virtualizer.isScrolling}
            >
              {row.kind === "empty" ? (
                <p className="px-8 py-1 text-xs text-muted-foreground">{t("sidebar.noConversations")}</p>
              ) : row.kind === "project" ? (
                <ProjectRow
                  project={row.project}
                  expanded={expandedIds.has(row.project.id)}
                  active={row.project.id === currentProjectId}
                  convs={conversationsByProject.get(row.project.id) ?? []}
                  generating={generating}
                  pendingConsent={pendingConsent}
                  pendingQuestion={pendingQuestion}
                  unread={unread}
                  onToggle={onToggleProject}
                  onNewChat={onNewChat}
                  folderOf={folderOf}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              ) : (
                <SidebarLeaf
                  label={row.conv.title || t("conversation.untitled")}
                  active={row.conv.id === activeConversationId}
                  meta={formatAge(row.conv.updatedAt, now, locale)}
                  generating={!!generating[row.conv.id]}
                  pendingConsent={!!pendingConsent[row.conv.id]}
                  pendingQuestion={!!pendingQuestion[row.conv.id]}
                  unread={!!unread[row.conv.id]}
                  onClick={() => onOpenConversation(row.conv.id, row.conv.projectId)}
                  onNewChat={() => onNewChat(row.project.workdir)}
                  onOpenFolder={(() => {
                    // A conversation prefers its own actual directory (under the default project each conversation has
                    // its own real directory); if missing, fall back to the project directory.
                    const dir = row.conv.workdir || row.project.workdir;
                    return dir ? () => void openPathInShell(dir) : undefined;
                  })()}
                  onRename={() => onRename("conversation", row.conv.id, row.conv.title || "")}
                  onDelete={() =>
                    onDelete("conversation", row.conv.id, row.conv.title || t("conversation.untitled"))
                  }
                />
              )}
            </TreeRow>
          );
        })}
      </div>
    </CustomScrollbar>
  );
}

/**
 * Positioned wrapper for one virtual row, and where the tree's open/close animation lives.
 *
 * `transition-transform` covers the movement: when a folder opens or closes, every row below it gets a new offset and
 * slides to it. A row's offset changes only when the shape of the tree changes — scrolling moves the scroll container,
 * not the rows — so this never fires while scrolling.
 *
 * The fade covers the arrival, and whether to play it is decided once, at mount, then frozen. It cannot be read live
 * from `isScrolling`: that flips on every scroll, and a className that comes and goes would cancel the fade halfway
 * through on one render and restart it on every row at once on the next.
 */
function TreeRow({
  index,
  start,
  measureRef,
  fadeIn,
  children,
}: {
  index: number;
  start: number;
  measureRef: (node: HTMLDivElement | null) => void;
  fadeIn: boolean;
  children: React.ReactNode;
}) {
  const [fade] = useState(fadeIn);
  return (
    <div
      data-index={index}
      ref={measureRef}
      className={cn(
        "absolute left-0 top-0 w-full pb-0.5 transition-transform duration-200 ease-out motion-reduce:transition-none",
        fade && "animate-sidebar-row-in"
      )}
      style={{ transform: `translateY(${start}px)` }}
    >
      {children}
    </div>
  );
}

/**
 * A project row. Split out so the rollup badges are computed for the handful of project rows on screen rather than for
 * every project in the tree on every render.
 */
function ProjectRow({
  project,
  expanded,
  active,
  convs,
  generating,
  pendingConsent,
  pendingQuestion,
  unread,
  onToggle,
  onNewChat,
  folderOf,
  onRename,
  onDelete,
}: {
  project: Project;
  expanded: boolean;
  active: boolean;
  convs: Conversation[];
  generating: Record<string, boolean>;
  pendingConsent: Record<string, boolean>;
  pendingQuestion: Record<string, boolean>;
  unread: Record<string, boolean>;
  onToggle: (p: Project) => void;
  onNewChat: (workdir: string) => void;
  folderOf: (p: Project) => string;
  onRename: (kind: "project" | "conversation", id: string, value: string) => void;
  onDelete: (kind: "project" | "conversation", id: string, name: string) => void;
}) {
  // Rolled up onto a collapsed project row: without this, a chat needing attention inside a folded project would show
  // no signal at all. An expanded project shows nothing of its own — its chats carry their own badges.
  const rollup = expanded
    ? { generating: false, consent: false, question: false, unread: false }
    : {
        generating: convs.some((c) => generating[c.id]),
        consent: convs.some((c) => pendingConsent[c.id]),
        question: convs.some((c) => pendingQuestion[c.id]),
        unread: convs.some((c) => unread[c.id]),
      };
  const dir = folderOf(project);
  return (
    <SidebarLeaf
      label={project.name}
      active={active}
      icon={expanded ? <FolderOpen className="size-[15px]" /> : <Folder className="size-[15px]" />}
      generating={rollup.generating}
      pendingConsent={rollup.consent}
      pendingQuestion={rollup.question}
      unread={rollup.unread}
      expanded={expanded}
      onClick={() => onToggle(project)}
      onNewChat={() => onNewChat(project.workdir)}
      onOpenFolder={dir ? () => void openPathInShell(dir) : undefined}
      onRename={() => onRename("project", project.id, project.name)}
      onDelete={() => onDelete("project", project.id, project.name)}
    />
  );
}
