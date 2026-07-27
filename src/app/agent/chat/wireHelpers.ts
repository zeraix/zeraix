/**
 * Pure wire/prompt transforms extracted from page.tsx (no component state — inputs → outputs only).
 *
 * These shape the message array "sent to the model" for a single request: appending runtime context,
 * hoisting system messages for strict local templates, stripping/downgrading images a model can't view,
 * cleaning a phase-summary body, and injecting rating feedback. Kept out of the ChatAgent component so the
 * component holds orchestration/state, not message plumbing. All functions return new arrays/values and
 * never mutate their inputs.
 */
import type { ApiMsg, ContentPart } from "./types";
import type { ResolvedModel } from "@/lib/ai/models";
import type { LoadedProjectSkill } from "@/lib/ai/skills/project";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { RATING_UP_FEEDBACK, RATING_DOWN_FEEDBACK } from "./constants";

/**
 * Dynamically builds the runtime info appended to the end of the system prompt: user time zone, current
 * date (YYYY-MM-DD), and the current model and provider. Called each time the system prompt is assembled
 * for a send, so it automatically reflects the latest time zone / date / selected model.
 */
export function userTimeContext(model: ResolvedModel | null): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    /* Leave empty if reading the time zone fails */
  }
  const modelPart = model ? `\nCurrent Model: ${model.label} (${model.model})` : "";
  return `User Time Zone: ${tz || "unknown"}\nCurrent Date: ${y}-${m}-${d}${modelPart}`;
}

/**
 * Collapse every system message into a SINGLE leading system message (contents joined in original order), rest after.
 * Local llama.cpp chat templates (Qwen / GLM / …) don't merely require the system message to be positioned first — many
 * reject *any second* `role:"system"` entry anywhere in the array (their Jinja checks `loop.first`), raising
 * "System message must be at the beginning." The runtime context + nudges are appended at the end for prefix-cache
 * stability, and several nudge/rating paths add their own separate system messages, so for local models we both hoist
 * and merge them into one message[0] just before sending. No-op when there is at most one system message and it is
 * already at the front. System messages are always string-content per ApiMsg.
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

/**
 * Append text to the end of the first system message's content, merging it into the system prompt itself rather than
 * adding a second system message — so chat templates that require a single leading system message (Qwen / GLM / …) accept it.
 * System messages are always string-content per ApiMsg. Falls back to a leading system message only if the wire has none
 * (buildWireContext always includes one, so that branch is defensive).
 */
export function appendToSystemPrompt(msgs: ApiMsg[], text: string): ApiMsg[] {
  if (!text) return msgs;
  const i = msgs.findIndex((m) => m.role === "system");
  if (i < 0) return [{ role: "system", content: text }, ...msgs];
  return msgs.map((m, idx) =>
    idx === i && m.role === "system" ? { ...m, content: m.content ? `${m.content}\n\n${text}` : text } : m,
  );
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
 * User rating (thumbs up / down) → dynamically injected wire feedback: each assistant message that carries a rating is
 * kept as-is after "stripping the rating field in place", with an English feedback system message inserted immediately
 * after it. Only affects the temporary wire "sent to the model" — the archived assistant content contains no rating, and
 * the rating field is never sent to the provider. Rebuilt from StoredMessage.rating on every request, so the feedback
 * stays visible to the model as long as that reply is in context.
 */
export function injectRatingFeedback(wire: ApiMsg[]): ApiMsg[] {
  // Fast-return the original array when there is no rating at all (the vast majority of requests: zero overhead, no cache churn).
  if (!wire.some((m) => m.role === "assistant" && m.rating)) return wire;
  const out: ApiMsg[] = [];
  for (const m of wire) {
    if (m.role === "assistant" && m.rating) {
      const { rating, ...clean } = m; // Strip the memory-only rating field; never send it to the provider
      out.push(clean);
      out.push({
        role: "system",
        content: rating === "up" ? RATING_UP_FEEDBACK : RATING_DOWN_FEEDBACK,
      });
    } else {
      out.push(m);
    }
  }
  return out;
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
