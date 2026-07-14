/**
 * Renderer-layer wrapper for accessing system-level notifications (design doc §3.1).
 *
 * Exposed by preload as `window.notification` (see electron/preload.cjs); under the hood the main-process
 * NotificationService queues / merges / rate-limits before calling the OS notification API (see electron/ipc/notificationIpc.mjs).
 * Only available in Electron; under browser / Web deployments `isNotificationAvailable()` is false,
 * sending is a no-op, history is empty, and subscriptions return a no-op unsubscribe function.
 */
import { isCustomSoundActive, playNotifySound, type NotifyType } from "@/lib/ai/notifySound";

/** Notification data structure (design doc §5). When sending, only title is required; the rest are optional. */
export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  type: "info" | "success" | "warning" | "error";
  route?: string;
  url?: string;
  silent?: boolean;
  priority?: "low" | "normal" | "high";
  groupKey?: string;
  actions?: Array<{ text: string; actionId?: string }>;
  /** Only pop when the window is unfocused / minimized (skipped when the user is viewing in the foreground). See notification-t.md. */
  whenBackground?: boolean;
}

/** Input for sending: title is required, the rest are optional (id/type are filled in / sanitized by the main process). */
export type NotificationInput = Partial<Omit<NotificationItem, "id" | "title">> & { title: string };

/** Notification history record (notification center). */
export interface NotificationRecord {
  id: string;
  item: NotificationItem;
  read: boolean;
  createdAt: number;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  merged?: boolean;
  /** Skipped due to a precondition (window in the foreground); neither popped nor added to history. */
  skipped?: boolean;
  supported?: boolean;
  error?: string;
}

interface NotificationBridge {
  send(payload: NotificationInput): Promise<SendResult>;
  isSupported(): Promise<boolean>;
  list(): Promise<NotificationRecord[]>;
  unreadCount(): Promise<number>;
  markRead(id: string): Promise<boolean>;
  markAllRead(): Promise<number>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<boolean>;
  onNavigate(cb: (route: string) => void): () => void;
  onAction(cb: (info: { id: string; index: number; actionId?: string }) => void): () => void;
  onChange(cb: () => void): () => void;
}

declare global {
  interface Window {
    notification?: NotificationBridge;
  }
}

const noop = () => {};

function bridge(): NotificationBridge | null {
  if (typeof window === "undefined") return null;
  return window.notification ?? null;
}

/** Whether the current environment provides system notifications (Electron only). */
export function isNotificationAvailable(): boolean {
  return !!bridge();
}

/**
 * Send a system notification. Returns { ok:false, supported:false } outside Electron.
 * Example: sendNotification({ title: "Task complete", body: "File processing finished", type: "success", route: "/task/123" })
 */
export async function sendNotification(input: NotificationInput): Promise<SendResult> {
  const type = (input.type ?? "info") as NotifyType;
  // When a custom sound is enabled for this type, always mute the OS notification and play it in this layer instead (to avoid overlapping sounds);
  // also mute when the caller requests silent. The two are OR'd together.
  const customSound = isCustomSoundActive(type);
  const payload: NotificationInput = { ...input, silent: !!input.silent || customSound };
  try {
    const res = (await bridge()?.send(payload)) ?? { ok: false, supported: false };
    // Only play the sound when the notification actually popped (was not skipped by the foreground precondition).
    if (res.ok && !res.skipped && customSound) playNotifySound(type);
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether the system supports native notifications (returns false outside Electron). */
export async function isNotificationSupported(): Promise<boolean> {
  return (await bridge()?.isSupported?.()) ?? false;
}

/** List notification history (reverse order); returns an empty array outside Electron. */
export async function listNotifications(): Promise<NotificationRecord[]> {
  return (await bridge()?.list?.()) ?? [];
}

/** Unread count (badge); returns 0 outside Electron. */
export async function unreadNotificationCount(): Promise<number> {
  return (await bridge()?.unreadCount?.()) ?? 0;
}

export async function markNotificationRead(id: string): Promise<boolean> {
  return (await bridge()?.markRead?.(id)) ?? false;
}

export async function markAllNotificationsRead(): Promise<number> {
  return (await bridge()?.markAllRead?.()) ?? 0;
}

export async function removeNotification(id: string): Promise<boolean> {
  return (await bridge()?.remove?.(id)) ?? false;
}

export async function clearNotifications(): Promise<boolean> {
  return (await bridge()?.clear?.()) ?? false;
}

/** Subscribe to the in-app navigation (deep link) triggered by clicking a notification; returns an unsubscribe function (no-op outside Electron). */
export function onNotificationNavigate(cb: (route: string) => void): () => void {
  return bridge()?.onNavigate?.(cb) ?? noop;
}

/** Subscribe to action-button clicks; returns an unsubscribe function (no-op outside Electron). */
export function onNotificationAction(
  cb: (info: { id: string; index: number; actionId?: string }) => void,
): () => void {
  return bridge()?.onAction?.(cb) ?? noop;
}

/** Subscribe to history changes (to refresh the notification center); returns an unsubscribe function (no-op outside Electron). */
export function onNotificationChange(cb: () => void): () => void {
  return bridge()?.onChange?.(cb) ?? noop;
}
