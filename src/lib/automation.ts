/**
 * Renderer-layer wrapper for <webview> automation: types, default config, and a thin wrapper around window.automation (preload).
 * The actual puppeteer-core / CDP logic runs in a separate utilityProcess forked by the main process (see electron/automation).
 */

/** Automation config (hot-swappable to adapt to different sites). */
export interface AutomationConfig {
  /** The address the <webview> initially loads. */
  startUrl: string;
  /** Attach to the target page whose URL contains this substring (usually the site domain). */
  hostMatch: string;
  /** URL regex (as a string) that identifies a "search", e.g. "[?&]q=". */
  searchPattern: string;
  /** Name of the query parameter to extract from the matched URL as the search term. */
  queryParam?: string;
}

/** Automation events, main process → renderer layer. */
export type AutomationEvent =
  | { type: "status"; state: string; url?: string }
  | { type: "trigger"; url: string; query: string; source: string }
  | { type: "error"; message: string };

/** Page action types and result. */
export type BrowserAction =
  | "read"
  | "links"
  | "click"
  | "type"
  | "navigate"
  | "eval"
  | "a11y"
  | "list"
  | "shot";
export interface BrowserActionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface AutomationBridge {
  start(config: AutomationConfig): Promise<boolean>;
  stop(): Promise<boolean>;
  /** Subscribe to events; returns an unsubscribe function. */
  onEvent(cb: (msg: AutomationEvent) => void): () => void;
  /** Dispatch a page action and wait for the result. */
  action(payload: { action: BrowserAction; params?: Record<string, unknown> }): Promise<BrowserActionResult>;
  /** Subscribe to "in-site request to open a new tab" (the main process notifies after intercepting window.open / target=_blank). */
  onNewTab(cb: (info: { url: string }) => void): () => void;
  /** Tell the automation process the current active tab's URL (so its CDP attaches to the correct webview). */
  setActiveUrl(url: string): Promise<boolean>;
  /** Save a screenshot (data URL) to a temp file; returns the file path. */
  saveShot?(dataUrl: string): Promise<string>;
}

declare global {
  interface Window {
    automation?: AutomationBridge;
  }
}

/** Default config (example: Bing search /search?q=…). To switch sites, change this here or override it on the page. */
export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  startUrl: "https://www.bing.com/",
  hostMatch: "bing.com",
  searchPattern: "[?&]q=",
  queryParam: "q",
};

/** Same-tab event name for "open the built-in browser" (triggered by the openBrowser tool, listened to by BrowserPanel). */
export const OPEN_BROWSER_EVENT = "agent-open-browser";

/** Request to open the built-in browser panel, optionally navigating to a url. */
export const requestOpenBrowser = (url?: string): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_BROWSER_EVENT, { detail: { url: url ?? "" } }));
  }
};

/** Whether running in Electron (automation is only available in the desktop app). */
export const isAutomationAvailable = (): boolean =>
  typeof window !== "undefined" && !!window.automation;

export const startAutomation = (config: AutomationConfig): Promise<boolean> =>
  window.automation?.start(config) ?? Promise.resolve(false);

export const stopAutomation = (): Promise<boolean> =>
  window.automation?.stop() ?? Promise.resolve(false);

export const onAutomationEvent = (cb: (msg: AutomationEvent) => void): (() => void) =>
  window.automation?.onEvent(cb) ?? (() => {});

/**
 * Handler that operates the built-in <webview> directly (registered by BrowserPanel).
 * Preferred path (webview native APIs: executeJavaScript / capturePage), avoiding the issue of CDP/puppeteer failing to connect to the webview.
 */
export type WebviewActionHandler = (
  action: BrowserAction,
  params?: Record<string, unknown>,
) => Promise<BrowserActionResult>;
let webviewHandler: WebviewActionHandler | null = null;
export const registerWebviewActionHandler = (h: WebviewActionHandler | null): void => {
  webviewHandler = h;
};

/** Perform one page action on the built-in browser (AI "takes over" the browser). Prefers webview native APIs, falls back to CDP. */
export const browserAction = (
  action: BrowserAction,
  params?: Record<string, unknown>,
): Promise<BrowserActionResult> => {
  if (webviewHandler) return webviewHandler(action, params);
  return (
    window.automation?.action({ action, params }) ??
    Promise.resolve({ ok: false, error: "Built-in browser unavailable (must be opened in the desktop app)" })
  );
};

/** Subscribe to "in-site request to open a new tab"; returns an unsubscribe function. */
export const onBrowserNewTab = (cb: (info: { url: string }) => void): (() => void) =>
  window.automation?.onNewTab(cb) ?? (() => {});

/** Push the current active tab URL to the automation process (decides which webview CDP operates on). */
export const setActiveBrowserUrl = (url: string): void => {
  void window.automation?.setActiveUrl(url);
};

/** Save a built-in browser screenshot (data URL) to a temp file; returns the path, or an empty string if unavailable. */
export const saveBrowserShot = (dataUrl: string): Promise<string> =>
  window.automation?.saveShot?.(dataUrl) ?? Promise.resolve("");

/** Event name for whether the AI is currently operating the browser (sent by browserControl, listened to by BrowserPanel). */
export const BROWSER_BUSY_EVENT = "agent-browser-busy";

/** Mark the start / end of an AI browser action (drives the panel's "currently operated by Agent" indicator). */
export const setBrowserBusy = (busy: boolean): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BROWSER_BUSY_EVENT, { detail: { busy } }));
  }
};

/** Subscribe to the AI browser-action busy state; returns an unsubscribe function. */
export const onBrowserBusy = (cb: (busy: boolean) => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb(!!(e as CustomEvent<{ busy?: boolean }>).detail?.busy);
  window.addEventListener(BROWSER_BUSY_EVENT, h);
  return () => window.removeEventListener(BROWSER_BUSY_EVENT, h);
};
