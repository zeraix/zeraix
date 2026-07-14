"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  PanelLeftClose,
  Pin,
  MessageSquarePlus,
  PencilLine,
  Trash2,
  FolderOpen,
  FolderTree,
  Settings,
  CircleHelp,
  Coins,
  Power,
  Languages,
  SunMoon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getStorage, removeStorage, setStorage } from "@zzcpt/zztool";
import { useAuthStore } from "@/store/authStore";
import { useLoginModalStore } from "@/store/loginModalStore";
import { clearAuthCookie } from "@/lib/actions/auth.actions";
import { useAgentChatStore } from "@/store/agentChatStore";
import { clearAgentWorkdir, putStorage } from "@/lib/ai/agentStorage";
import { useLocaleStore, useT, LOCALES } from "@/lib/i18n";
import {
  AGENT_MODE_KEY,
  AGENT_MODE_SELECTION_KEY,
  AGENT_STORAGE_ROOT,
  AGENT_WORKDIR_KEY,
  MODE_CHANGE_EVENT,
  WORKDIR_SET_EVENT,
  type AgentMode,
} from "@/constants/Agent";
import { cn } from "@/lib/utils";
import { formatWallet, isCnEdition } from "@/lib/edition";
import { openPathInShell } from "@/lib/electron/shell";
import { isToolkitAvailable, setWorkingDir } from "@/lib/ai/toolkit";
import { Spinner } from "@/components/ui/spinner";
import AgentModeTab from "./AgentModeTab";
import {
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  setNativeWindowButtons,
  isWindowControlsAvailable,
  isWindowAlwaysOnTop,
  toggleWindowAlwaysOnTop,
  onWindowAlwaysOnTopChange,
} from "@/lib/electron/windowControls";
import STORAGE_KEY from "@/constants/Storage";

/**
 * New Agent sidebar (independent of the legacy `sidebar.tsx`).
 * Fixed width 260px: window control dots + brand + main nav + project/conversation groups + bottom user.
 */

interface NavItem {
  id: string;
  /** i18n text key. */
  labelKey: string;
  /** Default (unselected) icon, SVG path under public/image/agent/sidebar. */
  icon: string;
  /** Selected-state icon (xxxx1.svg). */
  activeIcon: string;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "new-chat", labelKey: "nav.newChat", icon: "/image/agent/sidebar/sidebar1.svg", activeIcon: "/image/agent/sidebar/sidebar11.svg", href: "/agent" },
  { id: "skills", labelKey: "nav.skills", icon: "/image/agent/sidebar/sidebar2.svg", activeIcon: "/image/agent/sidebar/sidebar21.svg", href: "/agent/skills" },
  { id: "automation", labelKey: "nav.automation", icon: "/image/agent/sidebar/sidebar3.svg", activeIcon: "/image/agent/sidebar/sidebar31.svg", href: "/agent/automation" },
  { id: "models", labelKey: "nav.models", icon: "/image/agent/sidebar/sidebar4.svg", activeIcon: "/image/agent/sidebar/sidebar41.svg", href: "/agent/models" },
];

/** Theme modes (consistent with src/components/theme: light / dark / follow system). */
const THEME_MODES = [
  { key: "light", labelKey: "theme.light" },
  { key: "dark", labelKey: "theme.dark" },
  { key: "system", labelKey: "theme.system" },
] as const;

/** The "last selected" project / conversation remembered per mode (used to restore when switching modes, persisted in localStorage across restarts). */
type ModeSelection = { projectId: string | null; conversationId: string | null };
const readModeSelections = (): Partial<Record<AgentMode, ModeSelection>> => {
  const v = getStorage(AGENT_MODE_SELECTION_KEY);
  return v && typeof v === "object" ? (v as Partial<Record<AgentMode, ModeSelection>>) : {};
};
const saveModeSelection = (mode: AgentMode, sel: ModeSelection) => {
  // Object value: use setStorage directly (putStorage only accepts strings), consistent with agent.skills / agent.llm.models.
  setStorage(AGENT_MODE_SELECTION_KEY, { ...readModeSelections(), [mode]: sel });
};

const EASE = [0.4, 0, 0.2, 1] as const;

/** Nav entrance: the container staggers items, each child fades in and slides slightly from the left. */
const NAV_LIST_VARIANTS = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};
const NAV_ITEM_VARIANTS = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.25, ease: EASE } },
};

