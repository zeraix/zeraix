"use client";

/**
 * Expandable "Browser" panel (multi-tab) on the right of the chat page: each tab is a <webview>.
 * - The user clicks + to open a new tab; in-site results that use target=_blank / window.open open a new
 *   tab (e.g. Baidu) -> after the main process intercepts them it notifies the renderer to create a tab;
 *   same-page navigations (e.g. Google) navigate within the current tab.
 * - The AI operates the "current active tab" via CDP (puppeteer-core, a separate utilityProcess) -- the
 *   active tab's URL is pushed to the automation process so it attaches to the correct webview.
 * - A detected in-site search (trigger) is only logged and no longer auto-expands; expanding is controlled
 *   by the openBrowser tool / manually.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  Terminal,
  X,
} from "lucide-react";
import {
  OPEN_BROWSER_EVENT,
  isAutomationAvailable,
  onAutomationEvent,
  onBrowserBusy,
  onBrowserNewTab,
  registerWebviewActionHandler,
  saveBrowserShot,
  setActiveBrowserUrl,
  startAutomation,
  type AutomationConfig,
  type BrowserAction,
  type BrowserActionResult,
} from "@/lib/automation";
import { isCnEdition } from "@/lib/edition";

/** The panel's default search engine switches by build edition: the international edition uses Google, the China edition uses Baidu (Baidu's search-term parameter is wd). */
const PANEL_CONFIG: AutomationConfig = isCnEdition
  ? {
      startUrl: "https://www.baidu.com/",
      hostMatch: "baidu.com",
      searchPattern: "[?&]wd=",
      queryParam: "wd",
    }
  : {
      startUrl: "https://www.google.com/",
      hostMatch: "google.com",
      searchPattern: "[?&]q=",
      queryParam: "q",
    };

/** Runtime methods of the Electron <webview> (minimal subset). */
type WebviewEl = HTMLElement & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string }>;
};

