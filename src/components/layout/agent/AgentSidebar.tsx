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
 * 新版 Agent 侧边栏（独立于旧版 `sidebar.tsx`）。
 * 固定宽度 260px：窗口控制点 + 品牌 + 主导航 + 项目/对话分组 + 底部用户。
 */

interface NavItem {
  id: string;
  /** i18n 文案键。 */
  labelKey: string;
  /** 默认（未选中）图标，public/image/agent/sidebar 下的 SVG 路径。 */
  icon: string;
  /** 选中态图标（xxxx1.svg）。 */
  activeIcon: string;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "new-chat", labelKey: "nav.newChat", icon: "/image/agent/sidebar/sidebar1.svg", activeIcon: "/image/agent/sidebar/sidebar11.svg", href: "/agent" },
  { id: "skills", labelKey: "nav.skills", icon: "/image/agent/sidebar/sidebar2.svg", activeIcon: "/image/agent/sidebar/sidebar21.svg", href: "/agent/skills" },
  { id: "automation", labelKey: "nav.automation", icon: "/image/agent/sidebar/sidebar3.svg", activeIcon: "/image/agent/sidebar/sidebar31.svg", href: "/agent/automation" },
  { id: "models", labelKey: "nav.models", icon: "/image/agent/sidebar/sidebar4.svg", activeIcon: "/image/agent/sidebar/sidebar41.svg", href: "/agent/models" },
];

/** 主题模式（与 src/components/theme 一致：明 / 暗 / 跟随系统）。 */
const THEME_MODES = [
  { key: "light", labelKey: "theme.light" },
  { key: "dark", labelKey: "theme.dark" },
  { key: "system", labelKey: "theme.system" },
] as const;

/** 每个模式记住的「上次选中」项目 / 对话（用于切换模式时恢复，跨重开持久化于 localStorage）。 */
type ModeSelection = { projectId: string | null; conversationId: string | null };
const readModeSelections = (): Partial<Record<AgentMode, ModeSelection>> => {
  const v = getStorage(AGENT_MODE_SELECTION_KEY);
  return v && typeof v === "object" ? (v as Partial<Record<AgentMode, ModeSelection>>) : {};
};
const saveModeSelection = (mode: AgentMode, sel: ModeSelection) => {
  // 对象值：直接用 setStorage（putStorage 仅接受字符串），与 agent.skills / agent.llm.models 一致。
  setStorage(AGENT_MODE_SELECTION_KEY, { ...readModeSelections(), [mode]: sel });
};

const EASE = [0.4, 0, 0.2, 1] as const;

/** 导航进场：容器逐项错峰，子项淡入并自左微移。 */
const NAV_LIST_VARIANTS = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};
const NAV_ITEM_VARIANTS = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.25, ease: EASE } },
};

/**
 * macOS 风格窗口控制（红=关闭 / 黄=最小化 / 绿=缩放）。
 * 在 Electron 中可点击并驱动真实窗口（原生红绿灯已在主进程隐藏）；
 * 浏览器 / Web 下退化为纯装饰，且悬停不显示符号。
 */
