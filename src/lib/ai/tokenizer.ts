/**
 * Token estimation based on tiktoken (the pure-JS js-tiktoken build).
 *
 * Used only as a fallback estimate when a provider's response does not return usage: approximate counting with OpenAI's cl100k_base tokenizer.
 * Note: the tokenizers for models like DeepSeek / Qwen / Ernie differ from OpenAI's, so results are "estimates", not an exact bill.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

let enc: Tiktoken | null = null;
function getEnc(): Tiktoken {
  if (!enc) enc = getEncoding("cl100k_base");
  return enc;
}

/**
 * The longest run of text handed to the tokenizer at once.
 *
 * js-tiktoken's byte-pair merge is quadratic in the length of one pre-tokenizer piece — every merge rescans every
 * remaining part — and a piece is everything the split regex keeps together, which for letters is the whole run.
 * A file of two million `A`s, a base64 blob, a minified bundle: one piece, and the renderer's main thread is gone
 * for hours. A 2 MB read_file result froze the app outright (2026-09-03). Encoding in fixed windows bounds the
 * worst case per window to WINDOW_CHARS² and costs at most one extra token per window boundary on ordinary text,
 * which is noise for an estimator that is only ever a fallback.
 */
const WINDOW_CHARS = 512;
/**
 * The hard cut when no whitespace is found near the window's end — the blob case.
 *
 * Small on purpose. The merge's cost is quadratic in the piece, and its inner step builds a string, so a 512-character
 * piece of one letter costs about 70 ms and a 128-character one under 2 ms; a window that has no whitespace to cut
 * at is exactly the input that would pay the 70 ms. Ordinary text never reaches this: it is cut at a space instead.
 */
const HARD_CUT_CHARS = 128;
/** How far back from a window's end to look for whitespace to cut at, so ordinary words are not split. */
const CUT_LOOKBACK = 96;
/** Above this many characters the count is a sample, not a full pass. About 16K tokens of ordinary text. */
const SAMPLE_ABOVE = 65_536;
/** Windows sampled from a long text, spread evenly from its head to its tail. */
const SAMPLE_WINDOWS = 8;
const SAMPLE_WINDOW_CHARS = 4096;

const isWhitespace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

/**
 * Token count of a text no longer than SAMPLE_ABOVE, encoded window by window.
 *
 * A window ends at the last whitespace inside the lookback, so a word is never split and ordinary text gets the
 * tokenizer's own count. A window with no whitespace to cut at is a blob — one letter two million times, base64,
 * a minified bundle — and a blob is not encoded at all beyond a sample: its density is measured on its first
 * HARD_CUT_CHARS and scaled over the run, and the run is skipped. A blob's count is an estimate either way, and
 * this is what turns hours into a millisecond.
 */
function encodeWindowed(text: string): number {
  const e = getEnc();
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const soft = Math.min(text.length, i + WINDOW_CHARS);
    let cut = -1;
    for (let j = soft - 1; j > soft - CUT_LOOKBACK && j > i; j--) {
      if (isWhitespace(text.charCodeAt(j))) {
        cut = j;
        break;
      }
    }
    if (cut < 0 && soft - i <= HARD_CUT_CHARS) cut = soft; // a short tail: encode it as it is
    if (cut > i) {
      n += e.encode(text.slice(i, cut)).length;
      i = cut;
      continue;
    }
    let runEnd = soft;
    while (runEnd < text.length && !isWhitespace(text.charCodeAt(runEnd))) runEnd++;
    const sample = text.slice(i, i + HARD_CUT_CHARS);
    n += Math.ceil((e.encode(sample).length / sample.length) * (runEnd - i));
    i = runEnd;
  }
  return n;
}

/**
 * Token estimate for a long text: the density of a few evenly spaced windows, scaled to the whole.
 *
 * Head and tail are always among the samples, so a file whose character changes half-way (a header, then a blob)
 * is at least seen at both ends. Never exact and not meant to be — every caller of this module is documented as
 * taking an estimate — but bounded: eight windows, whatever the length.
 */
function estimateSampled(text: string): number {
  const stride = (text.length - SAMPLE_WINDOW_CHARS) / (SAMPLE_WINDOWS - 1);
  let sampledTokens = 0;
  let sampledChars = 0;
  for (let k = 0; k < SAMPLE_WINDOWS; k++) {
    const start = Math.round(k * stride);
    const window = text.slice(start, start + SAMPLE_WINDOW_CHARS);
    sampledTokens += encodeWindowed(window);
    sampledChars += window.length;
  }
  return Math.ceil((sampledTokens / Math.max(1, sampledChars)) * text.length);
}

/** Minimal message shape (to avoid coupling with page.tsx's types). */
interface MsgLike {
  role?: string;
  // A multimodal message's content may be an array of segments; counted as 0 when not a string (fallback estimation only).
  content?: string | null | unknown[];
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

/**
 * Optional content-keyed memoization. Off by default so normal callers pay nothing. The diagnostics
 * replay (contextDiag.simulateBudgets) re-counts the same message strings hundreds of times across
 * candidate budgets and turns; it enables the cache around a run and clears it after, turning hundreds
 * of full-conversation tokenizations into one-per-unique-string. Keyed by the string itself — slices
 * reuse the same primitive references, so lookups hit.
 */
let tokenCache: Map<string, number> | null = null;
export function setTokenCache(enabled: boolean): void {
  tokenCache = enabled ? new Map() : null;
}

/** Token count for plain text. */
export function countTokens(text: string): number {
  if (!text) return 0;
  const cached = tokenCache?.get(text);
  if (cached !== undefined) return cached;
  let n: number;
  try {
    n = text.length > SAMPLE_ABOVE ? estimateSampled(text) : encodeWindowed(text);
  } catch {
    // Fallback: when the tokenizer errors, roughly estimate at ~4 chars/token.
    n = Math.ceil(text.length / 4);
  }
  tokenCache?.set(text, n);
  return n;
}

/** Token count for a single message (including content and tool_calls). */
export function countMessageTokens(msg: MsgLike | undefined | null): number {
  if (!msg) return 0;
  let n = 0;
  if (typeof msg.content === "string") n += countTokens(msg.content);
  for (const tc of msg.tool_calls ?? []) {
    n += countTokens(tc.function?.name ?? "");
    n += countTokens(tc.function?.arguments ?? "");
  }
  return n;
}

/** Token estimate for the whole conversation (prompt): content + per-message fixed overhead + reply priming. */
export function countMessagesTokens(messages: MsgLike[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4; // Fixed overhead per message for role / separators, etc. (approximate)
    n += countMessageTokens(m);
  }
  return n + 2; // Reply priming
}
