import { ILoginResponse } from "@/types/auth";
import request from "./request";

/**
 * Google sign-in: hand the Google ID token obtained by the main process to the backend to exchange for a site session.
 * The success payload is { token, user }, which the caller (useFinishLogin) uses to persist the session.
 * @param idToken the Google ID token obtained via the main process's RFC 8252 flow
 * @param inviteCode invite code (optional, for personal referrals)
 * @returns login result (includes token and user info)
 */
export async function loginWithGoogle(
  idToken: string,
  inviteCode?: string,
): Promise<ILoginResponse> {
  return request<ILoginResponse>(
    "/auth/google",
    {
      method: "POST",
      body: JSON.stringify({ idToken, inviteCode }),
    },
    { skipAuthRetry: true },
  );
}
