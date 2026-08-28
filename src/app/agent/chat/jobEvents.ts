import { isJobCompletion, describeJobEvent, formatJobMessage, type ServiceEvent } from "@/lib/ai/services";
import { describeJobResult, type GenerationJobEvent } from "@/lib/ai/generation/jobs";
import { isSandboxEngine, type SandboxStatus } from "@/lib/ai/sandbox";
import { useAgentChatStore } from "@/store/agentChatStore";
import type { Attachment, DisplayMsg } from "./types";

export interface JobHandlerDeps {
  /** The conversation currently on screen. */
  convIdRef: React.RefObject<string | null>;
  /** Whether commands run in the sandbox VM — it changes how a command's result reads. */
  sandboxStatusRef: React.RefObject<SandboxStatus | null>;
  /** Job results that arrived mid-turn, per conversation, waiting for a tool result to ride back on. */
  pendingJobsRef: React.RefObject<Map<string, string[]>>;
  /** Background jobs a conversation has been promised a result from, but has not received yet. */
  awaitingJobsRef: React.RefObject<Map<string, number>>;
  /** Open a new turn carrying the job's notice. */
  send: (opts: { text: string; attachments: Attachment[]; _fromQueue?: boolean }) => void;
  /** Draw a bubble in the conversation on screen. */
  pushDisplay: (m: DisplayMsg) => void;
  /** Park a notice on a background conversation's queue, to wake it when the user opens it. */
  enqueueMessage: (convId: string, text: string, attachments: Attachment[]) => void;
}

export interface JobHandlers {
  onServiceJob: (evt: ServiceEvent) => void;
  onGenerationJob: (evt: GenerationJobEvent) => void;
}

/**
 * What happens when a background job reports back.
 *
 * Both handlers pick between the same two routes, and picking the wrong one is what left a finished build
 * stranded in a visible queue while the turn that was waiting for it worked on blind:
 *
 *  - MID-TURN → the pending buffer, which the tool loop drains onto the very next tool result. The user queue
 *    cannot serve here: by construction it is not read until the turn ENDS, so a job that finishes during a
 *    turn is exactly the case it can never deliver. The model was told it may keep working after starting a
 *    `notify` job, so this is the normal case, not the edge one.
 *  - IDLE → straight into a new turn, which is what wakes the conversation back up.
 *
 * Built fresh after every render (see the ref hand-off in page.tsx) so the closures see the current `send`,
 * and only ever called from a subscription — i.e. after the commit.
 */
export function createJobHandlers(deps: JobHandlerDeps): JobHandlers {
  const {
    convIdRef,
    sandboxStatusRef,
    pendingJobsRef,
    awaitingJobsRef,
    send,
    pushDisplay,
    enqueueMessage,
  } = deps;

  /** One fewer job outstanding. Floored at zero: an event for a job started before this counter existed (or
   * in another conversation) must not push it negative and wedge the goal loop into deferring for ever. */
  const settleOne = (convId: string) => {
    const waiting = awaitingJobsRef.current.get(convId) ?? 0;
    if (waiting > 0) awaitingJobsRef.current.set(convId, waiting - 1);
  };

  const hold = (convId: string, notice: string) => {
    const held = pendingJobsRef.current.get(convId) ?? [];
    pendingJobsRef.current.set(convId, [...held, notice]);
  };

  const onServiceJob = (evt: ServiceEvent) => {
    if (!isJobCompletion(evt)) return;
    const convId = convIdRef.current;
    if (!convId) return;
    const notice = describeJobEvent(evt);
    settleOne(convId);
    if (useAgentChatStore.getState().generating[convId]) hold(convId, notice);
    else send({ text: formatJobMessage(notice), attachments: [], _fromQueue: true });
  };

  /**
   * A generation job finished (generation/jobs.ts).
   *
   * The difference from a command is that this job produces an ARTIFACT, so the clip is rendered and
   * persisted here before the model is told about it. Rendering it only when the model next speaks would
   * leave the user watching nothing while the thing they asked for sat in a variable.
   */
  const onGenerationJob = (evt: GenerationJobEvent) => {
    const convId = evt.job.convId;
    settleOne(convId);

    if (evt.status === "succeeded") {
      const isVideo = evt.job.capability === "video_generation";
      const bubble: DisplayMsg = {
        kind: "tool",
        name: evt.job.capability,
        args: { prompt: evt.job.prompt },
        ok: true,
        result: evt.artifact.src,
        ...(isVideo ? { video: evt.artifact.src } : { image: evt.artifact.src }),
        servedBy: evt.artifact.servedBy,
      };
      // Only the conversation on screen draws it; a background one is rebuilt from the store on switch,
      // which is why the persist below is not conditional.
      if (convId === convIdRef.current) pushDisplay(bubble);
      // NOT indexed here. The job runner stores and indexes the artifact before emitting this event, so by
      // the time any listener runs the library file is already current — doing it here raced the library's
      // own re-read and made a finished video vanish from it until the page was reloaded.
      useAgentChatStore.getState().appendMessage(convId, {
        role: "tool",
        content: evt.artifact.src,
        // No tool_call_id: this message answers no call. The turn that started the job has long since
        // closed its own tool_calls, and inventing an id here would pair this with a call that already has
        // a result — which the provider rejects on the conversation's next request.
        name: evt.job.capability,
        ...(isVideo ? { video: evt.artifact.src } : { image: evt.artifact.src }),
        servedBy: evt.artifact.servedBy,
        ts: Date.now(),
      });
    }

    const notice = describeJobResult(evt, isSandboxEngine(sandboxStatusRef.current?.active));
    if (useAgentChatStore.getState().generating[convId]) {
      hold(convId, notice);
    } else if (convId === convIdRef.current) {
      send({ text: formatJobMessage(notice), attachments: [], _fromQueue: true });
    } else {
      // A background conversation that is idle: queued rather than sent, so it wakes when the user opens it
      // instead of starting a turn in a conversation nobody is looking at.
      enqueueMessage(convId, formatJobMessage(notice), []);
    }
  };

  return { onServiceJob, onGenerationJob };
}
