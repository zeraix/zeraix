"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import {
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT,
  isAccentKey,
  type AccentKey,
} from "./theme-config";

/* ---- 强调色：基于 localStorage 的轻量外部存储（避免 effect 内 setState） ---- */

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readAccent(): AccentKey {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  return isAccentKey(stored) ? stored : DEFAULT_ACCENT;
}

function getServerSnapshot(): AccentKey {
  return DEFAULT_ACCENT;
}

function applyAccent(accent: AccentKey) {
  document.documentElement.dataset.accent = accent;
}

/** 读取/设置强调色（写入 <html data-accent> 并持久化到 localStorage） */
export function useAccent() {
  const accent = useSyncExternalStore(subscribe, readAccent, getServerSnapshot);
  const setAccent = (next: AccentKey) => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, next);
    applyAccent(next);
    listeners.forEach((l) => l());
  };
  return { accent, setAccent };
}

/** 将当前强调色同步到 <html data-accent>（仅更新外部 DOM，不触发 setState） */
function AccentSync({ children }: { children: React.ReactNode }) {
  const { accent } = useAccent();
  useEffect(() => {
    applyAccent(accent);
  }, [accent]);
  return <>{children}</>;
}

/**
 * 全局主题 Provider：
 * - next-themes 负责明/暗/跟随系统（attribute="class" -> .dark）
 * - AccentSync 负责强调色（data-accent）
 */
export default function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <AccentSync>{children}</AccentSync>
    </NextThemesProvider>
  );
}
