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
  if (!wire.some((m) => (m.role === "assistant" && m.rating) || (m.role === "user" && m.reminder))) return wire;
  return wire.map((m) => {
    if (m.role === "assistant" && m.rating) {
      const { rating: _rating, ...clean } = m;
      return clean;
    }
    if (m.role === "user" && m.reminder) {
      const { reminder: _reminder, ...clean } = m;
      return clean;
    }
    return m;
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
