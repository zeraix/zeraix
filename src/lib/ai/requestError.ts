/**
 * Why a model request failed, in a shape something can act on.
 *
 * docs/agent-runtime-crash-recovery.md C8. Failures on this path used to be strings — `HTTP 0 — fetch failed` reached
 * the user as-is and nothing above could tell a dropped Wi-Fi connection from a malformed request, so neither could be
 * retried and neither could be explained. This gives every failure a status, a kind and a `retryable` flag, which is
 * the `RuntimeError` shape the runtime spec (§17) asks for, applied to the one path that needed it first.
 *
 * The classification is deliberately conservative in one direction: anything not recognised is NOT retryable. A missed
 * retry costs the user a click; a wrong one resends a request the provider already rejected, and bills them for it.
 */

export type RequestFailureKind =
  /** No HTTP response at all: the network went away, DNS failed, the socket closed mid-stream. */
  | "network"
  /** The provider asked us to slow down (429). */
  | "rate-limit"
  /** The provider broke on its own side (5xx, 408). */
  | "server"
  /** We sent something the provider refused (4xx). Resending it unchanged cannot help. */
  | "client"
  /** The user pressed Stop. Never retried, and never an error the user is shown. */
  | "aborted"
  /** Unrecognised. Treated as fatal, so an unknown failure is surfaced rather than silently repeated. */
  | "unknown";

/** A model request that failed, carrying what the transport knew at the time. */
export class ChatRequestError extends Error {
  readonly status: number;
  readonly kind: RequestFailureKind;
  readonly retryable: boolean;

  constructor(message: string, status: number, kind?: RequestFailureKind) {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
    const resolved = kind ?? classifyFailure(status, message).kind;
    this.kind = resolved;
    this.retryable = RETRYABLE.has(resolved);
  }
}

const RETRYABLE = new Set<RequestFailureKind>(["network", "rate-limit", "server"]);

/**
 * HTTP statuses worth sending the same request to again.
 *
 * 408 request timeout and 425 too-early are the server saying "not now"; 5xx is the server failing on its own side.
 * 409 is deliberately absent — a conflict is about state, and repeating the request does not resolve it.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524]);

/**
 * Substrings that mean "the bytes never made it", across the three transports this app uses (the OpenAI SDK inside the
 * main process, a raw `fetch` in the main process, and a direct `fetch` from the renderer). They each phrase it
 * differently, and none of them sets a status, so the message is the only evidence there is.
 */
const NETWORK_HINTS = [
  "fetch failed",
  "failed to fetch",
  "network error",
  "networkerror",
  "load failed",
  "socket hang up",
  "premature close",
  "terminated",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "enetunreach",
  "epipe",
  "etimedout",
  "timeout",
  "connection error",
  "connection closed",
  "getaddrinfo",
  "tls",
  "certificate",
];

/** Whether the text of an error reads like a transport failure rather than a rejection. */
export function looksLikeNetworkFailure(message: string): boolean {
  const m = (message || "").toLowerCase();
  return NETWORK_HINTS.some((hint) => m.includes(hint));
}

/** Classify a failure from what the transport reported. `status` 0 means "no HTTP response". */
export function classifyFailure(status: number, message = ""): { kind: RequestFailureKind; retryable: boolean } {
  const kind = kindOf(status, message);
  return { kind, retryable: RETRYABLE.has(kind) };
}

function kindOf(status: number, message: string): RequestFailureKind {
  if (status === 429) return "rate-limit";
  if (RETRYABLE_STATUS.has(status)) return "server";
  // A real 4xx is the provider refusing what we sent; resending it unchanged cannot help. Checked before the
  // network hints on purpose — a 400 whose body happens to mention a timeout is still a rejection, not a dropped
  // connection, and retrying it would burn the user's quota on a request that can only fail again.
  if (status >= 400 && status < 500) return "client";
  if (status >= 500) return "server";
  // No status: the only evidence is the text. A `fetch` that never reached a server throws a TypeError whose
  // message is the whole story.
  if (looksLikeNetworkFailure(message)) return "network";
  if (status === 0) return "network";
  return "unknown";
}

