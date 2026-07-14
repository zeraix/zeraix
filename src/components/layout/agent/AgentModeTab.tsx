"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Lightbulb, CodeXml } from "lucide-react";
import { getStorage } from "@zzcpt/zztool";
import { cn } from "@/lib/utils";
import { AGENT_MODE_KEY, MODE_CHANGE_EVENT, type AgentMode } from "@/constants/Agent";
import { clearAgentWorkdir, migrateLegacyAgentStorage, putStorage } from "@/lib/ai/agentStorage";
import { useT } from "@/lib/i18n";

/**
 * 侧边栏顶部的模式切换：日常模式 / 开发模式。
 * 分段控件，带滑动指示器（参考 src/app/app/chat/components/ModeTab.tsx 的实现）。
 * 选择持久化到 localStorage，便于跨页面 / 重开后保留。
 */

const MODES: { id: AgentMode; labelKey: string; icon: React.ReactNode }[] = [
  { id: "daily", labelKey: "mode.daily", icon: <Lightbulb className="size-4" /> },
  { id: "dev", labelKey: "mode.dev", icon: <CodeXml className="size-4" /> },
];

export default function AgentModeTab({
  defaultMode = "daily",
  onChange,
}: {
  defaultMode?: AgentMode;
  onChange?: (mode: AgentMode) => void;
}) {
  const t = useT();
  const [active, setActive] = useState<AgentMode>(defaultMode);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 回填上次选择。
  useEffect(() => {
    migrateLegacyAgentStorage();
    const saved = getStorage(AGENT_MODE_KEY);
    if (saved === "daily" || saved === "dev") setActive(saved);
  }, []);

  // 计算滑动指示器位置（DOM 更新后再测量）。
  useEffect(() => {
    requestAnimationFrame(() => {
      const i = MODES.findIndex((m) => m.id === active);
      const el = tabRefs.current[i];
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    });
  }, [active]);

  const pick = (id: AgentMode) => {
    if (id === active) return; // 仅在真正切换模式时处理
    setActive(id);
    if (typeof window !== "undefined") {
      putStorage(AGENT_MODE_KEY, id);
      // 通知同一标签页内的其它组件（如对话页）：storage 事件不会在本标签触发，故用自定义事件。
      window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: id }));
    }
    clearAgentWorkdir(); // 切换模式 → 清空已选工作目录
    onChange?.(id);
  };

  return (
    <div className="relative flex rounded-xl bg-surface-muted p-1">
      {/* 滑动背景指示器 */}
      <motion.div
        className="absolute top-1 bottom-1 rounded-lg bg-surface shadow-sm"
        animate={{ left: indicator.left, width: indicator.width }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
      {MODES.map((m, i) => {
        const isActive = active === m.id;
        return (
          <button
            key={m.id}
            type="button"
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            onClick={() => pick(m.id)}
            className={cn(
              "relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm outline-none transition-colors",
              isActive
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="shrink-0">{m.icon}</span>
            <span className="whitespace-nowrap">{t(m.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
