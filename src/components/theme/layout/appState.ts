"use client";

/**
 * The `state` a layout's visibleWhen expressions can read.
 *
 * Small and documented on purpose -- it is the API surface skin authors write against:
 *   state.theme      "light" | "dark"        the colour mode on screen
 *   state.locale     "en" | "zh" | ...        the UI language
 *   state.edition    "cn" | "intl"            the build edition
 *   state.platform   "win32" | "darwin" | "linux" | "web"
 *   state.desktop    boolean                  running inside Electron
 * plus whatever the region's host passes as slot values (e.g. `state.toolsReady` in the greeting).
 */
import { useMemo } from "react";
import { useTheme } from "next-themes";
import { useLocaleStore } from "@/lib/i18n";
import { APP_EDITION } from "@/lib/edition";
import { isSkinPackagesAvailable } from "@/lib/electron/skinpkg";
import type { AppState } from "./visibleWhen";

function platform(): AppState["platform"] {
  if (typeof navigator === "undefined") return "web";
  const p = navigator.platform.toLowerCase();
  if (p.startsWith("win")) return "win32";
  if (p.startsWith("mac")) return "darwin";
  if (p.includes("linux")) return "linux";
  return "web";
}

export function useLayoutAppState(extra?: Record<string, unknown>): AppState {
  const { resolvedTheme } = useTheme();
  const locale = useLocaleStore((s) => s.locale);
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const desktop = isSkinPackagesAvailable();
  // `extra` is small and re-created per render by callers; keyed by its JSON so the memo holds.
  const extraKey = extra ? JSON.stringify(extra) : "";
  return useMemo(
    () => ({ theme, locale, edition: APP_EDITION, platform: platform(), desktop, ...(extra ?? {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, locale, desktop, extraKey],
  );
}
