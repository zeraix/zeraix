"use client";

import { useEffect, useState } from "react";
import { ImageOff, Plus, Trash2 } from "lucide-react";
import { useLoginModalStore } from "@/store/loginModalStore";
import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  POLL_BUDGET_MS,
  clampPollInterval,
  pollsWithinBudget,
} from "@/lib/ai/generation/polling";
import {
  addCustomEngine,
  loadCustomEngines,
  removeCustomEngine,
  type CustomEngine,
  type EngineFormat,
} from "@/lib/ai/generation/custom";
import {
  addCustomModel,
  addOfficialModel,
  addOfficialModelFromCatalog,
  type AgentModel,
  apiFormatSuffix,
  clearVisionUnsupported,
  getApiKeyByRef,
  getSelectedModelId,
  loadModelList,
  modelLikelyVision,
  OFFICIAL_PROVIDER_ID,
  PROVIDERS,
  removeModel,
  setApiKeyByRef,
  setSelectedModelId,
  visionBlocked,
} from "@/lib/ai/models";
import { isOpenAIError, listModels, type Model } from "@/lib/api/agent";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "./ToggleSwitch";
import { FIELD_CLS, PRIMARY_BTN } from "./styles";

/** Sentinel value for the "Add model manually" option in the model dropdown (not a real model ID). */
export const MANUAL_MODEL = "__manual__";

