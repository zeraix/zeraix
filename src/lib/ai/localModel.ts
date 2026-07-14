/**
 * Renderer-layer integration for the local model (llama.cpp).
 *
 * The main process manages the llama-server child process (see electron/llm/localServer.mjs) and exposes it via preload as `window.localLlm`.
 * This module: type definitions + writing the "local" model into the user's model list under a stable id and setting it as default (when ready) / removing it (when deactivated).
 * Request routing: the local endpoint is 127.0.0.1, and the chat page forces it through the main-process proxy (to avoid cross-origin issues in the renderer); see isLocalEndpoint.
 */
import {
  loadModelList,
  saveModelList,
  setSelectedModelId,
  removeModel,
  type AgentModel,
} from "@/lib/ai/models";

/** Fixed providerId and stable id for the local model (for easy lookup / update / removal). */
export const LOCAL_PROVIDER_ID = "local";
export const LOCAL_MODEL_ID = "local::llama";

export interface LocalLlmModelInfo {
  hf: string;
  label: string;
  multimodal: boolean;
  /** Model id (e.g. qwen3.6-35b-a3b) — used as the model parameter sent to the local server and shown in the list's "Model" column. */
  id?: string;
  name?: string;
  /** The context window (-c) llama-server starts with, i.e. the local model's real window. */
  ctx?: number;
  /** Weights directory / HF repo / quantization tag (used by the model library to match the "running" entry). */
  dir?: string | null;
  repo?: string | null;
  quant?: string | null;
}

/** Installed (fully downloaded) local models (for the model library list). */
export interface DownloadedLocalModel {
  modelId: string;
  name: string;
  repo: string;
  quant: string;
  dir: string;
  sizeBytes: number;
  running: boolean;
}

/** Estimated memory usage based on the options. */
export interface LocalLlmEstimate {
  totalGB: number;
  weightGB: number;
  kvGB: number;
}

/** llama runtime info. */
export interface LocalLlmLlamaInfo {
  version: string;
  installedVersions: string[];
  installed: boolean;
  upToDate: boolean;
  updatable: boolean;
  variant: string | null;
  binDir: string;
  root: string;
}

export type LocalLlmPhase = "idle" | "downloading" | "extracting" | "fetching" | "probing" | "loading" | "ready" | "error";

/** `--list-devices` probe result (wizard step 2): real VRAM / device name / whether a usable GPU exists.
 *  shared = integrated GPU (shares system memory, UMA), treated as unified memory; uma = the authoritative ggml flag as parsed (null when unknown).
 *  See docs/vulkan-uma-windows.md. */
export interface LocalLlmProbe {
  vramGB: number | null;
  device: string | null;
  gpuPresent: boolean;
  variant?: string;
  uma?: boolean | null;
  shared?: boolean;
}

/** Local file storage location (llama runtime + GGUF models; large, customizable in settings). */
export interface LocalLlmStorage {
  dir: string;
  custom: boolean;
  freeGB: number | null;
  /** Windows: when the C drive is tight, suggest moving to a drive with more free space. */
  suggestion?: { dir: string; freeGB: number; drive: string } | null;
  /** "Change folder" (chooseStorageDir) migration result: ok or an error description. */
  migrateOk?: boolean;
  migrateError?: string;
}

/** The selected build variant and whether it's installed (wizard step 1). */
export interface LocalLlmInstallInfo {
  variant: string;
  installed: boolean;
  version: string;
}

/** Installation status of the two candidate variants, with and without CUDA (used to default-select the installed one, avoiding a redundant download). */
export interface LocalLlmInstallStatus {
  version: string;
  cuda: { available: boolean; version: string | null };
  variants: { useCuda: boolean; variant: string; installed: boolean }[];
}

export interface LocalLlmStatus {
  running: boolean;
  ready: boolean;
  /** Lifecycle phase (downloading = downloading the llama runtime; fetching = downloading model weights; loading = loading the model). */
  phase: LocalLlmPhase;
  /** Download percentage (downloading = runtime; fetching = model weights). */
  pct: number;
  port: number;
  endpoint: string;
  model: LocalLlmModelInfo | null;
  /** Whether the llama runtime is installed on this machine (userData). */
  installed: boolean;
  /** Target llama.cpp version (tag). */
  version: string;
  /** The build variant actually in use (win-vulkan-x64 / win-cpu-x64 / macos-arm64 …). */
  variant?: string | null;
  /** The installed build variant (used by the wizard to decide whether a download is needed). */
  installedVariant?: string | null;
  /** --list-devices probe result (wizard step 2). */
  probe?: LocalLlmProbe | null;
  error?: string | null;
  tail?: string;
  /** Path to the full runtime log file (install/probe/download/llama-server output all written to disk), opened by the UI's "Runtime log" button. */
  logFile?: string;
}

export interface LocalLlmFitOption {
  model: { id: string; name: string; params: number; vision: boolean; notes: string; hf?: string; moe?: boolean; active?: number; maxCtx?: number; mtp?: boolean; mtpEmbedded?: boolean };
  quant: { id: string; label: string; quality: number };
  fit: { weightGB: number; kvGB: number; totalGB: number };
  speed: string;
  /** The tags selectable in the quantization dropdown for this model, each one's size, and whether it fits (quants with fits=false are disabled in the UI).
   *  ctx / kvBits = the context and KV quantization auto-tiered for that quantization (see localModels.pickCtxKv). */
  quants?: { id: string; totalGB: number; fits?: boolean; ctx?: number; kvBits?: number }[];
  /** The context and KV quantization auto-tiered for this model (at the selected quantization). */
  ctx?: number;
  kvBits?: number;
  /** Number of layers offloaded to the GPU (999 = all; 0 = all CPU; N = first N layers on the GPU, partial offload). */
  ngl?: number;
  /** Total number of model layers (combined with ngl to show N/L layers on the GPU). */
  layers?: number;
}

