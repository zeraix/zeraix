"use client";

import { useAuthStore } from "@/store/authStore";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { refreshTokenAction, getAuthToken } from "@/lib/actions/auth.actions";
import { getStorage, setStorage } from "@zzcpt/zztool";
import { hydrateAppConfig } from "@/lib/ai/appConfig";
import { ensurePlatformApiKey } from "@/lib/ai/models";
import GlobalNotifications from "@/components/layout/GlobalNotifications";
import UpdateNotifier from "@/components/layout/UpdateNotifier";
import LoginModal from "@/components/auth/LoginModal";
import { onNotificationNavigate } from "@/lib/electron/notification";

import { PUBLIC_PATHS } from "@/constants/PublicPaths";
import STORAGE from "@/constants/Storage";


export default function ClientRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  const router = useRouter();
  const pathname = usePathname();
  const { logIn, isLoggedIn } = useAuthStore();

  // Consolidate authentication checks into a single state: 'loading' | 'authenticated' | 'unauthenticated'
  const [authStatus, setAuthStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');

  /**
   * 1. Initialize authentication state (executed only once upon mounting at the root)
   */
  useEffect(() => {
    hydrateAppConfig(); // Ready to use upon startup: `app.config` (an INI file located in the same directory as the executable) is loaded into local storage, with the file serving as the source of truth.

    const initAuth = async () => {
      const token = getAuthToken();

      if (!token) {
        setAuthStatus('unauthenticated');
        return;
      }

      // Restore Zustand state
      const storage = getStorage(STORAGE.userInfo);
      if (storage) {
        logIn({ ...storage, name: storage.name });
      }
      
      setAuthStatus('authenticated');
    };

    initAuth();
  }, []);

  /**
  * The main process dispatches `route:navigate` when the user clicks an OS notification; the router is used here to handle the navigation. 
  * In non-Electron environments, `onNotificationNavigate` returns a no-op, so the effect produces no side effects. 
  */
  useEffect(() => {
    return onNotificationNavigate((route) => {
      if (route) router.push(route);
    });
  }, [router]);

  /**
   * 2. Session sync (no route guard).
   * Login is no longer a gate — guests can use the whole app. This effect only
   * keeps `authStatus` in sync with the presence of a token, so the periodic
   * refresh below runs when (and only when) there is a session to refresh, and
   * config-loading effects fire right after an in-place (modal) login.
   */
  useEffect(() => {
    if (authStatus === 'loading') return;

    const token = getAuthToken();
    if (token && authStatus !== 'authenticated') {
      setAuthStatus('authenticated');
    } else if (!token && authStatus !== 'unauthenticated') {
      setAuthStatus('unauthenticated');
    }
    // `isLoggedIn` is a dependency so an in-place (modal) login/logout — which sets
    // the token then flips the store flag — re-runs this and syncs authStatus,
    // rather than waiting for the next route change.
  }, [pathname, authStatus, isLoggedIn]);

  /**
   * 3. Execute once when the authentication status changes to `authenticated`: Synchronize existing official API keys from the server (do not generate new ones).
   */
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    // After app startup/login: `app.config` has been populated locally via `hydrateAppConfig`; if no official key exists locally, the server is queried for an existing key. 
    // If a key already exists, the process skips the network call; no new key is automatically generated.
    void ensurePlatformApiKey();
  }, [authStatus]);

  /**
   * 4. Refresh the token every 12 hours while a session exists.
   * On failure just clear the session (the user becomes a guest); never redirect.
   */
  useEffect(() => {
    if (authStatus !== 'authenticated') return;

    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const intervalId = setInterval(async () => {
      const result = await refreshTokenAction();
      if (!result.success) {
        setAuthStatus('unauthenticated');
      }
    }, TWELVE_HOURS_MS);

    return () => clearInterval(intervalId);
  }, [authStatus]);


  const isPublicPath = PUBLIC_PATHS.includes(pathname);

  // Global overlays. The notification bar is desktop + logged-in only, but the
  // login modal must always be mounted (guests trigger it via gated actions),
  // and the update prompt is ungated for the same reason — login is optional,
  // and guests need updates as much as anyone. It self-hides outside Electron.
  const overlays = (
    <>
      {authStatus === 'authenticated' ? <GlobalNotifications /> : null}
      <UpdateNotifier />
      <LoginModal />
    </>
  );

  // While still checking auth on a private path, render nothing to avoid mounting
  // a page that would trigger its own routing logic mid-check.
  if (authStatus === 'loading' && !isPublicPath) {
    return null;
  }

  // The legacy /app shell (main sidebar) has been removed; the surviving surfaces
  // (/agent's own AgentShell, /browser, /) render their own chrome. Everything is
  // just children + global overlays now.
  return (
    <>
      {children}
      {overlays}
    </>
  );
}