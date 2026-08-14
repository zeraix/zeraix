/** Message / tool-call / attachment / to-do types shared by the chat page (extracted from page.tsx). */

// ── OpenAI-compatible message / tool-call structures ──────────────────────────────────────────
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
/** Multimodal content part (OpenAI-compatible): plain text or an image (image passed as a data URL). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Pending-attachment type (implementation moved to @/lib/ai/attachments, shared by the home and chat pages). */
export type { Attachment } from "@/lib/ai/attachments";

/**
 * Standing state carried by a change event, in structured form.
 *
 * The same information is ALSO rendered as a <system-reminder> block inside the turn's own content — that text is what the model
 * reads. This payload exists only so compaction can fold the state without re-parsing prose (see docs/cache-stable-prompt-context.md).
 * It is stripped from the wire before sending, so nothing the model needs may depend on it.
 *
 * Only "state" reminders carry a payload. Nudges are one-shot and describe no standing constraint, so they exist purely as text.
 */
export type ReminderState = {
  workdir?: string;
  /** Whether `workdir` is reachable as /workspace: in the sandbox it is, so the line says which of the two names to use.
   *  Always changes together with `env` (the two engines produce different text), so it never forms a delta on its own. */
  sandboxed?: boolean;
  /** Where run_command actually runs: the Linux sandbox, or the host directly. Flips when the VM comes up or falls back. */
  env?: string;
  ctx?: { date: string; model: string; tz: string };
  skills?: { id: string; description: string }[];
  disabledTools?: string[];
  task?: string;
};

export type ApiMsg =
  | { role: "system"; content: string }
  // reminderText: the <system-reminder> block(s) this turn carries, kept OUT of `content` and merged in only when the wire is
  //   built (materializeReminders). `content` therefore always means "what the user actually typed" / "what the tool returned",
  //   which is what the UI renders and what every content transform may safely rewrite.
  // reminder: structured copy of the standing state that block announces. Read only by the compaction fold.
  // Both are stripped before the request body is built.
  | { role: "user"; content: string | ContentPart[]; reminderText?: string; reminder?: ReminderState } // array content when images are included
  // rating: in-memory-only user rating (thumbs up/down), derived from the archived StoredMessage.rating. Before sending,
  // stripWireMetadata removes this field; it is never sent to the provider over the wire and never enters the archived body.
  // reasoning_content: the model's own thinking text. Carried on the buffer (so it survives a reload) and put on the wire by
  //   applyReasoningPolicy, which decides who receives it. By default: LOCAL models only, and only for the assistant turns
  //   after the last user query — that is exactly what a local chat template renders back into the prompt (Gemma reads
  //   `reasoning`/`reasoning_content`, Qwen only `reasoning_content`), so withholding it there would make the replayed
  //   prompt differ from what the model actually generated and break the cached prefix mid tool-loop. With the user's
  //   "send thinking as context" setting on (ThinkingConfig.sendContext), every turn keeps it for every model instead.
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; rating?: "up" | "down"; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string; reminderText?: string };
export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // Input tokens served from prefix cache (field names differ across providers; use whichever is present):
  prompt_cache_hit_tokens?: number; // DeepSeek
  prompt_cache_miss_tokens?: number; // DeepSeek
  prompt_tokens_details?: { cached_tokens?: number }; // OpenAI-compatible
};
export type ChatResponse = {
  choices?: Array<{
    message?: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      // The "deep thinking" body of reasoning models: Qwen / DeepSeek and others return it in a separate field (not content); field names vary, use whichever is present.
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
  }>;
  usage?: Usage; // OpenAI-compatible usage statistics
};

/** One tool call a sub-agent made inside its own loop, recorded so the user can see what it actually did
 *  rather than only the conclusion it reported back. Same four fields as a top-level tool bubble. */
export type SubAgentStep = { name: string; args: unknown; ok: boolean; result: string };

/** Display message (includes tool-call bubbles / choice cards). */
/** One question on a choice card. A card carries at least one; several are shown as tabs. */
export type ChoiceQuestion = {
  question: string;
  options: string[];
  /**
   * True when this question takes several options at once ("which of these do you want?") rather than
   * exactly one. Its options render as checkboxes, and the free-text box adds to the selection instead
   * of replacing it — in a multi-select question, typing is one more item, not a competing answer.
   */
  multiSelect?: boolean;
};

