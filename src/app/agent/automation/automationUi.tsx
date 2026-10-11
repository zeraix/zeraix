/**
 * Presentation shared by the automation page: style tokens, the page shell, and the small
 * building blocks (chips, labels, callouts, event rows) it composes. page.tsx keeps the data flow;
 * nothing here holds state.
 */
import { Workflow, AlertCircle, FolderOpen } from "lucide-react";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import type { RunEvent, RunState } from "@/lib/workflows";

/** Colour per run state; failures read red, waiting states amber, in-flight the brand accent. */
const STATE_STYLE: Record<RunState, string> = {
  QUEUED: "bg-muted text-muted-foreground",
  RUNNING: "bg-primary/10 text-primary",
  AWAITING_APPROVAL: "bg-warning/10 text-warning-ink",
  AWAITING_EVENT: "bg-info/10 text-info-ink",
  AWAITING_RETRY: "bg-warning/10 text-warning-ink",
  INTERRUPTED: "bg-warning/10 text-warning-ink",
  SUCCEEDED: "bg-success/10 text-success-ink",
  FAILED: "bg-danger/10 text-danger-ink",
  CANCELLED: "bg-muted text-muted-foreground",
  TIMED_OUT: "bg-danger/10 text-danger-ink",
};

/**
 * Button and card treatments, defined once.
 *
 * These are not an abstraction for its own sake: the same secondary button is written six times
 * between the toolbar, the folder button and the approval cards, and the copies had drifted apart by
 * a padding step (py-1 / py-1.5 / py-2) and a hover colour. Naming them is what keeps a later edit
 * from re-forking them.
 *
 * `focus-visible` rather than `focus`: these are all mouse targets in practice, and a ring that
 * appears on click reads as a rendering glitch. Keyboard users still get it.
 */
export const BTN_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background";
export const BTN_BASE = `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition active:scale-[0.98] ${BTN_FOCUS}`;
export const BTN_SECONDARY = `${BTN_BASE} border border-line-strong bg-surface text-foreground hover:border-line-strong hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40`;
export const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-sm hover:opacity-90 disabled:pointer-events-none disabled:opacity-40`;
export const BTN_DANGER = `${BTN_BASE} border border-line-strong bg-surface text-danger-ink hover:border-danger/40 hover:bg-danger/5 dark:text-danger-ink`;

/**
 * Selectable rows (workflow list, run list).
 *
 * The rows live inside one bordered card and are separated by dividers, rather than each being its
 * own bordered box in a gapped stack. Two lists of individually-outlined boxes is a lot of border for
 * a page that is mostly lists -- one frame per list reads as a single object and leaves the borders
 * that remain meaning something.
 *
 * Selection is a fill plus a left accent bar instead of a border colour, because inside a divided
 * list there is no per-row border left to recolour.
 */
/**
 * Every list here is UI, not prose, and has to say so.
 *
 * globals.css sets `ul { list-disc pl-5 }` in @layer base for rendered markdown, which overrides
 * Tailwind's preflight reset and applies to *every* ul in the app. Without this, each row gets a
 * bullet sitting outside its card and the whole list is indented five units.
 */
export const LIST_RESET = "list-none pl-0";

export const ROW_BASE = `relative w-full text-left transition ${BTN_FOCUS} focus-visible:z-10`;
// `before:content-['']` is stated rather than relied upon: the variant injects a default in current
// Tailwind, but the accent bar silently disappears if that ever stops being true, and a selection
// indicator is not something to leave resting on a framework default.
export const ROW_SELECTED =
  "bg-primary/[0.06] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary before:content-['']";
export const ROW_IDLE = "hover:bg-surface-hover/60";

export function Shell({
  t,
  folder,
  onOpenFolder,
  notice,
  children,
}: {
  t: (k: string) => string;
  /** Shown as the button's tooltip. Absent outside Electron, where there is no folder to open. */
  folder?: string | null;
  onOpenFolder?: () => void;
  notice?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <CustomScrollbar className="h-full" config={PAGE_SCROLLBAR}>
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
          <Workflow className="size-5" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("auto.title")}</h1>
        <span className="flex-1" />
        {/* Page-level, not per-workflow: this opens the root every run's folder sits under, so hiding
            it until a workflow happens to be selected would put it behind an unrelated choice. */}
        {onOpenFolder && (
          <button
            onClick={onOpenFolder}
            title={folder ?? undefined}
            className={`${BTN_SECONDARY} px-3 py-1.5 text-sm`}
          >
            <FolderOpen className="size-3.5" />
            {t("auto.openFolder")}
          </button>
        )}
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("auto.desc")}</p>
      {notice}
      {children}
    </div>
    </CustomScrollbar>
  );
}

export function StateChip({ state, t }: { state: RunState; t: (k: string) => string }) {
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${STATE_STYLE[state]}`}
    >
      {t(`auto.state.${state}`)}
    </span>
  );
}

/**
 * The one heading treatment on this page below the h1.
 *
 * Small, uppercase and muted rather than another near-body-weight `text-sm font-semibold`: the page
 * is a stack of lists, and the labels have to be distinguishable from the list contents at a glance
 * without competing with the title for the top of the hierarchy.
 */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </h2>
  );
}

