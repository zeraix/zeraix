import { create } from "zustand";

/**
 * * "Running Local Services" global state: Registered when the AI starts a project (dev server), 
 * and displayed via GlobalNotifications (project URL + stop button). 
 * * Sources include: 
 * 1. Start/stop events from the main process background workers (with PID, stoppable).
 * 2. URLs detected in the tool outputs.
 */
export interface RunningService {
  /** Normalize the URL (scheme + host + port).。 */
  url: string;
  /** Background process PID: if provided, it can be stopped; if absent, it is a detected external URL (display only). */
  pid?: number;
  /** Start command (for display only). */
  command?: string;
}

interface ServicesState {
  services: RunningService[];
  /**
   * Deduplicate and merge: 
   * - Entries with the same (non-empty) URL or the same PID are treated as the same service.
   * - Merges a "background process (PID present, URL unknown)" with a "detected address (URL present, no PID)" 
   * into a single entry, since they represent the same service.
   * - Incoming PID/command will overwrite existing ones, but an existing non-empty URL will never 
   * be overwritten by a later empty URL.
   */
  upsert: (svc: RunningService) => void;
  removeByUrl: (url: string) => void;
  removeByPid: (pid: number) => void;
  clear: () => void;
}

/**
 * Normalizes a URL string by stripping ANSI escape sequences/control characters and extracting the origin (scheme://host[:port]).
 * * Dev servers (e.g., Vite) often inject color codes into the port, polluting the string 
 * (e.g., `http://localhost:\x1b[1m5173\x1b[22m…`). This mismatch prevents the "background process card (dirty URL)" 
 * from merging with the "detected clean URL card", resulting in duplicate cards (one stoppable, one hide-only). 
 * Cleaning the URL ensures both resolve to the same origin, allowing them to merge into a single stoppable card via URL deduplication.
 * * Returns an empty string if parsing fails after cleanup, deferring to the "unknown address" logic.
 */
function cleanUrl(raw: string | undefined | null): string {
  if (!raw) return "";
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // CSI sequence (including SGR color codes)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ""); // Remaining control characters
  try {
    const u = new URL(stripped.trim());
    const host = u.hostname === "0.0.0.0" ? "localhost" : u.hostname;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "";
  }
}

export const useServicesStore = create<ServicesState>((set) => ({
  services: [],
  upsert: (raw) =>
    set((s) => {
      // // First, normalize the addresses to ensure that the same service address—originating from different sources (background process events or output probes)—is consistent, thereby enabling correct merging.
      const svc: RunningService = { ...raw, url: cleanUrl(raw.url) };
      const arr = s.services.slice();
      // Standard deduplication: based on identical (non-empty) URLs or identical PIDs. Empty URLs are excluded from URL matching (otherwise, two distinct empty addresses would be erroneously merged).
      let i = arr.findIndex(
        (x) => (!!svc.url && x.url === svc.url) || (svc.pid != null && x.pid === svc.pid),
      );
      // CRITICAL: Merge background processes with detected URLs to prevent duplicate cards—
      // such as "one stoppable card with an unknown address" + "one card with a URL but is hide-only"
      // (which would cause confusion since clicking the card with the URL only hides it instead of stopping the process).
      // Merge proximally into the most recent corresponding record.
      if (i < 0) {
        if (svc.pid == null && svc.url) {
          // Address detected: Merged into the background process categorized as "started but address unknown (URL empty)" and filled in the address.
          for (let j = arr.length - 1; j >= 0; j--)
            if (arr[j].pid != null && !arr[j].url) { i = j; break; }
        } else if (svc.pid != null && !svc.url) {
          // Background process started but address unknown: merge with the detected local address (which lacks a PID) and fill in the PID (making it stoppable).
          for (let j = arr.length - 1; j >= 0; j--)
            if (arr[j].pid == null && arr[j].url) { i = j; break; }
        }
      }
      if (i >= 0) {
        // Retain existing non-empty addresses to prevent them from being overwritten by subsequently arriving empty addresses.
        arr[i] = { ...arr[i], ...svc, url: svc.url || arr[i].url };
        return { services: arr };
      }
      return { services: [...arr, svc] };
    }),
  removeByUrl: (url) => set((s) => ({ services: s.services.filter((x) => x.url !== url) })),
  removeByPid: (pid) => set((s) => ({ services: s.services.filter((x) => x.pid !== pid) })),
  clear: () => set({ services: [] }),
}));

// localhost / 127.0.0.1 / 0.0.0.0(Can include port number)URL match;Normalize and deduplicate based on the origin.
const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)\]]*/gi;

/** Detects local service addresses from a block of text (typically tool output) and registers them (no PID available; display only). */
export function detectServices(text: string | undefined | null): void {
  if (!text) return;
  const upsert = useServicesStore.getState().upsert;
  for (const m of text.matchAll(LOCALHOST_RE)) {
    // cleanUrl strips any ANSI color codes that may be embedded in the matched string and normalizes it to its origin.
    // Returns an empty string for invalid URLs, which are then skipped.
    const url = cleanUrl(m[0]);
    if (url) upsert({ url });
  }
}