interface Tab {
  id: string;
  initialUrl: string; // src at creation time (fixed, so a controlled src doesn't repeatedly reload and interrupt navigation)
  url: string; // current address (for display)
  title: string;
}
interface LogEntry {
  id: number;
  text: string;
  kind: "status" | "trigger" | "error";
}

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
// An address that already has a protocol (http(s):// / file:// or any scheme://) or starts with about: is used as-is;
// otherwise it's treated as a bare domain and completed with https://. This avoids wrongly prefixing file:///... with https://.
const normUrl = (u: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith("about:") ? u : `https://${u}`;

/** A single tab's <webview> (isolates each tab's navigation / title events). */
function TabView({
  tab,
  active,
  available,
  registerRef,
  onNav,
  onTitle,
  onReady,
}: {
  tab: Tab;
  active: boolean;
  available: boolean;
  registerRef: (id: string, el: WebviewEl | null) => void;
  onNav: (id: string, url: string) => void;
  onTitle: (id: string, title: string) => void;
  onReady: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !available) return;
    // Imperatively create the <webview>: allowpopups must be set before the element is inserted into the DOM (guest mount),
    // otherwise target=_blank / window.open are blocked outright and setWindowOpenHandler never fires -> clicks do nothing.
    const el = document.createElement("webview") as unknown as WebviewEl & HTMLElement;
    el.setAttribute("allowpopups", "");
    el.setAttribute("src", tab.initialUrl);
    el.style.width = "100%";
    el.style.height = "100%";
    const nav = () => onNav(tab.id, el.getURL());
    const title = (e: Event) => onTitle(tab.id, (e as unknown as { title: string }).title || "");
    const ready = () => onReady();
    el.addEventListener("did-navigate", nav);
    el.addEventListener("did-navigate-in-page", nav);
    el.addEventListener("page-title-updated", title);
    el.addEventListener("dom-ready", ready);
    host.appendChild(el); // insert only after all attributes are set -> the guest mounts with allowpopups
    registerRef(tab.id, el);
    return () => {
      registerRef(tab.id, null);
      el.removeEventListener("did-navigate", nav);
      el.removeEventListener("did-navigate-in-page", nav);
      el.removeEventListener("page-title-updated", title);
      el.removeEventListener("dom-ready", ready);
      el.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cls = active ? "h-full w-full" : "hidden";
  return available ? (
    <div ref={hostRef} className={cls} />
  ) : (
    <iframe src={tab.initialUrl} title={tab.id} className={active ? "h-full w-full border-0" : "hidden"} />
  );
}

export default function BrowserPanel({
  onAddToConversation,
}: {
  onAddToConversation?: (info: { url: string; title: string }) => void;
}) {
  const [available] = useState(() => isAutomationAvailable());
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addr, setAddr] = useState("");
  const [status, setStatus] = useState("idle");
  const [agentControl, setAgentControl] = useState(true);
  const [busy, setBusy] = useState(false); // whether the AI is currently operating the browser
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const webviewRefs = useRef<Map<string, WebviewEl>>(new Map());
  const startedRef = useRef(false);
  const logIdRef = useRef(0);
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;

  const registerRef = useCallback((id: string, el: WebviewEl | null) => {
    if (el) webviewRefs.current.set(id, el);
    else webviewRefs.current.delete(id);
  }, []);
  const activeWv = () => (activeIdRef.current ? webviewRefs.current.get(activeIdRef.current) ?? null : null);

  const addTab = useCallback((rawUrl?: string, activate = true) => {
    const u = rawUrl ? normUrl(rawUrl) : "about:blank";
    const id = uid();
    setTabs((t) => [...t, { id, initialUrl: u, url: u, title: u === "about:blank" ? "New Tab" : u }]);
    if (activate) setActiveId(id);
    return id;
  }, []);

  const closeTab = useCallback((id: string) => {
    const remaining = tabsRef.current.filter((t) => t.id !== id);
    setTabs(remaining);
    setActiveId((cur) => (cur === id ? remaining[remaining.length - 1]?.id ?? null : cur));
    webviewRefs.current.delete(id);
  }, []);

  const navigateActive = useCallback((rawUrl: string) => {
    const u = normUrl(rawUrl);
    setAddr(u);
    const el = activeIdRef.current ? webviewRefs.current.get(activeIdRef.current) : null;
    if (el?.loadURL) void el.loadURL(u).catch(() => {});
    else if (activeIdRef.current) {
      // Browser fallback (iframe): swap initialUrl to trigger a reload
      setTabs((t) => t.map((x) => (x.id === activeIdRef.current ? { ...x, initialUrl: u } : x)));
    }
  }, []);

  // The AI "takes over" the built-in browser: it operates the current active tab directly via the <webview>
  // native API (not through CDP/puppeteer, so there's no "port=9222 not connected" issue). Supports
  // read/links/click/type/navigate/eval/a11y/list/shot.
  const performWebviewAction = useCallback(
    async (action: BrowserAction, params: Record<string, unknown> = {}): Promise<BrowserActionResult> => {
      if (action === "list") {
        const list = tabsRef.current.map((t, i) => `${i + 1}. ${t.title || t.url} — ${t.url}`).join("\n");
        return { ok: true, result: list || "(no open tabs)" };
      }
      const wv = activeWv();
      if (!wv) return { ok: false, error: "There is no active built-in browser tab; use openBrowser to open a page first." };
      const js = (code: string) => wv.executeJavaScript(code, true);
      const s = (v: unknown) => JSON.stringify(String(v ?? ""));
      try {
        switch (action) {
          case "navigate": {
            const url = normUrl(String(params.url ?? ""));
            if (!url) return { ok: false, error: "navigate is missing url" };
            await wv.loadURL(url).catch(() => {});
            return { ok: true, result: `Navigated to ${url}` };
          }
          case "read": {
            const text = String((await js("document.body ? document.body.innerText : ''")) ?? "").slice(0, 12000);
            return { ok: true, result: text || "(the page has no visible text)" };
          }
          case "links": {
            const max = Number(params.max ?? 40) || 40;
            const arr = (await js(
              `Array.from(document.querySelectorAll('a[href]')).slice(0,${max}).map((a,i)=>({i:i+1,text:(a.innerText||'').trim().slice(0,80),href:a.href}))`,
            )) as Array<{ i: number; text: string; href: string }>;
            const out = (arr || []).map((l) => `${l.i}. ${l.text || "(no text)"} — ${l.href}`).join("\n");
            return { ok: true, result: out || "(no links)" };
          }
          case "click": {
            const sel = params.selector ? s(params.selector) : "null";
            const txt = params.text ? s(params.text) : "null";
            const r = await js(
              `(()=>{const q=${sel},t=${txt};let el=q?document.querySelector(q):null;` +
                `if(!el&&t)el=Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button]')).find(e=>((e.innerText||e.value||'').trim()).includes(t))||null;` +
                `if(!el)return 'NOT_FOUND';el.scrollIntoView({block:'center'});el.click();return 'OK';})()`,
            );
            return r === "OK" ? { ok: true, result: "Clicked" } : { ok: false, error: "No matching element found" };
          }
          case "type": {
            const sel = params.selector ? s(params.selector) : "null";
            const text = s(params.text);
            const clear = params.clear ? "true" : "false";
            const submit = params.submit ? "true" : "false";
            const r = await js(
              `(()=>{const q=${sel};let el=q?document.querySelector(q):document.activeElement;` +
                `if(!el)return 'NOT_FOUND';el.focus();if(${clear})el.value='';el.value=(el.value||'')+${text};` +
                `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));` +
                `if(${submit}){const f=el.form;if(f){f.requestSubmit?f.requestSubmit():f.submit();}else el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}return 'OK';})()`,
            );
            return r === "OK" ? { ok: true, result: "Text entered" } : { ok: false, error: "Input field not found" };
          }
          case "eval": {
            const expr = String(params.expr ?? "");
            if (!expr) return { ok: false, error: "eval is missing expr" };
            const val = await js(`(()=>{try{return String(eval(${s(expr)}));}catch(e){return 'ERROR: '+e.message;}})()`);
            return { ok: true, result: String(val ?? "") };
          }
          case "a11y": {
            const outline = await js(
              `Array.from(document.querySelectorAll('h1,h2,h3,a[href],button,input,select,textarea,[role]')).slice(0,120).map(e=>{const r=e.getAttribute('role')||e.tagName.toLowerCase();const n=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').trim().slice(0,60);return r+(n?': '+n:'');}).join('\\n')`,
            );
            return { ok: true, result: String(outline ?? "") || "(none)" };
          }
          case "shot": {
            const img = await wv.capturePage();
            const path = await saveBrowserShot(img.toDataURL());
            return path ? { ok: true, result: `Screenshot saved: ${path}` } : { ok: false, error: "Failed to save screenshot" };
          }
          default:
            return { ok: false, error: `Unsupported action: ${action}` };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  // Register / unregister the webview action handler, which browserAction calls with priority (takes effect once the panel mounts).
  useEffect(() => {
    registerWebviewActionHandler(performWebviewAction);
    return () => registerWebviewActionHandler(null);
  }, [performWebviewAction]);

  const expand = useCallback(() => {
    setOpen(true);
    if (tabsRef.current.length === 0) addTab(PANEL_CONFIG.startUrl);
  }, [addTab]);

  const pushLog = (text: string, kind: LogEntry["kind"]) =>
    setLogs((l) => [...l.slice(-199), { id: ++logIdRef.current, text, kind }]);

  // Automation events -> logs (does not auto-expand).
  useEffect(
    () =>
      onAutomationEvent((msg) => {
        if (msg.type === "status") {
          setStatus(msg.state);
          pushLog(`status: ${msg.state}${msg.url ? ` · ${msg.url}` : ""}`, "status");
        } else if (msg.type === "error") {
          setStatus("error");
          pushLog(`error: ${msg.message}`, "error");
        } else if (msg.type === "trigger") {
          pushLog(`Detected search: ${msg.query || msg.url}`, "trigger");
        }
      }),
    [],
  );

  // AI browser-operation busy state -> drives the bottom "Agent is operating" indicator.
  useEffect(() => onBrowserBusy(setBusy), []);

  // openBrowser tool: expands the panel; with a url it navigates in the current tab, and with no active tab it opens a new one.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const to = (e as CustomEvent<{ url?: string }>).detail?.url?.trim();
      setOpen(true);
      if (!to) {
        if (tabsRef.current.length === 0) addTab(PANEL_CONFIG.startUrl);
        return;
      }
      if (activeIdRef.current && webviewRefs.current.get(activeIdRef.current)) navigateActive(to);
      else addTab(to);
    };
    window.addEventListener(OPEN_BROWSER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BROWSER_EVENT, onOpen);
  }, [addTab, navigateActive]);

  // Open a new in-site tab (the main process notifies after intercepting window.open / target=_blank).
  useEffect(() => onBrowserNewTab(({ url }) => {
    pushLog(`New tab: ${url}`, "trigger");
    setOpen(true);
    addTab(url);
  }), [addTab]);

  // Tab event callbacks.
  const onTabNav = useCallback((id: string, url: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, url } : t)));
  }, []);
  const onTabTitle = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: title || t.title } : t)));
  }, []);
  const onTabReady = useCallback(() => {
    if (available && !startedRef.current) {
      startedRef.current = true;
      void startAutomation(PANEL_CONFIG);
    }
  }, [available]);

  // When the active tab or its address changes -> sync the address bar + push the active URL to the automation process (the AI operates this tab).
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  useEffect(() => {
    setAddr(activeTab?.url ?? "");
    if (activeTab?.url) setActiveBrowserUrl(activeTab.url);
  }, [activeTab?.id, activeTab?.url]);

  const iconBtn =
    "flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground";

  return (
    <>
      {!open && (
        <button
          onClick={expand}
          title="Browser"
          className="absolute right-3 top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-foreground/70 shadow-md transition hover:bg-accent hover:text-foreground"
        >
          <Globe className="size-4" />
        </button>
      )}

      <div
        className={`h-full shrink-0 overflow-hidden border-l border-line bg-surface transition-[width] duration-300 ${
          open ? (maximized ? "w-full" : "w-[62%] min-w-[420px]") : "w-0"
        }`}
      >
        <div className="flex h-full w-full min-w-[420px] flex-col">
          {/* Top bar */}
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Globe className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Browser</span>
            <span className="ml-auto rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {available ? status : "Desktop app required"}
            </span>
            <button onClick={() => setMaximized((m) => !m)} title={maximized ? "Restore" : "Maximize"} className={iconBtn}>
              {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
            <button onClick={() => setOpen(false)} title="Close" className={iconBtn}>
              <X className="size-4" />
            </button>
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-surface-muted/40 px-2 pt-1.5">
            {tabs.map((t) => {
              const isActive = t.id === activeId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveId(t.id)}
                  title={t.url}
                  className={`flex min-w-0 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1 text-xs ${
                    isActive ? "border-line bg-surface text-foreground" : "border-transparent text-muted-foreground hover:bg-surface/60"
                  }`}
                >
                  <Globe className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t.title || "New Tab"}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            <button onClick={() => addTab(PANEL_CONFIG.startUrl)} title="New tab" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground">
              <Plus className="size-4" />
            </button>
          </div>

          {/* Address / navigation bar */}
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
            <button onClick={() => activeWv()?.goBack()} title="Back" className={iconBtn}>
              <ArrowLeft className="size-4" />
            </button>
            <button onClick={() => activeWv()?.goForward()} title="Forward" className={iconBtn}>
              <ArrowRight className="size-4" />
            </button>
            <button onClick={() => activeWv()?.reload()} title="Refresh" className={iconBtn}>
              <RotateCw className="size-4" />
            </button>
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addr.trim() && navigateActive(addr.trim())}
              placeholder="Enter a URL and press Enter to go"
              className="min-w-0 flex-1 rounded-lg border border-line bg-background px-3 py-1 text-xs outline-none focus:border-line-strong"
            />
          </div>

          {/* Each tab's webview (only the active tab is visible; the rest are hidden but keep their state) */}
          <div className="relative min-h-0 flex-1 bg-white">
            {tabs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Click + to open a new tab
              </div>
            ) : (
              tabs.map((t) => (
                <div key={t.id} className={t.id === activeId ? "h-full w-full" : "hidden"}>
                  <TabView
                    tab={t}
                    active={t.id === activeId}
                    available={available}
                    registerRef={registerRef}
                    onNav={onTabNav}
                    onTitle={onTabTitle}
                    onReady={onTabReady}
                  />
                </div>
              ))
            )}

            {/* AI operating: red-blue-green gradient border + glow (a blurred copy underneath bleeds the light), breathing brightness */}
            {busy && (
              <>
                <div className="agent-glow-bloom pointer-events-none absolute inset-0 z-20 animate-pulse" />
                <div className="agent-glow-border pointer-events-none absolute inset-0 z-20 animate-pulse" />
              </>
            )}
          </div>

          {/* Console logs */}
          {showLogs && (
            <div className="h-32 shrink-0 overflow-auto border-t border-line bg-surface-muted/60 px-3 py-2 font-mono text-[11px]">
              {logs.length === 0 ? (
                <p className="text-muted-foreground">No logs yet</p>
              ) : (
                logs.map((l) => (
                  <p
                    key={l.id}
                    className={
                      l.kind === "error" ? "text-destructive" : l.kind === "trigger" ? "text-primary" : "text-muted-foreground"
                    }
                  >
                    {l.text}
                  </p>
                ))
              )}
            </div>
          )}

          {/* Bottom bar */}
          <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs">
            <span
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${
                agentControl && busy ? "bg-emerald-500/15 text-emerald-600" : "bg-surface-muted text-muted-foreground"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${agentControl && busy ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`}
              />
              {!agentControl ? "You are in control" : busy ? "Agent is operating" : "Agent idle"}
            </span>
            <button
              onClick={() => setAgentControl((v) => !v)}
              className="rounded-md border border-line bg-surface px-2 py-1 font-medium text-foreground transition hover:bg-accent"
            >
              {agentControl ? "Take over" : "Return to Agent"}
            </button>
            <button onClick={() => setShowLogs((v) => !v)} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground">
              <Terminal className="size-3.5" />
              Console logs
              {logs.length > 0 && <span className="rounded-full bg-surface-muted px-1.5 text-[10px]">{logs.length}</span>}
            </button>
            {showLogs && logs.length > 0 && (
              <button onClick={() => setLogs([])} className="rounded-md px-2 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground">
                Clear
              </button>
            )}
            <button
              onClick={() => activeTab && onAddToConversation?.({ url: activeTab.url, title: activeTab.title })}
              className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background transition hover:opacity-90"
            >
              Add to conversation
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
