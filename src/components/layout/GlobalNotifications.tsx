"use client";

/**
 * Global notification bar (docked at the bottom-right). Two kinds of content:
 *  1. Running local services (dev servers started by the AI, etc.): shows the project URL,
 *     clickable to open in the built-in browser, and can be "stopped".
 *     Driven by the main process's background-process start/stop events (with a pid -> can be stopped),
 *     with health probing that auto-removes on disconnect.
 *  2. notificationStore notifications: model download/install progress, app operation hints, etc.
 * The container is pointer-events-none; only the cards are interactive, so it doesn't block page clicks.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, ChevronDown, Globe, Info, Loader2, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type AppNotification } from "@/store/notificationStore";
import { useServicesStore, type RunningService } from "@/store/servicesStore";
import { onServiceEvent, listServices, stopService } from "@/lib/ai/services";
import { requestOpenBrowser } from "@/lib/automation";
import { useT } from "@/lib/i18n";

const AUTO_DISMISS_MS = 5000;
const PING_MS = 6000;
const MAX_FAILS = 2;

/** Matches the spring used by the sidebar and mode tabs, so the app has one motion vocabulary. */
const SPRING = { type: "spring", stiffness: 500, damping: 38 } as const;
/** Collapsed/expanded survives reloads: a launcher that springs back open every restart is noise. */
const COLLAPSE_KEY = "zeraix.services.collapsed";

/** no-cors liveness probe: resolves if reachable, rejects on refusal / timeout. */
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

  // Read on mount rather than in the initializer: this renders on the server too, where there is no
  // localStorage, and seeding from it directly would hydrate to a different tree than the server sent.
  const [collapsed, setCollapsedState] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsedState(true);
    } catch {
      // Private mode / storage disabled — the launcher just starts expanded.
    }
  }, []);
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      // Not being able to remember the choice must not stop it taking effect now.
    }
  };

  // Subscribe to background service start/stop events + initial sync.
  useEffect(() => {
    void listServices().then((list) =>
      list.forEach((s) => upsert({ url: s.url, pid: s.pid, command: s.command })),
    );
    return onServiceEvent((evt) => {
      if (evt.type === "started") upsert({ url: evt.url || "", pid: evt.pid, command: evt.command });
      else if (evt.type === "stopped") removeByPid(evt.pid);
    });
  }, [upsert, removeByPid]);

  // Health probing: only probe "detected external URLs (no pid, display-only)"; remove after several consecutive unreachable results.
  // Background services started by the AI (with a pid) are excluded -- they should only disappear when the process actually exits
  // (main process sends back a stopped event -> removeByPid) or when the user stops them manually. Otherwise, occasional port-probe
  // failures, plus the packaged build's app:// -> http://localhost mixed-content blocking, would cause the "running service" card to be
  // wrongly removed shortly after starting (user feedback: the service isn't stopped, yet the popup flashes and vanishes).
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

  // Non-sticky info/success notifications: auto-dismiss on timeout (error and progress do not auto-dismiss).
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
      await stopService(svc.pid); // After the main process kills the process it sends back a stopped event to remove it; also remove optimistically here
      removeByPid(svc.pid);
    } else {
      removeByUrl(svc.url);
    }
  };

  if (items.length === 0 && services.length === 0) return null;

  return (
    // No `items-end` here: the column must keep stretching, or every NotificationCard below shrinks
    // to its content width. Only the collapsed ball opts out, via `self-end`.
    <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {services.length > 0 && (
        <ServiceLauncher
          services={services}
          t={t}
          onStop={(s) => void onStop(s)}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
        />
      )}
      {items.map((n) => (
        <NotificationCard key={n.id} n={n} onClose={() => dismiss(n.id)} />
      ))}
    </div>
  );
}

/**
 * The running-services launcher: a stack of service cards that collapses into a floating ball.
 *
 * Collapsing is a VIEW state and nothing else — every service keeps running, and the per-card
 * stop/hide buttons are untouched. That distinction is the whole point: "hide" on a card drops that
 * service from the list, while this only folds the panel away, so a user who wants their screen back
 * does not have to dismiss services they still want to watch.
 *
 * The panel and the ball share a `layoutId`, so framer-motion treats them as one element and springs
 * the geometry between them rather than cross-fading two unrelated boxes.
 */
function ServiceLauncher({
  services,
  t,
  onStop,
  collapsed,
  setCollapsed,
}: {
  services: RunningService[];
  t: (k: string) => string;
  onStop: (svc: RunningService) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}) {
  return (
    // Default (sync) mode, not popLayout: a shared `layoutId` needs both elements present for one
    // frame to measure the morph, and popLayout yanks the outgoing one out of flow first.
    <AnimatePresence initial={false}>
      {collapsed ? (
        <motion.button
          key="ball"
          type="button"
          layoutId="service-launcher"
          onClick={() => setCollapsed(false)}
          title={t("service.expand")}
          aria-label={t("service.expand")}
          aria-expanded={false}
          transition={SPRING}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          className="pointer-events-auto flex size-12 shrink-0 self-end items-center justify-center rounded-full border border-line bg-surface shadow-lg"
        >
          {/* The live dot doubles as the affordance: something is still running behind the ball.
              Plain spans, not motion children — a `layout` child inside a `layoutId` morph gets
              measured mid-transition and jitters against the parent it is being carried by. */}
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="ml-1 font-mono text-xs font-semibold tabular-nums text-ink">
            {services.length}
          </span>
        </motion.button>
      ) : (
        <motion.div
          key="panel"
          layoutId="service-launcher"
          transition={SPRING}
          className="pointer-events-auto flex w-full flex-col gap-2"
        >
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title={t("service.collapse")}
              aria-label={t("service.collapse")}
              aria-expanded
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink-subtle shadow-sm transition hover:bg-surface-muted"
            >
              <ChevronDown className="size-3" />
              {services.length}
            </button>
          </div>
          {/* Own AnimatePresence so a service that stops springs out instead of vanishing. `exit`
              only runs on a direct child of an AnimatePresence — without this the prop is dead. */}
          <AnimatePresence initial={false}>
            {services.map((s) => (
              <motion.div
                key={s.url || s.pid}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
                transition={SPRING}
              >
                <ServiceCard svc={s} t={t} onStop={() => onStop(s)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
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