/** Models section: maintains the list of selectable models (official catalog + custom), one of which can be set as the default (used by the home selector and for sending on the chat page). */
export function ModelsSection({ t }: { t: TFunc }) {
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const [list, setList] = useState<AgentModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Official catalog (excludes the custom placeholder and providers with no models).
  const officialProviders = PROVIDERS.filter((p) => !p.custom && p.models.length > 0);
  const [provId, setProvId] = useState(officialProviders[0]?.id ?? "");
  const provModels = officialProviders.find((p) => p.id === provId)?.models ?? [];
  const [modelName, setModelName] = useState(provModels[0] ?? "");
  const [oKey, setOKey] = useState(""); // API key for the selected provider (shared across the same provider)
  // "Add model manually": for new models not yet in the catalog (when the app hasn't been updated in time), the user just fills in the model ID + display name,
  // reusing the provider's endpoint and key. This mode is entered when modelName === MANUAL_MODEL.
  const [manualId, setManualId] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  // Official models (from the platform's GET /v1/models).
  const [officialModels, setOfficialModels] = useState<Model[]>([]);
  const [omState, setOmState] = useState<"loading" | "ready" | "error">("loading");
  const [omError, setOmError] = useState("");
  const [omSelected, setOmSelected] = useState("");
  // Custom model form.
  const [cApiFormat, setCApiFormat] = useState("openai-chat");
  /**
   * What the entry being added actually is.
   *
   * A chat model and an image engine are different things that happen to share an "add a model" form: they
   * have different endpoints, different response shapes, and different consumers. The selector decides which
   * LIST the entry lands in — a chat model goes to the model picker, an image engine to the generation
   * engines (see lib/ai/generation/custom.ts). They are never mixed, because that was tried once and had to
   * be cleaned up afterwards by purgeLegacyImageModels.
   */
  const [cKind, setCKind] = useState<"chat" | "image_generation" | "video_generation">("chat");
  const [cPollUrl, setCPollUrl] = useState("");
  /**
   * Poll cadence in SECONDS, because that is the unit a person thinks in; stored as milliseconds.
   *
   * Held as a string rather than a number so the field can be empty while being edited — a numeric state
   * would snap a half-typed "1" to the floor under the user's cursor.
   */
  const [cPollSeconds, setCPollSeconds] = useState(String(DEFAULT_POLL_INTERVAL_MS / 1000));
  /**
   * Optional response field paths for an async engine, and the disclosure that hides them.
   *
   * Collapsed by default because the documented defaults cover the common case, and three JSON-path inputs
   * on every add would be friction paid by everyone to help the few who need it. The error the generic
   * reader produces names the fields it searched, so a user who needs these is told so at the moment it
   * matters rather than having to guess that this section exists.
   */
  const [cAdvanced, setCAdvanced] = useState(false);
  const [cPathTask, setCPathTask] = useState("");
  const [cPathStatus, setCPathStatus] = useState("");
  const [cPathUrl, setCPathUrl] = useState("");
  const [cImageFormat, setCImageFormat] = useState<EngineFormat>("openai-image");
  const [engines, setEngines] = useState<CustomEngine[]>([]);
  const [cBaseUrl, setCBaseUrl] = useState("");
  const [cFullUrl, setCFullUrl] = useState(false);
  const [cModel, setCModel] = useState("");
  const [cMultimodal, setCMultimodal] = useState(false);
  const [cKey, setCKey] = useState("");

  const refresh = () => {
    setList(loadModelList());
    setSelectedId(getSelectedModelId());
  };
  useEffect(() => {
    setList(loadModelList());
    setSelectedId(getSelectedModelId());
    setEngines(loadCustomEngines());
  }, []);

  // Fetch the official model list (requires login + a reachable platform).
  useEffect(() => {
    let alive = true;
    setOmState("loading");
    listModels()
      .then((res) => {
        if (!alive) return;
        if (isOpenAIError(res)) {
          setOmError(res.error.message);
          setOmState("error");
          return;
        }
        const data = res.data ?? [];
        setOfficialModels(data);
        setOmSelected(data[0]?.id ?? "");
        setOmState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setOmError(String(e));
        setOmState("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Adding an official direct-connect model is account-bound: prompt login first.
  const addOfficialFromCatalog = async () => {
    if (!omSelected) return;
    if (!(await requireLogin())) return;
    addOfficialModelFromCatalog(omSelected);
    refresh();
  };

  const onProvChange = (id: string) => {
    setProvId(id);
    const models = officialProviders.find((p) => p.id === id)?.models ?? [];
    // Keep the "Add manually" mode (every provider allows adding models manually); otherwise revert to the provider's first built-in model.
    setModelName((prev) => (prev === MANUAL_MODEL ? MANUAL_MODEL : (models[0] ?? "")));
    setOKey(""); // Clear the input when switching providers (don't repopulate an existing key)
  };
  // Whether this provider already has a key (used to hint: leave blank to keep it, no need to re-enter).
  const hasProviderKey = !!getApiKeyByRef(provId);
  const manualMode = modelName === MANUAL_MODEL;
  const addOfficial = () => {
    // Manual mode: use the entered model ID + display name; otherwise use the built-in model selected in the dropdown.
    const model = manualMode ? manualId.trim() : modelName;
    if (!provId || !model) return;
    if (manualMode && !manualLabel.trim()) return; // Manual add requires a display name
    if (oKey.trim()) setApiKeyByRef(provId, oKey.trim()); // Only overwrite when a new key was entered
    addOfficialModel(provId, model, manualMode ? manualLabel.trim() : undefined);
    setOKey("");
    if (manualMode) {
      setManualId("");
      setManualLabel("");
    }
    refresh();
  };
  const addCustom = () => {
    if (!cBaseUrl.trim() || !cModel.trim()) return;
    if (cKind !== "chat") {
      // Video runs as a job on every vendor, so it needs somewhere to poll — and without one an accepted
      // request would spend quota and then time out with nothing to collect. Refused here rather than stored
      // and skipped later, so the reason is visible at the moment it can be fixed.
      if (cKind === "video_generation" && !cPollUrl.trim()) return;
      // The URL is taken as given. A generation endpoint's path is vendor-specific (/images/generations,
      // /v4/images/generations, :predict …), so appending one would be a guess that silently produces 404s.
      addCustomEngine({
        capability: cKind,
        endpoint: cBaseUrl.trim(),
        model: cModel.trim(),
        format: cKind === "video_generation" ? "async-job" : cImageFormat,
        pollUrl: cKind === "video_generation" ? cPollUrl.trim() : undefined,
        paths:
          cKind === "video_generation"
            ? { taskId: cPathTask, status: cPathStatus, url: cPathUrl }
            : undefined,
        // Clamped by the same function the runtime clamps with, so the value that is saved is the value that
        // will actually be used — a form that accepted 1s and then polled at 3s would be lying quietly.
        pollIntervalMs:
          cKind === "video_generation" ? clampPollInterval(Number(cPollSeconds) * 1000) : undefined,
        apiKey: cKey,
      });
      setEngines(loadCustomEngines());
      setCPollUrl("");
      setCPollSeconds(String(DEFAULT_POLL_INTERVAL_MS / 1000));
      setCPathTask("");
      setCPathStatus("");
      setCPathUrl("");
      setCAdvanced(false);
    } else {
      addCustomModel({
        baseUrl: cBaseUrl.trim(),
        fullUrl: cFullUrl,
        model: cModel.trim(),
        apiFormat: cApiFormat,
        multimodal: cMultimodal,
        apiKey: cKey,
      });
    }
    setCBaseUrl("");
    setCFullUrl(false);
    setCModel("");
    setCMultimodal(false);
    setCKey("");
    setCApiFormat("openai-chat");
    refresh();
  };

  const dropEngine = (id: string) => setEngines(removeCustomEngine(id));
  const setDefault = (id: string) => {
    setSelectedModelId(id);
    setSelectedId(id);
  };
  const providerLabel = (m: AgentModel) =>
    m.custom
      ? t("models.custom")
      : m.providerId === OFFICIAL_PROVIDER_ID
        ? t("models.official")
        : (PROVIDERS.find((p) => p.id === m.providerId)?.label ?? m.providerId);

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="mb-2 text-xl font-bold text-ink">{t("settings.models")}</h2>
      <p className="mb-5 text-xs text-ink-subtle">{t("models.desc")}</p>

      {/* Added list (single-select default) */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.added")}</p>
      {list.length === 0 ? (
        <p className="mb-6 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("models.empty")}
        </p>
      ) : (
        <div className="mb-6 divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
          {list.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => setDefault(m.id)}
                title={t("models.default")}
                aria-label={t("models.default")}
                className="shrink-0"
              >
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full border",
                    selectedId === m.id ? "border-primary" : "border-line-strong",
                  )}
                >
                  {selectedId === m.id && <span className="size-2 rounded-full bg-primary" />}
                </span>
              </button>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                  <span className="truncate">{m.label}</span>
                  {/* Deliberately NOT the send path's predicate: that one is optimistic and would badge
                      every model. This shows only what is actually known about the model. */}
                  {modelLikelyVision(m) && (
                    <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t("models.multimodal")}
                    </span>
                  )}
                  {/* The app decided this model rejects images and is stripping them before every send. Shown
                      because the only other evidence the user gets is the model answering "I cannot see
                      images" — which reads as a broken model rather than an app-side verdict. */}
                  {visionBlocked(m) && (
                    <span
                      title={t("models.visionBlockedHint")}
                      className="flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning-ink"
                    >
                      <ImageOff className="size-3" />
                      {t("models.visionBlocked")}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-ink-subtle">
                  {providerLabel(m)} · {m.model}
                  {m.custom && m.endpoint ? ` · ${m.endpoint}` : ""}
                </p>
              </div>
              {/* Undo the verdict without deleting the model — which used to be the only way back, taking the
                  API key and the default selection with it. */}
              {visionBlocked(m) && (
                <button
                  type="button"
                  onClick={() => setList(clearVisionUnsupported(m.id))}
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-ink-subtle transition hover:bg-surface hover:text-ink"
                >
                  {t("models.visionReset")}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setList(removeModel(m.id)); // Update directly with the post-removal list to avoid read-back timing issues
                  setSelectedId(getSelectedModelId());
                }}
                title={t("ctx.delete")}
                aria-label={t("ctx.delete")}
                className="shrink-0 rounded-md p-1.5 text-ink-muted transition hover:bg-surface hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add from the official catalog: official models come from the platform's GET /v1/models and are sent using the "official API key" */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.addOfficial")}</p>
      <div className="mb-6 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        {omState === "loading" ? (
          <p className="text-xs">{t("models.loading")}</p>
        ) : omState === "error" ? (
          <p className="text-xs text-warning-ink">
            {t("models.officialError")}
            {omError ? ` (${omError})` : ""}
          </p>
        ) : officialModels.length === 0 ? (
          <p className="text-xs">{t("models.officialEmpty")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-xs">
                {t("models.model")}
                <select
                  value={omSelected}
                  onChange={(e) => setOmSelected(e.target.value)}
                  className={cn(FIELD_CLS, "min-w-[200px]")}
                >
                  {officialModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.type && m.type !== "chat" ? ` (${m.type})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={addOfficialFromCatalog} className={cn(PRIMARY_BTN, "h-[34px]")}>
                <Plus className="size-3.5" />
                {t("models.add")}
              </button>
            </div>
            <p className="mt-2 text-[11px]">ⓘ {t("models.officialNote")}</p>
          </>
        )}
      </div>
      {/* Add third-party model */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.addThirdParty")}</p>
      <div className="mb-6 space-y-2.5 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs ">
            {t("models.provider")}
            <select value={provId} onChange={(e) => onProvChange(e.target.value)} className={cn(FIELD_CLS, "min-w-[170px]")}>
              {officialProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs ">
            {t("models.model")}
            <select value={modelName} onChange={(e) => setModelName(e.target.value)} className={cn(FIELD_CLS, "min-w-[170px]")}>
              {provModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {/* Every provider can manually add new models not in the catalog (when the app hasn't been updated in time) */}
              <option value={MANUAL_MODEL}>{t("models.manualOption")}</option>
            </select>
          </label>
        </div>
        {/* Manual add: fill in the model ID + display name; the endpoint and key reuse the provider selected above */}
        {manualMode && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs">
              <span>
                <span className="text-destructive">*</span> {t("models.modelId")}
              </span>
              <input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder={t("models.modelIdPlaceholder")}
                className={cn(FIELD_CLS, "min-w-[170px] font-mono text-xs")}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs">
              <span>
                <span className="text-destructive">*</span> {t("models.displayName")}
              </span>
              <input
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                placeholder={t("models.displayNamePlaceholder")}
                className={cn(FIELD_CLS, "min-w-[170px]")}
              />
            </label>
          </div>
        )}
        {/* This provider's API key (shared across all models of the same provider) */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            {t("models.apiKey")}
            <input
              type="password"
              autoComplete="off"
              value={oKey}
              onChange={(e) => setOKey(e.target.value)}
              placeholder={hasProviderKey ? t("models.apiKeyExists") : t("models.apiKeyPlaceholder")}
              className={cn(FIELD_CLS, "min-w-[220px] font-mono text-xs")}
            />
          </label>
          <button type="button" onClick={addOfficial} className={cn(PRIMARY_BTN, "h-[34px]")}>
            <Plus className="size-3.5" />
            {t("models.add")}
          </button>
        </div>
      </div>

      {/* Generation engines the user added.
          Shown separately from the model list, and deliberately so: these are not selectable and never appear
          in the chat picker — the image_generation tool resolves one by capability when it needs it. Listing
          them here is what makes an added engine verifiable at all; without it the only way to know whether
          one took would be to ask for an image and see. */}
      {engines.length > 0 && (
        <>
          <p className="mb-2 text-sm font-semibold text-ink">{t("models.engines")}</p>
          <div className="mb-5 space-y-2">
            {engines.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface-muted/50 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{e.label}</p>
                  <p className="truncate font-mono text-[11px] text-ink-subtle">{e.endpoint}</p>
                </div>
                <span className="shrink-0 rounded-md bg-surface px-2 py-0.5 text-[11px] text-ink-muted">
                  {t(e.capability === "video_generation" ? "models.kindVideo" : "models.kindImage")}
                </span>
                <button
                  type="button"
                  onClick={() => dropEngine(e.id)}
                  aria-label={t("ctx.delete")}
                  className="shrink-0 rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Add custom model */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.addCustom")}</p>
      <div className="space-y-3 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        {/* What is being added. Video is absent on purpose: CapabilityId has it, but no video adapter exists
            yet, so offering it would let the user configure something that cannot run. */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink">
            <span className="text-destructive">*</span> {t("models.kind")}
          </label>
          <select
            value={cKind}
            onChange={(e) => setCKind(e.target.value as "chat" | "image_generation" | "video_generation")}
            className={cn(FIELD_CLS, "w-full")}
          >
            <option value="chat">{t("models.kindChat")}</option>
            <option value="image_generation">{t("models.kindImage")}</option>
            <option value="video_generation">{t("models.kindVideo")}</option>
          </select>
        </div>

        {/* API format — the chat request shape, or the image RESPONSE shape, which is the part that varies. */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink">
            <span className="text-destructive">*</span> {t("models.apiFormat")}
          </label>
          {cKind === "chat" ? (
            <select value={cApiFormat} onChange={(e) => setCApiFormat(e.target.value)} className={cn(FIELD_CLS, "w-full")}>
              <option value="openai-chat">{t("models.apiFormatOpenAI")}</option>
              <option value="openai-responses">{t("models.apiFormatResponses")}</option>
            </select>
          ) : cKind === "video_generation" ? (
            <p className="rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
              ⓘ {t("models.videoFormatHint")}
            </p>
          ) : (
            <>
              <select
                value={cImageFormat}
                onChange={(e) => setCImageFormat(e.target.value as EngineFormat)}
                className={cn(FIELD_CLS, "w-full")}
              >
                <option value="openai-image">{t("models.imageFormatOpenAI")}</option>
                <option value="zhipu-image">{t("models.imageFormatZhipu")}</option>
                <option value="gemini-image">{t("models.imageFormatGemini")}</option>
                <option value="qwen-image">{t("models.imageFormatQwen")}</option>
              </select>
              <p className="mt-1 rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
                ⓘ {t("models.imageFormatHint")}
              </p>
            </>
          )}
        </div>

        {/* Custom request URL + full-URL toggle */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-ink">
              <span className="text-destructive">*</span> {t("models.customUrl")}
            </label>
            {cKind === "chat" && (
              <span className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
                {t("models.fullUrl")}
                <ToggleSwitch on={cFullUrl} onChange={setCFullUrl} label={t("models.fullUrl")} />
              </span>
            )}
          </div>
          <input
            value={cBaseUrl}
            onChange={(e) => setCBaseUrl(e.target.value)}
            placeholder={t("models.customUrlPlaceholder")}
            className={cn(FIELD_CLS, "w-full font-mono text-xs")}
          />
          <p className="mt-1 rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
            ⓘ{" "}
            {cKind !== "chat" || cFullUrl ? (
              t("models.urlHintFull")
            ) : (
              <>
                {t("models.urlHint")}
                <code className="mx-0.5 rounded bg-surface-muted px-1 font-mono text-ink-muted">
                  {apiFormatSuffix(cApiFormat)}
                </code>
              </>
            )}
          </p>
        </div>

        {/* Poll URL — video only. See custom.ts: the poll path is unrelated to the submit path on most
            vendors, so it is asked for rather than derived. */}
        {cKind === "video_generation" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-ink">
              <span className="text-destructive">*</span> {t("models.pollUrl")}
            </label>
            <input
              value={cPollUrl}
              onChange={(e) => setCPollUrl(e.target.value)}
              placeholder={t("models.pollUrlPlaceholder")}
              className={cn(FIELD_CLS, "w-full font-mono text-xs")}
            />
            <p className="mt-1 rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
              ⓘ {t("models.pollUrlHint")}
            </p>

            {/* Poll cadence. Seconds here, milliseconds in storage. */}
            <div className="mt-2">
              <label className="mb-1 block text-xs font-medium text-ink">{t("models.pollEvery")}</label>
              <input
                type="number"
                min={MIN_POLL_INTERVAL_MS / 1000}
                step={1}
                value={cPollSeconds}
                onChange={(e) => setCPollSeconds(e.target.value)}
                className={cn(FIELD_CLS, "w-full")}
              />
              <p className="mt-1 rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
                ⓘ{" "}
                {t("models.pollEveryHint", {
                  min: String(MIN_POLL_INTERVAL_MS / 1000),
                  polls: String(pollsWithinBudget(Number(cPollSeconds) * 1000)),
                  budget: String(Math.round(POLL_BUDGET_MS / 60_000)),
                })}
              </p>
            </div>

            {/* Field overrides. Optional: each replaces the corresponding default list, and naming only the
                one that is wrong is the common case. */}
            <button
              type="button"
              onClick={() => setCAdvanced((v) => !v)}
              className="mt-2 text-[11px] font-medium text-ink-muted underline-offset-2 hover:underline"
            >
              {cAdvanced ? t("models.fieldsHide") : t("models.fieldsShow")}
            </button>
            {cAdvanced && (
              <div className="mt-2 space-y-2 rounded-md border border-line/60 px-3 py-2.5">
                <p className="text-[11px] leading-relaxed text-ink-subtle">{t("models.fieldsHint")}</p>
                {(
                  [
                    ["models.fieldTaskId", cPathTask, setCPathTask, "id"],
                    ["models.fieldStatus", cPathStatus, setCPathStatus, "task_status"],
                    ["models.fieldUrl", cPathUrl, setCPathUrl, "output.results[0].url"],
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
          </div>
        )}

        {/* Model ID + multimodal toggle */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-ink">
              <span className="text-destructive">*</span> {t("models.modelId")}
            </label>
            {cKind === "chat" && (
              <span className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
                {t("models.multimodal")}
                <ToggleSwitch on={cMultimodal} onChange={setCMultimodal} label={t("models.multimodal")} />
              </span>
            )}
          </div>
          <input
            value={cModel}
            onChange={(e) => setCModel(e.target.value)}
            placeholder={t("models.modelIdPlaceholder")}
            className={cn(FIELD_CLS, "w-full")}
          />
        </div>

        {/* API key */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink">
            <span className="text-destructive">*</span> {t("models.apiKey")}
          </label>
          <input
            type="password"
            autoComplete="off"
            value={cKey}
            onChange={(e) => setCKey(e.target.value)}
            placeholder={t("models.apiKeyPlaceholder")}
            className={cn(FIELD_CLS, "w-full font-mono text-xs")}
          />
        </div>

        <button
          type="button"
          onClick={addCustom}
          disabled={!cBaseUrl.trim() || !cModel.trim()}
          className={cn(PRIMARY_BTN)}
        >
          <Plus className="size-3.5" />
          {t("models.add")}
        </button>
      </div>
    </div>
  );
}
