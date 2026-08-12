/**
 * Renderer-layer bridge for background services (dev servers spun up by the AI, etc.): stop / list / subscribe to start-stop events.
 * Via window.aiTools (exposed by preload, Electron only); everything degrades to no-op outside Electron.
 */
export interface ServiceEvent {
  type: "started" | "stopped";
  pid: number;
  url?: string;
  command?: string;
  /**
   * How a "stopped" ended: the process finished on its own, versus being killed by the user or by shutdown.
   * Absent on events from an older main process, which is why nothing may treat missing as "exited".
   */
  reason?: "exited" | "stopped";
  /** Exit code where the engine can recover one. Null in the sandbox: a `setsid …&` job has no shell left to reap it. */
  code?: number | null;
  signal?: string | null;
  /** Last few KB of the job's output — for a finished install this is the result, not a detail. */
  tail?: string;
  /** The job was started with `notify`, i.e. the model asked to be woken when it finished. */
  notify?: boolean;
}

interface AiToolsServiceBridge {
  stopProcess?(pid: number): Promise<boolean>;
  listProcesses?(): Promise<Array<{ pid: number; url: string; command: string }>>;
  onServiceEvent?(cb: (evt: ServiceEvent) => void): () => void;
}

function bridge(): AiToolsServiceBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { aiTools?: AiToolsServiceBridge }).aiTools ?? null;
}

/** Stop a background service (by pid). */
export async function stopService(pid: number): Promise<void> {
  try {
    await bridge()?.stopProcess?.(pid);
  } catch {
    /* Ignore */
  }
}

/** List current background services (for the initial sync). */
export async function listServices(): Promise<Array<{ pid: number; url: string; command: string }>> {
  try {
    return (await bridge()?.listProcesses?.()) ?? [];
  } catch {
    return [];
  }
}

/** Subscribe to background-service start-stop events; returns an unsubscribe function (no-op in Web environments). */
export function onServiceEvent(cb: (evt: ServiceEvent) => void): () => void {
  return bridge()?.onServiceEvent?.(cb) ?? (() => {});
}
