"use client";

/**
 * MCP servers section: connect Zeraix to external software and hosted MCP services.
 *
 * The panel manages configuration and trust only -- the protocol lives entirely in the main process
 * (electron/mcp/*), and a connected server's tools reach the model through the normal tool registry,
 * so nothing here touches the chat loop.
 *
 * Two things drive the layout:
 *  - **Approval is the gate, not the toggle.** An MCP server is third-party code with the user's
 *    filesystem and network, so a newly added or edited server shows its exact command line / URL and
 *    stays unconnected until the user accepts it. Editing the target revokes approval server-side.
 *  - **Failures are the common case while setting one up** (wrong path, missing API key), so a
 *    server's error text and the tail of its stderr are shown inline rather than behind a dialog --
 *    stderr is usually the only place the real reason appears.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileJson,
  FolderOpen,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { Toast } from "@/lib/toast";
import {
  type McpKind,
  type McpServer,
  type McpServerInput,
  type McpSnapshot,
  type McpStatus,
  approveMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  importMcpServers,
  isMcpAvailable,
  listMcp,
  onMcpStatus,
  openMcpConfig,
  parseCommandLine,
  parseKeyValueLines,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "@/lib/ai/mcp";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "./ToggleSwitch";
import { FIELD_CLS, PRIMARY_BTN } from "./styles";

/** The editor's working copy: free text the user types, parsed into config only on save. */
interface Draft {
  id: string;
  isNew: boolean;
  kind: McpKind;
  commandLine: string;
  cwd: string;
  url: string;
  /** KEY=value lines, one per line. */
  envText: string;
  headersText: string;
}

const EMPTY_DRAFT: Draft = { id: "", isNew: true, kind: "stdio", commandLine: "", cwd: "", url: "", envText: "", headersText: "" };

const DOT: Record<McpStatus["status"], string> = {
  ready: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  error: "bg-red-500",
  idle: "bg-line-strong",
  disabled: "bg-line-strong",
};

