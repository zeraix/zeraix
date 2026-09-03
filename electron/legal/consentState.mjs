/**
 * The record of the user's agreement to the Privacy Policy and the Terms of Service.
 *
 * Kept by the MAIN process, in userData, because the agreement gates the app itself: it is checked before the
 * first window exists, so it cannot live in the renderer's storage. Pure over a file path, so the rules — what
 * counts as agreed, and what a newer version of the documents does to an old agreement — are testable without
 * Electron.
 */
import fs from "node:fs";

/**
 * Bump when either document changes in a way that needs agreeing to again. An agreement recorded against an
 * older version is not an agreement to this one, so the screen comes back once.
 */
export const LEGAL_VERSION = "2026-09-03";

export const PRIVACY_URL = "https://zeraix.com/privacy.html";
export const TERMS_URL = "https://zeraix.com/terms.html";

/** Whether `record` (whatever was on disk) is an agreement to `version`. Anything malformed is "not agreed". */
export function isAccepted(record, version = LEGAL_VERSION) {
  return !!record && typeof record === "object" && record.version === version && typeof record.acceptedAt === "string";
}

/** The record in `file`, or null when there is none or it cannot be read — both mean "ask". */
export function readConsent(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Record an agreement to `version` in `file`. Throws on a write failure; the caller decides what that means. */
export function writeConsent(file, version = LEGAL_VERSION, now = new Date()) {
  const record = { version, acceptedAt: now.toISOString() };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}
