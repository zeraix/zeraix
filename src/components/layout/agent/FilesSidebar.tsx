"use client";

import { ChevronLeft } from "lucide-react";
import { useT } from "@/lib/i18n";
import FilesTree from "./FilesTree";

/**
 * 独立的「文件」侧栏：主侧边栏折叠后浮现于同一位置，展示当前工作目录的文件树。
 * 顶部返回按钮收起本侧栏并恢复主侧边栏（由 AgentShell 协调开合状态）。
 * 卡片外观与主侧边栏（AgentSidebar）保持一致。
 */
export default function FilesSidebar({ onClose }: { onClose?: () => void }) {
  const t = useT();
  return (
    <aside className="m-2 flex h-[calc(100%_-_16px)] w-[260px] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0px_4px_12.3px_0px_#0000000A]">
      {/* 顶部：返回 + 标题（整块作为无边框窗口拖拽区，交互元素 no-drag） */}
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

      {/* 文件树：整块可滚动 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <FilesTree />
      </div>
    </aside>
  );
}