export function McpSection({ t }: { t: TFunc }) {
  const available = isMcpAvailable();
  const [snap, setSnap] = useState<McpSnapshot>({ servers: [], status: [] });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string>("");

  const refresh = useCallback(() => {
    void listMcp().then(setSnap);
  }, []);

  useEffect(() => {
    refresh();
    // Connection state is pushed: a handshake takes seconds and a server can drop at any time, so
    // polling would either lag or hammer the IPC channel.
    return onMcpStatus((status) => setSnap((prev) => ({ ...prev, status })));
  }, [refresh]);

  const statusById = useMemo(() => {
    const m = new Map<string, McpStatus>();
    for (const s of snap.status) m.set(s.id, s);
    return m;
  }, [snap.status]);

  /** Apply a mutation result: handlers return the fresh snapshot so the UI never re-reads. */
  const applied = (res: { ok: boolean; error?: string } & Partial<McpSnapshot>, okMsg?: string) => {
    if (!res.ok) {
      Toast.error(res.error ? t(`mcp.err.${res.error}`) : t("mcp.err.failed"));
      return false;
    }
    if (res.servers && res.status) setSnap({ servers: res.servers, status: res.status });
    if (okMsg) Toast.success(okMsg);
    return true;
  };

  const startEdit = (s: McpServer) =>
    setDraft({
      id: s.id,
      isNew: false,
      kind: s.kind,
      commandLine: [s.command, ...s.args].filter(Boolean).join(" "),
      cwd: s.cwd,
      url: s.url,
      // Values are never sent to the renderer, so an edit starts from empty and re-entering a
      // variable is what re-sets it. Showing the key names alone would imply the values are here.
      envText: "",
      headersText: "",
    });

  const save = async () => {
    if (!draft) return;
    const id = draft.id.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      Toast.error(t("mcp.err.invalid-server-id"));
      return;
    }
    let config: McpServerInput;
    if (draft.kind === "http") {
      if (!draft.url.trim()) {
        Toast.error(t("mcp.err.invalid-server-config"));
        return;
      }
      config = { url: draft.url.trim(), headers: parseKeyValueLines(draft.headersText) };
    } else {
      const { command, args } = parseCommandLine(draft.commandLine.trim());
      if (!command) {
        Toast.error(t("mcp.err.invalid-server-config"));
        return;
      }
      config = { command, args, env: parseKeyValueLines(draft.envText), cwd: draft.cwd.trim() };
    }
    setBusy(id);
    const res = await upsertMcpServer(id, config);
    setBusy("");
    if (applied(res, t("mcp.saved"))) setDraft(null);
  };

  const approveAndConnect = async (s: McpServer) => {
    setBusy(s.id);
    const res = await approveMcpServer(s.id, true);
    if (applied(res)) await connectMcpServer(s.id);
    setBusy("");
  };

  const toggleTools = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const doImport = async () => {
    if (importText === null) return;
    let blob: unknown;
    try {
      blob = JSON.parse(importText);
    } catch {
      Toast.error(t("mcp.err.invalid-import"));
      return;
    }
    const res = await importMcpServers(blob);
    if (!res.ok) {
      Toast.error(t("mcp.err.invalid-import"));
      return;
    }
    const added = (res as { added?: string[] }).added ?? [];
    if (applied(res as Parameters<typeof applied>[0])) {
      Toast.success(`${t("mcp.importDone")} ${added.length}`);
      setImportText(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="mb-2 text-xl font-bold text-ink">{t("settings.mcp")}</h2>
      <p className="mb-5 text-xs text-ink-subtle">{t("mcp.desc")}</p>

      {!available ? (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("mcp.unsupported")}
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setDraft({ ...EMPTY_DRAFT })} className={PRIMARY_BTN}>
              <Plus className="size-3.5" />
              {t("mcp.add")}
            </button>
            <button
              type="button"
              onClick={() => setImportText(importText === null ? "" : null)}
              className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-muted"
            >
              <FileJson className="size-3.5" />
              {t("mcp.import")}
            </button>
            <button
              type="button"
              onClick={() => void openMcpConfig()}
              className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-muted"
            >
              <FolderOpen className="size-3.5" />
              {t("mcp.openConfig")}
            </button>
            <button
              type="button"
              onClick={refresh}
              className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-muted"
            >
              <RefreshCw className="size-3.5" />
              {t("mcp.refresh")}
            </button>
          </div>

          {importText !== null && (
            <div className="mb-4 rounded-xl border border-line bg-surface-muted/50 p-4">
              <p className="mb-1 text-sm font-semibold text-ink">{t("mcp.importTitle")}</p>
              <p className="mb-2 text-[11px] text-ink-subtle">{t("mcp.importHint")}</p>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={6}
                spellCheck={false}
                placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'}
                className={cn(FIELD_CLS, "w-full font-mono text-[11px]")}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImportText(null)}
                  className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-muted"
                >
                  {t("mcp.cancel")}
                </button>
                <button type="button" onClick={() => void doImport()} className={PRIMARY_BTN}>
                  {t("mcp.import")}
                </button>
              </div>
            </div>
          )}

          {draft && <ServerEditor t={t} draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} busy={busy === draft.id} />}

          {snap.servers.length === 0 ? (
            <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">{t("mcp.empty")}</p>
          ) : (
            <div className="space-y-3">
              {snap.servers.map((s) => {
                const st = statusById.get(s.id);
                const state = st?.status ?? "idle";
                const target = s.kind === "http" ? s.url : [s.command, ...s.args].join(" ");
                const open = expanded.has(s.id);
                return (
                  <div key={s.id} className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", DOT[state])} aria-hidden />
                      <p className="truncate text-sm font-semibold text-ink">{s.id}</p>
                      <span className="shrink-0 rounded border border-line-strong px-1.5 py-px text-[10px] uppercase text-ink-subtle">
                        {s.kind}
                      </span>
                      <span className="truncate text-[11px] text-ink-subtle">{t(`mcp.status.${state}`)}</span>
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        <ToggleSwitch
                          on={!s.disabled}
                          label={t("mcp.enabled")}
                          onChange={(on) => void setMcpServerEnabled(s.id, on).then((r) => applied(r))}
                        />
                      </div>
                    </div>

                    <p className="mt-1 truncate font-mono text-[11px] text-ink-subtle" title={target}>
                      {target}
                    </p>
                    {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
                      <p className="mt-0.5 text-[11px] text-ink-subtle">
                        {(s.kind === "http" ? s.headerKeys : s.envKeys).join(", ")}
                      </p>
                    )}

                    {/* Trust gate: an unapproved server never connects, and never runs on its own. */}
                    {!s.approved && (
                      <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="size-3.5" />
                          {t("mcp.approveTitle")}
                        </p>
                        <p className="mt-1 text-[11px] text-ink-subtle">{t("mcp.approveDesc")}</p>
                        <button
                          type="button"
                          disabled={busy === s.id}
                          onClick={() => void approveAndConnect(s)}
                          className={cn(PRIMARY_BTN, "mt-2")}
                        >
                          <ShieldCheck className="size-3.5" />
                          {t("mcp.approve")}
                        </button>
                      </div>
                    )}

                    {st?.error && (
                      <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
                        {st.error}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {state === "ready" ? (
                        <button
                          type="button"
                          onClick={() => void disconnectMcpServer(s.id).then((r) => applied(r))}
                          className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted"
                        >
                          <Plug className="size-3.5" />
                          {t("mcp.disconnect")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!s.approved || s.disabled || state === "connecting"}
                          onClick={() => void connectMcpServer(s.id).then((r) => applied(r))}
                          className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted disabled:opacity-40"
                        >
                          <PlugZap className="size-3.5" />
                          {t("mcp.connect")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleTools(s.id)}
                        className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted"
                      >
                        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        <Wrench className="size-3.5" />
                        {t("mcp.tools")} {st?.tools.length ?? 0}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(s)}
                        className="rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted"
                      >
                        {t("mcp.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeMcpServer(s.id).then((r) => applied(r))}
                        className="ml-auto flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-red-600 transition hover:bg-red-500/10 dark:text-red-400"
                      >
                        <Trash2 className="size-3.5" />
                        {t("mcp.delete")}
                      </button>
                    </div>

                    {open && (
                      <div className="mt-2 rounded-lg border border-line bg-surface px-3 py-2">
                        {(st?.tools.length ?? 0) === 0 ? (
                          <p className="text-[11px] text-ink-subtle">{t("mcp.noTools")}</p>
                        ) : (
                          <>
                            <p className="mb-1.5 text-[11px] text-ink-subtle">{t("mcp.toolPrefixNote")}</p>
                            <ul className="space-y-1">
                              {st!.tools.map((tool) => (
                                <li key={tool.name} className="text-[11px]">
                                  <span className="font-mono text-ink">{tool.name}</span>
                                  <span className="ml-1 text-ink-subtle">{tool.description}</span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        {st?.stderr && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-ink-subtle">{t("mcp.stderr")}</summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-ink-subtle">
                              {st.stderr}
                            </pre>
                          </details>
                        )}
                      </div>
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

/** Add / edit form. Kept in the same panel rather than a modal: the command line is long, and the
 *  list above is the context that makes an id collision obvious. */
function ServerEditor({
  t,
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
}: {
  t: TFunc;
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <div className="mb-4 rounded-xl border border-line bg-surface-muted/50 p-4">
      <p className="mb-3 text-sm font-semibold text-ink">{draft.isNew ? t("mcp.addTitle") : t("mcp.editTitle")}</p>

      <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.id")}</label>
      <input
        value={draft.id}
        disabled={!draft.isNew}
        onChange={(e) => set({ id: e.target.value })}
        placeholder="github"
        className={cn(FIELD_CLS, "mb-1 w-full font-mono text-xs disabled:opacity-60")}
      />
      <p className="mb-3 text-[11px] text-ink-subtle">{t("mcp.idHint")}</p>

      <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.type")}</label>
      <div className="mb-3 flex gap-2">
        {(["stdio", "http"] as McpKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => set({ kind: k })}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-xs transition",
              draft.kind === k ? "border-primary bg-primary/10 text-ink" : "border-line-strong bg-surface text-ink-muted hover:bg-surface-muted",
            )}
          >
            {t(`mcp.type${k === "stdio" ? "Stdio" : "Http"}`)}
          </button>
        ))}
      </div>

      {draft.kind === "stdio" ? (
        <>
          <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.command")}</label>
          <input
            value={draft.commandLine}
            onChange={(e) => set({ commandLine: e.target.value })}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
            spellCheck={false}
            className={cn(FIELD_CLS, "mb-1 w-full font-mono text-xs")}
          />
          <p className="mb-3 text-[11px] text-ink-subtle">{t("mcp.commandHint")}</p>

          <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.cwd")}</label>
          <input
            value={draft.cwd}
            onChange={(e) => set({ cwd: e.target.value })}
            spellCheck={false}
            className={cn(FIELD_CLS, "mb-3 w-full font-mono text-xs")}
          />

          <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.env")}</label>
          <textarea
            value={draft.envText}
            onChange={(e) => set({ envText: e.target.value })}
            rows={3}
            spellCheck={false}
            placeholder={"GITHUB_TOKEN=ghp_..."}
            className={cn(FIELD_CLS, "mb-1 w-full font-mono text-[11px]")}
          />
          <p className="mb-3 text-[11px] text-ink-subtle">{t("mcp.envHint")}</p>
        </>
      ) : (
        <>
          <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.url")}</label>
          <input
            value={draft.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="https://mcp.example.com/mcp"
            spellCheck={false}
            className={cn(FIELD_CLS, "mb-1 w-full font-mono text-xs")}
          />
          <p className="mb-3 text-[11px] text-ink-subtle">{t("mcp.urlHint")}</p>

          <label className="mb-1 block text-[11px] font-medium text-ink">{t("mcp.headers")}</label>
          <textarea
            value={draft.headersText}
            onChange={(e) => set({ headersText: e.target.value })}
            rows={3}
            spellCheck={false}
            placeholder={"Authorization=Bearer ..."}
            className={cn(FIELD_CLS, "mb-1 w-full font-mono text-[11px]")}
          />
          <p className="mb-3 text-[11px] text-ink-subtle">{t("mcp.headersHint")}</p>
        </>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-muted"
        >
          {t("mcp.cancel")}
        </button>
        <button type="button" disabled={busy} onClick={onSave} className={PRIMARY_BTN}>
          {t("mcp.save")}
        </button>
      </div>
    </div>
  );
}
