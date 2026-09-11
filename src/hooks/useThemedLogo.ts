"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useSkinBrand } from "@/components/theme/skinpkg/sidebar";

/**
 * Theme-aware app logo: Dlogo in dark mode, logo otherwise -- or the active skin package's brand mark
 * (sidebar.json `brand.mark` / `brand.markDark`) when it sets one. Used by the home screen, the title
 * bar and the sign-in dialog, so one key re-brands all three.
 * Defaults to the light built-in variant before mounting to avoid a hydration mismatch.
 */
export function useThemedLogo(): string {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  const brand = useSkinBrand(dark);
  if (mounted && brand.mark) return brand.mark;
  return dark ? "/image/agent/Dlogo.svg" : "/image/agent/logo.svg";
}
