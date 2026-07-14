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

/** Minimal message shape (to avoid coupling with page.tsx's types). */
interface MsgLike {
  role?: string;
  // A multimodal message's content may be an array of segments; counted as 0 when not a string (fallback estimation only).
  content?: string | null | unknown[];
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

/** Token count for plain text. */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEnc().encode(text).length;
  } catch {
    // Fallback: when the tokenizer errors, roughly estimate at ~4 chars/token.
    return Math.ceil(text.length / 4);
  }
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
