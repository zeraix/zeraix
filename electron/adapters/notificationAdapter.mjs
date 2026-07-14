/**
 * 平台适配层（设计文档 §4）：把统一的 NotificationItem 落到具体 OS 通知 API。
 *
 * 默认实现 ElectronNotificationAdapter 使用 Electron 内置 `Notification`，它已跨平台封装：
 *   - Windows：Toast（需 app.setAppUserModelId，见 main.mjs）
 *   - macOS：UNUserNotificationCenter，支持 action buttons
 *   - Linux：libnotify，支持 urgency
 * 适配层只负责「显示 + 事件回调」，不做排队 / 限流 / 持久化（那是 NotificationService 的职责）。
 * 抽象接口：`show(item, handlers) => Promise<void>`（Promise 在通知已弹出后即兑现，不等待用户交互）。
 */
import { Notification } from "electron";
import fs from "node:fs";

/** 当前系统是否支持原生通知（Linux 无通知守护进程等情况会为 false）。 */
export function isNotificationSupported() {
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}

/** priority → Linux urgency 映射（其它平台忽略）。 */
function mapUrgency(priority) {
  if (priority === "high") return "critical";
  if (priority === "low") return "low";
  return "normal";
}

export class ElectronNotificationAdapter {
  /** @param {{ iconPath?: string }} opts 通知图标绝对路径（不存在则不设，走系统默认）。 */
  constructor({ iconPath } = {}) {
    this.iconPath = iconPath && safeExists(iconPath) ? iconPath : undefined;
  }

  /**
   * 显示一条通知。
   * @param {object} item NotificationItem
   * @param {{ onClick?, onAction?, onClose?, onFailed? }} handlers 事件回调
   * @returns {Promise<void>} 通知弹出后兑现（不阻塞等待用户点击 / 关闭）
   */
  show(item, { onClick, onAction, onClose, onFailed } = {}) {
    return new Promise((resolve) => {
      let n;
      try {
        n = new Notification({
          title: item.title,
          body: item.body,
          silent: !!item.silent,
          icon: this.iconPath,
          urgency: mapUrgency(item.priority), // Linux
          // macOS 专属：动作按钮。其它平台自动忽略 actions。
          actions: Array.isArray(item.actions)
            ? item.actions.map((a) => ({ type: "button", text: String(a.text ?? "") }))
            : undefined,
          // 高优先级不自动消失（可用），其余走系统默认。
          timeoutType: item.priority === "high" ? "never" : "default",
        });
      } catch (e) {
        console.warn("[notification] 构造通知失败：", e?.message || e);
        onFailed?.(item, e);
        resolve();
        return;
      }

      n.on("click", () => onClick?.(item));
      n.on("action", (_e, index) => onAction?.(item, index));
      n.on("close", () => onClose?.(item));
      n.on("failed", (_e, error) => {
        console.warn("[notification] 系统拒绝显示：", error);
        onFailed?.(item, error);
      });

      try {
        n.show();
      } catch (e) {
        console.warn("[notification] show() 失败：", e?.message || e);
        onFailed?.(item, e);
      }
      // 通知已交给系统；下一 tick 兑现，让 Service 的限流节拍接管队列推进。
      setImmediate(resolve);
    });
  }
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
