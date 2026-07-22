"use client";

/**
 * Settings page (/agent/settings): converted from a modal into a standalone page, reusing the
 * /agent shell (outside the main left sidebar, this page provides its own secondary left column
 * with "search + section navigation" plus the content on the right).
 *  - Account: account info, privacy mode, sign out;
 *  - General: data storage path (location of the JSON files for conversations / project records, editable in the desktop app only);
 *  - Runtime parameters: tool-call round limit and infinite-loop guard threshold (saved and written to app.config on change).
 *
 * Top search: filters the section navigation by translated title / description; the runtime-parameters section further filters by field.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Archive,
  Boxes,
  Brain,
  Database,
  Download,
  FileCog,
  FolderOpen,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  Upload,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  User,
  Volume2,
  Play,
  Info,
  Github,
  ExternalLink,
  Loader2,
  CheckCircle2,
  Activity,
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useLoginModalStore } from "@/store/loginModalStore";
import { clearAuthCookie } from "@/lib/actions/auth.actions";
import { Toast } from "@/lib/toast";
import {
  OFFICIAL_PROVIDER_ID,
  PROVIDERS,
  addCustomModel,
  addOfficialModel,
  addOfficialModelFromCatalog,
  apiFormatSuffix,
  apiKeyRefOf,
  getApiKeyByRef,
  getSelectedModelId,
  loadModelList,
  removeModel,
  setApiKeyByRef,
  setPlatformApiKey,
  setSelectedModelId,
  type AgentModel,
} from "@/lib/ai/models";
import {
  getApiKey,
  isOpenAIError,
  listModels,
  regenerateApiKey,
  type ApiKeyInfo,
  type Model,
} from "@/lib/api/agent";
import {
  chooseStorePath,
  getStorePath,
  isFileStoreAvailable,
  setStorePath,
} from "@/lib/ai/conversation";
import { isAppConfigAvailable, openAppConfigFile, saveOfficialApiKeyToConfig } from "@/lib/ai/appConfig";
import {
  getBackgroundState,
  setBackgroundEnabled,
  setBackgroundOpenAtLogin,
  type BackgroundState,
} from "@/lib/background";
import {
  defaultSoundFor,
  getNotifySoundConfig,
  setNotifySoundConfig,
  updateTypeSound,
  playNotifySound,
  type NotifyType,
  type NotifySoundConfig,
} from "@/lib/ai/notifySound";
import { isNotificationAvailable } from "@/lib/electron/notification";
import {
  getNotifyPrefs,
  updateNotifyPrefs,
  type NotifyPrefs,
  type ReplyCompleteMode,
} from "@/lib/ai/notifyPrefs";
import {
  isMemoryFilesAvailable,
  listMemoryFiles,
  saveMemoryFile,
  deleteMemoryFile,
  openMemoryDir,
  importMemories,
  downloadTemplate,
  exportMemories,
  type MemoryFile,
} from "@/lib/ai/memoryFiles";
import { useAgentChatStore } from "@/store/agentChatStore";
import { updaterBridge, errorKey, type UpdaterState } from "@/lib/updater";
import { APP_NAME, APP_VERSION, GITHUB_URL } from "@/constants/App";
import { useT, type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type SectionId = "account" | "models" | "keys" | "memory" | "general" | "notify" | "about";
const NAV: { id: SectionId; labelKey: string; icon: typeof User }[] = [
  { id: "account", labelKey: "settings.account", icon: User },
  { id: "models", labelKey: "settings.models", icon: Boxes },
  { id: "keys", labelKey: "settings.keys", icon: KeyRound },
  { id: "memory", labelKey: "settings.memory", icon: Brain },
  { id: "notify", labelKey: "settings.notify", icon: Volume2 },
  { id: "general", labelKey: "settings.general", icon: SlidersHorizontal },
  { id: "about", labelKey: "settings.about", icon: Info },
];

/** The i18n keys each section contributes to search (title + description + fields), matched by substring after translation. */
const SECTION_KEYS: Record<SectionId, string[]> = {
  account: [
    "settings.account",
    "account.info",
    "account.manage",
    "account.privacy",
    "account.privacyDesc",
    "account.logout",
    "account.upgrade",
    "account.upgradeDesc",
    "plan.free",
  ],
  models: [
    "settings.models",
    "models.desc",
    "models.added",
    "models.addOfficial",
    "models.addCustom",
    "models.provider",
    "models.model",
    "models.default",
    "models.empty",
    "models.apiFormat",
    "models.apiFormatOpenAI",
    "models.apiFormatResponses",
    "models.customUrl",
    "models.fullUrl",
    "models.modelId",
    "models.multimodal",
    "models.apiKey",
    "models.official",
    "models.officialNote",
  ],
  keys: [
    "settings.keys",
    "keys.desc",
    "keys.empty",
    "keys.forProvider",
    "keys.placeholder",
    "keys.official",
    "keys.officialDesc",
    "keys.localTitle",
    "keys.generate",
    "keys.regenerate",
  ],
  memory: [
    "settings.memory",
    "memory.desc",
    "memory.items",
    "memory.empty",
    "memory.openDir",
    "memory.create",
    "memory.import",
    "memory.template",
    "memory.export",
  ],
  general: [
    "settings.general",
    "general.storage",
    "general.storageDesc",
    "general.migrateNote",
    "general.appConfig",
    "general.appConfigDesc",
    "general.appConfigOpen",
    "general.background",
    "general.backgroundDesc",
    "general.backgroundEnable",
    "general.backgroundAutostart",
  ],
  notify: [
    "settings.notify",
    "notify.desc",
    "notify.roundComplete",
    "notify.roundCompleteDesc",
    "notify.mode.never",
    "notify.mode.unfocused",
    "notify.mode.always",
    "notify.permission",
    "notify.permissionDesc",
    "notify.question",
    "notify.questionDesc",
    "notify.remindersTitle",
    "notify.soundsTitle",
    "notify.master",
    "notify.masterDesc",
    "notify.volume",
    "notify.typeInfo",
    "notify.typeSuccess",
    "notify.typeWarning",
    "notify.typeError",
    "notify.preview",
    "notify.upload",
    "notify.custom",
    "notify.builtin",
    "notify.reset",
    "notify.unsupported",
  ],
  about: [
    "settings.about",
    "about.title",
    "about.desc",
    "about.version",
    "about.updates",
    "about.check",
    "about.upToDate",
    "about.unsupported",
    "about.links",
    "about.github",
    "about.githubDesc",
  ],
};

