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
import { Group, LIST, PANEL, Pane, Row, WARN_NOTE } from "./pane";

/**
 * Notification sounds section: customize the system-notification sound per type (info/success/warning/error).
 * Master switch + volume + per-type toggle / preview / upload custom sound / reset to default. Config is stored locally (localStorage).
 */
export const NOTIFY_TYPE_META: {
  type: NotifyType;
  labelKey: string;
  className: string;
}[] = [
  { type: "info", labelKey: "notify.typeInfo", className: "bg-info/15 text-info-ink border-info/30" },
  { type: "success", labelKey: "notify.typeSuccess", className: "bg-success/15 text-success-ink border-success/30" },
  { type: "warning", labelKey: "notify.typeWarning", className: "bg-warning/15 text-warning-ink border-warning/30" },
  { type: "error", labelKey: "notify.typeError", className: "bg-danger/15 text-danger-ink border-danger/30" },
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
    <Pane title={t("settings.notify")} desc={t("notify.desc")}>
      {!available && <p className={WARN_NOTE}>{t("notify.unsupported")}</p>}

      {/* Notification reminders: round complete / permission / question */}
      <Group title={t("notify.remindersTitle")} anchor="notify/reminders">
        <div className={LIST}>
          {/* Round-complete notification (dropdown: never / only when the app is unfocused / always) */}
          <Row title={t("notify.roundComplete")} desc={t("notify.roundCompleteDesc")}>
            <select
              value={prefs.replyCompleteMode}
              onChange={(e) => patchPrefs({ replyCompleteMode: e.target.value as ReplyCompleteMode })}
              className={cn(FIELD_CLS, "shrink-0")}
            >
              <option value="never">{t("notify.mode.never")}</option>
              <option value="unfocused">{t("notify.mode.unfocused")}</option>
              <option value="always">{t("notify.mode.always")}</option>
            </select>
          </Row>
          {/* Enable permission notifications */}
          <Row title={t("notify.permission")} desc={t("notify.permissionDesc")}>
            <ToggleSwitch
              on={prefs.permissionEnabled}
              onChange={(v) => patchPrefs({ permissionEnabled: v })}
              label={t("notify.permission")}
            />
          </Row>
          {/* Enable question notifications */}
          <Row title={t("notify.question")} desc={t("notify.questionDesc")}>
            <ToggleSwitch
              on={prefs.questionEnabled}
              onChange={(v) => patchPrefs({ questionEnabled: v })}
              label={t("notify.question")}
            />
          </Row>
        </div>
      </Group>

      {/* Notification sounds */}
      <Group title={t("notify.soundsTitle")} anchor="notify/sounds">
        {/* Master switch + volume */}
        <div className={cn(PANEL, "mb-3")}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{t("notify.master")}</p>
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
      </Group>
    </Pane>
  );
}
