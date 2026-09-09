"use client";

/**
 * Edit one already-added model, inline under its row in the "Added models" list.
 *
 * Until this existed, a typo in a model ID or a rotated API key could only be fixed by deleting the
 * entry and adding it again — which also threw away the default selection and, for a custom entry,
 * the key stored against its id. So this edits in place: `updateModel` keeps the entry's id, and the
 * key is written to the same ref the entry already resolves through (see apiKeyRefOf).
 *
 * Only the two kinds of entry the user typed in themselves are editable — a third-party catalog
 * model and a custom endpoint. Official platform models come from the platform's own catalog and
 * local models are managed in the Model Library, so neither has fields that belong to the user.
 */

import { useState } from "react";
import {
  apiFormatSuffix,
  apiKeyRefOf,
  getApiKeyByRef,
  OFFICIAL_PROVIDER_ID,
  PROVIDERS,
  setApiKeyByRef,
  splitCustomEndpoint,
  updateModel,
  type AgentModel,
} from "@/lib/ai/models";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "./ToggleSwitch";
import { FIELD_CLS, PRIMARY_BTN } from "./styles";

/** Whether this entry is one the user filled in, and so one they can correct here. */
export function isEditableModel(m: AgentModel): boolean {
  return m.custom || (m.providerId !== OFFICIAL_PROVIDER_ID && m.providerId !== "local");
}

export function ModelEditForm({
  model,
  t,
  onSaved,
  onCancel,
}: {
  model: AgentModel;
  t: TFunc;
  /** Handed the list as it is after the write, so the caller never re-reads storage to catch up. */
  onSaved: (list: AgentModel[]) => void;
  onCancel: () => void;
}) {
  const custom = model.custom;
  // The stored endpoint is already resolved; split it back into the pair the form asks for.
  const [initial] = useState(() =>
    custom ? splitCustomEndpoint(model.endpoint ?? "", model.apiFormat) : { baseUrl: "", fullUrl: false },
  );
  const [label, setLabel] = useState(model.label);
  const [modelId, setModelId] = useState(model.model);
  const [apiFormat, setApiFormat] = useState(model.apiFormat || "openai-chat");
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [fullUrl, setFullUrl] = useState(initial.fullUrl);
  const [multimodal, setMultimodal] = useState(!!model.multimodal);
  const [apiKey, setApiKey] = useState("");

  // Custom entries key by their own id, third-party ones by provider — so the note below has to say
  // which, or a user would edit "the key" here and quietly re-point every model of that vendor.
  const keyRef = apiKeyRefOf(model);
  const hasKey = !!getApiKeyByRef(keyRef);
  const providerLabel = PROVIDERS.find((p) => p.id === model.providerId)?.label ?? model.providerId;

  const valid = !!modelId.trim() && (!custom || !!baseUrl.trim());
  const save = () => {
    if (!valid) return;
    // Blank means "keep what is stored": the field never shows the current key, so treating empty as
    // a deletion would wipe a working key every time someone renamed a model.
    if (apiKey.trim()) setApiKeyByRef(keyRef, apiKey.trim());
    onSaved(
      updateModel(model.id, {
        label,
        model: modelId,
        ...(custom ? { baseUrl, fullUrl, apiFormat, multimodal } : {}),
      }),
    );
  };

  return (
    <div className="space-y-2.5 border-t border-line bg-surface-muted/60 px-4 py-3.5">
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-[170px] flex-1 flex-col gap-1 text-xs text-ink-muted">
          {t("models.displayName")}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={model.model}
            className={cn(FIELD_CLS, "w-full")}
          />
        </label>
        <label className="flex min-w-[170px] flex-1 flex-col gap-1 text-xs text-ink-muted">
          <span>
            <span className="text-destructive">*</span> {t("models.modelId")}
          </span>
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder={t("models.modelIdPlaceholder")}
            className={cn(FIELD_CLS, "w-full font-mono text-xs")}
          />
        </label>
      </div>

      {/* Custom entries own their endpoint and request shape; a third-party one takes both from its
          provider, so showing these for it would offer edits that go nowhere. */}
      {custom && (
        <>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("models.apiFormat")}
            <select
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value)}
              className={cn(FIELD_CLS, "w-full")}
            >
              <option value="openai-chat">{t("models.apiFormatOpenAI")}</option>
              <option value="openai-responses">{t("models.apiFormatResponses")}</option>
            </select>
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="text-xs text-ink-muted">
                <span className="text-destructive">*</span> {t("models.customUrl")}
              </label>
              <span className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
                {t("models.fullUrl")}
                <ToggleSwitch on={fullUrl} onChange={setFullUrl} label={t("models.fullUrl")} />
              </span>
            </div>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("models.customUrlPlaceholder")}
              className={cn(FIELD_CLS, "w-full font-mono text-xs")}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-ink-subtle">
              ⓘ{" "}
              {fullUrl ? (
                t("models.urlHintFull")
              ) : (
                <>
                  {t("models.urlHint")}
                  <code className="mx-0.5 rounded bg-surface-muted px-1 font-mono text-ink-muted">
                    {apiFormatSuffix(apiFormat)}
                  </code>
                </>
              )}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px] text-ink-subtle">
            {t("models.multimodal")}
            <ToggleSwitch on={multimodal} onChange={setMultimodal} label={t("models.multimodal")} />
          </div>
        </>
      )}

      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        {t("models.apiKey")}
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? t("models.apiKeySet") : t("models.apiKeyPlaceholder")}
          className={cn(FIELD_CLS, "w-full font-mono text-xs")}
        />
      </label>
      {!custom && (
        <p className="text-[11px] leading-relaxed text-ink-subtle">
          ⓘ {t("models.keyShared", { provider: providerLabel })}
        </p>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button type="button" onClick={save} disabled={!valid} className={cn(PRIMARY_BTN)}>
          {t("ctx.save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-surface hover:text-ink"
        >
          {t("ctx.cancel")}
        </button>
      </div>
    </div>
  );
}
