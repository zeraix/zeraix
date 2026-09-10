"use client";

/**
 * The installed-skins list as the renderer sees it: store installs and the user's own skins.
 *
 * In Electron the list lives in the main process (electron/skins/store.mjs) and arrives two ways -- a synchronous
 * read for first paint, and a broadcast whenever any window changes it. The web build has no store, so it keeps
 * store installs (never images, never custom skins) in localStorage instead.
 *
 * Everything that comes in is re-sanitized. From the main process that is belt and braces; from localStorage,
 * which anything running in the page can write, it is the actual defence.
 */
import { useSyncExternalStore } from "react";
import { sanitizeSkin, type Skin } from "../../../../electron/skins/schema.mjs";
import { skinsBridge } from "@/lib/electron/skins";

const WEB_KEY = "zeraix.skins.installed";
const EMPTY: Skin[] = [];
let cache: Skin[] | null = null;
const listeners = new Set<() => void>();
let bridgeSubscribed = false;

/**
 * `origin` is read from the entry here, unlike everywhere else: this list comes from the main process, which is
 * the one party entitled to decide it. The web fallback only ever holds store skins, so it pins the origin.
 */
function clean(list: unknown, pinOrigin?: "store"): Skin[] {
  if (!Array.isArray(list)) return EMPTY;
  return list
    .map((s) =>
      sanitizeSkin(s, { origin: pinOrigin ?? ((s as { origin?: unknown })?.origin === "store" ? "store" : "custom") }),
    )
    .filter((s): s is Skin => s !== null);
}

function readFresh(): Skin[] {
  if (typeof window === "undefined") return EMPTY;
  const b = skinsBridge();
  if (b) {
    try {
      return clean(b.listSync());
    } catch {
      return EMPTY;
    }
  }
  try {
    return clean(JSON.parse(window.localStorage.getItem(WEB_KEY) ?? "[]"), "store");
  } catch {
    return EMPTY;
  }
}

function set(list: Skin[]) {
  cache = list;
  listeners.forEach((l) => l());
}

function ensureBridgeSubscription() {
  if (bridgeSubscribed || typeof window === "undefined") return;
  const b = skinsBridge();
  if (!b) return;
  bridgeSubscribed = true;
  b.onChanged((list) => set(clean(list)));
}

/** Stable array identity between changes, which useSyncExternalStore depends on. */
export function loadInstalledSkins(): Skin[] {
  ensureBridgeSubscription();
  if (cache === null) cache = readFresh();
  return cache;
}

export function refreshInstalled(): Skin[] {
  set(readFresh());
  return cache ?? EMPTY;
}

export function subscribeInstalled(listener: () => void) {
  ensureBridgeSubscription();
  listeners.add(listener);
  // Web build only: another tab changed the list. (In Electron the IPC broadcast covers every window.)
  const onStorage = (e: StorageEvent) => {
    if (e.key === WEB_KEY && !skinsBridge()) set(readFresh());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useInstalledSkins(): Skin[] {
  return useSyncExternalStore(subscribeInstalled, loadInstalledSkins, () => EMPTY);
}

export type SkinActionResult = { ok: true } | { ok: false; code?: string; canceled?: boolean };

function persistWeb(list: Skin[]) {
  try {
    window.localStorage.setItem(WEB_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the install lasts for this session only */
  }
}

export async function installStoreSkin(skin: Skin): Promise<SkinActionResult> {
  const b = skinsBridge();
  if (b) {
    const r = await b.install(skin);
    if (!r.ok) return { ok: false, code: r.code };
    refreshInstalled();
    return { ok: true };
  }
  const safe = sanitizeSkin(skin, { origin: "store" });
  if (!safe) return { ok: false, code: "invalid" };
  const next = [...loadInstalledSkins().filter((s) => s.id !== safe.id), safe];
  persistWeb(next);
  set(next);
  return { ok: true };
}

export async function removeInstalledSkin(id: string): Promise<SkinActionResult> {
  const b = skinsBridge();
  if (b) {
    const r = await b.remove(id);
    if (!r.ok) return { ok: false, code: r.code };
    refreshInstalled();
    return { ok: true };
  }
  const next = loadInstalledSkins().filter((s) => s.id !== id);
  persistWeb(next);
  set(next);
  return { ok: true };
}

/** A fresh id for a skin being created in the editor. Matches SKIN_ID_RE and never collides with a reserved id. */
export const newCustomSkinId = () => `custom-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
