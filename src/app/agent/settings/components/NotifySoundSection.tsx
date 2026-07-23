"use client";

import { useEffect, useState } from "react";
import { Play, RotateCcw, Upload, Volume2 } from "lucide-react";
import {
  defaultSoundFor,
  getNotifySoundConfig,
  type NotifySoundConfig,
  type NotifyType,
  playNotifySound,
  setNotifySoundConfig,
  updateTypeSound,
} from "@/lib/ai/notifySound";
import { isNotificationAvailable } from "@/lib/electron/notification";
import {
  getNotifyPrefs,
  type NotifyPrefs,
  type ReplyCompleteMode,
  updateNotifyPrefs,
} from "@/lib/ai/notifyPrefs";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "./ToggleSwitch";
import { FIELD_CLS } from "./styles";

/**
 * Notification sounds section: customize the system-notification sound per type (info/success/warning/error).
 * Master switch + volume + per-type toggle / preview / upload custom sound / reset to default. Config is stored locally (localStorage).
 */
export const NOTIFY_TYPE_META: {
  type: NotifyType;
  labelKey: string;
  className: string;
}[] = [
  { type: "info", labelKey: "notify.typeInfo", className: "bg-sky-500/15 text-sky-500 border-sky-500/30" },
  { type: "success", labelKey: "notify.typeSuccess", className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
  { type: "warning", labelKey: "notify.typeWarning", className: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  { type: "error", labelKey: "notify.typeError", className: "bg-red-500/15 text-red-500 border-red-500/30" },
];


export function NotifySoundSection({ t }: { t: TFunc }) {
  const [cfg, setCfg] = useState<NotifySoundConfig | null>(null);
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const available = isNotificationAvailable();

  useEffect(() => {
    setCfg(getNotifySoundConfig());
    setPrefs(getNotifyPrefs());
  }, []);

  const patchPrefs = (patch: Partial<NotifyPrefs>) => setPrefs(updateNotifyPrefs(patch));

  if (!cfg || !prefs) return null;

  const patchMaster = (patch: Partial<NotifySoundConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setNotifySoundConfig(next);
  };
  const patchType = (type: NotifyType, patch: Partial<NotifySoundConfig["perType"][NotifyType]>) => {
    setCfg(updateTypeSound(type, patch));
  };
  // Upload a custom sound: read it as a data URL and store it in the config (persisted with local settings).
  const onUpload = (type: NotifyType, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") patchType(type, { src: reader.result });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-1 text-xl font-bold text-ink">{t("settings.notify")}</h2>
      <p className="mb-5 text-sm text-ink-subtle">{t("notify.desc")}</p>

      {!available && (
        <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
          {t("notify.unsupported")}
        </p>
      )}

      {/* Notification reminders: round complete / permission / question */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("notify.remindersTitle")}</p>
      <div className="mb-6 divide-y divide-line rounded-xl border border-line">
        {/* Round-complete notification (dropdown: never / only when the app is unfocused / always) */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("notify.roundComplete")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.roundCompleteDesc")}</p>
          </div>
          <select
            value={prefs.replyCompleteMode}
            onChange={(e) => patchPrefs({ replyCompleteMode: e.target.value as ReplyCompleteMode })}
            className={cn(FIELD_CLS, "shrink-0")}
          >
            <option value="never">{t("notify.mode.never")}</option>
            <option value="unfocused">{t("notify.mode.unfocused")}</option>
            <option value="always">{t("notify.mode.always")}</option>
          </select>
        </div>
        {/* Enable permission notifications */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("notify.permission")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.permissionDesc")}</p>
          </div>
          <ToggleSwitch
            on={prefs.permissionEnabled}
            onChange={(v) => patchPrefs({ permissionEnabled: v })}
            label={t("notify.permission")}
          />
        </div>
        {/* Enable question notifications */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("notify.question")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.questionDesc")}</p>
          </div>
          <ToggleSwitch
            on={prefs.questionEnabled}
            onChange={(v) => patchPrefs({ questionEnabled: v })}
            label={t("notify.question")}
          />
        </div>
      </div>

      {/* Notification sounds */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("notify.soundsTitle")}</p>

      {/* Master switch + volume */}
      <div className="mb-6 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-ink">{t("notify.master")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.masterDesc")}</p>
          </div>
          <ToggleSwitch on={cfg.enabled} onChange={(v) => patchMaster({ enabled: v })} label={t("notify.master")} />
        </div>
        <div className={cn("mt-3 flex items-center gap-3", !cfg.enabled && "pointer-events-none opacity-40")}>
          <Volume2 className="size-4 shrink-0 text-ink-muted" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={cfg.volume}
            onChange={(e) => patchMaster({ volume: Number(e.target.value) })}
            className="h-1.5 flex-1 cursor-pointer accent-primary"
            aria-label={t("notify.volume")}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">
            {Math.round(cfg.volume * 100)}%
          </span>
        </div>
      </div>

      {/* Per-type settings */}
      <div className={cn("space-y-2", !cfg.enabled && "pointer-events-none opacity-40")}>
        {NOTIFY_TYPE_META.map(({ type, labelKey, className }) => {
          const ts = cfg.perType[type];
          const isCustom = ts.src !== defaultSoundFor(type);
          return (
            <div key={type} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
              <span className={cn("shrink-0 rounded border px-2 py-0.5 text-xs font-medium", className)}>
                {t(labelKey)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-subtle">
                {isCustom ? t("notify.custom") : t("notify.builtin")}
              </span>

              {/* Preview */}
              <button
                type="button"
                onClick={() => playNotifySound(type)}
                title={t("notify.preview")}
                className="inline-flex size-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
              >
                <Play className="size-3.5" />
              </button>

              {/* Upload custom sound */}
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted">
                <Upload className="size-3" />
                {t("notify.upload")}
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(type, f);
                    e.target.value = "";
                  }}
                />
              </label>

              {/* Reset to default (shown only when customized) */}
              {isCustom && (
                <button
                  type="button"
                  onClick={() => patchType(type, { src: defaultSoundFor(type) })}
                  title={t("notify.reset")}
                  className="inline-flex size-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              )}

              {/* Toggle for this type */}
              <ToggleSwitch on={ts.enabled} onChange={(v) => patchType(type, { enabled: v })} label={t(labelKey)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
