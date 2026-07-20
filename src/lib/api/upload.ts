import request from "./request";
import { GetUploadUrlResponse } from "@/types/upload";

/**
 * Main-process OSS upload proxy (Electron only; see electron/preload.cjs / main.mjs).
 * In production the renderer origin is app://localhost, which the OSS bucket's CORS rules usually don't include, so a direct browser PUT is blocked by the CORS preflight;
 * instead the main process (Node, not subject to browser CORS) issues the PUT.
 */
declare global {
  interface Window {
    upload?: {
      putOSS(p: { url: string; contentType: string; data: ArrayBuffer }): Promise<{
        ok: boolean;
        status: number;
        error?: string;
      }>;
    };
  }
}

/**
 * Get an OSS signed URL.
 * @param fileName file name
 * @param market
 * @returns
 */
export async function getUploadUrl(
  fileName: string,
  market: boolean = false,
): Promise<GetUploadUrlResponse> {
  return request<GetUploadUrlResponse>("/files/getUploadUrl", {
    method: "POST",
    body: JSON.stringify({ fileName, market }),
  });
}

/**
 * Upload a file to OSS (direct PUT to the presigned URL).
 *
 * Note: the frontend domain must be allowed in the Alibaba Cloud OSS bucket's CORS rules,
 * otherwise the browser will error out on CORS.
 *
 * @param file file
 * @param presignedUrl presigned URL
 * @param contentType file content type
 */
export async function upLoadFileOSS(
  file: File | Blob,
  presignedUrl: string,
  contentType: string,
): Promise<{ ok: boolean; url: string }> {
  // Validate parameters
  if (!file) {
    throw new Error("File must not be empty");
  }

  if (!presignedUrl || typeof presignedUrl !== "string") {
    throw new Error("Presigned URL must not be empty and must be a string");
  }

  if (!contentType || typeof contentType !== "string") {
    throw new Error("File content type must not be empty");
  }

  // Validate the URL format
  try {
    new URL(presignedUrl);
  } catch {
    throw new Error("Invalid presigned URL format");
  }

  console.log("Starting file upload to OSS:", {
    fileSize: file.size,
    contentType,
    presignedUrl: presignedUrl.substring(0, 100) + "...",
  });

  // Electron production: route the PUT through the main-process proxy to bypass the app:// origin's CORS preflight block (falls back to a direct fetch under Web deployments).
  const bridge = typeof window !== "undefined" ? window.upload : undefined;
  if (bridge) {
    try {
      const data = await file.arrayBuffer();
      const res = await bridge.putOSS({ url: presignedUrl, contentType, data });
      if (!res.ok) {
        throw new Error(`OSS upload failed: ${res.status} ${res.error ?? ""}`.trim());
      }
      const parsed = new URL(presignedUrl);
      return { ok: true, url: `${parsed.origin}${parsed.pathname}` };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error while uploading file to OSS";
      console.error("File upload to OSS failed (main-process proxy):", { error: errorMessage, fileSize: file?.size, contentType });
      throw new Error(errorMessage);
    }
  }

  try {
    // Direct PUT to the OSS presigned URL (Web deployment; requires the OSS bucket's CORS to allow the frontend domain)
    const ossResponse = await fetch(presignedUrl, {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": contentType,
      },
    });

    console.log("OSS upload response status:", ossResponse.status);

    if (ossResponse.ok) {
      console.log("File uploaded to OSS successfully");
      // Extract the OSS file access URL without query parameters
      const parsed = new URL(presignedUrl);
      const fileUrl = `${parsed.origin}${parsed.pathname}`;
      return { ok: true, url: fileUrl };
    } else {
      const errorText = await ossResponse.text().catch(() => "");
      throw new Error(`OSS upload failed: ${ossResponse.status} ${ossResponse.statusText} ${errorText}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error while uploading file to OSS";

    console.error("File upload to OSS failed:", {
      error: errorMessage,
      fileSize: file?.size,
      contentType,
    });

    throw new Error(errorMessage);
  }
}

