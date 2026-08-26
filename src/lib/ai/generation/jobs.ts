/**
 * Generation jobs that outlive the turn that asked for them.
 *
 * Video generation takes minutes on every vendor. Awaiting it inside the tool call — which is what the first
 * implementation did — holds the whole turn open: the model cannot act, the user cannot be answered, and the
 * only thing anyone can do is watch a spinner and wonder whether it has hung. The work is genuinely
 * asynchronous, so the turn should not pretend otherwise.
 *
 * This is the same shape `run_command` with `notify` already has: start the work, hand back an
 * acknowledgement, and deliver the result when it arrives. It is a separate module rather than an extension
 * of `services.ts` because these jobs are not processes — a service event comes from the Electron main
 * process over a bridge, while a generation job is an HTTP poll living in the renderer. Sharing the event
 * type would mean pretending a poll loop has a pid and an exit code.
 *
 * What IS shared, deliberately, is the delivery discipline: the host decides between "ride the next tool
 * result" and "open a new turn" by exactly the rule it already uses for background commands, because the
 * failure that rule exists to prevent — a finished job stranded in a queue nobody reads until the turn ends —
 * is identical here.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A job belongs to a CONVERSATION, not to a turn. The turn that started it is typically long over by the time
 * it lands, so a job must not be cancelled when its turn ends — only when the conversation is cleared, or the
 * user explicitly stops. That is the whole point of moving it out here, and it is why the turn's AbortSignal
 * is deliberately not used.
 */
import { generate } from "./index";
import { modelPathFor, storeArtifact } from "@/lib/ai/mediaLibrary";
import type { CapabilityId, GenerationArtifact, GenerationError } from "./types";

export interface GenerationJob {
  id: string;
  convId: string;
  capability: CapabilityId;
  prompt: string;
  startedAt: number;
}

export type GenerationJobEvent =
  | {
      job: GenerationJob;
      status: "succeeded";
      artifact: GenerationArtifact;
      elapsedMs: number;
      /** Absolute host path of the stored copy, when the save succeeded. The model is told a name derived
       *  from it — without this the clip exists on disk and nothing can say where, so "add subtitles to that
       *  video" has nowhere to start. */
      path?: string;
    }
  | { job: GenerationJob; status: "failed"; error: GenerationError; elapsedMs: number };

type Listener = (evt: GenerationJobEvent) => void;

const listeners = new Set<Listener>();
/** Live jobs, so a conversation can be told what it is waiting on and can cancel it. */
const running = new Map<string, { job: GenerationJob; abort: AbortController }>();

