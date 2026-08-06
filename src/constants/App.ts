/**
 * Static app identity used by the Settings → About section.
 *
 * `APP_VERSION` is inlined by Next at build time from package.json (see `env` in next.config.ts). Inside
 * the packaged desktop app the authoritative number is `app.getVersion()`, reported by the updater bridge
 * (src/lib/updater.ts) — this constant is the fallback for the browser and for `next dev`, and both come
 * from the same package.json.
 */
export const APP_NAME = "Zeraix";

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

/** Public repository — source, releases and issue tracker; also the auto-update feed (electron-builder.yml). */
export const GITHUB_URL = "https://github.com/zeraix/Zeraix";

/**
 * Plugin registry repository. Separate from GITHUB_URL on purpose: publishing a plugin must not
 * require an app release, so the two repos have independent lifecycles.
 *
 * Every plugin operation lives there — submit by pull request, withdraw by an entry in
 * `killlist.json`, and the commit history is the audit log (docs/plugin-marketplace-design.md §5.1).
 * The app never fetches from it: CI mirrors the built feeds to NEXT_PUBLIC_API_BASE_URL, which is
 * what the client reads (§5.2). This constant is the "where do I submit / what happened" link.
 */
export const REGISTRY_URL = "https://github.com/zeraix/registry";

/**
 * Whether the plugin marketplace is offered in the UI.
 *
 * Off until the registry actually serves something: the feeds are published from
 * github.com/zeraix/registry and mirrored to our API origin, and until that mirror exists there is
 * nothing to browse — a sidebar entry leading to an empty page is a worse first impression than no
 * entry at all.
 *
 * Gating the nav gates the whole subsystem, not just the link: configurePlugins() is only reached
 * from that page, so nothing configures the registry client, no refresh timers start, and the app
 * makes no plugin-related network requests. Flip to true once the publish endpoint is live.
 */
export const PLUGINS_UI_ENABLED = true; // LOCAL ONLY — revert to false before committing

/** Product website — the non-GitHub way to reach the team (see the feedback page). */
export const WEBSITE_URL = "https://zeraix.com/feedback.html";
