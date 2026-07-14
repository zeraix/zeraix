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
 * Mode switch at the top of the sidebar: daily mode / dev mode.
 * A segmented control with a sliding indicator (based on the implementation in src/app/app/chat/components/ModeTab.tsx).
 * The selection is persisted to localStorage so it survives across pages / reopening.
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

  // Restore the last selection.
  useEffect(() => {
    migrateLegacyAgentStorage();
    const saved = getStorage(AGENT_MODE_KEY);
    if (saved === "daily" || saved === "dev") setActive(saved);
  }, []);

  // Compute the sliding indicator position (measure after the DOM updates).
  useEffect(() => {
    requestAnimationFrame(() => {
      const i = MODES.findIndex((m) => m.id === active);
      const el = tabRefs.current[i];
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    });
  }, [active]);

  const pick = (id: AgentMode) => {
    if (id === active) return; // Only act when the mode actually changes
    setActive(id);
    if (typeof window !== "undefined") {
      putStorage(AGENT_MODE_KEY, id);
      // Notify other components in the same tab (e.g. the conversation page): the storage event doesn't fire in the same tab, so use a custom event.
      window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: id }));
    }
    clearAgentWorkdir(); // Switching mode -> clear the chosen working directory
    onChange?.(id);
  };

  return (
    <div className="relative flex rounded-xl bg-surface-muted p-1">
      {/* Sliding background indicator */}
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
