"use client";

import { useEffect, useRef, useState } from "react";
import {
  setSecureEnv as syncSecureEnv,
  onSandboxStatus,
  getSandboxStatus,
  getSandboxVmInfo,
  DEFAULT_SECURE_ENV,
  type SandboxStatus,
} from "@/lib/ai/sandbox";
import { useAgentChatStore } from "@/store/agentChatStore";

export interface SandboxEnv {
  /**
   * The live sandbox status. The ref feeds the system prompt describing the command-execution environment
   * (an async send loop must read the value that is current now, not the one its render captured); the state
   * drives the title-row status badge.
   */
  sandboxStatusRef: React.RefObject<SandboxStatus | null>;
  sandboxStatus: SandboxStatus | null;
  /** Incrementing it opens the sandbox startup dialog (clicking the top badge). */
  sandboxDialogTick: number;
  openSandboxDialog: () => void;
  /** The runtime environment has an updatable version (versions.json target ≠ downloaded) → badge hint. */
  vmUpdatable: boolean;
  /** Does THIS session run commands inside the sandbox VM, or directly on the host? */
  secureEnv: boolean;
  secureEnvRef: React.RefObject<boolean>;
  applySecureEnv: (next: boolean, opts?: { persist?: boolean }) => void;
}

/**
 * Owns the sandbox runtime status and this session's secure-environment switch.
 *
 * Secure environment is per session, not per project — see Conversation.secureEnv. A new session inherits the
 * project's most recent one, an existing session adopts whatever it recorded, and either way the state here is
 * the single source of truth that the header toggle renders, the main process is synced to, and
 * createConversation stamps onto a brand-new record.
 *
 * `activeConvId` / `activeProjectId` are passed in rather than subscribed to here, because the page already
 * subscribes to both and a second subscription would only add a render path for the same value.
 */
export function useSandboxEnv({
  convIdRef,
  activeConvId,
  activeProjectId,
}: {
  convIdRef: React.RefObject<string | null>;
  activeConvId: string | null;
  activeProjectId: string | null;
}): SandboxEnv {
  const sandboxStatusRef = useRef<SandboxStatus | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
  const [sandboxDialogTick, setSandboxDialogTick] = useState(0);
  const [vmUpdatable, setVmUpdatable] = useState(false);

  const [secureEnv, setSecureEnvState] = useState<boolean>(DEFAULT_SECURE_ENV);
  const secureEnvRef = useRef<boolean>(DEFAULT_SECURE_ENV);

  /**
   * Apply this session's secure-environment switch: remember it, mirror it to the main process, and read the status back.
   *
   * The read-back is what makes the change visible immediately — `active` flips to qemu/native as the main process re-routes,
   * and that value is what the header indicator shows and what buildReminderState turns into the command-environment change
   * event on the next turn. Without it the UI would keep showing the previous engine until some unrelated status push arrived.
   *
   * `persist` is false only for the initial adoption of a session's own setting: writing it straight back would dirty every
   * conversation merely by opening it. A real toggle, and a new session's inherited value, both persist.
   *
   * Idempotent by design. The inheritance effect below re-runs whenever the active project or a lazily loaded project's
   * conversations change, and most of those re-runs land on the value already in force; doing the work anyway would mean a
   * setState (and a render) per sidebar click for a switch that did not move. `syncedRef` — rather than just comparing to
   * `secureEnvRef` — is what still guarantees the FIRST call reaches the main process, even when the session's answer
   * happens to equal the initial state and the comparison alone would skip it.
   */
  const syncedRef = useRef(false);
  const applySecureEnv = (next: boolean, { persist = true }: { persist?: boolean } = {}) => {
    const persisting = persist && !!convIdRef.current;
    if (syncedRef.current && next === secureEnvRef.current && !persisting) return;
    syncedRef.current = true;
    secureEnvRef.current = next;
    setSecureEnvState(next);
    if (persisting) {
      useAgentChatStore.getState().setConversationSecureEnv(convIdRef.current!, next);
    }
    void syncSecureEnv(next)
      .then(() => getSandboxStatus())
      .then((st) => {
        if (st) {
          sandboxStatusRef.current = st;
          setSandboxStatus(st);
        }
      });
  };

  // Sandbox: subscribe to the main process's background initialization status (download runtime environment → start), writing to ref/state.
  // Presentation is handled by the startup progress dialog SandboxStartupDialog; the status also feeds environment-hint injection and the title badge.
  useEffect(() => {
    const apply = (st: SandboxStatus) => {
      sandboxStatusRef.current = st;
      setSandboxStatus(st);
    };
    getSandboxStatus().then((st) => st && apply(st)); // When the page mounts later than the main-process initialization, backfill the current status
    return onSandboxStatus(apply);
  }, []);

  // Whether the runtime environment has an updatable version (versions.json target version ≠ downloaded): re-checked as the sandbox phase changes, driving the badge's "updatable" hint.
  useEffect(() => {
    getSandboxVmInfo().then((i) => setVmUpdatable(!!i?.updatable));
  }, [sandboxStatus?.phase]);

  /**
   * Smart default for a session that does not exist yet: inherit the secure-environment switch from the project's most
   * recent session.
   *
   * Only ever runs with no active conversation — an existing session's own setting wins, and swapInConversation applies it.
   * Keyed on the active project as well, because "New chat" leaves the conversation null while the user goes on clicking
   * through projects in the sidebar, and each click changes which project's answer applies. Projects load lazily, so
   * secureEnvDefaultFor answers undefined until this one's conversations arrive and the app default stands in the meantime;
   * `loadedProjectIds` is in the dependency list so the answer is revised the moment it can be. That set, rather than
   * `conversations` itself, because the latter is a fresh array on every appended message — subscribing to it would
   * re-render this page on every streamed turn to re-decide something that cannot have changed.
   *
   * persist:false throughout — there is no record to write to yet. The value is stamped onto the record at createConversation.
   */
  const loadedProjectIds = useAgentChatStore((s) => s.loadedProjectIds);
  useEffect(() => {
    if (activeConvId) return;
    const store = useAgentChatStore.getState();
    applySecureEnv(store.secureEnvDefaultFor(activeProjectId) ?? DEFAULT_SECURE_ENV, { persist: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, activeProjectId, loadedProjectIds]);

  return {
    sandboxStatusRef,
    sandboxStatus,
    sandboxDialogTick,
    openSandboxDialog: () => setSandboxDialogTick((n) => n + 1),
    vmUpdatable,
    secureEnv,
    secureEnvRef,
    applySecureEnv,
  };
}
