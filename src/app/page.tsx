"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Root route: the product is usable without logging in, so `/` always lands on
 * /agent (as a guest when there's no session). Login is prompted on demand via
 * the global login modal, only for account-bound actions.
 */
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/agent");
  }, [router]);

  return (
    <div className="flex h-full w-full items-center justify-center bg-surface">
      <Loader2 className="h-6 w-6 animate-spin text-ink-subtle" />
    </div>
  );
}
