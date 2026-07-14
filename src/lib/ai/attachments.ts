/**
 * Shared model and handling logic for chat attachments (reused by the home page /agent and the chat page /agent/chat).
 *  - image  → uploaded to OSS to get a publicUrl, sent as multimodal image_url (requires a vision model);
 *  - text   → text-like files whose content is inlined into the prompt;
 *  - binary → binary/oversized files, only the filename is noted, content is not inlined.
 */
import { getUploadUrl, upLoadFileOSS } from "@/lib/api/upload";
import { getPathForFile } from "@/lib/ai/toolkit";

export type Attachment = {
  id: number;
  name: string;
  size: number;
  kind: "image" | "text" | "binary";
  url?: string; // image: the OSS publicUrl after a successful upload (HTTPS)
  text?: string; // text: the file's text content
  previewUrl?: string; // image: object URL for local preview (composer-only, revoked before sending)
  uploading?: boolean; // image: OSS upload in progress
  progress?: number; // image: upload progress 0-100
  uploadError?: boolean; // image: upload failed
  hostPath?: string; // binary: the real host path (Electron, captured on drag-in/selection); on send the file is copied to the working directory using this path
  file?: File; // The original File reference. binary: for synthetic files without a host path, bytes are read and written to disk via IPC on send; image: for local models, bytes are read and converted to base64 on send (previewUrl is revoked before sending, so it can't be relied on).
};

/** Attachment size limits: images go through multimodal (≤10MB); text-like files are inlined into the prompt with a stricter limit (≤2MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Human-readable file size. */
export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Upload a file to OSS and return the publicly accessible HTTPS link (publicUrl).
 *  Same upload flow as RobotChatInput: first get a presigned URL, PUT the upload, then use the publicUrl returned by the server. */
export async function uploadFileToOSS(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const { url: presignedUrl, contentType, publicUrl } = await getUploadUrl(file.name, true);
  if (!publicUrl) throw new Error("Server did not return the file's publicUrl");
  onProgress?.(30);
  const { ok } = await upLoadFileOSS(file, presignedUrl, contentType);
  if (!ok) throw new Error("OSS upload failed");
  onProgress?.(100);
  return publicUrl;
}

/** Unified handling for selected files: images are uploaded to OSS, text is read for inlining, binary/oversized files only carry the filename.
 *  Results are handed to the caller's state container via callbacks, so the home page and chat page can reuse it. */
export function addFilesTo(
  files: FileList | null,
  ctx: {
    nextId: () => number;
    push: (a: Attachment) => void;
    patch: (id: number, p: Partial<Attachment>) => void;
    onError: (msg: string) => void;
  },
): void {
  if (!files || files.length === 0) return;
  for (const file of Array.from(files)) {
    const id = ctx.nextId();
    const meta = { id, name: file.name, size: file.size };
    const hostPath = getPathForFile(file); // only present on Electron drag-in/selection; empty string for web / synthetic files
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_BYTES) {
        ctx.onError(`Image too large (>10MB), ignored 「${file.name}」.`);
        continue;
      }
      // Don't upload to OSS at attach time: defer until send and decide based on "whether the selected model is local" — local models inline base64 (privacy + offline,
      // never uploaded), while cloud models upload to OSS to get a publicUrl right before sending. Here we only set up a local preview placeholder and keep the file reference to read bytes at send time.
      const previewUrl = URL.createObjectURL(file);
      ctx.push({ ...meta, kind: "image", file, previewUrl });
    } else if (file.size > MAX_TEXT_BYTES) {
      ctx.push({ ...meta, kind: "binary", hostPath, file });
      ctx.onError(`「${file.name}」Exceeds 2 MB; content not inlined (filenames only).`);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? "");
        // Treat as binary if it contains NUL bytes, don't inline (avoids stuffing garbage into the prompt); record the host path for writing to disk on send.
        if (text.includes("\u0000")) ctx.push({ ...meta, kind: "binary", hostPath, file });
        else ctx.push({ ...meta, kind: "text", text });
      };
      reader.onerror = () => ctx.push({ ...meta, kind: "binary", hostPath, file });
      reader.readAsText(file);
    }
  }
}
