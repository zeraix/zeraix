/**
 * The goal evaluator — the independent judge of whether the goal's condition has been met.
 *
 * Deliberately a SEPARATE model call from the agent's own loop, and the only thing allowed to declare a goal
 * achieved. An agent grading its own homework is the failure this whole mechanism exists to prevent: it has
 * every incentive to read a partial result as a finished one, and it knows what it intended, which is exactly
 * what a verifier must not know. This call gets the transcript and nothing else.
 *
 * Three properties are load-bearing:
 *
 *  - **No tools.** `requestChat` is called with no tool array, so `tool_choice` is never set and the evaluator
 *    structurally cannot run a command, read a file or change anything. It judges only what the conversation
 *    already shows.
 *  - **Structured answer.** Strict JSON `{ met, reason }`, not prose. A free-form verdict would have to be
 *    parsed by heuristics, and "it looks like it's mostly working" has no truth value the loop can act on.
 *  - **It can never wedge the loop.** Every failure path — bad JSON, a timeout, a network error, an empty reply
 *    — resolves to `{ ok: false }`, which the caller treats as NOT met. The loop keeps going, the UI says the
 *    check failed, and the user's next message is never blocked waiting on it.
 *
 * Built as a factory over the page's `requestChat`, exactly like the compaction summariser
 * (createSummarizeHistory): that inherits the proxy transport, the retry ladder, abort handling and the usage
 * log without this module knowing anything about providers.
 */

import { materializeReminders } from "./reminders";
import type { ApiMsg, ChatResponse, RequestLog } from "./types";

/** What the evaluator is asked to judge. */
export interface GoalEvalRequest {
  /** The condition, verbatim. */
  condition: string;
  /** The criteria the agent derived from it, if any. Advisory — the condition is what is being judged. */
  criteria: string[];
  /** Conclusions written back from sub-agents, which may pre-date compaction and not appear in the transcript. */
  established: string[];
  /** The turns to judge: the WIRE view since the goal was set, so it matches what the agent actually saw. */
  messages: ApiMsg[];
}

export interface GoalVerdict {
  met: boolean;
  reason: string;
  /**
   * The condition can never be satisfied — it contradicts itself, it depends on something that does not exist,
   * or a hard blocker no amount of further work can clear.
   *
   * Distinct from `met: false`, and the distinction is the point: not-met means keep going, impossible means
   * stop and say so. Without it the only exit from an unsatisfiable goal is the round cap, which spends the
   * user's entire budget discovering what the evaluator already knew on round one.
   */
  impossible?: boolean;
}

/**
 * Total by construction. `ok: false` is NOT a verdict — no verdict could be obtained. The caller must neither
 * complete the goal nor keep the loop running on it: an evaluator that is down would otherwise drive every
 * remaining round blind, which is how a transport failure turns into the user's whole token budget.
 */
export type GoalEvalOutcome =
  | { ok: true; verdict: GoalVerdict; tokens: number }
  | { ok: false; error: string; timedOut: boolean; tokens: number };

/** The page's requestChat, narrowed to what the evaluator needs. Mirrors summarize.ts. */
type RequestChat = (
  messages: ApiMsg[],
  tools?: unknown[],
  signal?: AbortSignal,
  onDelta?: (d: { content: string; reasoning: string }) => void,
  log?: RequestLog,
) => Promise<ChatResponse>;

/**
 * How much transcript the evaluator is given, as a fraction of ITS OWN context window.
 *
 * Half, not all: the condition, the criteria, the established facts and the evaluator's own instructions all
 * have to fit alongside it, and a request that overflows returns nothing at all rather than a slightly worse
 * verdict. Expressed against the evaluator's window rather than the session model's because the two need not
 * be the same model — pointing the check at a small fast one is the supported configuration, and it would be
 * handed a transcript sized for a 1M window otherwise.
 */
export const TRANSCRIPT_BUDGET_FRACTION = 0.5;
/** Fallback when the caller cannot resolve a window. Deliberately conservative — a small model's window. */
const DEFAULT_BUDGET_CHARS = 24000;
/** Per tool result. Enough to show a test summary or an error, not a whole file. */
const MAX_TOOL_CHARS = 2000;

/**
 * Render turns as a plain transcript for the evaluator.
 *
 * Reminders are folded in first, because they are part of what the agent was shown — including the GOAL block
 * itself, which tells the evaluator what the agent was working against. Tool results are truncated hard: the
 * evaluator needs to see THAT a check ran and what it said, not to re-read the codebase.
 */
