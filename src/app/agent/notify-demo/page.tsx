"use client";

/**
 * System notification test page (/agent/notify-demo) — for development / integration testing only.
 *
 * Covers the capabilities from the electron / system-notification design doc:
 *   - Quick-send for the four types (info/success/warning/error)
 *   - Custom payload (title/body/type/priority/silent/deep-link route/groupKey/action buttons)
 *   - Rate-limit stress test (send 6 in a row, observe the ~333ms cadence and maxBurst dropping)
 *   - Merge stress test (send several with the same groupKey, collapsed into "N updates")
 *   - Deep Link (route points to a page in this app; clicking the notification navigates there)
 *   - Notification center history (list / mark read / delete / clear, refreshed live via onChange)
 *   - Live capture of click-navigation and action-button events
 *
 * Outside Electron (pure Web) an unavailable notice is shown at the top and all calls safely degrade to no-ops.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  BellRing,
  CheckCheck,
  Info,
  Link2,
  Send,
  Trash2,
  Zap,
  Layers,
  X,
} from "lucide-react";
import {
  sendNotification,
  isNotificationAvailable,
  isNotificationSupported,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  removeNotification,
  clearNotifications,
  onNotificationNavigate,
  onNotificationAction,
  onNotificationChange,
  type NotificationInput,
  type NotificationRecord,
} from "@/lib/electron/notification";

type NType = NonNullable<NotificationInput["type"]>;
type NPriority = NonNullable<NotificationInput["priority"]>;

const TYPE_META: Record<NType, { label: string; className: string }> = {
  info: { label: "Info", className: "bg-sky-500/15 text-sky-500 border-sky-500/30" },
  success: { label: "Success", className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
  warning: { label: "Warning", className: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  error: { label: "Error", className: "bg-red-500/15 text-red-500 border-red-500/30" },
};

/** Short-lived log entry (navigation / action / send result), for in-page visual feedback. */
interface LogLine {
  id: number;
  at: string;
  text: string;
}

