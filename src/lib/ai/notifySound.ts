/**
 * System notification sounds (customizable per type).
 *
 * Each notification type (info/success/warning/error) can independently: be toggled on/off, and choose a sound source (the built-in
 * default or a user-uploaded custom audio, the latter stored locally as a data URL). The default sound source is /sounds/notify.mp3.
 * The config is persisted in localStorage (STORAGE_KEY.notifySound) and edited visually on the settings page.
 *
 * Playback happens in the renderer layer via HTMLAudioElement: when a type has a custom sound enabled, the OS notification emitted by the main process
 * is set to silent (to avoid overlapping with the system default sound), and this module plays it per config instead (see lib/electron/notification.ts).
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import STORAGE_KEY from "@/constants/Storage";

export type NotifyType = "info" | "success" | "warning" | "error";
export const NOTIFY_TYPES: NotifyType[] = ["info", "success", "warning", "error"];

/** Built-in notification sounds (public/sounds/). info/success use notify, warning/error use error. */
export const NOTIFY_SOUND_SRC = "/sounds/notify.mp3";
export const ERROR_SOUND_SRC = "/sounds/error.mp3";

/** Built-in default sound source for each type. */
export const DEFAULT_SOUND_BY_TYPE: Record<NotifyType, string> = {
  info: NOTIFY_SOUND_SRC,
  success: NOTIFY_SOUND_SRC,
  warning: ERROR_SOUND_SRC,
  error: ERROR_SOUND_SRC,
};

/** Built-in default sound source for a type (unknown types fall back to notify). */
export function defaultSoundFor(type: NotifyType): string {
  return DEFAULT_SOUND_BY_TYPE[type] ?? NOTIFY_SOUND_SRC;
}

export interface TypeSound {
  /** Whether this type plays a custom notification sound (if off, defer to the system default notification sound). */
  enabled: boolean;
  /** Sound source: the default built-in path or a user-uploaded data URL. */
  src: string;
}

export interface NotifySoundConfig {
  /** Master switch: if off, no type plays a custom sound (fall back to the system default). */
  enabled: boolean;
  /** Volume 0~1. */
  volume: number;
  perType: Record<NotifyType, TypeSound>;
}

/** Default config: master switch on, volume 0.7, all four types enabled with default sounds. */
export function defaultNotifySoundConfig(): NotifySoundConfig {
  return {
    enabled: true,
    volume: 0.7,
    perType: {
      info: { enabled: true, src: defaultSoundFor("info") },
      success: { enabled: true, src: defaultSoundFor("success") },
      warning: { enabled: true, src: defaultSoundFor("warning") },
      error: { enabled: true, src: defaultSoundFor("error") },
    },
  };
}

/** Read the config (missing / corrupted → default; also applies field-level fallbacks for the old structure). */
export function getNotifySoundConfig(): NotifySoundConfig {
  const def = defaultNotifySoundConfig();
  try {
    const raw = getStorage(STORAGE_KEY.notifySound) as Partial<NotifySoundConfig> | null;
    if (!raw || typeof raw !== "object") return def;
    const perType = { ...def.perType };
    for (const ty of NOTIFY_TYPES) {
      const t = raw.perType?.[ty];
      if (t && typeof t === "object") {
        perType[ty] = {
          enabled: typeof t.enabled === "boolean" ? t.enabled : true,
          src: typeof t.src === "string" && t.src ? t.src : defaultSoundFor(ty),
        };
      }
    }
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : def.enabled,
      volume: typeof raw.volume === "number" ? Math.min(1, Math.max(0, raw.volume)) : def.volume,
      perType,
    };
  } catch {
    return def;
  }
}

/** Overwrite the config. */
export function setNotifySoundConfig(cfg: NotifySoundConfig): void {
  try {
    setStorage(STORAGE_KEY.notifySound, cfg);
  } catch {
    /* Ignore write failure */
  }
}

/** Update a type's notification-sound settings and persist, returning the new config. */
export function updateTypeSound(type: NotifyType, patch: Partial<TypeSound>): NotifySoundConfig {
  const cfg = getNotifySoundConfig();
  cfg.perType[type] = { ...cfg.perType[type], ...patch };
  setNotifySoundConfig(cfg);
  return cfg;
}

/** Whether this type will currently play a custom notification sound (both master switch and type switch on). Used to decide whether to silence the OS notification. */
export function isCustomSoundActive(type: NotifyType): boolean {
  const cfg = getNotifySoundConfig();
  return cfg.enabled && !!cfg.perType[type]?.enabled;
}

/**
 * Play a notification sound by type. Only sounds when the custom sound is active; stays silent (no-op) if the master switch / type switch is off.
 * Playback failures (autoplay policy / missing audio) are swallowed silently and never thrown.
 */
export function playNotifySound(type: NotifyType): void {
  if (typeof window === "undefined") return;
  const cfg = getNotifySoundConfig();
  const t = cfg.perType[type];
  if (!cfg.enabled || !t?.enabled) return;
  try {
    const audio = new Audio(t.src || defaultSoundFor(type));
    audio.volume = cfg.volume;
    void audio.play().catch(() => {
      /* Ignore autoplay restrictions / load failures */
    });
  } catch {
    /* Ignore */
  }
}