/** Normalized substring matcher: an empty query always matches. */
function makeMatcher(query: string) {
  const q = query.trim().toLowerCase();
  return (...texts: string[]) => q === "" || texts.some((t) => t.toLowerCase().includes(q));
}

const FIELD_CLS =
  "rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10";
const PRIMARY_BTN =
  "flex shrink-0 items-center gap-1 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50";

export default function AgentSettingsPage() {
  const t = useT();
  const router = useRouter();
  const { userInfo, isLoggedIn, logOut } = useAuthStore();
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const [section, setSection] = useState<SectionId>("account");
  // Deep link /agent/settings?section=local (the chat page's "local model not started" prompt jumps straight to the local models section).
  // Must be read reactively via useSearchParams: when only the query changes on the same route the component is not remounted (App Router soft navigation),
  // so reading window.location during useState initialization would stay on the previous section (appearing to jump to "Account").
  const searchParams = useSearchParams();
  useEffect(() => {
    const s = searchParams?.get("section");
    if (s === "local") { router.push("/agent/models"); return; } // Local models have moved to "Model Library"; redirect old links
    if (s && NAV.some((n) => n.id === s)) setSection(s as SectionId);
  }, [searchParams, router]);
  const [query, setQuery] = useState("");

  const name = userInfo?.username || userInfo?.name || "Username";
  const sub = userInfo?.phone || "";

  const matches = makeMatcher(query);
  // Whether a section matches: translate all of that section's searchable keys and match them together.
  const sectionHit = (id: SectionId) => matches(...SECTION_KEYS[id].map((k) => t(k)));
  const visibleNav = NAV.filter((n) => sectionHit(n.id));
  // If the current section is filtered out by search, fall back to the first matching section.
  const effectiveSection: SectionId | null = visibleNav.some((n) => n.id === section)
    ? section
    : (visibleNav[0]?.id ?? null);

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Secondary left column: search + section navigation */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface-muted/40 px-3 py-5">
        {/* The full-screen page has no main sidebar, so provide a back entry here */}
        <div className="mb-3 flex items-center gap-2 px-1">
          <button
            type="button"
            onClick={() => router.back()}
            aria-label={t("settings.back")}
            title={t("settings.back")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition hover:bg-surface hover:text-ink"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-lg font-bold text-ink">{t("settings.title")}</h1>
        </div>

        {/* Search box */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.search")}
            aria-label={t("settings.search")}
            className="w-full rounded-lg border border-line-strong bg-surface py-2 pl-8 pr-2.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10"
          />
        </div>

        <nav className="flex flex-col gap-0.5">
          {visibleNav.map((n) => {
            const Icon = n.icon;
            const active = effectiveSection === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  active ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-muted hover:bg-surface/70",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {t(n.labelKey)}
              </button>
            );
          })}
          {visibleNav.length === 0 && (
            <p className="px-2.5 py-2 text-sm text-ink-subtle">{t("settings.noResults")}</p>
          )}
        </nav>
      </aside>

      {/* Right-side content */}
      <div className="min-w-0 flex-1 overflow-auto px-8 py-7">
        {effectiveSection === "account" ? (
          <AccountSection
            t={t}
            name={name}
            sub={sub}
            isLoggedIn={isLoggedIn}
            // Log out in place: clear the session and stay (guest); no redirect.
            onLogout={() => {
              clearAuthCookie();
              logOut();
            }}
            onSignIn={() => void requireLogin()}
          />
        ) : effectiveSection === "models" ? (
          <ModelsSection t={t} />
        ) : effectiveSection === "keys" ? (
          <KeysSection t={t} />
        ) : effectiveSection === "memory" ? (
          <MemorySection t={t} />
        ) : effectiveSection === "general" ? (
          <GeneralSection t={t} />
        ) : effectiveSection === "notify" ? (
          <NotifySoundSection t={t} />
        ) : effectiveSection === "about" ? (
          <AboutSection t={t} />
        ) : (
          <p className="text-sm text-ink-subtle">{t("settings.noResults")}</p>
        )}
      </div>
    </div>
  );
}

/** Account section: account info + privacy mode + sign out / sign in. */
function AccountSection({
  t,
  name,
  sub,
  isLoggedIn,
  onLogout,
  onSignIn,
}: {
  t: TFunc;
  name: string;
  sub: string;
  isLoggedIn: boolean;
  onLogout: () => void;
  onSignIn: () => void;
}) {
  const [privacy, setPrivacy] = useState(false);
  return (
    <div className="max-w-2xl">
      <h2 className="mb-5 text-xl font-bold text-ink">{t("settings.account")}</h2>

      {/* <p className="mb-2 text-sm font-semibold text-ink">{t("account.info")}</p>
      <div className="mb-6 divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{name}</p>
            {sub && <p className="truncate text-xs text-ink-subtle">{sub}</p>}
          </div>
          <button className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted">
            {t("account.manage")}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("plan.free")}</p>
            <p className="text-xs text-ink-subtle">{t("account.upgradeDesc")}</p>
          </div>
          <button className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted">
            {t("account.upgrade")}
          </button>
        </div>
      </div>

      <p className="mb-2 text-sm font-semibold text-ink">{t("account.privacy")}</p>
      <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/50 px-4 py-3">
        <p className="text-xs text-ink-subtle">{t("account.privacyDesc")}</p>
        <ToggleSwitch on={privacy} onChange={setPrivacy} label={t("account.privacy")} />
      </div> */}

      {isLoggedIn ? (
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-destructive transition hover:bg-surface-muted"
        >
          <LogOut className="size-4" />
          {t("account.logout")}
        </button>
      ) : (
        <button
          onClick={onSignIn}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-surface-muted"
        >
          <LogOut className="size-4" />
          {t("auth.signIn")}
        </button>
      )}
    </div>
  );
}

