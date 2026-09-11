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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useLoginModalStore } from "@/store/loginModalStore";
import { clearAuthCookie } from "@/lib/actions/auth.actions";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { TITLE_BAR_HEIGHT_PX } from "@/components/layout/agent/titleBar";
import { useTrafficLights } from "@/components/layout/agent/WindowControls";
import { type SectionId, NAV, NAV_GROUPS, SECTION_KEYS, makeMatcher, setSettingsHash } from "./components/nav";
import { parseSettingsHash } from "@/lib/deepLink";
import { AccountSection } from "./components/AccountSection";
import { ModelsSection } from "./components/ModelsSection";
import { KeysSection } from "./components/KeysSection";
import { McpSection } from "./components/McpSection";
import { ProjectMemorySection } from "./components/ProjectMemorySection";
import { MemorySection } from "./components/MemorySection";
import { GeneralSection } from "./components/GeneralSection";
import { AppearanceSection } from "./components/AppearanceSection";
import { NotifySoundSection } from "./components/NotifySoundSection";
import { LogsSection } from "./components/LogsSection";
import { AboutSection } from "./components/AboutSection";

/**
 * The content column's top band, needed because this route is registered in AGENT_SELF_TITLED_PATHS
 * and so gets no title bar from the shell. It carries the window drag region the shell's row used
 * to provide and keeps the sections clear of the Windows / Linux window buttons. The rail does not
 * use it: a full band there left the rail's header hanging ~74px down (see the rail's top block).
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

/**
 * The address bar is the state.
 *
 * `/agent/settings#general/background` opens General and scrolls to the background group, and
 * clicking a section writes that hash back — so any pane, and any group inside one, can be linked
 * to from outside the app (a zeraix:// deep link resolves to exactly this form; see lib/deepLink).
 * Subscribing through useSyncExternalStore rather than an effect keeps the hash a *read* of browser
 * state instead of a copy of it that can drift.
 */
function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const getHash = () => (typeof window === "undefined" ? "" : window.location.hash);

/** How long an anchored group stays highlighted after being scrolled to. */
const FLASH_MS = 1400;

export default function AgentSettingsPage() {
  const t = useT();
  const lights = useTrafficLights();
  const router = useRouter();
  const { userInfo, isLoggedIn, logOut } = useAuthStore();
  const requireLogin = useLoginModalStore((s) => s.requireLogin);
  const hash = useSyncExternalStore(subscribeToHash, getHash, () => "");
  const { section: hashSection, anchor } = parseSettingsHash(hash);
  // ?section=… is the older form and still works: the chat page's "local model not started" prompt
  // links to it. Read reactively via useSearchParams — on a soft navigation only the query changes
  // and the component is not remounted, so reading window.location once would go stale.
  const searchParams = useSearchParams();
  const paramSection = searchParams?.get("section") ?? null;
  useEffect(() => {
    // Local models have moved to "Model Library"; redirect old links.
    if (paramSection === "local") router.push("/agent/models");
  }, [paramSection, router]);
  const known = (id: string | null): id is SectionId => !!id && NAV.some((n) => n.id === id);
  const section: SectionId = known(hashSection) ? hashSection : known(paramSection) ? paramSection : "account";
  /** Selecting a section writes the hash, which is what re-renders this page — and leaves a URL
   *  worth copying. It REPLACES the entry rather than pushing one: see setSettingsHash. */
  const selectSection = useCallback((id: SectionId) => {
    setSettingsHash(id);
  }, []);
  /** Leave settings for wherever it was opened from — one step, because switching sections no
   *  longer leaves entries behind. The fallback covers a window whose first page was settings
   *  itself (a deep link into a fresh window), where there is nothing to go back to. */
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/agent");
  }, [router]);
  const [query, setQuery] = useState("");

  const name = userInfo?.username || userInfo?.name || "Username";
  const sub = userInfo?.phone || "";

  // Scroll the addressed group into view once its pane has rendered, and flash it so it is obvious
  // which of a dozen switches the link meant. The attribute is set on the DOM node rather than held
  // in state: it is a transient decoration, and re-rendering the pane to show it would be silly.
  useEffect(() => {
    if (!anchor) return;
    let cancelled = false;
    let flash: ReturnType<typeof setTimeout> | undefined;
    // Some groups only exist once their section has answered the main process (background mode is
    // hidden until getBackgroundState resolves), so a link that arrives first would find nothing to
    // scroll to. Keep looking for a couple of seconds, then give up quietly.
    const deadline = Date.now() + 2500;
    const attempt = () => {
      if (cancelled) return;
      const el = document.getElementById(anchor);
      if (!el) {
        if (Date.now() < deadline) requestAnimationFrame(attempt);
        return;
      }
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.dataset.flash = "";
      flash = setTimeout(() => delete el.dataset.flash, FLASH_MS);
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(flash);
    };
  }, [anchor, section]);

  const matches = makeMatcher(query);
  // Whether a section matches: translate all of that section's searchable keys and match them together.
  const sectionHit = (id: SectionId) => matches(...SECTION_KEYS[id].map((k) => t(k)));
  const visibleNav = NAV.filter((n) => sectionHit(n.id));
  // Search filters the items; a group whose items all dropped out drops its heading with them.
  const visibleGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((n) => sectionHit(n.id)),
  })).filter((g) => g.items.length > 0);
  // If the current section is filtered out by search, fall back to the first matching section.
  const effectiveSection: SectionId | null = visibleNav.some((n) => n.id === section)
    ? section
    : (visibleNav[0]?.id ?? null);

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Secondary left column: search + section navigation */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-4">
        {/* Top block, laid out like the main sidebar's (AgentSidebar) so the header lands where its brand row does:
            24px from the window's top edge, not under a whole title-bar band. On macOS Electron the native traffic
            lights sit in that corner here (unmounting the main sidebar restores them), so the header drops below them
            by the same 12px row + 16px gap the sidebar keeps for its own lights. `active`, not `show`: a browser draws
            no lights on this page, so it reserves nothing. The block is the rail's drag region; the back button opts out.
            The full-screen page has no main sidebar, so the back entry lives here. */}
        <div
          className={cn("mb-3 flex shrink-0 items-center gap-2 px-1 pt-6", lights.active && "pt-[52px]")}
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <button
            type="button"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onClick={goBack}
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

        {/* Grouped nav. The headings are labels, not controls: a group is a place to look, and
            collapsing one would only hide the section someone is hunting for. */}
        <nav className="flex flex-col gap-3">
          {visibleGroups.map((g) => (
            <div key={g.labelKey} className="flex flex-col gap-0.5">
              <h2 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                {t(g.labelKey)}
              </h2>
              {g.items.map((n) => {
                const Icon = n.icon;
                const active = effectiveSection === n.id;
                return (
                  <button
                    key={n.id}
                    onClick={() => selectSection(n.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      active ? "skin-nav-active bg-accent font-medium text-ink" : "text-ink-muted hover:bg-accent",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {t(n.labelKey)}
                  </button>
                );
              })}
            </div>
          ))}
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
            // One pane, two groups: the project's memory file belongs under the same heading.
            <MemorySection t={t}>
              <ProjectMemorySection t={t} />
            </MemorySection>
          ) : effectiveSection === "general" ? (
            <GeneralSection t={t} />
          ) : effectiveSection === "appearance" ? (
            <AppearanceSection t={t} />
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
