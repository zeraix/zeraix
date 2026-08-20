/**
 * Pure wire/prompt transforms extracted from page.tsx (no component state — inputs → outputs only).
 *
 * These shape the message array "sent to the model" for a single request: hoisting system messages for strict local templates,
 * stripping/downgrading images a model can't view, cleaning a phase-summary body, and removing the app's own bookkeeping keys.
 * Kept out of the ChatAgent component so the component holds orchestration/state, not message plumbing. All functions return new
 * arrays/values and never mutate their inputs.
 *
 * Runtime context and the mission brief used to be spliced in here on every request; both are now change events carried in history
 * (see reminders.ts and docs/cache-stable-prompt-context.md).
 */
import type { ApiMsg, ContentPart } from "./types";
import type { LoadedProjectSkill } from "@/lib/ai/skills/project";
import type { InstalledSkill } from "@/lib/ai/skills/types";

/**
 * Collapse every system message into a SINGLE leading system message (contents joined in original order), rest after.
 *
 * Local llama.cpp chat templates (Qwen / GLM / …) don't merely require the system message to be positioned first — many reject
 * *any second* `role:"system"` entry anywhere in the array (their Jinja checks `loop.first`), raising "System message must be at
 * the beginning."
 *
 * This is now a GUARD, not a transform: it should never actually fire. The runtime context, the mission brief, the rating feedback
 * and all five nudges used to arrive as their own system messages, and merging them is what dragged every one of them into
 * messages[0] — re-prefilling the whole conversation from token 0 each time. They are all change events carried inside existing
 * turns now, so the only system message left is messages[0] itself and this returns its input unchanged. It stays because a future
 * caller adding a stray system message would otherwise get a hard template error instead of a silent merge.
 * See docs/cache-stable-prompt-context.md.
 */
export function hoistSystemToFront(msgs: ApiMsg[]): ApiMsg[] {
  const sysIdx = msgs.reduce<number[]>((acc, m, i) => (m.role === "system" ? [...acc, i] : acc), []);
  // Nothing to do: no system message, or exactly one already at index 0.
  if (sysIdx.length === 0 || (sysIdx.length === 1 && sysIdx[0] === 0)) return msgs;
  const merged: ApiMsg = {
    role: "system",
    content: sysIdx
      .map((i) => (msgs[i] as { role: "system"; content: string }).content)
      .filter(Boolean)
      .join("\n\n"),
  };
  const rest = msgs.filter((m) => m.role !== "system");
  return [merged, ...rest];
}

/** Host of an endpoint, for the usage log. Host only: some gateways carry a key in the query string. */
export function hostOfEndpoint(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

/**
 * Text-only model: remove EVERY image_url part (both inline data: and remote URLs), replacing each with a short text
 * note. A model without image support rejects the whole request the moment any image appears anywhere in history —
 * HTTP 400 "unknown variant `image_url`, expected `text`" — even for an image the user sent turns ago to a different,
 * vision-capable model. Unlike the local-model downgrade, inline images are dropped too: the provider's schema has no
 * image variant at all. Only affects this send's wire, never convoRef / persistence.
 */
export function stripAllImagesForText(messages: ApiMsg[]): ApiMsg[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const kept: ContentPart[] = [];
    let imageCount = 0;
    for (const part of m.content) {
      if (part.type === "image_url") imageCount++;
      else kept.push(part);
    }
    if (imageCount === 0) return m;
    const note = `<image note="${imageCount} image(s) omitted — the current model cannot view images" />`;
    const out: ContentPart[] = [];
    let appended = false;
    for (const part of kept) {
      if (part.type === "text" && !appended) {
        out.push({ type: "text", text: `${part.text}${part.text ? "\n" : ""}${note}` });
        appended = true;
      } else out.push(part);
    }
    if (!appended) out.unshift({ type: "text", text: note });
    if (out.length === 1 && out[0].type === "text") return { ...m, content: out[0].text };
    return { ...m, content: out };
  });
}

