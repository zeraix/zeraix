"use client";

/**
 * Sandbox startup progress dialog (daily mode only). Replaces the old "Starting sandbox…" toast:
 *   Step 1 · Runtime environment (QEMU VM image): first run downloads from the CDN → progress bar + MB; already present → "Downloaded";
 *            version differs from the versions.json target (a stale old version left over) → shows "New version available" + update button.
 *            This step shows the folder the image lives in below it (click to open).
 *   Step 2 · Start sandbox: QEMU boot (no fine-grained progress) → indeterminate spinner; auto-closes once the ready check passes.
 * Status comes from the main process sandbox:status (see setStatus / onProgress in electron/tools/sandbox/{engine,qemu}.mjs).
 * Dismissible: once dismissed it won't auto-pop again this round, and the sandbox keeps initializing in the background (commands fall back to host execution until ready).
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

// The phases of the main process's "initializing" state (qemu is mainly "starting"; the other two are for compatibility with the old docker engine).
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
  /** Externally triggered open (e.g. clicking the top "sandbox execution" badge): each increment opens the current status view. */
  openTick?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const dismissedRef = useRef(false); // User dismissed it this round: don't auto-pop back up
  const manualRef = useRef(false); // Opened manually via the badge: don't auto-close (let the user view/close it themselves)
  const [sawDownload, setSawDownload] = useState(false); // Whether a download happened this round (distinguishes "already downloaded" from "download complete")
  const [dl, setDl] = useState<{ pct: number | null; text: string }>({ pct: null, text: "" });
  const [vmInfo, setVmInfo] = useState<SandboxVmInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const phase = status?.phase ?? "idle";
  const reason = status?.reason ?? "";
  const isDaily = mode === "daily";
  const vmDir = vmInfo?.dir ?? null;

  // Badge click: open the dialog (manual state).
  useEffect(() => {
    if (!openTick) return;
    manualRef.current = true;
    dismissedRef.current = false;
    setOpen(true);
  }, [openTick]);

  // On open, fetch VM image info (version / whether updatable / directory); refresh once after ready or update state changes.
  useEffect(() => {
    if (open) getSandboxVmInfo().then((i) => setVmInfo(i));
  }, [open, phase]);

  useEffect(() => {
    if (!isDaily) { if (!manualRef.current) setOpen(false); return; } // Manual open (badge) is not restricted by mode
    if (phase !== "error") setRestarting(false); // Already left the error state (restart started / ready) → reset button
    if (ACTIVE.has(phase)) {
      if (reason.startsWith("Downloading runtime environment")) {
        setSawDownload(true);
        setDl({ pct: status?.pct ?? null, text: reason });
      } else if (reason.includes("Runtime environment ready") || status?.pct === 100) {
        setDl({ pct: 100, text: reason });
      }
      if (!dismissedRef.current) setOpen(true);
    } else if (phase === "error") {
      if (!dismissedRef.current) setOpen(true);
    } else {
      // ready / idle / disabled / unsupported → this round is over, reset for next time
      dismissedRef.current = false;
      setSawDownload(false);
      setDl({ pct: null, text: "" });
      setUpdating(false);
    }
  }, [phase, reason, status?.pct, isDaily]);

  // After ready, briefly show "ready" then auto-close — only when auto-popped (not manually opened via the badge).
  useEffect(() => {
    if (phase === "ready" && open && !manualRef.current) {
      const t = setTimeout(() => setOpen(false), 1400);
      return () => clearTimeout(t);
    }
  }, [phase, open]);

  const onOpenChange = (o: boolean) => {
    if (!o) { dismissedRef.current = true; manualRef.current = false; } // Remember it was dismissed by the user this round
    setOpen(o);
  };

  // Step state derivation
  const errored = phase === "error";
  const imageDone = phase === "ready" || dl.pct === 100 || (errored && !!vmInfo?.version); // The image is still present when the VM crashes
  const downloading = ACTIVE.has(phase) && sawDownload && !imageDone;
  const imageState: StepState = imageDone ? "done" : errored ? "error" : downloading ? "active" : ACTIVE.has(phase) ? "active" : "pending";
  const updatable = !!vmInfo?.updatable && !downloading && !updating;
  const imageDetail = updatable
    ? t("sbx.updatable")
    : imageDone
      ? sawDownload ? t("sbx.downloadDone") : t("sbx.alreadyDownloaded")
      : errored ? (reason || t("sbx.unknownError")) : downloading ? (dl.text || t("sbx.downloading")) : updating ? t("sbx.preparingUpdate") : t("sbx.checking");

  // When the VM exits (error): mark the startup step red and offer a restart button (see reason for details).
  const bootState: StepState = phase === "ready" ? "done" : errored ? "error" : imageDone && ACTIVE.has(phase) ? "active" : "pending";
  const bootDetail = phase === "ready" ? t("sbx.bootReady") : errored ? (reason || t("sbx.unknownError")) : bootState === "active" ? t("sbx.booting") : t("sbx.bootWaiting");

  const openFolder = () => {
    if (!vmDir) return;
    (window as unknown as { shellApi?: { openPath?: (p: string) => void } }).shellApi?.openPath?.(vmDir);
  };

  const doUpdate = () => {
    manualRef.current = true; // Keep the dialog open during update to watch progress
    setUpdating(true);
    void updateSandbox();
  };

  // Re-launch after VM exit (using the existing image, no re-download). Keep the dialog open to show startup progress.
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

        {/* After VM exit, keep the same two-step layout: startup step marked red + "Start sandbox" button (restart with the existing image). */}
        <div className="min-w-0 space-y-4 py-1">
            <StepRow
              state={updatable ? "active" : imageState}
              icon={updatable ? <RefreshCw className="size-3.5" /> : <HardDriveDownload className="size-3.5" />}
              title={t("sbx.imageStep")}
              detail={imageDetail}
              pct={downloading ? dl.pct : undefined}
            >
              {/* Version + update button (when versions differ). */}
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
              {/* Folder the image lives in: click to open (Electron shell). Placed below "Downloaded". */}
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
