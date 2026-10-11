/**
 * web_search / fetch_url and the headless HTTP / HTML helpers behind them. Split out of aiToolkit.mjs, whose
 * handler table spreads `webHandlers` in; httpGet is shared with attachment downloads and throwIfAborted with
 * page_console.
 */

// web_search / fetch_url (headless HTTP in the main process; no visible browser).
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WEB_TIMEOUT_MS = 15_000; // per HTTP request
const WEB_SEARCH_MAX = 10; // hard cap on results returned by web_search
const WEB_SEARCH_DEFAULT = 6; // default result count
const WEB_FETCH_MAX_CHARS = 8_000; // fetch_url readable-text cap

// ── Web search / fetch (headless HTTP; no visible browser) ─────────────────────
// These give the model a built-in way to look things up and read pages WITHOUT opening the
// in-app browser panel each time. They run in the main process (Node), so they are not subject
// to the renderer's CORS restrictions. web_search scrapes Bing's HTML result page (keyless; Bing is
// reachable in both mainland China and internationally); fetch_url downloads a single URL and strips
// HTML to readable text.

/** GET a URL with a browser-like UA and a hard timeout. Returns the Response (throws on error/timeout). */
/**
 * Stop, checked at a point where continuing would be work the user has already abandoned.
 *
 * Thrown rather than returned: `runTool` turns a throw into `{ ok: false }` and the loop is already checking the
 * signal, so a handler that aborts needs no special contract of its own. The message is what the model reads, so it
 * says who stopped it — a tool that merely says "aborted" reads as a fault the model should work around.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("The user stopped this operation.");
}

/**
 * One GET, bounded by the request timeout AND by the caller's Stop.
 *
 * The two used to be separate: the timeout aborted the fetch, and the user's Stop was not passed in at all, so a
 * search or a page fetch ran to completion after the user had already given up on it (docs/agent-runtime-crash-recovery.md
 * C6). Composed with `AbortSignal.any`, whichever fires first aborts the socket — which is the point of §15 of the
 * runtime spec: a timeout must trigger real cancellation rather than merely returning a timeout error.
 */
export async function httpGet(url, { accept, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS);
  // AbortSignal.any is Node 20+/Electron; the fallback keeps the timeout working if it is ever absent.
  const composed =
    signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, ctrl.signal]) : (signal ?? ctrl.signal);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: composed,
      headers: {
        "User-Agent": WEB_UA,
        "Accept-Language": "en-US,en;q=0.9",
        ...(accept ? { Accept: accept } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Named HTML entities commonly seen in search snippets / page text (beyond the numeric forms). */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ensp: " ", emsp: " ", thinsp: " ", middot: "·", bull: "•", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
};

/** Decode the HTML entities that appear in titles / snippets / page text (numeric + common named). */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePointOr(parseInt(h, 16), _))
    .replace(/&#(\d+);/g, (_, d) => codePointOr(parseInt(d, 10), _))
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m,
    );
}
function codePointOr(cp, fallback) {
  try {
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : fallback;
  } catch {
    return fallback;
  }
}

/** Strip HTML → collapsed readable plain text (drops script/style, keeps rough block breaks). */
function htmlToText(html) {
  const stripped = String(html)
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bing result href → the real destination URL. Most organic results are direct links; some are
 *  wrapped in a /ck/a redirect whose `u` param is `a1` + base64url(url). Returns null for a Bing
 *  redirect we can't decode (so the caller skips it) rather than surfacing a tracker URL. */
function unwrapBingUrl(href) {
  try {
    const u = new URL(href, "https://www.bing.com");
    if (/(^|\.)bing\.com$/i.test(u.hostname) && /\/ck\/a/i.test(u.pathname)) {
      const raw = u.searchParams.get("u") || "";
      const b64 = raw.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
      if (b64) {
        const dec = Buffer.from(b64, "base64").toString("utf8");
        if (/^https?:\/\//i.test(dec)) return dec;
      }
      return null; // undecodable Bing redirect → drop it
    }
    return u.href;
  } catch {
    return href;
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────
export const webHandlers = {
  /**
   * Web search (built-in, headless): query Bing's HTML endpoint and return the top ranked results
   * as text (title, URL, snippet) — no visible browser, no API key. Bing is chosen because it is
   * reachable both internationally and inside mainland China (unlike Google / DuckDuckGo), so the
   * same code works for both app editions. The model uses this as its primary way to look things
   * up; it can then fetch_url a result to read it in full.
   */
  async web_search({ query, count } = {}, { signal } = {}) {
    const q = String(query ?? "").trim();
    if (!q) throw new Error("query must not be empty");
    const want = Math.max(1, Math.min(WEB_SEARCH_MAX, Number(count) || WEB_SEARCH_DEFAULT));

    const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20`;
    throwIfAborted(signal);
    const res = await httpGet(endpoint, { accept: "text/html", signal });
    if (!res.ok) throw new Error(`search backend returned HTTP ${res.status}`);
    const html = await res.text();

    // Each organic result is an <li class="b_algo"> block: title + href in <h2><a href>, snippet
    // in the block's caption <p>. Split on the block marker, then extract per block.
    const results = [];
    const seen = new Set();
    for (const block of html.split(/<li class="b_algo"/).slice(1)) {
      if (results.length >= want) break;
      const hm = block.match(/<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!hm) continue;
      const url = unwrapBingUrl(decodeEntities(hm[1]));
      const title = htmlToText(hm[2]);
      if (!title || !url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const sm =
        block.match(/<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
        block.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = sm ? htmlToText(sm[1]) : "";
      results.push({ title, url, snippet });
    }

    if (results.length === 0) {
      return (
        `No web results found for "${q}". The search page may have changed or the query returned ` +
        `nothing — try rephrasing with more distinctive keywords, or use openBrowser to search visually.`
      );
    }

    const lines = results.map(
      (r, n) => `${n + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
    );
    return (
      `Web search results for "${q}" (top ${results.length}):\n\n${lines.join("\n\n")}\n\n` +
      `Next: call fetch_url on the most relevant URL to read its full content, then answer and cite the source. ` +
      `Use openBrowser only if the user needs to see the page or it requires interaction.`
    );
  },

  /**
   * Fetch a single URL (headless) and return its main readable text. HTML is stripped to text;
   * JSON / plain text is returned as-is. Does not run JavaScript and cannot log in / interact —
   * for that the model should use openBrowser + browser instead.
   */
  async fetch_url({ url } = {}, { signal } = {}) {
    const target = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(target)) throw new Error("url must be an absolute http(s) URL");

    throwIfAborted(signal);
    const res = await httpGet(target, {
      signal,
      accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
    });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const raw = await res.text();
    const finalUrl = res.url || target;

    let body;
    if (ctype.includes("html") || /^\s*<(?:!doctype|html)\b/i.test(raw)) {
      const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleM ? htmlToText(titleM[1]) : "";
      body = (title ? `# ${title}\n\n` : "") + htmlToText(raw);
    } else {
      body = raw; // JSON / plain text / other textual content
    }
    body = body.trim();
    const truncated = body.length > WEB_FETCH_MAX_CHARS;
    if (truncated) body = body.slice(0, WEB_FETCH_MAX_CHARS);

    const statusNote = res.ok ? "" : ` (HTTP ${res.status})`;
    const typeNote = ctype ? ` [${ctype.split(";")[0]}]` : "";
    return (
      `Fetched ${finalUrl}${statusNote}${typeNote}:\n\n${body || "(empty response body)"}` +
      (truncated ? `\n\n… (content truncated at ${WEB_FETCH_MAX_CHARS} characters)` : "")
    );
  },
};
