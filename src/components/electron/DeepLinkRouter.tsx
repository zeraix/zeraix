"use client";

/**
 * Routes `zeraix://…` activations to the page they name.
 *
 * The preload has exposed `window.deepLink.onOpen` since the Google sign-in flow shipped, but
 * nothing in the renderer had ever subscribed to it: a link brought the window to the front and
 * then sat there on whatever page happened to be open. This is the subscriber.
 *
 * Mounted once in the agent shell so it survives navigation. Web builds have no bridge and mount a
 * no-op. Where the link only changes the fragment of the page we are already on, the hash is
 * assigned directly — router.push() to the same pathname would not re-run the page's hash effect.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { resolveDeepLink, type DeepLinkInfo } from "@/lib/deepLink";

declare global {
  interface Window {
    deepLink?: { onOpen: (cb: (info: DeepLinkInfo) => void) => () => void };
  }
}

export default function DeepLinkRouter() {
  const router = useRouter();

  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.deepLink : undefined;
    if (!bridge) return;
    return bridge.onOpen((info) => {
      const target = resolveDeepLink(info);
      if (!target) return;
      const [path, hash] = target.split("#");
      if (window.location.pathname === path) {
        // Same page: assignment fires hashchange, which is what the page listens to. Assigning the
        // hash it already has fires nothing, so clear it first — a link to the section you are on
        // should still scroll you to the group it names.
        if (hash && window.location.hash === `#${hash}`) window.location.hash = "";
        window.location.hash = hash ?? "";
      } else {
        router.push(target);
      }
    });
  }, [router]);

  return null;
}
