/**
 * One sub-agent execution, read as a conversation.
 *
 * A delegation IS a conversation — a task given, work done, an answer returned — and it was already being
 * rendered as a bespoke list of rows that had to be kept looking like the chat page by hand. This turns the
 * execution record into the same `DisplayMsg[]` the chat page renders, so the Inspector's run view is not an
 * imitation of the transcript: it is the transcript component, given different messages. A change to how a
 * tool call or a reply is drawn reaches both, because there is only one renderer.
 *
 * Pure and JSX-free, so the mapping can be exercised from `node --test` rather than through a renderer —
 * the same reason `transcriptRows.ts` is its own module.
 */
import {
  isTerminal,
  type SubAgentExecution,
} from "@/lib/agent/subagentExecution";
import type { DisplayMsg } from "./types";

/**
 * The messages of one run.
 *
 * The shape mirrors what actually happened, in order: the task the sub-agent was given (its user turn), every
 * tool call it made (the thinking-process trace), and the conclusion it returned (its reply). A run still in
 * flight simply has no reply yet — which is exactly how the chat page renders a turn in progress, so the
 * running state needs no special case.
 *
 * A failure gets its conclusion from the error, because an execution that failed has no result and a page
 * that ended in silence would read as one that is still going.
 */
export function executionTranscript(ex: SubAgentExecution): DisplayMsg[] {
  const rows: DisplayMsg[] = [{ kind: "user", content: ex.task }];

  for (const call of ex.toolCalls) {
    rows.push({
      kind: "tool",
      name: call.name,
      args: call.args,
      // `ok` is meaningless while a call is in flight; `running` is what says so, and the transcript reads
      // that rather than inferring it from a result that has not arrived.
      ok: call.ok ?? true,
      result: call.output ?? "",
      running: call.ok === undefined,
      ms: call.durationMs,
    });
  }

  if (ex.error) {
    rows.push({
      kind: "assistant",
      content: ex.error.code ? `${ex.error.code}: ${ex.error.message}` : ex.error.message,
    });
  } else if (ex.result) {
    rows.push({ kind: "assistant", content: ex.result });
  }

  return rows;
}

/** Whether the run view should show the thinking dots: the same question the chat page asks of a turn. */
export function executionIsRunning(ex: SubAgentExecution): boolean {
  return !isTerminal(ex.status);
}
