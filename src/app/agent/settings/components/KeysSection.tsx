"use client";

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useLoginModalStore } from "@/store/loginModalStore";
import { Toast } from "@/lib/toast";
import {
  apiKeyRefOf,
  getApiKeyByRef,
  loadModelList,
  OFFICIAL_PROVIDER_ID,
  PROVIDERS,
  setApiKeyByRef,
  setPlatformApiKey,
} from "@/lib/ai/models";
import { type ApiKeyInfo, getApiKey, regenerateApiKey } from "@/lib/api/agent";
import { saveOfficialApiKeyToConfig } from "@/lib/ai/appConfig";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fmtDate } from "./formatDate";
import { FIELD_CLS, PRIMARY_BTN } from "./styles";

/** API keys section: configure a key for each provider / custom model in the list (shared by both official and custom models). */
export function KeysSection({ t }: { t: TFunc }) {
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  // Local provider / custom model keys (excludes official — official is managed by the platform API).
  const [keys, setKeys] = useState<Record<string, string>>({});
  const groups: { ref: string; label: string }[] = [];
  {
    const seen = new Set<string>();
    for (const m of loadModelList()) {
      const ref = apiKeyRefOf(m);
      if (ref === OFFICIAL_PROVIDER_ID || seen.has(ref)) continue;
      seen.add(ref);
      groups.push({
        ref,
        label: m.custom ? m.label : (PROVIDERS.find((p) => p.id === m.providerId)?.label ?? m.providerId),
      });
    }
  }

  useEffect(() => {
    const k: Record<string, string> = {};
    const seen = new Set<string>();
    for (const m of loadModelList()) {
      const ref = apiKeyRefOf(m);
      if (ref === OFFICIAL_PROVIDER_ID || seen.has(ref)) continue;
      seen.add(ref);
      k[ref] = getApiKeyByRef(ref);
    }
    setKeys(k);
  }, []);

  const onChange = (ref: string, v: string) => {
    setKeys((prev) => ({ ...prev, [ref]: v }));
    setApiKeyByRef(ref, v);
  };

  // Official API key (issued by the platform account; getApiKey returns a list; regenerateApiKey creates / rotates it).
  const [official, setOfficial] = useState<ApiKeyInfo[]>([]);
  const [okState, setOkState] = useState<"loading" | "ready" | "error">("loading");
  const [okError, setOkError] = useState("");
  const [okBusy, setOkBusy] = useState(false);

  const loadOfficial = () => {
    setOkState("loading");
    getApiKey()
      .then((res) => {
        if (!res.success) {
          setOkError(res.error || res.message || "");
          setOkState("error");
          return;
        }
        // Handle the backend returning either a single object or a list.
        const raw = res.data as unknown;
        const arr: ApiKeyInfo[] = Array.isArray(raw) ? (raw as ApiKeyInfo[]) : raw ? [raw as ApiKeyInfo] : [];
        setOfficial(arr);
        // Persist the first plaintext key locally (for sending with official models), and explicitly write it to app.config every time.
        const active = arr.find((k) => k.key);
        if (active?.key) {
          setPlatformApiKey(active.key);
          saveOfficialApiKeyToConfig(active.key);
        }
        setOkState("ready");
      })
      .catch((e) => {
        setOkError(String(e));
        setOkState("error");
      });
  };
  useEffect(() => {
    loadOfficial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generating / rotating the official API key is account-bound: prompt login first.
  const regenerate = async () => {
    if (!(await requireLogin())) return;
    setOkBusy(true);
    regenerateApiKey()
      .then((res) => {
        // On successful regeneration: persist locally and explicitly write to app.config.
        if (res.success && res.data?.key) {
          setPlatformApiKey(res.data.key);
          saveOfficialApiKeyToConfig(res.data.key);
          Toast.success(t("keys.regenSuccess"));
        } else {
          Toast.error(t("keys.regenFailed"));
        }
        loadOfficial();
      })
      .catch(() => {
        Toast.error(t("keys.regenFailed"));
      })
      .finally(() => setOkBusy(false));
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-2 text-xl font-bold text-ink">{t("settings.keys")}</h2>
      <p className="mb-5 text-xs text-ink-subtle">{t("keys.desc")}</p>

      {/* Official API key */}
      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-ink">{t("keys.official")}</p>
          <button type="button" onClick={regenerate} disabled={okBusy} className={cn(PRIMARY_BTN, "h-[30px]")}>
            <RotateCcw className="size-3.5" />
            {official.length ? t("keys.regenerate") : t("keys.generate")}
          </button>
        </div>
        <p className="mb-2 text-[11px] text-ink-subtle">{t("keys.officialDesc")}</p>
        {okState === "loading" ? (
          <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
            {t("models.loading")}
          </p>
        ) : okState === "error" ? (
          <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-amber-600 dark:text-amber-400">
            {t("keys.officialError")}
            {okError ? ` (${okError})` : ""}
          </p>
        ) : official.length === 0 ? (
          <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
            {t("keys.officialEmpty")}
          </p>
        ) : (
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
            {official.map((k, i) => (
              <div key={k.id ?? i} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-ink">
                    {k.key ?? `${k.keyPrefix ?? ""}••••••••`}
                  </p>
                  <p className="truncate text-[11px] text-ink-subtle">
                    {t("keys.created")}
                    {fmtDate(k.createdAt) || t("keys.never")} · {t("keys.lastUsed")}
                    {fmtDate(k.lastUsedAt) || t("keys.never")}
                  </p>
                </div>
                {k.key && (
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(k.key ?? "")}
                    className="shrink-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted"
                  >
                    {t("keys.copy")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Provider / custom model keys (saved locally) */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("keys.localTitle")}</p>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("keys.empty")}
        </p>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
          {groups.map((g) => (
            <div key={g.ref} className="px-4 py-3">
              <label className="mb-1.5 block text-sm font-medium text-ink">
                {t("keys.forProvider")} {g.label}
              </label>
              <input
                type="password"
                autoComplete="off"
                value={keys[g.ref] ?? ""}
                onChange={(e) => onChange(g.ref, e.target.value)}
                placeholder={t("keys.placeholder")}
                className={cn(FIELD_CLS, "w-full font-mono text-xs")}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
