"use client";

/**
 * In-conversation "skill selection" panel (dialog). It only handles selection — choosing which installed skills go into the current conversation's config —
 * not downloading / uninstalling (those happen on the /agent/skills page). Selections are written to the shared store,
 * and the latest list is passed up to the chat page via onChange (it takes effect on the next message).
 */
import { memo } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { setSkillEnabled } from "@/lib/ai/skills/store";

interface Props {
  open: boolean;
  onClose: () => void;
  installed: InstalledSkill[];
  onChange: (list: InstalledSkill[]) => void;
}

function SkillSelectPanelInner({ open, onClose, installed, onChange }: Props) {
  const t = useT();
  const onToggle = (id: string, enabled: boolean) => onChange(setSkillEnabled(id, enabled));
  const enabledCount = installed.filter((s) => s.enabled).length;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-ink-muted" />
            {t("chat.skillsPanel.title")}
            {/* Purely numeric, so it needs no phrasing of its own in eleven locales. */}
            {enabledCount > 0 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-ink">
                {enabledCount}/{installed.length}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>{t("chat.skillsPanel.hint")}</DialogDescription>
        </DialogHeader>

        {installed.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line px-4 py-8 text-center">
            <Sparkles className="size-5 text-ink-subtle" />
            <p className="text-[13px] text-ink-muted">{t("chat.skillsPanel.empty")}</p>
            <DialogClose asChild>
              <Link
                href="/agent/skills"
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:brightness-105"
              >
                {t("chat.skillsPanel.browse")}
              </Link>
            </DialogClose>
          </div>
        ) : (
          <ul className="-mx-1 flex max-h-[55vh] flex-col gap-1.5 overflow-auto px-1">
            {installed.map((s) => (
              <li key={s.id}>
                {/* The whole row is the hit target: a 16px checkbox alone is a poor one, and the
                    description is the part the user is actually reading when they decide. */}
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition",
                    s.enabled
                      ? "border-primary/40 bg-primary/5"
                      : "border-line bg-surface-muted/40 hover:bg-surface-hover/60",
                  )}
                >
                  <Checkbox
                    checked={s.enabled}
                    onCheckedChange={(c) => onToggle(s.id, c === true)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] font-medium text-ink">
                      <span className="truncate">{s.name}</span>
                      <span className="font-mono text-[11px] font-normal text-ink-subtle">
                        v{s.version}
                      </span>
                      {s.source === "builtin" && (
                        <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium uppercase text-ink-subtle">
                          {t("skills.badge.builtin")}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-ink-subtle">
                      {s.description}
                    </p>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="sm:items-center sm:justify-between">
          {/* asChild, so leaving for the skills page also dismisses the dialog -- the chat page stays
              mounted across this navigation, so an unwrapped link leaves the modal open behind it. */}
          <DialogClose asChild>
            <Link
              href="/agent/skills"
              className="text-[11px] font-medium text-ink-muted transition hover:text-ink"
            >
              {t("chat.skillsPanel.manage")}
            </Link>
          </DialogClose>
          <DialogClose className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted">
            {t("chat.skillsPanel.close")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const SkillSelectPanel = memo(SkillSelectPanelInner);
