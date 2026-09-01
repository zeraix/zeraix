/**
 * Reading the `arguments` a model emitted for a tool call.
 *
 * Every provider hands tool arguments over as a STRING that is supposed to be JSON, and models get that string wrong in a small
 * number of recurring ways. The old reading of it was `JSON.parse(...)` inside a `try` whose `catch` produced `{}` — which turned
 * every one of those failures into the same lie: the call ran with no arguments at all, and the tool then complained about a
 * missing parameter the model is looking at in its own transcript. `spawn_subagents` showed it worst, because its payload is the
 * largest and most nested one on the wire: a batch of long task descriptions would come back "tasks must be a non-empty array",
 * the model would conclude the array shape was wrong, and it would fall back to one blocking `run_subagent` at a time — the exact
 * concurrency the tool exists to provide, lost to a parse error nobody was told about.
 *
 * So this module does two things the `catch {}` could not:
 *  - **Recovers what is recoverable.** Fenced JSON, a doubly-encoded string, and a payload TRUNCATED mid-value (the common one:
 *    the response hit its token ceiling in the middle of a long argument) are all read rather than discarded.
 *  - **Reports what is not.** A genuinely unreadable payload returns an error the model can act on — that the call did not run,
 *    that its JSON was cut short, and which keys did arrive — instead of a schema complaint about arguments it did send.
 *
 * Truncated payloads are deliberately NOT executed. A repaired object is used only to describe the failure: running a delegation
 * whose task text was cut in half is worse than telling the model to send it again, because the sub-agent would work for minutes
 * on half a brief and report a confident answer to the wrong question.
 */

/**
 * The outcome of reading one call's `arguments` string.
 *
 * `partial` is what a truncated payload was carrying before it stopped — used to DESCRIBE the failure, never to run it. It is
 * also how a truncated `call_tool` envelope still yields the name of the tool the model was reaching for, so the failure is
 * reported against `spawn_subagents` rather than against the dispatcher the user never wrote.
 */
export type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; partial?: Record<string, unknown> };

/**
 * How a model spells "this tool takes no arguments" when it does not simply send `{}`.
 *
 * Tolerated because the old `catch → {}` tolerated it, and a no-argument tool is exactly where a model is most likely to write
 * something that is not JSON at all. Failing these would trade one class of wasted round trip for another.
 */
const EMPTY_SPELLINGS = new Set(["null", "undefined", "none", "nil", "nan", "{}", "()", "[]", '""', "''"]);

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const tryJson = (text: string): { value: unknown } | null => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
};

/** ```json … ``` around the payload. Small models wrap tool arguments the way they wrap chat code blocks. */
function stripFence(text: string): string {
  const m = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return m ? m[1].trim() : text;
}

/**
 * The first complete JSON object in a payload that carries more than JSON.
 *
 * Models append a sentence to the arguments the way they annotate a code block ("{…} — I have used the narrow set here"), and a
 * payload that is entirely valid up to a trailing remark is one the old parse threw away whole. Scanned with string awareness so
 * a brace inside a task description cannot end the object early.
 */
function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Close a JSON payload that simply stops.
 *
 * Walks the text once tracking string/escape state and the open-bracket stack, then completes it: terminate an unfinished string,
 * drop a dangling separator, and close every container that was left open. Several endings are ambiguous (a cut key, a key with
 * no value yet), so the completions are tried in order of likelihood and the first one that parses wins.
 *
 * Returns the recovered value, or null when nothing readable comes out of it.
 */
