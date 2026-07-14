import { create } from "zustand";

/**
 * Global notification center (persistent notification panel in the bottom-right corner).
 *
 * Purpose: Displays local model download/installation progress and various application
 * operation notifications. Unlike transient top toast notifications (Sonner),
 * notifications here can remain persistent (sticky), are not dismissed by clicks,
 * and support progress bars as well as in-place updates via ID-based upsert.
 */
export type NotificationKind = "info" | "success" | "error" | "progress";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message?: string;
  /** progress ：0~1;Ignore the rest. */
  progress?: number;
  /** Persistent: Will not auto-dismiss and hides the close button (e.g., when an installation is in progress). */
  sticky?: boolean;
  createdAt: number;
}

interface NotificationState {
  items: AppNotification[];
  /** Inserts or overwrites/updates by ID (upsert); returns the notification ID. Automatically generates an ID if none is provided. */
  push: (n: Partial<AppNotification> & { title: string; kind?: NotificationKind }) => string;
  /** Partially update an existing notification (ignore if not found). */
  update: (id: string, patch: Partial<AppNotification>) => void;
  /** Dismiss a notification. */
  dismiss: (id: string) => void;
  /** Clear all notifications. */
  clear: () => void;
}

let seq = 0;
const genId = () => `ntf_${++seq}`;

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  push: (n) => {
    const id = n.id ?? genId();
    set((s) => {
      const next: AppNotification = {
        id,
        kind: n.kind ?? "info",
        title: n.title,
        message: n.message,
        progress: n.progress,
        sticky: n.sticky,
        createdAt: Date.now(),
      };
      const idx = s.items.findIndex((it) => it.id === id);
      if (idx >= 0) {
        const items = s.items.slice();
        items[idx] = { ...items[idx], ...next };
        return { items };
      }
      return { items: [...s.items, next] };
    });
    return id;
  },
  update: (id, patch) =>
    set((s) => {
      const idx = s.items.findIndex((it) => it.id === id);
      if (idx < 0) return s;
      const items = s.items.slice();
      items[idx] = { ...items[idx], ...patch };
      return { items };
    }),
  dismiss: (id) => set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Helper/Convenience method (for non-React contexts like event callbacks): accesses the store directly. */
export const notify = {
  push: (n: Parameters<NotificationState["push"]>[0]) => useNotificationStore.getState().push(n),
  update: (id: string, patch: Partial<AppNotification>) =>
    useNotificationStore.getState().update(id, patch),
  dismiss: (id: string) => useNotificationStore.getState().dismiss(id),
};
