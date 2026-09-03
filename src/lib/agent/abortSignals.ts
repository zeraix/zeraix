/**
 * Join abort signals, so one piece of work can be stopped from more than one direction.
 *
 * A delegation runs under two. The turn's (on the fan-out path, the scheduler's) — everything stops when the
 * user stops the turn — and its own, which is what the Inspector's per-sub-agent Stop pulls. Neither
 * replaces the other, and the loop, the model request and every tool call each take exactly one signal, so
 * the two are joined here into one that fires when either does.
 *
 * Hand-rolled rather than `AbortSignal.any` for one reason: `release`. A turn's signal outlives every
 * delegation it ran, and a listener left on it per delegation is a leak the size of the conversation.
 * `AbortSignal.any` drops its listeners only when the derived signal is collected; this drops them the
 * moment the work ends, which is a fact the caller knows and the garbage collector does not.
 *
 * Runtime layer: no React, no imports, exercised from test/subagent-observability.test.mjs.
 */
export interface LinkedSignal {
  /** Aborted as soon as any source is. */
  signal: AbortSignal;
  /** Detach from every source. Call when the work is done; afterwards the linked signal never fires again. */
  release(): void;
}

export function linkSignals(...sources: AbortSignal[]): LinkedSignal {
  const controller = new AbortController();
  const attached: AbortSignal[] = [];
  const onAbort = (e: Event) => controller.abort((e.target as AbortSignal | null)?.reason);
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      continue;
    }
    source.addEventListener("abort", onAbort, { once: true });
    attached.push(source);
  }
  return {
    signal: controller.signal,
    release() {
      for (const source of attached) source.removeEventListener("abort", onAbort);
    },
  };
}
