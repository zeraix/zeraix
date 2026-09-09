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
 * rewritten directly — router.push() to the same pathname would not re-run the page's hash effect.
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
        // Same page: rewrite the fragment in place and fire the event the page listens to.
        // replaceState rather than assignment, so an activation leaves no history entry behind —
        // the settings back button is meant to leave settings in one press, not walk back through
        // every fragment that has been on screen. A link naming the fragment already showing is a
        // no-op either way: the page reads the hash, and that hash has not moved.
        const url = hash ? `#${hash}` : window.location.pathname + window.location.search;
        window.history.replaceState(window.history.state, "", url);
        window.dispatchEvent(new Event("hashchange"));
      } else {
        router.push(target);
      }
    });
  }, [router]);

  return null;
}