export default function NotifyDemoPage() {
  const router = useRouter();

  const available = isNotificationAvailable();
  const [supported, setSupported] = useState<boolean | null>(null);

  // Custom form
  const [title, setTitle] = useState("Task complete");
  const [body, setBody] = useState("File processing finished, click to view details");
  const [type, setType] = useState<NType>("success");
  const [priority, setPriority] = useState<NPriority>("normal");
  const [route, setRoute] = useState("/agent/settings");
  const [groupKey, setGroupKey] = useState("");
  const [silent, setSilent] = useState(false);
  const [withActions, setWithActions] = useState(false);
  const [whenBackground, setWhenBackground] = useState(false);

  const [history, setHistory] = useState<NotificationRecord[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logSeq = useRef(0);

  const pushLog = useCallback((text: string) => {
    const at = new Date().toLocaleTimeString();
    setLogs((prev) => [{ id: ++logSeq.current, at, text }, ...prev].slice(0, 30));
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistory(await listNotifications());
  }, []);

  // Initialization: capability probe + initial history fetch + subscriptions (history change / click navigation / action).
  useEffect(() => {
    void isNotificationSupported().then(setSupported);
    void refreshHistory();
    const offChange = onNotificationChange(() => void refreshHistory());
    const offNav = onNotificationNavigate((r) => pushLog(`Click navigate → ${r}`));
    const offAction = onNotificationAction((info) =>
      pushLog(`Action button #${info.index}${info.actionId ? ` (${info.actionId})` : ""} @ ${info.id.slice(0, 8)}`),
    );
    return () => {
      offChange();
      offNav();
      offAction();
    };
  }, [refreshHistory, pushLog]);

  const doSend = useCallback(
    async (payload: NotificationInput, note?: string) => {
      const res = await sendNotification(payload);
      pushLog(
        !res.ok
          ? `Send failed: ${res.error ?? "invalid payload"}`
          : res.skipped
            ? `Skipped "${payload.title}" (window is in the foreground; only pops when in the background)`
            : `Sent "${payload.title}"${res.merged ? " (merged)" : ""}${note ? ` — ${note}` : ""}`,
      );
      void refreshHistory();
      return res;
    },
    [pushLog, refreshHistory],
  );

  // Quick: send one of each of the four types
  const sendQuick = (t: NType) =>
    void doSend({
      title: `${TYPE_META[t].label} notification`,
      body: `This is a "${TYPE_META[t].label}" type system notification.`,
      type: t,
    });

  // Custom send
  const sendCustom = () =>
    void doSend({
      title,
      body,
      type,
      priority,
      silent,
      whenBackground,
      route: route.trim() || undefined,
      groupKey: groupKey.trim() || undefined,
      actions: withActions
        ? [
            { text: "View", actionId: "view" },
            { text: "Ignore", actionId: "dismiss" },
          ]
        : undefined,
    });

  // Rate-limit stress test: send 6 in a row (maxPerSecond=3 → about a 333ms cadence; beyond maxBurst the oldest non-high is dropped)
  const stressRate = () => {
    for (let i = 1; i <= 6; i++) {
      void doSend({ title: `Stress #${i}`, body: `Rate-limit cadence test (${i}/6)`, type: "info" }, i === 1 ? "Sent 6 in a row" : undefined);
    }
  };

  // Merge stress test: send 4 in a row with the same groupKey → collapsed into "N updates"
  const stressMerge = () => {
    for (let i = 1; i <= 4; i++) {
      void doSend(
        { title: "AI reply", body: `Message ${i}`, type: "info", groupKey: "ai-stream" },
        i === 1 ? "Sent 4 in a row with the same groupKey" : undefined,
      );
    }
  };

  // Deep Link: the route points to the settings page; clicking the notification should navigate there
  const sendDeepLink = () =>
    void doSend(
      { title: "Open settings page", body: "Clicking this notification navigates to /agent/settings", type: "info", route: "/agent/settings" },
      "Should navigate on click",
    );

  return (
    <div className="h-full overflow-auto bg-surface text-ink">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-line text-ink-muted transition hover:bg-surface-muted"
            aria-label="Back"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="flex-1">
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <BellRing className="size-5 text-primary" />
              System notification test bench
            </h1>
            <p className="text-xs text-ink-subtle">window.notification → main-process queue / merge / rate-limit → OS notification</p>
          </div>
          <AvailabilityBadge available={available} supported={supported} />
        </div>

        {!available && (
          <div className="mb-6 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              Not currently in an Electron environment (pure Web); system notifications are unavailable and the actions below are all no-ops. Please open this page in the desktop app (
              <code className="rounded bg-surface-muted px-1">npm run electron:dev</code>) to test.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left column: send controls */}
          <div className="space-y-6">
            {/* Quick types */}
            <Section title="Quick send" icon={<Bell className="size-4" />}>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(TYPE_META) as NType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => sendQuick(t)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition hover:opacity-80 ${TYPE_META[t].className}`}
                  >
                    {TYPE_META[t].label}
                  </button>
                ))}
              </div>
            </Section>

            {/* Scenario stress tests */}
            <Section title="Scenario tests" icon={<Zap className="size-4" />}>
              <div className="flex flex-col gap-2">
                <ActionRow icon={<Zap className="size-4" />} label="Rate-limit stress test (send 6)" hint="≈333ms cadence" onClick={stressRate} />
                <ActionRow icon={<Layers className="size-4" />} label="Merge stress test (4 in one group)" hint="Collapsed into N updates" onClick={stressMerge} />
                <ActionRow icon={<Link2 className="size-4" />} label="Deep Link navigation" hint="→ /agent/settings" onClick={sendDeepLink} />
              </div>
            </Section>

            {/* Custom */}
            <Section title="Custom payload" icon={<Send className="size-4" />}>
              <div className="space-y-3">
                <Field label="Title">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Body">
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} className={inputCls} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type">
                    <select value={type} onChange={(e) => setType(e.target.value as NType)} className={inputCls}>
                      {(Object.keys(TYPE_META) as NType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_META[t].label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Priority">
                    <select value={priority} onChange={(e) => setPriority(e.target.value as NPriority)} className={inputCls}>
                      <option value="low">low</option>
                      <option value="normal">normal</option>
                      <option value="high">high (does not auto-dismiss)</option>
                    </select>
                  </Field>
                </div>
                <Field label="route (deep link, starts with /)">
                  <input value={route} onChange={(e) => setRoute(e.target.value)} placeholder="/agent/settings" className={inputCls} />
                </Field>
                <Field label="groupKey (merge key, leave blank to not merge)">
                  <input value={groupKey} onChange={(e) => setGroupKey(e.target.value)} placeholder="ai-stream" className={inputCls} />
                </Field>
                <div className="flex flex-wrap items-center gap-4">
                  <Toggle checked={silent} onChange={setSilent} label="Silent" />
                  <Toggle checked={withActions} onChange={setWithActions} label="With action buttons (macOS)" />
                  <Toggle checked={whenBackground} onChange={setWhenBackground} label="Only pop when in background / minimized" />
                </div>
                <button
                  type="button"
                  onClick={sendCustom}
                  disabled={!title.trim()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
                >
                  <Send className="size-4" />
                  Send notification
                </button>
              </div>
            </Section>
          </div>

          {/* Right column: history + event log */}
          <div className="space-y-6">
            {/* History */}
            <Section
              title={`Notification history (${history.length})`}
              icon={<Bell className="size-4" />}
              action={
                <div className="flex items-center gap-1.5">
                  <IconBtn title="Mark all read" onClick={() => void markAllNotificationsRead().then(refreshHistory)}>
                    <CheckCheck className="size-3.5" />
                  </IconBtn>
                  <IconBtn title="Clear" onClick={() => void clearNotifications().then(refreshHistory)}>
                    <Trash2 className="size-3.5" />
                  </IconBtn>
                </div>
              }
            >
              {history.length === 0 ? (
                <p className="py-8 text-center text-sm text-ink-subtle">No notification history yet</p>
              ) : (
                <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
                  {history.map((r) => (
                    <HistoryRow
                      key={r.id}
                      record={r}
                      onRead={() => void markNotificationRead(r.id).then(refreshHistory)}
                      onRemove={() => void removeNotification(r.id).then(refreshHistory)}
                    />
                  ))}
                </div>
              )}
            </Section>

            {/* Event log */}
            <Section title="Event log" icon={<Info className="size-4" />}>
              {logs.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-subtle">Events appear here after you send a notification or click a system notification</p>
              ) : (
                <div className="max-h-[220px] space-y-1 overflow-auto font-mono text-xs">
                  {logs.map((l) => (
                    <div key={l.id} className="flex gap-2 text-ink-muted">
                      <span className="shrink-0 text-ink-subtle">{l.at}</span>
                      <span className="break-all">{l.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small components ─────────────────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition focus:border-primary";

function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2 text-sm text-ink-muted">
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${checked ? "bg-primary" : "bg-line-strong"}`}
      >
        <span className={`inline-block size-4 rounded-full bg-white transition ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

function ActionRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left text-sm transition hover:bg-surface-muted"
    >
      <span className="text-primary">{icon}</span>
      <span className="flex-1 font-medium text-ink">{label}</span>
      {hint && <span className="text-xs text-ink-subtle">{hint}</span>}
    </button>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md border border-line text-ink-muted transition hover:bg-surface-muted hover:text-ink"
    >
      {children}
    </button>
  );
}

function AvailabilityBadge({ available, supported }: { available: boolean; supported: boolean | null }) {
  const ok = available && supported !== false;
  const text = !available ? "Web (unavailable)" : supported === false ? "Not supported by system" : supported === null ? "Checking…" : "Available";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" : "border-line bg-surface-muted text-ink-subtle"
      }`}
    >
      <span className={`size-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-ink-subtle"}`} />
      {text}
    </span>
  );
}

