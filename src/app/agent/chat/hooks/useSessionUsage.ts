"use client";

import { useRef, useState } from "react";
import type { DisplayMsg } from "../types";

type Usage = { prompt: number; completion: number; total: number; cached: number; estimated: boolean };

export interface SessionUsage {
  /** Accumulates every request of the current round (tool rounds and sub-agents included). Reset per round. */
  turnUsageRef: React.RefObject<Usage>;
  /** Wall-clock start of the current round, stamped where turnUsageRef is reset. */
  turnStartRef: React.RefObject<number>;
  /** The whole session's accumulation, shown in the header. */
  sessionUsage: Usage;
  /** Input tokens of the most recent request — the compressed wire size the usage ring shows. */
  contextTokens: number;
  contextTokensRef: React.RefObject<number>;
  setCtxTokens: (n: number) => void;
  /** A new or emptied conversation: the round, the session and the context usage all back to zero. */
  resetUsage: () => void;
  /** A round is starting: zero its usage and start its clock. */
  beginTurnUsage: () => void;
  /**
   * A round is over: hand its usage row to `show`, and add it to the session total. Does nothing when the round
   * made no request that reported (or estimated) usage.
   */
  recordTurnUsage: (show: (row: DisplayMsg) => void) => void;
}

/** Owns the token accounting: this round's usage, the session's, and the current context size. */
export function useSessionUsage(): SessionUsage {
  // Token usage: turnUsageRef accumulates all requests of "this round" (including tool rounds and subagents); sessionUsage is the whole-session accumulation.
  // estimated indicates that part of this round / session was estimated with tiktoken (the provider did not return usage).
  const turnUsageRef = useRef({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false });
  // Wall-clock start of this round, stamped where turnUsageRef is reset so the reported duration spans exactly the
  // same window as the token accounting: from send until the loop settles, including every tool round and subagent.
  const turnStartRef = useRef(0);
  // Current context usage (the input tokens of the most recent request = the compressed wire size), drives the usage progress bar above the input box.
  // Mirror the latest value in a ref, to ease snapshotting the current usage when switching conversations (the state in a closure may be stale).
  const [contextTokens, setContextTokens] = useState(0);
  const contextTokensRef = useRef(0);
  const setCtxTokens = (n: number) => {
    contextTokensRef.current = n;
    setContextTokens(n);
  };
  const [sessionUsage, setSessionUsage] = useState({
    prompt: 0,
    completion: 0,
    total: 0,
    cached: 0, // Accumulated input tokens served from the prefix cache
    estimated: false,
  });

  const resetUsage = () => {
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false };
    setSessionUsage({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false }); // Reset the session token stats
    setCtxTokens(0); // New conversation: context usage back to zero
  };

  const beginTurnUsage = () => {
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false }; // Reset this round's usage
    turnStartRef.current = Date.now(); // Start this round's clock (paired with the usage reset above)
  };

  const recordTurnUsage = (show: (row: DisplayMsg) => void) => {
    // Show this round's token usage (including tool rounds / subagents), and add it to the session total.
    const u = turnUsageRef.current;
    // Wall-clock time for the whole round. Measured when the turn's `finally` calls this, so it covers the normal path,
    // an error, and a user cancel alike — i.e. it always reflects how long the user actually waited.
    const elapsedMs = turnStartRef.current > 0 ? Date.now() - turnStartRef.current : 0;
    if (u.prompt > 0 || u.completion > 0 || u.total > 0) {
      const total = u.total || u.prompt + u.completion;
      show({
        kind: "usage",
        prompt: u.prompt,
        completion: u.completion,
        total,
        cached: u.cached,
        estimated: u.estimated,
        elapsedMs,
      });
      setSessionUsage((s) => ({
        prompt: s.prompt + u.prompt,
        completion: s.completion + u.completion,
        total: s.total + total,
        cached: s.cached + u.cached,
        estimated: s.estimated || u.estimated,
      }));
    }
  };

  return {
    turnUsageRef,
    turnStartRef,
    sessionUsage,
    contextTokens,
    contextTokensRef,
    setCtxTokens,
    resetUsage,
    beginTurnUsage,
    recordTurnUsage,
  };
}
