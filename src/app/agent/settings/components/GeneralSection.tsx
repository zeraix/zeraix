"use client";

import { useEffect, useState } from "react";
import { Activity, Database, FileCog } from "lucide-react";
import { chooseStorePath, getStorePath, isFileStoreAvailable, setStorePath } from "@/lib/ai/conversation";
import { isAppConfigAvailable, openAppConfigFile } from "@/lib/ai/appConfig";
import {
  type BackgroundState,
  getBackgroundState,
  setBackgroundEnabled,
  setBackgroundOpenAtLogin,
} from "@/lib/background";
import { useAgentChatStore } from "@/store/agentChatStore";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "./ToggleSwitch";

/** General section: data storage path. */
export function GeneralSection({ t }: { t: TFunc }) {
  const reload = useAgentChatStore((s) => s.reload);
  const [path, setPath] = useState("");
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [configurable, setConfigurable] = useState(false);
  const [appConfigOk, setAppConfigOk] = useState(false);
  const [appConfigMsg, setAppConfigMsg] = useState<string | null>(null);
  // Background / tray mode. `null` = desktop bridge absent (web build) -> the whole block is hidden.
  const [bg, setBg] = useState<BackgroundState | null>(null);

  useEffect(() => {
    setConfigurable(isFileStoreAvailable());
    setAppConfigOk(isAppConfigAvailable());
    void getBackgroundState().then(setBg);
    void getStorePath().then((p) => {
      if (p) {
        setPath(p);
        setInput(p);
      }
    });
  }, []);

  const onChanged = async (dir: string) => {
    setPath(dir);
    setInput(dir);
    setMsg(`${t("general.setOk")}${dir}`);
    await reload();
  };
  const apply = async () => {
    const dir = input.trim();
    if (!dir || !configurable) return;
    setMsg(null);
    try {
      const file = await setStorePath(dir);
      if (file) await onChanged(file);
    } catch (e) {
      setMsg(`${t("general.setFail")}${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const browse = async () => {
    if (!configurable) return;
    setMsg(null);
    try {
      const file = await chooseStorePath();
      if (file) await onChanged(file);
    } catch (e) {
      setMsg(`${t("general.chooseFail")}${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const openAppConfig = async () => {
    setAppConfigMsg(null);
    const res = await openAppConfigFile();
    if (!res.ok) setAppConfigMsg(`${t("general.appConfigOpenFail")}${res.error ?? ""}`);
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-5 text-xl font-bold text-ink">{t("settings.general")}</h2>

      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Database className="size-4 text-ink-muted" />
        {t("general.storage")}
      </p>
      {configurable ? (
        <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
          <p className="mb-2 text-xs text-ink-subtle">{t("general.storageDesc")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void apply();
                }
              }}
              placeholder={t("general.dirPlaceholder")}
              className="min-w-[220px] flex-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 font-mono text-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10"
            />
            <button
              onClick={() => void browse()}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
            >
              {t("general.chooseDir")}
            </button>
            <button
              onClick={() => void apply()}
              disabled={!input.trim()}
              className="shrink-0 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {t("general.apply")}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("general.current")}
            <span className="break-all font-mono text-ink-muted">{path || t("general.default")}</span>
            {t("general.migrateNote")}
          </p>
          {msg && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{msg}</p>}
        </div>
      ) : (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("general.unsupported")}
        </p>
      )}

      {/* app.config: open the persisted config file in the system's default editor (desktop app only). */}
      {appConfigOk && (
        <div className="mt-6">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <FileCog className="size-4 text-ink-muted" />
            {t("general.appConfig")}
          </p>
          <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
            <p className="mb-2 text-xs text-ink-subtle">{t("general.appConfigDesc")}</p>
            <button
              onClick={() => void openAppConfig()}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
            >
              {t("general.appConfigOpen")}
            </button>
            {appConfigMsg && (
              <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{appConfigMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* Background / tray mode: desktop only. Scheduled automations cannot fire while the app is
          not running, so this is the setting that makes the automation scheduler useful at all. */}
      {bg && (
        <>
          <p className="mb-2 mt-6 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Activity className="size-4 text-ink-muted" />
            {t("general.background")}
          </p>
          <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
            <p className="mb-3 text-xs text-ink-subtle">{t("general.backgroundDesc")}</p>
            {bg.traySupported ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">{t("general.backgroundEnable")}</p>
                    <p className="text-xs text-ink-subtle">{t("general.backgroundEnableDesc")}</p>
                  </div>
                  <ToggleSwitch
                    on={bg.enabled}
                    label={t("general.backgroundEnable")}
                    onChange={(v) => {
                      // Optimistic: the main process is the source of truth, but disabling background
                      // mode also clears autostart there, so mirror that here to stay consistent.
                      setBg({ ...bg, enabled: v, openAtLogin: v ? bg.openAtLogin : false });
                      // Enabling can still be refused (no system tray) -- reconcile with the result
                      // rather than leaving the toggle showing a state the main process rejected.
                      void setBackgroundEnabled(v).then((actual) => {
                        if (actual !== v) void getBackgroundState().then(setBg);
                      });
                    }}
                  />
                </div>
                <div
                  className={cn(
                    "mt-3 flex items-center justify-between gap-4 border-t border-line pt-3 transition",
                    !bg.enabled && "pointer-events-none opacity-40",
                  )}
                >
                  <div>
                    <p className="text-sm font-medium text-ink">{t("general.backgroundAutostart")}</p>
                    <p className="text-xs text-ink-subtle">{t("general.backgroundAutostartDesc")}</p>
                  </div>
                  <ToggleSwitch
                    on={bg.openAtLogin}
                    label={t("general.backgroundAutostart")}
                    onChange={(v) => {
                      setBg({ ...bg, openAtLogin: v });
                      void setBackgroundOpenAtLogin(v);
                    }}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("general.backgroundUnsupported")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
