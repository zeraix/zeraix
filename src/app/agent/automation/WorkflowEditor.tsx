"use client";

/**
 * The workflow editor — a full page (its own route), not a dialog.
 *
 * One workflow, two views over the exact same `WorkflowDefinition`: **Simple** (beginner-first blocks)
 * and **Professional** (the React Flow canvas + raw JSON). The canonical value the page holds is the
 * JSON `text`; every view parses it and writes back through `onChange`, so switching modes is instant
 * and lossless — there is nothing to convert. Validation stays in the main process (schema.mjs); Save
 * only reports what it says.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Blocks, Workflow as WorkflowIcon, Loader2, AlertCircle, Sparkles, SlidersHorizontal, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  isWorkflowsAvailable,
  getWorkflow,
  saveWorkflow,
  type WorkflowDefinition,
} from "@/lib/workflows";
import SimpleFlow from "./SimpleFlow";
import WorkflowCanvas from "./WorkflowCanvas";
import WorkflowAssistant from "./WorkflowAssistant";

type Mode = "simple" | "pro";

export default function WorkflowEditor({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const search = useSearchParams();
  const available = useMemo(() => isWorkflowsAvailable(), []);

  const [text, setText] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>(search.get("mode") === "pro" ? "pro" : "simple");
  const [proTab, setProTab] = useState<"visual" | "json">("visual");
  const [showAssistant, setShowAssistant] = useState(false);

  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const def = await getWorkflow(id);
      if (ignore) return;
      if (def) setText(JSON.stringify(def, null, 2));
      else setNotFound(true);
    })();
    return () => {
      ignore = true;
    };
  }, [available, id]);

  /** Parsed view of the canonical text; null while a hand-edit on the JSON tab is momentarily invalid. */
  const definition = useMemo<WorkflowDefinition | null>(() => {
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as WorkflowDefinition) : null;
    } catch {
      return null;
    }
  }, [text]);

  const onChange = (next: WorkflowDefinition) => setText(JSON.stringify(next, null, 2));

  const switchMode = (m: Mode) => {
    setMode(m);
    // Keep the mode in the URL so it survives refresh / back-forward and is shareable.
    const params = new URLSearchParams(search.toString());
    params.set("mode", m);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const backToList = () => router.push(`/agent/automation?selected=${encodeURIComponent(id)}`);

  const onSave = async () => {
    if (text === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErrors([`${t("auto.jsonError")} ${e instanceof Error ? e.message : String(e)}`]);
      return;
    }
    setSaving(true);
    const res = await saveWorkflow(parsed);
    setSaving(false);
    if (res.ok) backToList();
    else setErrors(res.errors);
  };

  const renameWorkflow = (name: string) => {
    if (!definition) return;
    onChange({ ...definition, name });
  };

  /** Patch a workflow-level run limit (token budget, cost, duration), preserving the rest. */
  const patchLimits = (patch: Partial<WorkflowDefinition["limits"]>) => {
    if (!definition) return;
    const cur = definition.limits ?? { concurrency: "single" as const };
    onChange({ ...definition, limits: { ...cur, ...patch } });
  };

  /* ---------------- states ---------------- */

  if (!available) {
    return (
      <EditorShell t={t} onBack={() => router.push("/agent/automation")} title={t("auto.editTitle")}>
        <Centered>{t("auto.desktopOnly")}</Centered>
      </EditorShell>
    );
  }
  if (notFound) {
    return (
      <EditorShell t={t} onBack={() => router.push("/agent/automation")} title={t("auto.editTitle")}>
        <Centered>{t("auto.notFound")}</Centered>
      </EditorShell>
    );
  }
  if (text === null) {
    return (
      <EditorShell t={t} onBack={() => router.push("/agent/automation")} title={t("auto.editTitle")}>
        <Centered>
          <Loader2 className="size-5 animate-spin" />
        </Centered>
      </EditorShell>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Page top bar */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <button
          onClick={backToList}
          aria-label={t("auto.edit.back")}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface text-foreground transition hover:border-primary hover:bg-surface-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <p className="font-mono text-[10px] text-muted-foreground">automation / edit / {id}</p>
          <input
            value={definition?.name ?? ""}
            onChange={(e) => renameWorkflow(e.target.value)}
            placeholder={t("auto.edit.namePlaceholder")}
            className="-ml-1 w-full max-w-xs rounded px-1 text-[15px] font-semibold text-foreground outline-none focus:bg-surface-muted"
          />
        </div>

        <div className="flex-1" />

        {/* Build with AI */}
        <button
          onClick={() => setShowAssistant((v) => !v)}
          aria-pressed={showAssistant}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            showAssistant
              ? "border-primary bg-primary/10 text-primary"
              : "border-line-strong bg-surface text-foreground hover:bg-surface-muted"
          }`}
        >
          <Sparkles className="size-4" />
          {t("auto.ai.title")}
        </button>

        {/* Mode switch */}
        <div className="flex gap-0.5 rounded-lg bg-surface-muted p-0.5" role="group" aria-label={t("auto.edit.mode")}>
          <ModeTab active={mode === "simple"} onClick={() => switchMode("simple")}>
            <Blocks className="size-3.5" />
            {t("auto.mode.simple")}
          </ModeTab>
          <ModeTab active={mode === "pro"} onClick={() => switchMode("pro")}>
            <WorkflowIcon className="size-3.5" />
            {t("auto.mode.pro")}
          </ModeTab>
        </div>

        <div className="h-6 w-px bg-line-strong" />
        <button
          onClick={backToList}
          className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
        >
          {t("auto.cancelEdit")}
        </button>
        <button
          onClick={() => void onSave()}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {t("auto.save")}
        </button>
      </header>

      {/* Run limits — workflow-level ceilings the Policy Guard enforces. Shown in both modes because
          hitting a ceiling ("token ceiling reached 218k/200k") is exactly when a user needs to raise it. */}
      {definition && (
        <details className="group border-b border-line px-4 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition group-open:rotate-90" />
            <SlidersHorizontal className="size-3.5" />
            {t("auto.limits.title")}
          </summary>
          <div className="mt-2 grid max-w-2xl gap-3 sm:grid-cols-3">
            <LimitField
              label={t("auto.limits.maxTokens")}
              hint={t("auto.limits.maxTokensHint")}
              value={definition.limits?.maxTokens}
              placeholder={t("auto.limits.none")}
              onChange={(n) => patchLimits({ maxTokens: n })}
            />
            <LimitField
              label={t("auto.limits.maxCost")}
              value={definition.limits?.maxCostUsd}
              placeholder={t("auto.limits.none")}
              float
              onChange={(n) => patchLimits({ maxCostUsd: n })}
            />
            <LimitField
              label={t("auto.limits.maxMinutes")}
              value={definition.limits?.maxDurationMs ? Math.round(definition.limits.maxDurationMs / 60000) : undefined}
              placeholder={t("auto.limits.none")}
              onChange={(n) => patchLimits({ maxDurationMs: n ? n * 60000 : undefined })}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">{t("auto.limits.localNote")}</p>
        </details>
      )}

      {/* Sub-tabs for Professional */}
      {mode === "pro" && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          {(["visual", "json"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setProTab(tab)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                proTab === tab ? "bg-surface-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`auto.canvas.${tab}`)}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground">{t("auto.edit.proHint")}</span>
        </div>
      )}

      {/* Body: editor area + optional AI assistant drawer */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          <div className="h-full p-4">
            {mode === "simple" ? (
              definition ? (
                <SimpleFlow definition={definition} onChange={onChange} />
              ) : (
                <Centered>{t("auto.edit.invalidJson")}</Centered>
              )
            ) : proTab === "visual" && definition ? (
              <div className="h-full">
                <WorkflowCanvas key={definition.id} definition={definition} onChange={onChange} />
              </div>
            ) : proTab === "visual" ? (
              <Centered>{t("auto.edit.invalidJson")}</Centered>
            ) : (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                className="h-full min-h-[60vh] w-full resize-none rounded-lg border border-line-strong bg-surface p-3 font-mono text-xs text-foreground outline-none focus:border-ring"
              />
            )}
          </div>
        </div>
        {showAssistant && definition && (
          <div className="w-[340px] shrink-0 border-l border-line">
            <WorkflowAssistant current={definition} onApply={onChange} onClose={() => setShowAssistant(false)} />
          </div>
        )}
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
            {errors.map((err, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EditorShell({
  t,
  title,
  onBack,
  children,
}: {
  t: (k: string) => string;
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t("auto.edit.back")}
          className="flex size-9 items-center justify-center rounded-lg border border-line-strong bg-surface text-foreground transition hover:bg-surface-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function LimitField({
  label,
  hint,
  value,
  placeholder,
  float,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  placeholder?: string;
  float?: boolean;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      <input
        type="number"
        min={0}
        step={float ? "0.01" : "1"}
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          const n = float ? parseFloat(raw) : parseInt(raw, 10);
          // Empty or non-positive clears the ceiling (the field then means "no limit").
          onChange(raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
        }}
        className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-ring"
      />
      {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
        active ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
