/**
 * Google Sign-In IPC：渲染层 window.googleAuth.signIn → 主进程运行 RFC 8252 原生流程。
 *
 * 主进程独占 OAuth 所需的 Node/OS 能力（环回 http 服务、shell.openExternal、PKCE crypto）；
 * 渲染层只经此通道触发并拿到结果（id_token 或取消），再由渲染层 POST /auth/google。
 * 见 electron/services/googleAuth.mjs 与 docs/google-signin-frontend.md。
 */
import { ipcMain } from "electron";
import { runGoogleSignIn } from "../services/googleAuth.mjs";

export function registerGoogleAuth() {
  // 统一返回结构 { ok, idToken? , canceled? , error? }，渲染层据此走成功/取消/失败分支。
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
