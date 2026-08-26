"use client";

import { MessageSquarePlus, PencilLine, Trash2, FolderOpen } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

/**
 * A row of the sidebar's project / chat tree, plus the age label those rows show.
 * Split out of AgentSidebar to keep that file under the 1000-line ceiling.
 */

/**
 * Intl.DurationFormat is not in this TypeScript release's lib yet, though every runtime that matters here ships it
 * (Chromium 129+, so Electron 42). Declare the sliver used below, and keep an ASCII fallback for anything older.
 */
type DurationParts = Partial<
  Record<"years" | "months" | "days" | "hours" | "minutes" | "seconds", number>
>;
type DurationFormatter = { format: (d: DurationParts) => string };
type DurationFormatCtor = new (
  locale: string,
  options: { style: "narrow" | "short" }
) => DurationFormatter;
const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat;

/** One formatter per locale + style; building an Intl formatter is expensive and every visible row asks for one. */
const durationFormatters = new Map<string, DurationFormatter>();
const durationFormat = (locale: string, style: "narrow" | "short", d: DurationParts) => {
  const key = `${locale}:${style}`;
  let f = durationFormatters.get(key);
  if (!f) {
    f = new DurationFormat!(locale, { style });
    durationFormatters.set(key, f);
  }
  return f.format(d);
};

/** Coarsest unit first; the first one that fits at least once is the one shown. */
const AGE_UNITS = [
  { ms: 365 * 86_400_000, style: "short", unit: "years", ascii: "y" },
  { ms: 30 * 86_400_000, style: "short", unit: "months", ascii: "mo" },
  { ms: 86_400_000, style: "narrow", unit: "days", ascii: "d" },
  { ms: 3_600_000, style: "narrow", unit: "hours", ascii: "h" },
  { ms: 60_000, style: "narrow", unit: "minutes", ascii: "m" },
  { ms: 1_000, style: "narrow", unit: "seconds", ascii: "s" },
] as const;

/**
 * How long ago `ts` was, as a bare magnitude ("13m", "3h", "13分钟") — no "ago", because the label sits in a 260px
 * sidebar next to a chat title and only needs to convey recency.
 *
 * Intl.DurationFormat carries all 11 locales for free, so this needs no translation keys of its own. Months and years
 * use the `short` style: narrow English collapses both months and minutes to "m", which would read as 3 minutes.
 * Anything older than the app (or a clock that has gone backwards) clamps to 0 rather than showing a negative age.
 */
export function formatAge(ts: number, now: number, locale: string): string {
  const diff = Math.max(0, now - ts);
  const u = AGE_UNITS.find((x) => diff >= x.ms) ?? AGE_UNITS[AGE_UNITS.length - 1];
  const n = Math.floor(diff / u.ms);
  if (!DurationFormat) return `${n}${u.ascii}`;
  return durationFormat(locale, u.style, { [u.unit]: n });
}

/** A list item within a section (project / chat entry). Supports a context menu when onNewChat/onRename/onDelete are provided. */
export default function SidebarLeaf({
  label,
  active = false,
  icon,
  meta,
  generating = false,
  pendingConsent = false,
  pendingQuestion = false,
  unread = false,
  expanded,
  onClick,
  onNewChat,
  onOpenFolder,
  onRename,
  onDelete,
}: {
  label: string;
  active?: boolean;
  /** Left gutter glyph (a folder, on project rows). The gutter is reserved either way, so chat labels line up under project labels. */
  icon?: React.ReactNode;
  /** Right-hand label — the chat's age. */
  meta?: string;
  /** Whether this conversation is currently generating AI output (if so, show a spinner). */
  generating?: boolean;
  /** Whether this conversation has a sensitive-tool confirmation waiting (show an "approval needed" badge). */
  pendingConsent?: boolean;
  pendingQuestion?: boolean;
  /** Whether this conversation replied while the user was reading another one (show a "new reply" dot until opened). */
  unread?: boolean;
  /** Whether this row's chats are showing (projects only; drives the folder glyph and aria-expanded). */
  expanded?: boolean;
  onClick?: () => void;
  /** Right-click "New chat" (take the project path and start a new conversation). */
  onNewChat?: () => void;
  /** Right-click "Open folder" (open the project directory in the system file manager); not provided when there's no directory. */
  onOpenFolder?: () => void;
  /** Right-click "Rename". */
  onRename?: () => void;
  /** Right-click "Delete". */
  onDelete?: () => void;
}) {
  const t = useT();
  /* Waiting-on-you badge: a pulsing amber dot when this conversation needs the user before it can go on —
     either a sensitive tool awaiting confirmation, or an unanswered ask_user question. Both take
     precedence over the generating spinner (the AI is blocked on the user, not actively producing).
     A question badge matters most for a conversation that is NOT on screen: its card is shown only in
     its own conversation, so without this the only signal would be an OS notification the user may
     never see while the app is focused. */
  const status =
    pendingConsent || pendingQuestion ? (
      <span
        title={pendingConsent ? t("sidebar.approvalNeeded") : t("sidebar.answerNeeded")}
        className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500"
      />
    ) : generating ? (
      <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
    ) : unread ? (
      // Not pulsing, unlike the amber badges: this one reports something finished, it does not ask for anything.
      <span
        title={t("sidebar.newReply")}
        className="size-2 shrink-0 rounded-full bg-primary"
      />
    ) : null;

  const leaf = (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-expanded={expanded}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-accent font-medium text-foreground dark:bg-white/[0.06]"
          : "text-foreground/80 hover:bg-accent dark:hover:bg-white/[0.04]",
        // An unseen reply also weights the label: the dot alone is easy to miss in a long list.
        !active && unread && "font-medium text-foreground"
      )}
    >
      {/* Gutter: the row's own glyph if it has one, otherwise its status. A project keeps its folder and moves the
          status over to the right, so a folded project still signals that something inside it is running. */}
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon ?? status}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {icon && status}
      {meta && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{meta}</span>
      )}
    </button>
  );

  if (!onNewChat && !onOpenFolder && !onRename && !onDelete) return leaf;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{leaf}</ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        {onNewChat && <ContextMenuItem onSelect={onNewChat}><MessageSquarePlus />{t("ctx.newChat")}</ContextMenuItem>}
        {onOpenFolder && <ContextMenuItem onSelect={onOpenFolder}><FolderOpen />{t("ctx.openFolder")}</ContextMenuItem>}
        {onRename && <ContextMenuItem onSelect={onRename}><PencilLine />{t("ctx.rename")}</ContextMenuItem>}
        {onDelete && (
          <ContextMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />{t("ctx.delete")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
