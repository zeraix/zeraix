/**
 * Platform adapter layer (design doc §4): maps the unified NotificationItem onto the concrete OS notification API.
 *
 * The default implementation ElectronNotificationAdapter uses Electron's built-in `Notification`, which is already cross-platform:
 *   - Windows: Toast (requires app.setAppUserModelId, see main.mjs)
 *   - macOS: UNUserNotificationCenter, supports action buttons
 *   - Linux: libnotify, supports urgency
 * The adapter only handles "display + event callbacks"; it does no queuing / rate-limiting / persistence (that's NotificationService's job).
 * Abstract interface: `show(item, handlers) => Promise<void>` (the Promise resolves once the notification has popped, without waiting for user interaction).
 */
import { Notification } from "electron";
import fs from "node:fs";

/** Whether the current system supports native notifications (false on e.g. Linux without a notification daemon). */
export function isNotificationSupported() {
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}

/** priority → Linux urgency mapping (ignored on other platforms). */
function mapUrgency(priority) {
  if (priority === "high") return "critical";
  if (priority === "low") return "low";
  return "normal";
}

export class ElectronNotificationAdapter {
  /** @param {{ iconPath?: string }} opts Absolute path to the notification icon (if it doesn't exist, leave unset and use the system default). */
  constructor({ iconPath } = {}) {
    this.iconPath = iconPath && safeExists(iconPath) ? iconPath : undefined;
  }

  /**
   * Display a single notification.
   * @param {object} item NotificationItem
   * @param {{ onClick?, onAction?, onClose?, onFailed? }} handlers Event callbacks
   * @returns {Promise<void>} Resolves once the notification has popped (does not block waiting for the user to click / close)
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
          // macOS-specific: action buttons. Other platforms ignore actions automatically.
          actions: Array.isArray(item.actions)
            ? item.actions.map((a) => ({ type: "button", text: String(a.text ?? "") }))
            : undefined,
          // High priority does not auto-dismiss ("never"); the rest use the system default.
          timeoutType: item.priority === "high" ? "never" : "default",
        });
      } catch (e) {
        console.warn("[notification] Failed to construct notification:", e?.message || e);
        onFailed?.(item, e);
        resolve();
        return;
      }

      n.on("click", () => onClick?.(item));
      n.on("action", (_e, index) => onAction?.(item, index));
      n.on("close", () => onClose?.(item));
      n.on("failed", (_e, error) => {
        console.warn("[notification] System refused to display:", error);
        onFailed?.(item, error);
      });

      try {
        n.show();
      } catch (e) {
        console.warn("[notification] show() failed:", e?.message || e);
        onFailed?.(item, e);
      }
      // The notification has been handed to the system; resolve on the next tick so the Service's rate-limit cadence takes over advancing the queue.
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
