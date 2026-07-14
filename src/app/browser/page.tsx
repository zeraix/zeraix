"use client";

/**
 * <webview> + automation demo page.
 * An embedded <webview> on the left loads the target site; when the user searches within the site (matching searchPattern),
 * the puppeteer-core in a separate utilityProcess captures that navigation via CDP, relays an event, and the right-hand panel expands accordingly.
 *
 * This is site-swappable scaffolding: change cfg (startUrl / hostMatch / searchPattern / queryParam) to connect to a real site.
 */
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_AUTOMATION_CONFIG,
  isAutomationAvailable,
  onAutomationEvent,
  startAutomation,
  type AutomationConfig,
} from "@/lib/automation";

interface TriggerInfo {
  query: string;
  url: string;
  source: string;
  at: number;
}

export default function BrowserPage() {
  const webviewRef = useRef<HTMLElement>(null);
  const [available] = useState(() => isAutomationAvailable());
  const [cfg, setCfg] = useState<AutomationConfig>(DEFAULT_AUTOMATION_CONFIG);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const [url, setUrl] = useState(DEFAULT_AUTOMATION_CONFIG.startUrl);
  const [status, setStatus] = useState("idle");
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const startedRef = useRef(false);

  // Subscribe to automation events (status / trigger / error).
  useEffect(() => {
    return onAutomationEvent((msg) => {
      if (msg.type === "status") setStatus(msg.state);
      else if (msg.type === "error") setStatus(`error: ${msg.message}`);
      else if (msg.type === "trigger") {
        setTrigger({ query: msg.query, url: msg.url, source: msg.source, at: Date.now() });
        setPanelOpen(true);
      }
    });
  }, []);

  // Automatically start watching once the webview finishes loading for the first time.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !available) return;
    const onReady = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      void startAutomation(cfgRef.current);
    };
    wv.addEventListener("dom-ready", onReady);
    return () => wv.removeEventListener("dom-ready", onReady);
  }, [available]);

  // Apply config: navigate the webview to the new address and (re)start watching.
  const applyAndWatch = () => {
    setUrl(cfg.startUrl);
    startedRef.current = true;
    void startAutomation(cfg);
  };

  const field = (label: string, key: keyof AutomationConfig, placeholder?: string) => (
    <label className="flex items-center gap-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <input
        value={cfg[key] ?? ""}
        onChange={(e) => setCfg((c) => ({ ...c, [key]: e.target.value }))}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-md border border-line bg-background px-2 py-1 font-mono text-xs outline-none focus:border-line-strong"
      />
    </label>
  );

  return (
    <div className="flex h-full flex-col bg-surface text-foreground">
      {/* Top: address + config + status */}
      <div className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            value={cfg.startUrl}
            onChange={(e) => setCfg((c) => ({ ...c, startUrl: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && applyAndWatch()}
            placeholder="https://…"
            className="min-w-0 flex-1 rounded-lg border border-line bg-background px-3 py-1.5 text-sm outline-none focus:border-line-strong"
          />
          <button
            onClick={applyAndWatch}
            disabled={!available}
            className="shrink-0 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
          >
            Go and watch
          </button>
          <span
            className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            title="Automation status (puppeteer-core / CDP)"
          >
            {available ? status : "Desktop app required"}
          </span>
        </div>
        <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {field("Match domain", "hostMatch", "bing.com")}
          {field("Search regex", "searchPattern", "[?&]q=")}
          {field("Query param", "queryParam", "q")}
        </div>
      </div>

      {/* Body: webview + right-hand panel */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-white">
          {available ? (
            <webview ref={webviewRef} src={url} allowpopups={true} className="h-full w-full" />
          ) : (
            <iframe src={url} title="preview" className="h-full w-full border-0" />
          )}
        </div>

        {/* Right-hand panel: expands when a search trigger is detected */}
        <div
          className={`shrink-0 overflow-hidden border-l border-line bg-surface transition-[width] duration-300 ${
            panelOpen ? "w-80" : "w-0"
          }`}
        >
          <div className="flex h-full w-80 flex-col">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <span className="text-sm font-semibold">Search detected</span>
              <button
                onClick={() => setPanelOpen(false)}
                className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-surface-muted"
              >
                Collapse
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-sm">
              {trigger ? (
                <>
                  <div>
                    <p className="mb-0.5 text-[11px] text-muted-foreground">Search term</p>
                    <p className="break-all font-medium">{trigger.query || "(no query parameter parsed)"}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-[11px] text-muted-foreground">Source</p>
                    <p className="font-mono text-xs">{trigger.source}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-[11px] text-muted-foreground">URL</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">{trigger.url}</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(trigger.at).toLocaleTimeString()}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">Waiting for an in-site search…</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
