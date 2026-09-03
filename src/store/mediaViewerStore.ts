/**
 * The media viewer's state: what is open, and which of it is on screen.
 *
 * A store rather than props because the viewer is opened from places that share no ancestor short of the
 * shell — a thumbnail in a chat bubble, a tile in the library, a transcript inside the sub-agent inspector —
 * and threading an `onView` callback down through a memoised transcript row for a one-shot action would be
 * plumbing for its own sake. One host (`MediaViewerHost`, mounted by AgentShell) renders whatever is here;
 * everything else just calls `openMediaViewer`.
 *
 * The viewer component itself (`MediaViewer`) stays controlled and knows nothing about this store, so it can
 * also be rendered directly with props wherever that is the simpler thing.
 */
import { create } from "zustand";

/** Broad categories — the same split the media library uses, so its entries map across one-to-one. */
export type MediaViewerKind = "image" | "video" | "audio" | "document" | "other";

export interface MediaViewerItem {
  /** Stable identity for React keys; the position stands in when absent. */
  id?: string;
  /**
   * Something the renderer can load: an https:, data: or blob: URL, or the app's own app:// scheme.
   * A bare disk path renders nothing — see mediaSrcFor in lib/ai/mediaLibrary.ts for how one becomes a URL.
   */
  src: string;
  kind: MediaViewerKind;
  mime?: string;
  /** What the title bar calls it. Also the last resort for the download name — see fileNameOf. */
  name?: string;
  bytes?: number;
  /** Absolute path on disk, when there is one: what "open with system app" needs. */
  path?: string;
  description?: string;
}

interface MediaViewerState {
  open: boolean;
  items: MediaViewerItem[];
  index: number;
  show: (items: MediaViewerItem[], index?: number) => void;
  close: () => void;
  setIndex: (index: number) => void;
}

/** Keep `i` inside `[0, n)`; an empty list clamps to 0. */
export const clampIndex = (i: number, n: number): number =>
  Math.min(Math.max(0, Math.trunc(i) || 0), Math.max(0, n - 1));

export const useMediaViewerStore = create<MediaViewerState>((set) => ({
  open: false,
  items: [],
  index: 0,
  show: (items, index = 0) => {
    if (items.length === 0) return;
    set({ open: true, items, index: clampIndex(index, items.length) });
  },
  // The items stay: the exit animation is still drawing them for a moment after the close.
  close: () => set({ open: false }),
  setIndex: (index) => set((s) => ({ index: clampIndex(index, s.items.length) })),
}));

/** Open the viewer on `items`, starting at `index`. Safe from any event handler; a no-op for an empty list. */
export function openMediaViewer(items: MediaViewerItem[], index = 0): void {
  useMediaViewerStore.getState().show(items, index);
}

export function closeMediaViewer(): void {
  useMediaViewerStore.getState().close();
}
