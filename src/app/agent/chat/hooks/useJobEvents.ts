"use client";

import { useEffect, useRef } from "react";
import { onServiceEvent, type ServiceEvent } from "@/lib/ai/services";
import { onGenerationJobEvent, type GenerationJobEvent } from "@/lib/ai/generation/jobs";
import type { SandboxStatus } from "@/lib/ai/sandbox";
import { createJobHandlers, type JobHandlerDeps } from "../turn/jobEvents";
import type { DisplayMsg } from "../types";

export interface JobEvents {
  /** Job results that arrived mid-turn, per conversation, waiting for a tool result to ride back on. */
  pendingJobsRef: React.RefObject<Map<string, string[]>>;
  /** Background jobs a conversation has been promised a result from, but has not received yet. */
  awaitingJobsRef: React.RefObject<Map<string, number>>;
}

/**
 * Owns the bookkeeping for background jobs (`notify` commands, image / video generation) and the subscriptions
 * that deliver their results. What a result DOES when it lands is jobEvents.ts; this hook keeps the handlers
 * bound to the current render's `send`.
 *
 * `send` is passed as a lazy wrapper: the page's `send` comes from useChatSend, which is called after this hook
 * because it needs the two refs this hook returns. Only the call happens later, after the commit.
 */
export function useJobEvents({
  convIdRef,
  sandboxStatusRef,
  send,
  pushDisplay,
  enqueueMessage,
}: {
  convIdRef: React.RefObject<string | null>;
  sandboxStatusRef: React.RefObject<SandboxStatus | null>;
  send: JobHandlerDeps["send"];
  pushDisplay: (m: DisplayMsg) => void;
  enqueueMessage: JobHandlerDeps["enqueueMessage"];
}): JobEvents {
  /**
   * Job results that arrived mid-turn, per conversation, waiting for a tool result to ride back on.
   *
   * A ref rather than state: the tool loop reads it from closures that must see the current value the moment a
   * job reports, and nothing about it is rendered.
   */
  const pendingJobsRef = useRef(new Map<string, string[]>());

  /**
   * Background jobs this conversation has been promised a result from, but has not received yet.
   *
   * Incremented when the model starts a `notify` job, decremented when one reports back. It exists for the goal
   * loop: a turn that ends while a build is still running has nothing new to show, so evaluating it can only
   * produce "not met", and auto-continuing would burn rounds racing a job that was always going to take
   * minutes. Deferring instead costs nothing — the job's completion opens a turn of its own when it lands, and
   * THAT turn is evaluated.
   */
  const awaitingJobsRef = useRef(new Map<string, number>());
  /**
   * A `notify` background job finishing wakes the conversation back up. Same late-bound-ref shape as resendRef
   * and for the same reason: the subscription is mounted once, but it has to reach the CURRENT `send`.
   *
   * The event may land at any moment, including while a round is generating or while the user is reading a
   * different conversation — so it is routed exactly like a user message rather than sent straight out:
   * idle here → send now; busy → the FIFO queue drains it when this round ends; another conversation → the
   * queue holds it until that one is opened again. Nothing new has to be taught about concurrency.
   */
  const jobFinishedRef = useRef<(evt: ServiceEvent) => void>(() => {});
  /** Same late-bound shape, for jobs this renderer runs itself (image / video generation). */
  const generationJobFinishedRef = useRef<(evt: GenerationJobEvent) => void>(() => {});
  useEffect(() => onServiceEvent((evt) => jobFinishedRef.current(evt)), []);
  useEffect(() => onGenerationJobEvent((evt) => generationJobFinishedRef.current(evt)), []);

  // Refreshed after every render, for the same closure reason as resendRef (see useMessageActions).
  // Assigned in an effect rather than during render: a ref written while rendering is read by whatever
  // rendered first, and React may discard a render entirely. Both of these are only ever called from a
  // subscription — i.e. after the commit — so binding them post-commit changes nothing about which closure
  // the caller gets.
  useEffect(() => {
    // Both job handlers, rebuilt against this render's `send` (see jobEvents.ts).
    const jobs = createJobHandlers({
      convIdRef,
      sandboxStatusRef,
      pendingJobsRef,
      awaitingJobsRef,
      send,
      pushDisplay,
      enqueueMessage,
    });
    jobFinishedRef.current = jobs.onServiceJob;
    generationJobFinishedRef.current = jobs.onGenerationJob;
  }); // no dependency array: the bindings must be refreshed on EVERY render, which is the whole point

  return { pendingJobsRef, awaitingJobsRef };
}
