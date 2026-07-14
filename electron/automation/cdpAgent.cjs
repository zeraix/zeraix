/**
 * <webview> automation agent (runs in a dedicated utilityProcess, isolated from the main / renderer threads).
 *
 * Connects to Electron via the CDP remote-debugging port using puppeteer-core, and attaches to the page target
 * of the built-in <webview> (identified by type==="webview", kept across navigations). It both passively watches
 * search navigations and reports trigger events back, and accepts action commands sent down from the renderer
 * (via the main process) to perform read / list-links / click / type / navigate on the page, sending the results
 * back -- i.e. the AI "takes over" the browser via CDP.
 *
 * Communication with the main process: process.parentPort (the utilityProcess message channel).
 */
// puppeteer-core is ESM-only (package "type":"module"), so require() cannot be used -- lazy-load it via dynamic import.
let puppeteer = null;
async function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  const mod = await import("puppeteer-core");
  puppeteer = mod.default ?? mod;
  return puppeteer;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => {
  try {
    process.parentPort.postMessage(msg);
  } catch {
    /* ignore when the channel is not ready */
  }
};

let browser = null;
let config = null;
let port = 0;
let stopped = false;
let connecting = false;
let lastError = "";
let attachedPage = null; // the attached webview page (puppeteer Page)
let attachedTargetId = null;
let lastTrigger = "";
let activeUrl = ""; // current active-tab URL reported by the renderer (used to locate the active webview when there are multiple tabs)

process.parentPort.on("message", (e) => {
  const msg = e?.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "start") void start(msg.config);
  else if (msg.type === "stop") void stop();
  else if (msg.type === "action") void handleAction(msg);
  else if (msg.type === "active-url") {
    const u = String(msg.url || "");
    if (u && u !== activeUrl) {
      activeUrl = u;
      // active tab changed -> re-attach to the new active page.
      attachedPage = null;
      attachedTargetId = null;
      void attachAndWatch();
    }
  }
});

