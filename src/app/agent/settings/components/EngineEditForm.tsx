"use client";

/**
 * Edit one already-added generation engine, inline under its row in the "Generation engines" list.
 *
 * The counterpart of ModelEditForm, and it exists for the sharper version of the same problem: an
 * engine is never selected, so a wrong endpoint or a mistyped result path produces nothing visible
 * until someone asks for an image several minutes later. Correcting one used to mean deleting it —
 * which also deletes its API key, since removeCustomEngine takes the key with the entry.
 *
 * `capability` is shown but not editable: see applyEngineEdit for why.
 */

import { useState } from "react";
import {
  ENGINE_FORMATS,
  updateCustomEngine,
  type CustomEngine,
  type EngineFormat,
} from "@/lib/ai/generation/custom";
import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  POLL_BUDGET_MS,
  pollsWithinBudget,
} from "@/lib/ai/generation/polling";
import { getApiKeyByRef, setApiKeyByRef } from "@/lib/ai/models";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { FIELD_CLS, PRIMARY_BTN } from "./styles";

/** The image response shapes, in the order the add form offers them. `async-job` is video's, and fixed. */
const IMAGE_FORMATS = ENGINE_FORMATS.filter((f) => f !== "async-job");

const FORMAT_LABEL_KEY: Record<string, string> = {
  "openai-image": "models.imageFormatOpenAI",
  "zhipu-image": "models.imageFormatZhipu",
  "gemini-image": "models.imageFormatGemini",
  "qwen-image": "models.imageFormatQwen",
};

export function EngineEditForm({
  engine,
  t,
  onSaved,
  onCancel,
}: {
  engine: CustomEngine;
  t: TFunc;
  /** Handed the list as it is after the write, so the caller never re-reads storage to catch up. */
  onSaved: (list: CustomEngine[]) => void;
  onCancel: () => void;
}) {
  const isVideo = engine.capability === "video_generation";
  const [label, setLabel] = useState(engine.label);
  const [endpoint, setEndpoint] = useState(engine.endpoint);
  const [model, setModel] = useState(engine.model);
  const [format, setFormat] = useState<EngineFormat>(engine.format);
  const [pollUrl, setPollUrl] = useState(engine.pollUrl ?? "");
  // Seconds in the form, milliseconds in storage — the same split the add form uses, and held as a
  // string so the field can be empty mid-edit instead of snapping to the floor under the cursor.
  const [pollSeconds, setPollSeconds] = useState(
    String((engine.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) / 1000),
  );
  // Opened when this engine already has overrides: they are the reason someone would come back here.
  const [advanced, setAdvanced] = useState(!!engine.paths);
  const [pathTask, setPathTask] = useState(engine.paths?.taskId ?? "");
  const [pathStatus, setPathStatus] = useState(engine.paths?.status ?? "");
  const [pathUrl, setPathUrl] = useState(engine.paths?.url ?? "");
  const [apiKey, setApiKey] = useState("");

  const hasKey = !!getApiKeyByRef(engine.id);
  // The same rule addCustomEngine refuses on: a job with nowhere to poll spends quota and then times
  // out with nothing to collect, so it is blocked here rather than saved and skipped later.
  const valid = !!endpoint.trim() && !!model.trim() && (!isVideo || !!pollUrl.trim());

  const save = () => {
    if (!valid) return;
    // Blank means "keep the stored key": the field never shows it, so treating empty as a deletion
    // would wipe a working key every time someone fixed a URL.
    if (apiKey.trim()) setApiKeyByRef(engine.id, apiKey.trim());
    onSaved(
      updateCustomEngine(engine.id, {
        label,
        endpoint,
        model,
        format,
        ...(isVideo
          ? {
              pollUrl,
              paths: { taskId: pathTask, status: pathStatus, url: pathUrl },
              pollIntervalMs: Number(pollSeconds) * 1000,
            }
          : {}),
      }),
    );
  };

  return (
    <div className="mt-2 space-y-2.5 rounded-xl border border-line bg-surface-muted/60 px-4 py-3.5">
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        {t("models.displayName")}
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={engine.model}
          className={cn(FIELD_CLS, "w-full")}
        />
      </label>

      {/* Video is read as a generic async job, so there is nothing to pick; image responses differ per
          vendor, and the wrong choice returns a successful call whose image cannot be read. */}
      {isVideo ? (
        <p className="rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
          ⓘ {t("models.videoFormatHint")}
        </p>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t("models.apiFormat")}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as EngineFormat)}
            className={cn(FIELD_CLS, "w-full")}
          >
            {IMAGE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {t(FORMAT_LABEL_KEY[f] ?? f)}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        <span>
          <span className="text-destructive">*</span> {t("models.customUrl")}
        </span>
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={t("models.customUrlPlaceholder")}
          className={cn(FIELD_CLS, "w-full font-mono text-xs")}
        />
      </label>
      <p className="text-[11px] leading-relaxed text-ink-subtle">ⓘ {t("models.urlHintFull")}</p>

      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        <span>
          <span className="text-destructive">*</span> {t("models.modelId")}
        </span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={t("models.modelIdPlaceholder")}
          className={cn(FIELD_CLS, "w-full")}
        />
      </label>

      {isVideo && (
        <>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            <span>
              <span className="text-destructive">*</span> {t("models.pollUrl")}
            </span>
            <input
              value={pollUrl}
              onChange={(e) => setPollUrl(e.target.value)}
              placeholder={t("models.pollUrlPlaceholder")}
              className={cn(FIELD_CLS, "w-full font-mono text-xs")}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-ink-subtle">ⓘ {t("models.pollUrlHint")}</p>

          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {t("models.pollEvery")}
            <input
              type="number"
              min={MIN_POLL_INTERVAL_MS / 1000}
              step={1}
              value={pollSeconds}
              onChange={(e) => setPollSeconds(e.target.value)}
              className={cn(FIELD_CLS, "w-full")}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-ink-subtle">
            ⓘ{" "}
            {t("models.pollEveryHint", {
              min: String(MIN_POLL_INTERVAL_MS / 1000),
              polls: String(pollsWithinBudget(Number(pollSeconds) * 1000)),
              budget: String(Math.round(POLL_BUDGET_MS / 60_000)),
            })}
          </p>

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-[11px] font-medium text-ink-muted underline-offset-2 hover:underline"
          >
            {advanced ? t("models.fieldsHide") : t("models.fieldsShow")}
          </button>
          {advanced && (
            <div className="space-y-2 rounded-md border border-line/60 px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-ink-subtle">{t("models.fieldsHint")}</p>
              {(
                [
                  ["models.fieldTaskId", pathTask, setPathTask, "id"],
                  ["models.fieldStatus", pathStatus, setPathStatus, "task_status"],
                  ["models.fieldUrl", pathUrl, setPathUrl, "output.results[0].url"],
                ] as const
              ).map(([key, value, set, placeholder]) => (
                <div key={key}>
                  <label className="mb-1 block text-[11px] font-medium text-ink">{t(key)}</label>
                  <input
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    placeholder={placeholder}
                    className={cn(FIELD_CLS, "w-full font-mono text-xs")}
                  />
                </div>
              ))}
            </div>
          )}
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
