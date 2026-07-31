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

/** Product website — the non-GitHub way to reach the team (see the feedback page). */
export const WEBSITE_URL = "https://zeraix.com/feedback.html";
