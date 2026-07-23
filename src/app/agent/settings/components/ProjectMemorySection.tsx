"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, CheckCircle2, FileCog, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { type TFunc } from "@/lib/i18n";
import { callTool, getWorkingDir, isToolkitAvailable, wsReadFile, wsWriteFile } from "@/lib/ai/toolkit";
import { cn } from "@/lib/utils";

/** Filename of the per-workspace project map (electron/tools/projectMemory/constants.mjs). */
export const PROJECT_MEMORY_FILE = "ZERAIX.md";

/**
 * Project memory (ZERAIX.md): the map the assistant keeps for the current workspace.
 *
 * Editing it here is a first-class path, not an escape hatch. Generated sections sit between
 * `zeraix:` markers and are rebuilt from the repository, while everything outside them — and
 * anything marked `lock` or listed in `pins=` — is preserved verbatim. So a correction made here
 * survives the next rebuild, which is what makes hand-editing worth offering at all.
 */
export function ProjectMemorySection({ t }: { t: TFunc }) {
  const available = isToolkitAvailable();
  const [workdir, setWorkdir] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Reading is kept free of setState so the effect below can drop a result that arrived after the
  // panel closed — otherwise navigating away mid-read updates an unmounted component.
  const fetchDoc = useCallback(async () => {
    if (!available) return null;
    try {
      const dir = await getWorkingDir();
      const r = await wsReadFile(PROJECT_MEMORY_FILE);
      return { dir, content: r.ok ? r.content : null };
    } catch {
      return { dir: "", content: null };
    }
  }, [available]);

  const apply = useCallback((doc: { dir: string; content: string | null }) => {
    setWorkdir(doc.dir);
    setText(doc.content);
    setDraft(doc.content ?? "");
  }, []);

  const load = useCallback(async () => {
    const doc = await fetchDoc();
    if (doc) apply(doc);
  }, [fetchDoc, apply]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const doc = await fetchDoc();
      if (alive && doc) apply(doc);
    })();
    return () => {
      alive = false;
    };
  }, [fetchDoc, apply]);

  // Read straight off the document rather than tracking state separately: the file is the source
  // of truth, and it may have been rewritten by a rebuild since this panel last rendered.
  const stats = useMemo(() => {
    const src = text ?? "";
    const notesBody = src.split("id=notes")[1]?.split("zeraix:end")[0] ?? "";
    return {
      modules: (src.match(/^- `[^`]+\/` —/gm) ?? []).length,
      pending: (src.match(/\(not yet summarised\)/g) ?? []).length,
      pinned: (src.match(/pins=([^\s>]+)/)?.[1]?.split(",").filter(Boolean) ?? []).length,
      notes: notesBody
        .split("\n")
        .filter((l) => l.trim().startsWith("- ") && !l.includes("(nothing recorded yet)")).length,
    };
  }, [text]);

  const dirty = draft !== (text ?? "");

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const onSave = () =>
    withBusy(async () => {
      await wsWriteFile(PROJECT_MEMORY_FILE, draft);
      setText(draft);
      setSaved(true);
    });

  const onRebuild = (refresh: boolean) =>
    withBusy(async () => {
      await callTool("init_command", refresh ? { refresh: true } : {});
      await load();
    });

  return (
    <div className="mt-10 border-t border-line pt-8">
      <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <FileCog className="size-4 text-ink-muted" />
        {t("projmem.title")}
      </p>
      <p className="mb-4 text-xs text-ink-subtle">{t("projmem.desc")}</p>

      {!available ? (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("memory.unavailable")}
        </p>
      ) : (
        <>
          <p className="mb-3 truncate text-[11px] text-ink-subtle" title={workdir}>
            {t("projmem.workdir", { dir: workdir || "—" })}
          </p>

          {text === null ? (
            <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
              <p className="mb-3 text-xs text-ink-subtle">{t("projmem.none")}</p>
              <button
                type="button"
                onClick={() => void onRebuild(false)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Brain className="size-3" />}
                {t("projmem.generate")}
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                  {t("projmem.statModules", { count: stats.modules })}
                </span>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                  {t("projmem.statNotes", { count: stats.notes })}
                </span>
                {stats.pinned > 0 && (
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                    {t("projmem.statPinned", { count: stats.pinned })}
                  </span>
                )}
                {stats.pending > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600">
                    {t("projmem.statPending", { count: stats.pending })}
                  </span>
                )}
              </div>

              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
                spellCheck={false}
                rows={18}
                className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink outline-none transition focus:border-line-strong"
              />

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void onSave()}
                  disabled={busy || !dirty}
                  className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
                >
                  {saved && !dirty ? <CheckCircle2 className="size-3 text-emerald-500" /> : null}
                  {saved && !dirty ? t("projmem.saved") : t("projmem.save")}
                </button>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
                >
                  <RotateCcw className="size-3" />
                  {t("projmem.reload")}
                </button>
                <button
                  type="button"
                  onClick={() => void onRebuild(true)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3", busy && "animate-spin")} />
                  {t("projmem.rebuild")}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-ink-subtle">{t("projmem.hint")}</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