async function connectWithRetry(p, tries = 20) {
  let err;
  for (let i = 0; i < tries; i++) {
    if (stopped) throw new Error("stopped");
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${p}`, defaultViewport: null });
    } catch (e) {
      err = e;
      await delay(500);
    }
  }
  throw new Error(`Cannot connect to CDP port ${p}: ${String(err?.message || err)}`);
}

/** Idempotent connect: used by both start and action; (re)connects on demand when there is no connection. */
async function ensureConnected() {
  if (browser) return browser;
  if (!port) {
    lastError = "Not started yet (start was not called / port is missing)";
    return null;
  }
  if (connecting) {
    for (let i = 0; i < 40 && connecting; i++) await delay(300);
    return browser;
  }
  connecting = true;
  send({ type: "status", state: "connecting" });
  try {
    await loadPuppeteer();
    browser = await connectWithRetry(port);
    lastError = "";
    send({ type: "status", state: "connected" });
    browser.on("targetcreated", () => void attachAndWatch());
    browser.on("targetchanged", () => void attachAndWatch());
  } catch (err) {
    lastError = String(err?.message || err);
    send({ type: "error", message: lastError });
  } finally {
    connecting = false;
  }
  return browser;
}

async function start(cfg) {
  if (!cfg) return;
  config = cfg;
  port = cfg.port || port;
  stopped = false;
  attachedPage = null;
  attachedTargetId = null;
  lastTrigger = "";
  const b = await ensureConnected();
  if (!b) return;
  for (let i = 0; i < 30 && !stopped && !attachedPage; i++) {
    await attachAndWatch();
    if (attachedPage) break;
    await delay(500);
  }
}

/** Whether the URL is the app's own shell / debug page (to be excluded; the remaining page is the built-in <webview>). */
function isAppShell(u) {
  return (
    !u ||
    u === "about:blank" ||
    u.startsWith("devtools://") ||
    u.startsWith("chrome://") ||
    u.startsWith("app://") ||
    u.includes("localhost:3000")
  );
}

/** Find the <webview> to operate on: with multiple tabs, prefer the one matching the active-tab URL; otherwise take the first webview / non-shell page. */
function findWebviewTarget() {
  const webviews = browser.targets().filter((x) => x.type() === "webview");
  if (webviews.length > 1 && activeUrl) {
    const exact = webviews.find((x) => x.url() === activeUrl);
    if (exact) return exact;
    const incl = webviews.find((x) => {
      const u = x.url() || "";
      return u && (activeUrl.includes(u) || u.includes(activeUrl));
    });
    if (incl) return incl;
  }
  if (webviews.length) return webviews[0];
  return browser.targets().find((x) => x.type() === "page" && !isAppShell(x.url() || "")) || null;
}

async function attachAndWatch() {
  if (stopped || !browser) return;
  const target = findWebviewTarget();
  if (!target) return;

  const tid = `${target.type()}:${target.url()}`;
  if (tid === attachedTargetId && attachedPage) return;

  let page;
  try {
    page = await target.page();
  } catch {
    return;
  }
  if (!page) return;
  attachedPage = page;
  attachedTargetId = tid;
  send({ type: "status", state: "attached", url: page.url() });

  const re = config && config.searchPattern ? new RegExp(config.searchPattern) : null;
  const fire = (url, source) => {
    if (stopped || !re || !re.test(url) || url === lastTrigger) return;
    lastTrigger = url;
    let query = "";
    try {
      query = new URL(url).searchParams.get((config && config.queryParam) || "q") || "";
    } catch {
      /* non-standard URL */
    }
    send({ type: "trigger", url, query, source });
  };
  // Only listen to main-frame navigations to detect searches -- not every network request (avoids a flood of Network events slowing the page down).
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) fire(frame.url(), "navigate");
  });
  fire(page.url(), "initial");
}

/** Ensure a page is attached (waits for the webview to appear if necessary). */
async function getPage() {
  for (let i = 0; i < 20 && !attachedPage && !stopped; i++) {
    await attachAndWatch();
    if (attachedPage) break;
    await delay(300);
  }
  return attachedPage;
}

/** Execute the page action sent by the AI and report the result back (correlated by id). */
async function handleAction({ id, action, params = {} }) {
  const reply = (ok, result, error) => send({ type: "action-result", id, ok, result, error });
  await ensureConnected(); // reconnect on demand when there is no connection
  const page = await getPage();
  if (!page) {
    const list = browser
      ? browser.targets().map((t) => `${t.type()}|${t.url()}`).join(" ; ") || "(none)"
      : "(not connected)";
    return reply(
      false,
      null,
      `Built-in browser not ready. port=${port || "?"} started=${!!config} connectError=${lastError || "none"} targets=[${list}]`,
    );
  }
  try {
    switch (action) {
      case "navigate": {
        const raw = String(params.url || "").trim();
        if (!raw) return reply(false, null, "navigate is missing url");
        const u = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
        return reply(true, `Navigated to ${page.url()}`);
      }
      case "read": {
        const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
        return reply(true, String(text).replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000));
      }
      case "links": {
        const max = Number(params.max) || 40;
        const links = await page.evaluate((m) => {
          const out = [];
          const seen = new Set();
          document.querySelectorAll("a[href]").forEach((a) => {
            const text = (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ");
            const href = a.href;
            if (!text || !href || href.startsWith("javascript:") || seen.has(href)) return;
            seen.add(href);
            out.push({ i: out.length + 1, text: text.slice(0, 120), href });
          });
          return out.slice(0, m);
        }, max);
        return reply(true, links);
      }
      case "click": {
        if (params.selector) {
          await page.click(String(params.selector));
          return reply(true, `Clicked ${params.selector}`);
        }
        if (params.text) {
          const clicked = await page.evaluate((t) => {
            const els = [...document.querySelectorAll("a, button, [role=button], [role=link]")];
            const el = els.find((e) => ((e.innerText || e.textContent || "").trim()).includes(t));
            if (!el) return null;
            el.click();
            return (el.innerText || el.textContent || "").trim().slice(0, 120);
          }, String(params.text));
          return clicked
            ? reply(true, `Clicked: ${clicked}`)
            : reply(false, null, `No clickable element containing "${params.text}" was found`);
        }
        return reply(false, null, "click requires selector or text");
      }
      case "type": {
        const sel = String(params.selector || "");
        if (!sel) return reply(false, null, "type requires selector");
        if (params.clear) {
          // clear the input first (select all + delete) before typing
          await page.click(sel, { clickCount: 3 }).catch(() => page.click(sel).catch(() => {}));
        } else {
          await page.click(sel).catch(() => {});
        }
        await page.type(sel, String(params.text || ""));
        if (params.submit || params.enter) await page.keyboard.press("Enter");
        return reply(true, `Typed into ${sel}${params.submit || params.enter ? " and submitted with Enter" : ""}`);
      }
      case "eval": {
        const expr = String(params.expr || params.js || "").trim();
        if (!expr) return reply(false, null, "eval is missing expr");
        const val = await page.evaluate(expr); // puppeteer evaluates the string as an expression in the page context
        const s = typeof val === "string" ? val : JSON.stringify(val);
        return reply(true, (s ?? "undefined").slice(0, 4000));
      }
      case "a11y": {
        const opts = { interestingOnly: !params.full };
        if (params.root) {
          const h = await page.$(String(params.root)).catch(() => null);
          if (h) opts.root = h;
        }
        const tree = await page.accessibility.snapshot(opts);
        const s = JSON.stringify(tree);
        // the tree can be large: if too long, truncate to a string before returning to avoid blowing up the context.
        return reply(true, s.length > 6000 ? `${s.slice(0, 6000)}…(truncated)` : tree);
      }
      case "list": {
        const out = browser
          .targets()
          .filter((t) => t.type() === "page" || t.type() === "webview")
          .map((t) => ({ type: t.type(), url: t.url() }));
        return reply(true, out);
      }
      case "shot": {
        const os = require("os");
        const path = require("path");
        const file = String(params.path || "").trim() || path.join(os.tmpdir(), `cdp-shot-${id}.png`);
        await page.screenshot({ path: file, fullPage: !!params.full });
        return reply(true, `Screenshot saved: ${file}`);
      }
      default:
        return reply(false, null, `Unknown action: ${action}`);
    }
  } catch (err) {
    return reply(false, null, String(err?.message || err));
  }
}

async function stop() {
  stopped = true;
  attachedPage = null;
  attachedTargetId = null;
  try {
    if (browser) await browser.disconnect();
  } catch {
    /* ignore */
  }
  browser = null;
  send({ type: "status", state: "stopped" });
}