/**
 * Turn anything thrown on the request path into a classified failure.
 *
 * Handles the three shapes that actually arrive: our own `ChatRequestError`, a `TypeError` from a bare `fetch`, and an
 * `Error` whose message we previously formatted as `HTTP <status> — …` (recovering the status from the text so an
 * older throw site is classified as well as a newer one).
 */
export function asRequestFailure(e: unknown): { kind: RequestFailureKind; retryable: boolean; status: number; message: string } {
  if (e instanceof ChatRequestError) {
    return { kind: e.kind, retryable: e.retryable, status: e.status, message: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  const m = /^HTTP (\d{3})\b/.exec(message);
  const status = m ? Number(m[1]) : 0;
  const { kind, retryable } = classifyFailure(status, message);
  return { kind, retryable, status, message };
}

/** Attempts for one request, including the first. Two retries: enough for a blip, few enough to notice a real outage. */
export const MAX_ATTEMPTS = 3;

/**
 * How long to wait before attempt `n` (1-based: the delay *before* the second attempt is `retryDelayMs(1)`).
 *
 * Exponential with full-width jitter, and a longer base for a rate limit because the provider has just said the
 * opposite of "immediately". `random` is injectable so the schedule can be asserted rather than sampled.
 */
export function retryDelayMs(attempt: number, kind: RequestFailureKind, random: () => number = Math.random): number {
  const base = kind === "rate-limit" ? 2000 : 600;
  const ideal = base * Math.pow(3, Math.max(0, attempt - 1));
  // ±25% so a fleet of retries does not resynchronise on the same second.
  const jitter = 1 + (random() - 0.5) * 0.5;
  return Math.round(Math.min(ideal * jitter, 30_000));
}

/** What a retry tells its caller, so a UI can say a request is being retried rather than merely hanging. */
export interface RetryInfo {
  /** The attempt that just failed, 1-based. */
  attempt: number;
  /** The total budget, so a message can read "2 of 3". */
  attempts: number;
  kind: RequestFailureKind;
  delayMs: number;
  message: string;
}

/** Abortable delay: someone pressing Stop during a retry wait must not have to sit through it. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run one request, retrying only what the transport lost.
 *
 * Kept here, separate from the request code, so the policy can be tested without a provider: `attempt` is whatever
 * sends the request, and everything this makes a decision about — the classification, the budget, the schedule, the
 * clock — is injectable.
 *
 * Two rules it will not break:
 *  - **An aborted request is never retried.** The user pressed Stop; resending is the opposite of what they asked.
 *  - **Only a transport failure is retried.** A rejection is rethrown untouched, so a 400 fails once and is seen.
 */
export async function withRequestRetry<T>(
  attempt: (attemptNo: number) => Promise<T>,
  opts: {
    signal?: AbortSignal;
    onRetry?: (info: RetryInfo) => void;
    /** Called after the wait, before the next attempt — where a caller drops whatever the failed attempt had rendered. */
    onBeforeRetry?: () => void;
    maxAttempts?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    delayFor?: (attemptNo: number, kind: RequestFailureKind) => number;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = opts.sleep ?? delay;
  const delayFor = opts.delayFor ?? ((n, kind) => retryDelayMs(n, kind));
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const failure = asRequestFailure(e);
      if (!failure.retryable || n >= maxAttempts) throw e;
      const wait = delayFor(n, failure.kind);
      opts.onRetry?.({ attempt: n, attempts: maxAttempts, kind: failure.kind, delayMs: wait, message: failure.message });
      await sleep(wait, opts.signal);
      // Re-checked after the wait: Stop during the pause must not start another request.
      if (opts.signal?.aborted) throw e;
      opts.onBeforeRetry?.();
    }
  }
}
