/**
 * Turning history into a summary — the model-facing half of context compaction.
 *
 * The planning half (what to cover, when to fire, how to fold the result back in) lives in
 * contextCompress.ts and in the page. This module owns only the two steps that talk to a model: rendering a
 * span of turns as a transcript, and asking the summariser to compress it.
 */
import { isUsageLogEnabledSync } from "@/lib/ai/usageLog";
import { findUnverifiedFacts } from "./contextDiag";
import { materializeReminders } from "./reminders";
import { parseSummaryWithTaskState, type ExtractedTaskState } from "./taskMemory";
import type { ApiMsg, ChatResponse } from "./types";

/** Render a span of history messages into a plain-text transcript for the "summarizer model" (tool results truncated, to control the summary input size). */
const renderTranscript = (msgs: ApiMsg[]): string => {
  // Reminders are part of what the model was shown, so the summariser sees them too — nothing is excluded from its input.
  msgs = materializeReminders(msgs);
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      // A multimodal turn used to collapse to the bare marker, throwing away the user's own question along with any change
      // event carried on that turn — so a nudge emitted on a message with an attached image vanished at compaction. Keep the
      // text parts and mark the images separately.
      const txt =
        typeof m.content === "string"
          ? m.content
          : m.content
              .map((p) => (p.type === "text" ? p.text : "[image]"))
              .filter(Boolean)
              .join("\n");
      lines.push(`[User] ${txt}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`[Assistant] ${m.content}`);
      for (const tc of m.tool_calls ?? [])
        lines.push(`[Assistant · tool call] ${tc.function.name}(${(tc.function.arguments || "").slice(0, 300)})`);
    } else if (m.role === "tool") {
      // No second truncation: tool results are already limited to ≤8000 chars by capToolOutput before entering convoRef,
      // so hand them to the summarizer as-is, ensuring the key analysis data enters the summary in full.
      const c = typeof m.content === "string" ? m.content : "";
      lines.push(`[Tool result] ${c}`);
    }
  }
  return lines.join("\n");
};

/** The page's requestChat, narrowed to what the summariser needs from it. */
type RequestChat = (
  messages: ApiMsg[],
  tools?: unknown[],
  signal?: AbortSignal,
  onDelta?: (d: { content: string; reasoning: string }) => void,
  log?: { actor: string; convId?: string; turnId?: string },
) => Promise<ChatResponse>;

export function createSummarizeHistory(requestChat: RequestChat) {
  /**
   * Call the current model to compress earlier history into a summary body (throws on failure; the caller
   * falls back to dedup-only). Counted toward this round's usage.
   * priorSummary (§8.1 incremental): when set, `msgs` is only the NEWLY-covered span and the model updates
   * the existing summary rather than re-summarising the whole span from scratch — far cheaper. When null,
   * `msgs` is the full covered span (from-scratch: first summary, or a B1 forced drift reset).
   */
  return async (
    msgs: ApiMsg[],
    signal?: AbortSignal,
    log?: { actor: string; convId?: string; turnId?: string },
    priorSummary?: string | null,
  ): Promise<{ summary: string; extracted: ExtractedTaskState | null }> => {
    const sys: ApiMsg = {
      role: "system",
      content:
        (priorSummary
          ? "You are a conversation summarizer maintaining a running summary. Below is the EXISTING summary of the earlier conversation, then ADDITIONAL newer conversation. Produce an UPDATED summary that folds the new content into the existing one, preserving everything important from BOTH — do not drop details already captured in the existing summary. "
          : "You are a conversation summarizer. Compress the following earlier AI-assistant conversation into a concise but information-complete summary, so the subsequent conversation can seamlessly continue the context. ") +
        "Be sure to preserve completely (better a bit long than to lose anything): " +
        "① the goal and key requirements of each user question; " +
        "② the conclusion / solution for each question — what was ultimately done and how it turned out; " +
        "③ the reasons and basis for reaching that conclusion and choosing that approach — why it was done this way, which alternatives were ruled out, and based on which findings; " +
        "④ key analysis findings and important data — do not just write \"read/checked some file\", write the concrete conclusions / key content / values derived from it; " +
        "⑤ the files / paths / commands involved; ⑥ what is done and what is still pending; ⑦ any pitfalls and caveats. " +
        "Do not fabricate information that did not appear; do not restate irrelevant intermediate steps sentence by sentence.\n\n" +
        // Compaction-time task-state extraction: the summary is lossy, so separately capture the DURABLE
        // mission state so it can be preserved verbatim even as this prose is later re-summarised.
        "After the summary, output a task-state capture wrapped EXACTLY in these markers, on their own lines:\n" +
        "<<<TASK_STATE>>>\n" +
        "{\"notes\": \"<a few sentences capturing the CURRENT MISSION found in this history: the overall goal, the plan/phases, any hard constraints the user stated, and key decisions and why>\", \"todos\": [{\"title\": \"...\", \"status\": \"pending|in_progress|completed\"}]}\n" +
        "<<<END_TASK_STATE>>>\n" +
        "Include only what is genuinely present as a durable plan / goal / constraint / decision (omit todos if none). If there is no clear mission or plan in this history, output {} between the markers. Output the summary first, then the markers.",
    };
    const transcript = renderTranscript(msgs);
    const user: ApiMsg = {
      role: "user",
      content: priorSummary
        ? `[Existing summary]\n${priorSummary}\n\n[Additional newer conversation]\n${transcript}`
        : transcript,
    };
    // Logged under the "compact" actor: these tokens are the app's own housekeeping, not the answer
    // the user asked for, and a usage report that hid them would under-count the turn.
    const data = await requestChat([sys, user], undefined, signal, undefined, log ?? { actor: "compact" });
    const raw = data.choices?.[0]?.message?.content ?? "";
    // Split the prose summary from the appended task-state JSON (pure helper; robust to malformed markers).
    const { summary, extracted } = parseSummaryWithTaskState(raw);
    if (!summary) throw new Error("Summary is empty");
    // C1 (error-hardening §9): advisory-only hallucination check — flag distinctive facts (paths / large
    // numbers) that appear in the summary but not in its source. Observability, gated to when diagnostics
    // are on; never rejects/retries or edits the summary (summaries legitimately omit facts).
    if (isUsageLogEnabledSync()) {
      const sourceText = typeof user.content === "string" ? user.content : "";
      const unverified = findUnverifiedFacts(summary, sourceText);
      if (unverified.length) {
        console.warn(
          `[compaction] summary has ${unverified.length} fact(s) absent from the source (possible hallucination): ${unverified.slice(0, 8).join(", ")}`,
        );
      }
    }
    return { summary, extracted };
  };
}
