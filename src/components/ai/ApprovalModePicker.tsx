"use client";

/**
 * The tool-approval control, as one component used by both composers.
 *
 * It lives here rather than in either composer because the setting is global: the home page sends the
 * first message of a conversation and the chat page sends the rest, so the control has to exist in
 * both places and mean the same thing in both. Two copies of a menu that grants an agent the right to
 * delete files without asking is not a thing to maintain twice.
 *
 * Presentational: the value and the setter come from the host, which is what already happens with the
 * model and thinking pickers beside it. `triggerClassName` lets each toolbar size its own pill — the
 * chat composer's row is text-xs, the home page's is text-sm — so the control matches its neighbours
 * rather than importing another toolbar's proportions.
 */

import { useState } from "react";
import { ChevronDown, ClipboardList, ShieldCheck, ShieldQuestion, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  APPROVAL_MODES,
  approvalDescKey,
  approvalLabelKey,
  type ApprovalMode,
} from "@/lib/ai/approvalMode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * How each mode paints: its icon, and the tone of the pill while it is in force.
 *
 * `default` is deliberately the quiet one — it is what the app has always done, and a pill shouting
 * about the ordinary case trains people to ignore it. The others are coloured by what they cost you:
 * amber for the mode that stops asking, blue for the two that ask more.
 */
const APPROVAL_STYLE: Record<ApprovalMode, { icon: typeof ShieldCheck; pill: string }> = {
  default: { icon: ShieldCheck, pill: "text-ink-muted" },
  trust: { icon: Zap, pill: "border-warning/40 bg-warning/10 text-warning-ink" },
  manual: { icon: ShieldQuestion, pill: "border-primary/40 bg-primary/10 text-primary" },
  plan: { icon: ClipboardList, pill: "border-primary/40 bg-primary/10 text-primary" },
};

export function ApprovalModePicker({
  mode,
  onChange,
  triggerClassName,
}: {
  mode: ApprovalMode;
  onChange: (next: ApprovalMode) => void;
  /** The host toolbar's pill idiom (border tone, text size). */
  triggerClassName?: string;
}) {
  const t = useT();
  /**
   * Full trust is confirmed once before it takes effect.
   *
   * It is the one choice here that removes a safety net rather than adding friction — after it the
   * agent deletes files and runs commands with nobody in the loop — and it sits two pixels from the
   * mode that only asks more often. A mis-click should not be how someone finds that out.
   */
  const [confirmTrust, setConfirmTrust] = useState(false);
  const Icon = APPROVAL_STYLE[mode].icon;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={t("composer.approvalTitle")}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border transition hover:bg-surface-muted",
              triggerClassName,
              APPROVAL_STYLE[mode].pill,
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{t(approvalLabelKey(mode))}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-[11px] text-ink-subtle">
            {t("composer.approvalTitle")}
          </DropdownMenuLabel>
          {APPROVAL_MODES.map((m) => {
            const ItemIcon = APPROVAL_STYLE[m].icon;
            return (
              <DropdownMenuItem
                key={m}
                className="items-start gap-2"
                // Full trust asks first; every other mode applies on the click.
                onClick={() => (m === "trust" ? setConfirmTrust(true) : onChange(m))}
              >
                <ItemIcon className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm text-ink">
                    {t(approvalLabelKey(m))}
                    {m === mode && <span className="ml-auto text-primary">✓</span>}
                  </span>
                  <span className="mt-0.5 block whitespace-normal text-[11px] leading-snug text-ink-subtle">
                    {t(approvalDescKey(m))}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Deliberately a dialog and not a toast-after-the-fact: the point is to be read before the
          agent is allowed to delete something without asking. */}
      <Dialog open={confirmTrust} onOpenChange={setConfirmTrust}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Zap className="size-4 text-warning-ink" />
              {t("composer.approval.trustConfirmTitle")}
            </DialogTitle>
            <DialogDescription>{t("composer.approval.trustConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmTrust(false)}
              className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
            >
              {t("composer.approval.trustCancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmTrust(false);
                onChange("trust");
              }}
              className="rounded-lg bg-gradient-to-br from-warning to-warning/85 px-3 py-1.5 text-xs font-semibold text-warning-on shadow-sm transition hover:brightness-105"
            >
              {t("composer.approval.trustConfirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
