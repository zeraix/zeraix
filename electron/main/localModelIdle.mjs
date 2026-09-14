/**
 * Releasing the local model while the app sits in the background, and keeping it when the window comes back.
 */
import * as localLlm from "../llm/localServer.mjs";
import { hasActiveLlmStreams } from "../ipc/llmIpc.mjs";

/**
 * Idle grace period before a hidden window releases the local model. Long enough that hiding and
 * reopening does not pay the multi-GB reload cost, short enough that a tray-resident app is not
 * quietly holding that memory for the rest of the session.
 */
const LOCAL_MODEL_IDLE_MS = 5 * 60 * 1000;
let localModelIdleTimer = null;

/**
 * The window just went to the background. Schedule release of the expensive resident cost: a
 * llama.cpp server parked in the tray means multiple GB held permanently on the user's machine,
 * which is exactly what makes people kill the process. It restarts on demand on next use.
 */
export function onWindowHidden() {
  clearTimeout(localModelIdleTimer);
  localModelIdleTimer = setTimeout(() => {
    // Never yank the model out from under a running generation -- an in-flight stream means the
    // user (or a scheduled automation) is still working, hidden window or not.
    if (hasActiveLlmStreams()) {
      onWindowHidden(); // still busy: re-arm rather than dropping the check entirely
      return;
    }
    try {
      localLlm.stop();
    } catch {
      /* ignore -- nothing running */
    }
  }, LOCAL_MODEL_IDLE_MS);
}

/** The window came back: cancel any pending local-model release. */
export function onWindowShown() {
  clearTimeout(localModelIdleTimer);
  localModelIdleTimer = null;
}
