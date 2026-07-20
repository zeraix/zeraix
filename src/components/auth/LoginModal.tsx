"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toast } from "@/lib/toast";
import { loginWithGoogle } from "@/lib/api/auth";
import { googleSignIn, isGoogleSignInAvailable } from "@/lib/electron/googleAuth";
import { useT } from "@/lib/i18n";
import { useThemedLogo } from "@/hooks/useThemedLogo";
import { useLoginModalStore } from "@/store/loginModalStore";
import { useFinishLogin } from "./useFinishLogin";

/**
 * Global, on-demand login modal — Google sign-in only.
 *
 * Rendered once at the app root. It stays hidden until a gated action calls
 * `requireLogin()` (top-up, adding official models, generating official API keys).
 * On success it lands the session in place (no navigation) and resolves the
 * pending requireLogin() promise so the caller can proceed.
 */
export default function LoginModal() {
  const t = useT();
  const finishLogin = useFinishLogin();
  const open = useLoginModalStore((s) => s.open);
  const resolveLogin = useLoginModalStore((s) => s.resolveLogin);
  const [loading, setLoading] = useState(false);
  const logoSrc = useThemedLogo();

  const handleGoogleLogin = useCallback(async () => {
    if (loading) return;
    if (!isGoogleSignInAvailable()) {
      Toast.error(t("auth.googleDesktopOnly"));
      return;
    }
    setLoading(true);
    try {
      // 1) Native flow in the main process (system browser + loopback + PKCE) → Google ID token.
      const res = await googleSignIn();
      if (res.canceled) {
        Toast.info(t("auth.googleCanceled"));
        return;
      }
      if (!res.ok || !res.idToken) {
        Toast.error(t("auth.googleFailed"), res.error || t("auth.retry"));
        return;
      }
      // 2) Exchange the ID token for a site session (same payload as account login).
      const response = await loginWithGoogle(res.idToken);
      if (response.success && response.data) {
        // Land the session in place (no redirect) and settle the gated action.
        const ok = await finishLogin(response.data, { redirect: false });
        if (ok) {
          resolveLogin(true);
        } else {
          Toast.error(t("auth.loginFailed"), response.message || t("auth.loginFailedRetry"));
        }
      } else {
        Toast.error(t("auth.loginFailed"), response.message || t("auth.loginFailedRetry"));
      }
    } catch (error) {
      console.error("Google login failed:", error);
      Toast.info(t("auth.loginFailed"), t("auth.networkError"));
    } finally {
      setLoading(false);
    }
  }, [loading, finishLogin, resolveLogin, t]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && resolveLogin(false)}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader className="items-center text-center">
          <Image src={logoSrc} alt="Zeraix" width={44} height={40} priority className="mb-1" />
          <DialogTitle className="text-lg">{t("auth.loginRequired")}</DialogTitle>
          <DialogDescription>{t("auth.loginRequiredDesc")}</DialogDescription>
        </DialogHeader>

        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={loading}
          aria-label={t("auth.google")}
          className="mt-2 flex w-full items-center justify-center gap-3 rounded-2xl bg-surface-muted py-3.5 text-sm font-medium text-ink transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Image src="/google.svg" alt="" width={20} height={20} />
          )}
          <span>{t("auth.google")}</span>
        </button>
      </DialogContent>
    </Dialog>
  );
}