/**
 * Wording that names the image input itself.
 *
 * Only consulted AFTER the status gate below, and deliberately does NOT include the bare words "vision" or
 * "multimodal": those are what vision models are NAMED (gpt-4-vision-preview, qwen-vl, *-multimodal), and
 * providers echo the model name back in unrelated errors — "rate limit reached for gpt-4-vision-preview"
 * would otherwise read as a vision rejection and blind the one class of model that certainly is not blind.
 * Every entry here names the image as INPUT, which a model name never does.
 */
const VISION_REJECTION_WORDS = [
  "image_url",
  "invalid_image",
  "image input",
  "image content",
  "not support image",
  "support images",
  "image is not supported",
  "images are not supported",
  "cannot process image",
];

/** Wording that explains a failure WITHOUT the model being image-blind — the images were merely the bulk. */
const NOT_VISION_WORDS = [
  // Size / context: images are by far the biggest part of the body, so stripping them "fixes" these every time.
  "context length",
  "context_length",
  "maximum context",
  "too many tokens",
  "token limit",
  "reduce the length",
  "too large",
  "entity too large",
  "payload",
  "body limit",
  // Load / quota / billing.
  "rate limit",
  "rate_limit",
  "quota",
  "overload",
  "capacity",
  "insufficient",
  "balance",
  "billing",
  "try again",
  // Transport: no status at all, so the retry succeeding says nothing about the model.
  "timeout",
  "timed out",
  "network",
  "failed to fetch",
  "fetch failed",
  "socket",
  "econnreset",
  "etimedout",
  "enotfound",
  "aborted",
];

/**
 * Does this failure mean "this model cannot accept images", as opposed to "this request failed and happened
 * to be carrying images"?
 *
 * The distinction is the whole point. requestChat retries any failed image request without its images, and a
 * retry that succeeds used to be taken as proof the model is text-only — a verdict then persisted against the
 * model forever. But images are the largest and slowest part of a request, so a rate limit, a timeout on a
 * multi-megabyte upload, an oversized body, or a context overflow ALL produce exactly the same evidence, and
 * each one permanently blinded a perfectly capable vision model. That is the bug behind "the AI says it can't
 * see images, and the only cure is deleting and re-adding the model".
 *
 * So: retry broadly (a failed request is worth a second chance whatever the cause), but learn narrowly. A
 * status the provider only returns for a malformed/unsupported request body counts; a transient one, an
 * oversized one, and a request that never got a status at all do not.
 *
 * The gates run in this order on purpose — status first, wording second. Wording alone cannot be trusted
 * ahead of the status because provider errors quote the MODEL NAME, and vision models are named for their
 * vision; matching text first turned "429 rate limit reached for gpt-4-vision-preview" into a verdict that
 * the model cannot see. Every gate fails safe: when in doubt the model KEEPS image support, because being
 * wrong that way costs one retried request while the other way silently deletes the user's picture.
 *
 * A bare 400 with no explanation is still enough. That matters for the common mid-conversation switch — a
 * vision model to a text-only one like DeepSeek, with images already in the history — where the rejection
 * arrives as a deserialization complaint that never mentions images. Without it, every later turn in that
 * conversation would pay a doomed request plus a retry, forever.
 */
export function isVisionRejection(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  // Gate 1 — the status. Our own errors are "HTTP <status> — <body>"; the body is searched only as a
  // fallback, and only for 4xx/5xx, so a model name like gpt-4o-2024-11-20 or a port number cannot pose
  // as one. No status at all means the request never reached the provider (a thrown fetch, an abort), and
  // a retry succeeding after that says nothing whatever about the model.
  const status = Number(/\bhttp\s+(\d{3})\b/.exec(msg)?.[1] ?? /\b([45]\d{2})\b/.exec(msg)?.[1] ?? 0);
  // Only the statuses that mean "I will not process this body as sent". 5xx is the provider failing at its
  // own end, and 408/409/413/429 are load, conflict and size — every one of which the stripped retry
  // "fixes" simply by being smaller.
  if (status !== 400 && status !== 415 && status !== 422) return false;
  // Gate 2 — the provider named the image input. Checked ahead of the exclusions, and safe to, now that the
  // status gate has already removed the errors that merely quote a model's name: a 400 that says "image_url"
  // is telling us the answer, even if the body also says something like "please try again".
  if (VISION_REJECTION_WORDS.some((w) => msg.includes(w))) return true;
  // Gate 3 — a client error that explains itself as something other than image support.
  if (NOT_VISION_WORDS.some((w) => msg.includes(w))) return false;
  // An unexplained rejection of the body we sent. The images were the only unusual thing in it.
  return true;
}

