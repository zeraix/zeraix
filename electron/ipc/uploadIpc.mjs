/**
 * OSS upload proxy IPC: renderer window.upload.putOSS -> main process PUTs to a presigned URL.
 *
 * In production the renderer origin is app://localhost, which the Alibaba Cloud OSS bucket's CORS rules usually do not include, so a direct browser PUT would be blocked by the CORS preflight;
 * instead the main process (Node, not subject to browser CORS) issues the PUT. data is an ArrayBuffer passed over IPC.
 */
import { ipcMain } from "electron";

export function registerUploadProxy() {
  ipcMain.handle("upload:put-oss", async (_e, { url, contentType, data }) => {
    try {
      const res = await fetch(url, {
        method: "PUT",
        body: Buffer.from(data),
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, error: e && e.message ? String(e.message) : String(e) };
    }
  });
}
