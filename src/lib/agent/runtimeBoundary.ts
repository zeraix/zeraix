/**
 * Runtime / UI boundary — the contract that lets the loop stop being a React component.
 *
 * Spec: docs/agent-runtime-loop.md §13, and §14's "page.tsx constructs this callback set and hands it to the
 * Runtime". This is the section the original spec was missing and, as M0 found (problem P4), it is where the
 * real risk lives.
 *
 * The problem it solves is specific. Two things in the current loop BLOCK on a human: a tool that needs
 * consent, and `ask_user`. Both are implemented as promises parked in React refs — `useConsentQueue`'s queue
 * and a `Map<number, {resolve}>` for choice cards — and resolved by a click handler somewhere else in the
 * component. That works, and it is why the loop cannot leave the component: the loop does not call a
 * function to ask a question, it reaches into component state and waits.
 *
 * So the boundary is not an abstraction for its own sake. It is the difference between "the Runtime awaits a
 * ref" and "the Runtime awaits a promise someone handed it", and only the second can run in a test, in a
 * sub-agent, or eventually outside Electron.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────────────────────
 *
 *  - **Cancellation.** §13 is explicit: page.tsx keeps owning the per-conversation `AbortController` map and
 *    the Runtime just accepts a signal, exactly as `requestChat` does today. Building a second cancellation
 *    mechanism is forbidden by §11, and there is nothing wrong with the existing one.
 *  - **Transport.** Model requests stay in `chatRequest.ts` with its three provider-rejection fallbacks.
 *  - **Rendering decisions.** The Runtime emits events describing what happened; it does not know that
 *    anything renders them. `onEvent` takes a discriminated union rather than a set of typed callbacks so a
 *    consumer that only cares about two event kinds does not have to supply stubs for six.
 *
 * ── Why storage is an interface ─────────────────────────────────────────────────────────────────────────────
 *
 * §13 asks for persistence to go through an explicit interface rather than `useAgentChatStore.getState()`
 * inline. That is not testability theatre: the store is a module-level singleton, so a test of the loop today
 * would mutate the real conversation store, and two tests running in the same process would see each other's
 * writes. An interface makes the loop's persistence observable and inert in tests, which is what §18's Test 7
 * (persistence round-trip) actually requires.
 */
import type { ApiMsg, ChoiceQuestion, ChoiceAnswer } from "@/app/agent/chat/types";
import type { AgentTurn, ToolResult } from "./turn";

/**
 * Something that happened, described without reference to how it is displayed.
 *
 * A union rather than a callback bag because the set will grow: §19 wants per-turn instrumentation and M3
 * will add stop-reason events, and each of those would otherwise be another optional method every consumer
 * has to know about. A consumer switches on `type` and ignores what it does not handle.
 */
export type RuntimeEvent =
  /** Streaming delta. Both fields are cumulative-so-far, matching what `onDelta` already provides. */
  | { type: "delta"; content: string; reasoning: string }
  /** A provider turn opened. */
  | { type: "turn-start"; turn: AgentTurn }
  /** A provider turn closed, with everything it produced. */
  | { type: "turn-end"; turn: AgentTurn }
  /** A tool is about to run. Emitted before execution so the UI can show it in flight. */
  | { type: "tool-start"; toolCallId: string; name: string; args: Record<string, unknown> }
  /** A tool finished. */
  | { type: "tool-end"; result: ToolResult }
  /** Human-readable progress, replacing the ad-hoc `setStatus` calls. Already-localised text. */
  | { type: "status"; text: string }
  /** The run ended, with the Stop Policy's reason (§11). */
  | { type: "stopped"; reason: StopReason; detail?: string };

/** §11's structured stop reasons. Fixed set: adding one is a deliberate change to the Stop Policy. */
export type StopReason =
  | "completed"
  | "max-turns"
  | "max-tool-calls"
  | "doom-loop"
  | "cancelled"
  | "error"
  | "context-limit";

/** What the Runtime needs to know before running a tool that requires consent. */
export interface ConsentRequest {
  name: string;
  args: Record<string, unknown>;
  /** Rendered diff preview, when the tool is a file mutation and one could be produced. */
  previewDiff?: string | null;
  /** A warning to show alongside the request (e.g. the target is known only from compressed history). */
  warning?: string | null;
  /**
   * Set when a sub-agent is the caller, so the panel can name it.
   *
   * Its presence also means the "don't ask again" allowance must be bypassed: that answer was given about
   * work the user requested and was watching, and inheriting it would silently make sub-agents more powerful
   * than the agent in front of the user. The implementation must preserve that; it is a safety property, not
   * a UI detail.
   */
  requester?: { agentId: string; task: string } | null;
}

/** "always" is "yes, and stop asking for this tool in this conversation". */
export type ConsentDecision = "yes" | "no" | "always";

/**
 * How the Runtime writes through. Every method is fire-and-forget from the loop's point of view.
 *
 * Deliberately narrow: this is what the loop actually persists today, and nothing more. A wider interface
 * would invite the loop to own storage concerns that belong to the store.
 */
export interface RuntimeStorage {
  /** Append one message to the conversation; returns the index it landed at, which sub-agent traces need. */
  appendMessage(sessionId: string, msg: ApiMsg & { name?: string; ts?: number }): number;
  /** Attach a model-facing reminder to an already-persisted message (see reminders.ts). */
  setMessageReminder(sessionId: string, index: number, reminderText: string): void;
  /** Mark the conversation as generating / idle, which drives the sidebar spinner. */
  setGenerating(sessionId: string, generating: boolean): void;
}

