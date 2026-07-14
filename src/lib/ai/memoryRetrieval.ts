/**
 * Memory retrieval (lexical RAG).
 *
 * Lets the search_memory tool pull relevant memories from the memory store on demand — the retrieval
 * side of "retrieval-augmented generation". For the design trade-offs see
 * docs/prompt-cache-optimization.md §4.3: a personal memory store usually holds only a few dozen entries, so
 * lexical retrieval (term overlap + substring) is simpler, deterministic, and needs no possibly-unconfigured
 * embedding endpoint; the scoreMemory scoring function is isolated so that, once the corpus grows, it can be
 * swapped wholesale for vector / embedding similarity without touching callers.
 *
 * Pure functions, no side effects, no DOM dependencies — easy to unit-test.
 */
import type { MemoryFile } from "./memoryFiles";

/** Split text into searchable "terms": Latin words (≥2 letters/digits) + adjacent CJK character bigrams, giving some recall for Chinese too. */
export function terms(text: string): string[] {
  const s = text.toLowerCase();
  const out: string[] = [];
  for (const w of s.match(/[a-z0-9]{2,}/g) ?? []) out.push(w);
  for (const run of s.match(/[㐀-鿿぀-ヿ가-힯]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** Score one memory against the query: term overlap (title weighted higher than content) + a whole-string substring bonus. Can be swapped wholesale for vector similarity. */
export function scoreMemory(queryTerms: string[], normalizedQuery: string, m: MemoryFile): number {
  const title = m.title.toLowerCase();
  const content = m.content.toLowerCase();
  let score = 0;
  for (const t of new Set(queryTerms)) {
    if (title.includes(t)) score += 3;
    if (content.includes(t)) score += 1;
  }
  if (normalizedQuery && title.includes(normalizedQuery)) score += 5;
  if (normalizedQuery && content.includes(normalizedQuery)) score += 2;
  return score;
}

/**
 * Retrieve memories:
 *  - No query terms, or a total count within limit → return them all (newest first) — guaranteeing "a small store is
 *    always shown in full", which is exactly what fixes "newly added memories being invisible in the conversation":
 *    every call reads the current file, not the stale snapshot from when the conversation started;
 *  - otherwise sort by relevance and take the top limit; if nothing matches, fall back to returning everything (so the model never "sees not a single one").
 */
export function searchMemories(all: MemoryFile[], query: string, limit = 20): MemoryFile[] {
  const recentFirst = [...all].sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  const q = query.trim().toLowerCase();
  if (!q || recentFirst.length <= limit) return recentFirst.slice(0, limit);
  const qt = terms(q);
  const scored = recentFirst
    .map((memory) => ({ memory, score: scoreMemory(qt, q, memory) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return recentFirst.slice(0, limit); // nothing matched → fall back to returning everything
  return scored.slice(0, limit).map((x) => x.memory);
}
