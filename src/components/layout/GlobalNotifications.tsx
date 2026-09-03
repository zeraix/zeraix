"use client";

/**
 * Global notification bar (docked at the bottom-right). Two kinds of content:
 *  1. Running local services (dev servers started by the AI, etc.): shows the project URL,
 *     clickable to open in the built-in browser, and can be "stopped".
 *     Driven ONLY by the main process's background-process start/stop events (each with a pid, so each
 *     can be stopped); a card leaves when its process exits or the user stops it. Nothing is inferred
 *     from tool output — see servicesStore.ts for what that used to put here.
 *  2. notificationStore notifications: model download/install progress, app operation hints, etc.
 * The container is pointer-events-none; only the cards are interactive, so it doesn't block page clicks.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, ChevronDown, Globe, Info, Loader2, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type AppNotification } from "@/store/notificationStore";
import { useServicesStore, type RunningService } from "@/store/servicesStore";
import { onServiceEvent, listServices, stopService } from "@/lib/ai/services";
import { requestOpenBrowser } from "@/lib/automation";
import { useWorkflowRunNotifications } from "@/hooks/useWorkflowRunNotifications";
import { useT } from "@/lib/i18n";

const AUTO_DISMISS_MS = 5000;

/** Matches the spring used by the sidebar and mode tabs, so the app has one motion vocabulary. */
const SPRING = { type: "spring", stiffness: 500, damping: 38 } as const;
/**
 * The fold: critically damped (damping² ≈ 4·stiffness·mass), so the stack and the capsule settle in about
 * 300ms without overshooting. An overshoot is fine on a tab indicator; on a panel that is folding away
 * it reads as a bounce, and the bounce was half of what made the old transition feel wrong.
 */
const FOLD = { type: "spring", stiffness: 360, damping: 34, mass: 0.8 } as const;
/** Collapsed/expanded survives reloads: a launcher that springs back open every restart is noise. */
const COLLAPSE_KEY = "zeraix.services.collapsed";

/**
 * The collapsed flag as an external store, so the first client render can read localStorage without
 * disagreeing with the server render: React takes the server snapshot (expanded) while hydrating and
 * re-renders with the real one after. The in-memory value is authoritative for the session, so a browser
 * that refuses the write still folds the panel — remembering it is the part that may fail.
 */
const collapseListeners = new Set<() => void>();
let collapsedNow: boolean | null = null;
const readCollapsed = (): boolean => {
  if (collapsedNow !== null) return collapsedNow;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false; // Private mode / storage disabled — the launcher just starts expanded.
  }
};
const subscribeCollapsed = (cb: () => void) => {
  collapseListeners.add(cb);
  return () => void collapseListeners.delete(cb);
};
function useCollapsed(): [boolean, (v: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const setCollapsed = (v: boolean) => {
    collapsedNow = v;
    try {
      window.localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      // Not being able to remember the choice must not stop it taking effect now.
    }
    collapseListeners.forEach((l) => l());
  };
  return [collapsed, setCollapsed];
}

export default function GlobalNotifications() {
  const t = useT();
  const items = useNotificationStore((s) => s.items);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const scheduled = useRef<Set<string>>(new Set());

  // Announces automation runs that start while the user is elsewhere in the app; pushes into the same
  // notificationStore rendered below, so it needs nothing from this component but a mount point.
  useWorkflowRunNotifications();

  const services = useServicesStore((s) => s.services);
  const upsert = useServicesStore((s) => s.upsert);
  const removeByPid = useServicesStore((s) => s.removeByPid);

  const [collapsed, setCollapsed] = useCollapsed();

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
    await stopService(svc.pid); // After the main process kills the process it sends back a stopped event to remove it; also remove optimistically here
    removeByPid(svc.pid);
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
 * The running-services launcher: a stack of service cards that folds into a floating capsule.
 *
 * Collapsing is a VIEW state and nothing else — every service keeps running, and the per-card stop
 * buttons are untouched. That distinction is the whole point: stopping a card ends that service, while
 * this only folds the panel away, so a user who wants their screen back does not have to stop services
 * they still want to watch.
 *
 * One toggle lives in both states and never changes shape; it only slides. It used to be two elements
 * sharing a `layoutId` — a 48px ball and the whole column of cards — and morphing one into the other
 * stretched the cards' text mid-flight while the two crossfaded: the jump people saw. Now the stack
 * folds toward the corner on its own, the toggle glides down to meet it, and nothing with text in it is
 * ever scaled by a layout transform.
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
    // `relative`: the folding stack is popped out of flow while it leaves (popLayout) and positioned
    // against this box. That is what lets the toggle glide down over the fold instead of jumping the
    // moment the stack unmounts.
    <div className="pointer-events-auto relative flex w-full flex-col items-end gap-2">
      <motion.button
        type="button"
        layout="position"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? t("service.expand") : t("service.collapse")}
        aria-label={collapsed ? t("service.expand") : t("service.collapse")}
        aria-expanded={!collapsed}
        transition={FOLD}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 font-mono text-xs font-semibold tabular-nums text-ink transition-shadow duration-300",
          // Deeper shadow once it floats alone: the same capsule, reading as a button on the page rather than a header on a panel.
          collapsed ? "shadow-lg" : "shadow-sm",
        )}
      >
        {/* The live dot doubles as the affordance: something is still running behind the capsule. */}
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
        </span>
        <span>{services.length}</span>
        {/* Points down at the stack it will fold, up at the stack it will unfold. */}
        <motion.span
          aria-hidden
          animate={{ rotate: collapsed ? 180 : 0 }}
          transition={FOLD}
          className="flex text-ink-subtle"
        >
          <ChevronDown className="size-3" />
        </motion.span>
      </motion.button>

      <AnimatePresence initial={false} mode="popLayout">
        {!collapsed && (
          <motion.div
            key="stack"
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={FOLD}
            // Toward the corner the capsule settles in, so the fold reads as the stack tucking under it.
            style={{ transformOrigin: "100% 100%" }}
            className="flex w-full flex-col gap-2"
          >
            {/* Own AnimatePresence so a service that stops springs out instead of vanishing. `exit`
                only runs on a direct child of an AnimatePresence — without this the prop is dead. */}
            <AnimatePresence initial={false}>
              {services.map((s) => (
                <motion.div
                  key={s.pid}
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
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
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
          title={t("service.stop")}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/40 px-2 py-1 text-[11px] font-medium text-danger-ink transition hover:bg-danger/10"
        >
          <Square className="size-3" />
          {t("service.stop")}
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
            <CheckCircle2 className="size-4 text-success-ink" />
          ) : n.kind === "error" ? (
            <AlertCircle className="size-4 text-danger-ink" />
          ) : (
            <Info className="size-4 text-ink-muted" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{n.title}</p>
          {n.message && <p className="mt-0.5 break-words text-xs text-ink-subtle">{n.message}</p>}
          {/* Only when there is a real fraction to show. `progress` also means "indeterminate, and do
              not auto-dismiss" — a workflow run has no percentage — and a bar frozen at 0% for the
              whole job reads as stalled rather than as working. Those get the spinner alone. */}
          {n.kind === "progress" && pct != null && (
            <div className="mt-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-strong/40">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] tabular-nums text-ink-subtle">{pct}%</p>
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
