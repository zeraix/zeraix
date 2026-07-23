"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Brain, Download, FolderOpen, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  deleteMemoryFile,
  downloadTemplate,
  exportMemories,
  importMemories,
  isMemoryFilesAvailable,
  listMemoryFiles,
  type MemoryFile,
  openMemoryDir,
  saveMemoryFile,
} from "@/lib/ai/memoryFiles";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fmtDate } from "./formatDate";
import { FIELD_CLS, PRIMARY_BTN } from "./styles";


/** Memory section: visually manage the memories the AI writes (one Markdown file per entry) — view / refresh / open directory / delete. */
export function MemorySection({ t }: { t: TFunc }) {
  const available = isMemoryFilesAvailable();
  const [items, setItems] = useState<MemoryFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Manual new-entry form
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    try {
      setItems(await listMemoryFiles());
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = async (m: MemoryFile) => {
    if (!window.confirm(t("memory.deleteConfirm"))) return;
    await deleteMemoryFile(m.id);
    await refresh();
  };

  const onCreate = async () => {
    if (!newTitle.trim() && !newContent.trim()) return;
    setBusy(true);
    try {
      await saveMemoryFile({ title: newTitle.trim(), content: newContent.trim() });
      setNewTitle("");
      setNewContent("");
      setCreating(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setBusy(true);
    try {
      await importMemories();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onDownloadTemplate = async () => {
    setBusy(true);
    try {
      await downloadTemplate();
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    setBusy(true);
    try {
      await exportMemories();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-2 text-xl font-bold text-ink">{t("settings.memory")}</h2>
      <p className="mb-5 text-xs text-ink-subtle">{t("memory.desc")}</p>

      {!available ? (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("memory.unavailable")}
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Brain className="size-4 text-ink-muted" />
              {t("memory.items")}
              <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {items.length}
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCreating((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted"
              >
                <Plus className="size-3" />
                {t("memory.create")}
              </button>
              <button
                type="button"
                onClick={() => void onImport()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
              >
                <Upload className="size-3" />
                {t("memory.import")}
              </button>
              <button
                type="button"
                onClick={() => void onDownloadTemplate()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
              >
                <Download className="size-3" />
                {t("memory.template")}
              </button>
              <button
                type="button"
                onClick={() => void onExport()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted disabled:opacity-50"
              >
                <Archive className="size-3" />
                {t("memory.export")}
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted"
              >
                <RefreshCw className={cn("size-3", loading && "animate-spin")} />
                {t("memory.refresh")}
              </button>
              <button
                type="button"
                onClick={() => void openMemoryDir()}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink transition hover:bg-surface-muted"
              >
                <FolderOpen className="size-3" />
                {t("memory.openDir")}
              </button>
            </div>
          </div>

          {/* Manual new-memory form */}
          {creating && (
            <div className="mb-3 space-y-2 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t("memory.newTitle")}
                className={cn(FIELD_CLS, "w-full")}
              />
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder={t("memory.newContent")}
                rows={4}
                className={cn(FIELD_CLS, "w-full resize-y")}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onCreate()}
                  disabled={busy || (!newTitle.trim() && !newContent.trim())}
                  className={cn(PRIMARY_BTN, "h-[30px]")}
                >
                  {t("memory.save")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewTitle("");
                    setNewContent("");
                  }}
                  className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
                >
                  {t("memory.cancel")}
                </button>
              </div>
            </div>
          )}

          {items.length === 0 ? (
            <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
              {t("memory.empty")}
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((m) => {
                const open = expanded === m.id;
                return (
                  <div key={m.id} className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : m.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-sm font-semibold text-ink">{m.title || m.id}</p>
                        <p
                          className={cn(
                            "mt-0.5 whitespace-pre-wrap break-words text-xs text-ink-subtle",
                            !open && "line-clamp-2",
                          )}
                        >
                          {m.content}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(m)}
                        className="shrink-0 rounded-md p-1 text-ink-subtle transition hover:bg-red-500/10 hover:text-red-500"
                        aria-label={t("memory.delete")}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    {m.updated && (
                      <p className="mt-1.5 font-mono text-[10px] text-ink-subtle/70">
                        {t("memory.updated")}
                        {fmtDate(m.updated)} · {m.id}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
