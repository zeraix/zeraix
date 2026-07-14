"use client";

/**
 * 全局：把本地 llama-server 的状态镜像到聊天模型清单——就绪时加入清单并设为默认，停止时移除。
 * 挂在 AgentShell 里（layout 级，跨 /agent 子页面持续存在），独立于「模型库 / 聊天」页面生命周期：
 * 用户在模型库点启动后切到聊天，模型 ~8s 后才就绪；若注册逻辑只在模型库页，切走即丢失就绪事件。
 */
import { useEffect } from "react";
import { localLlm, activateLocalModel, deactivateLocalModel } from "@/lib/ai/localModel";

export default function LocalModelSync() {
  useEffect(() => {
    const bridge = localLlm();
    if (!bridge) return; // 非 Electron
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
    bridge.status().then(register); // 挂载时补齐当前状态
    return bridge.onStatus(register);
  }, []);
  return null;
}
