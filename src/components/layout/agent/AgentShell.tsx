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
import { requestCloseFile } from "@/lib/fileViewer";

/** 侧边栏外框宽度：卡片 260 + 左右 m-2（各 8）。 */
const SIDEBAR_WIDTH = 276;
const EASE = [0.4, 0, 0.2, 1] as const;

/**
 * Agent 模块外壳：左侧新版侧边栏 + 右侧内容区。
 * 由 `src/app/agent/layout.tsx` 套用到所有 `/agent` 子页面。
 * relative 用于承载 Windows/Linux 右上角窗口控制（绝对定位）。
 */
export default function AgentShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  // 文件侧栏：打开时折叠主侧边栏并在同一位置浮现文件树；关闭时恢复主侧边栏。
  const [filesOpen, setFilesOpen] = useState(false);
  // 全屏页（如设置）隐藏左侧主侧边栏，由页面自身提供返回入口。见 AGENT_FULLSCREEN_PATHS。
  const pathname = usePathname();
  const hideSidebar = shouldHideAgentSidebar(pathname ?? "");
  // 对话页常驻挂载：仅在 /agent/chat 显示，其余 /agent 路由隐藏（display:none）但不卸载——
  // 使其生成循环、消息队列与「停止」控制在页面切换时持续有效。见 ChatAgentView / page.tsx。
  const isChatRoute = pathname === "/agent/chat";

  const openFiles = () => {
    setFilesOpen(true);
    setCollapsed(true);
  };
  const closeFiles = () => {
    setFilesOpen(false);
    setCollapsed(false);
    requestCloseFile(); // 收起文件树侧栏时，一并关闭右侧文件查看/编辑面板
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-surface">
      {/* 全局：本地模型就绪/停止 → 同步聊天模型清单（跨页面持续，避免离开模型库页丢失就绪事件）。 */}
      <LocalModelSync />
      {/* 外层只动画宽度并裁剪，内部 aside 保持 260 宽度，避免折叠时文字被挤压 */}
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

      {/* 文件侧栏：主侧边栏折叠后，在同一位置浮现（宽度动画进出） */}
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
        {/* 顶部标题栏：预留高度并可拖拽（右上角窗口控制悬浮其上），避免内容贴住窗口顶边 */}
        <div
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          className="h-8 shrink-0 bg-surface"
        />
        {/* 顶栏下方的内容行：页面内容 + 右侧文件面板并排。文件面板置于此处（顶栏下方）而非
            main 之外，避免其头部与右上角窗口控制（悬浮于顶栏）重叠。 */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            {/* 常驻的对话页：始终挂载，仅在对话路由显示；其它路由渲染各自 children，对话页隐藏但继续运行。 */}
            <div className={isChatRoute ? "h-full" : "hidden"}>
              <ChatAgentView />
            </div>
            {!isChatRoute && children}
          </div>
          {/* 文件查看/编辑面板：侧栏文件树点击文件 → OPEN_FILE_EVENT → 此面板加载展示。
              置于 Shell 层（而非仅对话页），使任意 /agent 页面点击文件都能显示内容。
              自管理开合，未打开时渲染为 null，不占空间。 */}
          <FilesPanel />
        </div>
      </main>

      {/* 折叠时左上角浮现的展开按钮（全屏页无侧边栏，不展示） */}
      <AnimatePresence>
        {collapsed && !hideSidebar && !filesOpen && (
          <motion.button
            type="button"
            aria-label="展开侧边栏"
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

      {/* Windows / Linux：右上角窗口控制（macOS 下不渲染，用侧边栏红绿灯） */}
      <WindowControls />
    </div>
  );
}
