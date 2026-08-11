"use client";

import { useEffect, useState } from "react";
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
 * How often to re-check which greeting applies.
 *
 * A minute is far finer than the boundaries themselves (they are hours apart) and costs nothing, but
 * the interval alone is not enough: a laptop that sleeps through noon does not run timers while it is
 * asleep, so the visibility listener below re-checks on the way back as well.
 */
const GREETING_TICK_MS = 60_000;

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
  const refreshWallet = useAuthStore((s) => s.refreshWallet);
  // Seeded during render so the first paint is already correct; kept current by the effect below.
  const [greeting, setGreeting] = useState(greetingKey);
  // In dev mode, block sending when no working directory is selected (reported by WorkdirSelector).
  const [blocked, setBlocked] = useState(false);
  // Bumped on every send attempt made while blocked; WorkdirSelector replays its attention animation on each bump.
  const [nudge, setNudge] = useState(0);
  const logoSrc = useThemedLogo();

  /**
   * Pull the current user from the server.
   *
   * Nothing else on this route does. `SafetyRootLayout` restores the store from **localStorage** at
   * startup (`logIn({ ...storage })`) — a cache, not a fetch — and the only call that actually asks
   * the server is `refreshWallet` (POST /auth/refresh-me), which lives on the chat and wallet pages.
   * So this screen showed whatever was cached at the last login: a name changed elsewhere, or a
   * balance spent on another device, stayed wrong here until the user happened to open one of those
   * two pages.
   *
   * Safe to fire on mount: the action no-ops for guests, is throttled to one call every few seconds,
   * de-dupes concurrent calls, and swallows its own failures — a dead network leaves the last known
   * values on screen rather than blanking them.
   */
  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);

  /**
   * Re-check on the way back to the app, and while it sits open.
   *
   * This is a desktop app that stays open for days, so "fetch once on mount" is the same staleness
   * bug with a longer fuse — the interesting moment is when the user returns after doing something
   * else, which is exactly when the cached name and balance are most likely to have moved. The same
   * handler re-evaluates the greeting, because a machine resuming from sleep has usually crossed a
   * boundary and its timers did not run while it was asleep.
   */
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== "visible") return;
      setGreeting(greetingKey());
      void refreshWallet();
    };
    const tick = setInterval(() => setGreeting(greetingKey()), GREETING_TICK_MS);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [refreshWallet]);

  const handleSubmit = (text: string, attachments: Attachment[]) => {
    if (blocked) return; // Fallback: in dev mode a directory must be selected first (the composer routes these to onBlockedSubmit)
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
            {t(greeting)} {name}
            <br />
            {t("home.welcome")}
          </h2>
        </div>

        {/* Task input box + working directory selection (chosen before entering the conversation) */}
        <AgentComposer
          autoFocus
          blocked={blocked}
          onBlockedSubmit={() => setNudge((n) => n + 1)}
          onSubmit={handleSubmit}
        />
        <WorkdirSelector onBlockingChange={setBlocked} nudge={nudge} />
      </div>
    </div>
  );
}
