/**
 * System notification service (design doc §3.3 / §6 / §7) -- the main-process single entry point, decoupling the renderer from the OS.
 *
 * Responsibilities:
 *   - Receive notification requests (fields already whitelisted / length-checked / scheme-sanitized by the IPC layer)
 *   - Queue (display sequentially to avoid flooding) + merge (fold same-groupKey items into "N updates") + rate-limit
 *   - Call the platform adapter to display
 *   - Handle clicks → bring the main window forward and dispatch route:navigate (Deep Link)
 *   - Write to history (notification center data layer) and broadcast notify:changed
 *
 * Rate limiting (design doc §6.1): maxPerSecond controls the display cadence, maxBurst caps the backlog queue
 * (beyond it, the oldest non-high priority items are dropped to prevent unbounded buildup).
 */
import { appendRecord } from "../store/notificationStore.mjs";

const RATE_LIMIT = { maxPerSecond: 3, maxBurst: 10 };

export class NotificationService {
  /**
   * @param {object} deps
   * @param {import("../adapters/notificationAdapter.mjs").ElectronNotificationAdapter} deps.adapter Platform adapter
   * @param {() => (Electron.BrowserWindow | null)} deps.getWindow Get the main window (bring forward + route on click)
   * @param {(channel: string, payload?: any) => void} [deps.broadcast] Broadcast to the renderer (e.g. notify:changed)
   */
  constructor({ adapter, getWindow, broadcast }) {
    this.adapter = adapter;
    this.getWindow = getWindow;
    this.broadcast = broadcast || (() => {});
    this.queue = [];
    this.active = false;
    this.lastShownAt = 0; // Timestamp of the last display (rate-limit cadence)
  }

  /** Display cadence: the minimum interval between two displays (ms). */
  get minInterval() {
    return Math.ceil(1000 / RATE_LIMIT.maxPerSecond);
  }

  /** Whether the main window is currently in the foreground (focused and not minimized). */
  isForeground() {
    const win = this.getWindow?.();
    return !!win && !win.isMinimized() && win.isFocused();
  }

  /**
   * Enqueue a notification. Returns { id, merged } or { id, skipped }.
   * Precondition (notification-t.md §trigger preconditions): a notification with whenBackground pops only when
   * the window is unfocused or minimized (the user isn't looking); it is skipped while the user is watching the app, to avoid interruption.
   * Merge strategy (§6.2): if the tail (not-yet-shown) queue item has the same groupKey as the new item, fold them into
   * one and accumulate the update count, rather than popping each separately (typical case: continuous AI output).
   */
  send(item) {
    // Precondition: notify only when in the background/minimized. If the user is viewing in the foreground, skip outright (no popup, no history).
    if (item.whenBackground && this.isForeground()) {
      return { id: item.id, skipped: true };
    }

    // Merge: if it belongs to the same group as the tail, update in place rather than adding a new queue item.
    const tail = this.queue[this.queue.length - 1];
    if (item.groupKey && tail && tail.groupKey === item.groupKey) {
      tail._count = (tail._count || 1) + 1;
      tail.title = item.title || tail.title;
      tail.body = mergedBody(item, tail._count);
      tail.route = item.route ?? tail.route;
      tail.url = item.url ?? tail.url;
      this.processQueue();
      return { id: tail.id, merged: true };
    }

    this.queue.push(item);
    this.enforceBurstCap();
    this.processQueue();
    return { id: item.id, merged: false };
  }

  /** When the backlog exceeds maxBurst: drop the oldest non-high priority items (high is kept) and log it. */
  enforceBurstCap() {
    while (this.queue.length > RATE_LIMIT.maxBurst) {
      const idx = this.queue.findIndex((it) => it.priority !== "high");
      if (idx < 0) break; // All high, drop nothing
      const [dropped] = this.queue.splice(idx, 1);
      console.warn(`[notification] Queue over capacity, dropping: ${dropped.title}`);
    }
  }

  /** Process the queue sequentially: one at a time, pacing by minInterval. */
  async processQueue() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;

    this.active = true;
    try {
      await this.waitForRateSlot();
      await this.show(item);
      this.lastShownAt = Date.now();
    } catch (e) {
      console.error("[notification] Display failed:", e);
    } finally {
      this.active = false;
    }
    // Continue processing subsequent items
    if (this.queue.length) this.processQueue();
  }

  /** Rate limit: if less than minInterval has passed since the last display, wait to make up the difference. */
  waitForRateSlot() {
    const wait = this.lastShownAt + this.minInterval - Date.now();
    if (wait <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, wait));
  }

  /** Display a single item + persist to history + bind the click route. */
  async show(item) {
    // Persist to history first (even if the system doesn't pop it, the notification center still shows it -- satisfying "offline cache + recovery").
    try {
      await appendRecord(item);
      this.broadcast("notify:changed");
    } catch (e) {
      console.error("[notification] Failed to write history:", e);
    }

    await this.adapter.show(item, {
      onClick: (it) => this.handleClick(it),
      onAction: (it, index) => this.handleAction(it, index),
    });
  }

  /** Click a notification: bring the main window forward and dispatch route:navigate (Deep Link, §7). */
  handleClick(item) {
    const route = normalizeRoute(item.route ?? item.url);
    const win = this.getWindow?.();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (route) win.webContents.send("route:navigate", route);
    }
  }

  /** Action button click: dispatch along with the button index; the renderer decides the behavior. */
  handleAction(item, index) {
    const win = this.getWindow?.();
    const action = Array.isArray(item.actions) ? item.actions[index] : undefined;
    win?.webContents.send("notify:action", { id: item.id, index, actionId: action?.actionId });
    // An action also brings the window forward by default, to ease subsequent routing.
    if (win) {
      win.show();
      win.focus();
    }
  }
}

/** Merged body: keep the first item's body and append the update count. */
function mergedBody(item, count) {
  const base = item.title || item.body || "Update";
  return `${base} (${count} updates)`;
}

/**
 * Normalize a click target into an in-app route usable by the renderer:
 *   - "/task/123"            → unchanged
 *   - "notify://open/task/1" → "/task/1"
 *   - http(s) external link  → returns null (no in-app navigation; leave it to the renderer/external browser)
 */
function normalizeRoute(target) {
  if (!target || typeof target !== "string") return null;
  if (target.startsWith("/")) return target;
  const m = target.match(/^notify:\/\/open(\/.*)$/);
  if (m) return m[1];
  return null;
}