/**
 * Everything the Runtime needs from whoever is hosting it.
 *
 * `page.tsx` builds one of these from its existing refs and state (§14). A test builds one from plain
 * functions. Neither the Runtime nor this file knows which it got.
 */
export interface RuntimeBoundary {
  /** Cancellation, owned by the caller. §13 is explicit that the Runtime only accepts a signal. */
  signal: AbortSignal;
  /** Everything observable. Never throws — a consumer that throws must not be able to break a turn. */
  onEvent(event: RuntimeEvent): void;
  /**
   * Ask the user to approve a tool call, and wait.
   *
   * Rejecting is a normal answer ("no"), not an error: the loop continues with a refusal as the tool result,
   * which is how the model learns it may not do that. Only cancellation aborts.
   */
  requestConsent(req: ConsentRequest): Promise<ConsentDecision>;
  /**
   * Ask the user a question (`ask_user`) and wait for the card to be submitted.
   *
   * Resolves with the TEXT to feed back to the model, not with structured answers. That is deliberate: how an
   * answer reads depends on whether the question was multi-select and whether the user flagged it for
   * discussion, which is the host's knowledge, and the Runtime's only use for the result is as a tool result.
   * Returning structured answers would oblige every host to agree on a formatting convention the Runtime
   * would then have to apply — and would let a host return answers that never appeared on any card.
   *
   * May never resolve if the user simply does not answer — that is correct, and it is why the signal exists.
   * Settling it on cancel or on a conversation switch is the HOST's job, not the Runtime's: page.tsx already
   * does this in `dropChoicesFor`, which resolves every parked promise with an explanation so the loop
   * unwinds instead of hanging. The Runtime never calls that; it just has to tolerate its promise being
   * settled by someone else.
   */
  askUser(questions: ChoiceQuestion[]): Promise<string>;
  storage: RuntimeStorage;
}

/**
 * A boundary that answers everything itself and records what it was asked.
 *
 * The test double for §18. Not in a test file because the same double is used by every milestone's tests and
 * by anything that needs to drive the Runtime headlessly; duplicating it per test file is how two tests end
 * up asserting against subtly different fakes while both claiming to test the Runtime.
 *
 * Defaults are the permissive ones — consent granted, the first option chosen — because most scenarios are
 * not about the human. A scenario that IS about the human overrides them.
 */
export interface TestBoundaryOptions {
  signal?: AbortSignal;
  /** Decide per request. Default: approve everything. */
  onConsent?: (req: ConsentRequest) => ConsentDecision | Promise<ConsentDecision>;
  /** Answer per question. Default: pick the first option, or "" when a question offers none. */
  onAsk?: (questions: ChoiceQuestion[]) => ChoiceAnswer[] | Promise<ChoiceAnswer[]>;
}

export interface TestBoundary extends RuntimeBoundary {
  readonly events: RuntimeEvent[];
  readonly consentRequests: ConsentRequest[];
  readonly questions: ChoiceQuestion[][];
  /** Messages the Runtime persisted, in order — the assertion target for §18's Test 7. */
  readonly persisted: Array<{ sessionId: string; msg: ApiMsg & { name?: string; ts?: number } }>;
  /** Events of one kind, for readable assertions. */
  eventsOfType<T extends RuntimeEvent["type"]>(type: T): Extract<RuntimeEvent, { type: T }>[];
}


/**
 * The test double's rendering of an answered card.
 *
 * Deliberately simpler than the app's own formatting in `submitChoice` — a test asserting on this should be
 * asserting that the right question was asked and the right option chosen, not on prose. Anything depending
 * on the exact production wording belongs in a test of the host, not of the double.
 */
function formatAnswers(questions: ChoiceQuestion[], answers: ChoiceAnswer[]): string {
  return questions
    .map((q, i) => {
      const a = answers[i];
      if (!a) return `- ${q.question} → (unanswered)`;
      return a.discuss ? `- ${q.question} → discuss` : `- ${q.question} → ${a.value}`;
    })
    .join("\n");
}

export function createTestBoundary(opts: TestBoundaryOptions = {}): TestBoundary {
  const events: RuntimeEvent[] = [];
  const consentRequests: ConsentRequest[] = [];
  const questions: ChoiceQuestion[][] = [];
  const persisted: Array<{ sessionId: string; msg: ApiMsg & { name?: string; ts?: number } }> = [];
  // A never-aborting signal when the caller supplies none, so the common case needs no ceremony.
  const signal = opts.signal ?? new AbortController().signal;

  return {
    signal,
    onEvent(event) {
      events.push(event);
    },
    async requestConsent(req) {
      consentRequests.push(req);
      return opts.onConsent ? opts.onConsent(req) : "yes";
    },
    async askUser(qs) {
      questions.push(qs);
      // `discuss: false` is the default and is not incidental: an answer flagged for discussion tells the
      // model to stop and talk rather than act, which would change what every scenario does next.
      const answers = opts.onAsk
        ? await opts.onAsk(qs)
        : qs.map((q) => ({ value: q.options[0] ?? "", discuss: false }));
      return formatAnswers(qs, answers);
    },
    storage: {
      appendMessage(sessionId, msg) {
        persisted.push({ sessionId, msg });
        // The index within THAT session, matching what the real store returns — a global counter would hand
        // sub-agent traces the wrong index the moment two conversations persist in one test.
        return persisted.filter((p) => p.sessionId === sessionId).length - 1;
      },
      setMessageReminder() {},
      setGenerating() {},
    },
    get events() {
      return events;
    },
    get consentRequests() {
      return consentRequests;
    },
    get questions() {
      return questions;
    },
    get persisted() {
      return persisted;
    },
    eventsOfType(type) {
      return events.filter((e) => e.type === type) as never;
    },
  };
}
