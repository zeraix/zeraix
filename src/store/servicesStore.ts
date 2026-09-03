import { create } from "zustand";

/**
 * "Running local services" global state: the background processes the AI has started (dev servers and the
 * like), shown by GlobalNotifications with their address and a stop button.
 *
 * ONE source: the main process's start / stop events for processes it spawned, each carrying the pid the
 * user can stop. Nothing is inferred from text any more. Tool output used to be scanned for localhost URLs
 * and every hit shown as a "detected" card — which put a curl's target, a README's example URL and a user's
 * own unrelated server in a panel that is meant to list what the AI is running. A service's address now
 * comes only from the service's own output (native.mjs watches for it), and arrives as a later `started`
 * event for the same pid.
 */
export interface RunningService {
  /** Normalized address (scheme + host + port), or "" while the service has not announced one. */
  url: string;
  /** The background process, as the main process knows it — what "stop" acts on. */
  pid: number;
  /** Start command (for display only). */
  command?: string;
}

interface ServicesState {
  services: RunningService[];
  /** Add or update by pid. A later event with no address never blanks one already known. */
  upsert: (svc: RunningService) => void;
  removeByPid: (pid: number) => void;
  clear: () => void;
}

/**
 * Normalizes a URL string by stripping ANSI escape sequences/control characters and extracting the origin (scheme://host[:port]).
 * Dev servers (e.g., Vite) often inject color codes into the port, polluting the string
 * (e.g., `http://localhost:\x1b[1m5173\x1b[22m…`); cleaning it is what makes the address usable and comparable.
 * Returns an empty string if parsing fails after cleanup, which is shown as "address unknown".
 */
function cleanUrl(raw: string | undefined | null): string {
  if (!raw) return "";
  const stripped = raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // CSI sequence (including SGR color codes)
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
      const svc: RunningService = { ...raw, url: cleanUrl(raw.url) };
      const i = s.services.findIndex((x) => x.pid === svc.pid);
      if (i < 0) return { services: [...s.services, svc] };
      const arr = s.services.slice();
      // Keep a known address: the follow-up event that fills an address in is also the one that must not lose it.
      arr[i] = { ...arr[i], ...svc, url: svc.url || arr[i].url };
      return { services: arr };
    }),
  removeByPid: (pid) => set((s) => ({ services: s.services.filter((x) => x.pid !== pid) })),
  clear: () => set({ services: [] }),
}));
