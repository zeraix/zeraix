"use client";

/**
 * Skills page (/agent/skills). The "download / manage" hub for skills:
 *   1. Skills marketplace: browse downloadable skills, filter by "audience (developer / regular user)", group by "general / targeted",
 *      the "+" in the top-right of a card downloads, installs, and enables it by default;
 *   2. Installed: toggle enabled state (= whether it enters the chat configuration), uninstall.
 *
 * The catalog comes from src/skills/*.md (see @/lib/ai/skills/catalog). Enabled state is written to shared storage
 * (@/lib/ai/skills/store, dot path agent.skills); /agent/chat reads the skills enabled here,
 * letting the user load_skill on demand during a conversation. All page copy is fully i18n (see the skills.* keys).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileCode2, Loader2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  InstalledSkill,
  Skill,
  SkillAudience,
  SkillManifest,
  SkillScope,
} from "@/lib/ai/skills/types";
import { skillFromMarkdown } from "@/lib/ai/skills/parse";
import { downloadSkill, fetchCatalog } from "@/lib/ai/skills/marketplace";
import {
  installSkill,
  loadInstalled,
  saveUserSkill,
  setSkillEnabled,
  uninstallSkill,
} from "@/lib/ai/skills/store";

/** Brand pink (matches AgentComposer). */
const ACCENT = "#f5327d";
/** Skill upload: Markdown only. */
const MD_ACCEPT = ".md,.markdown,text/markdown";

type Tab = "market" | "installed";
/** Audience filter: all / developer / regular user. */
type AudienceFilter = "all" | SkillAudience;
/** Group display order: general first, then targeted. */
const SCOPES: SkillScope[] = ["general", "targeted"];

/** Compact toggle, used for "enable / disable" on installed cards. */
function ToggleSwitch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={() => onChange(!on)}
      className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
      style={{ backgroundColor: on ? ACCENT : "var(--line-strong)" }}
    >
      <span
        className="absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-all"
        style={{ left: on ? "14px" : "2px" }}
      />
    </button>
  );
}

/** Card shell: code icon on the left + title (name / version) + badge row + two-line description; the action area on the right is a separate flex child
 *  that reserves its own width and never overlaps the content (prevents long names / badges from crowding the toggle, edit, uninstall, etc. buttons).
 *
 *  onOpen makes the whole card activatable (opens the detail dialog). The card stays a <div role="button"> rather than a
 *  real <button>, because it already contains buttons (download / toggle / edit / uninstall) and nesting interactive
 *  elements is invalid HTML and breaks keyboard navigation. The action area stops click propagation so those buttons
 *  keep working without also opening the detail. */