/** Subscribe to job completions. Returns an unsubscribe function, matching `onServiceEvent`'s shape. */
export function onGenerationJobEvent(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * A listener that throws must not take down the others, or one rendering bug would silently strand every
 * later job. The error is reported rather than swallowed, because a listener that always throws is a bug
 * someone needs to see.
 */
function emit(evt: GenerationJobEvent): void {
  for (const cb of [...listeners]) {
    try {
      cb(evt);
    } catch (e) {
      console.error("[generation-job] a listener threw; other listeners are unaffected", e);
    }
  }
}

/**
 * Every job still running, oldest first.
 *
 * The library shows in-flight generations alongside finished assets, and it is not scoped to a conversation —
 * a video started in one chat is still the user's video while they are looking at another.
 */
export function allJobs(): GenerationJob[] {
  return [...running.values()].map((r) => r.job).sort((a, b) => a.startedAt - b.startedAt);
}

/** Jobs still running for a conversation, oldest first. */
export function jobsFor(convId: string): GenerationJob[] {
  return [...running.values()]
    .filter((r) => r.job.convId === convId)
    .map((r) => r.job)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Cancel a conversation's jobs.
 *
 * Called when the conversation is cleared or deleted — NOT when a turn ends. A cancelled job emits nothing:
 * the conversation it would report to is the one being torn down, and waking it back up is the opposite of
 * what clearing it asked for.
 */
export function cancelJobsFor(convId: string): number {
  const mine = [...running.entries()].filter(([, r]) => r.job.convId === convId);
  for (const [id, r] of mine) {
    r.abort.abort();
    running.delete(id);
  }
  return mine.length;
}

/**
 * Start a generation job and return immediately.
 *
 * The returned job is an acknowledgement, not a result. `generate` is called exactly as the blocking path
 * called it — this module changes WHEN it is awaited, not what it does, so the adapter, the poll loop and
 * every error path stay in one implementation.
 */
export function startGenerationJob(input: {
  convId: string;
  capability: CapabilityId;
  prompt: string;
  chatProviderId?: string;
  /** Injected so tests need no clock; the host passes Date.now. */
  now?: () => number;
}): GenerationJob {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const job: GenerationJob = {
    // Counter-free and collision-safe enough for a per-session map, and readable in a log.
    id: `gen_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    convId: input.convId,
    capability: input.capability,
    prompt: input.prompt,
    startedAt,
  };
  const abort = new AbortController();
  running.set(job.id, { job, abort });

  void generate({
    capability: input.capability,
    prompt: input.prompt,
    chatProviderId: input.chatProviderId,
    signal: abort.signal,
  })
    .then(async (res) => {
      let stored: Awaited<ReturnType<typeof storeArtifact>> | null = null;
      // Cancelled while in flight: the map entry is gone, and so is the conversation that would hear about it.
      if (!running.has(job.id)) return;
      running.delete(job.id);
      if (res.ok) {
        // Stored BEFORE the event is emitted, and awaited.
        //
        // Every listener reacts to this event, and one of them re-reads the index to redraw the library. Doing
        // the write inside a listener instead — which is where it was — raced that read: the in-flight tile
        // disappeared (the job is no longer running) and no finished tile replaced it (the row was not written
        // yet), so a completed video vanished from the library until the page was reloaded.
        stored = await storeArtifact({
          src: res.artifact.src,
          mime: res.artifact.mime,
          origin: "generated",
          convId: job.convId,
          prompt: job.prompt,
        });
      }
      emit(
        res.ok
          ? {
              job,
              status: "succeeded",
              artifact: res.artifact,
              elapsedMs: now() - startedAt,
              ...(stored?.path ? { path: stored.path } : {}),
            }
          : { job, status: "failed", error: res.error, elapsedMs: now() - startedAt },
      );
    })
    .catch((e: unknown) => {
      if (!running.has(job.id)) return;
      running.delete(job.id);
      // `generate` returns typed failures rather than throwing, so reaching here means a defect rather than a
      // provider problem. Reported as a job failure regardless: a job that vanishes silently is worse than one
      // that reports an ugly message, because the conversation would wait for it for ever.
      emit({
        job,
        status: "failed",
        error: { kind: "unknown", message: e instanceof Error ? e.message : String(e) },
        elapsedMs: now() - startedAt,
      });
    });

  return job;
}

/** How the model is told a job finished. One wording, so the two delivery routes cannot describe it differently. */
export function describeJobResult(evt: GenerationJobEvent, sandboxed = false): string {
  const seconds = Math.round(evt.elapsedMs / 1000);
  if (evt.status === "failed") {
    return (
      `[${evt.job.capability} job failed after ${seconds}s] "${evt.job.prompt}"\n` +
      `The reason was: ${evt.error.message} (${evt.error.kind}). Tell the user plainly; do not silently retry.`
    );
  }
  // The stored copy is named the way the model can reach it — /assets in the sandbox, the host path natively.
  // Omitted rather than guessed when the save failed: a plausible-looking path it cannot open is worse than
  // being told there is no file.
  const shown = modelPathFor(evt.path ?? "", sandboxed);
  return (
    `[${evt.job.capability} job finished after ${seconds}s] "${evt.job.prompt}"\n` +
    "It is already displayed to the user — do not repeat the URL or embed it in markdown." +
    (shown
      ? ` The file is saved in the media library at ${shown} — use that exact path to process it further.` +
        " The library is READ-ONLY: to change the file itself, copy it into the working directory first and write the result there."
      : "")
  );
}
