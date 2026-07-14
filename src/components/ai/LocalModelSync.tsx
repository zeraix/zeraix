"use client";

/**
 * Global: mirror the local llama-server's status into the chat model list — add it to the list and set it as default when ready, remove it when stopped.
 * Mounted inside AgentShell (layout level, persists across /agent subpages), independent of the "model library / chat" page lifecycle:
 * after the user clicks start in the model library and switches to chat, the model only becomes ready ~8s later; if the registration logic lived only on the model library page, navigating away would lose the ready event.
 */
import { useEffect } from "react";
import { localLlm, activateLocalModel, deactivateLocalModel } from "@/lib/ai/localModel";

export default function LocalModelSync() {
  useEffect(() => {
    const bridge = localLlm();
    if (!bridge) return; // not Electron
    const register = (st: import("@/lib/ai/localModel").LocalLlmStatus) => {
      if (st.ready && st.model) {
        activateLocalModel({
          endpoint: st.endpoint,
          model: st.model.id ?? "local",
          label: st.model.label,
          multimodal: st.model.multimodal,
          contextWindow: st.model.ctx,
        });
      } else if (st.phase === "idle" && !st.running) {
        deactivateLocalModel();
      }
    };
    bridge.status().then(register); // backfill the current status on mount
    return bridge.onStatus(register);
  }, []);
  return null;
}
