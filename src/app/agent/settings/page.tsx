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
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useLoginModalStore } from "@/store/loginModalStore";
import { clearAuthCookie } from "@/lib/actions/auth.actions";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { TITLE_BAR_HEIGHT_PX } from "@/components/layout/agent/titleBar";
import { type SectionId, NAV, SECTION_KEYS, makeMatcher } from "./components/nav";
import { AccountSection } from "./components/AccountSection";
import { ModelsSection } from "./components/ModelsSection";
import { KeysSection } from "./components/KeysSection";
import { McpSection } from "./components/McpSection";
import { ProjectMemorySection } from "./components/ProjectMemorySection";
import { MemorySection } from "./components/MemorySection";
import { GeneralSection } from "./components/GeneralSection";
import { NotifySoundSection } from "./components/NotifySoundSection";
import { LogsSection } from "./components/LogsSection";
import { AboutSection } from "./components/AboutSection";

/**
 * The top band, drawn per column because this route is registered in AGENT_SELF_TITLED_PATHS
 * and so gets no title bar from the shell. Over the rail it is rail-toned, which is the whole
 * point -- the rail reaches the window's top edge instead of hanging under a full-width strip
 * of content tone. It also carries the window drag region the shell's row used to provide, and
 * leaves macOS's traffic lights somewhere to sit.
 */
function TitleBand() {
  return (
    <div
      className="shrink-0"
      style={
        { height: TITLE_BAR_HEIGHT_PX, WebkitAppRegion: "drag" } as React.CSSProperties
      }
      aria-hidden
    />
  );
}

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
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-4">
        <TitleBand />
        {/* The full-screen page has no main sidebar, so provide a back entry here */}
        <div className="mb-3 mt-6 flex items-center gap-2 px-1">
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
            className="w-full rounded-lg border border-line-strong bg-surface py-2 pl-8 pr-2.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
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
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  active ? "bg-accent font-medium text-ink" : "text-ink-muted hover:bg-accent",
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

      {/* Right-side content. The band sits outside the scroll area so it stays put and keeps
          its drag region while the sections scroll under the window controls. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBand />
        <CustomScrollbar className="min-h-0 flex-1" viewportClassName="px-8 pb-7 pt-7" config={PAGE_SCROLLBAR}>
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
          ) : effectiveSection === "mcp" ? (
            <McpSection t={t} />
          ) : effectiveSection === "memory" ? (
            <div className="max-w-2xl mx-auto">
              <MemorySection t={t} />
              <ProjectMemorySection t={t} />
            </div>
          ) : effectiveSection === "general" ? (
            <GeneralSection t={t} />
          ) : effectiveSection === "notify" ? (
            <NotifySoundSection t={t} />
          ) : effectiveSection === "logs" ? (
            <LogsSection t={t} />
          ) : effectiveSection === "about" ? (
            <AboutSection t={t} />
          ) : (
            <p className="text-sm text-ink-subtle mx-auto">{t("settings.noResults")}</p>
          )}
        </CustomScrollbar>
      </div>
    </div>
  );
}
