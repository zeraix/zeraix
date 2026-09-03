/**
 * A download-progress reporter that speaks at a human rate.
 *
 * The runtime image is downloaded in HTTPS chunks of 16–64 KB, and the reporter used to be called for every one of
 * them. Each call became a `sandbox:status` broadcast to every window and a state change in the chat page — tens of
 * thousands of IPC messages and React renders over a multi-GB first-run download, which is what made a fresh install
 * feel sluggish for exactly as long as the download took. Nobody can read a number that changes 500 times a second.
 *
 * So: a report goes out when the whole-percent value changes, or when `intervalMs` has passed since the last one, or
 * when the caller marks a milestone (a file finished) — and otherwise it is dropped. Bytes are still counted exactly;
 * only the broadcasts are rationed. Dependency-free and clock-injectable so test/sandbox-progress.test.mjs can drive it.
 */

/** Progress broadcasts per second, at most, while the percentage is not moving. */
export const PROGRESS_INTERVAL_MS = 250;

/**
 * @param {object} opts
 * @param {number} opts.total          Bytes expected in all, or 0 when unknown (then `pct` is reported as null).
 * @param {(pct: number|null, text: string) => void} opts.onProgress
 * @param {() => number} [opts.now]    Clock, for tests.
 * @param {number} [opts.intervalMs]
 * @returns {{ add(bytes: number): void; milestone(): void; done: number }}
 */
export function createProgressReporter({ total, onProgress, now = Date.now, intervalMs = PROGRESS_INTERVAL_MS }) {
  let done = 0;
  let lastAt = -Infinity;
  let lastPct = NaN;
  const pctOf = () => (total ? Math.min(99, Math.floor((done / total) * 100)) : null);
  const text = () => `Downloading runtime environment ${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`;
  const emit = () => {
    lastAt = now();
    lastPct = pctOf();
    onProgress?.(lastPct, text());
  };
  return {
    get done() {
      return done;
    },
    /** Count bytes, and report only when there is something new to say. The first call always reports. */
    add(bytes) {
      done += bytes;
      const pct = pctOf();
      if (pct === lastPct && now() - lastAt < intervalMs) return;
      emit();
    },
    /** Force a report: a file just finished, and the exact number should land on screen. */
    milestone() {
      emit();
    },
  };
}