export interface LocalLlmRecommendation {
  budgetGB: number;
  ctx: number;
  primary: LocalLlmFitOption | null;
  options: LocalLlmFitOption[];
}

export interface LocalLlmHardware {
  hw: {
    platform: string;
    arch: string;
    backend: string;
    unified: boolean;
    totalMemGB: number;
    gpu: { name: string; vramGB: number } | null;
    cores: number;
  };
  /** NVIDIA CUDA probe result (Windows only); when available, the panel shows a "Use NVIDIA GPU acceleration" toggle. */
  cuda?: { available: boolean; version: string | null };
  /** Whether the minimum memory threshold for running a local model is met (deviceMem >= minMemGB); when false, the panel disables startup and only shows a hint. */
  supported?: boolean;
  minMemGB?: number;
}

export interface LocalLlmBridge {
  hardware(): Promise<LocalLlmHardware>;
  /** Local file storage location (llama runtime + GGUF models). */
  storageInfo(): Promise<LocalLlmStorage>;
  setStorageDir(dir: string): Promise<LocalLlmStorage>;
  chooseStorageDir(): Promise<LocalLlmStorage | null>;
  /** Step 1: the selected variant and whether it's installed. */
  installInfo(opts?: { useCuda?: boolean }): Promise<LocalLlmInstallInfo>;
  /** Step 1: installation status of the two candidate variants (default-select the installed one to avoid a redundant download). */
  installStatus(): Promise<LocalLlmInstallStatus>;
  /** Step 1: install the runtime bundle (skips download if already installed). */
  install(opts?: { useCuda?: boolean }): Promise<LocalLlmStatus>;
  /** Step 2: probe VRAM using the installed binary. */
  probe(opts?: { useCuda?: boolean }): Promise<LocalLlmProbe>;
  recommend(opts?: { vramGB?: number; device?: string; budgetGB?: number; ctx?: number; vision?: boolean; shared?: boolean; uma?: boolean | null }): Promise<LocalLlmRecommendation>;
  /** Step 3: start the local model. vision (default true): whether to load the vision projector when the model supports vision (turning it off saves ~1GB of memory). */
  start(opts: { modelId?: string; quantId?: string; hf?: string; ctx?: number; kvBits?: number; useCuda?: boolean; vision?: boolean; mtp?: boolean }): Promise<LocalLlmStatus>;
  stop(): Promise<LocalLlmStatus>;
  /** "Start over": stop the server + clear the probe, return to step 1 (keeping the installed runtime). */
  reset(): Promise<LocalLlmStatus>;
  status(): Promise<LocalLlmStatus>;
  onStatus(cb: (st: LocalLlmStatus) => void): () => void;
  /** List of downloaded local models (model library). */
  listModels(): Promise<DownloadedLocalModel[]>;
  /** Delete a downloaded model (rejected if it's currently running). */
  deleteModel(opts: { dir: string }): Promise<{ ok: boolean; error?: string }>;
  /** GGUF model download directory. */
  modelsDir(): Promise<string>;
  /** Estimate memory usage based on the options. */
  estimate(opts: { modelId: string; quant: string; ctx: number; kvBits: number; vision: boolean; mtp?: boolean }): Promise<LocalLlmEstimate | null>;
  /** llama runtime info. */
  llamaInfo(): Promise<LocalLlmLlamaInfo>;
}

declare global {
  interface Window {
    localLlm?: LocalLlmBridge;
  }
}

/** Whether the current environment provides local-model capability (Electron only). */
export function localLlm(): LocalLlmBridge | null {
  return typeof window !== "undefined" && window.localLlm ? window.localLlm : null;
}
export function isLocalLlmAvailable(): boolean {
  return !!localLlm();
}

/** Whether it's a local endpoint (the chat page uses this to force local models through the main-process proxy, bypassing CORS). */
export function isLocalEndpoint(endpoint: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(endpoint);
}

/** Add or update the "local" model (stable id, deduplicated, pinned to top). Returns the entry. */
export function upsertLocalModel(info: { endpoint: string; model?: string; label?: string; multimodal?: boolean; contextWindow?: number }): AgentModel {
  const entry: AgentModel = {
    id: LOCAL_MODEL_ID,
    providerId: LOCAL_PROVIDER_ID,
    model: info.model || "local",
    label: info.label || "Local model（llama.cpp）",
    endpoint: info.endpoint,
    custom: false,
    apiFormat: "openai-chat",
    multimodal: !!info.multimodal,
    // The local model's real window (llama-server -c): drives the chat page's context-usage bar and compaction threshold, avoiding a wrong 1M-default assumption.
    ...(info.contextWindow && info.contextWindow > 0 ? { contextWindow: info.contextWindow } : {}),
  };
  const rest = loadModelList().filter((m) => m.id !== LOCAL_MODEL_ID);
  saveModelList([entry, ...rest]);
  return entry;
}

/** Local model ready: add it to the list and set it as the current default model. */
export function activateLocalModel(info: { endpoint: string; model?: string; label?: string; multimodal?: boolean; contextWindow?: number }): AgentModel {
  const entry = upsertLocalModel(info);
  setSelectedModelId(LOCAL_MODEL_ID);
  return entry;
}

/** Deactivate the local model: remove it from the list (removeModel will select the first list entry if the removed one was selected). */
export function deactivateLocalModel(): void {
  removeModel(LOCAL_MODEL_ID);
}

export function hasLocalModel(): boolean {
  return loadModelList().some((m) => m.id === LOCAL_MODEL_ID);
}
