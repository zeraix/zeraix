"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Send, ChevronDown } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { addFilesTo, formatBytes, type Attachment } from "@/lib/ai/attachments";
import {
  OFFICIAL_PROVIDER_ID,
  ensureModelListSeeded,
  getSelectedModel,
  loadModelList,
  setSelectedModelId,
  MODEL_LIST_CHANGE_EVENT,
  type AgentModel,
} from "@/lib/ai/models";
import { LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import { useT } from "@/lib/i18n";

/** Brand pink from the design mockup (send button / accent). */
const ACCENT = "#f5327d";

/**
 * Task input box (used on the new-conversation home page).
 * Multi-line input on top + attachment preview + bottom toolbar (add file / model selection / send).
 * On submit, hands the text and attachments together to onSubmit (images are already uploaded to OSS, with url).
 */
export default function AgentComposer({
  placeholder,
  autoFocus = false,
  className,
  disabled = false,
  onSubmit,
}: {
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** When true, disables sending (e.g. no working directory chosen yet in dev mode); preserves entered text. */
  disabled?: boolean;
  onSubmit?: (text: string, attachments: Attachment[]) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState("");
  // Selectable model list (maintained in settings) + current selection; persisted on selection, read by the chat page when sending.
  const [models, setModels] = useState<AgentModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const attachIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploading = attachments.some((a) => a.kind === "image" && a.uploading);
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled && !uploading;

  // Load the model list and current selection; refresh when returning from the settings page (focus).
  useEffect(() => {
    const refresh = () => {
      ensureModelListSeeded();
      setModels(loadModelList());
      const sel = getSelectedModel(); // fall back to the first item in the list when missing
      setSelectedId(sel?.id ?? null);
      if (sel) setSelectedModelId(sel.id); // solidify the fallback value, the chat page sends based on it
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(MODEL_LIST_CHANGE_EVENT, refresh); // local model ready/stopped and other same-page list changes refresh immediately
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener(MODEL_LIST_CHANGE_EVENT, refresh); };
  }, []);

  const selectModel = (id: string) => {
    setSelectedId(id);
    setSelectedModelId(id);
  };
  const selectedLabel = models.find((m) => m.id === selectedId)?.label ?? null;

  // Group by category: official / local models / third-party / custom.
  const modelGroups = [
    {
      key: "official",
      labelKey: "models.official",
      items: models.filter((m) => !m.custom && m.providerId === OFFICIAL_PROVIDER_ID),
    },
    {
      key: "local",
      labelKey: "models.local",
      items: models.filter((m) => m.providerId === LOCAL_PROVIDER_ID),
    },
    {
      key: "thirdParty",
      labelKey: "models.thirdParty",
      items: models.filter((m) => !m.custom && m.providerId !== OFFICIAL_PROVIDER_ID && m.providerId !== LOCAL_PROVIDER_ID),
    },
    { key: "custom", labelKey: "models.custom", items: models.filter((m) => m.custom) },
  ].filter((g) => g.items.length > 0);

  const addFiles = (files: FileList | null) =>
    addFilesTo(files, {
      nextId: () => ++attachIdRef.current,
      push: (a) => setAttachments((list) => [...list, a]),
      patch: (id, p) => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...p } : a))),
      onError: setError,
    });

  const removeAttachment = (id: number) =>
    setAttachments((list) => {
      const t = list.find((a) => a.id === id);
      if (t?.previewUrl) URL.revokeObjectURL(t.previewUrl);
      return list.filter((a) => a.id !== id);
    });

  const submit = () => {
    if (!canSend) return;
    onSubmit?.(value.trim(), attachments);
    setValue("");
    setAttachments([]);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={cn(
        "rounded-2xl border border-line bg-background px-4 pb-3 pt-3 shadow-sm transition-colors focus-within:border-line-strong",
        className
      )}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div key={a.id} className="group relative">
              {a.kind === "image" ? (
                <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.previewUrl || a.url} alt={a.name} title={a.name} className="h-full w-full object-cover" />
                  {a.uploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] font-semibold text-white">
                      {a.progress ?? 0}%
                    </div>
                  )}
                  {a.uploadError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 text-[10px] font-semibold text-white">
                      Failed
                    </div>
                  )}
                </div>
              ) : (
                <div
                  title={`${a.name} · ${formatBytes(a.size)}`}
                  className="flex h-16 w-36 flex-col justify-center gap-0.5 rounded-lg border border-line bg-surface-muted px-2.5"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className="shrink-0">{a.kind === "binary" ? "📦" : "📄"}</span>
                    <span className="truncate">{a.name}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{formatBytes(a.size)}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                title="Remove"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[11px] font-bold text-white shadow transition hover:bg-neutral-900"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <Textarea
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={(e) => {
          if (e.clipboardData.files.length > 0) addFiles(e.clipboardData.files);
        }}
        placeholder={placeholder ?? t("composer.placeholder")}
        className="min-h-[64px] resize-none border-0 bg-transparent px-0 py-1 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      {error && <p className="mb-1 text-[11px] text-destructive">{error}</p>}

      <div className="mt-1 flex items-center gap-2">
        {/* Add file */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("composer.addFile")}
          title={t("composer.addFile")}
        >
          <Plus className="size-5" />
        </button>

        {/* Model selection */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex max-w-[220px] items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span className="truncate">{selectedLabel ?? t("composer.model")}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-auto">
            {models.length === 0 ? (
              <DropdownMenuItem onClick={() => router.push("/agent/settings")}>
                {t("composer.addModel")}
              </DropdownMenuItem>
            ) : (
              modelGroups.map((g, gi) => (
                <div key={g.key}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                    {t(g.labelKey)}
                  </DropdownMenuLabel>
                  {g.items.map((m) => (
                    <DropdownMenuItem key={m.id} onClick={() => selectModel(m.id)}>
                      <span className="truncate">{m.label}</span>
                      {m.id === selectedId && <span className="ml-auto text-primary">✓</span>}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Send */}
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          title={uploading ? t("composer.uploading") : undefined}
          className="ml-auto flex size-9 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
          style={{ backgroundColor: ACCENT }}
        >
          <Send className="size-4 -translate-x-px translate-y-px" />
        </button>
      </div>
    </div>
  );
}
