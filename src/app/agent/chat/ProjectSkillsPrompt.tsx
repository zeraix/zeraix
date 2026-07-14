"use client";

/**
 * Project skill discovery.
 *
 * When a conversation has a working directory, scan the project for skill / instruction files left behind by other tools (.claude, .codex/AGENTS.md (OpenAI),
 * .cursor, .github (Copilot), .windsurf, .zeraix). For skills that are "not yet decided", pop a toast notification in the bottom-right corner;
 * after the user clicks "View", a dialog opens to [Add] / [View content] / [Ignore] each one. Decisions are written to .zeraix/config.json
 * (see @/lib/ai/skills/project). The dialog closes automatically once everything has been handled.
 *
 * The component itself only renders dialogs (Portal) and takes no layout space; use workdirKey to trigger re-discovery (pass a new value when switching conversation / directory).
 * onDecided is called back after each decision, so the parent can reload the enabled project skills and feed them to the agent.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Eye, Loader2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import {
  decideProjectSkill,
  discoverProjectSkills,
  readProjectSkill,
  type ProjectSkill,
} from "@/lib/ai/skills/project";

export function ProjectSkillsPrompt({
  workdirKey,
  onDecided,
}: {
  workdirKey?: string;
  onDecided?: () => void;
}) {
  const t = useT();
  const [pending, setPending] = useState<ProjectSkill[]>([]);
  const [open, setOpen] = useState(false); // Skill list dialog
  const [busy, setBusy] = useState<string | null>(null); // Path of the skill currently being decided
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
  const [loadingView, setLoadingView] = useState(false);

  // Discover "to be decided" skills (discovered status). Re-discover when switching conversation / directory (workdirKey changes);
  // if there are new skills, pop a toast in the bottom-right corner, and clicking "View" opens the dialog. Use a fixed id to dedupe and avoid repeated pop-ups.
  useEffect(() => {
    let active = true;
    void discoverProjectSkills().then((all) => {
      if (!active) return;
      const undecided = all.filter((s) => s.status === "discovered");
      setPending(undecided);
      if (undecided.length > 0) {
        Toast.info(t("projectSkills.detected", { n: undecided.length }), t("projectSkills.prompt"), {
          id: `project-skills:${workdirKey ?? ""}`,
          position: "bottom-right",
          duration: Infinity,
          action: { label: t("projectSkills.viewAction"), onClick: () => setOpen(true) },
        });
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdirKey]);

  const decide = useCallback(
    async (skill: ProjectSkill, enabled: boolean) => {
      setBusy(skill.path);
      try {
        await decideProjectSkill(skill.path, enabled);
        setPending((list) => {
          const next = list.filter((s) => s.path !== skill.path);
          if (next.length === 0) setOpen(false); // All handled → close the dialog
          return next;
        });
        onDecided?.();
      } finally {
        setBusy(null);
      }
    },
    [onDecided],
  );

  const view = useCallback(async (skill: ProjectSkill) => {
    setLoadingView(true);
    setViewing({ name: skill.name, content: "" });
    const content = await readProjectSkill(skill.path);
    setViewing({ name: skill.name, content });
    setLoadingView(false);
  }, []);

  return (
    <>
      {/* Skill list dialog (opened by the toast's "View" action) */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("projectSkills.modalTitle")}</DialogTitle>
            <DialogDescription>{t("projectSkills.prompt")}</DialogDescription>
          </DialogHeader>
          {pending.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-ink-subtle">
              {t("projectSkills.allHandled")}
            </p>
          ) : (
            <ul className="flex max-h-[55vh] flex-col gap-1.5 overflow-auto">
              {pending.map((s) => {
                const rowBusy = busy === s.path;
                return (
                  <li
                    key={s.path}
                    className="flex items-center gap-3 rounded-lg border border-line bg-surface-muted/40 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                        <span className="truncate">{s.name}</span>
                        <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium uppercase text-ink-subtle">
                          {s.source}
                        </span>
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-subtle">{s.path}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void decide(s, true)}
                        disabled={rowBusy}
                        className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-60"
                      >
                        {rowBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Check className="size-3.5" />
                        )}
                        {t("projectSkills.add")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void view(s)}
                        className="flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted"
                      >
                        <Eye className="size-3.5" />
                        {t("projectSkills.view")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(s, false)}
                        disabled={rowBusy}
                        className="flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs font-medium text-ink-subtle transition hover:bg-surface-muted disabled:opacity-60"
                      >
                        <X className="size-3.5" />
                        {t("projectSkills.ignore")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* Single-skill content viewer dialog */}
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name || t("projectSkills.viewTitle")}</DialogTitle>
            <DialogDescription>{t("projectSkills.viewTitle")}</DialogDescription>
          </DialogHeader>
          {loadingView ? (
            <div className="flex items-center gap-2 px-1 py-6 text-sm text-ink-subtle">
              <Loader2 className="size-4 animate-spin" />
              {t("projectSkills.loading")}
            </div>
          ) : (
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs leading-relaxed text-ink">
              {viewing?.content}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
