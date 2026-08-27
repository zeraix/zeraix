"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronsUpDown,
  PanelLeftClose,
  Pin,
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
import { useImeGuard } from "@/lib/ime";
import {
  AGENT_SELECTION_KEY,
  AGENT_WORKDIR_KEY,
  WORKDIR_SET_EVENT,
} from "@/constants/Agent";
import { PLUGINS_UI_ENABLED } from "@/constants/App";
import { cn } from "@/lib/utils";
import { formatWallet, isCnEdition } from "@/lib/edition";
import {
  setNativeWindowButtons,
  isWindowControlsAvailable,
  isWindowAlwaysOnTop,
  toggleWindowAlwaysOnTop,
  onWindowAlwaysOnTopChange,
} from "@/lib/electron/windowControls";
import STORAGE_KEY from "@/constants/Storage";
import SidebarTree from "./SidebarTree";
import { TrafficLights, useTrafficLights } from "./WindowControls";
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
  { id: "plugins", labelKey: "nav.plugins", icon: "/image/agent/sidebar/sidebar5.svg", activeIcon: "/image/agent/sidebar/sidebar51.svg", href: "/agent/plugins" },
  { id: "library", labelKey: "nav.library", icon: "/image/agent/sidebar/sidebar6.svg", activeIcon: "/image/agent/sidebar/sidebar61.svg", href: "/agent/library" },
  // Filtered rather than deleted: the page and its route stay built and reachable by URL for
  // testing, and switching PLUGINS_UI_ENABLED on is the whole launch.
]

/** Theme modes (consistent with src/components/theme: light / dark / follow system). */
const THEME_MODES = [
  { key: "light", labelKey: "theme.light" },
  { key: "dark", labelKey: "theme.dark" },
  { key: "system", labelKey: "theme.system" },
] as const;

/** The "last selected" project / conversation (persisted in localStorage across restarts). Was a record keyed by the
 *  daily/dev mode, so switching modes restored that mode's selection; with one mode there is one selection. */
