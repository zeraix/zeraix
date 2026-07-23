/**
 * Per-workdir serialisation, shared by every writer of ZERAIX.md.
 *
 * Concurrent sessions and sub-agents can touch the same document at once — a staleness pass and a
 * `remember_project` call, say. Chaining per workdir means simultaneous callers queue rather than
 * race. Cross-process races degrade to a redundant rebuild, never corruption, because the write
 * itself is atomic (see markdown.writeAtomic).
 */
const chains = new Map();

export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
