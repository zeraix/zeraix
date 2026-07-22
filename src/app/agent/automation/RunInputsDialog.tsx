"use client";

/**
 * Collects a workflow's declared inputs before a run starts.
 *
 * The engine refuses a run whose required inputs are missing (design doc §4.1) — deliberately,
 * because failing deep inside a node means money already spent. This dialog is the other half of
 * that contract: without it a user would hit "missing required input(s)" with no way to supply them.
 *
 * `secret` variables are never asked for here. They resolve from secure storage at execute time and
 * must not pass through the renderer, which is exactly how a key ends up in a log or a crash report.
 */
import { useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pickWorkflowFile, type WorkflowVariable } from "@/lib/workflows";

/** Variables a user can actually be asked for. */
export function askableVariables(vars: WorkflowVariable[] | undefined): WorkflowVariable[] {
  return (vars ?? []).filter((v) => v.type !== "secret");
}

export default function RunInputsDialog({
  open,
  onOpenChange,
  variables,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variables: WorkflowVariable[];
  onRun: (values: Record<string, unknown>) => Promise<void>;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const raw = (v: WorkflowVariable) =>
    values[v.key] ?? (v.default === undefined ? "" : String(v.default));

  const missing = variables.filter((v) => v.required && !raw(v).trim());

  /** Parse each field to its declared type; JSON is validated so a typo fails here, not mid-run. */
  const collect = (): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } => {
    const out: Record<string, unknown> = {};
    for (const v of variables) {
      const text = raw(v);
      if (!text.trim() && !v.required) continue; // let the definition's default apply
      switch (v.type) {
        case "number": {
          const n = Number(text);
          if (!Number.isFinite(n)) return { ok: false, error: `${v.label || v.key}: not a number` };
          out[v.key] = n;
          break;
        }
        case "boolean":
          out[v.key] = text === "true";
          break;
        case "json":
          try {
            out[v.key] = JSON.parse(text);
          } catch {
            return { ok: false, error: `${v.label || v.key}: invalid JSON` };
          }
          break;
        default:
          out[v.key] = text;
      }
    }
    return { ok: true, values: out };
  };

  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const parsed = collect();
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    setBusy(true);
    try {
      await onRun(parsed.values);
      onOpenChange(false);
      setValues({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("auto.inputs.title")}</DialogTitle>
          <DialogDescription>{t("auto.inputs.desc")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto">
          {variables.map((v) => (
            <label key={v.key} className="block">
              <span className="mb-1 flex items-center gap-1 text-xs font-medium text-foreground">
                {v.label || v.key}
                {v.required && <span className="text-red-500">*</span>}
              </span>

              {v.type === "file" ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await pickWorkflowFile();
                      if (p) setValues((s) => ({ ...s, [v.key]: p }));
                    }}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs text-foreground transition hover:bg-surface-muted"
                  >
                    <FileUp className="size-3.5" />
                    {t("auto.inputs.choose")}
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                    {raw(v) || t("auto.inputs.noFile")}
                  </span>
                </div>
              ) : v.type === "boolean" ? (
                <select
                  value={raw(v) || "false"}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  className="w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs outline-none focus:border-ring"
                >
                  <option value="true">{t("auto.inputs.yes")}</option>
                  <option value="false">{t("auto.inputs.no")}</option>
                </select>
              ) : v.type === "json" ? (
                <textarea
                  value={raw(v)}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  rows={3}
                  spellCheck={false}
                  className="w-full resize-none rounded-lg border border-line-strong bg-surface px-2 py-1.5 font-mono text-[11px] outline-none focus:border-ring"
                />
              ) : (
                <input
                  type={v.type === "number" ? "number" : "text"}
                  value={raw(v)}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  className="w-full rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs outline-none focus:border-ring"
                />
              )}
            </label>
          ))}
        </div>

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
          >
            {t("auto.cancelEdit")}
          </button>
          <button
            onClick={() => void submit()}
            // Disabled rather than letting the engine reject it: the user should see what is missing
            // here, not as an error string after the fact.
            disabled={busy || missing.length > 0}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t("auto.run")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
