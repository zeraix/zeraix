"use client";

/**
 * The installed skin packages, as the renderer sees them.
 *
 * `useInstalledSkins()` is the hook the prompt set describes (useState + useEffect, `{ skins, isLoading, refresh }`),
 * backed by one module-level cache so three hook instances on a settings page cost one IPC round trip, and by the
 * main process's `skinpkg:changed` broadcast so an install in another window shows up here.
 *
 * The list is the engine's: it re-validates every manifest on read (store.rs), so nothing is sanitized again here.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { skinAPI, type SkinListPayload, type SkinManifest } from "@/lib/electron/skinpkg";

const EMPTY: SkinManifest[] = [];

let cache: SkinManifest[] | null = null;
let inflight: Promise<SkinManifest[]> | null = null;
const listeners = new Set<(skins: SkinManifest[]) => void>();
const activeListeners = new Set<(active: string | null) => void>();
let bridgeSubscribed = false;

function publish(payload: SkinListPayload) {
  cache = Array.isArray(payload.skins) ? payload.skins : EMPTY;
  listeners.forEach((l) => l(cache ?? EMPTY));
  activeListeners.forEach((l) => l(payload.active ?? null));
}

function ensureBridgeSubscription() {
  if (bridgeSubscribed) return;
  const api = skinAPI();
  if (!api) return;
  bridgeSubscribed = true;
  api.onChanged(publish);
}

/** Fetch the list from the main process; concurrent callers share one request. */
export function refreshInstalledSkins(): Promise<SkinManifest[]> {
  const api = skinAPI();
  if (!api) return Promise.resolve(EMPTY);
  if (inflight) return inflight;
  inflight = api
    .list()
    .then((r) => {
      if (r.ok) publish(r);
      return cache ?? EMPTY;
    })
    .catch(() => cache ?? EMPTY)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The cached list, without a fetch. */
export const installedSkinsSnapshot = () => cache ?? EMPTY;

/** The main process's view of the active id changed (another window, or a delete that fell back to default). */
export function subscribeActiveFromMain(listener: (active: string | null) => void) {
  ensureBridgeSubscription();
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

const noopSubscribe = () => () => {};

export function useInstalledSkins(): { skins: SkinManifest[]; isLoading: boolean; refresh: () => Promise<void> } {
  const [skins, setSkins] = useState<SkinManifest[]>(() => cache ?? EMPTY);
  // "Loading" is derived, not read from window during render: the server has no bridge and the client has one,
  // and a state initialised from that difference would hydrate one way and render the other.
  const desktop = useSyncExternalStore(noopSubscribe, () => !!skinAPI(), () => true);
  const [settled, setSettled] = useState(() => cache !== null);
  const isLoading = desktop && !settled;

  useEffect(() => {
    ensureBridgeSubscription();
    const onList = (next: SkinManifest[]) => {
      setSkins(next);
      setSettled(true);
    };
    listeners.add(onList);
    if (cache === null) {
      void refreshInstalledSkins().then(onList);
    } else {
      onList(cache);
    }
    return () => {
      listeners.delete(onList);
    };
  }, []);

  const refresh = useCallback(async () => {
    setSettled(false);
    const next = await refreshInstalledSkins();
    setSkins(next);
    setSettled(true);
  }, []);

  return { skins, isLoading, refresh };
}
