"use client";

import { useEffect, useState } from "react";
import { Activity, Database, FileCog, Gauge } from "lucide-react";
import { chooseStorePath, getStorePath, isFileStoreAvailable, setStorePath } from "@/lib/ai/conversation";
import { isAppConfigAvailable, openAppConfigFile } from "@/lib/ai/appConfig";
import {
  DEFAULT_CONTEXT_BUDGET_K,
  MAX_CONTEXT_BUDGET_K,
  MIN_CONTEXT_BUDGET_K,
  getContextBudgetK,
  restoreBudgetK,
  setContextBudgetK,
} from "@/lib/ai/contextBudget";
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
import { useImeGuard } from "@/lib/ime";

/** General section: data storage path. */
export function GeneralSection({ t }: { t: TFunc }) {
  const ime = useImeGuard();
  const reload = useAgentChatStore((s) => s.reload);
  const [path, setPath] = useState("");
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [configurable, setConfigurable] = useState(false);
  const [appConfigOk, setAppConfigOk] = useState(false);
  const [appConfigMsg, setAppConfigMsg] = useState<string | null>(null);
  // Background / tray mode. `null` = desktop bridge absent (web build) -> the whole block is hidden.
  const [bg, setBg] = useState<BackgroundState | null>(null);
  // Absolute context working-set budget (K tokens); "" input is treated as 0 = off.
  const [budgetK, setBudgetK] = useState(DEFAULT_CONTEXT_BUDGET_K);
  const [budgetInput, setBudgetInput] = useState(String(DEFAULT_CONTEXT_BUDGET_K));
  /**
   * The budget to restore when the cap is switched back on.
   *
   * State rather than a ref: this is read during render (by the toggle) and the lint rule that forbids
   * mutating a ref is right to — a value the UI depends on should not change without a render. Kept so that
   * toggling off and on again does not silently reset a tuned budget to the default.
   */
  const [lastPositiveK, setLastPositiveK] = useState(DEFAULT_CONTEXT_BUDGET_K);

  useEffect(() => {
    setConfigurable(isFileStoreAvailable());
    setAppConfigOk(isAppConfigAvailable());
    void getBackgroundState().then(setBg);
    const b = getContextBudgetK();
    if (b > 0) setLastPositiveK(b);
    setBudgetK(b);
    setBudgetInput(String(b));
    void getStorePath().then((p) => {
      if (p) {
        setPath(p);
        setInput(p);
      }
    });
  }, []);


  const applyBudget = () => {
    const n = Math.round(Number(budgetInput));
    setContextBudgetK(!Number.isFinite(n) || n <= 0 ? 0 : n);
    const eff = getContextBudgetK(); // clamped/normalized by the store
    if (eff > 0) setLastPositiveK(eff);
    setBudgetK(eff);
    setBudgetInput(String(eff));
  };

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
    <div className="max-w-2xl mx-auto">
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
              {...ime.bind}
              onKeyDown={(e) => {
                if (ime.isImeKey(e)) return; // a path can be typed on an IME — see lib/ime.ts
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
          {msg && <p className="mt-1 text-[11px] text-warning-ink">{msg}</p>}
        </div>
      ) : (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("general.unsupported")}
        </p>
      )}

      {/* Context working-set budget: caps auto-compaction at an absolute token budget so large-window
          models don't hoard hundreds of thousands of tokens. Available in every build (localStorage pref). */}
      <div className="mt-6">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Gauge className="size-4 text-ink-muted" />
          {t("general.contextBudget")}
        </p>
        <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
          <p className="mb-2 text-xs text-ink-subtle">{t("general.contextBudgetDesc")}</p>
          {/* An explicit switch, because "type 0 to disable" is a rule you have to already know. The number
              stays the way to TUNE the cap; this is the way to turn it off, and toggling back on restores the
              value rather than the default. */}
          <label className="mb-2.5 flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={budgetK > 0}
              onChange={(e) => {
                // `restoreBudgetK`, not `lastPositiveK` directly: on a fresh install nothing positive has been
                // seen yet, and switching the cap ON with the default (0) switched it off instead — the box
                // un-ticked itself and the number field stayed disabled, so the control could never be used.
                const next = e.target.checked ? restoreBudgetK(lastPositiveK) : 0;
                setContextBudgetK(next);
                const eff = getContextBudgetK();
                setBudgetK(eff);
                setBudgetInput(String(eff));
              }}
              className="size-3.5 accent-primary"
            />
            {t("general.contextBudgetEnabled")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              disabled={budgetK <= 0}
              max={MAX_CONTEXT_BUDGET_K}
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyBudget();
                }
              }}
              onBlur={applyBudget}
              placeholder="0"
              className="w-24 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs tabular-nums outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="text-xs text-ink-subtle">{t("general.contextBudgetUnit")}</span>
            <button
              onClick={applyBudget}
              disabled={budgetK <= 0}
              className="shrink-0 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("general.apply")}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("general.current")}
            <span className="font-mono text-ink-muted">
              {budgetK > 0 ? `${budgetK} ${t("general.contextBudgetUnit")}` : t("general.contextBudgetOff")}
            </span>
            {budgetK > 0 && budgetK < MIN_CONTEXT_BUDGET_K ? ` (min ${MIN_CONTEXT_BUDGET_K})` : ""}
          </p>
        </div>
      </div>

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
              <p className="mt-2 text-[11px] text-warning-ink">{appConfigMsg}</p>
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
              <p className="text-xs text-warning-ink">
                {t("general.backgroundUnsupported")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
