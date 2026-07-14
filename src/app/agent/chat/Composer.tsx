"use client";

import { ChevronDown, Paperclip, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentModel } from "@/lib/ai/models";
import type { Attachment } from "./types";
import { formatBytes } from "./format";
import { useT } from "@/lib/i18n";

/** Groups for the model selector inside the input box (official / local / third-party / custom). */
export type ModelGroup = { key: string; labelKey: string; items: AgentModel[] };

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
}) {
  const t = useT();
  return (
    <div className="border-t border-line bg-surface px-4 py-3">
      <div className="mx-auto w-full max-w-4xl">
        <div
          className="rounded-[20px] border border-line-strong bg-surface px-3 pb-2.5 pt-2.5 shadow-sm transition focus-within:border-ring focus-within:shadow-md focus-within:ring-4 focus-within:ring-primary/10"
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

          {/* Multi-line input: auto-adjusting height, up to 30vh */}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
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
            className="block max-h-[30vh] w-full resize-none border-0 bg-transparent px-1.5 py-1 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed disabled:opacity-60"
          />

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
                  className="flex max-w-[220px] items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
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
