/**
 * Minimal async queue bridging callback-style producers to `for await`.
 *
 * Runtimes need this because their event sources are callbacks (a child process's `data` handler, an
 * agent loop's progress hook) while the NodeRuntime contract is an async iterable. Buffering events
 * and yielding them at the end would look equivalent and is not: the Policy Guard inspects each
 * event as it arrives, so a buffered runtime cannot be stopped mid-node and a budget ceiling would
 * only bind after the spending had already happened.
 *
 * Events pushed before the consumer arrives are buffered, so nothing emitted between starting the
 * producer and the first iteration is lost.
 */
export function createEventQueue() {
  const buffer = [];
  let done = false;
  let wake = null;

  return {
    /**
     * Enqueue an event. The returned promise resolves once the consumer has taken it — awaiting it
     * gives the producer **backpressure**.
     *
     * That matters for the agent loop: without it, the loop keeps issuing paid model calls while the
     * consumer is still working through earlier events, so a budget abort arrives several rounds too
     * late. Producers that cannot overrun anything (a child process, whose output the OS already
     * buffers) can safely ignore the promise.
     */
    push(item) {
      // After close() nobody will ever take this item, so parking the producer on it would be a
      // permanent deadlock -- and close() exists precisely to promise that cannot happen. This is
      // not hypothetical: when a budget ceiling aborts a node, the consumer stops mid-round while
      // the agent loop is still inside a tool call, and whatever that call emits on its way out
      // arrives here after the queue is already closed.
      if (done) return Promise.resolve();
      return new Promise((resolve) => {
        buffer.push({ item, resolve });
        wake?.();
        wake = null;
      });
    },
    /** No more events. Also releases any producer waiting on backpressure, so it cannot deadlock. */
    close() {
      done = true;
      for (const pending of buffer) pending.resolve();
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buffer.length) {
          const next = buffer.shift();
          // try/finally, not a plain call after the yield: if the consumer throws or breaks, the
          // generator exits *at* the yield. This item is already out of the buffer, so close()
          // could not release it either -- the producer would park on backpressure forever and any
          // `await` on it would deadlock. The finally guarantees release on every exit path.
          try {
            yield next.item;
          } finally {
            next.resolve();
          }
        }
        if (done) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * Combine abort signals. Prefers the built-in when available (Node 20+), falling back to manual
 * wiring so the runtime does not depend on a specific Node build.
 */
export function anySignal(signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
