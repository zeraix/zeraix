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

/**
 * Whether this event is a background job reporting back — i.e. one the model asked to be woken for.
 *
 * `reason` is absent on events from an older main process, so a missing one is never treated as a completion.
 * Everything else (a dev server the user stopped, a job nobody is waiting on) only updates the running-services
 * indicator.
 */
export function isJobCompletion(evt: ServiceEvent): boolean {
  return evt.type === "stopped" && evt.reason === "exited" && !!evt.notify;
}

/** What actually happened, as one line. Shared by both delivery routes so they cannot describe it differently. */
export function describeJobEvent(evt: ServiceEvent): string {
  const ok = evt.code == null ? null : evt.code === 0;
  const outcome = ok === null ? "finished" : ok ? "finished successfully" : `failed with exit code ${evt.code}`;
  return (
    `[Background job ${outcome}] \`${evt.command ?? "(unknown command)"}\`\n\n` +
    (evt.tail ? `Its output ended with:\n${evt.tail}\n` : "There was no output.\n")
  );
}

/**
 * Job results delivered ON THE BACK OF A TOOL RESULT, into the turn that is still running.
 *
 * This is the route that matters. A model told to "start the build with notify and carry on" does exactly
 * that — it keeps working while the build runs — and for as long as that turn lasts there is no way to hand it
 * anything, because the only other channel is the user-message queue, which by construction cannot be drained
 * until the turn ENDS. So the very result the turn was waiting for sat in a visible queue while the agent
 * worked on without it. Riding a tool result is the same trick sub-agent conclusions already use
 * (formatAutoDelivery), and for the same reason.
 *
 * Fenced, so it cannot be mistaken for the output of the tool it is appended to.
 */
export function formatJobDelivery(notices: string[]): string {
  if (notices.length === 0) return "";
  return (
    `\n\n[Background jobs that finished while you were working — delivered automatically, do not go looking for them]\n` +
    `${notices.join("\n")}\n[end of background job results]`
  );
}

/**
 * The same result delivered as its OWN turn, when the conversation was idle (or the turn ended before any tool
 * result could carry it). Here the user genuinely may have moved on, which the inline form must not claim.
 */
export function formatJobMessage(notice: string): string {
  return (
    `${notice}\n` +
    "This is an automatic notification, not the user speaking — they may have asked about something else " +
    "since. Pick the waiting task back up from here. If it failed, report what went wrong instead of " +
    "re-running it blindly."
  );
}
