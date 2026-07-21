"use client";

/**
 * Model library: local large-model (llama.cpp) management.
 *   Top: local inference runtime (install / update / re-detect + detected hardware + directory).
 *   Two tabs: recommended models (all recommendations that fit this machine) / installed (weights + fully downloaded mmproj/mtp).
 *   One card per model (2-column grid); clicking a card opens an "options dialog": quant / context (K can be typed) / KV / vision,
 *   with live usage estimation; start / stop (at most one) / cancel download / open folder / delete / reset.
 * All copy goes through i18n (ml.* / local.note.*). Status and progress come from the main process window.localLlm.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Cpu, Play, Square, Trash2, FolderOpen, Loader2, Download, Check, Sparkles, RotateCcw, X, RefreshCw, HardDrive, Copy, FileText, FolderSync, Search, AlertTriangle } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ModelIcon from "@/components/ai/ModelIcon";
import {
  localLlm,
  type LocalLlmStatus,
  type LocalLlmRecommendation,
  type LocalLlmHardware,
  type LocalLlmLlamaInfo,
  type LocalLlmStorage,
  type DownloadedLocalModel,
  type HfSearchItem,
  type HfRepoDetail,
} from "@/lib/ai/localModel";

type Opt = LocalLlmRecommendation["options"][number];
/** Minimum selectable context window — mirrors MIN_CTX in electron/llm/localModels.mjs. The agent system prompt alone
 *  already approaches 8K, so a smaller window leaves no room for tools or history and is never offered. */
const MIN_CTX = 32768;
const CTX_LADDER = [32768, 65536, 131072, 262144, 524288, 1048576];
/** Context presets for a given native window: the standard rungs at or below it, always ending at the window itself
 *  (so a non-power-of-2 max like 40960 gets its exact value as the top button). Empty when the model can't reach MIN_CTX. */
const ctxPresets = (maxCtx: number): number[] => {
  if (maxCtx < MIN_CTX) return [];
  const rungs = CTX_LADDER.filter((c) => c < maxCtx);
  return rungs[rungs.length - 1] === maxCtx ? rungs : [...rungs, maxCtx];
};
/** Clamp a user-typed context into [MIN_CTX, maxCtx]. */
const clampCtx = (n: number, maxCtx: number) => Math.min(Math.max(n, MIN_CTX), Math.max(maxCtx, MIN_CTX));
const OPTS_KEY = "zeraix.modelLibrary.opts";
const HW_KEY = "zeraix.modelLibrary.hw";
const TMPL_KEY = "zeraix.modelLibrary.tmpl"; // per-repo chat-template override { [repo]: builtinName }
// llama.cpp built-in chat templates offered as overrides for community GGUFs with broken embedded templates. "" = use the model's own (default).
// chatml is the safe generic fallback (works for Qwen and most modern models); the rest cover common families.
const CHAT_TEMPLATES = ["chatml", "chatglm4", "llama3", "gemma", "deepseek3", "mistral-v7", "phi4", "command-r", "granite", "vicuna", "zephyr"];
const loadTmpl = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(TMPL_KEY) || "{}"); } catch { return {}; } };
const fmtGB = (bytes: number) => `${(bytes / 1073741824).toFixed(1)} GB`;
const fmtK = (n: number) => (n >= 1024 * 1024 ? `${Math.round((n / (1024 * 1024)) * 10) / 10}M` : `${Math.round(n / 1024)}K`);
// OpenAI-compatible base URL (strip /chat/completions) — this is the base URL you usually enter in third-party Agent apps.
const apiBase = (ep?: string) => (ep || "").replace(/\/chat\/completions\/?$/, "");
const openFolder = (p: string) =>
  (window as unknown as { shellApi?: { openPath?: (p: string) => void } }).shellApi?.openPath?.(p);

type ModelOpts = { quant: string; ctx: number; kvBits: number; vision: boolean; mtp: boolean };
const loadPersisted = (): Record<string, ModelOpts> => {
  try { return JSON.parse(localStorage.getItem(OPTS_KEY) || "{}"); } catch { return {}; }
};
const loadCachedHw = (): LocalLlmHardware | null => {
  try { return JSON.parse(localStorage.getItem(HW_KEY) || "null"); } catch { return null; }
};

