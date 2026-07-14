/**
 * 系统通知 IPC（设计文档 §3.2 / §10）：渲染层 window.notification.* → 主进程服务。
 *
 * 安全（§10）：
 *   - 字段白名单：仅接受 ALLOWED_FIELDS，其余一律剔除
 *   - 长度限制：title / body 截断，防止超长通知刷屏
 *   - scheme 限制：route 必须是应用内路径（/ 开头）或 notify://；url 仅允许 http(s)
 *   - 频率限制：由 NotificationService 的队列 + 限流承担（maxPerSecond / maxBurst）
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

/** 截断到指定长度并转字符串。 */
function clampStr(v, max) {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/** route 净化：仅允许应用内路径或 notify://；否则丢弃。 */
function sanitizeRoute(route) {
  if (typeof route !== "string") return undefined;
  if (route.startsWith("/") || route.startsWith("notify://open/")) return route.slice(0, 300);
  return undefined;
}

/** url 净化：仅允许 http(s)；否则丢弃。 */
function sanitizeUrl(url) {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/** 动作按钮净化：最多 3 个，仅保留 text/actionId。 */
function sanitizeActions(actions) {
  if (!Array.isArray(actions)) return undefined;
  const out = actions.slice(0, 3).map((a) => ({
    text: clampStr(a?.text, 40),
    actionId: typeof a?.actionId === "string" ? a.actionId.slice(0, 80) : undefined,
  }));
  return out.length ? out : undefined;
}

/**
 * 把渲染层传入的原始 payload 净化为受信 NotificationItem。
 * 非法 / 空 title 直接返回 null（拒绝该通知）。
 */
function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;
  // 字段白名单
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
    // 前置条件开关：仅当窗口在后台/最小化时才弹（notification-t.md）。
    whenBackground: !!src.whenBackground,
  };
}

/**
 * 注册系统通知 IPC，并返回 NotificationService（供主进程内部直接推送，如 AI 任务完成通知）。
 * @param {{ getWindow: () => (Electron.BrowserWindow|null), iconPath?: string }} opts
 */
export function registerNotifications({ getWindow, iconPath }) {
  const adapter = new ElectronNotificationAdapter({ iconPath });
  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };
  const service = new NotificationService({ adapter, getWindow, broadcast });

  // 发送：返回 { ok, id?, supported }。非法 payload → ok:false。
  ipcMain.handle("notify:send", (_e, payload) => {
    const item = sanitize(payload);
    if (!item) return { ok: false, error: "invalid payload", supported: isNotificationSupported() };
    const { id, merged, skipped } = service.send(item);
    return { ok: true, id, merged, skipped, supported: isNotificationSupported() };
  });

  // 通知中心数据接口
  ipcMain.handle("notify:list", () => listHistory());
  ipcMain.handle("notify:unread-count", () => unreadCount());
  ipcMain.handle("notify:mark-read", (_e, id) => markRead(id));
  ipcMain.handle("notify:mark-all-read", () => markAllRead());
  ipcMain.handle("notify:remove", (_e, id) => removeRecord(id));
  ipcMain.handle("notify:clear", () => clearHistory());
  ipcMain.handle("notify:supported", () => isNotificationSupported());

  return service;
}