/** Count beside a section label. Tabular so a list that grows past 9 does not shift the label. */
export function Count({ n }: { n: number }) {
  return (
    <span className="rounded bg-surface-muted px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

/** An error line. Same shape everywhere it appears -- folder failures, run failures, run errors. */
export function Notice({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={`flex items-start gap-1.5 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger-ink ${className}`}
    >
      <AlertCircle className="mt-px size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** A list with nothing in it yet. Dashed, so it reads as a placeholder rather than a real container. */
export function EmptyState({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
      {icon && <span className="text-muted-foreground/50">{icon}</span>}
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

/**
 * The two "the engine is waiting on you" blocks. One frame around the whole group rather than a
 * bordered box per item: with several pending at once, per-item frames stack into a wall of tinted
 * rectangles and stop reading as one list.
 */
export function Callout({
  tone,
  icon,
  title,
  count,
  desc,
  children,
}: {
  tone: "amber" | "sky";
  icon: React.ReactNode;
  title: string;
  count: number;
  desc: string;
  children: React.ReactNode;
}) {
  // Written out rather than composed, because Tailwind resolves class names statically -- a
  // `border-${tone}-500/25` would survive review and then ship with no border at all.
  const TONE = {
    amber: {
      frame: "border-warning/25 bg-warning/[0.04]",
      head: "text-warning-ink",
      divide: "divide-warning/15",
      rule: "border-warning/25",
    },
    sky: {
      frame: "border-info/25 bg-info/[0.04]",
      head: "text-info-ink",
      divide: "divide-info/15",
      rule: "border-info/25",
    },
  }[tone];

  return (
    <section className={`mt-6 overflow-hidden rounded-xl border ${TONE.frame}`}>
      <div className="px-4 pb-2 pt-3">
        <h2 className={`flex items-center gap-1.5 text-sm font-semibold ${TONE.head}`}>
          {icon}
          {title}
          <Count n={count} />
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
      </div>
      <div className={`divide-y border-t ${TONE.divide} ${TONE.rule}`}>{children}</div>
    </section>
  );
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString();
}

/** Whether a row has anything worth expanding. A row that opens to nothing is worse than a dead one. */
export function hasDetail(e: RunEvent): boolean {
  const payload = e.payload;
  if (!payload || typeof payload !== "object") return false;
  // `type` is already the row's own label, so a payload carrying only that adds nothing.
  return Object.keys(payload).some((k) => k !== "type");
}

/**
 * One-line gist of an event; the full payload is one click away in EventDetail.
 *
 * Tool events get the first string argument verbatim — for a search that is the query, which is the
 * one thing a timeline is read to find out. Truncation happens in CSS, not here, so a long query
 * still expands to its full text rather than being clipped before it is ever stored.
 */
export function summarizeEvent(e: RunEvent): string {
  const payload = e.payload;
  if (!payload || typeof payload !== "object") return "";

  if (e.type === "tool:started") {
    const args = (payload.args ?? {}) as Record<string, unknown>;
    const first = Object.entries(args).find(([, v]) => typeof v === "string" && v);
    return [payload.name, first?.[1]].filter(Boolean).join("  ");
  }
  if (e.type === "tool:finished") {
    const secs = typeof payload.ms === "number" ? `${(payload.ms / 1000).toFixed(1)}s` : "";
    if (!payload.ok) return `${payload.name} — ${payload.error ?? "failed"}`;
    const size = typeof payload.chars === "number" ? `${payload.chars} chars` : "";
    return [payload.name, [size, secs].filter(Boolean).join(", ")].filter(Boolean).join(" → ");
  }

  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (payload.values && typeof payload.values === "object") {
    const values = payload.values as Record<string, unknown>;
    const first = Object.entries(values).find(([, v]) => typeof v === "string" && v);
    return first ? `${first[0]}: ${String(first[1]).slice(0, 120)}` : "";
  }
  const keys = Object.keys(payload);
  return keys.length ? keys.map((k) => `${k}=${String(payload[k]).slice(0, 40)}`).join(" ") : "";
}

/**
 * The expanded row: every field of the event, as stored.
 *
 * Field names are printed raw rather than translated. They are the engine's own vocabulary (`args`,
 * `preview`, `chars`) and they are what the design doc and the SQLite rows call them — a localized
 * label would make this view harder to match against the log it is a projection of, not easier.
 */
export function EventDetail({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(([k]) => k !== "type");
  return (
    <dl className="space-y-2 border-t border-line/60 bg-surface-muted/40 px-3 py-2.5">
      {entries.map(([k, v]) => {
        const isObject = typeof v === "object" && v !== null;
        const text = isObject ? JSON.stringify(v, null, 2) : String(v);
        // Multi-line and long values get a block of their own; a search result rendered inline
        // squeezes into a 20%-wide column and is unreadable.
        const block = isObject || text.includes("\n") || text.length > 80;
        return (
          <div key={k} className={block ? "space-y-1" : "flex gap-3"}>
            {/* break-words, not just a wider column: these are the engine's own field names and a
                long one (`definitionVersion`) is wider than any fixed column worth giving it. Without
                wrapping, `shrink-0` lets the label run straight over its own value. */}
            <dt className="w-24 shrink-0 break-words font-mono text-[10px] uppercase leading-relaxed tracking-wide text-muted-foreground">
              {k}
            </dt>
            <dd className="min-w-0 flex-1">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                {text}
              </pre>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
