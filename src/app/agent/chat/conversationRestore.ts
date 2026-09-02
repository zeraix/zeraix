import { sanitizeToolCallArguments } from "@/lib/ai/toolArgs";
import { resolveToolCall } from "@/lib/ai/toolRouter";
import { thinkingProcessText } from "./wireHelpers";
import type { StoredMessage } from "@/lib/ai/conversation";
import type { ApiMsg, DisplayMsg } from "./types";

/** The slice of a stored conversation these two rebuilds read. */
export interface StoredConversation {
  messages: StoredMessage[];
  systemPrompt?: string;
}

/**
 * Rebuild the conversation that is sent to the model.
 *
 * Faithfully restores the tool-call trace (the assistant's tool_calls plus the tool result messages), so that
 * when the chat continues the model still "remembers" what it called and what results it got.
 */
export function restoreWireBuffer(conv: StoredConversation): ApiMsg[] {
  const restoredSystem: ApiMsg[] = conv.systemPrompt ? [{ role: "system", content: conv.systemPrompt }] : [];
  const restored = conv.messages.map((m): ApiMsg => {
    // A tool result may carry a mid-loop nudge. It rides its own field, so `content` replays unchanged and the reminder is
    // re-merged at wire-build time — the turn renders exactly as it was sent (see reminders.ts).
    if (m.role === "tool")
      return {
        role: "tool",
        tool_call_id: m.tool_call_id ?? "",
        content: m.content,
        ...(m.reminderText ? { reminderText: m.reminderText } : {}),
      };
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content,
        // Repaired on the way back in, not just on the way out. A conversation saved before the sanitiser
        // existed still holds the malformed call, and replaying it means the provider rejects the request
        // the moment the conversation is reopened -- so the fix has to reach the archive too, or every
        // conversation already broken by this stays broken for good.
        ...(m.tool_calls?.length ? { tool_calls: [...sanitizeToolCallArguments(m.tool_calls)] } : {}),
        // The rating (thumbs up / down) is restored from the archive into the in-memory wire buffer; stripWireMetadata removes the field before sending.
        ...(m.rating ? { rating: m.rating } : {}),
        // Thinking text is restored too, or reopening mid tool-loop would replay a prompt missing the <think> blocks the model
        // itself produced — the same prefix break this field exists to avoid. applyReasoningPolicy still gates who receives it.
        ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
      };
    // Rebuild the multimodal user turn. The archive splits a user message into `content` (the text the
    // bubble renders) and `images` (the URLs), so replaying `content` alone silently dropped every image
    // the user had sent: the transcript still showed the thumbnail — rebuilt from `images` just below —
    // while the model saw a text-only history and could no longer answer questions about the picture.
    // Reassemble the OpenAI-compatible shape it was sent as: one text part (when there is text) followed
    // by one image_url part per image.
    //   { role:"user", content:[ {type:"text",text}, {type:"image_url",image_url:{url}}, … ] }
    // `wireText` is preferred over `content` when present: it is the version that carried inlined
    // text-file contents and saved attachment paths (see the persist site), which `content` omits so the
    // user's own bubble stays clean.
    // `reminderText` and `reminder` ride along: the first is text the model has already been shown, so losing it would change
    // this turn's bytes on the next send; the second is what the compaction fold reads to reconstruct standing state, so losing
    // it would make the next send re-emit everything (see docs/cache-stable-prompt-context.md).
    const userText = m.wireText ?? m.content;
    const extras = {
      ...(m.reminderText ? { reminderText: m.reminderText } : {}),
      ...(m.reminder ? { reminder: m.reminder } : {}),
    };
    if (m.images?.length) {
      return {
        role: "user",
        content: [
          ...(userText ? [{ type: "text" as const, text: userText }] : []),
          ...m.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
        ...extras,
      };
    }
    return { role: "user", content: userText, ...extras };
  });
  return [...restoredSystem, ...restored];
}

/**
 * Rebuild the transcript on screen.
 *
 * Tool result messages become tool bubbles, with their arguments taken from the corresponding assistant
 * tool_call; an assistant message that only issues tool calls and has no body is skipped, because its trace is
 * already reflected by those bubbles.
 */
export function restoreDisplay(conv: StoredConversation): DisplayMsg[] {
  // Rebuild the display: tool result messages are restored as tool bubbles (arguments taken from the corresponding assistant tool_call); an assistant message that only issues
  // tool calls and has no body is skipped in the display layer (its trace is reflected by the tool bubbles).
  const callArgs = new Map<string, { name: string; args: unknown }>();
  for (const m of conv.messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        let a: unknown = {};
        try {
          a = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* Invalid JSON arguments, display as an empty object */
        }
        // Resolved, for the same reason the tool result persists a resolved name: a call_tool entry would otherwise rebuild
        // the bubble with the dispatcher's own {name, arguments} envelope in place of the arguments the tool actually ran on.
        const { name: rn, args: ra } = resolveToolCall(tc.function.name, (a ?? {}) as Record<string, unknown>);
        callArgs.set(tc.id, { name: rn, args: ra });
      }
    }
  }
  const disp: DisplayMsg[] = [];
  conv.messages.forEach((m, mi) => {
    if (m.role === "user") {
      disp.push({ kind: "user", content: m.content, images: m.images, files: m.files });
    } else if (m.role === "tool") {
      const info = m.tool_call_id ? callArgs.get(m.tool_call_id) : undefined;
      disp.push({
        kind: "tool",
        name: m.name ?? info?.name ?? "tool",
        args: info?.args ?? {},
        ok: true,
        result: m.content,
        // Restore a generated image so it survives a conversation switch (persisted display-only, see StoredMessage.image).
        ...(m.image ? { image: m.image, servedBy: m.servedBy } : {}),
        // Same for a sub-agent's inner steps, so the reopened view matches what was shown live.
      });
    } else if (m.role === "assistant") {
      // The deep-thinking block is restored before this round's content / tool trace (consistent with the real-time order).
      if (m.reasoning) disp.push({ kind: "reasoning", content: m.reasoning, ms: m.thinkMs });
      // Final reply with no tool calls: the body is shown as-is. The body of a round that issued tool calls becomes that
      // round's thinking-process text — whole, chain of thought included (thinkingProcessText), matching the real-time
      // display. Daily-mode conversations used to skip it here, because their live view skipped it too; with the modes
      // merged the live view is always phased, so the rebuild is unconditional and old records now render the same way
      // a new one would.
      // storedIndex=mi + rating feed the action-bar rating: clicking persists it to that StoredMessage and highlights the chosen rating.
      if (m.content) {
        if (!m.tool_calls?.length) {
          disp.push({ kind: "assistant", content: m.content, rating: m.rating, storedIndex: mi });
        } else {
          // The body of a tool-call round: rebuilt as a "thinking process" entry (phase), consistent with the real-time
          // display — part of the stream, not a standalone block, and with no action bar (rating belongs to the final reply).
          const summary = thinkingProcessText(m.content);
          if (summary) disp.push({ kind: "phase", content: summary, ms: m.thinkMs });
        }
      }
    }
  });
  return disp;
}