/**
 * macOS-style window controls (red = close / yellow = minimize / green = zoom).
 * In Electron they are clickable and drive the real window (the native traffic lights are hidden in the main process);
 * in the browser / Web they degrade to pure decoration and show no symbols on hover.
 */
function TrafficLights() {
  const [state, setState] = useState({ electron: false, mac: false });

  // Detect the platform on the client only, to avoid hydration mismatches.
  useEffect(() => {
    void (async () => {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setState({ electron: ua.includes("Electron"), mac: ua.includes("Macintosh") });
    })();
  }, []);

  // On Windows/Linux, Electron uses the top-right window controls (see WindowControls), so we don't render the traffic lights here.
  if (state.electron && !state.mac) return null;

  // Only under macOS Electron are they clickable to control the window; in the browser they are pure decoration.
  const active = state.electron && state.mac;

  const buttons = [
    { color: "#ff5f57", label: "Close", glyph: "✕", onClick: closeWindow },
    { color: "#febc2e", label: "Minimize", glyph: "−", onClick: minimizeWindow },
    { color: "#28c840", label: "Zoom", glyph: "+", onClick: () => void toggleMaximizeWindow() },
  ];

  return (
    <div className="group/lights flex items-center gap-2">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          title={b.label}
          tabIndex={active ? 0 : -1}
          onClick={active ? b.onClick : undefined}
          style={{ backgroundColor: b.color, WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className={cn(
            "flex size-3 items-center justify-center rounded-full",
            active ? "cursor-pointer" : "pointer-events-none"
          )}
        >
          <span className="text-[8px] font-bold leading-none text-black/55 opacity-0 transition-opacity group-hover/lights:opacity-100">
            {active ? b.glyph : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Collapsible section (projects / conversations). */
function CollapsibleSection({
  title,
  children,
  className,
  scroll = false,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  /** Scroll within this section when content exceeds the available height (used for the conversation list, to avoid overflowing the sidebar and being unable to scroll). */
  scroll?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    // When scroll is set, this section acts as a shrinkable flex column: the title stays fixed and the list scrolls in the remaining space.
    <div className={cn(className, scroll && "flex min-h-0 flex-col")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex shrink-0 items-center gap-1 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span>{title}</span>
        <ChevronDown
          className={cn("size-3 transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open && (
        <div
          className={cn(
            "mt-2 space-y-0.5",
            scroll && "min-h-0 flex-1 overflow-y-auto pr-0.5",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default function AgentSidebar({
  onToggle,
  onOpenFiles,
}: {
  onToggle?: () => void;
  /** Open the "Files" sidebar: collapse the main sidebar and reveal a separate file-list sidebar (coordinated by AgentShell). */
  onOpenFiles?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { userInfo, isLoggedIn, logOut } = useAuthStore();
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const t = useT();

  // Guests can use the whole app; the account row falls back to a "sign in" label.
  const name = isLoggedIn ? userInfo?.username || userInfo?.name || "Username" : t("auth.signIn");
  const avatar = (isLoggedIn && userInfo?.avatar) || "";
  // Wallet display: switches by build edition — the domestic edition shows credits (balance x1000), the international edition shows US dollars ($). Missing values show as 0.
  const walletText = formatWallet(userInfo?.walletBalance);

  // Project / conversation records (persisted to a JSON file, see agentChatStore).
  const projects = useAgentChatStore((s) => s.projects);
  const conversations = useAgentChatStore((s) => s.conversations);
  const activeProjectId = useAgentChatStore((s) => s.activeProjectId);
  const activeConversationId = useAgentChatStore((s) => s.activeConversationId);
  const generating = useAgentChatStore((s) => s.generating);
  const initStore = useAgentChatStore((s) => s.init);
  const setActiveProject = useAgentChatStore((s) => s.setActiveProject);
  const setActiveConversation = useAgentChatStore((s) => s.setActiveConversation);
  const ensureProjectLoaded = useAgentChatStore((s) => s.ensureProjectLoaded);
  const renameConversation = useAgentChatStore((s) => s.renameConversation);
  const deleteConversation = useAgentChatStore((s) => s.deleteConversation);
  const renameProject = useAgentChatStore((s) => s.renameProject);
  const deleteProjectDeep = useAgentChatStore((s) => s.deleteProjectDeep);
  // Rename dialog (shared by projects / conversations; Electron blocks window.prompt, so we use a dialog input).
  const [renameState, setRenameState] = useState<{
    kind: "project" | "conversation";
    id: string;
    value: string;
  } | null>(null);
  const submitRename = () => {
    if (!renameState) return;
    const v = renameState.value.trim();
    if (v) {
      if (renameState.kind === "project") renameProject(renameState.id, v);
      else renameConversation(renameState.id, v);
    }
    setRenameState(null);
  };
  // Delete confirmation dialog (shared by projects / conversations): use a controlled Dialog instead of window.confirm. The native dialog blocks synchronously inside the
  // context menu's (Radix modal layer) onSelect; after confirming, the deleted row and its menu are removed from the tree directly, so Radix's cleanup that resets <body>
  // pointer events is skipped -> the whole page gets stuck at pointer-events:none and becomes unclickable. A controlled Dialog opens/closes via state and unmounts cleanly, avoiding this issue.
  const [deleteState, setDeleteState] = useState<{
    kind: "project" | "conversation";
    id: string;
    name: string;
  } | null>(null);
  const confirmDelete = () => {
    if (!deleteState) return;
    if (deleteState.kind === "project") void deleteProjectDeep(deleteState.id);
    else deleteConversation(deleteState.id);
    setDeleteState(null);
  };
  // Theme (light / dark / system): using next-themes; show the label only after mounted, to avoid hydration mismatches.
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Dark mode uses the "sidebarD*" icon variants (sidebar1.svg -> sidebarD1.svg); before mounting, treat as light to avoid hydration mismatches.
  const isDark = mounted && resolvedTheme === "dark";
  const iconFor = (p: string) => (isDark ? p.replace(/sidebar(\d+\.svg)$/, "sidebarD$1") : p);
  useEffect(() => setMounted(true), []);
  // i18n: UI language (the translation function t is already declared at the top of the component).
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const themeLabel = mounted ? t(THEME_MODES.find((m) => m.key === theme)?.labelKey ?? "theme.system") : "";

  // Load records on first mount.
  useEffect(() => {
    void initStore();
  }, [initStore]);

  // Current mode (daily / dev): synced with the sidebar's AgentModeTab (custom event + cross-tab storage).
  const [mode, setMode] = useState<AgentMode>("daily");
  // Mirror of the applied mode: used in event handlers to determine "whether a real switch occurred" (the backfill on mount doesn't count as a switch).
  const modeRef = useRef<AgentMode>("daily");
  // "Skip default selection for this mode change": right-click "New chat in project" switches mode but wants to start a new conversation, and shouldn't be interrupted by the default selection.
  const skipRestoreRef = useRef(false);
  // Mirror of the current route (so event handlers can read the latest value, avoiding stale closures): only auto-navigate to the selected conversation on conversation-related routes.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    // Backfill on mount: only sync the mode mirror and state, don't trigger the default selection (to avoid overriding a conversation reached directly via URL).
    const read = () => {
      const v = getStorage(AGENT_MODE_KEY);
      if (v === "daily" || v === "dev") {
        modeRef.current = v;
        setMode(v);
      }
    };
    read();
    const onCustom = (e: Event) => {
      const v = (e as CustomEvent).detail;
      if (v !== "daily" && v !== "dev") return;
      const changed = v !== modeRef.current;
      modeRef.current = v;
      setMode(v);
      const skip = skipRestoreRef.current;
      skipRestoreRef.current = false;
      // After switching modes, no longer auto-load that mode's conversation (the last remembered one / the first project's); instead return to the "New chat" home page,
      // letting the user start fresh in the target mode. skip = right-click "New chat in project", which already navigates home itself, so don't navigate again.
      if (changed && !skip) {
        useAgentChatStore.getState().setActiveConversation(null); // clear the conversation highlight
        const path = pathnameRef.current;
        if (path === "/agent" || path.startsWith("/agent/chat")) router.push("/agent");
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === AGENT_STORAGE_ROOT) read();
    };
    window.addEventListener(MODE_CHANGE_EVENT, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MODE_CHANGE_EVENT, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, [router]);

  // Project = folder + mode: filter by the current mode; history of different modes is mutually independent.
  const projectsInMode = projects.filter((p) => p.mode === mode);
  const currentProjectId =
    activeProjectId && projectsInMode.some((p) => p.id === activeProjectId)
      ? activeProjectId
      : (projectsInMode[0]?.id ?? null);
  // Lazy-load the current project's conversations.
  useEffect(() => {
    if (currentProjectId) void ensureProjectLoaded(currentProjectId);
  }, [currentProjectId, ensureProjectLoaded]);
  const projectConversations = conversations
    .filter((c) => c.projectId === currentProjectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const openConversation = (id: string, projectId: string) => {
    setActiveConversation(id);
    saveModeSelection(mode, { projectId, conversationId: id }); // remember the current mode's selection, to restore after switching modes
    router.push(`/agent/chat?c=${id}&p=${projectId}`);
  };

  // The project's actual folder: an explicit project = its workdir; the "default project" (daily mode with no folder selected, projectWorkdir empty,
  // so project.workdir="") has no directory of its own — its real directory lives on each conversation (conv.workdir); take the most recent conversation that has a directory.
  const projectFolder = (p: { id: string; workdir?: string }) =>
    p.workdir ||
    conversations.find((c) => c.projectId === p.id && c.workdir)?.workdir ||
    "";

  // Click a project: set it as the current project and set that project's directory as the working directory (persist + broadcast, so the conversation page updates immediately).
  // When the project directory is empty (e.g. a daily-mode project), clear the selected directory.
  const selectProject = (p: { id: string; workdir?: string }) => {
    setActiveProject(p.id);
    // Remember the project selected in the current mode; when switching projects, clear its conversation memory, so on restore it defaults back to the project's first conversation.
    const prev = readModeSelections()[mode];
    saveModeSelection(mode, {
      projectId: p.id,
      conversationId: prev?.projectId === p.id ? prev.conversationId : null,
    });
    if (p.workdir) {
      putStorage(AGENT_WORKDIR_KEY, p.workdir);
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: p.workdir }));
    } else {
      clearAgentWorkdir();
    }
  };

  // Click "Files": before opening, always land the "target project" directory as the main-process working directory, so the file tree shows that project's contents.
  //  - Target project = the active project (if it belongs to the current mode); otherwise fall back to the first project of the current mode (e.g. right after switching modes).
  // Why it must be landed explicitly here: the file tree reads the main-process cwd, but clicking a project's selectProject only dispatches
  // WORKDIR_SET_EVENT (which only the conversation page listens to and calls setWorkingDir); on other pages the cwd isn't updated, causing
  // "clicked a project then clicked Files, but the file tree didn't switch over". Here we call setWorkingDir directly and await it before opening,
  // ensuring that when the file tree mounts, the cwd already points at the target project — regardless of the current page.
  const handleOpenFiles = async () => {
    const target =
      (activeProjectId ? projectsInMode.find((p) => p.id === activeProjectId) : undefined) ??
      projectsInMode[0] ??
      null;
    if (target) {
      if (target.id !== activeProjectId) setActiveProject(target.id);
      const dir = projectFolder(target);
      if (dir) {
        putStorage(AGENT_WORKDIR_KEY, dir);
        window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: dir }));
        if (isToolkitAvailable()) await setWorkingDir(dir).catch(() => {});
      } else {
        clearAgentWorkdir();
      }
    }
    onOpenFiles?.();
  };

  // Right-click "New chat": take that project's path and mode, and start a new conversation belonging to that project.
  // Follow the existing "New chat" flow — preset the working directory + mode, clear the current conversation, and return to the home page to start;
  // when the first message is sent, createConversation groups it into that project by "path + mode".
  const newChatInProject = (projectWorkdir: string, projectMode: AgentMode) => {
    if (projectWorkdir) {
      putStorage(AGENT_WORKDIR_KEY, projectWorkdir);
      // Broadcast the selected directory: the persistently mounted conversation page uses this to sync its working directory to the project directory. Without this event, even though storage is changed here,
      // the conversation page keeps using the previous project's stale directory (storage changes aren't notified across components), and on send the new conversation would be wrongly grouped into the previous project.
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: projectWorkdir }));
    } else {
      clearAgentWorkdir(); // internally dispatches WORKDIR_CLEAR_EVENT, so the conversation page clears its directory -> the new conversation is grouped into the default project
    }
    putStorage(AGENT_MODE_KEY, projectMode);
    // This mode switch is to open a new conversation within the project, so it shouldn't be interrupted by "default-select the last conversation".
    skipRestoreRef.current = true;
    window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: projectMode }));
    setActiveConversation(null);
    router.push("/agent");
  };

  // macOS: hide the native traffic lights when entering /agent (the sidebar's own buttons take over), and restore them on leaving.
  useEffect(() => {
    setNativeWindowButtons(false);
    return () => setNativeWindowButtons(true);
  }, []);

  // Window always-on-top: Electron only. Backfill the current state and subscribe to changes, for the top pin button to display / toggle.
  const [pinAvailable, setPinAvailable] = useState(false);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!isWindowControlsAvailable()) return;
    setPinAvailable(true);
    void isWindowAlwaysOnTop().then(setPinned);
    return onWindowAlwaysOnTopChange(setPinned);
  }, []);
  const togglePin = async () => setPinned(await toggleWindowAlwaysOnTop());

  const isActive = (href: string) => {
    if (href === "/agent") {
      return pathname === "/agent" || pathname.startsWith("/agent/chat");
    }
    return pathname === href || pathname.startsWith(href + "/");
  };
  // Log out in place: clear the session and stay on /agent as a guest (no redirect).
  const logout = () => {
    removeStorage(STORAGE_KEY.userInfo);
    clearAuthCookie();
    logOut();
  };
  // Sign in on demand via the global modal (used by the guest account row).
  const signIn = () => void requireLogin();
  // Recharge is account-bound: prompt login first, then open the top-up flow.
  const handleRecharge = async () => {
    if (await requireLogin()) router.push("/agent/settings");
  };
  return (
    <aside className="m-2 flex h-[calc(100%_-_16px)] w-[260px] shrink-0 flex-col rounded-2xl border border-line bg-surface shadow-[0px_4px_12.3px_0px_#0000000A]">
      {/* Top: window control dots + brand + collapse button (the whole block is the drag region of the frameless window; interactive elements are no-drag) */}
      <div className="px-4 pt-4" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <TrafficLights />
        <div className="mt-4 flex items-center justify-between">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${isDark ? "/image/agent/sidebar/DZeraix.svg" : "/image/agent/sidebar/Zeraix.svg"}`}
            alt="Zeraix"
            className="h-4 w-auto select-none"
            draggable={false}
          />
          <div
            className="flex items-center gap-1"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {/* Window always-on-top toggle (Electron only): when pinned, "reply finished" uses an in-app hint, otherwise a system notification. */}
            {pinAvailable && (
              <button
                type="button"
                aria-label={pinned ? t("window.unpin") : t("window.pin")}
                aria-pressed={pinned}
                title={pinned ? t("window.unpin") : t("window.pin")}
                onClick={() => void togglePin()}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent dark:hover:bg-white/[0.04]",
                  pinned ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Pin className={cn("size-[16px]", pinned && "fill-current")} />
              </button>
            )}
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={onToggle}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:hover:bg-white/[0.04]"
            >
              <PanelLeftClose className="size-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* Mode switch: daily mode / dev mode */}
      <div className="mt-4 px-3">
        <AgentModeTab />
      </div>

      {/* Main nav */}
      <motion.nav
        className="mt-4 space-y-0.5 px-3"
        variants={NAV_LIST_VARIANTS}
        initial="hidden"
        animate="show"
      >
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <motion.div
              key={item.id}
              variants={NAV_ITEM_VARIANTS}
              whileHover={{ x: 2 }}
              whileTap={{ scale: 0.97 }}
            >

              <button
                onClick={
                  () => {
                    if(item.id === "new-chat") {
                      // New chat: clear the selected working directory and deselect the current conversation, starting from a clean state.
                      clearAgentWorkdir();
                      setActiveConversation(null);
                    }
                    router.push(item.href)
                  }
                }
                className={cn(
                  "relative block rounded-lg px-3 py-2 w-full text-sm text-foreground",
                  active ? "font-medium" : "hover:bg-accent/60 dark:hover:bg-white/[0.04]"
                )}
              >
                {/* Selected-state background pill: slides between items as the route changes */}
                {active && (
                  <motion.span
                    layoutId="agent-nav-active"
                    className="absolute inset-0 rounded-lg bg-accent dark:bg-white/[0.06]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-3">
                  {/* Icon: cross-fades between selected / unselected */}
                  <span className="relative size-[18px] shrink-0">
                    <AnimatePresence initial={false}>
                      <motion.img
                        key={`${active ? "on" : "off"}-${isDark ? "d" : "l"}`}
                        src={iconFor(active ? item.activeIcon : item.icon)}
                        alt=""
                        aria-hidden
                        draggable={false}
                        initial={{ opacity: 0, scale: 0.7 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.7 }}
                        transition={{ duration: 0.15 }}
                        className="absolute inset-0 size-[18px] object-contain"
                      />
                    </AnimatePresence>
                  </span>
                  <span>{t(item.labelKey)}</span>
                </span>
              </button>
            </motion.div>
          );
        })}
      </motion.nav>

      {/* Project group (= folders, filtered by the current mode): click to switch the current project. When there are too many, scroll within this section (max 30vh),
          taking only the height needed, without crowding out the conversation list space */}
      <CollapsibleSection title={t("section.projects")} className="mt-7 max-h-[30vh] px-3" scroll>
        {projectsInMode.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("sidebar.autoCreated")}</p>
        ) : (
          projectsInMode.map((p) => (
            <SidebarLeaf
              key={p.id}
              label={p.name}
              active={p.id === currentProjectId}
              onClick={() => selectProject(p)}
              onNewChat={() => newChatInProject(p.workdir, p.mode)}
              onOpenFolder={(() => {
                const dir = projectFolder(p);
                return dir ? () => void openPathInShell(dir) : undefined;
              })()}
              onRename={() => setRenameState({ kind: "project", id: p.id, value: p.name })}
              onDelete={() => setDeleteState({ kind: "project", id: p.id, name: p.name })}
            />
          ))
        )}
      </CollapsibleSection>

      {/* Conversation group (fills the remaining space, pushing the user area to the bottom; when the list is too long, scroll within this section) */}
      <CollapsibleSection title={t("section.conversations")} className="mt-7 min-h-0 flex-1 px-3" scroll>
        {projectConversations.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("sidebar.noConversations")}</p>
        ) : (
          projectConversations.map((c) => (
            <SidebarLeaf
              key={c.id}
              label={c.title || t("conversation.untitled")}
              active={c.id === activeConversationId}
              generating={!!generating[c.id]}
              onClick={() => openConversation(c.id, c.projectId)}
              onNewChat={() => {
                const proj = projects.find((pp) => pp.id === c.projectId);
                newChatInProject(proj?.workdir ?? "", proj?.mode ?? c.mode);
              }}
              onOpenFolder={(() => {
                // A conversation prefers its own actual directory (under the default project each conversation has its own real directory); if missing, fall back to the project directory.
                const dir = c.workdir || projects.find((pp) => pp.id === c.projectId)?.workdir;
                return dir ? () => void openPathInShell(dir) : undefined;
              })()}
              onRename={() =>
                setRenameState({ kind: "conversation", id: c.id, value: c.title || "" })
              }
              onDelete={() =>
                setDeleteState({
                  kind: "conversation",
                  id: c.id,
                  name: c.title || t("conversation.untitled"),
                })
              }
            />
          ))
        )}
      </CollapsibleSection>

      {/* Files: click to open the separate "Files" sidebar (collapse the main sidebar and reveal the file tree, see AgentShell).
          Electron only; determine only after mounted, to avoid a hydration mismatch between static export (no window) and the client. */}
      {mounted && isToolkitAvailable() && (
        <div className="mt-2 px-3">
          <button
            type="button"
            onClick={() => void handleOpenFiles()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent/60 dark:hover:bg-white/[0.04]"
          >
            <FolderTree className="size-[18px] shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-left">{t("files.section")}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      )}

      {/* Bottom user */}
      <div className="border-t border-line p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent dark:hover:bg-white/[0.04]"
            >
              <Avatar className="size-7">
                <AvatarImage src={avatar} alt={name} />
                <AvatarFallback className="text-xs">
                  {name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1 truncate text-sm font-medium text-foreground">
                {name}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[252px] p-1.5">
            {/* Settings */}
            <DropdownMenuItem onClick={() => router.push("/agent/settings")}>
              <Settings />
              {t("menu.settings")}
            </DropdownMenuItem>

            {/* Help & feedback */}
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <CircleHelp />
              {t("menu.help")}
            </DropdownMenuItem>

            {/* Language (multi-language submenu) */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Languages />
                <span className="flex flex-1 items-center">
                  {t("menu.language")}
                  <span className="ml-auto text-xs text-muted-foreground">{t("lang.current")}</span>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-auto">
                {LOCALES.map((l) => (
                  <DropdownMenuItem key={l.code} onClick={() => setLocale(l.code)}>
                    {l.label}
                    {locale === l.code && <span className="ml-auto text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Theme (light / dark / system, submenu) */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SunMoon />
                <span className="flex flex-1 items-center">
                  {t("menu.theme")}
                  <span className="ml-auto text-xs text-muted-foreground">{themeLabel}</span>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {THEME_MODES.map((m) => (
                  <DropdownMenuItem key={m.key} onClick={() => setTheme(m.key)}>
                    {t(m.labelKey)}
                    {theme === m.key && <span className="ml-auto text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Wallet: domestic edition = credits balance, international edition = US dollar balance. Highlighted card + recharge now */}
            <div className="my-1.5 rounded-xl border border-primary/40 bg-primary/[0.05] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <Coins className="size-3.5" />
                {isCnEdition ? t("menu.credits") : t("menu.balance")}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-xl font-bold tabular-nums text-foreground">
                  {walletText}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRecharge()}
                  className="shrink-0 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
                >
                  {t("menu.recharge")}
                </button>
              </div>
            </div>

            {/* Log out (signed in) / Sign in (guest). */}
            {isLoggedIn ? (
              <DropdownMenuItem onClick={() => logout()}>
                <Power />
                {t("menu.logout")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => signIn()}>
                <Power />
                {t("auth.signIn")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Rename dialog (shared by projects / conversations) */}
      <Dialog open={!!renameState} onOpenChange={(o) => !o && setRenameState(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {renameState?.kind === "project"
                ? t("ctx.renameProject")
                : t("ctx.renameConversation")}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameState?.value ?? ""}
            onChange={(e) =>
              setRenameState((s) => (s ? { ...s, value: e.target.value } : s))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitRename();
              }
            }}
            placeholder={t("ctx.renamePlaceholder")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameState(null)}>
              {t("ctx.cancel")}
            </Button>
            <Button onClick={submitRename} disabled={!renameState?.value.trim()}>
              {t("ctx.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog (shared by projects / conversations): a controlled Dialog replacing the native window.confirm (which freezes the whole page's pointer events). */}
      <Dialog open={!!deleteState} onOpenChange={(o) => !o && setDeleteState(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("ctx.delete")}</DialogTitle>
            <DialogDescription>
              {(deleteState?.kind === "project"
                ? t("ctx.confirmDeleteProject")
                : t("ctx.confirmDeleteConversation")
              ).replace("{name}", deleteState?.name ?? "")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteState(null)}>
              {t("ctx.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("ctx.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

/** A list item within a section (project / conversation entry). Supports a context menu when onNewChat/onRename/onDelete are provided. */
function SidebarLeaf({
  label,
  active = false,
  generating = false,
  onClick,
  onNewChat,
  onOpenFolder,
  onRename,
  onDelete,
}: {
  label: string;
  active?: boolean;
  /** Whether this conversation is currently generating AI output (if so, show a spinner on the right). */
  generating?: boolean;
  onClick?: () => void;
  /** Right-click "New chat" (take the project path and start a new conversation). */
  onNewChat?: () => void;
  /** Right-click "Open folder" (open the project directory in the system file manager); not provided when there's no directory. */
  onOpenFolder?: () => void;
  /** Right-click "Rename". */
  onRename?: () => void;
  /** Right-click "Delete". */
  onDelete?: () => void;
}) {
  const t = useT();
  const leaf = (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-accent font-medium text-foreground dark:bg-white/[0.06]"
          : "text-foreground/80 hover:bg-accent dark:hover:bg-white/[0.04]"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* Show a spinner while generating. */}
      {generating && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
    </button>
  );

  if (!onNewChat && !onOpenFolder && !onRename && !onDelete) return leaf;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{leaf}</ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        {onNewChat && <ContextMenuItem onSelect={onNewChat}><MessageSquarePlus />{t("ctx.newChat")}</ContextMenuItem>}
        {onOpenFolder && <ContextMenuItem onSelect={onOpenFolder}><FolderOpen />{t("ctx.openFolder")}</ContextMenuItem>}
        {onRename && <ContextMenuItem onSelect={onRename}><PencilLine />{t("ctx.rename")}</ContextMenuItem>}
        {onDelete && (
          <ContextMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />{t("ctx.delete")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