function TrafficLights() {
  const [state, setState] = useState({ electron: false, mac: false });

  // 仅客户端判断平台，避免水合不一致。
  useEffect(() => {
    void (async () => {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setState({ electron: ua.includes("Electron"), mac: ua.includes("Macintosh") });
    })();
  }, []);

  // Windows/Linux 的 Electron 改用右上角窗口控制（见 WindowControls），这里不渲染红绿灯。
  if (state.electron && !state.mac) return null;

  // 仅 macOS Electron 下可点击控制窗口；浏览器中为纯装饰。
  const active = state.electron && state.mac;

  const buttons = [
    { color: "#ff5f57", label: "关闭", glyph: "✕", onClick: closeWindow },
    { color: "#febc2e", label: "最小化", glyph: "−", onClick: minimizeWindow },
    { color: "#28c840", label: "缩放", glyph: "+", onClick: () => void toggleMaximizeWindow() },
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

/** 可折叠分组（项目 / 对话）。 */
function CollapsibleSection({
  title,
  children,
  className,
  scroll = false,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  /** 内容超出可用高度时在本区内滚动（用于会话列表，避免撑破侧栏、无法滚动）。 */
  scroll?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    // scroll 时本区作为可收缩的 flex 列，标题固定、列表在剩余空间内滚动。
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
  /** 打开「文件」侧栏：折叠主侧边栏并浮现独立的文件列表侧栏（由 AgentShell 协调）。 */
  onOpenFiles?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { userInfo, isLoggedIn, logOut } = useAuthStore();
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const t = useT();

  // Guests can use the whole app; the account row falls back to a "sign in" label.
  const name = isLoggedIn ? userInfo?.username || userInfo?.name || "用户名" : t("auth.signIn");
  const avatar = (isLoggedIn && userInfo?.avatar) || "";
  // 钱包展示：按构建版本切换——国内版显示积分（余额×1000），国际版显示美元（$）。缺失按 0 展示。
  const walletText = formatWallet(userInfo?.walletBalance);

  // 项目 / 对话记录（持久化于 JSON 文件，见 agentChatStore）。
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
  // 重命名弹窗（项目 / 对话共用；Electron 屏蔽 window.prompt，故用对话框输入）。
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
  // 删除确认弹窗（项目 / 对话共用）：改用受控 Dialog 而非 window.confirm。原生弹窗会同步阻塞在右键菜单
  // （Radix 模态层）的 onSelect 里，确认后被删行连同其菜单被直接从树上移除，Radix 复位 <body> 指针事件的
  // 清理被跳过 → 整页 pointer-events:none 卡死、点不动。受控 Dialog 由 state 开合、干净卸载，规避此问题。
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
  // 主题（明 / 暗 / 系统）：用 next-themes；mounted 后再显示标签，避免水合不一致。
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // 暗色模式使用「sidebarD*」图标变体（sidebar1.svg → sidebarD1.svg）；挂载前按浅色，避免水合不一致。
  const isDark = mounted && resolvedTheme === "dark";
  const iconFor = (p: string) => (isDark ? p.replace(/sidebar(\d+\.svg)$/, "sidebarD$1") : p);
  useEffect(() => setMounted(true), []);
  // i18n：界面语言（翻译函数 t 在组件顶部已声明）。
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const themeLabel = mounted ? t(THEME_MODES.find((m) => m.key === theme)?.labelKey ?? "theme.system") : "";

  // 首次载入记录。
  useEffect(() => {
    void initStore();
  }, [initStore]);

  // 当前模式（日常 / 开发）：与侧边栏的 AgentModeTab 同步（自定义事件 + 跨标签 storage）。
  const [mode, setMode] = useState<AgentMode>("daily");
  // 已应用模式的镜像：用于在事件处理里判断「是否真正发生了切换」（挂载时的回填不算切换）。
  const modeRef = useRef<AgentMode>("daily");
  // 「本次模式变化跳过默认选中」：右键「在项目内新建对话」会切模式但要开新对话，不应被默认选中打断。
  const skipRestoreRef = useRef(false);
  // 当前路由镜像（供事件处理里读取最新值，避免闭包过期）：仅在对话相关路由才自动跳转到选中对话。
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    // 挂载回填：仅同步模式镜像与状态，不触发默认选中（避免覆盖 URL 直达的会话）。
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
      // 切换模式后不再自动载入该模式下（上次记住的 / 首个项目的）对话，而是回到「新建对话」首页，
      // 让用户在目标模式从干净状态开始。skip = 右键「在项目内新建对话」，其自身已跳首页，勿重复跳转。
      if (changed && !skip) {
        useAgentChatStore.getState().setActiveConversation(null); // 清空对话高亮
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

  // 项目 = 文件夹 + 模式：按当前模式过滤，不同模式的历史相互独立。
  const projectsInMode = projects.filter((p) => p.mode === mode);
  const currentProjectId =
    activeProjectId && projectsInMode.some((p) => p.id === activeProjectId)
      ? activeProjectId
      : (projectsInMode[0]?.id ?? null);
  // 懒加载当前项目的对话。
  useEffect(() => {
    if (currentProjectId) void ensureProjectLoaded(currentProjectId);
  }, [currentProjectId, ensureProjectLoaded]);
  const projectConversations = conversations
    .filter((c) => c.projectId === currentProjectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const openConversation = (id: string, projectId: string) => {
    setActiveConversation(id);
    saveModeSelection(mode, { projectId, conversationId: id }); // 记住当前模式的选择，供切换模式后恢复
    router.push(`/agent/chat?c=${id}&p=${projectId}`);
  };

  // 项目对应的实际文件夹：显式项目 = 其 workdir；「默认项目」（日常模式未选文件夹，projectWorkdir 为空，
  // 故 project.workdir=""）本身不存目录，其真实目录落在各对话上（conv.workdir），取最近一条有目录的对话。
  const projectFolder = (p: { id: string; workdir?: string }) =>
    p.workdir ||
    conversations.find((c) => c.projectId === p.id && c.workdir)?.workdir ||
    "";

  // 点击项目：设为当前项目，并把该项目的目录设为操作目录（持久化 + 广播，供对话页即时更新）。
  // 项目目录为空（如日常模式项目）时则清空所选目录。
  const selectProject = (p: { id: string; workdir?: string }) => {
    setActiveProject(p.id);
    // 记住当前模式选中的项目；切换项目时清空其对话记忆，恢复时默认回到该项目第一条对话。
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

  // 点击「文件」：打开前始终把「目标项目」的目录落地为主进程工作目录，使文件树展示该项目内容。
  //  - 目标项目 = 活动项目（若属当前模式）；否则回退到当前模式的第一个项目（如刚切换模式后）。
  // 之所以必须在此显式落地：文件树读取的是主进程 cwd，而点击项目的 selectProject 只派发
  // WORKDIR_SET_EVENT（仅对话页监听并调用 setWorkingDir）；在其它页面 cwd 不会更新，导致
  // 「点了项目再点文件，文件树没切过去」。这里直接调用 setWorkingDir 并 await 后再打开，
  // 确保文件树挂载时 cwd 已指向目标项目——无论当前在哪个页面。
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

  // 右键「新建对话」：取该项目的路径与模式，开启一段归属该项目的新对话。
  // 沿用「新建对话」的既有流程——预置工作目录 + 模式，清空当前会话后回到首页开始，
  // 首条消息发送时 createConversation 会按「路径 + 模式」归入该项目。
  const newChatInProject = (projectWorkdir: string, projectMode: AgentMode) => {
    if (projectWorkdir) {
      putStorage(AGENT_WORKDIR_KEY, projectWorkdir);
      // 广播已选目录：常驻挂载的对话页据此把工作目录同步为该项目目录。缺此事件时，即使这里改了 storage，
      // 对话页仍沿用上一个项目的陈旧目录（storage 变更不跨组件通知），发送时新会话会被错误归入上一个项目。
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: projectWorkdir }));
    } else {
      clearAgentWorkdir(); // 内部已派发 WORKDIR_CLEAR_EVENT，对话页据此清空目录 → 新会话归入默认项目
    }
    putStorage(AGENT_MODE_KEY, projectMode);
    // 这次切模式是为了在该项目内开新对话，不要被「默认选中上次对话」打断。
    skipRestoreRef.current = true;
    window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: projectMode }));
    setActiveConversation(null);
    router.push("/agent");
  };

  // macOS：进入 /agent 时隐藏原生红绿灯（由侧边栏自绘按钮接管），离开时恢复。
  useEffect(() => {
    setNativeWindowButtons(false);
    return () => setNativeWindowButtons(true);
  }, []);

  // 窗口置顶（always-on-top）：仅 Electron 可用。回填当前状态并订阅变化，供顶部置顶按钮显示 / 切换。
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
      {/* 顶部：窗口控制点 + 品牌 + 折叠按钮（整块作为无边框窗口的拖拽区，交互元素 no-drag） */}
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
            {/* 窗口置顶开关（仅 Electron）：置顶后「回复完成」用应用内提示，否则用系统通知。 */}
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
              aria-label="折叠侧边栏"
              onClick={onToggle}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground dark:hover:bg-white/[0.04]"
            >
              <PanelLeftClose className="size-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* 模式切换：日常模式 / 开发模式 */}
      <div className="mt-4 px-3">
        <AgentModeTab />
      </div>

      {/* 主导航 */}
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
                      // 新建对话：清空已选工作目录，并取消当前对话高亮，从干净状态开始。
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
                {/* 选中态背景药丸：随路由切换在各项间滑动 */}
                {active && (
                  <motion.span
                    layoutId="agent-nav-active"
                    className="absolute inset-0 rounded-lg bg-accent dark:bg-white/[0.06]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-3">
                  {/* 图标：选中 / 未选中之间交叉淡入 */}
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

      {/* 项目分组（= 文件夹，按当前模式过滤）：点击切换当前项目。过多时在本区内滚动（上限 30vh），
          仅占用所需高度，不挤占会话列表空间 */}
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

      {/* 对话分组（撑满剩余空间，把用户区压到底部；列表过多时在本区内滚动） */}
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
                // 对话优先用自身实际目录（默认项目下每条对话各有真实目录）；缺失再回退项目目录。
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

      {/* 文件：点击打开独立的「文件」侧栏（折叠主侧边栏并浮现文件树，见 AgentShell）。
          仅 Electron 可用；mounted 后再判定，避免静态导出（无 window）与客户端水合不一致。 */}
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

      {/* 底部用户 */}
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
            {/* 设置 */}
            <DropdownMenuItem onClick={() => router.push("/agent/settings")}>
              <Settings />
              {t("menu.settings")}
            </DropdownMenuItem>

            {/* 帮助与反馈 */}
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <CircleHelp />
              {t("menu.help")}
            </DropdownMenuItem>

            {/* 语言（多语言子菜单） */}
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

            {/* 主题（明 / 暗 / 系统，子菜单） */}
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

            {/* 钱包：国内版=积分余额，国际版=美元余额。高亮卡片 + 立即充值 */}
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

      {/* 重命名弹窗（项目 / 对话共用） */}
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

      {/* 删除确认弹窗（项目 / 对话共用）：受控 Dialog，替代原生 window.confirm（后者会卡死整页指针事件）。 */}
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

/** 分组内的列表项（项目 / 对话条目）。提供 onNewChat/onRename/onDelete 时支持右键菜单。 */
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
  /** 该会话是否正在生成 AI 输出（是则右侧显示转圈）。 */
  generating?: boolean;
  onClick?: () => void;
  /** 右键「新建对话」（取该项目路径，开启新对话）。 */
  onNewChat?: () => void;
  /** 右键「打开文件夹」（在系统文件管理器中打开项目目录）；无目录时不提供。 */
  onOpenFolder?: () => void;
  /** 右键「重命名」。 */
  onRename?: () => void;
  /** 右键「删除」。 */
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
      {/* 生成中显示转圈。 */}
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