function HistoryRow({
  record,
  onRead,
  onRemove,
}: {
  record: NotificationRecord;
  onRead: () => void;
  onRemove: () => void;
}) {
  const { item, read, createdAt } = record;
  const meta = TYPE_META[(item.type as NType) ?? "info"] ?? TYPE_META.info;
  return (
    <div className={`group relative rounded-lg border border-line px-3 py-2.5 transition ${read ? "opacity-60" : "bg-surface-muted/40"}`}>
      <div className="flex items-start gap-2">
        {!read && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}>{meta.label}</span>
            <p className="truncate text-sm font-medium text-ink">{item.title}</p>
          </div>
          {item.body && <p className="mt-0.5 break-words text-xs text-ink-subtle">{item.body}</p>}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-subtle">
            <span>{new Date(createdAt).toLocaleTimeString()}</span>
            {item.route && (
              <span className="inline-flex items-center gap-0.5">
                <Link2 className="size-2.5" />
                {item.route}
              </span>
            )}
            {item.groupKey && <span>· {item.groupKey}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
          {!read && (
            <IconBtn title="Mark read" onClick={onRead}>
              <CheckCheck className="size-3" />
            </IconBtn>
          )}
          <IconBtn title="Delete" onClick={onRemove}>
            <X className="size-3" />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}