export default function ModelLibrary() {
  const t = useT();
  const bridge = localLlm();
  const [hw, setHw] = useState<LocalLlmHardware | null>(() => loadCachedHw());
  const [llama, setLlama] = useState<LocalLlmLlamaInfo | null>(null);
  const [rec, setRec] = useState<LocalLlmRecommendation | null>(null);
  const [status, setStatus] = useState<LocalLlmStatus | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadedLocalModel[]>([]);
  const [tab, setTab] = useState<"recommended" | "installed" | "browse">("recommended");
  const [dialogId, setDialogId] = useState<string | null>(null);
  // Browse tab: Hub search + one repo's detail dialog.
  const [query, setQuery] = useState("");
  const [trusted, setTrusted] = useState(true);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<HfSearchItem[] | null>(null); // null = not searched yet (auto-searches on first open)
  const [searchErr, setSearchErr] = useState("");
  const [repoDlg, setRepoDlg] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<HfRepoDetail | null>(null); // null = loading
  const [repoQuant, setRepoQuant] = useState("");
  const [repoCtx, setRepoCtx] = useState(32768);
  const [repoKv, setRepoKv] = useState(8);
  const [repoTmpl, setRepoTmpl] = useState(""); // chat-template override for the open repo ("" = model's own)
  const [repoEst, setRepoEst] = useState<number | null>(null);
  const [opts, setOpts] = useState<Record<string, ModelOpts>>({});
  const [defaults, setDefaults] = useState<Record<string, ModelOpts>>({});
  const [est, setEst] = useState<Record<string, number>>({});
  const [useCuda, setUseCuda] = useState(false);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<LocalLlmStorage | null>(null);
  const [migrating, setMigrating] = useState(false);

  const KV_LABEL: Record<number, string> = { 8: t("ml.kv.q8"), 4: t("ml.kv.q4"), 16: t("ml.kv.f16") };
  const kvTag = (v: number) => (v === 16 ? "f16" : `q${v}_0`);
  const modelNote = (id: string, fallback: string) => { const s = t(`local.note.${id}`); return s === `local.note.${id}` ? fallback : s; };

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const [h, li, r, st, dl, sg] = await Promise.all([
      bridge.hardware(), bridge.llamaInfo(), bridge.recommend({}), bridge.status(), bridge.listModels(), bridge.storageInfo(),
    ]);
    setHw(h); setLlama(li); setRec(r); setStatus(st); setDownloaded(dl); setStorage(sg);
    try { localStorage.setItem(HW_KEY, JSON.stringify(h)); } catch { /* ignore */ }
    setUseCuda(li?.variant?.includes("cuda") ?? false);
    const recDefaults: Record<string, ModelOpts> = {};
    for (const o of r.options) recDefaults[o.model.id] = { quant: o.quant.id, ctx: o.ctx ?? 16384, kvBits: o.kvBits ?? 8, vision: true, mtp: true };
    setDefaults(recDefaults);
    const persisted = loadPersisted();
    setOpts((prev) => {
      const next = { ...prev };
      for (const o of r.options) next[o.model.id] = prev[o.model.id] ?? persisted[o.model.id] ?? recDefaults[o.model.id];
      return next;
    });
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!bridge) return;
    return bridge.onStatus((st) => {
      setStatus(st);
      // ready/stopped → syncing the chat list is handled by the global LocalModelSync; here we only refresh the installed list.
      if (st.phase === "ready" || st.phase === "idle" || st.phase === "error") bridge.listModels().then(setDownloaded);
    });
  }, [bridge]);

  const optsKey = useMemo(() => JSON.stringify(opts), [opts]);
  useEffect(() => {
    if (!bridge || !rec) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, number> = {};
      for (const o of rec.options) {
        const mo = opts[o.model.id];
        if (!mo) continue;
        const e = await bridge.estimate({ modelId: o.model.id, quant: mo.quant, ctx: mo.ctx, kvBits: mo.kvBits, vision: mo.vision, mtp: mo.mtp });
        if (e) next[o.model.id] = e.totalGB;
      }
      if (!cancelled) setEst(next);
    })();
    return () => { cancelled = true; };
  }, [bridge, rec, optsKey, opts]);

  // ── Browse tab: search + repo detail ──
  const runSearch = useCallback(async (q: string, tr: boolean) => {
    if (!bridge) return;
    setSearching(true);
    setSearchErr("");
    try {
      const r = await bridge.hfSearch({ query: q, trusted: tr });
      setResults(r.items);
      if (!r.ok) setSearchErr(r.error || "");
    } finally {
      setSearching(false);
    }
  }, [bridge]);
  // First open of the Browse tab: show trending trusted GGUF repos without requiring a query.
  useEffect(() => { if (tab === "browse" && results === null && !searching) void runSearch(query, trusted); }, [tab, results, searching, query, trusted, runSearch]);

  // Opening a repo dialog fetches its detail and preselects the offering closest to ~Q4 (the catalog's balanced default).
  useEffect(() => {
    if (!repoDlg || !bridge) return;
    setRepoInfo(null);
    setRepoQuant("");
    let alive = true;
    void bridge.hfRepo({ repo: repoDlg }).then((d) => {
      if (!alive) return;
      setRepoInfo(d);
      if (d.ok && d.quants?.length) {
        const target = d.gguf?.total ? (d.gguf.total * 4.85) / 8 : 0;
        const pick = target ? [...d.quants].sort((a, b) => Math.abs(a.bytes - target) - Math.abs(b.bytes - target))[0] : d.quants[Math.floor(d.quants.length / 2)];
        setRepoQuant(pick.id);
        // Default context: the 32K floor (usable headroom over the ~6K system prompt). Repos whose native window is
        // smaller are rejected outright via belowMinCtx, so there is nothing below this to clamp down to.
        setRepoCtx(MIN_CTX);
        setRepoKv(8);
      }
    });
    // Restore any override for this repo: a persisted manifest value (from a prior auto-fallback) wins over the local choice.
    setRepoTmpl(downloaded.find((x) => x.repo === repoDlg)?.chatTemplate || loadTmpl()[repoDlg] || "");
    return () => { alive = false; };
  }, [repoDlg, bridge]);

  // Persist the per-repo chat-template override so restarts (and startCustom from the Installed tab) reuse it.
  const setRepoTmplPersist = (repo: string, tmpl: string) => {
    setRepoTmpl(tmpl);
    try { const m = loadTmpl(); if (tmpl) m[repo] = tmpl; else delete m[repo]; localStorage.setItem(TMPL_KEY, JSON.stringify(m)); } catch { /* ignore */ }
  };

  // Live estimate for the selected quant / context / KV.
  useEffect(() => {
    if (!bridge || !repoDlg || !repoInfo?.ok || !repoQuant) { setRepoEst(null); return; }
    let alive = true;
    void bridge.estimate({ repo: repoDlg, meta: repoInfo.gguf ?? null, quant: repoQuant, ctx: repoCtx, kvBits: repoKv, vision: !!repoInfo.mmproj })
      .then((e) => { if (alive) setRepoEst(e?.totalGB ?? null); });
    return () => { alive = false; };
  }, [bridge, repoDlg, repoInfo, repoQuant, repoCtx, repoKv]);

  const startRepo = (repo: string, info: HfRepoDetail, quant: string) => {
    setBusy(true);
    bridge?.start({ hf: `${repo}:${quant}`, label: repo.split("/").pop(), multimodal: !!info.mmproj, mtp: !!info.mtp, meta: info.gguf ?? null, ctx: repoCtx, kvBits: repoKv, chatTemplate: repoTmpl || null, useCuda }).finally(() => setBusy(false));
  };
  // Restart an installed community model from its manifest (gguf header persisted at download time); reuse any saved template override.
  const startCustom = (d: DownloadedLocalModel) => {
    setBusy(true);
    bridge?.start({ hf: `${d.repo}:${d.quant}`, label: d.name, multimodal: !!d.vision, mtp: !!d.mtp, meta: d.gguf ?? null, chatTemplate: d.chatTemplate || loadTmpl()[d.repo] || null, useCuda }).finally(() => setBusy(false));
  };

  const installing = status?.phase === "downloading" || status?.phase === "extracting"; // runtime install
  // Only allow changing/migrating the folder when "idle": no runtime install, no model download, no model running/loading (otherwise it would conflict with files being written).
  const busyPhase = status ? (status.running || ["downloading", "extracting", "fetching", "loading", "probing"].includes(status.phase)) : false;
  const migrateBlocked = migrating || busy || busyPhase;
  const cudaAvailable = !!hw?.cuda?.available;
  const setOpt = (id: string, patch: Partial<ModelOpts>) =>
    setOpts((p) => { const next = { ...p, [id]: { ...p[id], ...patch } }; try { localStorage.setItem(OPTS_KEY, JSON.stringify(next)); } catch { /* ignore */ } return next; });

  if (!bridge) return <p className="text-sm text-ink-subtle">{t("ml.desktopOnly")}</p>;
  if (hw && hw.supported === false) {
    return <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">{t("ml.insufficient", { gb: hw.minMemGB ?? 8 })}</p>;
  }

  const options = rec?.options ?? [];
  const installedIds = new Set(downloaded.map((d) => d.modelId));
  // recommended = recommendations not yet installed; installed = the installed ones. Each model appears in only one tab.
  const shown = tab === "installed" ? options.filter((o) => installedIds.has(o.model.id)) : options.filter((o) => !installedIds.has(o.model.id));
  // Community (Browse-tab) downloads: no catalog card, rendered from their manifest in the installed tab.
  const customInstalled = tab === "installed" ? downloaded.filter((d) => d.custom) : [];
  const dlgOpt = options.find((o) => o.model.id === dialogId) ?? null;

  // Derive the runtime state of a single model.
  const stateOf = (o: Opt) => {
    const mo = opts[o.model.id] ?? defaults[o.model.id] ?? { quant: o.quant.id, ctx: o.ctx ?? 16384, kvBits: o.kvBits ?? 8, vision: true };
    const dl = downloaded.find((d) => d.modelId === o.model.id && d.quant === mo.quant); // whether the selected quant is already installed
    const anyDl = downloaded.find((d) => d.modelId === o.model.id) ?? null;
    const isThis = status?.model?.id === o.model.id;
    const isRunning = !!isThis && !!status?.ready && !installing;
    const isFetching = !!isThis && status?.phase === "fetching";
    const isLoading = !!isThis && !status?.ready && (status?.phase === "fetching" || status?.phase === "loading");
    return { mo, dl, anyDl, isThis, isRunning, isFetching, isLoading, sizeGB: est[o.model.id] };
  };

  const start = (o: Opt, mo: ModelOpts) => { setBusy(true); bridge.start({ modelId: o.model.id, quantId: mo.quant, ctx: mo.ctx, kvBits: mo.kvBits, vision: mo.vision, mtp: mo.mtp, useCuda }).finally(() => setBusy(false)); };
  const stop = () => { setBusy(true); bridge.stop().finally(() => setBusy(false)); };
  // Change storage folder: native directory picker → migrate the downloaded runtime/models/logs to the new location (instant on the same drive, copy across drives).
  const changeFolder = async () => {
    setMigrating(true);
    try { const r = await bridge.chooseStorageDir(); if (r?.migrateError) alert(t("ml.migrateFailed", { err: r.migrateError })); await refresh(); }
    finally { setMigrating(false); }
  };

  // Start/stop/progress button on the card (shared by card and dialog).
  const ActionButton = ({ o, size = "sm" }: { o: Opt; size?: "sm" | "lg" }) => {
    const s = stateOf(o);
    const cls = size === "lg" ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs";
    if (s.isRunning) return <button onClick={(e) => { e.stopPropagation(); stop(); }} className={`inline-flex items-center gap-1 rounded-lg border border-line-strong ${cls} text-ink transition hover:bg-surface-muted`}><Square className="size-3" /> {t("ml.stop")}</button>;
    if (s.isLoading) return <button onClick={(e) => { e.stopPropagation(); bridge.stop(); }} className={`inline-flex items-center gap-1 rounded-lg ${cls} text-primary transition hover:bg-primary/10`} title={t("ml.cancel")}><Loader2 className="size-3 animate-spin" /> {s.isFetching ? t("ml.downloadPct", { pct: status?.pct ?? 0 }) : t("ml.loading")} <X className="size-3" /></button>;
    return <button onClick={(e) => { e.stopPropagation(); start(o, s.mo); }} className={`inline-flex items-center gap-1 rounded-lg bg-primary ${cls} font-medium text-white shadow-sm transition hover:brightness-105`}><Play className="size-3" /> {s.dl ? t("ml.start") : t("ml.downloadStart")}</button>;
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-subtle">{t("ml.pageDesc")}</p>

      {/* ── Runtime (incl. storage folder + change/migrate + run log) ── */}
      <section className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Cpu className="size-4 text-ink-muted" />
          <span className="text-sm font-medium text-ink">{t("ml.runtime")}</span>
          {llama?.installed ? (
            llama.upToDate ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-600"><Check className="size-3" /> {t("ml.installed")}{llama.variant ? ` · ${llama.variant}` : ""} · {llama.version}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400"><RefreshCw className="size-3" /> {t("ml.newVersion", { version: llama.version, old: llama.installedVersions[0] ?? "" })}</span>
            )
          ) : (
            <span className="text-xs text-ink-subtle">{t("ml.notInstalled")}</span>
          )}
          <button onClick={async () => { setBusy(true); try { if (!llama?.installed || llama?.updatable) await bridge.install({ useCuda }); else await bridge.probe({ useCuda }); await refresh(); } finally { setBusy(false); } }} disabled={busy || installing}
            className="ml-auto inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50">
            {installing ? <Loader2 className="size-3.5 animate-spin" /> : !llama?.installed || llama?.updatable ? <Download className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            {installing ? t("ml.installingPct", { pct: status?.pct ?? 0 }) : !llama?.installed ? t("ml.install") : llama?.updatable ? t("ml.update") : t("ml.recheck")}
          </button>
        </div>
        {installing && <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(3, status?.pct ?? 0)}%` }} /></div>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
          <span className="inline-flex items-center gap-1"><HardDrive className="size-3" /> {t("ml.detected", { mem: hw?.hw?.totalMemGB ?? "…" })}{hw?.hw?.unified ? t("ml.unifiedMem") : ""} · {status?.probe?.device || hw?.hw?.gpu?.name || (hw?.hw?.backend === "cpu" ? "CPU" : hw?.hw?.backend)}{status?.probe?.vramGB || hw?.hw?.gpu?.vramGB ? ` · ${t("ml.vram", { gb: status?.probe?.vramGB || hw?.hw?.gpu?.vramGB || 0 })}` : ""}</span>
          {cudaAvailable && <label className="ml-auto flex items-center gap-1"><input type="checkbox" checked={useCuda} disabled={busy || installing} onChange={(e) => setUseCuda(e.target.checked)} /> {t("ml.nvidiaAccel")}</label>}
        </div>
        {/* Storage folder (runtime + models + logs together) + run log + change folder (migrate; clickable only when idle). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2">
          {storage && (
            <button onClick={() => openFolder(storage.dir)} title={t("ml.openStorageDir")}
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-subtle transition hover:text-ink">
              <FolderOpen className="size-3 shrink-0" /> <span className="truncate font-mono">{storage.dir}</span>
              {storage.freeGB != null && <span className="shrink-0 text-ink-muted">· {t("ml.storageFree", { gb: storage.freeGB })}</span>}
            </button>
          )}
          {status?.logFile && <button onClick={() => openFolder(status.logFile!)} className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-subtle transition hover:text-ink" title={t("ml.viewLogTitle")}><FileText className="size-3 shrink-0" /> {t("ml.viewLog")}</button>}
          {storage && (
            <button onClick={changeFolder} disabled={migrateBlocked} title={busyPhase && !migrating ? t("ml.migrateBusyTip") : undefined}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1 text-[11px] text-ink transition hover:bg-surface-muted disabled:opacity-50">
              {migrating ? <Loader2 className="size-3 animate-spin" /> : <FolderSync className="size-3" />}
              {migrating ? t("ml.migrating") : t("ml.changeFolder")}
            </button>
          )}
        </div>
      </section>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 border-b border-line">
        {(["recommended", "installed", "browse"] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={`relative -mb-px border-b-2 px-3 py-2 text-sm transition ${tab === k ? "border-primary font-medium text-ink" : "border-transparent text-ink-subtle hover:text-ink"}`}>
            {k === "recommended" ? t("ml.tabRecommended") : k === "installed" ? t("ml.tabInstalled") : t("ml.tabBrowse")}
            {k === "installed" && installedIds.size > 0 && <span className="ml-1 rounded-full bg-surface-muted px-1.5 text-[10px] text-ink-muted">{installedIds.size}</span>}
          </button>
        ))}
      </div>

      {/* ── Browse tab: Hub search ── */}
      {tab === "browse" && (
        <div className="space-y-3">
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void runSearch(query, trusted); }}>
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5">
              <Search className="size-3.5 shrink-0 text-ink-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("ml.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted" />
            </span>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-subtle">
              <input type="checkbox" checked={trusted} onChange={(e) => { setTrusted(e.target.checked); void runSearch(query, e.target.checked); }} /> {t("ml.trustedOnly")}
            </label>
            <button type="submit" disabled={searching} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50">
              {searching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} {t("ml.search")}
            </button>
          </form>
          <p className="text-[11px] text-ink-muted">{t("ml.browseHint")}</p>
          {searchErr && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">{t("ml.browseError", { err: searchErr })}</p>}
          {searching && results === null ? (
            <p className="py-6 text-center text-sm text-ink-subtle"><Loader2 className="mr-1 inline size-3.5 animate-spin" /> {t("ml.searching")}</p>
          ) : (results ?? []).length === 0 && !searchErr ? (
            <p className="py-6 text-center text-sm text-ink-subtle">{t("ml.browseEmpty")}</p>
          ) : (
            <div className="divide-y divide-line rounded-xl border border-line bg-surface">
              {(results ?? []).map((r) => {
                const installedHere = downloaded.some((d) => d.repo === r.repo);
                return (
                  <button key={r.repo} onClick={() => setRepoDlg(r.repo)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-surface-muted">
                    <ModelIcon hints={[r.repo]} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{r.repo}</span>
                      <span className="mt-0.5 block text-[11px] text-ink-muted">{t("ml.downloadsN", { n: r.downloads.toLocaleString() })}{r.gated ? ` · ${t("ml.gated")}` : ""}</span>
                    </span>
                    {installedHere && <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">{t("ml.installed")}</span>}
                    <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-ink-muted" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Card grid (recommended / installed) ── */}
      {tab !== "browse" && (shown.length === 0 && customInstalled.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-subtle">{tab === "installed" ? t("ml.noInstalled") : t("ml.noModels")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shown.map((o) => {
            const s = stateOf(o);
            const isPrimary = rec?.primary?.model.id === o.model.id;
            return (
              <div key={o.model.id} role="button" tabIndex={0} onClick={() => setDialogId(o.model.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDialogId(o.model.id); } }}
                className={`flex cursor-pointer flex-col rounded-xl border bg-surface p-4 text-left transition hover:border-line-strong hover:shadow-sm ${s.isRunning ? "border-emerald-500/40" : "border-line"}`}>
                <div className="flex items-center gap-2">
                  <ModelIcon hints={[o.model.id, o.model.name]} />
                  <span className="truncate text-sm font-semibold text-ink">{o.model.name}</span>
                  {isPrimary && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600"><Sparkles className="size-2.5" /> {t("ml.recommended")}</span>}
                </div>
                <p className="mt-1 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-ink-subtle">{modelNote(o.model.id, o.model.notes)}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] text-ink-muted">{s.sizeGB != null ? `${s.sizeGB}GB` : ""} · {fmtK(s.mo.ctx)}</span>
                  {s.isRunning && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">{t("ml.running")}</span>}
                  <span className="ml-auto" onClick={(e) => e.stopPropagation()}><ActionButton o={o} /></span>
                </div>
                {s.isRunning && status?.endpoint && (
                  <button onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(apiBase(status.endpoint)); }} title={t("ml.copyUrl")}
                    className="mt-2 flex max-w-full items-center gap-1 text-[10px] text-ink-muted transition hover:text-ink">
                    <Copy className="size-2.5 shrink-0" /><span className="truncate font-mono">{apiBase(status.endpoint)}</span>
                  </button>
                )}
              </div>
            );
          })}
          {/* Community models (from Browse): rendered off their manifest; start/stop/delete like catalog cards, options fixed at download time. */}
          {customInstalled.map((d) => {
            const isThis = status?.model?.dir === d.dir || status?.model?.id === d.repo;
            const isRunning = !!isThis && !!status?.ready && !installing;
            const isFetching = !!isThis && status?.phase === "fetching";
            const isLoading = !!isThis && !status?.ready && (status?.phase === "fetching" || status?.phase === "loading");
            return (
              <div key={d.dir} className={`flex flex-col rounded-xl border bg-surface p-4 text-left transition ${isRunning ? "border-emerald-500/40" : "border-line"}`}>
                <div className="flex items-center gap-2">
                  <ModelIcon hints={[d.repo, d.name]} />
                  <span className="truncate text-sm font-semibold text-ink">{d.name}</span>
                  <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-ink-muted">{t("ml.community")}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-ink-subtle">{d.repo} · {d.quant}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] text-ink-muted">{fmtGB(d.sizeBytes)}</span>
                  {isRunning && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">{t("ml.running")}</span>}
                  {d.belowMinCtx && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">{t("ml.ctxTooSmall", { min: fmtK(MIN_CTX) })}</span>}
                  <span className="ml-auto flex items-center gap-1.5">
                    {isRunning ? (
                      <button onClick={stop} className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1 text-xs text-ink transition hover:bg-surface-muted"><Square className="size-3" /> {t("ml.stop")}</button>
                    ) : isLoading ? (
                      <button onClick={() => bridge.stop()} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-primary transition hover:bg-primary/10" title={t("ml.cancel")}>
                        <Loader2 className="size-3 animate-spin" /> {isFetching ? t("ml.downloadPct", { pct: status?.pct ?? 0 }) : t("ml.loading")} <X className="size-3" />
                      </button>
                    ) : (
                      // Installed before the 32K floor existed: keep it listed (so it can be inspected and deleted) but refuse to start it.
                      <button onClick={() => startCustom(d)} disabled={!!d.belowMinCtx} title={d.belowMinCtx ? t("ml.ctxTooSmall", { min: fmtK(MIN_CTX) }) : undefined}
                        className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-40 disabled:hover:brightness-100"><Play className="size-3" /> {t("ml.start")}</button>
                    )}
                    <button onClick={() => openFolder(d.dir)} className="rounded-lg border border-line p-1 text-ink-subtle transition hover:bg-surface-muted" title={t("ml.openWeightsDir")}><FolderOpen className="size-3.5" /></button>
                    <button onClick={async () => { if (d.running || isRunning) return; setBusy(true); await bridge.deleteModel({ dir: d.dir }); await bridge.listModels().then(setDownloaded); setBusy(false); }} disabled={d.running || isRunning || busy}
                      className="rounded-lg border border-destructive/30 p-1 text-destructive transition hover:bg-destructive/10 disabled:opacity-40" title={d.running || isRunning ? t("ml.deleteRunningTitle") : t("ml.deleteTitle")}><Trash2 className="size-3.5" /></button>
                  </span>
                </div>
                {isRunning && status?.endpoint && (
                  <button onClick={() => void navigator.clipboard?.writeText(apiBase(status.endpoint))} title={t("ml.copyUrl")}
                    className="mt-2 flex max-w-full items-center gap-1 text-[10px] text-ink-muted transition hover:text-ink">
                    <Copy className="size-2.5 shrink-0" /><span className="truncate font-mono">{apiBase(status.endpoint)}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* ── Options dialog ── */}
      <Dialog open={!!dlgOpt} onOpenChange={(v) => { if (!v) setDialogId(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dlgOpt && (() => {
            const o = dlgOpt;
            const s = stateOf(o);
            const mo = s.mo;
            const maxCtx = o.model.maxCtx ?? 32768;
            const locked = s.isRunning || s.isLoading;
            const isDefault = JSON.stringify(mo) === JSON.stringify(defaults[o.model.id]);
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><ModelIcon hints={[o.model.id, o.model.name]} size="lg" />{o.model.name}{s.isRunning &&<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">{t("ml.running")}</span>}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs leading-relaxed text-ink-subtle">{modelNote(o.model.id, o.model.notes)}</p>
                    <button onClick={() => setOpt(o.model.id, defaults[o.model.id])} disabled={isDefault || locked}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/10 disabled:border-line disabled:bg-transparent disabled:font-normal disabled:text-ink-subtle disabled:opacity-50" title={t("ml.resetTitle")}>
                      <RotateCcw className="size-3" /> {t("ml.reset")}
                    </button>
                  </div>
                  {s.isFetching && <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(3, status?.pct ?? 0)}%` }} /></div>}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs text-ink-subtle">{t("ml.quant")}
                      <select className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink disabled:opacity-50" value={mo.quant} disabled={locked}
                        onChange={(e) => { const nq = o.quants?.find((q) => q.id === e.target.value); setOpt(o.model.id, { quant: e.target.value, ctx: nq?.ctx ?? mo.ctx, kvBits: nq?.kvBits ?? mo.kvBits }); }}>
                        {o.quants?.map((q) => <option key={q.id} value={q.id} disabled={q.fits === false}>{q.id}{q.fits === false ? t("ml.wontFit") : ""}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5 text-xs text-ink-subtle">{t("ml.contextLen", { max: fmtK(maxCtx) })}
                      <span className="inline-flex w-fit items-center rounded-md border border-line-strong bg-surface">
                        <input type="number" min={Math.round(MIN_CTX / 1024)} max={Math.round(maxCtx / 1024)} step={1} value={Math.round(mo.ctx / 1024)} disabled={locked}
                          onChange={(e) => setOpt(o.model.id, { ctx: clampCtx(Math.floor(Number(e.target.value) || 0) * 1024, maxCtx) })}
                          className="w-14 bg-transparent px-2 py-1 text-right text-ink disabled:opacity-50" /><span className="pr-2 text-ink-muted">K</span>
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {CTX_LADDER.filter((c) => c <= maxCtx).map((c) => <button key={c} type="button" disabled={locked} onClick={() => setOpt(o.model.id, { ctx: c })} className={`rounded-md px-1.5 py-0.5 text-[11px] transition ${mo.ctx === c ? "bg-primary/15 font-medium text-primary" : "bg-surface-muted text-ink-subtle hover:bg-surface-muted/70"}`}>{fmtK(c)}</button>)}
                      </div>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-ink-subtle">{t("ml.kvQuant")}
                      <select className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink disabled:opacity-50" value={mo.kvBits} disabled={locked} onChange={(e) => setOpt(o.model.id, { kvBits: Number(e.target.value) })}>
                        {[8, 4, 16].map((v) => <option key={v} value={v}>{KV_LABEL[v]}</option>)}
                      </select>
                    </label>
                    {o.model.vision && (
                      <label className="flex flex-col gap-1 text-xs text-ink-subtle">{t("ml.vision")}
                        <label className="flex h-[30px] items-center gap-2 rounded-md border border-line-strong bg-surface px-2 text-ink"><input type="checkbox" checked={mo.vision} disabled={locked} onChange={(e) => setOpt(o.model.id, { vision: e.target.checked })} />{mo.vision ? t("ml.visionOn") : t("ml.visionOff")}</label>
                      </label>
                    )}
                    {o.model.mtp && (
                      <label className="flex flex-col gap-1 text-xs text-ink-subtle">{t("ml.mtp")}
                        <label className="flex h-[30px] items-center gap-2 rounded-md border border-line-strong bg-surface px-2 text-ink"><input type="checkbox" checked={mo.mtp !== false} disabled={locked} onChange={(e) => setOpt(o.model.id, { mtp: e.target.checked })} />{mo.mtp !== false ? t("ml.mtpOn") : t("ml.mtpOff")}</label>
                      </label>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-muted">{t("ml.estimate", { gb: s.sizeGB != null ? s.sizeGB : "…", ctx: fmtK(mo.ctx), kv: kvTag(mo.kvBits) })}</p>
                  {s.isRunning && status?.endpoint && (
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5">
                      <span className="shrink-0 text-[11px] text-ink-subtle">{t("ml.serverUrl")}</span>
                      <span className="truncate font-mono text-[11px] text-ink">{apiBase(status.endpoint)}</span>
                      <button onClick={() => void navigator.clipboard?.writeText(apiBase(status.endpoint))} title={t("ml.copyUrl")}
                        className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 transition hover:text-emerald-500"><Copy className="size-3" /> {t("ml.copy")}</button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <ActionButton o={o} size="lg" />
                    {s.dl && (
                      <>
                        <button onClick={() => openFolder(s.dl!.dir)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-subtle transition hover:bg-surface-muted" title={t("ml.openWeightsDir")}><FolderOpen className="size-3.5" /> {t("ml.openFolder")}</button>
                        <button onClick={async () => { if (s.dl!.running) return; setBusy(true); await bridge.deleteModel({ dir: s.dl!.dir }); await bridge.listModels().then(setDownloaded); setBusy(false); }} disabled={s.dl.running || busy}
                          className="inline-flex items-center gap-1 rounded-lg border border-destructive/30 px-2.5 py-1.5 text-xs text-destructive transition hover:bg-destructive/10 disabled:opacity-40" title={s.dl.running ? t("ml.deleteRunningTitle") : t("ml.deleteTitle")}><Trash2 className="size-3.5" /> {t("ml.delete", { size: fmtGB(s.dl.sizeBytes) })}</button>
                      </>
                    )}
                  </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Browse repo dialog: quant offerings + compat + download/start ── */}
      <Dialog open={!!repoDlg} onOpenChange={(v) => { if (!v) setRepoDlg(null); }}>
        <DialogContent className="sm:max-w-lg">
          {repoDlg && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-mono text-base"><ModelIcon hints={[repoDlg]} size="lg" /><span className="truncate">{repoDlg}</span></DialogTitle>
              </DialogHeader>
              {repoInfo === null ? (
                <p className="py-6 text-center text-sm text-ink-subtle"><Loader2 className="mr-1 inline size-3.5 animate-spin" /> {t("ml.searching")}</p>
              ) : !repoInfo.ok ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">{t("ml.browseError", { err: repoInfo.error || "" })}</p>
              ) : (() => {
                const info = repoInfo;
                const isThis = status?.model?.id === repoDlg;
                const isRunning = !!isThis && !!status?.ready;
                const isFetching = !!isThis && status?.phase === "fetching";
                const isLoading = !!isThis && !status?.ready && (status?.phase === "fetching" || status?.phase === "loading");
                const budget = rec?.budgetGB ?? null;
                return (
                  <div className="space-y-3 py-1">
                    {/* Metadata line: arch compat + params + native context + capabilities */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
                      {info.compat === "supported" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-600"><Check className="size-3" /> {t("ml.compatOk")}{info.arch ? ` · ${info.arch}` : ""}</span>
                      ) : info.compat === "unsupported" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3" /> {t("ml.compatNo")}{info.arch ? ` · ${info.arch}` : ""}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5"><AlertTriangle className="size-3" /> {t("ml.compatUnknown")}</span>
                      )}
                      {info.gguf?.total ? <span>{t("ml.paramsB", { b: (info.gguf.total / 1e9).toFixed(1) })}</span> : null}
                      {info.gguf?.context_length ? <span>{fmtK(info.gguf.context_length)} ctx</span> : null}
                      {info.mmproj && <span>{t("ml.vision")}</span>}
                      {info.gated ? <span className="text-amber-600 dark:text-amber-400">{t("ml.gated")}</span> : null}
                    </div>
                    {info.belowMinCtx && (
                      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                        {t("ml.ctxTooSmall", { min: fmtK(info.minCtx ?? MIN_CTX) })}
                      </p>
                    )}
                    {(info.quants ?? []).length === 0 ? (
                      <p className="py-4 text-center text-sm text-ink-subtle">{t("ml.noQuants")}</p>
                    ) : (() => {
                      const repoMaxCtx = info.gguf?.context_length || 32768;
                      return (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-xs text-ink-subtle">{t("ml.quant")}
                            <select className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink disabled:opacity-50" value={repoQuant} disabled={isLoading || isRunning}
                              onChange={(e) => setRepoQuant(e.target.value)}>
                              {(info.quants ?? []).map((q) => {
                                const wontFit = budget != null && q.bytes / 1e9 + 1 > budget;
                                return <option key={q.id} value={q.id}>{q.id} · {fmtGB(q.bytes)}{wontFit ? t("ml.wontFit") : ""}</option>;
                              })}
                            </select>
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-ink-subtle">{t("ml.kvQuant")}
                            <select className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink disabled:opacity-50" value={repoKv} disabled={isLoading || isRunning} onChange={(e) => setRepoKv(Number(e.target.value))}>
                              {[8, 4, 16].map((v) => <option key={v} value={v}>{KV_LABEL[v]}</option>)}
                            </select>
                          </label>
                          <label className="flex flex-col gap-1.5 text-xs text-ink-subtle sm:col-span-2">{t("ml.contextLen", { max: fmtK(repoMaxCtx) })}
                            <span className="inline-flex w-fit items-center rounded-md border border-line-strong bg-surface">
                              <input type="number" min={Math.round(MIN_CTX / 1024)} max={Math.round(repoMaxCtx / 1024)} step={1} value={Math.round(repoCtx / 1024)} disabled={isLoading || isRunning}
                                onChange={(e) => setRepoCtx(clampCtx(Math.floor(Number(e.target.value) || 0) * 1024, repoMaxCtx))}
                                className="w-14 bg-transparent px-2 py-1 text-right text-ink disabled:opacity-50" /><span className="pr-2 text-ink-muted">K</span>
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {ctxPresets(repoMaxCtx).map((c) => <button key={c} type="button" disabled={isLoading || isRunning} onClick={() => setRepoCtx(c)} className={`rounded-md px-1.5 py-0.5 text-[11px] transition ${repoCtx === c ? "bg-primary/15 font-medium text-primary" : "bg-surface-muted text-ink-subtle hover:bg-surface-muted/70"}`}>{fmtK(c)}</button>)}
                            </div>
                          </label>
                          {/* A template file shipped by the repo is loaded with --chat-template-file and outranks any
                              built-in pick, so the selector below would have no effect — disable it and say why. */}
                          <label className="flex flex-col gap-1 text-xs text-ink-subtle sm:col-span-2">{t("ml.chatTemplate")}
                            <select className="rounded-md border border-line-strong bg-surface px-2 py-1 text-ink disabled:opacity-50" value={repoTmpl} disabled={isLoading || isRunning || !!info.templateFile}
                              onChange={(e) => setRepoTmplPersist(repoDlg, e.target.value)}>
                              <option value="">{t("ml.chatTemplateAuto")}</option>
                              {CHAT_TEMPLATES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}
                            </select>
                            <span className="text-[11px] text-ink-muted">{info.templateFile ? t("ml.chatTemplateFile", { file: info.templateFile }) : t("ml.chatTemplateHint")}</span>
                          </label>
                        </div>
                      );
                    })()}
                    {repoEst != null && <p className="text-[11px] text-ink-muted">{t("ml.estimate", { gb: repoEst, ctx: fmtK(repoCtx), kv: kvTag(repoKv) })}</p>}
                    {isFetching && <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(3, status?.pct ?? 0)}%` }} /></div>}
                    {isRunning && status?.endpoint && (
                      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5">
                        <span className="shrink-0 text-[11px] text-ink-subtle">{t("ml.serverUrl")}</span>
                        <span className="truncate font-mono text-[11px] text-ink">{apiBase(status.endpoint)}</span>
                        <button onClick={() => void navigator.clipboard?.writeText(apiBase(status.endpoint))} title={t("ml.copyUrl")}
                          className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 transition hover:text-emerald-500"><Copy className="size-3" /> {t("ml.copy")}</button>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {isRunning ? (
                        <button onClick={stop} className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink transition hover:bg-surface-muted"><Square className="size-3" /> {t("ml.stop")}</button>
                      ) : isLoading ? (
                        <button onClick={() => bridge.stop()} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-primary transition hover:bg-primary/10" title={t("ml.cancel")}>
                          <Loader2 className="size-3 animate-spin" /> {isFetching ? t("ml.downloadPct", { pct: status?.pct ?? 0 }) : t("ml.loading")} <X className="size-3" />
                        </button>
                      ) : (
                        <button onClick={() => startRepo(repoDlg, info, repoQuant)} disabled={!repoQuant || busy || !!info.belowMinCtx}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50">
                          <Play className="size-3" /> {downloaded.some((d) => d.repo === repoDlg && d.quant === repoQuant) ? t("ml.start") : t("ml.downloadStart")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