/** Sentinel value for the "Add model manually" option in the model dropdown (not a real model ID). */
const MANUAL_MODEL = "__manual__";

/** Models section: maintains the list of selectable models (official catalog + custom), one of which can be set as the default (used by the home selector and for sending on the chat page). */
function ModelsSection({ t }: { t: TFunc }) {
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const [list, setList] = useState<AgentModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Official catalog (excludes the custom placeholder and providers with no models).
  const officialProviders = PROVIDERS.filter((p) => !p.custom && p.models.length > 0);
  const [provId, setProvId] = useState(officialProviders[0]?.id ?? "");
  const provModels = officialProviders.find((p) => p.id === provId)?.models ?? [];
  const [modelName, setModelName] = useState(provModels[0] ?? "");
  const [oKey, setOKey] = useState(""); // API key for the selected provider (shared across the same provider)
  // "Add model manually": for new models not yet in the catalog (when the app hasn't been updated in time), the user just fills in the model ID + display name,
  // reusing the provider's endpoint and key. This mode is entered when modelName === MANUAL_MODEL.
  const [manualId, setManualId] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  // Official models (from the platform's GET /v1/models).
  const [officialModels, setOfficialModels] = useState<Model[]>([]);
  const [omState, setOmState] = useState<"loading" | "ready" | "error">("loading");
  const [omError, setOmError] = useState("");
  const [omSelected, setOmSelected] = useState("");
  // Custom model form.
  const [cApiFormat, setCApiFormat] = useState("openai-chat");
  const [cBaseUrl, setCBaseUrl] = useState("");
  const [cFullUrl, setCFullUrl] = useState(false);
  const [cModel, setCModel] = useState("");
  const [cMultimodal, setCMultimodal] = useState(false);
  const [cKey, setCKey] = useState("");

  const refresh = () => {
    setList(loadModelList());
    setSelectedId(getSelectedModelId());
  };
  useEffect(() => {
    setList(loadModelList());
    setSelectedId(getSelectedModelId());
  }, []);

  // Fetch the official model list (requires login + a reachable platform).
  useEffect(() => {
    let alive = true;
    setOmState("loading");
    listModels()
      .then((res) => {
        if (!alive) return;
        if (isOpenAIError(res)) {
          setOmError(res.error.message);
          setOmState("error");
          return;
        }
        const data = res.data ?? [];
        setOfficialModels(data);
        setOmSelected(data[0]?.id ?? "");
        setOmState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setOmError(String(e));
        setOmState("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Adding an official direct-connect model is account-bound: prompt login first.
  const addOfficialFromCatalog = async () => {
    if (!omSelected) return;
    if (!(await requireLogin())) return;
    addOfficialModelFromCatalog(omSelected);
    refresh();
  };

  const onProvChange = (id: string) => {
    setProvId(id);
    const models = officialProviders.find((p) => p.id === id)?.models ?? [];
    // Keep the "Add manually" mode (every provider allows adding models manually); otherwise revert to the provider's first built-in model.
    setModelName((prev) => (prev === MANUAL_MODEL ? MANUAL_MODEL : (models[0] ?? "")));
    setOKey(""); // Clear the input when switching providers (don't repopulate an existing key)
  };
  // Whether this provider already has a key (used to hint: leave blank to keep it, no need to re-enter).
  const hasProviderKey = !!getApiKeyByRef(provId);
  const manualMode = modelName === MANUAL_MODEL;
  const addOfficial = () => {
    // Manual mode: use the entered model ID + display name; otherwise use the built-in model selected in the dropdown.
    const model = manualMode ? manualId.trim() : modelName;
    if (!provId || !model) return;
    if (manualMode && !manualLabel.trim()) return; // Manual add requires a display name
    if (oKey.trim()) setApiKeyByRef(provId, oKey.trim()); // Only overwrite when a new key was entered
    addOfficialModel(provId, model, manualMode ? manualLabel.trim() : undefined);
    setOKey("");
    if (manualMode) {
      setManualId("");
      setManualLabel("");
    }
    refresh();
  };
  const addCustom = () => {
    if (!cBaseUrl.trim() || !cModel.trim()) return;
    addCustomModel({
      baseUrl: cBaseUrl.trim(),
      fullUrl: cFullUrl,
      model: cModel.trim(),
      apiFormat: cApiFormat,
      multimodal: cMultimodal,
      apiKey: cKey,
    });
    setCBaseUrl("");
    setCFullUrl(false);
    setCModel("");
    setCMultimodal(false);
    setCKey("");
    setCApiFormat("openai-chat");
    refresh();
  };
  const setDefault = (id: string) => {
    setSelectedModelId(id);
    setSelectedId(id);
  };
  const providerLabel = (m: AgentModel) =>
    m.custom
      ? t("models.custom")
      : m.providerId === OFFICIAL_PROVIDER_ID
        ? t("models.official")
        : (PROVIDERS.find((p) => p.id === m.providerId)?.label ?? m.providerId);

  return (
    <div className="max-w-2xl">
      <h2 className="mb-2 text-xl font-bold text-ink">{t("settings.models")}</h2>
      <p className="mb-5 text-xs text-ink-subtle">{t("models.desc")}</p>

      {/* Added list (single-select default) */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.added")}</p>
      {list.length === 0 ? (
        <p className="mb-6 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("models.empty")}
        </p>
      ) : (
        <div className="mb-6 divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
          {list.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => setDefault(m.id)}
                title={t("models.default")}
                aria-label={t("models.default")}
                className="shrink-0"
              >
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full border",
                    selectedId === m.id ? "border-primary" : "border-line-strong",
                  )}
                >
                  {selectedId === m.id && <span className="size-2 rounded-full bg-primary" />}
                </span>
              </button>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                  <span className="truncate">{m.label}</span>
                  {m.multimodal && (
                    <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t("models.multimodal")}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-ink-subtle">
                  {providerLabel(m)} · {m.model}
                  {m.custom && m.endpoint ? ` · ${m.endpoint}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setList(removeModel(m.id)); // Update directly with the post-removal list to avoid read-back timing issues
                  setSelectedId(getSelectedModelId());
                }}
                title={t("ctx.delete")}
                aria-label={t("ctx.delete")}
                className="shrink-0 rounded-md p-1.5 text-ink-muted transition hover:bg-surface hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add from the official catalog: official models come from the platform's GET /v1/models and are sent using the "official API key" */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.addOfficial")}</p>
      <div className="mb-6 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        {omState === "loading" ? (
          <p className="text-xs">{t("models.loading")}</p>
        ) : omState === "error" ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("models.officialError")}
            {omError ? ` (${omError})` : ""}
          </p>
        ) : officialModels.length === 0 ? (
          <p className="text-xs">{t("models.officialEmpty")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-xs">
                {t("models.model")}
                <select
                  value={omSelected}
                  onChange={(e) => setOmSelected(e.target.value)}
                  className={cn(FIELD_CLS, "min-w-[200px]")}
                >
                  {officialModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.type && m.type !== "chat" ? ` (${m.type})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={addOfficialFromCatalog} className={cn(PRIMARY_BTN, "h-[34px]")}>
                <Plus className="size-3.5" />
                {t("models.add")}
              </button>
            </div>
            <p className="mt-2 text-[11px]">ⓘ {t("models.officialNote")}</p>
          </>
        )}
      </div>
      {/* Add third-party model */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.addThirdParty")}</p>
      <div className="mb-6 space-y-2.5 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs ">
            {t("models.provider")}
            <select value={provId} onChange={(e) => onProvChange(e.target.value)} className={cn(FIELD_CLS, "min-w-[170px]")}>
              {officialProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs ">
            {t("models.model")}
            <select value={modelName} onChange={(e) => setModelName(e.target.value)} className={cn(FIELD_CLS, "min-w-[170px]")}>
              {provModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {/* Every provider can manually add new models not in the catalog (when the app hasn't been updated in time) */}
              <option value={MANUAL_MODEL}>{t("models.manualOption")}</option>
            </select>
          </label>
        </div>
        {/* Manual add: fill in the model ID + display name; the endpoint and key reuse the provider selected above */}
        {manualMode && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs">
              <span>
                <span className="text-destructive">*</span> {t("models.modelId")}
              </span>
              <input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder={t("models.modelIdPlaceholder")}
                className={cn(FIELD_CLS, "min-w-[170px] font-mono text-xs")}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs">
              <span>
                <span className="text-destructive">*</span> {t("models.displayName")}
              </span>
              <input
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                placeholder={t("models.displayNamePlaceholder")}
                className={cn(FIELD_CLS, "min-w-[170px]")}
              />
            </label>
          </div>
        )}
        {/* This provider's API key (shared across all models of the same provider) */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            {t("models.apiKey")}
            <input
              type="password"
              autoComplete="off"
              value={oKey}
              onChange={(e) => setOKey(e.target.value)}
              placeholder={hasProviderKey ? t("models.apiKeyExists") : t("models.apiKeyPlaceholder")}
              className={cn(FIELD_CLS, "min-w-[220px] font-mono text-xs")}
            />
          </label>
          <button type="button" onClick={addOfficial} className={cn(PRIMARY_BTN, "h-[34px]")}>
            <Plus className="size-3.5" />
            {t("models.add")}
          </button>
        </div>
      </div>

      {/* Add custom model */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("models.addCustom")}</p>
      <div className="space-y-3 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        {/* API format */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink">
            <span className="text-destructive">*</span> {t("models.apiFormat")}
          </label>
          <select value={cApiFormat} onChange={(e) => setCApiFormat(e.target.value)} className={cn(FIELD_CLS, "w-full")}>
            <option value="openai-chat">{t("models.apiFormatOpenAI")}</option>
            <option value="openai-responses">{t("models.apiFormatResponses")}</option>
          </select>
        </div>

        {/* Custom request URL + full-URL toggle */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-ink">
              <span className="text-destructive">*</span> {t("models.customUrl")}
            </label>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
              {t("models.fullUrl")}
              <ToggleSwitch on={cFullUrl} onChange={setCFullUrl} label={t("models.fullUrl")} />
            </span>
          </div>
          <input
            value={cBaseUrl}
            onChange={(e) => setCBaseUrl(e.target.value)}
            placeholder={t("models.customUrlPlaceholder")}
            className={cn(FIELD_CLS, "w-full font-mono text-xs")}
          />
          <p className="mt-1 rounded-md bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-subtle">
            ⓘ{" "}
            {cFullUrl ? (
              t("models.urlHintFull")
            ) : (
              <>
                {t("models.urlHint")}
                <code className="mx-0.5 rounded bg-surface-muted px-1 font-mono text-ink-muted">
                  {apiFormatSuffix(cApiFormat)}
                </code>
              </>
            )}
          </p>
        </div>

        {/* Model ID + multimodal toggle */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-ink">
              <span className="text-destructive">*</span> {t("models.modelId")}
            </label>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
              {t("models.multimodal")}
              <ToggleSwitch on={cMultimodal} onChange={setCMultimodal} label={t("models.multimodal")} />
            </span>
          </div>
          <input
            value={cModel}
            onChange={(e) => setCModel(e.target.value)}
            placeholder={t("models.modelIdPlaceholder")}
            className={cn(FIELD_CLS, "w-full")}
          />
        </div>

        {/* API key */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink">
            <span className="text-destructive">*</span> {t("models.apiKey")}
          </label>
          <input
            type="password"
            autoComplete="off"
            value={cKey}
            onChange={(e) => setCKey(e.target.value)}
            placeholder={t("models.apiKeyPlaceholder")}
            className={cn(FIELD_CLS, "w-full font-mono text-xs")}
          />
        </div>

        <button
          type="button"
          onClick={addCustom}
          disabled={!cBaseUrl.trim() || !cModel.trim()}
          className={cn(PRIMARY_BTN)}
        >
          <Plus className="size-3.5" />
          {t("models.add")}
        </button>
      </div>
    </div>
  );
}

/** Toggle switch (reuses the account section's styling). */
function ToggleSwitch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        // inline-flex + items-center vertically centers the knob; border-0 p-0 resets the browser's default button box model,
        // ensuring w-9 is exact and the knob's translation isn't pushed off by default padding (previously an absolute knob with no left would overflow).
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors",
        on ? "bg-primary" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** API keys section: configure a key for each provider / custom model in the list (shared by both official and custom models). */
function KeysSection({ t }: { t: TFunc }) {
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  // Local provider / custom model keys (excludes official — official is managed by the platform API).
  const [keys, setKeys] = useState<Record<string, string>>({});
  const groups: { ref: string; label: string }[] = [];
  {
    const seen = new Set<string>();
    for (const m of loadModelList()) {
      const ref = apiKeyRefOf(m);
      if (ref === OFFICIAL_PROVIDER_ID || seen.has(ref)) continue;
      seen.add(ref);
      groups.push({
        ref,
        label: m.custom ? m.label : (PROVIDERS.find((p) => p.id === m.providerId)?.label ?? m.providerId),
      });
    }
  }

  useEffect(() => {
    const k: Record<string, string> = {};
    const seen = new Set<string>();
    for (const m of loadModelList()) {
      const ref = apiKeyRefOf(m);
      if (ref === OFFICIAL_PROVIDER_ID || seen.has(ref)) continue;
      seen.add(ref);
      k[ref] = getApiKeyByRef(ref);
    }
    setKeys(k);
  }, []);

  const onChange = (ref: string, v: string) => {
    setKeys((prev) => ({ ...prev, [ref]: v }));
    setApiKeyByRef(ref, v);
  };

  // Official API key (issued by the platform account; getApiKey returns a list; regenerateApiKey creates / rotates it).
  const [official, setOfficial] = useState<ApiKeyInfo[]>([]);
  const [okState, setOkState] = useState<"loading" | "ready" | "error">("loading");
  const [okError, setOkError] = useState("");
  const [okBusy, setOkBusy] = useState(false);

  const loadOfficial = () => {
    setOkState("loading");
    getApiKey()
      .then((res) => {
        if (!res.success) {
          setOkError(res.error || res.message || "");
          setOkState("error");
          return;
        }
        // Handle the backend returning either a single object or a list.
        const raw = res.data as unknown;
        const arr: ApiKeyInfo[] = Array.isArray(raw) ? (raw as ApiKeyInfo[]) : raw ? [raw as ApiKeyInfo] : [];
        setOfficial(arr);
        // Persist the first plaintext key locally (for sending with official models), and explicitly write it to app.config every time.
        const active = arr.find((k) => k.key);
        if (active?.key) {
          setPlatformApiKey(active.key);
          saveOfficialApiKeyToConfig(active.key);
        }
        setOkState("ready");
      })
      .catch((e) => {
        setOkError(String(e));
        setOkState("error");
      });
  };
  useEffect(() => {
    loadOfficial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generating / rotating the official API key is account-bound: prompt login first.
  const regenerate = async () => {
    if (!(await requireLogin())) return;
    setOkBusy(true);
    regenerateApiKey()
      .then((res) => {
        // On successful regeneration: persist locally and explicitly write to app.config.
        if (res.success && res.data?.key) {
          setPlatformApiKey(res.data.key);
          saveOfficialApiKeyToConfig(res.data.key);
          Toast.success(t("keys.regenSuccess"));
        } else {
          Toast.error(t("keys.regenFailed"));
        }
        loadOfficial();
      })
      .catch(() => {
        Toast.error(t("keys.regenFailed"));
      })
      .finally(() => setOkBusy(false));
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-2 text-xl font-bold text-ink">{t("settings.keys")}</h2>
      <p className="mb-5 text-xs text-ink-subtle">{t("keys.desc")}</p>

      {/* Official API key */}
      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-ink">{t("keys.official")}</p>
          <button type="button" onClick={regenerate} disabled={okBusy} className={cn(PRIMARY_BTN, "h-[30px]")}>
            <RotateCcw className="size-3.5" />
            {official.length ? t("keys.regenerate") : t("keys.generate")}
          </button>
        </div>
        <p className="mb-2 text-[11px] text-ink-subtle">{t("keys.officialDesc")}</p>
        {okState === "loading" ? (
          <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
            {t("models.loading")}
          </p>
        ) : okState === "error" ? (
          <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-amber-600 dark:text-amber-400">
            {t("keys.officialError")}
            {okError ? ` (${okError})` : ""}
          </p>
        ) : official.length === 0 ? (
          <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
            {t("keys.officialEmpty")}
          </p>
        ) : (
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
            {official.map((k, i) => (
              <div key={k.id ?? i} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-ink">
                    {k.key ?? `${k.keyPrefix ?? ""}••••••••`}
                  </p>
                  <p className="truncate text-[11px] text-ink-subtle">
                    {t("keys.created")}
                    {fmtDate(k.createdAt) || t("keys.never")} · {t("keys.lastUsed")}
                    {fmtDate(k.lastUsedAt) || t("keys.never")}
                  </p>
                </div>
                {k.key && (
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(k.key ?? "")}
                    className="shrink-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted"
                  >
                    {t("keys.copy")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Provider / custom model keys (saved locally) */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("keys.localTitle")}</p>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("keys.empty")}
        </p>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
          {groups.map((g) => (
            <div key={g.ref} className="px-4 py-3">
              <label className="mb-1.5 block text-sm font-medium text-ink">
                {t("keys.forProvider")} {g.label}
              </label>
              <input
                type="password"
                autoComplete="off"
                value={keys[g.ref] ?? ""}
                onChange={(e) => onChange(g.ref, e.target.value)}
                placeholder={t("keys.placeholder")}
                className={cn(FIELD_CLS, "w-full font-mono text-xs")}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Format an ISO time as a local string; returns "" for empty values. */
function fmtDate(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** Memory section: visually manage the memories the AI writes (one Markdown file per entry) — view / refresh / open directory / delete. */
function MemorySection({ t }: { t: TFunc }) {
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

/** General section: data storage path. */
function GeneralSection({ t }: { t: TFunc }) {
  const reload = useAgentChatStore((s) => s.reload);
  const [path, setPath] = useState("");
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [configurable, setConfigurable] = useState(false);
  const [appConfigOk, setAppConfigOk] = useState(false);
  const [appConfigMsg, setAppConfigMsg] = useState<string | null>(null);
  // Background / tray mode. `null` = desktop bridge absent (web build) -> the whole block is hidden.
  const [bg, setBg] = useState<BackgroundState | null>(null);

  useEffect(() => {
    setConfigurable(isFileStoreAvailable());
    setAppConfigOk(isAppConfigAvailable());
    void getBackgroundState().then(setBg);
    void getStorePath().then((p) => {
      if (p) {
        setPath(p);
        setInput(p);
      }
    });
  }, []);

  const onChanged = async (dir: string) => {
    setPath(dir);
    setInput(dir);
    setMsg(`${t("general.setOk")}${dir}`);
    await reload();
  };
  const apply = async () => {
    const dir = input.trim();
    if (!dir || !configurable) return;
    setMsg(null);
    try {
      const file = await setStorePath(dir);
      if (file) await onChanged(file);
    } catch (e) {
      setMsg(`${t("general.setFail")}${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const browse = async () => {
    if (!configurable) return;
    setMsg(null);
    try {
      const file = await chooseStorePath();
      if (file) await onChanged(file);
    } catch (e) {
      setMsg(`${t("general.chooseFail")}${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const openAppConfig = async () => {
    setAppConfigMsg(null);
    const res = await openAppConfigFile();
    if (!res.ok) setAppConfigMsg(`${t("general.appConfigOpenFail")}${res.error ?? ""}`);
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-5 text-xl font-bold text-ink">{t("settings.general")}</h2>

      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Database className="size-4 text-ink-muted" />
        {t("general.storage")}
      </p>
      {configurable ? (
        <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
          <p className="mb-2 text-xs text-ink-subtle">{t("general.storageDesc")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void apply();
                }
              }}
              placeholder={t("general.dirPlaceholder")}
              className="min-w-[220px] flex-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 font-mono text-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10"
            />
            <button
              onClick={() => void browse()}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
            >
              {t("general.chooseDir")}
            </button>
            <button
              onClick={() => void apply()}
              disabled={!input.trim()}
              className="shrink-0 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {t("general.apply")}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("general.current")}
            <span className="break-all font-mono text-ink-muted">{path || t("general.default")}</span>
            {t("general.migrateNote")}
          </p>
          {msg && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{msg}</p>}
        </div>
      ) : (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("general.unsupported")}
        </p>
      )}

      {/* app.config: open the persisted config file in the system's default editor (desktop app only). */}
      {appConfigOk && (
        <div className="mt-6">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <FileCog className="size-4 text-ink-muted" />
            {t("general.appConfig")}
          </p>
          <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
            <p className="mb-2 text-xs text-ink-subtle">{t("general.appConfigDesc")}</p>
            <button
              onClick={() => void openAppConfig()}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
            >
              {t("general.appConfigOpen")}
            </button>
            {appConfigMsg && (
              <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{appConfigMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* Background / tray mode: desktop only. Scheduled automations cannot fire while the app is
          not running, so this is the setting that makes the automation scheduler useful at all. */}
      {bg && (
        <>
          <p className="mb-2 mt-6 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Activity className="size-4 text-ink-muted" />
            {t("general.background")}
          </p>
          <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
            <p className="mb-3 text-xs text-ink-subtle">{t("general.backgroundDesc")}</p>
            {bg.traySupported ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-ink">{t("general.backgroundEnable")}</p>
                    <p className="text-xs text-ink-subtle">{t("general.backgroundEnableDesc")}</p>
                  </div>
                  <ToggleSwitch
                    on={bg.enabled}
                    label={t("general.backgroundEnable")}
                    onChange={(v) => {
                      // Optimistic: the main process is the source of truth, but disabling background
                      // mode also clears autostart there, so mirror that here to stay consistent.
                      setBg({ ...bg, enabled: v, openAtLogin: v ? bg.openAtLogin : false });
                      // Enabling can still be refused (no system tray) -- reconcile with the result
                      // rather than leaving the toggle showing a state the main process rejected.
                      void setBackgroundEnabled(v).then((actual) => {
                        if (actual !== v) void getBackgroundState().then(setBg);
                      });
                    }}
                  />
                </div>
                <div
                  className={cn(
                    "mt-3 flex items-center justify-between gap-4 border-t border-line pt-3 transition",
                    !bg.enabled && "pointer-events-none opacity-40",
                  )}
                >
                  <div>
                    <p className="text-sm font-medium text-ink">{t("general.backgroundAutostart")}</p>
                    <p className="text-xs text-ink-subtle">{t("general.backgroundAutostartDesc")}</p>
                  </div>
                  <ToggleSwitch
                    on={bg.openAtLogin}
                    label={t("general.backgroundAutostart")}
                    onChange={(v) => {
                      setBg({ ...bg, openAtLogin: v });
                      void setBackgroundOpenAtLogin(v);
                    }}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("general.backgroundUnsupported")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}


/**
 * Notification sounds section: customize the system-notification sound per type (info/success/warning/error).
 * Master switch + volume + per-type toggle / preview / upload custom sound / reset to default. Config is stored locally (localStorage).
 */
const NOTIFY_TYPE_META: {
  type: NotifyType;
  labelKey: string;
  className: string;
}[] = [
  { type: "info", labelKey: "notify.typeInfo", className: "bg-sky-500/15 text-sky-500 border-sky-500/30" },
  { type: "success", labelKey: "notify.typeSuccess", className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
  { type: "warning", labelKey: "notify.typeWarning", className: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  { type: "error", labelKey: "notify.typeError", className: "bg-red-500/15 text-red-500 border-red-500/30" },
];

function NotifySoundSection({ t }: { t: TFunc }) {
  const [cfg, setCfg] = useState<NotifySoundConfig | null>(null);
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const available = isNotificationAvailable();

  useEffect(() => {
    setCfg(getNotifySoundConfig());
    setPrefs(getNotifyPrefs());
  }, []);

  const patchPrefs = (patch: Partial<NotifyPrefs>) => setPrefs(updateNotifyPrefs(patch));

  if (!cfg || !prefs) return null;

  const patchMaster = (patch: Partial<NotifySoundConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setNotifySoundConfig(next);
  };
  const patchType = (type: NotifyType, patch: Partial<NotifySoundConfig["perType"][NotifyType]>) => {
    setCfg(updateTypeSound(type, patch));
  };
  // Upload a custom sound: read it as a data URL and store it in the config (persisted with local settings).
  const onUpload = (type: NotifyType, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") patchType(type, { src: reader.result });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-1 text-xl font-bold text-ink">{t("settings.notify")}</h2>
      <p className="mb-5 text-sm text-ink-subtle">{t("notify.desc")}</p>

      {!available && (
        <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
          {t("notify.unsupported")}
        </p>
      )}

      {/* Notification reminders: round complete / permission / question */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("notify.remindersTitle")}</p>
      <div className="mb-6 divide-y divide-line rounded-xl border border-line">
        {/* Round-complete notification (dropdown: never / only when the app is unfocused / always) */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("notify.roundComplete")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.roundCompleteDesc")}</p>
          </div>
          <select
            value={prefs.replyCompleteMode}
            onChange={(e) => patchPrefs({ replyCompleteMode: e.target.value as ReplyCompleteMode })}
            className={cn(FIELD_CLS, "shrink-0")}
          >
            <option value="never">{t("notify.mode.never")}</option>
            <option value="unfocused">{t("notify.mode.unfocused")}</option>
            <option value="always">{t("notify.mode.always")}</option>
          </select>
        </div>
        {/* Enable permission notifications */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("notify.permission")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.permissionDesc")}</p>
          </div>
          <ToggleSwitch
            on={prefs.permissionEnabled}
            onChange={(v) => patchPrefs({ permissionEnabled: v })}
            label={t("notify.permission")}
          />
        </div>
        {/* Enable question notifications */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("notify.question")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.questionDesc")}</p>
          </div>
          <ToggleSwitch
            on={prefs.questionEnabled}
            onChange={(v) => patchPrefs({ questionEnabled: v })}
            label={t("notify.question")}
          />
        </div>
      </div>

      {/* Notification sounds */}
      <p className="mb-2 text-sm font-semibold text-ink">{t("notify.soundsTitle")}</p>

      {/* Master switch + volume */}
      <div className="mb-6 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-ink">{t("notify.master")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("notify.masterDesc")}</p>
          </div>
          <ToggleSwitch on={cfg.enabled} onChange={(v) => patchMaster({ enabled: v })} label={t("notify.master")} />
        </div>
        <div className={cn("mt-3 flex items-center gap-3", !cfg.enabled && "pointer-events-none opacity-40")}>
          <Volume2 className="size-4 shrink-0 text-ink-muted" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={cfg.volume}
            onChange={(e) => patchMaster({ volume: Number(e.target.value) })}
            className="h-1.5 flex-1 cursor-pointer accent-primary"
            aria-label={t("notify.volume")}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">
            {Math.round(cfg.volume * 100)}%
          </span>
        </div>
      </div>

      {/* Per-type settings */}
      <div className={cn("space-y-2", !cfg.enabled && "pointer-events-none opacity-40")}>
        {NOTIFY_TYPE_META.map(({ type, labelKey, className }) => {
          const ts = cfg.perType[type];
          const isCustom = ts.src !== defaultSoundFor(type);
          return (
            <div key={type} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
              <span className={cn("shrink-0 rounded border px-2 py-0.5 text-xs font-medium", className)}>
                {t(labelKey)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-subtle">
                {isCustom ? t("notify.custom") : t("notify.builtin")}
              </span>

              {/* Preview */}
              <button
                type="button"
                onClick={() => playNotifySound(type)}
                title={t("notify.preview")}
                className="inline-flex size-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
              >
                <Play className="size-3.5" />
              </button>

              {/* Upload custom sound */}
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted">
                <Upload className="size-3" />
                {t("notify.upload")}
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(type, f);
                    e.target.value = "";
                  }}
                />
              </label>

              {/* Reset to default (shown only when customized) */}
              {isCustom && (
                <button
                  type="button"
                  onClick={() => patchType(type, { src: defaultSoundFor(type) })}
                  title={t("notify.reset")}
                  className="inline-flex size-7 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              )}

              {/* Toggle for this type */}
              <ToggleSwitch on={ts.enabled} onChange={(v) => patchType(type, { enabled: v })} label={t(labelKey)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * About section: app identity + update check + repository link.
 *
 * The version comes from the updater bridge (`app.getVersion()` in the packaged app) and falls back to the
 * build-time APP_VERSION in the browser / `next dev`. Unlike the silent background check in UpdateNotifier,
 * a check started here is one the user asked for, so it reports every outcome — including the errors the
 * background flow deliberately swallows (see updateErrorKey there).
 */
function AboutSection({ t }: { t: TFunc }) {
  const [state, setState] = useState<UpdaterState | null>(null);
  // True only between clicking "Check" and the first state transition, so the spinner belongs to *this* check.
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const bridge = updaterBridge();
    if (!bridge) return; // browser / next dev: no updater at all
    const off = bridge.onState((s) => {
      // Merge, don't replace — `supported` describes the environment, and losing it would swap the
      // whole updates block for the "not supported here" note while a download is running.
      setState((prev) => ({ ...prev, ...s }));
      if (s.status !== "checking") setChecking(false);
    });
    let cancelled = false;
    void bridge.getState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const version = state?.currentVersion || APP_VERSION;
  const supported = state?.supported ?? false;
  const status = state?.status ?? "idle";
  const busy = checking || status === "checking";

  const check = async () => {
    const bridge = updaterBridge();
    if (!bridge) return;
    setChecking(true);
    const res = await bridge.check();
    // A rejected check never transitions state, so clear the spinner here as well.
    if (!res.ok) setChecking(false);
  };

  // https URLs are handed to the system browser by the main process (setWindowOpenHandler); in a
  // plain browser this is an ordinary new tab.
  const openGithub = () => window.open(GITHUB_URL, "_blank", "noopener,noreferrer");

  return (
    <div className="max-w-2xl">
      <h2 className="mb-5 text-xl font-bold text-ink">{t("about.title")}</h2>

      {/* Identity */}
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-line bg-surface-muted/50 px-4 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export: plain <img> avoids the optimizer entirely */}
        <img src="/logo.png" alt="" className="size-12 shrink-0 rounded-xl object-contain" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">{APP_NAME}</p>
          <p className="mt-0.5 text-xs text-ink-subtle">{t("about.desc")}</p>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {version ? t("about.version", { version }) : "—"}
          </p>
        </div>
      </div>

      {/* Updates */}
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <RefreshCw className="size-4 text-ink-muted" />
        {t("about.updates")}
      </p>
      <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void check()}
            disabled={!supported || busy}
            className={PRIMARY_BTN}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {busy ? t("about.checking") : t("about.check")}
          </button>

          {/* An update the user can act on: consent to download, then choose when to restart. */}
          {status === "available" && (
            <button onClick={() => void updaterBridge()?.download()} className={PRIMARY_BTN}>
              <Download className="size-3.5" />
              {t("update.action.download")}
            </button>
          )}
          {status === "downloaded" && (
            <button onClick={() => void updaterBridge()?.install()} className={PRIMARY_BTN}>
              <RefreshCw className="size-3.5" />
              {t("update.action.installNow")}
            </button>
          )}
        </div>

        {/* Outcome of the last check. Nothing is shown while idle — there is nothing to report yet. */}
        {!supported ? (
          <p className="mt-2 text-[11px] text-ink-subtle">{t("about.unsupported")}</p>
        ) : status === "not-available" ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" /> {t("about.upToDate")}
          </p>
        ) : status === "available" ? (
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("update.available.body", { version: state?.version ?? "" })}
          </p>
        ) : status === "downloading" ? (
          <div className="mt-2">
            <p className="text-[11px] text-ink-subtle">
              {t("update.downloading.body", { percent: state?.percent ?? 0 })}
            </p>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${Math.max(2, state?.percent ?? 0)}%` }}
              />
            </div>
          </div>
        ) : status === "downloaded" ? (
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("update.ready.body", { version: state?.version ?? "" })} {t("update.later.hint")}
          </p>
        ) : status === "error" ? (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            {t(errorKey(state?.error ?? null))}
          </p>
        ) : null}
      </div>

      {/* Links */}
      <p className="mb-2 mt-6 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <ExternalLink className="size-4 text-ink-muted" />
        {t("about.links")}
      </p>
      <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <Github className="size-4 text-ink-muted" />
              {t("about.github")}
            </p>
            <p className="mt-0.5 break-all text-[11px] text-ink-subtle">{t("about.githubDesc")}</p>
          </div>
          <button
            onClick={openGithub}
            className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
          >
            {t("about.open")}
          </button>
        </div>
      </div>
    </div>
  );
}
