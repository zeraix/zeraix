"use client";

/**
 * 全局通知栏（右下角常驻）。两类内容：
 *  1. 运行中的本地服务（AI 跑起的 dev server 等）：显示项目地址，可点击在内置浏览器打开、可「停止」。
 *     由主进程后台进程启停事件驱动（带 pid → 可停止），并做健康探测，断连自动移除。
 *  2. notificationStore 通知：模型下载/安装进度、应用操作提示等。
 * 容器 pointer-events-none，仅卡片可交互，不遮挡页面点击。
 */
import { useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, Globe, Info, Loader2, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type AppNotification } from "@/store/notificationStore";
import { useServicesStore, type RunningService } from "@/store/servicesStore";
import { onServiceEvent, listServices, stopService } from "@/lib/ai/services";
import { requestOpenBrowser } from "@/lib/automation";
import { useT } from "@/lib/i18n";

const AUTO_DISMISS_MS = 5000;
const PING_MS = 6000;
const MAX_FAILS = 2;

/** no-cors 探活：可达 resolve，被拒 / 超时 reject。 */
async function ping(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export default function GlobalNotifications() {
  const t = useT();
  const items = useNotificationStore((s) => s.items);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const scheduled = useRef<Set<string>>(new Set());

  const services = useServicesStore((s) => s.services);
  const upsert = useServicesStore((s) => s.upsert);
  const removeByPid = useServicesStore((s) => s.removeByPid);
  const removeByUrl = useServicesStore((s) => s.removeByUrl);
  const failsRef = useRef<Record<string, number>>({});

  // 订阅后台服务启停事件 + 初始同步。
  useEffect(() => {
    void listServices().then((list) =>
      list.forEach((s) => upsert({ url: s.url, pid: s.pid, command: s.command })),
    );
    return onServiceEvent((evt) => {
      if (evt.type === "started") upsert({ url: evt.url || "", pid: evt.pid, command: evt.command });
      else if (evt.type === "stopped") removeByPid(evt.pid);
    });
  }, [upsert, removeByPid]);

  // 健康探测：仅对「探测到的外部地址（无 pid，仅展示）」做探测，连续多次不可达即移除。
  // 由 AI 启动的后台服务（有 pid）不参与——它只应在进程真正退出（主进程回传 stopped 事件 → removeByPid）
  // 或用户手动停止时消失。否则端口探测的偶发失败、以及打包版 app:// → http://localhost 的混合内容拦截
  // 会让「运行中的服务」卡片启动后很快被误删（用户反馈：服务未停，弹窗却一闪就没了）。
  useEffect(() => {
    const withUrl = services.filter((s) => s.url && s.pid == null);
    if (withUrl.length === 0) return;
    const id = window.setInterval(() => {
      for (const s of withUrl) {
        void ping(s.url).then((ok) => {
          if (ok) {
            failsRef.current[s.url] = 0;
          } else {
            const n = (failsRef.current[s.url] ?? 0) + 1;
            failsRef.current[s.url] = n;
            if (n >= MAX_FAILS) {
              delete failsRef.current[s.url];
              removeByUrl(s.url);
            }
          }
        });
      }
    }, PING_MS);
    return () => window.clearInterval(id);
  }, [services, removeByUrl]);

  // 非常驻的 info/success 通知：到期自动消失（error 与 progress 不自动消失）。
  useEffect(() => {
    for (const it of items) {
      if (it.sticky || it.kind === "progress" || it.kind === "error") continue;
      if (scheduled.current.has(it.id)) continue;
      scheduled.current.add(it.id);
      window.setTimeout(() => {
        dismiss(it.id);
        scheduled.current.delete(it.id);
      }, AUTO_DISMISS_MS);
    }
  }, [items, dismiss]);

  const onStop = async (svc: RunningService) => {
    if (svc.pid != null) {
      await stopService(svc.pid); // 主进程结束进程后会回传 stopped 事件移除；这里也乐观移除
      removeByPid(svc.pid);
    } else {
      removeByUrl(svc.url);
    }
  };

  if (items.length === 0 && services.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {services.map((s) => (
        <ServiceCard key={s.url || s.pid} svc={s} t={t} onStop={() => void onStop(s)} />
      ))}
      {items.map((n) => (
        <NotificationCard key={n.id} n={n} onClose={() => dismiss(n.id)} />
      ))}
    </div>
  );
}

function ServiceCard({
  svc,
  t,
  onStop,
}: {
  svc: RunningService;
  t: (k: string) => string;
  onStop: () => void;
}) {
  const label = svc.url.replace(/^https?:\/\//, "") || svc.command || t("service.running");
  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <button
          type="button"
          onClick={() => svc.url && requestOpenBrowser(svc.url)}
          title={t("service.open")}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate font-mono text-xs font-medium text-ink">{label}</p>
          <p className="text-[10px] text-ink-subtle">{t("service.running")}</p>
        </button>
        <button
          type="button"
          onClick={onStop}
          title={svc.pid != null ? t("service.stop") : t("service.hide")}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition",
            svc.pid != null
              ? "border-red-500/40 text-red-500 hover:bg-red-500/10"
              : "border-line-strong text-ink-subtle hover:bg-surface-muted",
          )}
        >
          {svc.pid != null ? <Square className="size-3" /> : <X className="size-3" />}
          {svc.pid != null ? t("service.stop") : t("service.hide")}
        </button>
        {svc.url && <Globe className="size-3.5 shrink-0 text-ink-subtle/60" />}
      </div>
    </div>
  );
}

function NotificationCard({ n, onClose }: { n: AppNotification; onClose: () => void }) {
  const pct = typeof n.progress === "number" ? Math.round(Math.min(1, Math.max(0, n.progress)) * 100) : null;
  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <span className="mt-0.5 shrink-0">
          {n.kind === "progress" ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : n.kind === "success" ? (
            <CheckCircle2 className="size-4 text-emerald-500" />
          ) : n.kind === "error" ? (
            <AlertCircle className="size-4 text-red-500" />
          ) : (
            <Info className="size-4 text-ink-muted" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{n.title}</p>
          {n.message && <p className="mt-0.5 break-words text-xs text-ink-subtle">{n.message}</p>}
          {n.kind === "progress" && (
            <div className="mt-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-strong/40">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              {pct != null && <p className="mt-1 text-[10px] tabular-nums text-ink-subtle">{pct}%</p>}
            </div>
          )}
        </div>
        {!n.sticky && n.kind !== "progress" && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-0.5 text-ink-subtle transition hover:bg-surface-muted hover:text-ink"
            aria-label="close"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
