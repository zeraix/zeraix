"use client";

/**
 * The expanded half of a plugin card: what the plugin adds, and — once installed — its files.
 *
 * Two sources, deliberately asymmetric. The catalogue knows every item's display name but no paths;
 * the installed record knows paths but carries no names. So they are merged by id: names come from
 * the catalogue where there is one, paths from disk. An uninstalled plugin therefore lists what it
 * would add and nothing else, because nothing of it exists locally yet — the renderer is never sent
 * entry points or command lines (design doc §4).
 *
 * Note the vocabulary: the word "capability" is the install path's model, not the user's, and must
 * not reach the screen (design doc §10). Everything here is "what it adds" and "files".
 */

import { useCallback, useMemo, useState } from "react";
import { FileCode, Loader2 } from "lucide-react";

import { pluginBridge } from "@/lib/plugins/bridge";
import type { CatalogueEntry, InstalledPlugin } from "@/lib/plugins/types";
import type { T } from "./ui";

export function PluginDetails({
  t,
  entry,
  record,
}: {
  t: T;
  entry: CatalogueEntry | null;
  record: InstalledPlugin | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [file, setFile] = useState<{ loading: boolean; content: string | null; error: string | null }>({
    loading: false,
    content: null,
    error: null,
  });

  const pluginId = entry?.id ?? record?.id ?? "";
  /** id -> display name, so the file list can show "Writing commits" rather than `commits`. */
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of entry?.capabilities ?? []) if (c.name) m.set(c.id, c.name);
    return m;
  }, [entry]);

  /** Grouped by the author's `module`, which is exactly what it is for: "adds 3 tools and a skill". */
  const byModule = useMemo(() => {
    const items = entry?.capabilities ?? record?.capabilities.map((c) => ({ ...c, name: null })) ?? [];
    const groups = new Map<string, { id: string; type: string; name: string | null }[]>();
    for (const c of items) {
      const key = c.module ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id: c.id, type: c.type, name: c.name ?? null });
    }
    return [...groups.entries()];
  }, [entry, record]);

  const files = record?.capabilities.filter((c) => c.path) ?? [];
  /** Locale-formatted, because the record stores an ISO string nobody wants to read. */
  const installedAt = useMemo(() => {
    if (!record?.installedAt) return null;
    const d = new Date(record.installedAt);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
  }, [record]);

  const openFile = useCallback(
    async (capId: string) => {
      if (open === capId) {
        setOpen(null);
        return;
      }
      setOpen(capId);
      setFile({ loading: true, content: null, error: null });
      const bridge = pluginBridge();
      if (!bridge) return setFile({ loading: false, content: null, error: t("plugins.readFailed") });
      try {
        // Re-verified against the pinned digest on the main-process side, so what renders here is
        // the reviewed bytes or nothing at all.
        const r = await bridge.read(pluginId, capId);
        setFile({ loading: false, content: r.content, error: r.ok ? null : r.error ?? t("plugins.readFailed") });
      } catch (e) {
        setFile({ loading: false, content: null, error: e instanceof Error ? e.message : t("plugins.readFailed") });
      }
    },
    [open, pluginId, t],
  );

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          {t("plugins.detailAdds")}
        </h3>
        <div className="space-y-1.5">
          {byModule.map(([mod, items]) => (
            <div key={mod || "_"} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {mod ? <span className="font-mono text-[10px] text-ink-subtle">{mod}</span> : null}
              {items.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                  <span className="size-1 rounded-full bg-ink-subtle/40" />
                  {c.name ?? c.id}
                  <span className="text-[10px] text-ink-subtle">{t(`plugins.adds.${c.type}`, { count: 1 })}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          {t("plugins.detailFiles")}
        </h3>
        {files.length === 0 ? (
          <p className="text-[11px] text-ink-subtle">{t("plugins.filesAfterInstall")}</p>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line">
            {files.map((c) => (
              <li key={c.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => void openFile(c.id)}
                  aria-expanded={open === c.id}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-surface-hover/50"
                >
                  <FileCode className="size-3 shrink-0 text-ink-subtle" />
                  <span className="truncate font-mono text-[11px] text-ink-muted">{c.path}</span>
                  <span className="ml-auto shrink-0 truncate text-[10px] text-ink-subtle">
                    {names.get(c.id) ?? c.id}
                  </span>
                </button>
                {open === c.id ? (
                  <div className="border-t border-line bg-surface-muted/40 px-2.5 py-2">
                    {file.loading ? (
                      <Loader2 className="size-3.5 animate-spin text-ink-subtle" />
                    ) : file.error ? (
                      <p className="text-[11px] text-danger-ink">{file.error}</p>
                    ) : (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-ink-muted">
                        {file.content}
                      </pre>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {installedAt ? (
        <p className="text-[10px] text-ink-subtle">{t("plugins.detailInstalled", { date: installedAt })}</p>
      ) : null}
    </div>
  );
}
