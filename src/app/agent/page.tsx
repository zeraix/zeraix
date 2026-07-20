"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import AgentComposer from "@/components/layout/agent/AgentComposer";
import WorkdirSelector from "@/components/layout/agent/WorkdirSelector";
import { useAuthStore } from "@/store/authStore";
import { useAgentChatStore } from "@/store/agentChatStore";
import type { Attachment } from "@/lib/ai/attachments";
import { useT } from "@/lib/i18n";
import { useThemedLogo } from "@/hooks/useThemedLogo";

/** Return the i18n key for the greeting based on the current time. */
function greetingKey(): string {
  const h = new Date().getHours();
  if (h < 6) return "greeting.dawn";
  if (h < 12) return "greeting.morning";
  if (h < 14) return "greeting.noon";
  if (h < 18) return "greeting.afternoon";
  return "greeting.evening";
}

/**
 * New conversation home page: centered greeting + task input box.
 * After submitting, navigates to the conversation page carrying the first task.
 */
export default function AgentHomePage() {
  const router = useRouter();
  const { userInfo } = useAuthStore();
  const name = userInfo?.username || userInfo?.name || "April";
  const t = useT();
  const setPendingSend = useAgentChatStore((s) => s.setPendingSend);
  // In dev mode, block sending when no working directory is selected (reported by WorkdirSelector).
  const [blocked, setBlocked] = useState(false);
  const logoSrc = useThemedLogo();

  const handleSubmit = (text: string, attachments: Attachment[]) => {
    if (blocked) return; // Fallback: in dev mode a directory must be selected first (sending is already disabled at this point)
    // Stash the first message (with attachments) in the store; the conversation page auto-sends it after navigation.
    setPendingSend({ text, attachments });
    router.push("/agent/chat");
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-3xl">
        {/* Greeting */}
        <div className="mb-5 flex items-center gap-4">
          <Image
            src={logoSrc}
            alt="Zeraix"
            width={64}
            height={51}
            className="shrink-0"
          />
          <h2 className="text-[22px] font-bold leading-snug text-foreground">
            {t(greetingKey())} {name}
            <br />
            {t("home.welcome")}
          </h2>
        </div>

        {/* Task input box + working directory selection (chosen before entering the conversation) */}
        <AgentComposer autoFocus disabled={blocked} onSubmit={handleSubmit} />
        <WorkdirSelector onBlockingChange={setBlocked} />
      </div>
    </div>
  );
}
