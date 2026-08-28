"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveActiveModel,
  resolveModelById,
  ensureModelListSeeded,
  loadModelList,
  getSelectedModel,
  OFFICIAL_PROVIDER_ID,
  MODEL_LIST_CHANGE_EVENT,
  type ResolvedModel,
  type AgentModel,
} from "@/lib/ai/models";
import { isLocalEndpoint, localLlm, LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import {
  loadThinking,
  saveThinking,
  THINKING_CHANGE_EVENT,
  type ThinkingConfig,
} from "@/lib/ai/thinking";
import { useAgentChatStore } from "@/store/agentChatStore";

/** One category in the composer's model picker. */
export interface ModelGroup {
  key: string;
  labelKey: string;
  items: AgentModel[];
}

export interface ModelSelection {
  /** The currently selected model. endpoint / modelName / apiKey are derived from it. */
  activeModel: ResolvedModel | null;
  models: AgentModel[];
  selectedModelId: string | null;
  selectedLabel: string | null;
  modelGroups: ModelGroup[];
  /** Switch models from the composer, binding the choice to the current conversation. */
  selectModel: (id: string) => void;
  /**
   * Recompute the effective model for the current conversation: its own binding first, the global selection
   * as the fallback. Called on mount, on window focus, and whenever a conversation is loaded or cleared.
   */
  applyEffectiveModel: () => void;
  /** Adopt the globally selected model during mount initialization, before any conversation exists. */
  initActiveModel: () => void;

  // ── Connection config, all derived from the active model ──────────────────────────────────────────────────
  endpoint: string;
  modelName: string;
  apiKey: string;
  isLocalModel: boolean;

  // ── Thinking ─────────────────────────────────────────────────────────────────────────────────────────────
  thinking: ThinkingConfig;
  changeThinking: (next: ThinkingConfig) => void;
  /**
   * Models that rejected the thinking switch outright (see the 400 fallback in requestChat): once a model is in
   * here the field is left off its requests for the rest of the session.
   */
  thinkingUnsupportedRef: React.RefObject<Set<string>>;
  /**
   * Same idea for the other direction: models that rejected a REPLAYED thinking block (`reasoning_content` on an
   * assistant message of the request). While the model is in here, the "send thinking as context" setting is
   * suspended for it — the wire is built without the replay instead of paying a failed request per turn.
   */
  reasoningContextUnsupportedRef: React.RefObject<Set<string>>;
  /**
   * "Replay past thinking blocks on this request": the user setting, minus the models that proved they reject
   * the field. Read as a function rather than captured once, because both the refs and the setting can change
   * mid conversation.
   */
  sendReasoningContext: () => boolean;

  // ── Local model ──────────────────────────────────────────────────────────────────────────────────────────
  /** Tri-state: null = not a local model, false = not running, true = ready. */
  localLlmReady: boolean | null;
  /** The "local model not started" dialog, guiding the user to Settings → Local model. */
  localStartDialog: boolean;
  setLocalStartDialog: (open: boolean) => void;
}

/**
 * Which model this conversation talks to, and everything derived from that answer.
 *
 * The effective model is the conversation's own binding when it has one, and the globally selected model
 * otherwise — a picker that sits next to a specific conversation has to bind to that conversation, while a
 * conversation that never chose follows whatever settings says. Both the list and the selection are refreshed
 * on window focus and on MODEL_LIST_CHANGE_EVENT, because this component is mounted for the app's lifetime and
 * the settings page writes the same storage.
 */
export function useModelSelection({
  convIdRef,
  t,
}: {
  convIdRef: React.RefObject<string | null>;
  t: (key: string, vars?: Record<string, string>) => string;
}): ModelSelection {
  // The currently selected model (chosen in settings / home page, read-only here for sending). endpoint / model / apiKey are derived from it.
  const [activeModel, setActiveModel] = useState<ResolvedModel | null>(null);
  // The list of selectable models + the currently selected id (used by the model picker inside the input box).
  const [models, setModels] = useState<AgentModel[]>([]);
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(null);

  // Thinking mode (master switch + gear), set from the composer toolbar and persisted globally like the
  // selected model. Read synchronously on the client for the same reason the locale store does: the
  // toolbar would otherwise flash the default before the stored choice lands.
  const [thinking, setThinking] = useState<ThinkingConfig>(loadThinking);
  const changeThinking = (next: ThinkingConfig) => {
    setThinking(next);
    saveThinking(next);
  };
  // This component is mounted once for the app's lifetime, so a setting changed anywhere else (the home
  // page's own composer writes the same storage) would otherwise never reach the value used for sending.
  useEffect(() => {
    const sync = () => setThinking(loadThinking());
    window.addEventListener(THINKING_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THINKING_CHANGE_EVENT, sync);
  }, []);

  const thinkingUnsupportedRef = useRef<Set<string>>(new Set());
  const reasoningContextUnsupportedRef = useRef<Set<string>>(new Set());

  // The connection config needed for sending, all derived from the "currently selected model" (maintained in settings / home page).
  const endpoint = activeModel?.endpoint ?? "";
  const modelName = activeModel?.model ?? "";
  const apiKey = activeModel?.apiKey ?? "";

  // The actual running status of the local model (llama.cpp): after an app restart, llama-server is not started automatically (no auto-start),
  // so a selected local model may be "in the list but not running". Subscribe to the main-process status to drive the top dot and the send guidance (go to settings to start it).
  const isLocalModel = !!activeModel && (activeModel.providerId === LOCAL_PROVIDER_ID || isLocalEndpoint(endpoint));

  const sendReasoningContext = () =>
    thinking.sendContext && !reasoningContextUnsupportedRef.current.has(modelName);

  const [localLlmReady, setLocalLlmReady] = useState<boolean | null>(null);
  const [localStartDialog, setLocalStartDialog] = useState(false);
  useEffect(() => {
    // Clearing the tri-state the moment the model stops being local IS the correct render-visible answer, and
    // the async probe below can only overwrite it later. Nothing derives from it during this render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isLocalModel) { setLocalLlmReady(null); return; }
    const bridge = localLlm();
    if (!bridge) { setLocalLlmReady(false); return; } // Non-Electron: the local model is necessarily unavailable
    let alive = true;
    bridge.status().then((st) => { if (alive) setLocalLlmReady(!!st.ready); }).catch(() => { if (alive) setLocalLlmReady(false); });
    const off = bridge.onStatus((st) => { if (alive) setLocalLlmReady(!!st.ready); });
    return () => { alive = false; off?.(); };
  }, [isLocalModel, activeModel?.id]);

  // Compute the "effective model for the current conversation": the conversation-level binding takes priority,
  // falling back to the globally selected model when the binding is missing / points to a deleted model. Synced to the input-box picker and the resolved model used for sending.
  // Stable, so the mount-initialization effect that calls it can list it and still run exactly once.
  const initActiveModel = useCallback(() => setActiveModel(resolveActiveModel()), []);

  const applyEffectiveModel = useCallback(() => {
    const store = useAgentChatStore.getState();
    const conv = convIdRef.current ? store.getConversation(convIdRef.current) : null;
    const list = loadModelList();
    const globalId = getSelectedModel()?.id ?? null;
    const bound = conv?.modelId && list.some((m) => m.id === conv.modelId) ? conv.modelId : null;
    const eid = bound ?? globalId;
    setSelectedModelIdState(eid);
    setActiveModel(eid ? resolveModelById(eid) : null);
  }, [convIdRef]);

  // When returning to this page after switching models in settings / home page, refresh the selectable list and the effective model.
  useEffect(() => {
    const refresh = () => {
      ensureModelListSeeded();
      setModels(loadModelList());
      applyEffectiveModel();
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(MODEL_LIST_CHANGE_EVENT, refresh); // Refresh immediately on same-page list changes such as a local model becoming ready / stopping
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener(MODEL_LIST_CHANGE_EVENT, refresh); };
  }, [applyEffectiveModel]);

  // Switch models within the input box: bind to the current conversation (if the conversation is not yet created, bind when it
  // is created on the first send); does not change the global one. This used to be conditional — dev mode bound per session,
  // daily mode wrote the global selection — and with the two modes merged, per-session binding is what survives, because that
  // is the behaviour the model picker sits next to a specific conversation to provide.
  const selectModel = (id: string) => {
    setSelectedModelIdState(id);
    setActiveModel(resolveModelById(id));
    if (convIdRef.current) useAgentChatStore.getState().setConversationModel(convIdRef.current, id);
  };

  const selectedLabel = models.find((m) => m.id === selectedModelId)?.label ?? null;
  // Group by category: official / local models / third-party / custom.
  const modelGroups = [
    { key: "official", labelKey: t("chat.groupOfficial"), items: models.filter((m) => !m.custom && m.providerId === OFFICIAL_PROVIDER_ID) },
    { key: "local", labelKey: t("chat.groupLocal"), items: models.filter((m) => m.providerId === LOCAL_PROVIDER_ID) },
    { key: "thirdParty", labelKey: t("chat.groupThirdParty"), items: models.filter((m) => !m.custom && m.providerId !== OFFICIAL_PROVIDER_ID && m.providerId !== LOCAL_PROVIDER_ID) },
    { key: "custom", labelKey: t("chat.groupCustom"), items: models.filter((m) => m.custom) },
  ].filter((g) => g.items.length > 0);

  return {
    activeModel,
    models,
    selectedModelId,
    selectedLabel,
    modelGroups,
    selectModel,
    applyEffectiveModel,
    initActiveModel,
    endpoint,
    modelName,
    apiKey,
    isLocalModel,
    thinking,
    changeThinking,
    thinkingUnsupportedRef,
    reasoningContextUnsupportedRef,
    sendReasoningContext,
    localLlmReady,
    localStartDialog,
    setLocalStartDialog,
  };
}
