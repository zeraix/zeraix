/**
 * System notification IPC (design doc §3.2 / §10): renderer window.notification.* -> main-process service.
 *
 * Security (§10):
 *   - Field allowlist: accept only ALLOWED_FIELDS, strip everything else
 *   - Length limits: truncate title / body to prevent overly long notifications from flooding the screen
 *   - Scheme restriction: route must be an in-app path (starting with /) or notify://; url allows only http(s)
 *   - Rate limiting: handled by the NotificationService's queue + throttle (maxPerSecond / maxBurst)
 */
import { ipcMain, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { ElectronNotificationAdapter, isNotificationSupported } from "../adapters/notificationAdapter.mjs";
import { NotificationService } from "../services/notificationService.mjs";
import {
  listHistory,
  unreadCount,
  markRead,
  markAllRead,
  removeRecord,
  clearHistory,
} from "../store/notificationStore.mjs";

const ALLOWED_FIELDS = ["title", "body", "type", "route", "url", "silent", "priority", "groupKey", "actions", "whenBackground"];
const MAX_TITLE = 120;
const MAX_BODY = 500;
const TYPES = new Set(["info", "success", "warning", "error"]);
const PRIORITIES = new Set(["low", "normal", "high"]);

/** Truncate to the given length and convert to a string. */
function clampStr(v, max) {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/** Sanitize route: allow only in-app paths or notify://; otherwise drop. */
function sanitizeRoute(route) {
  if (typeof route !== "string") return undefined;
  if (route.startsWith("/") || route.startsWith("notify://open/")) return route.slice(0, 300);
  return undefined;
}

/** Sanitize url: allow only http(s); otherwise drop. */
function sanitizeUrl(url) {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/** Sanitize action buttons: at most 3, keep only text/actionId. */
function sanitizeActions(actions) {
  if (!Array.isArray(actions)) return undefined;
  const out = actions.slice(0, 3).map((a) => ({
    text: clampStr(a?.text, 40),
    actionId: typeof a?.actionId === "string" ? a.actionId.slice(0, 80) : undefined,
  }));
  return out.length ? out : undefined;
}

/**
 * Sanitize the raw payload passed in from the renderer into a trusted NotificationItem.
 * An invalid / empty title returns null immediately (the notification is rejected).
 */
function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Field allowlist
  const src = {};
  for (const k of ALLOWED_FIELDS) if (k in raw) src[k] = raw[k];

  const title = clampStr(src.title, MAX_TITLE).trim();
  if (!title) return null;

  return {
    id: randomUUID(),
    title,
    body: clampStr(src.body, MAX_BODY),
    type: TYPES.has(src.type) ? src.type : "info",
    route: sanitizeRoute(src.route),
    url: sanitizeUrl(src.url),
    silent: !!src.silent,
    priority: PRIORITIES.has(src.priority) ? src.priority : "normal",
    groupKey: typeof src.groupKey === "string" ? src.groupKey.slice(0, 120) : undefined,
    actions: sanitizeActions(src.actions),
    // Precondition switch: only pop when the window is in the background / minimized (notification-t.md).
    whenBackground: !!src.whenBackground,
  };
}

/**
 * Register the system notification IPC and return the NotificationService (for the main process to push directly, e.g. AI task-completion notifications).
 * @param {{ getWindow: () => (Electron.BrowserWindow|null), ensureWindow?: () => Promise<Electron.BrowserWindow|null>, iconPath?: string }} opts
 */
export function registerNotifications({ getWindow, ensureWindow, iconPath }) {
  const adapter = new ElectronNotificationAdapter({ iconPath });
  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };
  const service = new NotificationService({ adapter, getWindow, ensureWindow, broadcast });

  // Send: returns { ok, id?, supported }. An invalid payload -> ok:false.
  ipcMain.handle("notify:send", (_e, payload) => {
    const item = sanitize(payload);
    if (!item) return { ok: false, error: "invalid payload", supported: isNotificationSupported() };
    const { id, merged, skipped } = service.send(item);
    return { ok: true, id, merged, skipped, supported: isNotificationSupported() };
  });

  // Notification center data interfaces
  ipcMain.handle("notify:list", () => listHistory());
  ipcMain.handle("notify:unread-count", () => unreadCount());
  ipcMain.handle("notify:mark-read", (_e, id) => markRead(id));
  ipcMain.handle("notify:mark-all-read", () => markAllRead());
  ipcMain.handle("notify:remove", (_e, id) => removeRecord(id));
  ipcMain.handle("notify:clear", () => clearHistory());
  ipcMain.handle("notify:supported", () => isNotificationSupported());

  return service;
}