/** What the user picked for one question. `discuss` is the auto-appended "talk it through" escape. */
export type ChoiceAnswer = {
  value: string;
  discuss: boolean;
  /** True when the user typed the answer rather than picking one of the offered options. */
  custom?: boolean;
  /**
   * Multi-select only: every item picked, in the order the question offered them, with any typed text
   * last. `value` is these joined, so everything downstream that only wants a string — the submitted
   * summary, the text handed back to the model — keeps working without knowing about multi-select.
   */
  values?: string[];
};

/**
 * An ask_user card.
 *
 * Answers are held per question and are NOT final until the card is submitted: with several questions the
 * user moves between tabs and revises, and resolving the tool call on the first click would end the
 * interaction before they had answered the rest.
 */
export type ChoiceMsg = {
  kind: "choice";
  id: number;
  questions: ChoiceQuestion[];
  /** Parallel to `questions`; null where that question has not been answered yet. */
  answers: (ChoiceAnswer | null)[];
  /** True once the user has submitted. The card is read-only from then on. */
  submitted: boolean;
};
export type DisplayMsg =
  | {
      kind: "user";
      content: string;
      images?: string[]; // data URLs of attached images
      files?: { name: string; size: number; embedded: boolean }[]; // non-image attachments (embedded = content already inlined)
    }
  // rating: the user's rating of this reply (thumbs up/down), from StoredMessage.rating; storedIndex: its index in the session
  // messages array, used to persist the rating to the corresponding StoredMessage (only present for replies already written to disk).
  | { kind: "assistant"; content: string; rating?: "up" | "down"; storedIndex?: number }
  | { kind: "reasoning"; content: string } // the "deep thinking" body of reasoning models (collapsible; distinct from the "thinking process" tool trace)
  // Dev-mode "phase summary": the body of a tool-call round (after cleanup) — shown as one entry in the "thinking process" timeline,
  // collected into the same card alongside deep thinking / the tool trace rather than as its own separate block (avoids splitting one round into multiple "done" reply blocks).
  | { kind: "phase"; content: string }
  // `image` / `servedBy` are set by image_generation only: the artifact is rendered here, in the
  // display layer, and deliberately never enters the model's context (a base64 payload would be
  // re-sent every turn). `servedBy` names the engine because the vendor may differ from the chat
  // vendor — see docs/generation-capabilities-design.md §3.
  // `steps` is set by run_subagent only: the tool calls the sub-agent made inside its own loop. They are
  // nested in this one bubble rather than pushed as siblings, because the whole delegation is persisted
  // as a single tool message — sibling bubbles would exist live and then vanish on reload.
  | {
      kind: "tool";
      name: string;
      args: unknown;
      ok: boolean;
      result: string;
      image?: string;
      servedBy?: string;
      steps?: SubAgentStep[];
    }
  | { kind: "todos"; todos: Todo[] } // the task list archived into the chat after the conversation ends
  // this round's token usage (cached = input tokens served from prefix cache) + the wall-clock time it took
  | {
      kind: "usage";
      prompt: number;
      completion: number;
      total: number;
      cached: number;
      estimated: boolean;
      elapsedMs?: number;
    }
  | ChoiceMsg;

/** To-do item (task list). */
export type TodoStatus = "pending" | "in_progress" | "completed";
export type Todo = { title: string; status: TodoStatus };

/**
 * The run context for a single send (generation). send() and the tool executions / subagents it invokes share it, to support "background concurrent generation":
 *  - convId: the conversation this generation belongs to (captured stably, unchanged when switching conversations); always used for persistence;
 *  - signal: this run's own independent abort signal (one per conversation, mutually isolated);
 *  - push / status: view side effects that only actually affect the UI while convId is still the current active conversation, otherwise silent
 *    (a background conversation only persists to disk and never pollutes the display or state of the currently viewed conversation; it is rebuilt from the store by loadConversation when switched back to).
 */
export type RunCtx = {
  convId: string;
  /**
   * Identifies this one generation in the usage log. Every model call, tool call and delegation the
   * turn produces carries it, which is what lets the log viewer's timeline group a turn's spending
   * instead of showing a flat list of unrelated requests.
   */
  turnId: string;
  signal: AbortSignal;
  push: (m: DisplayMsg) => void;
  status: (s: string) => void;
};
