"use client";

/**
 * A store of text files from the ACTIVE skin package, re-read whenever the active package -- or its
 * generation, i.e. a reinstall of the same id -- changes. Shared by the layout engine (layout.json,
 * components.json) and the sidebar (sidebar.json), so both follow the same rules:
 *
 *  - read over IPC (window.skinAPI.readText -> Rust), never fetch(): Chromium refuses a cross-origin
 *    fetch() to a custom scheme whatever skin:// answers;
 *  - one read per package generation, shared by every subscriber;
 *  - a missing file is `null`; a failed read is logged and treated as missing, never thrown into a render;
 *  - the server snapshot is the empty value, so hydration always renders the built-in look first.
 */
import { useSyncExternalStore } from "react";
import { skinAPI } from "@/lib/electron/skinpkg";
import { getSkinState, subscribeSkinState } from "./apply";
import { isPackageSkinId } from "./builtin";

export interface PackageSnapshot<T> {
  skinId: string;
  generation: number;
  value: T;
}

export interface ActivePackageStore<T> {
  useSnapshot(): PackageSnapshot<T>;
  getSnapshot(): PackageSnapshot<T>;
}

export function createActivePackageStore<T>(opts: {
  /** For log lines. */
  name: string;
  files: readonly string[];
  empty: T;
  /** Turn the files' texts (null when absent) into the value. May throw; a throw reads as `empty`. */
  parse: (skinId: string, texts: Record<string, string | null>) => T;
}): ActivePackageStore<T> {
  const NONE: PackageSnapshot<T> = { skinId: "default", generation: 0, value: opts.empty };
  let current = NONE;
  /** `<id>#<generation>` of what `current` holds / what is being read. */
  let loadedKey = "default#0";
  let loadingKey: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  async function readText(skinId: string, rel: string): Promise<string | null> {
    const api = skinAPI();
    if (!api) return null;
    try {
      const r = await api.readText(rel, skinId);
      if (r.ok) return r.text ?? null;
      console.warn(`[${opts.name}] ${skinId}/${rel}: ${r.error?.code ?? "failed"} ${r.error?.detail ?? ""}`.trim());
    } catch (e) {
      console.warn(`[${opts.name}] ${skinId}/${rel}: ${(e as Error)?.message ?? e}`);
    }
    return null;
  }

  async function load(skinId: string, generation: number, key: string) {
    loadingKey = key;
    const pairs = await Promise.all(opts.files.map(async (f) => [f, await readText(skinId, f)] as const));
    if (loadingKey !== key) return; // superseded by a newer switch
    loadingKey = null;
    loadedKey = key;
    let value = opts.empty;
    try {
      value = opts.parse(skinId, Object.fromEntries(pairs));
    } catch (e) {
      console.warn(`[${opts.name}] ${skinId}: ${(e as Error)?.message ?? e}`);
    }
    current = { skinId, generation, value };
    notify();
  }

  function reconcile() {
    const { currentSkinId, isApplying, generation } = getSkinState();
    if (!isPackageSkinId(currentSkinId)) {
      const key = `${currentSkinId}#0`;
      if (loadedKey === key) return;
      loadingKey = null;
      loadedKey = key;
      current = { skinId: currentSkinId, generation: 0, value: opts.empty };
      notify();
      return;
    }
    // A package still loading its stylesheet bumps the generation when it lands: read once, then.
    if (isApplying) return;
    const key = `${currentSkinId}#${generation}`;
    if (loadedKey === key || loadingKey === key) return;
    void load(currentSkinId, generation, key);
  }

  let subscribed = false;
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!subscribed) {
      subscribed = true;
      subscribeSkinState(reconcile);
    }
    reconcile();
    return () => {
      listeners.delete(listener);
    };
  }

  const getSnapshot = () => current;
  return {
    getSnapshot,
    useSnapshot: () => useSyncExternalStore(subscribe, getSnapshot, () => NONE),
  };
}
