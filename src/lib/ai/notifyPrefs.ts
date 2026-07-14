/**
 * System notification behavior preferences (separate from the notifySound chime).
 *
 * Maps to the three items in the settings page's "Notifications" section:
 *   - Reply-complete notification (replyCompleteMode): a reminder when the AI finishes a task — never / only when the app is unfocused / always
 *   - Enable permission notifications (permissionEnabled): remind when the AI needs authorization to perform a sensitive operation
 *   - Enable question notifications (questionEnabled): remind when the AI needs user input to continue (ask_user)
 * The config is persisted in localStorage (STORAGE_KEY.notifyPrefs).
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import STORAGE_KEY from "@/constants/Storage";

/** Trigger mode for reply-complete notifications. */
export type ReplyCompleteMode = "never" | "unfocused" | "always";

export interface NotifyPrefs {
  replyCompleteMode: ReplyCompleteMode;
  permissionEnabled: boolean;
  questionEnabled: boolean;
}

/** Defaults: reply-complete notification only when the app is unfocused; permission/question notifications both on (matches the design mockups). */
export function defaultNotifyPrefs(): NotifyPrefs {
  return {
    replyCompleteMode: "unfocused",
    permissionEnabled: true,
    questionEnabled: true,
  };
}

const MODES: ReplyCompleteMode[] = ["never", "unfocused", "always"];

/** Read the preferences (missing / corrupt → defaults, with a per-field fallback). */
export function getNotifyPrefs(): NotifyPrefs {
  const def = defaultNotifyPrefs();
  try {
    const raw = getStorage(STORAGE_KEY.notifyPrefs) as Partial<NotifyPrefs> | null;
    if (!raw || typeof raw !== "object") return def;
    return {
      replyCompleteMode: MODES.includes(raw.replyCompleteMode as ReplyCompleteMode)
        ? (raw.replyCompleteMode as ReplyCompleteMode)
        : def.replyCompleteMode,
      permissionEnabled: typeof raw.permissionEnabled === "boolean" ? raw.permissionEnabled : def.permissionEnabled,
      questionEnabled: typeof raw.questionEnabled === "boolean" ? raw.questionEnabled : def.questionEnabled,
    };
  } catch {
    return def;
  }
}

/** Overwrite the stored preferences. */
export function setNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    setStorage(STORAGE_KEY.notifyPrefs, prefs);
  } catch {
    /* ignore write failures */
  }
}

/** Partially update the preferences and persist them, returning the new config. */
export function updateNotifyPrefs(patch: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...getNotifyPrefs(), ...patch };
  setNotifyPrefs(next);
  return next;
}
