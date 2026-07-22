/**
 * Translated strings for the approval OS-notification.
 *
 * Its own module to avoid a cycle: ipc.mjs receives the strings from the renderer, paths.mjs reads
 * them when sending the notification, and paths.mjs already imports ipc.mjs. A shared leaf module
 * keeps the dependency arrows one-way.
 *
 * The main process has no i18n runtime (same constraint as the tray labels in services/background.mjs),
 * so the renderer pushes these on load. English defaults cover a first launch with no window.
 */
const strings = { title: "Approval needed", expires: "expires" };

export function setApprovalStrings(next) {
  if (typeof next?.title === "string" && next.title.trim()) strings.title = next.title.trim();
  if (typeof next?.expires === "string" && next.expires.trim()) strings.expires = next.expires.trim();
}

export function approvalStrings() {
  return strings;
}
