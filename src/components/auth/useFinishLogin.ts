"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { setStorage } from "@zzcpt/zztool";
import { Toast } from "@/lib/toast";
import { useAuthStore } from "@/store/authStore";
import { syncPlatformApiKeyFromServer } from "@/lib/ai/models";
import { useT } from "@/lib/i18n";
import STORAGE_KEY from "@/constants/Storage";
import type { ILoginData } from "@/types/auth";

/** Options for the shared login-landing routine. */
export interface FinishLoginOptions {
  /**
   * Navigate to /agent after a successful login. Defaults to `false`:
   * login now happens in-place via a modal, so the caller usually stays put.
   */
  redirect?: boolean;
}

/**
 * The single session-landing path (shared by every login method):
 * writes the token to localStorage / cookie, updates client state, validates the
 * session, syncs the official API key, and optionally navigates to /agent.
 * @returns finishLogin(data, opts): whether login succeeded (checkAuthStatus passed).
 */
export function useFinishLogin() {
  const router = useRouter();
  const t = useT();
  const { logIn, setUserInfo, checkAuthStatus } = useAuthStore();

  return useCallback(
    async (data: ILoginData, opts: FinishLoginOptions = {}): Promise<boolean> => {
      // Clear any stale cookie first.
      document.cookie =
        "token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.zeraix.com; Secure; SameSite=None";
      const { token, user } = data;
      // Persist the token to localStorage (setStorage already includes the auth_token field).
      setStorage(STORAGE_KEY.userInfo, {
        auth_token: token,
        ...data,
        ...user,
      });
      // Mirror the auth_token into a cookie on the zeraix domain.
      document.cookie = `token=${token}; path=/; domain=.zeraix.com; Secure; SameSite=None`;
      // Update client state.
      logIn({
        id: user.id,
        name: user.username,
        avatar: user.avatar,
      });
      setUserInfo({
        ...user,
        auth_token: token,
      });
      const resolve = await checkAuthStatus();
      if (resolve) {
        // After login, sync the official API key from the server (generate if missing),
        // persist locally and mirror to app.config; never block the flow.
        void syncPlatformApiKeyFromServer();
        Toast.success(t("auth.loginSuccess"));
        if (opts.redirect) router.replace("/agent");
        return true;
      }
      return false;
    },
    [router, t, logIn, setUserInfo, checkAuthStatus],
  );
}
