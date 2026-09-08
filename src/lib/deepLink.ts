/**
 * Where a `zeraix://…` link lands in the app.
 *
 * The main process already parses the URL and hands the renderer `{ host, pathname, params }`
 * (electron/services/deepLink.mjs → main.mjs). This module is the other half: it decides which
 * in-app route that describes, and nothing else — no navigation, no window access — so the mapping
 * can be tested on its own (test/deep-link.test.mjs).
 *
 * The settings pane is addressable down to a single group:
 *
 *   zeraix://settings                      → /agent/settings
 *   zeraix://settings/general              → /agent/settings#general
 *   zeraix://settings/general/background   → /agent/settings#general/background
 *
 * Anything that is not a route we recognise resolves to null and is ignored. That matters: a deep
 * link is an *external* input — any process on the machine can fire one at us — so this is an
 * allow-list of destinations, never a general "navigate to whatever the URL says".
 */

/** What the main process sends on the `deep-link` channel. */
export interface DeepLinkInfo {
  url?: string;
  host?: string;
  pathname?: string;
  params?: Record<string, string>;
}

/** /agent routes a link may open. Anything outside this list is not reachable by deep link. */
const AGENT_ROUTES = [
  "chat",
  "settings",
  "plugins",
  "models",
  "skills",
  "library",
  "wallet",
  "automation",
  "help",
] as const;

/** One path segment, conservatively: no dots, no slashes, no escapes to another route. */
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;

function segments(pathname: string | undefined): string[] {
  return (pathname ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The in-app path a deep link describes, or null when it addresses nothing we route.
 *
 * `zeraix://open?path=/agent/…` is the escape hatch for links to a route this list does not name
 * yet; it is still confined to /agent, because the point of the allow-list is that a link cannot
 * reach an arbitrary URL.
 */
export function resolveDeepLink(info: DeepLinkInfo | null | undefined): string | null {
  if (!info) return null;
  const host = (info.host ?? "").toLowerCase();
  const params = info.params ?? {};

  if (host === "open") {
    const path = params.path ?? "";
    // Same-origin, /agent only, and no protocol-relative "//evil.example" smuggled in.
    if (!path.startsWith("/agent") || path.startsWith("//")) return null;
    return path;
  }

  if (!(AGENT_ROUTES as readonly string[]).includes(host)) return null;
  const route = `/agent/${host}`;
  const rest = segments(info.pathname);

  if (host === "settings") {
    // A section may come from the path (zeraix://settings/models) or the query
    // (zeraix://settings?section=models); the path wins when both are given.
    const fromPath = rest.filter((s) => SEGMENT.test(s));
    const parts = fromPath.length > 0 ? fromPath : segments(params.section).filter((s) => SEGMENT.test(s));
    if (parts.length === 0) return route;
    return `${route}#${parts.slice(0, 2).join("/")}`;
  }

  return route;
}

/** What `#…` on the settings page means: a section, and optionally one group inside it. */
export function parseSettingsHash(hash: string | null | undefined): {
  section: string | null;
  anchor: string | null;
} {
  let raw = (hash ?? "").replace(/^#/, "").trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* A malformed escape is not a section name; fall through with the raw text. */
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0 || !SEGMENT.test(parts[0])) return { section: null, anchor: null };
  const section = parts[0];
  // Group ids are namespaced by their section ("general/background"), so an anchor is only an
  // anchor when the section owns it.
  const anchor = parts.length > 1 && SEGMENT.test(parts[1]) ? `${section}/${parts[1]}` : null;
  return { section, anchor };
}
