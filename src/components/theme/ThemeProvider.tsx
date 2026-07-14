"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import {
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT,
  isAccentKey,
  type AccentKey,
} from "./theme-config";

/* ---- Accent color: lightweight external store backed by localStorage (avoids setState inside an effect) ---- */

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

/** Read/set the accent color (writes to <html data-accent> and persists to localStorage) */
export function useAccent() {
  const accent = useSyncExternalStore(subscribe, readAccent, getServerSnapshot);
  const setAccent = (next: AccentKey) => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, next);
    applyAccent(next);
    listeners.forEach((l) => l());
  };
  return { accent, setAccent };
}

/** Sync the current accent color to <html data-accent> (only updates external DOM, doesn't trigger setState) */
function AccentSync({ children }: { children: React.ReactNode }) {
  const { accent } = useAccent();
  useEffect(() => {
    applyAccent(accent);
  }, [accent]);
  return <>{children}</>;
}

/**
 * Global theme Provider:
 * - next-themes handles light/dark/follow-system (attribute="class" -> .dark)
 * - AccentSync handles the accent color (data-accent)
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