function repairTruncated(text: string): unknown {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") closers.push("}");
    else if (c === "[") closers.push("]");
    else if (c === "}" || c === "]") closers.pop();
  }
  if (closers.length === 0 && !inString) return null; // Not a truncation: something else is malformed.

  let head = escaped ? text.slice(0, -1) : text;
  if (inString) head += '"';
  const tail = closers.reverse().join("");

  // Ordered by how a cut usually lands: mid-value, right after a comma, on a key with no value, mid-key.
  const candidates = [
    head,
    head.replace(/,\s*$/, ""),
    /:\s*$/.test(head) ? `${head} null` : null,
    /"\s*$/.test(head) ? `${head}: null` : null,
    head.replace(/[,{[]\s*"[^"]*"?\s*$/, (m) => (m.trimStart().startsWith(",") ? "" : m[0])),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const parsed = tryJson(candidate + tail);
    if (parsed) return parsed.value;
  }
  return null;
}

/** What the model is told when its arguments could not be read. Says the call did not run, and why, and what to do about it. */
function unreadable(text: string, recovered: unknown): string {
  const obj = asObject(recovered);
  const keys = obj ? Object.keys(obj) : [];
  const received = keys.length > 0 ? ` The keys that did arrive: ${keys.join(", ")}.` : "";
  const cause =
    recovered !== null
      ? `The payload stopped after ${text.length} characters, mid-value, which is what a response cut off at its token limit looks like.`
      : `The payload (${text.length} characters) is not parseable JSON — check for an unescaped quote, a stray newline inside a string, or a trailing comma.`;
  return (
    `The arguments for this call were not valid JSON, so NOTHING RAN — this is not a complaint about the parameters you chose. ` +
    `${cause}${received} ` +
    `Send the same call again with shorter argument text (split one long call into several smaller ones rather than trimming what the tool needs to know).`
  );
}

/**
 * Read one tool call's `arguments` string.
 *
 * Total on the happy path and on every recoverable near-miss; the error branch is reserved for a payload that carries no usable
 * object at all. An empty string is a legitimate no-argument call, not a failure.
 */
export function parseToolArguments(raw: unknown): ParsedToolArgs {
  // `arguments` is typed as a string and is one on every provider seen so far, but it arrives as untyped wire JSON — so an
  // object here is a provider difference, not a bug to throw on. The previous `JSON.parse` swallowed the whole question in a
  // catch; this reads it, and a non-string scalar still falls through to the error below rather than being coerced.
  const passthrough = asObject(raw);
  if (passthrough) return { ok: true, args: passthrough };
  if (raw === null || raw === undefined) return { ok: true, args: {} };
  if (typeof raw !== "string") {
    return {
      ok: false,
      error:
        `Tool arguments must be a JSON object of named parameters; this call sent a ` +
        `${Array.isArray(raw) ? "array" : typeof raw}, so nothing ran. Send the call again with its arguments as an object.`,
    };
  }

  const text = raw.trim();
  if (!text || EMPTY_SPELLINGS.has(text.toLowerCase())) return { ok: true, args: {} };

  const unfenced = stripFence(text);
  const embedded = firstObject(unfenced);
  const direct = tryJson(text) ?? tryJson(unfenced) ?? (embedded ? tryJson(embedded) : null);
  if (direct) {
    const obj = asObject(direct.value);
    if (obj) return { ok: true, args: obj };
    // `null` is how some providers spell "no arguments"; a doubly-encoded object is a common near-miss worth unwrapping once.
    if (direct.value === null) return { ok: true, args: {} };
    if (typeof direct.value === "string") {
      const encoded = direct.value.trim();
      if (!encoded) return { ok: true, args: {} };
      const inner = tryJson(encoded);
      const innerObj = inner ? asObject(inner.value) : null;
      if (innerObj) return { ok: true, args: innerObj };
    }
    return {
      ok: false,
      error:
        `Tool arguments must be a JSON OBJECT of named parameters, but this call sent a bare ` +
        `${Array.isArray(direct.value) ? "array" : typeof direct.value}, so nothing ran. ` +
        `Wrap it in the parameter the tool declares — e.g. {"tasks": [ … ]} rather than [ … ].`,
    };
  }

  const recovered = repairTruncated(unfenced);
  const partial = asObject(recovered);
  return { ok: false, error: unreadable(text, recovered), ...(partial ? { partial } : {}) };
}
