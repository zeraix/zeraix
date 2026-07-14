/** Message / tool-call / attachment / to-do types shared by the chat page (extracted from page.tsx). */

// ── OpenAI-compatible message / tool-call structures ──────────────────────────────────────────
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
/** Multimodal content part (OpenAI-compatible): plain text or an image (image passed as a data URL). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Pending-attachment type (implementation moved to @/lib/ai/attachments, shared by the home and chat pages). */
export type { Attachment } from "@/lib/ai/attachments";

export type ApiMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] } // an array of content parts when images are included
  // rating: in-memory-only user rating (thumbs up/down), derived from the archived StoredMessage.rating. Before sending,
  // injectRatingFeedback strips this field and inserts a feedback system message in its place; it is never sent to the provider over the wire and never enters the archived body.
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; rating?: "up" | "down" }
  | { role: "tool"; tool_call_id: string; content: string };
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

/** Display message (includes tool-call bubbles / choice cards). */
export type ChoiceMsg = {
  kind: "choice";
  id: number;
  question: string;
  options: string[];
  selected: string | null; // the selected option; null means not yet selected
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
  | { kind: "tool"; name: string; args: unknown; ok: boolean; result: string }
  | { kind: "todos"; todos: Todo[] } // the task list archived into the chat after the conversation ends
  | { kind: "usage"; prompt: number; completion: number; total: number; cached: number; estimated: boolean } // this round's token usage (cached = input tokens served from prefix cache)
  | ChoiceMsg;

/** To-do item (task list). */
export type TodoStatus = "pending" | "in_progress" | "completed";
export type Todo = { title: string; status: TodoStatus };
