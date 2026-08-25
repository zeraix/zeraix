/**
 * Context manager — turning the conversation buffer into the array that goes on the wire.
 *
 * Spec: docs/agent-runtime-loop.md §10, §14. Milestone M5a.
 *
 * The buffer and the wire are not the same thing and never have been. The buffer is the faithful record —
 * every turn, every tool result, the app's own bookkeeping keys, the reasoning text — and it is what gets
 * persisted. The wire is what one particular model is allowed to see on one particular request: compacted,
 * with reminders folded into the text that carries them, with the bookkeeping stripped, with reasoning
 * replayed or withheld, and with images kept, downgraded or removed depending on what the provider will
 * accept.
 *
 * That transformation was six statements inline in the loop, re-run from scratch on every round (M0's
 * problem P6). Moving it here does three things: it becomes testable without a model, the loop stops
 * containing provider-specific image rules, and §10's distinction between static and dynamic context becomes
 * something the code can express rather than something the comments describe.
 *
 * ── Order is the whole specification ────────────────────────────────────────────────────────────────────────
 *
 * Every step here depends on the ones before it, and the reasons are not obvious from the names:
 *
 *  1. compaction FIRST, so that a stubbed tool result still carries the change event that rode on it;
 *  2. reminders folded AFTER compaction for the same reason, and after the summary fold so the banner stays
 *     adjacent to the text it summarises;
 *  3. bookkeeping stripped next — this is the only place `rating` and `reminder` are removed, and it has to
 *     happen after (2) has consumed the reminder;
 *  4. reasoning policy, which decides who gets replayed thinking;
 *  5. images, which is where provider capability finally enters;
 *  6. the system hoist, last, because it must see the final array.
 *
 * Reordering any pair of these produces a wire that still looks plausible and is subtly wrong, which is
 * exactly the kind of bug that survives review. The tests pin the order by asserting on outcomes that only
 * hold if it is respected.
 */
import type { ApiMsg } from "@/app/agent/chat/types";

/** What the wire needs to know about the model it is being built for. */
export interface WireModelContext {
  /** A local llama.cpp build: stricter chat template, cannot fetch remote images. */
  isLocal: boolean;
  /**
   * Whether images may be sent at all.
   *
   * Resolved by the caller through `modelAcceptsImages`, which answers "yes" unless the model is a local
   * build with no mmproj or a provider actually rejected images for it recently. So this strips only when we
   * KNOW it is needed rather than guessing and silently dropping the user's picture; if the guess is still
   * wrong in the permissive direction, `requestChat` retries without images and records the verdict.
   */
  acceptsImages: boolean;
  /** Replay past turns' reasoning text as context. The user's "send thinking as context" setting. */
  sendReasoningContext: boolean;
  /** For the log line when images are stripped; not used in any decision. */
  modelId?: string;
}

/**
 * The transformation steps, injected rather than imported.
 *
 * They live in `app/agent/chat/` (`contextCompress.ts`, `reminders.ts`, `wireHelpers.ts`) and are mature —
 * §10 and §17 both say to call into them rather than replace them. Taking them as parameters keeps this
 * module free of a dependency on the app layer and, more usefully, makes each step substitutable in a test so
 * the ORDER can be asserted independently of what any individual step does.
 */
export interface WireSteps {
  buildWireContext: (messages: ApiMsg[], compaction: unknown) => ApiMsg[];
  sanitizeToolCallPairs: (messages: ApiMsg[]) => ApiMsg[];
  materializeReminders: (messages: ApiMsg[]) => ApiMsg[];
  stripWireMetadata: (messages: ApiMsg[]) => ApiMsg[];
  applyReasoningPolicy: (messages: ApiMsg[], isLocal: boolean, sendContext: boolean) => ApiMsg[];
  stripAllImagesForText: (messages: ApiMsg[]) => ApiMsg[];
  stripRemoteImagesForLocal: (messages: ApiMsg[]) => ApiMsg[];
  hoistSystemToFront: (messages: ApiMsg[]) => ApiMsg[];
}

export interface PrepareWireOptions {
  model: WireModelContext;
  steps: WireSteps;
  /**
   * Called when images are about to be stripped from a request that had some.
   *
   * A callback rather than a `console.warn` inside the function, because this module must stay pure: the
   * event is worth reporting (the request goes out with the pictures replaced by "N image(s) omitted", the
   * model answers that it cannot see images, and nothing on screen says the app removed them) but deciding
   * WHERE to report it is the host's business.
   */
  onImagesStripped?: (modelId: string) => void;
}

/** Does this array carry any image part? Used only to decide whether the strip is worth reporting. */
export function hasImages(messages: ApiMsg[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === "image_url"),
  );
}

/**
 * Build the request array for one Provider Turn.
 *
 * Pure: same inputs, same output, no I/O, no clock. That is what makes it testable and what makes it safe to
 * call once per round — the cost is CPU over an array whose prefix is unchanged, which §10 notes and which a
 * later milestone can memoise now that there is one function to memoise.
 */
export function prepareWire(
  convo: ApiMsg[],
  compaction: unknown,
  { model, steps, onImagesStripped }: PrepareWireOptions,
): ApiMsg[] {
  // Compaction first, and tool-call pairing repaired on the way out: an assistant.tool_calls whose result is
  // missing makes the provider reject the entire conversation, which is how a turn interrupted by a crash
  // used to become an unreopenable one.
  let wire = steps.sanitizeToolCallPairs(steps.buildWireContext(convo, compaction));
  // Fold each turn's <system-reminder> block into its content — on this outgoing copy only, never on the
  // buffer or on disk.
  wire = steps.materializeReminders(wire);
  // Remove the app's own bookkeeping keys (rating, reminder). The only place either is stripped.
  wire = steps.stripWireMetadata(wire);
  // Replay thinking text: every turn to every model when the user turned "send thinking as context" on,
  // otherwise only to local models and only on the turns their chat template renders it back on.
  wire = steps.applyReasoningPolicy(wire, model.isLocal, model.sendReasoningContext);

  if (!model.acceptsImages) {
    // Known text-only: strip EVERY image part. Such a provider 400s on any image anywhere in the history,
    // including one sent turns ago to a different model.
    if (onImagesStripped && hasImages(wire)) onImagesStripped(model.modelId ?? "(no model)");
    wire = steps.stripAllImagesForText(wire);
  } else if (model.isLocal) {
    // Multimodal local model: keep inline base64 images, but downgrade remote http ones — llama cannot fetch
    // them, and a URL it cannot resolve is worse than a description of what was there.
    wire = steps.stripRemoteImagesForLocal(wire);
  }
  // Multimodal cloud model: images pass through untouched, which is why there is no third branch.

  // Local models only: strict llama.cpp chat templates reject a system message that is not at the very
  // front. Nothing appends trailing system messages any more, so this is a never-firing guard kept against
  // future callers — and it must run last, on the final array.
  if (model.isLocal) wire = steps.hoistSystemToFront(wire);
  return wire;
}
