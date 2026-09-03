"use client";

/**
 * In-conversation "skill selection" panel (dialog). It only handles selection — choosing which installed skills go into the current conversation's config —
 * not downloading / uninstalling (those happen on the /agent/skills page). Selections are written to the shared store,
 * and the latest list is passed up to the chat page via onChange (it takes effect on the next message).
 */
import { memo } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
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
  if (!open) return null;

  const onToggle = (id: string, enabled: boolean) => onChange(setSkillEnabled(id, enabled));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("chat.skillsPanel.title")}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Sparkles className="size-4 text-ink-muted" />
          <span className="text-base font-bold text-ink">{t("chat.skillsPanel.title")}</span>
          <span className="text-[11px] text-ink-subtle">{t("chat.skillsPanel.hint")}</span>
          <button
            onClick={onClose}
            className="ml-auto rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
          >
            {t("chat.skillsPanel.close")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {installed.length === 0 ? (
            <div className="rounded-lg bg-surface-muted px-3 py-4 text-center">
              <p className="text-xs text-ink-muted">{t("chat.skillsPanel.empty")}</p>
              <Link
                href="/agent/skills"
                className="mt-2 inline-block rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
              >
                {t("chat.skillsPanel.browse")}
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {installed.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start gap-2 rounded-lg border border-line px-3 py-2"
                >
                  <label className="mt-0.5 flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => onToggle(s.id, e.target.checked)}
                      className="size-4 accent-primary"
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {s.name}
                      <span className="ml-1 font-mono text-[11px] text-ink-subtle">v{s.version}</span>
                      {s.enabled && (
                        <span className="ml-2 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success-ink">
                          {t("chat.skillsPanel.enabled")}
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-ink-subtle">{s.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer: go to the skills page to download more */}
        <div className="border-t border-line px-4 py-2.5">
          <Link
            href="/agent/skills"
            className="text-[11px] font-medium text-ink-muted transition hover:text-ink"
          >
            {t("chat.skillsPanel.manage")}
          </Link>
        </div>
      </div>
    </div>
  );
}

export const SkillSelectPanel = memo(SkillSelectPanelInner);
