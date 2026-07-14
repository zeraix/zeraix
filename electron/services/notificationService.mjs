/**
 * 系统通知服务（设计文档 §3.3 / §6 / §7）—— 主进程统一入口，解耦渲染层与 OS。
 *
 * 职责：
 *   - 接收通知请求（已由 IPC 层做字段白名单 / 长度 / scheme 净化）
 *   - 排队（顺序显示，避免刷屏）+ 合并（同 groupKey 折叠为「N 条更新」）+ 限流
 *   - 调用平台适配层显示
 *   - 处理点击 → 唤起主窗口并下发 route:navigate（Deep Link）
 *   - 写入历史（通知中心数据层）并广播 notify:changed
 *
 * 限流（设计文档 §6.1）：maxPerSecond 控制显示节拍，maxBurst 限制积压队列上限
 * （超出丢弃最旧的非 high 优先级项，防止无限堆积）。
 */
import { appendRecord } from "../store/notificationStore.mjs";

const RATE_LIMIT = { maxPerSecond: 3, maxBurst: 10 };

export class NotificationService {
  /**
   * @param {object} deps
   * @param {import("../adapters/notificationAdapter.mjs").ElectronNotificationAdapter} deps.adapter 平台适配器
   * @param {() => (Electron.BrowserWindow | null)} deps.getWindow 取主窗口（点击时唤起 + 路由）
   * @param {(channel: string, payload?: any) => void} [deps.broadcast] 向渲染层广播（如 notify:changed）
   */
  constructor({ adapter, getWindow, broadcast }) {
    this.adapter = adapter;
    this.getWindow = getWindow;
    this.broadcast = broadcast || (() => {});
    this.queue = [];
    this.active = false;
    this.lastShownAt = 0; // 上次显示时间戳（限流节拍）
  }

  /** 显示节拍：两次显示之间的最小间隔（ms）。 */
  get minInterval() {
    return Math.ceil(1000 / RATE_LIMIT.maxPerSecond);
  }

  /** 主窗口当前是否在前台（已聚焦且未最小化）。 */
  isForeground() {
    const win = this.getWindow?.();
    return !!win && !win.isMinimized() && win.isFocused();
  }

  /**
   * 入队一条通知。返回 { id, merged } 或 { id, skipped }。
   * 前置条件（notification-t.md §触发条件前置条件）：带 whenBackground 的通知仅在窗口未聚焦
   * 或已最小化（用户没在看）时才弹；用户正盯着应用时跳过，避免打扰。
   * 合并策略（§6.2）：若队尾未显示项与新项 groupKey 相同，则折叠为一条并累计更新数，
   * 而非各弹一条（典型场景：AI 连续输出）。
   */
  send(item) {
    // 前置条件：仅后台/最小化时通知。用户正在前台查看则直接跳过（不弹、不入历史）。
    if (item.whenBackground && this.isForeground()) {
      return { id: item.id, skipped: true };
    }

    // 合并：与队尾同组则就地更新，不新增队列项。
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

  /** 队列积压超过 maxBurst：丢弃最旧的非 high 优先级项（high 保留），并记日志。 */
  enforceBurstCap() {
    while (this.queue.length > RATE_LIMIT.maxBurst) {
      const idx = this.queue.findIndex((it) => it.priority !== "high");
      if (idx < 0) break; // 全是 high，不丢
      const [dropped] = this.queue.splice(idx, 1);
      console.warn(`[notification] 队列超限，丢弃：${dropped.title}`);
    }
  }

  /** 顺序处理队列：一次一条，按 minInterval 控制节拍。 */
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
      console.error("[notification] 显示失败：", e);
    } finally {
      this.active = false;
    }
    // 继续处理后续项
    if (this.queue.length) this.processQueue();
  }

  /** 限流：距上次显示不足 minInterval 时等待补足。 */
  waitForRateSlot() {
    const wait = this.lastShownAt + this.minInterval - Date.now();
    if (wait <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, wait));
  }

  /** 显示单条 + 落历史 + 绑定点击路由。 */
  async show(item) {
    // 先落历史（即便系统不弹，通知中心仍可见 —— 满足「离线缓存 + 恢复」）。
    try {
      await appendRecord(item);
      this.broadcast("notify:changed");
    } catch (e) {
      console.error("[notification] 写历史失败：", e);
    }

    await this.adapter.show(item, {
      onClick: (it) => this.handleClick(it),
      onAction: (it, index) => this.handleAction(it, index),
    });
  }

  /** 点击通知：唤起主窗口并下发 route:navigate（Deep Link，§7）。 */
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

  /** 动作按钮点击：连同按钮索引下发，渲染层自行决定行为。 */
  handleAction(item, index) {
    const win = this.getWindow?.();
    const action = Array.isArray(item.actions) ? item.actions[index] : undefined;
    win?.webContents.send("notify:action", { id: item.id, index, actionId: action?.actionId });
    // 动作默认也唤起窗口，便于后续路由。
    if (win) {
      win.show();
      win.focus();
    }
  }
}

/** 合并后的正文：保留首条正文并附加更新计数。 */
function mergedBody(item, count) {
  const base = item.title || item.body || "更新";
  return `${base}（${count} 条更新）`;
}

/**
 * 归一化点击目标为渲染层可用的应用内路由：
 *   - "/task/123"           → 原样
 *   - "notify://open/task/1" → "/task/1"
 *   - http(s) 外链           → 返回 null（不做应用内跳转，交由渲染层/外部浏览器处理）
 */
function normalizeRoute(target) {
  if (!target || typeof target !== "string") return null;
  if (target.startsWith("/")) return target;
  const m = target.match(/^notify:\/\/open(\/.*)$/);
  if (m) return m[1];
  return null;
}
