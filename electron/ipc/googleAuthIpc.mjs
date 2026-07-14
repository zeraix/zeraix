/**
 * Google Sign-In IPC: renderer window.googleAuth.signIn → main process runs the RFC 8252 native flow.
 *
 * The main process exclusively holds the Node/OS capabilities OAuth needs (loopback http server, shell.openExternal, PKCE crypto);
 * the renderer only triggers it through this channel and receives the result (id_token or canceled), then POSTs /auth/google itself.
 * See electron/services/googleAuth.mjs and docs/google-signin-frontend.md.
 */
import { ipcMain } from "electron";
import { runGoogleSignIn } from "../services/googleAuth.mjs";

export function registerGoogleAuth() {
  // Unified return shape { ok, idToken? , canceled? , error? }; the renderer branches on it for success/canceled/failure.
  ipcMain.handle("google-auth:signin", async () => {
    try {
      const result = await runGoogleSignIn();
      if (result?.canceled) return { ok: false, canceled: true };
      return { ok: true, idToken: result.idToken };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
