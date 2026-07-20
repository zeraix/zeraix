"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

/**
 * Theme-aware logo path: Dlogo in dark mode, logo otherwise.
 * Defaults to the light variant before mounting to avoid a hydration mismatch.
 */
export function useThemedLogo(): string {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && resolvedTheme === "dark" ? "/image/agent/Dlogo.svg" : "/image/agent/logo.svg";
}

