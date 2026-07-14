"use client";

/**
 * 沙箱启动进度弹窗（仅日常模式）。取代原「正在启动沙箱…」小 toast：
 *   步骤 1 · 运行环境（QEMU VM 镜像）：首次运行从 CDN 下载 → 进度条 + MB；已存在 → 「已下载」；
 *            版本与 versions.json 目标不一致（有旧版本残留）→ 显示「有新版本」+ 更新按钮。
 *            该步骤下方给出镜像所在文件夹（可点击打开）。
 *   步骤 2 · 启动沙箱：QEMU 引导（无细粒度进度）→ 不确定态转圈；就绪打勾后自动关闭。
 * 状态来自主进程 sandbox:status（见 electron/tools/sandbox/{engine,qemu}.mjs 的 setStatus / onProgress）。
 * 可关闭：关闭后本轮不再自动弹出，沙箱继续在后台初始化（命令在就绪前回退宿主执行）。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Check, AlertTriangle, HardDriveDownload, Cpu, FolderOpen, RefreshCw, Play } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getSandboxVmInfo, updateSandbox, restartSandbox, type SandboxStatus, type SandboxVmInfo } from "@/lib/ai/sandbox";

// 主进程「初始化进行中」的各阶段（qemu 主要是 starting；另两枚为兼容旧 docker 引擎）。
const ACTIVE = new Set(["starting", "pulling-image", "installing-runtime"]);

type StepState = "pending" | "active" | "done" | "error";

function StepRow({
  state,
  icon,
  title,
  detail,
  pct,
  children,
}: {
  state: StepState;
  icon: React.ReactNode;
  title: string;
  detail?: string;
  pct?: number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          state === "done"
            ? "bg-emerald-500/15 text-emerald-600"
            : state === "active"
              ? "bg-primary/15 text-primary"
              : state === "error"
                ? "bg-destructive/15 text-destructive"
                : "bg-surface-muted text-ink-subtle"
        }`}
      >
        {state === "done" ? <Check className="size-3.5" /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" /> : state === "error" ? <AlertTriangle className="size-3.5" /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${state === "pending" ? "text-ink-subtle" : "text-ink"}`}>{title}</div>
        {detail && <div className={`mt-0.5 text-xs ${state === "error" ? "break-words text-destructive" : "truncate text-ink-subtle"}`}>{detail}</div>}
        {state === "active" && typeof pct === "number" && (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
        )}
        {children}
      </div>
      {state === "active" && typeof pct === "number" && (
        <span className="shrink-0 text-xs tabular-nums text-ink-muted">{pct}%</span>
      )}
    </div>
  );
}

export default function SandboxStartupDialog({
  status,
  mode,
  openTick = 0,
}: {
  status: SandboxStatus | null;
  mode: string;
  /** 外部触发打开（如点击顶部「沙箱执行」徽标）：每次自增即打开当前状态视图。 */
  openTick?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const dismissedRef = useRef(false); // 用户本轮已关闭：不再自动弹回
  const manualRef = useRef(false); // 由徽标手动打开：不自动关闭（让用户自行查看/关闭）
  const [sawDownload, setSawDownload] = useState(false); // 本轮是否发生过下载（区分「已下载」与「下载完成」）
  const [dl, setDl] = useState<{ pct: number | null; text: string }>({ pct: null, text: "" });
  const [vmInfo, setVmInfo] = useState<SandboxVmInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const phase = status?.phase ?? "idle";
  const reason = status?.reason ?? "";
  const isDaily = mode === "daily";
  const vmDir = vmInfo?.dir ?? null;

  // 徽标点击：打开弹窗（手动态）。
  useEffect(() => {
    if (!openTick) return;
    manualRef.current = true;
    dismissedRef.current = false;
    setOpen(true);
  }, [openTick]);

  // 打开时拉取 VM 镜像信息（版本 / 是否可更新 / 目录）；就绪或更新态变化后刷新一次。
  useEffect(() => {
    if (open) getSandboxVmInfo().then((i) => setVmInfo(i));
  }, [open, phase]);

  useEffect(() => {
    if (!isDaily) { if (!manualRef.current) setOpen(false); return; } // 手动打开（徽标）不受模式限制
    if (phase !== "error") setRestarting(false); // 已离开错误态（开始重启/就绪）→ 复位按钮
    if (ACTIVE.has(phase)) {
      if (reason.startsWith("下载运行环境")) {
        setSawDownload(true);
        setDl({ pct: status?.pct ?? null, text: reason });
      } else if (reason.includes("运行环境就绪") || reason.includes("已就绪") || status?.pct === 100) {
        setDl({ pct: 100, text: reason });
      }
      if (!dismissedRef.current) setOpen(true);
    } else if (phase === "error") {
      if (!dismissedRef.current) setOpen(true);
    } else {
      // ready / idle / disabled / unsupported → 本轮结束，复位以备下次
      dismissedRef.current = false;
      setSawDownload(false);
      setDl({ pct: null, text: "" });
      setUpdating(false);
    }
  }, [phase, reason, status?.pct, isDaily]);

  // 就绪后短暂展示「已就绪」再自动关闭——仅当是自动弹出（非徽标手动打开）时。
  useEffect(() => {
    if (phase === "ready" && open && !manualRef.current) {
      const t = setTimeout(() => setOpen(false), 1400);
      return () => clearTimeout(t);
    }
  }, [phase, open]);

  const onOpenChange = (o: boolean) => {
    if (!o) { dismissedRef.current = true; manualRef.current = false; } // 记住本轮已被用户关闭
    setOpen(o);
  };

  // 步骤态推导
  const errored = phase === "error";
  const imageDone = phase === "ready" || dl.pct === 100 || (errored && !!vmInfo?.version); // VM 崩溃时镜像仍在
  const downloading = ACTIVE.has(phase) && sawDownload && !imageDone;
  const imageState: StepState = imageDone ? "done" : errored ? "error" : downloading ? "active" : ACTIVE.has(phase) ? "active" : "pending";
  const updatable = !!vmInfo?.updatable && !downloading && !updating;
  const imageDetail = updatable
    ? t("sbx.updatable")
    : imageDone
      ? sawDownload ? t("sbx.downloadDone") : t("sbx.alreadyDownloaded")
      : errored ? (reason || t("sbx.unknownError")) : downloading ? (dl.text || t("sbx.downloading")) : updating ? t("sbx.preparingUpdate") : t("sbx.checking");

  // VM 退出（error）时：启动步骤标红并给出重启按钮（详因见 reason）。
  const bootState: StepState = phase === "ready" ? "done" : errored ? "error" : imageDone && ACTIVE.has(phase) ? "active" : "pending";
  const bootDetail = phase === "ready" ? t("sbx.bootReady") : errored ? (reason || t("sbx.unknownError")) : bootState === "active" ? t("sbx.booting") : t("sbx.bootWaiting");

  const openFolder = () => {
    if (!vmDir) return;
    (window as unknown as { shellApi?: { openPath?: (p: string) => void } }).shellApi?.openPath?.(vmDir);
  };

  const doUpdate = () => {
    manualRef.current = true; // 更新时保持弹窗打开看进度
    setUpdating(true);
    void updateSandbox();
  };

  // VM 退出后重新拉起（用已有镜像，不重新下载）。保持弹窗打开以显示启动进度。
  const doRestart = () => {
    manualRef.current = true;
    dismissedRef.current = false;
    setRestarting(true);
    void restartSandbox();
  };

  const shortVersion = vmInfo?.version ? vmInfo.version.replace(/^sha-/, "").slice(0, 12) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{phase === "ready" ? t("sbx.readyTitle") : errored ? t("sbx.stoppedTitle") : t("sbx.preparingTitle")}</DialogTitle>
          <DialogDescription>
            {errored ? t("sbx.stoppedDesc") : t("sbx.desc")}
          </DialogDescription>
        </DialogHeader>

        {/* VM 退出后同样保留两步式布局：启动步骤标红 + 「启动沙箱」按钮（用已有镜像重启）。 */}
        <div className="min-w-0 space-y-4 py-1">
            <StepRow
              state={updatable ? "active" : imageState}
              icon={updatable ? <RefreshCw className="size-3.5" /> : <HardDriveDownload className="size-3.5" />}
              title={t("sbx.imageStep")}
              detail={imageDetail}
              pct={downloading ? dl.pct : undefined}
            >
              {/* 版本 + 更新按钮（版本不一致时）。 */}
              {(shortVersion || updatable) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-subtle">
                  {shortVersion && <span className="font-mono">{t("sbx.version", { v: shortVersion })}</span>}
                  {updatable && (
                    <button
                      type="button"
                      onClick={doUpdate}
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-medium text-white transition hover:brightness-105"
                    >
                      <RefreshCw className="size-3" /> {t("sbx.updateBtn")}
                    </button>
                  )}
                </div>
              )}
              {/* 镜像所在文件夹：点击打开（Electron shell）。放在「已下载」下方。 */}
              {vmDir && (
                <button
                  type="button"
                  onClick={openFolder}
                  title={t("sbx.openImageDir")}
                  className="mt-1.5 flex w-full min-w-0 max-w-full items-center gap-2 rounded-lg border border-line bg-surface-muted/40 px-2.5 py-1.5 text-left text-[11px] text-ink-subtle transition hover:bg-surface-muted"
                >
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono">{vmDir}</span>
                  <span className="shrink-0 font-medium text-primary">{t("sbx.open")}</span>
                </button>
              )}
            </StepRow>
            <StepRow
              state={bootState}
              icon={<Cpu className="size-3.5" />}
              title={t("sbx.bootStep")}
              detail={bootDetail}
            >
              {errored && (
                <button
                  type="button"
                  onClick={doRestart}
                  disabled={restarting}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-60"
                >
                  {restarting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  {restarting ? t("sbx.booting") : t("sbx.startBtn")}
                </button>
              )}
            </StepRow>
          </div>
      </DialogContent>
    </Dialog>
  );
}
