/**
 * What a tool call is allowed to leave behind in the execution history (TODO §10, §28).
 *
 * The Inspector shows a sub-agent's tool inputs and outputs, and a sub-agent reads whatever it is pointed
 * at: a `.env` file, a `git remote -v` with a token in the URL, a command that echoes its environment. The
 * transcript already has that problem and answers it by only ever showing what the model itself received;
 * this history is different, because it OUTLIVES the turn and is kept in memory for inspection long after
 * the conversation moved on. So nothing sensitive is stored in the first place — redaction happens on the
 * way in, not on the way out. A redaction applied at render time is one refactor away from being skipped.
 *
 * Deliberately dependency-free and pure, so the rules can be exercised directly
 * (test/subagent-observability.test.mjs) rather than through a rendered panel.
 */

/** What stands in for a value that was withheld. Stated, never silently dropped — a gap reads as "no value". */
export const REDACTED = "[redacted]";

/**
 * Argument keys whose VALUE is never stored, whatever it looks like.
 *
 * Matched on the key rather than the value because that is the half that is reliable: an API key is an
 * opaque string with no shape worth trusting, whereas the field it arrives in is nearly always named after
 * what it is. `env` is here for the whole object: TODO §10 asks for environment variables not to be exposed
 * by default, and there is no useful middle ground between "the env is shown" and "it is not".
 */
const SECRET_KEY = /(^|[_.-])(api[_-]?key|key|token|secret|password|passwd|pwd|credential|credentials|auth|authorization|cookie|session|signature|private[_-]?key|access[_-]?key|refresh[_-]?token|env|environment)($|[_.-])/i;

/**
 * Values that are secrets whatever they are called.
 *
 * Only shapes that are unambiguous. A generic "long random-looking string" test was tried and removed: it
 * redacted file hashes, minified source lines and base64 images, which made the history unreadable while
 * protecting nothing — the named-key rule above already covers the case that matters.
 */
const SECRET_VALUE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, // GitHub
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // `SECRET_TOKEN=…` in command lines and command output, which is how a leak actually reaches this file.
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|\S+)/g,
];

/** How much of one argument string is worth keeping. A `write_file` body is the size of the file. */
export const MAX_ARG_CHARS = 600;
/** How much of one tool result is worth keeping. Enough to read; nowhere near enough to hold a repository. */
export const MAX_OUTPUT_CHARS = 4000;
/** Guards against a pathological argument object walking forever. */
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ITEMS = 20;

/** Note the elision, so a reader knows they are looking at a fragment rather than the whole thing. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more characters)`;
}

/**
 * Scrub secret-shaped substrings out of free text.
 *
 * Applied to every stored string, argument and result alike: the named-key rule cannot help when the secret
 * is in the middle of a command line or in the output of one.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE) {
    // The `KEY=value` pattern has capture groups; keeping the name and replacing only the value is what
    // makes the line still legible ("AWS_SECRET_ACCESS_KEY=[redacted]" says more than one long blank).
    out = out.replace(re, (match, name?: string) =>
      typeof name === "string" && match.includes(name) ? `${name}=${REDACTED}` : REDACTED,
    );
  }
  return out;
}

/** One tool result, ready to store: scrubbed, then clipped. */
export function redactOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  return clip(scrubSecrets(text), max);
}

/**
 * One tool call's arguments, ready to store.
 *
 * Structure is preserved — the Inspector shows arguments as JSON, and flattening them to a string would
 * lose which value belonged to which parameter — but every leaf is scrubbed and clipped, secret-named keys
 * are withheld outright, and the walk is bounded in depth and breadth.
 */
export function redactArgs(args: unknown): Record<string, unknown> {
  const walked = walk(args, 0);
  return walked !== null && typeof walked === "object" && !Array.isArray(walked)
    ? (walked as Record<string, unknown>)
    : { value: walked };
}

function walk(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return clip(scrubSecrets(value), MAX_ARG_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "…";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ITEMS).map((v) => walk(v, depth + 1));
    if (value.length > MAX_ITEMS) kept.push(`… (${value.length - MAX_ITEMS} more)`);
    return kept;
  }
  if (typeof value !== "object") return String(value);

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n >= MAX_KEYS) {
      out["…"] = `(${Object.keys(value as object).length - MAX_KEYS} more keys)`;
      break;
    }
    n++;
    out[k] = SECRET_KEY.test(k) ? REDACTED : walk(v, depth + 1);
  }
  return out;
}
