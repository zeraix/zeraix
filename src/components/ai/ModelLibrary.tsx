"use client";

/**
 * 模型库：本地大模型（llama.cpp）管理。
 *   顶部：本地推理运行时（安装 / 更新 / 重新检测 + 检测到的硬件 + 目录）。
 *   两个标签：推荐模型（全部适配本机的推荐项）/ 已安装（权重 + mmproj/mtp 完整下载的）。
 *   每个模型一张卡片（2 列网格）；点卡片弹出「选项对话框」：量化 / 上下文（可手输 K）/ KV / 视觉，
 *   实时估算占用；启动 / 停止（至多一个）/ 取消下载 / 打开文件夹 / 删除 / 重置。
 * 全部文案走 i18n（ml.* / local.note.*）。状态与进度来自主进程 window.localLlm。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Cpu, Play, Square, Trash2, FolderOpen, Loader2, Download, Check, Sparkles, RotateCcw, X, RefreshCw, HardDrive, Copy, FileText, FolderSync } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  localLlm,
  type LocalLlmStatus,
  type LocalLlmRecommendation,
  type LocalLlmHardware,
  type LocalLlmLlamaInfo,
  type LocalLlmStorage,
  type DownloadedLocalModel,
} from "@/lib/ai/localModel";

type Opt = LocalLlmRecommendation["options"][number];
const CTX_LADDER = [16384, 32768, 65536, 131072, 262144];
const OPTS_KEY = "zeraix.modelLibrary.opts";
const HW_KEY = "zeraix.modelLibrary.hw";
const fmtGB = (bytes: number) => `${(bytes / 1073741824).toFixed(1)} GB`;
const fmtK = (n: number) => `${Math.round(n / 1024)}K`;
// OpenAI 兼容基址（去掉 /chat/completions）——三方 Agent 应用里通常填这个 base URL。
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
  const [tab, setTab] = useState<"recommended" | "installed">("recommended");
  const [dialogId, setDialogId] = useState<string | null>(null);
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
      // 就绪/停止 → 聊天清单同步交给全局 LocalModelSync；此处只刷新已安装列表。
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

  const installing = status?.phase === "downloading" || status?.phase === "extracting"; // 运行时安装
  // 仅在「空闲」时允许更改/迁移文件夹：无运行时安装、无模型下载、无模型在跑/加载（否则会与正写入的文件冲突）。
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
  // 推荐 = 尚未安装的推荐项；已安装 = 已装的。每个模型只出现在一个标签里。
  const shown = tab === "installed" ? options.filter((o) => installedIds.has(o.model.id)) : options.filter((o) => !installedIds.has(o.model.id));
  const dlgOpt = options.find((o) => o.model.id === dialogId) ?? null;

  // 单个模型的运行态派生。
  const stateOf = (o: Opt) => {
    const mo = opts[o.model.id] ?? defaults[o.model.id] ?? { quant: o.quant.id, ctx: o.ctx ?? 16384, kvBits: o.kvBits ?? 8, vision: true };
    const dl = downloaded.find((d) => d.modelId === o.model.id && d.quant === mo.quant); // 选中量化是否已装
    const anyDl = downloaded.find((d) => d.modelId === o.model.id) ?? null;
    const isThis = status?.model?.id === o.model.id;
    const isRunning = !!isThis && !!status?.ready && !installing;
    const isFetching = !!isThis && status?.phase === "fetching";
    const isLoading = !!isThis && !status?.ready && (status?.phase === "fetching" || status?.phase === "loading");
    return { mo, dl, anyDl, isThis, isRunning, isFetching, isLoading, sizeGB: est[o.model.id] };
  };

  const start = (o: Opt, mo: ModelOpts) => { setBusy(true); bridge.start({ modelId: o.model.id, quantId: mo.quant, ctx: mo.ctx, kvBits: mo.kvBits, vision: mo.vision, mtp: mo.mtp, useCuda }).finally(() => setBusy(false)); };
  const stop = () => { setBusy(true); bridge.stop().finally(() => setBusy(false)); };
  // 更改存储文件夹：原生选目录 → 迁移已下载的运行时/模型/日志到新位置（同盘秒级，跨盘拷贝）。
  const changeFolder = async () => {
    setMigrating(true);
    try { const r = await bridge.chooseStorageDir(); if (r?.migrateError) alert(t("ml.migrateFailed", { err: r.migrateError })); await refresh(); }
    finally { setMigrating(false); }
  };

  // 卡片上的启停/进度按钮（card 与 dialog 共用）。
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

      {/* ── 运行时（含存储文件夹 + 更改/迁移 + 运行日志） ── */}
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
        {/* 存储文件夹（运行时 + 模型 + 日志同处）+ 运行日志 + 更改文件夹（迁移；仅空闲可点）。 */}
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

      {/* ── 标签 ── */}
      <div className="flex items-center gap-1 border-b border-line">
        {(["recommended", "installed"] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={`relative -mb-px border-b-2 px-3 py-2 text-sm transition ${tab === k ? "border-primary font-medium text-ink" : "border-transparent text-ink-subtle hover:text-ink"}`}>
            {k === "recommended" ? t("ml.tabRecommended") : t("ml.tabInstalled")}
            {k === "installed" && installedIds.size > 0 && <span className="ml-1 rounded-full bg-surface-muted px-1.5 text-[10px] text-ink-muted">{installedIds.size}</span>}
          </button>
        ))}
      </div>

      {/* ── 卡片网格 ── */}
      {shown.length === 0 ? (
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
        </div>
      )}

      {/* ── 选项对话框 ── */}
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
                  <DialogTitle className="flex items-center gap-2">{o.model.name}{s.isRunning && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">{t("ml.running")}</span>}</DialogTitle>
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
                        <input type="number" min={1} max={Math.round(maxCtx / 1024)} step={1} value={Math.round(mo.ctx / 1024)} disabled={locked}
                          onChange={(e) => { const k = Math.max(1, Math.min(Math.round(maxCtx / 1024), Math.floor(Number(e.target.value) || 1))); setOpt(o.model.id, { ctx: k * 1024 }); }}
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
    </div>
  );
}
