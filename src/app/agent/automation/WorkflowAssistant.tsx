"use client";

/**
 * The "Build with AI" dialogue panel on the editor page.
 *
 * The user describes what they want; the assistant generates (or edits) the workflow and applies it to
 * the editor, so the Simple/Professional views update live and the change is reviewed — and Saved —
 * like any hand edit. It is deliberately a thin conversation over generate.ts: no state of its own that
 * the definition doesn't already hold, so closing and reopening loses nothing important.
 */
import { useRef, useState, useEffect } from "react";
import { Sparkles, Send, Loader2, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { WorkflowDefinition } from "@/lib/workflows";
import { runAssistant, type AssistantMessage } from "./generate";

type Msg = { role: "user" | "assistant"; text: string; error?: boolean; ui?: boolean };

export default function WorkflowAssistant({
  current,
  onApply,
  onClose,
}: {
  current: WorkflowDefinition;
  onApply: (next: WorkflowDefinition) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", text: t("auto.ai.intro"), ui: true }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = async (text: string) => {
    const description = text.trim();
    if (!description || busy) return;
    setInput("");
    // Model history is the real exchange only — skip UI-only lines (the greeting, error notices).
    const history: AssistantMessage[] = [
      ...messages.filter((m) => !m.ui).map((m) => ({ role: m.role, text: m.text })),
      { role: "user", text: description },
    ];
    setMessages((m) => [...m, { role: "user", text: description }]);
    setBusy(true);
    const res = await runAssistant({ history, current }, t);
    setBusy(false);
    if (res.ok) {
      if (res.definition) onApply(res.definition);
      // Prefer the model's own words; fall back to a short note only if it built silently.
      const reply = res.reply || (res.definition ? t("auto.ai.applied", { n: res.stepCount ?? 0 }) : "");
      if (reply) setMessages((m) => [...m, { role: "assistant", text: reply }]);
    } else {
      setMessages((m) => [...m, { role: "assistant", text: res.error, error: true, ui: true }]);
    }
  };

  const examples = [t("auto.ai.ex1"), t("auto.ai.ex2"), t("auto.ai.ex3")];
  const showExamples = messages.length <= 1 && !busy;

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">{t("auto.ai.title")}</span>
        <button
          onClick={onClose}
          aria-label={t("auto.ai.close")}
          className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : m.error
                    ? "border border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400"
                    : "bg-surface-muted text-foreground"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl bg-surface-muted px-3 py-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("auto.ai.generating")}
            </div>
          </div>
        )}

        {showExamples && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t("auto.ai.tryLabel")}</p>
            {examples.map((ex, i) => (
              <button
                key={i}
                onClick={() => void send(ex)}
                className="block w-full rounded-lg border border-line px-2.5 py-1.5 text-left text-[12px] text-foreground transition hover:border-primary hover:bg-primary/5"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-line p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-surface px-2 py-1.5 focus-within:border-ring">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={t("auto.ai.placeholder")}
            rows={2}
            className="min-h-0 flex-1 resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            aria-label={t("auto.ai.send")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:opacity-90 disabled:opacity-30"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[10.5px] text-muted-foreground">{t("auto.ai.disclaimer")}</p>
      </div>
    </div>
  );
}
