"use client";

/**
 * Global appearance provider.
 *
 * - next-themes drives light/dark/system (attribute="class" -> .dark on <html>).
 * - `seedFromConfig()` runs at module scope, synchronously, so app.config's [ui] values are in
 *   localStorage and on <html> before next-themes reads them. See appearance.ts for why the ordering
 *   is load-bearing.
 * - `AppearanceSync` keeps this window in step with changes made in another one.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import {
  appearanceBridge,
  applyAttributes,
  commitAppearance,
  readAppearance,
  seedFromConfig,
} from "./appearance";
import {
  ACCENT_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  FONT_SIZE_PX_STORAGE_KEY,
  FONT_SIZE_STORAGE_KEY,
  SKIN_MOTION_STORAGE_KEY,
  SKIN_ON_CHAT_STORAGE_KEY,
  SKIN_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type Appearance,
} from "./theme-config";

// Module scope on purpose: this must happen before React renders, and therefore before next-themes
// initialises. Guarded internally against running twice and against the server.
if (typeof window !== "undefined") seedFromConfig();

/* ---- Appearance as an external store, so reads stay consistent and no setState hides in an effect ---- */

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// useSyncExternalStore compares snapshots by identity, so a fresh object every read would loop
// forever. Cached, and replaced only when a field actually differs.
let snapshot: Appearance = DEFAULT_APPEARANCE;
let snapshotPrimed = false;

function getSnapshot(): Appearance {
  const next = readAppearance();
  if (
    !snapshotPrimed ||
    next.theme !== snapshot.theme ||
    next.accent !== snapshot.accent ||
    next.fontSize !== snapshot.fontSize ||
    next.fontSizePx !== snapshot.fontSizePx ||
    next.skinMotion !== snapshot.skinMotion ||
    next.skinOnChat !== snapshot.skinOnChat ||
    next.skin !== snapshot.skin
  ) {
    snapshot = next;
    snapshotPrimed = true;
  }
  return snapshot;
}

const getServerSnapshot = (): Appearance => DEFAULT_APPEARANCE;

/**
 * Read and change the appearance settings.
 *
 * `set` is local-first: it paints and persists immediately, then tells the main process, which fans
 * the change out to any other window. Every setting travels that one path; light/dark additionally
 * goes through next-themes' setTheme, which is what actually flips the `.dark` class.
 */
export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { setTheme } = useTheme();
  const set = useCallback(
    (patch: Partial<Appearance>) => {
      commitAppearance(patch);
      // Writing next-themes' storage key is not enough in THIS window: it hears about that key through
      // the storage event, and the storage event never fires in the window that made the write.
      if (patch.theme) setTheme(patch.theme);
      notify();
    },
    [setTheme],
  );
  return { appearance, setAppearance: set };
}

/** Back-compat shim for callers that only ever wanted the accent. */
export function useAccent() {
  const { appearance, setAppearance } = useAppearance();
  return {
    accent: appearance.accent,
    setAccent: (accent: Appearance["accent"]) => setAppearance({ accent }),
  };
}

/**
 * Keep <html> and this window's state in step with the outside world: changes broadcast from another
 * window, and the accent/font-size attributes after any local change.
 */
function AppearanceSync({ children }: { children: React.ReactNode }) {
  const { appearance } = useAppearance();
  const { setTheme } = useTheme();
  // The broadcast listener below is subscribed once; it reads setTheme through a ref so it never
  // holds a stale one, without resubscribing to IPC every time next-themes hands out a new function.
  const setThemeRef = useRef(setTheme);
  useEffect(() => {
    setThemeRef.current = setTheme;
  }, [setTheme]);

  useEffect(() => {
    applyAttributes(appearance);
  }, [appearance]);

  useEffect(() => {
    const b = appearanceBridge();
    if (!b) return;
    let selfId: number | null = null;
    try {
      selfId = b.getSync().windowId;
    } catch {
      selfId = null;
    }
    return b.onChanged(({ appearance: incoming, origin }) => {
      // Over the defaults, for the same reason as seedFromConfig: a missing field must not read as "off".
      const next = { ...DEFAULT_APPEARANCE, ...incoming };
      // Our own change, already applied locally before the round trip. Re-applying it is harmless but
      // pointless, and it would stomp a newer local edit made while this was in flight.
      if (origin != null && origin === selfId) return;
      applyAttributes(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next.theme);
        window.localStorage.setItem(ACCENT_STORAGE_KEY, next.accent);
        window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, next.fontSize);
        window.localStorage.setItem(FONT_SIZE_PX_STORAGE_KEY, String(next.fontSizePx));
        window.localStorage.setItem(SKIN_MOTION_STORAGE_KEY, next.skinMotion ? "on" : "off");
        window.localStorage.setItem(SKIN_ON_CHAT_STORAGE_KEY, next.skinOnChat ? "on" : "off");
        window.localStorage.setItem(SKIN_STORAGE_KEY, next.skin);
      } catch {
        /* storage unavailable; the DOM is already updated */
      }
      setThemeRef.current(next.theme);
      notify();
    });
  }, []);

  return <>{children}</>;
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <AppearanceSync>{children}</AppearanceSync>
    </NextThemesProvider>
  );
}