/**
 * Local-model only: downgrade the image_url parts of "remote http images" in history to textual XML references (keeping
 * the URL), while inline data:base64 images are still kept as image_url. llama-server cannot fetch remote URLs (400
 * Failed to load image), but most history images are OSS links uploaded by cloud models with no original bytes to
 * convert. Turning them into `<image url="…"/>` text avoids the error and still tells the model an image was there.
 * Only affects this send's wire, never convoRef / persistence.
 */
export function stripRemoteImagesForLocal(messages: ApiMsg[]): ApiMsg[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const kept: ContentPart[] = [];
    const remoteUrls: string[] = [];
    for (const part of m.content) {
      if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        if (/^data:/i.test(url)) kept.push(part); // Locally readable inline image, keep it
        else if (url) remoteUrls.push(url); // Remote URL, convert to text
      } else kept.push(part);
    }
    if (remoteUrls.length === 0) return m;
    const xml = remoteUrls.map((u) => `<image url="${u}" note="Historical image, not viewable by the local model" />`).join("\n");
    const out: ContentPart[] = [];
    let appended = false;
    for (const part of kept) {
      if (part.type === "text" && !appended) {
        out.push({ type: "text", text: `${part.text}${part.text ? "\n" : ""}${xml}` });
        appended = true;
      } else out.push(part);
    }
    if (!appended) out.unshift({ type: "text", text: xml });
    if (out.length === 1 && out[0].type === "text") return { ...m, content: out[0].text };
    return { ...m, content: out };
  });
}

/**
 * Dev-mode "phase summary" cleanup: reasoning models sometimes stuff the chain of thought + a leftover </think> into the
 * body of a "tool-call round". Phased streaming shows this body as that phase's summary, so keep only the body after the
 * last </think> (returned as-is if none), and strip leading whitespace, to avoid displaying chain-of-thought remnants.
 */
export function phaseSummaryText(raw: string): string {
  const marker = "</think>";
  const i = raw.lastIndexOf(marker);
  return (i >= 0 ? raw.slice(i + marker.length) : raw).replace(/^\s+/, "");
}

/**
 * Remove the app's own bookkeeping fields from the wire, just before the request body is built.
 *
 * `rating` and `reminder` are non-standard keys the app hangs on messages; `page.tsx` sends `messages` verbatim, so anything left
 * on them goes to the provider. This is the ONLY place either is stripped — deleting the call leaks both.
 *
 * It replaces the former injectRatingFeedback, which also expanded a rating into a `role:"system"` block after the rated message.
 * That block was dropped: it carried one bit with no diagnosis, mostly fired for ratings the user never acted on (regenerate
 * deletes the rated message), and on local models a single thumbs-up re-prefilled the whole conversation from token 0, because the
 * hoist drags any system message to the front. StoredMessage.rating is untouched and still available for audit.
 * See docs/cache-stable-prompt-context.md.
 */
export function stripWireMetadata(wire: ApiMsg[]): ApiMsg[] {
  // Fast-return the original array when there is nothing to strip (the vast majority of requests: zero overhead, no cache churn).
  const dirty = (m: ApiMsg) =>
    (m.role === "assistant" && m.rating) ||
    ((m.role === "user" || m.role === "tool") && m.reminderText) ||
    (m.role === "user" && m.reminder);
  if (!wire.some(dirty)) return wire;
  return wire.map((m) => {
    if (m.role === "assistant" && m.rating) {
      const { rating: _rating, ...clean } = m;
      return clean;
    }
    // reminderText should already be gone — materializeReminders consumes it. Stripped here too so a caller that skips that step
    // cannot ship a non-standard key to a provider.
    if (m.role === "tool" && m.reminderText) {
      const { reminderText: _t, ...clean } = m;
      return clean;
    }
    if (m.role === "user" && (m.reminderText || m.reminder)) {
      const { reminderText: _t, reminder: _r, ...clean } = m;
      return clean;
    }
    return m;
  });
}