function SkillCard({
  name,
  version,
  description,
  audienceLabel,
  customLabel,
  onOpen,
  openLabel,
  children,
}: {
  name: string;
  version?: string;
  description: string;
  audienceLabel?: string;
  customLabel?: string;
  onOpen?: () => void;
  openLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      {...(onOpen && {
        role: "button",
        tabIndex: 0,
        "aria-label": openLabel,
        onClick: onOpen,
        // Enter / Space activate, matching native button behavior for a role="button" element.
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        },
      })}
      className={`group flex items-start gap-4 rounded-xl border border-line bg-surface p-5 transition hover:border-line-strong hover:shadow-sm ${
        onOpen ? "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2" : ""
      }`}
      style={onOpen ? { outlineColor: ACCENT } : undefined}
    >
      <FileCode2 className="mt-0.5 size-9 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h3 className="truncate text-[15px] font-semibold text-foreground">{name}</h3>
          {version && (
            <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground">
              v{version}
            </span>
          )}
        </div>
        {(customLabel || audienceLabel) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {customLabel && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${ACCENT}1a`, color: ACCENT }}
              >
                {customLabel}
              </span>
            )}
            {audienceLabel && (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {audienceLabel}
              </span>
            )}
          </div>
        )}
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {/* Buttons live inside an activatable card: swallow clicks/keys so acting on a skill never also opens its detail. */}
      <div
        className="shrink-0"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export default function AgentSkillsPage() {
  const t = useT();
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [catalog, setCatalog] = useState<SkillManifest[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // id of the skill currently downloading
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("market");
  const [audience, setAudience] = useState<AudienceFilter>("all");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState<InstalledSkill | null>(null); // the user skill currently being edited
  const [editText, setEditText] = useState(""); // the raw Markdown in the editor
  const [editErr, setEditErr] = useState<string | null>(null);
  // Detail dialog: the skill whose details are open. A marketplace entry is only a manifest (no instructions), so the
  // body is fetched lazily on open; an installed skill already carries them and renders immediately.
  const [detail, setDetail] = useState<SkillManifest | InstalledSkill | null>(null);
  const [detailBody, setDetailBody] = useState<Skill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const detailReq = useRef(0); // increments per open; stale fetches are discarded

  // On mount: restore installed skills + fetch the marketplace catalog.
  useEffect(() => {
    let active = true;
    const run = async () => {
      if (active) setInstalled(loadInstalled());
      setErr(null);
      setLoadingCatalog(true);
      try {
        const cat = await fetchCatalog();
        if (active) setCatalog(cat);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoadingCatalog(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, []);

  const installedIds = useMemo(() => new Set(installed.map((s) => s.id)), [installed]);

  const audienceLabel = (a?: SkillAudience) =>
    a === "dev" ? t("skills.audience.dev") : a === "user" ? t("skills.audience.user") : "";

  // The marketplace catalog after audience filtering.
  const visibleCatalog = useMemo(
    () => (audience === "all" ? catalog : catalog.filter((s) => s.audience === audience)),
    [catalog, audience],
  );

  const onDownload = async (id: string) => {
    setErr(null);
    setBusyId(id);
    try {
      const skill = await downloadSkill(id);
      setInstalled(installSkill(skill)); // downloading installs and enables it by default
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onToggle = (id: string, enabled: boolean) => setInstalled(setSkillEnabled(id, enabled));
  const onRemove = (id: string) => setInstalled(uninstallSkill(id));

  // Upload .md -> parse into a skill -> save as a user skill (enabled by default), and switch to "Installed". Markdown only.
  const onUploadFile = async (file: File) => {
    setErr(null);
    if (!/\.(md|markdown)$/i.test(file.name)) {
      setErr(t("skills.uploadOnlyMd"));
      return;
    }
    try {
      const text = await file.text();
      // Use the file name (extension stripped) as a fallback name: even a file with only a body / only a description can still become a skill.
      const fallbackName = file.name.replace(/\.(md|markdown)$/i, "").trim();
      const skill = skillFromMarkdown(text, fallbackName);
      setInstalled(saveUserSkill(skill, text));
      setTab("installed");
    } catch (e) {
      setErr(`${t("skills.parseFailed")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const onUploadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset, so the same file can be selected again
    if (file) void onUploadFile(file);
  };

  // Edit a user skill: prefill the editor with its raw Markdown.
  const openEdit = (s: InstalledSkill) => {
    setEditErr(null);
    setEditText(s.sourceMarkdown ?? "");
    setEditing(s);
  };
  // Save edits: re-parse the editor text; if the id changed, treat it as a rename (delete old, save new). On parse failure, report inline and don't close.
  const saveEdit = () => {
    setEditErr(null);
    try {
      // Use the edited skill's original name as a fallback name: it can still be saved even if the user deleted the name field.
      const skill = skillFromMarkdown(editText, editing?.name);
      if (editing && skill.id !== editing.id) uninstallSkill(editing.id);
      setInstalled(saveUserSkill(skill, editText));
      setEditing(null);
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Open the detail dialog for a skill. An installed skill already carries its instructions and renders instantly;
   * a marketplace entry is only a manifest, so the full body is fetched. That fetch reads the catalog and does NOT
   * install anything — viewing details is non-destructive, and downloading stays an explicit action.
   * detailReq guards against a slow fetch for a previously-opened skill landing after the user opened another one.
   */
  const openDetail = (s: SkillManifest | InstalledSkill) => {
    const req = ++detailReq.current;
    setDetailErr(null);
    setDetail(s);
    if ("instructions" in s && s.instructions) {
      setDetailBody(s as Skill);
      setDetailLoading(false);
      return;
    }
    setDetailBody(null);
    setDetailLoading(true);
    void downloadSkill(s.id)
      .then((full) => {
        if (detailReq.current === req) setDetailBody(full);
      })
      .catch((e) => {
        if (detailReq.current === req) setDetailErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (detailReq.current === req) setDetailLoading(false);
      });
  };

  const AUDIENCE_FILTERS: { key: AudienceFilter; label: string }[] = [
    { key: "all", label: t("skills.filter.all") },
    { key: "dev", label: t("skills.filter.dev") },
    { key: "user", label: t("skills.filter.user") },
  ];

  /** The top-right action button on a marketplace card (download / downloading / downloaded). */
  const marketAction = (s: SkillManifest) => {
    const has = installedIds.has(s.id);
    const downloading = busyId === s.id;
    return (
      <button
        type="button"
        onClick={() => void onDownload(s.id)}
        disabled={has || downloading}
        aria-label={has ? t("skills.action.installed") : t("skills.action.download")}
        title={
          has
            ? t("skills.action.installed")
            : downloading
              ? t("skills.action.downloading")
              : t("skills.action.download")
        }
        className={`flex size-7 shrink-0 items-center justify-center rounded-lg border transition ${
          has
            ? "border-transparent text-emerald-600"
            : "border-line text-muted-foreground hover:border-line-strong hover:text-foreground"
        }`}
      >
        {downloading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : has ? (
          <Check className="size-4" />
        ) : (
          <Plus className="size-4" />
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-8 py-6">
        <div className="mx-auto flex w-full max-w-6xl items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t("skills.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("skills.subtitle")}</p>
          </div>
          {/* Upload a custom skill (.md only) */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-105"
            style={{ backgroundColor: ACCENT }}
          >
            <Upload className="size-4" />
            {t("skills.upload")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={MD_ACCEPT}
            onChange={onUploadInput}
            className="hidden"
          />
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <div className="mx-auto w-full max-w-6xl">
          {/* Tabs */}
          <div className="mb-5 flex items-center gap-6 border-b border-line">
            <button
              type="button"
              onClick={() => setTab("market")}
              className={`-mb-px border-b-2 pb-2.5 text-base font-bold transition ${
                tab === "market"
                  ? "text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              style={tab === "market" ? { borderColor: ACCENT } : undefined}
            >
              {t("skills.tab.market")}
            </button>
            <button
              type="button"
              onClick={() => setTab("installed")}
              className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2.5 text-base font-bold transition ${
                tab === "installed"
                  ? "text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              style={tab === "installed" ? { borderColor: ACCENT } : undefined}
            >
              {t("skills.tab.installed")}
              {installed.length > 0 && (
                <span
                  className="flex size-5 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ backgroundColor: ACCENT }}
                >
                  {installed.length}
                </span>
              )}
            </button>
          </div>

          {err && (
            <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          )}

          {/* Skills marketplace */}
          {tab === "market" && (
            <>
              {/* Audience filter */}
              <div className="mb-5 flex flex-wrap gap-2">
                {AUDIENCE_FILTERS.map((f) => {
                  const selected = audience === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setAudience(f.key)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                        selected
                          ? "border-line-strong bg-surface-muted text-foreground"
                          : "border-line bg-surface text-muted-foreground hover:bg-surface-muted"
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>

              {loadingCatalog ? (
                <p className="rounded-lg bg-surface-muted px-3 py-3 text-xs text-muted-foreground">
                  {t("skills.loading")}
                </p>
              ) : visibleCatalog.length === 0 ? (
                <p className="rounded-lg bg-surface-muted px-3 py-3 text-xs text-muted-foreground">
                  {t("skills.emptyCategory")}
                </p>
              ) : (
                <div className="flex flex-col gap-7">
                  {SCOPES.map((scope) => {
                    const items = visibleCatalog.filter((s) => (s.scope ?? "general") === scope);
                    if (items.length === 0) return null;
                    return (
                      <section key={scope}>
                        <h2 className="mb-3 text-sm font-semibold text-foreground">
                          {scope === "general"
                            ? t("skills.scope.general")
                            : t("skills.scope.targeted")}
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            {items.length}
                          </span>
                        </h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                          {items.map((s) => (
                            <SkillCard
                              key={s.id}
                              name={s.name}
                              version={s.version}
                              description={s.description}
                              audienceLabel={
                                audience === "all" ? audienceLabel(s.audience) : undefined
                              }
                              onOpen={() => openDetail(s)}
                              openLabel={t("skills.detail.open", { name: s.name })}
                            >
                              {marketAction(s)}
                            </SkillCard>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Installed */}
          {tab === "installed" &&
            (installed.length === 0 ? (
              <p className="rounded-lg bg-surface-muted px-3 py-6 text-center text-sm text-muted-foreground">
                {t("skills.emptyInstalled")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {installed.map((s) => (
                  <SkillCard
                    key={s.id}
                    name={s.name}
                    version={s.version}
                    description={s.description}
                    audienceLabel={audienceLabel(s.audience)}
                    customLabel={s.source === "user" ? t("skills.badge.custom") : undefined}
                    onOpen={() => openDetail(s)}
                    openLabel={t("skills.detail.open", { name: s.name })}
                  >
                    <div className="flex shrink-0 items-center gap-2">
                      <ToggleSwitch
                        on={s.enabled}
                        onChange={(next) => onToggle(s.id, next)}
                        label={s.enabled ? t("skills.action.disable") : t("skills.action.enable")}
                      />
                      {s.source === "user" && (
                        <button
                          type="button"
                          onClick={() => openEdit(s)}
                          aria-label={t("skills.action.edit")}
                          title={t("skills.action.edit")}
                          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground"
                        >
                          <Pencil className="size-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemove(s.id)}
                        aria-label={t("skills.action.uninstall")}
                        title={t("skills.action.uninstall")}
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </SkillCard>
                ))}
              </div>
            ))}
        </div>
      </div>

      {/* Skill details (read-only), opened by clicking a card in either tab. Marketplace entries load their body on open. */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5">
                  <span className="truncate">{detail.name}</span>
                  {detail.version && (
                    <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground">
                      v{detail.version}
                    </span>
                  )}
                </DialogTitle>
                <DialogDescription>{detail.description}</DialogDescription>
              </DialogHeader>

              {/* Metadata row: badges + author. Only rendered when there is something to show. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {"source" in detail && detail.source === "user" && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: `${ACCENT}1a`, color: ACCENT }}
                  >
                    {t("skills.badge.custom")}
                  </span>
                )}
                {audienceLabel(detail.audience) && (
                  <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {audienceLabel(detail.audience)}
                  </span>
                )}
                <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {(detail.scope ?? "general") === "general"
                    ? t("skills.scope.general")
                    : t("skills.scope.targeted")}
                </span>
                {(detail.tags ?? []).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
                {detail.author && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("skills.detail.author")}: {detail.author}
                  </span>
                )}
              </div>

              {(detailBody?.allowedTools ?? []).length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  {t("skills.detail.tools")}:{" "}
                  <span className="font-mono">{detailBody?.allowedTools?.join(", ")}</span>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-xs font-semibold text-foreground">
                  {t("skills.detail.instructions")}
                </p>
                {detailErr ? (
                  <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {detailErr}
                  </div>
                ) : detailLoading ? (
                  <p className="flex items-center gap-1.5 rounded-lg bg-surface-muted px-3 py-3 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("skills.detail.loading")}
                  </p>
                ) : (
                  <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
                    {detailBody?.instructions}
                  </pre>
                )}
              </div>

              <DialogFooter>
                {/* Downloading straight from the detail view: the natural next step after reading what a skill does. */}
                {!installedIds.has(detail.id) && (
                  <button
                    type="button"
                    onClick={() => void onDownload(detail.id)}
                    disabled={busyId === detail.id}
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-60"
                    style={{ backgroundColor: ACCENT }}
                  >
                    {busyId === detail.id
                      ? t("skills.action.downloading")
                      : t("skills.action.download")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDetail(null)}
                  className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
                >
                  {t("skills.close")}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit a user skill: edit its Markdown directly (frontmatter + body), re-parsed on save. */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("skills.editTitle")}</DialogTitle>
            <DialogDescription>{t("skills.editDesc")}</DialogDescription>
          </DialogHeader>
          {editErr && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {t("skills.parseFailed")}: {editErr}
            </div>
          )}
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            spellCheck={false}
            rows={18}
            className="max-h-[55vh] min-h-64 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-line-strong"
          />
          <DialogFooter>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
            >
              {t("skills.cancel")}
            </button>
            <button
              type="button"
              onClick={saveEdit}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-105"
              style={{ backgroundColor: ACCENT }}
            >
              {t("skills.save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
