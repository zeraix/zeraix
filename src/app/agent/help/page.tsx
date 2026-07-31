"use client";

/**
 * Help page (/agent/help): reached from "Help & feedback" in the sidebar account menu.
 * Renders inside the /agent shell (the main sidebar stays visible), so it needs no back entry of its own.
 *
 * Three blocks:
 *  - FAQ: the questions that otherwise arrive as issues — where data lives, own keys, offline models, billing, language.
 *  - Resources: the repository, its issue tracker and its releases, all derived from GITHUB_URL.
 *  - Send feedback: an entry point only. Composing a report is a task of its own (pick a channel, write it up),
 *    so it lives on /agent/help/feedback rather than as a form buried under the FAQ.
 */
import { useState } from "react";
import { Bug, ChevronDown, CircleHelp, ExternalLink, Github, Send, Tags } from "lucide-react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n";
import { GITHUB_URL } from "@/constants/App";
import { cn } from "@/lib/utils";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { CARD, openExternal } from "./ui";

/** Question/answer i18n key pairs, in display order. */
const FAQ: readonly (readonly [string, string])[] = [
  ["help.q.storage", "help.a.storage"],
  ["help.q.keys", "help.a.keys"],
  ["help.q.local", "help.a.local"],
  ["help.q.billing", "help.a.billing"],
  ["help.q.language", "help.a.language"],
];

/** Links to the repository. Paths are plain GitHub routes, valid for any public repo. */
const RESOURCES = [
  { href: GITHUB_URL, titleKey: "help.repo", descKey: "help.repoDesc", icon: Github },
  { href: `${GITHUB_URL}/issues`, titleKey: "help.issues", descKey: "help.issuesDesc", icon: Bug },
  { href: `${GITHUB_URL}/releases`, titleKey: "help.releases", descKey: "help.releasesDesc", icon: Tags },
] as const;

export default function AgentHelpPage() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(FAQ[0][0]); // one answer expanded at a time

  return (
    <CustomScrollbar className="h-full" config={PAGE_SCROLLBAR}>
      <div className="mx-auto max-w-3xl px-8 py-10">
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-foreground">
            <CircleHelp className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{t("help.title")}</h1>
            <p className="mt-0.5 text-sm text-ink-subtle">{t("help.subtitle")}</p>
          </div>
        </div>

        {/* FAQ */}
        <h2 className="mb-2 mt-8 text-sm font-semibold text-ink">{t("help.faq")}</h2>
        <div className={cn(CARD, "divide-y divide-line")}>
          {FAQ.map(([qKey, aKey]) => {
            const expanded = open === qKey;
            return (
              <div key={qKey}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : qKey)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-ink transition hover:bg-surface/60"
                >
                  <span className="min-w-0 flex-1">{t(qKey)}</span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-ink-subtle transition-transform",
                      expanded && "rotate-180",
                    )}
                  />
                </button>
                {expanded && (
                  <p className="px-4 pb-3.5 text-[13px] leading-relaxed text-ink-muted">{t(aKey)}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Resources */}
        <h2 className="mb-2 mt-8 flex items-center gap-1.5 text-sm font-semibold text-ink">
          <ExternalLink className="size-4 text-ink-muted" />
          {t("help.resources")}
        </h2>
        <div className={cn(CARD, "divide-y divide-line")}>
          {RESOURCES.map(({ href, titleKey, descKey, icon: Icon }) => (
            <div key={href} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Icon className="size-4 text-ink-muted" />
                  {t(titleKey)}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-subtle">{t(descKey)}</p>
              </div>
              <button
                onClick={() => openExternal(href)}
                className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
              >
                {t("help.open")}
              </button>
            </div>
          ))}
        </div>

        {/* Feedback: entry point to the dedicated page */}
        <div className={cn(CARD, "mt-8 flex flex-wrap items-center justify-between gap-2 px-4 py-3.5")}>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <Send className="size-4 text-ink-muted" />
              {t("help.feedback")}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-subtle">{t("help.feedbackCardDesc")}</p>
          </div>
          <button
            onClick={() => router.push("/agent/help/feedback")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105"
          >
            {t("help.open")}
          </button>
        </div>
      </div>
    </CustomScrollbar>
  );
}
