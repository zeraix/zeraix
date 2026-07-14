/**
 * Renderer-layer wrapper for accessing Google sign-in.
 *
 * Exposed by preload as `window.googleAuth` (see electron/preload.cjs); under the hood the main process runs
 * the RFC 8252 native flow (system browser + loopback address + PKCE, see electron/services/googleAuth.mjs).
 * Only available in Electron; under browser / Web deployments `isGoogleSignInAvailable()` is false.
 *
 * This layer is only responsible for "obtaining the Google id_token"; the subsequent POST /auth/google and session
 * persistence are done by the caller (going through the exact same storage path as phone-number login), see docs/google-signin-frontend.md.
 */

/** Result after the main process runs the flow: on success carries idToken; user cancel sets canceled=true; failure carries error. */
export interface GoogleSignInResult {
  ok: boolean;
  idToken?: string;
  canceled?: boolean;
  error?: string;
}

interface GoogleAuthBridge {
  signIn(): Promise<GoogleSignInResult>;
}

declare global {
  interface Window {
    googleAuth?: GoogleAuthBridge;
  }
}

function bridge(): GoogleAuthBridge | null {
  if (typeof window === "undefined") return null;
  return window.googleAuth ?? null;
}

/** Whether the current environment provides Google sign-in (Electron only). */
export function isGoogleSignInAvailable(): boolean {
  return !!bridge();
}

/**
 * Start the Google sign-in flow. Returns { ok:false, error } outside Electron.
 * On success result.idToken is the Google-issued ID token, to be handed to the backend POST /auth/google.
 */
export async function googleSignIn(): Promise<GoogleSignInResult> {
  const b = bridge();
  if (!b) return { ok: false, error: "Google sign-in is only available in the desktop client" };
  try {
    return await b.signIn();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
