"use client";

/**
 * The chat page's top bar: conversation title (with the token-usage / rename / clear dropdown), the sandbox
 * status badge, the current-model chip, and the skills button.
 *
 * Purely presentational — every action is a callback and every value a prop, so nothing here reaches into the
 * page's state. It reads translations and the router itself, because those are ambient rather than page state.
 */
import { ChevronDown, Eraser, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isSandboxEngine, type SandboxStatus } from "@/lib/ai/sandbox";
import type { ResolvedModel } from "@/lib/ai/models";
import { useT } from "@/lib/i18n";

export type SessionUsage = {
  prompt: number;
  completion: number;
  total: number;
  cached: number;
  estimated: boolean;
};

export function ChatHeader(props: {
  title: string;
  /** False before the first message, when there is no record to rename. */
  hasConversation: boolean;
  /** Number of display messages — the clear actions are pointless on an empty transcript. */
  messageCount: number;
  sessionUsage: SessionUsage;
  onRename: () => void;
  onClear: () => void;
  toolsReady: boolean;
  sandboxStatus: SandboxStatus | null;
  onSandboxBadgeClick: () => void;
  /** The runtime environment has a newer image available. */
  vmUpdatable: boolean;
  activeModel: ResolvedModel | null;
  isLocalModel: boolean;
  /** Tri-state: null while unknown, false when llama-server is selected but not running. */
  localLlmReady: boolean | null;
  onOpenSkills: () => void;
  enabledSkillCount: number;
  /** The settings strip below the title row is only rendered while the settings area is expanded. */
  settingsOpen: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const { sandboxStatus: sbx, activeModel, sessionUsage } = props;
  const usageArgs = {
    approx: sessionUsage.estimated ? "≈" : "",
    total: sessionUsage.total,
    prompt: sessionUsage.prompt,
    completion: sessionUsage.completion,
  };

  return (
    <div className="border-b border-line bg-surface/90 backdrop-blur">
      <div className="mx-auto w-full px-4 py-3">
        {/* Title row */}
        <div className="flex min-w-0 items-center gap-2">
          {/* Conversation title + dropdown: token usage, rename, clear. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 max-w-[min(45vw,320px)] items-center gap-1 rounded-lg px-1 py-0.5 text-left transition hover:bg-surface-muted"
                title={props.title || t("chat.title")}
              >
                <span className="truncate text-base font-bold">{props.title || t("chat.title")}</span>
                <ChevronDown className="size-4 shrink-0 text-ink-muted" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[15rem]">
              <DropdownMenuLabel className="whitespace-nowrap font-normal text-ink-subtle">
                {t("chat.tokenUsageLine", usageArgs)}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!props.hasConversation} onClick={props.onRename}>
                <Pencil className="size-4" /> {t("ctx.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={props.messageCount === 0}
                onClick={props.onClear}
                className="text-destructive focus:text-destructive"
              >
                <Eraser className="size-4" /> {t("chat.clearChat")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Sandbox status badge: where commands actually execute (sandbox VM / host machine) + initialization progress and failure reason. */}
          {props.toolsReady && sbx && sbx.phase !== "idle" && (
            <span
              onClick={props.onSandboxBadgeClick}
              role="button"
              className={`hidden cursor-pointer rounded-full px-2 py-0.5 text-[11px] font-medium transition hover:brightness-95 sm:inline ${
                isSandboxEngine(sbx.active)
                  ? "bg-emerald-500/15 text-emerald-600"
                  : sbx.phase === "error"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : sbx.phase === "installing-runtime" ||
                        sbx.phase === "pulling-image" ||
                        sbx.phase === "starting"
                      ? "bg-sky-500/15 text-sky-600"
                      : "bg-surface-muted text-ink-muted"
              }`}
              title={
                isSandboxEngine(sbx.active)
                  ? t("sbx.title.sandbox", { engine: sbx.active })
                  : sbx.phase === "ready"
                    ? t("sbx.title.ready")
                    : sbx.phase === "error"
                      ? t("sbx.title.error", { reason: sbx.reason })
                      : sbx.phase === "pulling-image"
                        ? t("sbx.title.pulling")
                        : sbx.phase === "installing-runtime" || sbx.phase === "starting"
                          ? t("sbx.title.starting")
                          : sbx.reason || t("sbx.title.unsupported")
              }
            >
              {isSandboxEngine(sbx.active)
                ? t("sbx.badge.sandbox")
                : sbx.phase === "pulling-image"
                  ? t("sbx.badge.pulling", { pct: sbx.pct ?? 0 })
                  : sbx.phase === "installing-runtime" || sbx.phase === "starting"
                    ? t("sbx.badge.starting")
                    : sbx.phase === "error"
                      ? t("sbx.badge.error")
                      : t("sbx.badge.host")}
              {/* The runtime environment has an updatable version: the badge appends a hint (click the badge to open the dialog and update). */}
              {props.vmUpdatable && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">{t("sbx.badge.updatable")}</span>
              )}
            </span>
          )}
          {/* The current model (read-only; chosen in settings / home page). Green dot = available (cloud has a key configured / the local service is running);
              amber = missing key or the local service is not started — when local is not started, clicking jumps directly to "Settings → Local model" to start it. */}
          <span
            className={`hidden max-w-[220px] items-center gap-1.5 truncate rounded-full bg-surface-muted px-2.5 py-0.5 text-[11px] text-ink-muted sm:flex ${props.isLocalModel && props.localLlmReady === false ? "cursor-pointer hover:bg-surface" : ""}`}
            title={
              !activeModel
                ? t("lm.chipNoModel")
                : props.isLocalModel && props.localLlmReady === false
                  ? t("lm.notStartedTip")
                  : activeModel.label
            }
            onClick={() => {
              if (props.isLocalModel && props.localLlmReady === false) router.push("/agent/models");
            }}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeModel && (props.isLocalModel ? props.localLlmReady === true : !!activeModel.apiKey.trim()) ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span className="truncate">{activeModel?.label ?? t("lm.noModelShort")}</span>
          </span>
          <button
            onClick={props.onOpenSkills}
            className="ml-auto shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-line hover:bg-surface-muted active:scale-[0.98]"
            title={t("chat.selectSkills")}
          >
            🧩 {t("chat.skills")}
            {props.enabledSkillCount > 0 && (
              <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                {props.enabledSkillCount}
              </span>
            )}
          </button>
          {props.messageCount > 0 && (
            <button
              onClick={props.onClear}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-line hover:bg-surface-muted active:scale-[0.98]"
            >
              {t("chat.clearChat")}
            </button>
          )}
        </div>

        {/* The model and API key are managed in "Settings · Model / API key"; the working directory is now determined
            automatically by the project / at send time. Run parameters (round limits / deadlock protection) have been
            removed, and this area only shows this session's token usage. */}
        {props.settingsOpen && (
          <div className="mt-3 border-t border-line/60 pt-3">
            {sessionUsage.total > 0 && (
              <p className="text-[11px] text-ink-subtle">{t("chat.sessionTokens", usageArgs)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
