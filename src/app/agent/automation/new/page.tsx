"use client";

/**
 * "New workflow" — the first-run / template picker page.
 *
 * A blank editor teaches nothing (see electron/automation/templates.mjs), so starting a workflow means
 * choosing a starting point. Picking one mints the definition in the main process and navigates straight
 * into the editor with `replace`, so Back returns to the list rather than this picker.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, AlertCircle } from "lucide-react";
import { useT } from "@/lib/i18n";
import { isWorkflowsAvailable, listTemplates, createFromTemplate } from "@/lib/workflows";

/** A friendly face per starter template; unknown ids fall back to a neutral block. */
const TEMPLATE_EMOJI: Record<string, string> = {
  blank: "🧩",
  digest: "📰",
  actions: "✅",
  article: "📣",
  stocks: "📈",
  intel: "🛰️",
};

export default function NewWorkflowPage() {
  const t = useT();
  const router = useRouter();
  const available = useMemo(() => isWorkflowsAvailable(), []);
  const [templates, setTemplates] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const list = await listTemplates();
      if (!ignore) setTemplates(list);
    })();
    return () => {
      ignore = true;
    };
  }, [available]);

  const create = async (templateId: string) => {
    if (busy) return;
    setBusy(templateId);
    setError(null);
    const res = await createFromTemplate(templateId, t(`auto.tpl.${templateId}.name`));
    if (res.ok) router.replace(`/agent/automation/edit?id=${encodeURIComponent(res.id)}&mode=simple`);
    else {
      setBusy(null);
      setError(res.errors.join("; "));
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          onClick={() => router.push("/agent/automation")}
          aria-label={t("auto.edit.back")}
          className="flex size-9 items-center justify-center rounded-lg border border-line-strong bg-surface text-foreground transition hover:bg-surface-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <p className="text-[15px] font-semibold text-foreground">{t("auto.new.title")}</p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-6 py-10">
          {!available ? (
            <p className="text-center text-sm text-muted-foreground">{t("auto.desktopOnly")}</p>
          ) : (
            <>
              <h1 className="text-center text-2xl font-bold tracking-tight text-foreground">{t("auto.new.heading")}</h1>
              <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">{t("auto.new.subtitle")}</p>

              {error && (
                <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="size-3.5" />
                  {error}
                </p>
              )}

              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {templates.map((tpl) => (
                  <button
                    key={tpl}
                    onClick={() => void create(tpl)}
                    disabled={!!busy}
                    className="flex items-center gap-3 rounded-2xl border border-line-strong bg-surface p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary disabled:opacity-50"
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/5 text-2xl">
                      {busy === tpl ? (
                        <Loader2 className="size-5 animate-spin text-primary" />
                      ) : (
                        TEMPLATE_EMOJI[tpl] ?? "🧩"
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground">{t(`auto.tpl.${tpl}.name`)}</span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                        {t(`auto.tpl.${tpl}.desc`)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
