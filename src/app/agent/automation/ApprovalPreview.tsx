"use client";

/**
 * What a pending approval is actually asking you to authorise.
 *
 * This used to be `<pre>{JSON.stringify(preview, null, 2)}</pre>` — the engine's own payload, shape
 * and all. That is readable if you already know the wire format, and an obstacle if you do not: to
 * answer "should this send?" a user first had to work out which field held the thing being sent.
 * An approval gate that costs the reader a JSON-parsing exercise is worse than no gate, because the
 * predictable response to an unreadable prompt is to approve it and move on.
 *
 * So the shape is read by runtime and rendered as the action it represents — the command a shell step
 * will run, the instruction an agent step will follow — with the resolved inputs beside it, since a
 * step's real content usually arrives as an input from the step before it. The raw payload stays one
 * disclosure away: engineers need it, and hiding data outright would trade one bad default for another.
 */
import { useState } from "react";
import { ChevronRight, Terminal, Bot, FileText } from "lucide-react";
import { useT } from "@/lib/i18n";

/** The payload executionManager builds for an approval (see requestApproval). */
export interface ApprovalPayload {
  runtime?: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

/** Values under this length read fine on one line; longer ones get their own block. */
const INLINE_MAX = 60;

export default function ApprovalPreview({ preview }: { preview: unknown }) {
  const t = useT();
  const [showRaw, setShowRaw] = useState(false);

  const payload = (preview ?? {}) as ApprovalPayload;
  const runtime = typeof payload.runtime === "string" ? payload.runtime : "";
  const config = isRecord(payload.config) ? payload.config : {};
  const inputs = isRecord(payload.inputs) ? payload.inputs : {};

  // The one field that *is* the action. Anything else in config is a knob (model, timeout) and
  // belongs in the technical disclosure, not in the question being asked.
  const action =
    runtime === "shell"
      ? { icon: <Terminal className="size-3.5" />, label: t("auto.approval.willRun"), body: str(config.command), mono: true }
      : runtime === "agent"
        ? { icon: <Bot className="size-3.5" />, label: t("auto.approval.willAsk"), body: str(config.prompt), mono: false }
        : { icon: <FileText className="size-3.5" />, label: t("auto.approval.willDo", { runtime: runtime || "?" }), body: "", mono: false };

  const inputEntries = Object.entries(inputs);
  // Nothing recognisable to show: fall back to the raw payload rather than an empty card that looks
  // like the approval has no content.
  const unreadable = !action.body && inputEntries.length === 0;

  return (
    <div className="mt-2 space-y-2">
      {action.body && (
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            {action.icon}
            {action.label}
          </p>
          <pre
            className={`max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line/60 bg-surface p-2.5 text-[11px] leading-relaxed text-foreground ${
              action.mono ? "font-mono" : ""
            }`}
          >
            {action.body}
          </pre>
        </div>
      )}

      {/* The values this step was handed. Usually where the actual content lives — the draft to send,
          the text about to be written to a file — which is exactly what the JSON dump buried. */}
      {inputEntries.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{t("auto.approval.withValues")}</p>
          <dl className="space-y-1.5 rounded-lg border border-line/60 bg-surface p-2.5">
            {inputEntries.map(([key, value]) => {
              const text = str(value);
              const block = text.length > INLINE_MAX || text.includes("\n");
              return (
                <div key={key} className={block ? "space-y-1" : "flex gap-2"}>
                  <dt className="shrink-0 text-[11px] font-medium text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 flex-1">
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
                      {text || t("auto.approval.emptyValue")}
                    </pre>
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}

      {/* Never a lossy summary: everything the engine stored is one click away, including the config
          knobs skipped above. */}
      <div>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          aria-expanded={showRaw}
          className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight className={`size-3 transition-transform ${showRaw ? "rotate-90" : ""}`} />
          {unreadable ? t("auto.approval.rawOnly") : t("auto.approval.rawDetails")}
        </button>
        {(showRaw || unreadable) && (
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-line/60 bg-surface p-2.5 font-mono text-[10px] leading-snug text-muted-foreground">
            {JSON.stringify(preview, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Render a value as the text a person should read: strings as themselves, structures as JSON. */
function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