function renderTranscript(msgs: ApiMsg[], budgetChars: number): string {
  const lines: string[] = [];
  for (const m of materializeReminders(msgs)) {
    if (m.role === "user") {
      const txt =
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).filter(Boolean).join("\n");
      if (txt.trim()) lines.push(`[User] ${txt}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`[Assistant] ${m.content}`);
      for (const tc of m.tool_calls ?? []) {
        lines.push(`[Assistant ran] ${tc.function.name}(${(tc.function.arguments || "").slice(0, 300)})`);
      }
    } else if (m.role === "tool") {
      const c = typeof m.content === "string" ? m.content : "";
      lines.push(`[Result] ${c.length > MAX_TOOL_CHARS ? `${c.slice(0, MAX_TOOL_CHARS)}\n…[truncated]` : c}`);
    }
  }
  const text = lines.join("\n");
  if (text.length <= budgetChars) return text;
  // Keep the TAIL — the recent rounds are where the work that would satisfy the condition happened — and say
  // what the omission MEANS, not merely that it happened. An evaluator told only "earlier rounds omitted" will
  // still answer from what it can see; told that missing proof must read as not-met, it fails safe. The one way
  // truncation could produce a WRONG verdict rather than a cautious one is silence about it.
  return (
    "…[Earlier conversation omitted to fit your context window. Judge the condition against the transcript " +
    "below; if the evidence you need may be in the omitted part, answer not met with the reason " +
    '"insufficient evidence in transcript".]\n' +
    text.slice(-budgetChars)
  );
}

/**
 * The evaluator's instructions.
 *
 * Written to make the DEFAULT answer "not met". An evaluator that resolves doubt in favour of the agent turns
 * the whole loop into a formality, so the burden of proof sits explicitly on the transcript: an assertion is
 * not evidence, and an unrun check is not a passed one.
 */
const SYSTEM_PROMPT =
  "You are a strict goal evaluator for a coding agent. You are given a GOAL CONDITION and a transcript of what the " +
  "agent has done so far. Decide one thing: has the condition been met?\n\n" +
  "Rules:\n" +
  "1. Judge ONLY from the transcript. You cannot run commands, read files or check anything yourself.\n" +
  "2. Evidence is something the transcript SHOWS: a command that ran and its output, a file that was read, a test " +
  "that reported passing, a request that returned a status. The agent SAYING it did something, or saying it works, " +
  "is not evidence.\n" +
  "3. If the condition names a verification (tests pass, the build succeeds, an endpoint returns 401) and the " +
  "transcript does not show that verification actually running and succeeding, the condition is NOT met.\n" +
  "4. Partial progress is not met. Every part of the condition must hold.\n" +
  "5. When in doubt, answer not met. A wrong \"met\" ends the task prematurely; a wrong \"not met\" only costs " +
  "another round.\n" +
  "6. If the transcript does not contain the evidence either way — because it was truncated, or because the " +
  "work simply has not been done — answer not met with the reason \"insufficient evidence in transcript\". Do " +
  "not infer, and do not give the agent the benefit of the doubt.\n\n" +
  "Reply with STRICT JSON and nothing else — no prose, no markdown, no code fences:\n" +
  '{"met": true|false, "reason": "<one or two sentences>", "impossible": true}\n\n' +
  "When not met, the reason is read by the agent as its next instruction, so state specifically what is still " +
  "missing or unproven, not a general critique. Quote the transcript where you can — the command and its " +
  "output, the file and what it said — rather than characterising it.\n" +
  "Include \"impossible\": true ONLY when no amount of further work could satisfy the condition: it " +
  "contradicts itself, it depends on something that does not exist, or the transcript shows a blocker the " +
  "agent cannot clear (a missing credential only the user has, a service that is gone). It stops the task, so " +
  "a condition that is merely hard, slow or failing so far is NOT impossible — omit the field for those.";

/** The one-shot correction sent when the first reply was not usable JSON. */
const RETRY_PROMPT =
  'Your previous reply was not valid JSON. Reply with ONLY this, nothing else: {"met": true|false, "reason": "..."}';

/**
 * Pull a verdict out of a model reply.
 *
 * Exported for its own tests, because this is where a well-behaved loop meets a badly-behaved model. Handles
 * the three things models actually do to JSON: wrap it in a code fence, put prose around it, and answer with a
 * bare object embedded mid-sentence. Anything else returns null and the caller retries once.
 */
export function parseVerdict(raw: string): GoalVerdict | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  // Strip a fenced block if present, then take the first balanced-looking object. A regex is enough here: the
  // payload is two flat fields, so there is no nesting to get wrong.
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const candidates = [unfenced, text];
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
        const obj = JSON.parse(c.slice(start, end + 1)) as {
        met?: unknown;
        reason?: unknown;
        impossible?: unknown;
      };
      // `met` must be a real boolean. A string "true" or a missing field is a malformed answer, not a verdict —
      // coercing it would let a confused model complete a goal by accident.
      if (typeof obj.met !== "boolean") continue;
      const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
      // `impossible` ends the task, so it is honoured only as a literal true and only alongside not-met. A
      // "met AND impossible" answer is incoherent, and reading it either way would be guessing.
      const impossible = obj.impossible === true && obj.met === false;
      return { met: obj.met, reason: reason.slice(0, 600), ...(impossible ? { impossible: true } : {}) };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const usageTokens = (data: ChatResponse): number =>
  data.usage?.total_tokens ?? (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);

/**
 * Build the evaluator over a bound `requestChat`.
 *
 * The caller decides WHICH model that is: the page passes the conversation's own request function by default,
 * or one built for a separately configured evaluator model. Local setups care about this — asking a 30B for a
 * yes/no after every round is a visible stall — but it is a configuration question, not this module's.
 */
/**
 * How long the check may take before the turn stops waiting for it.
 *
 * A yes/no over a bounded transcript is seconds of work, so anything past this is a stall rather than slow
 * thinking — and the goal check sits between the model finishing and the user getting control back, so a
 * request that never returns holds the turn open indefinitely. Bounding it turns the worst case into one
 * amber notice instead of a hang.
 */
export const EVAL_TIMEOUT_MS = 30_000;

export interface GoalEvaluatorOptions {
  /** Characters of transcript the evaluator may be given. Derive it from ITS window; see TRANSCRIPT_BUDGET_FRACTION. */
  budgetChars?: number;
  timeoutMs?: number;
}

export function createGoalEvaluator(requestChat: RequestChat, opts: GoalEvaluatorOptions = {}) {
  const budgetChars = Math.max(2000, opts.budgetChars ?? DEFAULT_BUDGET_CHARS);
  const timeoutMs = opts.timeoutMs ?? EVAL_TIMEOUT_MS;

  return async (req: GoalEvalRequest, signal?: AbortSignal, log?: RequestLog): Promise<GoalEvalOutcome> => {
    const parts = [`GOAL CONDITION:\n${req.condition}`];
    if (req.criteria.length) {
      parts.push(`The agent derived these acceptance criteria from it:\n${req.criteria.map((c) => `- ${c}`).join("\n")}`);
    }
    if (req.established.length) {
      // Conclusions from delegated sub-agents. They may pre-date compaction and so be absent from the
      // transcript, while still being the reason a criterion is satisfied.
      parts.push(
        `Established earlier by delegated sub-agents (already accepted as fact):\n${req.established.map((e) => `- ${e}`).join("\n")}`,
      );
    }
    parts.push(`TRANSCRIPT:\n${renderTranscript(req.messages, budgetChars)}`);
    parts.push("Has the goal condition been met? Reply with the JSON object only.");

    const messages: ApiMsg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: parts.join("\n\n") },
    ];
    // Logged under its own actor: these tokens are the app's own housekeeping, and a usage report that folded
    // them into the answer the user asked for would misattribute every round of a long loop.
    const evalLog: RequestLog = log ?? { actor: "goal" };

    // The turn's own signal, plus a deadline of our own. Chained through one controller rather than
    // AbortSignal.any so the reason for the abort is knowable: a user cancel and a stalled evaluator produce
    // the same rejection otherwise, and they are reported to the user differently.
    const ctrl = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is RACED, not merely signalled. Aborting only ends the request if the transport honours the
    // signal, and "the transport is misbehaving" is exactly the case this bound exists for — a timeout that
    // depends on the thing it is protecting against is not a timeout. The abort still fires alongside, so the
    // in-flight request is cancelled rather than left running.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        reject(new Error("the goal check timed out"));
      }, timeoutMs);
    });
    const onOuterAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onOuterAbort);
    const ask = (m: ApiMsg[]) =>
      Promise.race([requestChat(m, undefined, ctrl.signal, undefined, evalLog), deadline]);

    let tokens = 0;
    try {
      const first = await ask(messages);
      tokens += usageTokens(first);
      const raw = first.choices?.[0]?.message?.content ?? "";
      const verdict = parseVerdict(raw);
      if (verdict) return { ok: true, verdict, tokens };

      // One retry, and only one. A model that ignores the schema twice will ignore it a third time, and the
      // loop must not spend the user's tokens discovering that on every round.
      if (ctrl.signal.aborted) {
        return { ok: false, error: timedOut ? "the goal check timed out" : "aborted", timedOut, tokens };
      }
      const second = await ask([
        ...messages,
        { role: "assistant", content: raw.slice(0, 500) },
        { role: "user", content: RETRY_PROMPT },
      ]);
      tokens += usageTokens(second);
      const retried = parseVerdict(second.choices?.[0]?.message?.content ?? "");
      if (retried) return { ok: true, verdict: retried, tokens };
      return { ok: false, error: "the evaluator did not return a usable verdict", timedOut: false, tokens };
    } catch (e) {
      // Network failure, provider error, deadline, user cancel — none of them is a verdict. The caller neither
      // completes the goal nor keeps driving it; see GoalEvalOutcome.
      return {
        ok: false,
        error: timedOut ? "the goal check timed out" : e instanceof Error ? e.message : String(e),
        timedOut,
        tokens,
      };
    } finally {
      clearTimeout(timer); // also stops `deadline` ever rejecting after we have returned
      signal?.removeEventListener("abort", onOuterAbort);
    }
  };
}
