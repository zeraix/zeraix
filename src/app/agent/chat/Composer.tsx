"use client";

import { Brain, ChevronDown, History, Paperclip, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { AgentModel } from "@/lib/ai/models";
import { LOCAL_PROVIDER_ID, isLocalEndpoint } from "@/lib/ai/localModel";
import {
  THINKING_EFFORTS,
  effortLabelKey,
  type ThinkingConfig,
  type ThinkingEffort,
} from "@/lib/ai/thinking";
import type { Attachment } from "./types";
import { formatBytes } from "./format";
import { useT } from "@/lib/i18n";
import { useImeGuard } from "@/lib/ime";
import { commandTokenLength, matchSlashCommands, type SlashCommand } from "./slashCommands";
import { AnimatePresence, motion } from "framer-motion";
import { useRef, useState } from "react";

/** Groups for the model selector inside the input box (official / local / third-party / custom). */
export type ModelGroup = { key: string; labelKey: string; items: AgentModel[] };

/**
 * Type metrics shared by the textarea and the mirror layer that paints the command tag behind it.
 *
 * Every property here affects where a character lands, so the two layers must be given the SAME ones or the
 * tag drifts from the word it is drawn around. Kept as one constant rather than duplicated class strings
 * precisely because the failure is silent: an edit to the textarea's padding alone would not break anything
 * that a test or a typecheck could see, only nudge a rounded rectangle off the word it belongs to.
 */
const TEXT_METRICS = "whitespace-pre-wrap break-words px-2 py-1 text-sm leading-relaxed";

/**
 * Bottom input area (Composer): preview of attachments to send + multi-line input + toolbar (add file · model selection · send / stop).
 * Purely presentational — all state and behavior are injected via props; the core send logic still lives in the page body.
 */
export function Composer({
  input,
  onInputChange,
  attachments,
  onRemoveAttachment,
  onAddFiles,
  taRef,
  fileInputRef,
  loading,
  onSend,
  onCancel,
  models,
  modelGroups,
  selectedLabel,
  selectedModelId,
  onSelectModel,
  onGoSettings,
  thinking,
  onThinkingChange,
}: {
  input: string;
  onInputChange: (v: string) => void;
  attachments: Attachment[];
  onRemoveAttachment: (id: number) => void;
  onAddFiles: (files: FileList | null) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  loading: boolean;
  onSend: () => void;
  onCancel: () => void;
  models: AgentModel[];
  modelGroups: ModelGroup[];
  selectedLabel: string | null;
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
  onGoSettings: () => void;
  /** Thinking mode: the master switch plus the gear it uses while on. */
  thinking: ThinkingConfig;
  onThinkingChange: (next: ThinkingConfig) => void;
}) {
  const t = useT();
  const ime = useImeGuard();

  // ── Slash-command menu ────────────────────────────────────────────────────────────────────────────
  // Derived from the input rather than held as open/closed state: the menu is a pure function of what has
  // been typed (see matchSlashCommands), so there is no way for it to get stuck open over text that is no
  // longer a command. `dismissed` is the one piece of real state — Escape has to be able to close a menu
  // that the text alone would keep open.
  const [dismissed, setDismissed] = useState(false);
  const matches = matchSlashCommands(input);
  const menu = dismissed ? null : matches;
  // Identity of the list currently on offer. The highlight is stored WITH the key it was chosen against and
  // read back only when they still agree, so filtering the list down re-homes the selection to the top
  // without an effect — and without the highlight ever pointing past the end of a shorter list.
  const menuKey = matches ? matches.map((c) => c.id).join(",") : "";
  const [hl, setHl] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const highlight = hl.key === menuKey ? hl.index : 0;
  const moveHighlight = (next: (from: number) => number) =>
    setHl({ key: menuKey, index: next(highlight) });

  // How much of the input is a complete command word — what the tag behind the textarea is drawn around.
  // Zero for ordinary messages, which is the overwhelmingly common case and renders no mirror at all.
  const tokenLen = commandTokenLength(input);
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  /** Put a command into the composer and close the menu. Never sends: the user confirms with Enter. */
  const pickCommand = (c: SlashCommand) => {
    onInputChange(c.insert);
    setDismissed(true);
    taRef.current?.focus();
  };
  // Mirrors the send side's isLocalModel: provider id, or a custom entry pointed at a local endpoint.
  const selected = models.find((m) => m.id === selectedModelId);
  const localSelected =
    !!selected && (selected.providerId === LOCAL_PROVIDER_ID || isLocalEndpoint(selected.endpoint ?? ""));
  return (
    <div className="border-t border-line bg-surface px-4 py-3">
      <div className="mx-auto w-full max-w-4xl">
        <div
          // `relative` anchors the slash-command menu, which is positioned against this box rather than the
          // textarea so it spans the full composer width.
          className="relative rounded-[20px] border border-line-strong bg-surface px-3 pb-2.5 pt-2.5 shadow-sm transition focus-within:border-ring focus-within:shadow-md focus-within:ring-4 focus-within:ring-primary/10"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onAddFiles(e.dataTransfer.files);
          }}
        >
          {/* Attachments to send: images show a thumbnail, other files show a card with an icon */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1 pt-0.5">
              {attachments.map((a) => (
                <div key={a.id} className="group relative">
                  {a.kind === "image" ? (
                    <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-line">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={a.previewUrl || a.url}
                        alt={a.name}
                        title={a.name}
                        className="h-full w-full object-cover"
                      />
                      {/* Uploading overlay + progress */}
                      {a.uploading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] font-semibold text-white">
                          {a.progress ?? 0}%
                        </div>
                      )}
                      {a.uploadError && (
                        <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 text-[10px] font-semibold text-white">
                          {t("chat.uploadFailedShort")}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      title={`${a.name} · ${formatBytes(a.size)}${a.kind === "binary" ? t("chat.notInlined") : ""}`}
                      className="flex h-16 w-36 flex-col justify-center gap-0.5 rounded-lg border border-line bg-surface-muted px-2.5"
                    >
                      <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                        <span className="shrink-0">{a.kind === "binary" ? "📦" : "📄"}</span>
                        <span className="truncate">{a.name}</span>
                      </div>
                      <span className="text-[10px] text-ink-subtle">
                        {formatBytes(a.size)}
                        {a.kind === "binary" && t("chat.notInlinedShort")}
                      </span>
                    </div>
                  )}
                  <button
                    onClick={() => onRemoveAttachment(a.id)}
                    title={t("chat.remove")}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[11px] font-bold text-white shadow transition hover:bg-neutral-900"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Slash-command menu: opens on "/" and filters as the command word is typed. Rendered above the
              textarea (bottom-anchored input, so a menu below it would be off-screen).

              AnimatePresence keeps it mounted long enough to animate back out — without it the menu would
              vanish on the frame the text stopped matching, which reads as a flicker rather than a dismissal.
              The rise-and-settle matches the consent panel's vocabulary (same duration, same expo-out curve),
              so the two surfaces that appear over the composer behave alike. */}
          <AnimatePresence>
            {menu && (
              <motion.div
                key="slash-menu"
                initial={{ opacity: 0, y: 6, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.985 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                // Scaling from the bottom edge keeps the menu anchored to the input it belongs to; the
                // default centre origin makes it look like it grew out of nowhere.
                style={{ transformOrigin: "bottom center" }}
                className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-surface/95 shadow-[0_8px_28px_-12px_rgba(0,0,0,0.3)] backdrop-blur-md"
              >
                <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
                    {t("slash.heading")}
                  </span>
                  {/* Keyboard affordances. The menu is driven from the keyboard far more than the mouse, and
                      nothing else on screen says the arrows do anything here. */}
                  <span className="flex items-center gap-1.5 text-[10px] text-ink-subtle">
                    <kbd className="rounded border border-line px-1 font-sans">↑↓</kbd>
                    {t("slash.hintNavigate")}
                    <kbd className="ml-1 rounded border border-line px-1 font-sans">↵</kbd>
                    {t("slash.hintSelect")}
                    <kbd className="ml-1 rounded border border-line px-1 font-sans">esc</kbd>
                    {t("slash.hintDismiss")}
                  </span>
                </div>
                <ul className="max-h-60 overflow-auto p-1">
                  {menu.map((c, i) => {
                    const active = i === highlight;
                    return (
                      <li key={c.id} className="relative">
                        {/* The selection, as its own layer with a shared layoutId: framer slides one
                            rectangle between rows instead of cross-fading a background per row, so moving
                            with the arrow keys reads as a single object tracking the cursor. */}
                        {active && (
                          <motion.span
                            layoutId="slash-active"
                            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                            className="absolute inset-0 rounded-lg bg-primary/[0.08] ring-1 ring-inset ring-primary/20"
                          />
                        )}
                        <button
                          // onMouseDown, not onClick: the textarea loses focus on mousedown, and a click
                          // handler would fire after that blur — long enough for the menu to have
                          // re-rendered under the pointer. Picking on mousedown also lets preventDefault
                          // keep focus in the box.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickCommand(c);
                          }}
                          onMouseEnter={() => moveHighlight(() => i)}
                          className="relative flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left"
                        >
                          {/* The literal command in the accent colour, the placeholder dimmed beside it:
                              what you type and what you fill in are different things, and the row says so
                              without a word of explanation. */}
                          <span className="shrink-0 font-mono text-xs">
                            <span
                              className={cn(
                                "font-semibold transition-colors duration-150",
                                active ? "text-primary" : "text-primary/75",
                              )}
                            >
                              {c.name}
                            </span>
                            {c.args && <span className="ml-1 font-normal text-ink-subtle">{c.args}</span>}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-[11px] transition-colors duration-150",
                              active ? "text-ink-muted" : "text-ink-subtle",
                            )}
                          >
                            {t(c.descriptionKey)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Multi-line input: auto-adjusting height, up to 30vh.

              A textarea cannot render styled content, so the command tag is painted by a mirror layer BEHIND
              it: same text, same metrics, everything transparent except a pill drawn around the command word.
              The real text stays in the textarea, fully visible and untouched.

              That direction is deliberate. The usual version of this trick hides the textarea's own text and
              lets the mirror draw it in colour — which puts the caret, the selection and every IME composition
              at the mercy of the two layers agreeing to the pixel. Here they do not have to: if the mirror
              drifts, a rounded rectangle sits slightly off, and typing still works perfectly. See lib/ime.ts
              for why input correctness is not something to trade for a colour. */}
          <div className="relative">
            {tokenLen > 0 && (
              <div
                ref={mirrorRef}
                aria-hidden
                className={cn(TEXT_METRICS, "pointer-events-none absolute inset-0 overflow-hidden text-transparent")}
              >
                {/* Padding and an equal NEGATIVE margin, always as a pair. Horizontal padding on an inline
                    box shifts its own content, which would slide the tag off the word it is drawn around;
                    pulling the box back by the same amount restores the character positions and leaves the
                    pill bleeding evenly past the text on both sides. That bleed is the only way this layer
                    can add breathing room at all — the visible text belongs to the textarea underneath and
                    its spacing is not ours to change. */}
                <span className="-mx-1 rounded-md bg-primary/[0.12] px-1 py-[3px] ring-1 ring-inset ring-primary/20">
                  {input.slice(0, tokenLen)}
                </span>
                {input.slice(tokenLen)}
              </div>
            )}
            <textarea
              ref={taRef}
              // Keeps the mirror aligned once the input grows past its max height and starts scrolling.
              onScroll={(e) => {
                if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              value={input}
              onChange={(e) => {
                // Any edit re-arms the menu: Escape dismisses the menu for the text it was showing, not for
                // the rest of the session.
                setDismissed(false);
                onInputChange(e.target.value);
              }}
              {...ime.bind}
              onKeyDown={(e) => {
                // The Enter that commits an IME composition is not a send. Returning before
                // preventDefault leaves the keypress to the IME, which still needs it. See lib/ime.ts.
                // Checked before the menu keys too: while composing, Enter and the arrows belong to the
                // candidate window, and stealing them to drive this menu would break IME input outright.
                if (ime.isImeKey(e)) return;
                // Menu navigation takes the keys it needs, and only while the menu is actually open.
                if (menu) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveHighlight((h) => (h + 1) % menu.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveHighlight((h) => (h - 1 + menu.length) % menu.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    // Enter picks rather than sends. Sending "/goa" as a chat message is never what someone
                    // half-way through typing a command meant.
                    e.preventDefault();
                    pickCommand(menu[highlight] ?? menu[0]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length > 0) onAddFiles(e.clipboardData.files);
              }}
              rows={1}
              placeholder={t("chat.composerPlaceholder")}
              // The metrics are shared with the mirror above, so the two layers wrap identically. The
              // textarea keeps its own background/caret concerns; only the type metrics are common.
              className={cn(
                TEXT_METRICS,
                "relative block max-h-[30vh] w-full resize-none border-0 bg-transparent text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed disabled:opacity-60",
              )}
            />
          </div>

          {/* Bottom toolbar: add file · model selection · send */}
          <div className="mt-1.5 flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onAddFiles(e.target.files);
                e.target.value = ""; // Allow selecting the same file again
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              title={t("composer.addFile")}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-muted hover:text-ink active:scale-95"
            >
              <Paperclip className="size-[18px]" />
            </button>

            {/* Model selector */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t("chat.selectModel")}
                  className="flex min-w-0 max-w-[220px] shrink items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
                >
                  <span className="truncate">{selectedLabel ?? t("chat.selectModel")}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-ink-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-auto">
                {models.length === 0 ? (
                  <DropdownMenuItem onClick={onGoSettings}>{t("composer.addModel")}</DropdownMenuItem>
                ) : (
                  modelGroups.map((g, gi) => (
                    <div key={g.key}>
                      {gi > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-[11px] text-ink-subtle">
                        {g.labelKey}
                      </DropdownMenuLabel>
                      {g.items.map((m) => (
                        <DropdownMenuItem key={m.id} onClick={() => onSelectModel(m.id)}>
                          <span className="truncate">{m.label}</span>
                          {m.id === selectedModelId && <span className="ml-auto text-primary">✓</span>}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Thinking mode: master switch + three gears. The gears stay visible while off (greyed) so the
                depth on offer is discoverable without having to flip the switch first. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t("composer.thinkingTitle")}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-muted",
                    thinking.enabled
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-line-strong text-ink-muted",
                  )}
                >
                  <Brain className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {thinking.enabled
                      ? t("composer.thinkingOn", { level: t(effortLabelKey(thinking.effort)) })
                      : t("composer.thinkingOff")}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                {/* The switch itself is decoration — the row owns the click, so the two can't both fire.
                    preventDefault keeps the menu open, so a gear can be picked in the same visit. */}
                <DropdownMenuItem
                  onSelect={(e) => e.preventDefault()}
                  onClick={() => onThinkingChange({ ...thinking, enabled: !thinking.enabled })}
                >
                  <Brain className="size-4 text-ink-muted" />
                  <span className="flex-1">{t("composer.thinking")}</span>
                  <Switch size="sm" checked={thinking.enabled} tabIndex={-1} className="pointer-events-none" />
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[11px] text-ink-subtle">
                  {t("composer.thinkingDepth")}
                </DropdownMenuLabel>
                {THINKING_EFFORTS.map((e: ThinkingEffort) => (
                  <DropdownMenuItem
                    key={e}
                    disabled={!thinking.enabled}
                    onClick={() => onThinkingChange({ ...thinking, enabled: true, effort: e })}
                  >
                    <span className="truncate">{t(effortLabelKey(e))}</span>
                    {thinking.effort === e && <span className="ml-auto text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
                {/* llama.cpp has no effort knob, so say so rather than let the gears look inert. */}
                {localSelected && (
                  <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-ink-subtle">
                    {t("composer.thinkingLocalNote")}
                  </p>
                )}
                <DropdownMenuSeparator />
                {/* Replay past thinking as context. Independent of the master switch above — a conversation can hold
                    thinking from earlier turns that is still worth sending after the switch has been turned off. */}
                <DropdownMenuItem
                  onSelect={(ev) => ev.preventDefault()}
                  onClick={() => onThinkingChange({ ...thinking, sendContext: !thinking.sendContext })}
                >
                  <History className="size-4 text-ink-muted" />
                  <span className="flex-1">{t("composer.thinkingContext")}</span>
                  <Switch size="sm" checked={thinking.sendContext} tabIndex={-1} className="pointer-events-none" />
                </DropdownMenuItem>
                <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-ink-subtle">
                  {t("composer.thinkingContextNote")}
                </p>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Send / stop (right-aligned) */}
            {/* While generating: offer both "stop" and "queue" — queuing adds the new message to the queue, which is then sent automatically in order after this round finishes. */}
            {loading && (
              <button
                onClick={onCancel}
                className="ml-auto flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-neutral-700 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-neutral-800 active:scale-95"
              >
                <span className="inline-block size-2.5 rounded-[2px] bg-surface" />
                {t("chat.stop")}
              </button>
            )}
            <button
              onClick={onSend}
              disabled={
                (!input.trim() && attachments.length === 0) ||
                attachments.some((a) => a.kind === "image" && a.uploading)
              }
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-br from-primary to-primary/85 pl-4 pr-4 text-sm font-semibold text-white shadow-sm transition hover:shadow-md hover:brightness-105 active:scale-95 disabled:opacity-50 disabled:shadow-none",
                !loading && "ml-auto",
              )}
              title={loading ? t("chat.queueTitle") : undefined}
            >
              <Send className="size-4 -translate-y-px" />
              {loading ? t("chat.queue") : t("chat.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