/**
 * Decide which assistant turns replay their thinking text, and to whom.
 *
 * `sendContext` (the user setting, off by default — see ThinkingConfig.sendContext) is the wide door: with it on, every
 * assistant turn keeps its thinking text for every model, so the model is shown what it reasoned earlier in the
 * conversation and not just its conclusions. It is opt-in because the replay is billed as input on every later request,
 * grows with the conversation, and a strict provider rejects the field outright (the caller retries without it).
 *
 * The rest of this function is the floor that applies while that setting is off, and it is not merely "send nothing":
 *
 * A local chat template renders `reasoning_content` back into the prompt, but only for assistant turns AFTER the last user
 * query — both families compute the same guard by different means:
 *
 *     Qwen   walk messages backwards, stop at the first user message not wrapped in <tool_response>  -> last_query_index
 *     Gemma  forward scan, index of the last role:"user" message                                     -> last_user_idx
 *     gate   render thinking iff  loop.index0 > that index
 *
 * So the rule is symmetric, and both directions matter:
 *
 *   inside a tool loop   template WILL render it   -> we must send it, or the replayed prompt no longer matches what the
 *                                                     model generated and the cached prefix dies at the assistant reply
 *   after a new user query  template DROPS it      -> sending it changes nothing; we strip it so nothing accumulates
 *
 * Remote providers get none of it: it is an output-side field and some reject it outright.
 *
 * Tool results travel as role:"tool" in this app (never a <tool_response>-wrapped user turn), so "the last user query" is
 * simply the last role:"user" message — the tool_response special case in Qwen's template cannot arise here.
 */
export function applyReasoningPolicy(wire: ApiMsg[], isLocal: boolean, sendContext = false): ApiMsg[] {
  if (!wire.some((m) => m.role === "assistant" && m.reasoning_content)) return wire;
  // Setting on: keep every turn's thinking text as-is, for local and remote alike. Nothing to strip, so the input array
  // is returned untouched (no new objects, no cache churn).
  if (sendContext) return wire;
  let lastUser = -1;
  for (let i = 0; i < wire.length; i++) if (wire[i].role === "user") lastUser = i;
  return wire.map((m, i) => {
    if (m.role !== "assistant" || !m.reasoning_content) return m;
    if (isLocal && i > lastUser) return m;
    const { reasoning_content: _r, ...clean } = m;
    return clean;
  });
}

/**
 * Drop `reasoning_content` from every assistant turn, unconditionally.
 *
 * The escape hatch for a provider that answers a replayed thinking block with a 400 (see isReasoningContentError): the
 * request is resent through this, so one rejection costs a retry rather than the turn. Separate from
 * applyReasoningPolicy because it runs on a request that has ALREADY been built and failed, where "what a local template
 * would render" no longer matters — the only thing that can be true is that the field must go.
 */
export function stripReasoningContent(wire: ApiMsg[]): ApiMsg[] {
  if (!wire.some((m) => m.role === "assistant" && m.reasoning_content)) return wire;
  return wire.map((m) => {
    if (m.role !== "assistant" || !m.reasoning_content) return m;
    const { reasoning_content: _r, ...clean } = m;
    return clean;
  });
}

/** Project skill (LoadedProjectSkill) → InstalledSkill shape, so it can be merged into the runtime skill set and
 *  progressively disclosed by load_skill. The id is prefixed with "project:" to avoid clashing with installed skills;
 *  description falls back to name (load_skill relies on it to be discovered by the model). */
export function toInstalledProjectSkill(p: LoadedProjectSkill): InstalledSkill {
  return {
    id: `project:${p.path}`,
    name: p.name,
    version: "1",
    description: p.description || p.name,
    instructions: p.instructions,
    installedAt: 0,
    enabled: true,
  };
}
