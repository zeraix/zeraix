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
import { type SectionId, NAV, SECTION_KEYS, makeMatcher } from "./components/nav";
import { AccountSection } from "./components/AccountSection";
import { ModelsSection } from "./components/ModelsSection";
import { KeysSection } from "./components/KeysSection";
import { ProjectMemorySection } from "./components/ProjectMemorySection";
import { MemorySection } from "./components/MemorySection";
import { GeneralSection } from "./components/GeneralSection";
import { NotifySoundSection } from "./components/NotifySoundSection";
import { AboutSection } from "./components/AboutSection";

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
          <div className="max-w-2xl">
            <MemorySection t={t} />
            <ProjectMemorySection t={t} />
          </div>
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