type Selection = { projectId: string | null; conversationId: string | null };
const readSelection = (): Partial<Selection> => {
  const v = getStorage(AGENT_SELECTION_KEY);
  return v && typeof v === "object" ? (v as Partial<Selection>) : {};
};
const saveSelection = (sel: Selection) => {
  // Object value: use setStorage directly (putStorage only accepts strings), consistent with agent.skills / agent.llm.models.
  setStorage(AGENT_SELECTION_KEY, sel);
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
 * Collapsible section (projects / conversations). A shrinkable flex column: the title stays fixed and the content takes
 * the remaining space. Scrolling belongs to the content — SidebarTree owns its own scroller, because the virtualizer
 * inside it needs the scrolling element.
 */
function CollapsibleSection({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className={cn(className, "flex min-h-0 flex-col")}>
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
      {open && children}
    </div>
  );
}

export default function AgentSidebar({ onToggle }: { onToggle?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { userInfo, isLoggedIn, logOut } = useAuthStore();
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const t = useT();
  const ime = useImeGuard();
  // Whether the window's top-left corner is ours to reserve — see useTrafficLights.
  const lights = useTrafficLights();

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
  const pendingConsent = useAgentChatStore((s) => s.pendingConsent);
  const pendingQuestion = useAgentChatStore((s) => s.pendingQuestion);
  const unread = useAgentChatStore((s) => s.unread);
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

  // Chat rows show how long ago each was last updated; re-read the clock every minute so "13m" does not sit there stale.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Mirror of the current route (so event handlers can read the latest value, avoiding stale closures): only auto-navigate to the selected conversation on conversation-related routes.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // Every project, in one list. This used to be filtered to the current mode — a folder was a daily project and a dev
  // project with separate histories, and switching the sidebar toggle swapped which half was visible. The two mode tags
  // merged into one, so there is one history per folder and nothing to filter by.
  const currentProjectId =
    activeProjectId && projects.some((p) => p.id === activeProjectId)
      ? activeProjectId
      : (projects[0]?.id ?? null);
  // Lazy-load the current project's conversations.
  useEffect(() => {
    if (currentProjectId) void ensureProjectLoaded(currentProjectId);
  }, [currentProjectId, ensureProjectLoaded]);
  // Projects and chats are one tree: a project row expands to reveal its own chats. Projects start open — the tree is
  // meant to be read as one list of chats grouped by folder — and stay that way until the user folds one, which is why
  // this is an override map rather than a set of open ids (a set would need an effect to seed itself).
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  const expandedProjectIds = useMemo(
    () => new Set(projects.filter((p) => expandOverrides[p.id] ?? true).map((p) => p.id)),
    [projects, expandOverrides]
  );
  // Chats are now visible for any open project, not just the current one, so each open project needs its records loaded.
  useEffect(() => {
    expandedProjectIds.forEach((id) => void ensureProjectLoaded(id));
  }, [expandedProjectIds, ensureProjectLoaded]);
  const setProjectExpanded = (id: string, open: boolean) =>
    setExpandOverrides((m) => ({ ...m, [id]: open }));

  // Chats grouped by project (most recently updated first), so each row can render its own children without re-filtering.
  const conversationsByProject = useMemo(() => {
    const map = new Map<string, typeof conversations>();
    for (const c of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const list = map.get(c.projectId);
      if (list) list.push(c);
      else map.set(c.projectId, [c]);
    }
    return map;
  }, [conversations]);

  const openConversation = (id: string, projectId: string) => {
    setActiveConversation(id);
    // Chats of every open project are reachable now, so a chat can belong to a project that is not the current one;
    // adopt its project so the sidebar highlight and the Files button follow the chat. The working directory is left to
    // the chat page, which restores the conversation's own directory (more precise than the project's) as it loads.
    if (projectId !== currentProjectId) setActiveProject(projectId);
    saveSelection({ projectId, conversationId: id }); // remember the selection, to restore on the next launch
    router.push(`/agent/chat?c=${id}&p=${projectId}`);
  };

  // The project's actual folder: an explicit project = its workdir; the "default project" (no folder selected, projectWorkdir empty,
  // so project.workdir="") has no directory of its own — its real directory lives on each conversation (conv.workdir); take the most recent conversation that has a directory.
  const projectFolder = (p: { id: string; workdir?: string }) =>
    p.workdir ||
    conversations.find((c) => c.projectId === p.id && c.workdir)?.workdir ||
    "";

  // Click a project: set it as the current project and set that project's directory as the working directory (persist + broadcast, so the conversation page updates immediately).
  // When the project directory is empty (the default project), clear the selected directory.
  const selectProject = (p: { id: string; workdir?: string }) => {
    setActiveProject(p.id);
    // Remember the selected project; when switching projects, clear its conversation memory, so on restore it defaults back to the project's first conversation.
    const prev = readSelection();
    saveSelection({
      projectId: p.id,
      conversationId: prev?.projectId === p.id ? (prev.conversationId ?? null) : null,
    });
    if (p.workdir) {
      putStorage(AGENT_WORKDIR_KEY, p.workdir);
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: p.workdir }));
    } else {
      clearAgentWorkdir();
    }
  };

  // Click a project row: open it and make it current. Clicking the already-open current project folds it back up.
  const toggleProject = (p: { id: string; workdir?: string }) => {
    const open = expandedProjectIds.has(p.id);
    if (open && p.id === currentProjectId) {
      setProjectExpanded(p.id, false);
      return;
    }
    if (!open) setProjectExpanded(p.id, true);
    selectProject(p);
  };

  // Right-click "New chat": take that project's path and start a new conversation belonging to that project.
  // Follow the existing "New chat" flow — preset the working directory, clear the current conversation, and return to the home page to start;
  // when the first message is sent, createConversation groups it into that project by path.
  const newChatInProject = (projectWorkdir: string) => {
    if (projectWorkdir) {
      putStorage(AGENT_WORKDIR_KEY, projectWorkdir);
      // Broadcast the selected directory: the persistently mounted conversation page uses this to sync its working directory to the project directory. Without this event, even though storage is changed here,
      // the conversation page keeps using the previous project's stale directory (storage changes aren't notified across components), and on send the new conversation would be wrongly grouped into the previous project.
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: projectWorkdir }));
    } else {
      clearAgentWorkdir(); // internally dispatches WORKDIR_CLEAR_EVENT, so the conversation page clears its directory -> the new conversation is grouped into the default project
    }
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
  // Recharge is account-bound: prompt login first, then open the top-up page.
  const handleRecharge = async () => {
    if (await requireLogin()) router.push("/agent/wallet");
  };
  return (
    <aside className="m-2 flex h-[calc(100%_-_16px)] w-[260px] shrink-0 flex-col rounded-2xl border border-line bg-surface shadow-[0px_4px_12.3px_0px_#0000000A]">
      {/* Top: window control dots + brand + collapse button (the whole block is the drag region of the frameless window; interactive elements are no-drag) */}
      <div className="px-4 pt-4" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <TrafficLights />
        {/* The gap under the lights belongs to the lights: on Windows and Linux nothing is drawn up here, and
            reserving macOS's inset anyway left a band of dead space above the brand. */}
        <div className={cn("flex items-center justify-between", lights.show && "mt-4")}>
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

      {/* The daily / dev mode switch used to sit here. Both tags merged into "Developer Mode", so there is nothing to
          choose; what the toggle really controlled — sandbox or host execution — is now a per-session switch in the chat
          page's header, where it can differ from one conversation to the next. */}

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

      {/* Projects + their chats, as one tree: clicking a project expands its chats underneath. Fills the remaining
          space (pushing the user area to the bottom) and scrolls internally when the tree gets long. */}
      <CollapsibleSection title={t("section.projects")} className="mt-7 min-h-0 flex-1 px-3">
        <SidebarTree
          projects={projects}
          conversationsByProject={conversationsByProject}
          expandedIds={expandedProjectIds}
          currentProjectId={currentProjectId}
          activeConversationId={activeConversationId}
          generating={generating}
          pendingConsent={pendingConsent}
          pendingQuestion={pendingQuestion}
          unread={unread}
          now={now}
          locale={locale}
          onToggleProject={toggleProject}
          onOpenConversation={openConversation}
          onNewChat={newChatInProject}
          folderOf={projectFolder}
          onRename={(kind, id, value) => setRenameState({ kind, id, value })}
          onDelete={(kind, id, name) => setDeleteState({ kind, id, name })}
        />
      </CollapsibleSection>

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
            <DropdownMenuItem onClick={() => router.push("/agent/help")}>
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
            {...ime.bind}
            onKeyDown={(e) => {
              if (ime.isImeKey(e)) return; // the Enter that commits an IME composition is not a confirm — see lib/ime.ts
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
