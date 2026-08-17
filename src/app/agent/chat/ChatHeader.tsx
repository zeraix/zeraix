"use client";

/**
 * The chat page's top bar: conversation title (with the token-usage / rename / clear dropdown), the secure-environment
 * switch, the current-model chip, and the skills button.
 *
 * Purely presentational — every action is a callback and every value a prop, so nothing here reaches into the
 * page's state. It reads translations and the router itself, because those are ambient rather than page state.
 */
import { ChevronDown, Eraser, Monitor, Pencil, ShieldCheck } from "lucide-react";
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
  /** This session's secure-environment switch: true = run commands in the sandbox VM, false = on the host. */
  secureEnv: boolean;
  onSecureEnvChange: (next: boolean) => void;
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
  const { sandboxStatus: sbx, activeModel, sessionUsage, secureEnv } = props;
  const usageArgs = {
    approx: sessionUsage.estimated ? "≈" : "",
    total: sessionUsage.total,
    prompt: sessionUsage.prompt,
    completion: sessionUsage.completion,
  };

  // Where commands ACTUALLY go right now, which is not the same question as what the switch asks for: the VM may still be
  // downloading, still booting, or have crashed back to native, and in every one of those the honest answer is "the host".
  // The label reports this; the switch reports the request. Showing the request in both places is what would let the header
  // claim "Sandbox Execution" while a command ran on the user's machine.
  const inSandbox = isSandboxEngine(sbx?.active);
  const phase = sbx?.phase ?? "idle";
  const sandboxUnavailable = phase === "unsupported" || phase === "disabled";
  // Asked for the sandbox but not in it yet — the transitional state the label has to explain rather than silently deny.
  const pending = secureEnv && !inSandbox && !sandboxUnavailable;
  // Every transitional label is gated on `secureEnv`, not just the error one. This half of the pill answers exactly one
  // question — where do THIS session's commands run — and the VM downloads and boots in the background whether or not
  // the session asked for it. So "Sandbox image 42%" on a host-execution session would answer a question nobody asked
  // with a state that misdescribes where its commands are going. Such a session reads "Host Execution" throughout,
  // because that is the truth for it the whole time.
  const envLabel = inSandbox
    ? t("sbx.env.sandbox")
    : !secureEnv
      ? t("sbx.env.host")
      : phase === "pulling-image"
        ? t("sbx.badge.pulling", { pct: sbx?.pct ?? 0 })
        : phase === "installing-runtime" || phase === "starting"
          ? t("sbx.badge.starting")
          : phase === "error"
            ? t("sbx.badge.error")
            : t("sbx.env.host");
  /**
   * The pill's colour, as a WIPE rather than a cross-fade.
   *
   * Both directions are anchored at the LEFT edge: turning safe mode on grows the fill rightward, turning it off lets its
   * right edge retreat back leftward until it is gone. One anchor for both, so this is a plain `scale-x` toggle on a
   * fixed `origin-left` — the browser animates only `transform`, which it does on the compositor. The layer is separate
   * from the container so the text and icon are not scaled along with it.
   *
   * Colour and visibility are deliberately SEPARATE values. Deriving the colour as "" for the inactive state broke the
   * way out: the class was dropped in the same frame the collapse began, so the layer turned transparent instantly and
   * there was nothing left to watch retract — it simply disappeared. The colour therefore always resolves to something
   * (emerald is the resting choice, since safe mode is the state that has a fill) and only `envFilled` decides whether it
   * is scaled in. At rest with the switch off the layer is scale-x-0, so carrying a colour costs nothing visually.
   */
  const envFill = pending
    ? "bg-sky-500/15"
    : phase === "error" && secureEnv
      ? "bg-amber-500/15"
      : "bg-emerald-500/15";
  // Follows the switch, not the engine: `pending` is derived from `secureEnv` (local state), so this flips on the click
  // rather than waiting for the main process to confirm the engine change — the wipe starts under the user's finger.
  const envFilled = inSandbox || pending || (phase === "error" && secureEnv);
  const envText = inSandbox
    ? "text-emerald-600"
    : phase === "error" && secureEnv
      ? "text-amber-600 dark:text-amber-400"
      : pending
        ? "text-sky-600"
        : "text-ink-muted";
  const envTitle = inSandbox
    ? t("sbx.env.onTip")
    : sandboxUnavailable
      ? sbx?.reason || t("sbx.env.unsupported")
      : phase === "error"
        ? t("sbx.title.error", { reason: sbx?.reason ?? "" })
        : pending
          ? t("sbx.env.pendingTip")
          : t("sbx.env.offTip");

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
          {/* Secure environment: the switch that decides where THIS session's commands run, plus an indicator of where they
              actually run right now. Two controls in one pill because they answer two different questions and users conflate
              them — the left half states the live engine (and opens the runtime dialog for progress / failure / update), the
              right half is the request. Bound to the conversation, not the project: see Conversation.secureEnv. */}
          {props.toolsReady && (
            // Never hidden at narrow widths, unlike the status badge it replaces and the model chip beside it: this is the
            // only place the environment can be changed, and a control with no other entry point cannot responsively
            // disappear. The LABEL collapses instead — the icon and the switch still say which environment is live.
            <span
              className={`relative inline-flex items-center gap-1.5 overflow-hidden rounded-full bg-surface-muted py-0.5 pl-2 pr-1 text-[11px] font-medium transition-colors duration-300 ${envText}`}
            >
              {/* The wiping fill. Sits under the content (which is why the content is z-10) and is inert to the pointer,
                  so it changes nothing about hit-testing on either button. */}
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-0 origin-left transition-transform duration-300 ease-in ${envFill} ${
                  envFilled ? "scale-x-100" : "scale-x-0"
                }`}
              />
              <button
                type="button"
                onClick={props.onSandboxBadgeClick}
                className="relative z-10 flex items-center gap-1 rounded-full transition hover:brightness-95"
                title={envTitle}
              >
                {inSandbox ? <ShieldCheck className="size-3" /> : <Monitor className="size-3" />}
                <span className="hidden sm:inline">{envLabel}</span>
                {/* The runtime has a newer image: appended here rather than beside the switch, because updating is
                    something you do to the runtime, and this half is what opens the runtime dialog. */}
                {props.vmUpdatable && (
                  <span className="text-amber-600 dark:text-amber-400">{t("sbx.badge.updatable")}</span>
                )}
              </button>
              {/* The switch proper. Disabled when this machine cannot run the VM at all — offering a control that silently
                  does nothing is worse than showing why it is unavailable. */}
              <button
                type="button"
                role="switch"
                aria-checked={secureEnv}
                aria-label={t("sbx.env.label")}
                disabled={sandboxUnavailable}
                onClick={() => props.onSecureEnvChange(!secureEnv)}
                title={
                  sandboxUnavailable
                    ? sbx?.reason || t("sbx.env.unsupported")
                    : `${secureEnv ? t("sbx.env.onTip") : t("sbx.env.offTip")}\n${t("sbx.env.sessionNote")}`
                }
                className={`relative z-10 h-3.5 w-7 shrink-0 overflow-hidden rounded-full bg-line-strong ${
                  sandboxUnavailable ? "cursor-not-allowed opacity-50" : ""
                }`}
              >
                {/* The track fills by the same wipe, anchored the same way and over the same duration as the pill, so one
                    state change reads as one gesture rather than two effects that happen to coincide. The knob's slide is
                    matched to it too — it used to run at the default duration and arrived ahead of the colour. */}
                <span
                  aria-hidden
                  className={`absolute inset-0 origin-left bg-emerald-500 transition-transform duration-300 ease-in ${
                    secureEnv ? "scale-x-100" : "scale-x-0"
                  }`}
                />
                <span
                  className={`absolute top-0.5 z-10 size-2.5 rounded-full bg-white shadow-sm transition-[left] duration-300 ease-in ${
                    secureEnv ? "left-[15px]" : "left-0.5"
                  }`}
                />
              </button>
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
