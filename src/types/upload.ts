/**
 * API for retrieving response data for a file upload pre-signed URL
 */
export interface GetUploadUrlResponse {
  /** Pre-signed upload URL */
  url: string;
  /** File content type */
  contentType: string;
  /** Publicly accessible URL */
  publicUrl?: string;
}