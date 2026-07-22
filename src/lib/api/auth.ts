import { ILoginResponse } from "@/types/auth";
import request from "./request";
import { getStorage } from "@zzcpt/zztool";
import STORAGE from "@/constants/Storage";

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


export async function refreshCurrentUser(): Promise<{
  success: boolean;
  message: string;
  data?: {
    token: string;
    user: {
      id: string;
      phone: string;
      username?: string;
      shippingAddresses?: any[];
      certStatus: string;
      avatar: string;
      walletBalance: number;
    };
    member: {
      remainingCredits?: number | undefined;
      id: string;
      role: "admin" | "teacher" | "student";
      classId: string;
    };
    institution: {
      id: string;
      name: string;
      code: string;
    }
  };
}> {
  const currentToken = getStorage(STORAGE.userInfo)?.auth_token;
  return request("/auth/refresh-me", {
    method: "POST",
    body: JSON.stringify({
      token: currentToken
    }),
  });
}