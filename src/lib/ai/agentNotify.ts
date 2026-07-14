/**
 * System notification triggers for the Agent conversation (notification-t.md).
 *
 * Trigger conditions:
 *   1. AI reply completes (reply-complete notification) → clicking the notification jumps to the matching conversation (route: /agent/chat?c=<id>)
 *   2. AI page error → (a) API error  (b) call-count limit reached
 *   3. Permission notification: the AI requests a sensitive operation and is waiting for authorization
 *   4. Question notification: the AI needs user input to continue (ask_user)
 *
 * The precondition is left to the main process via whenBackground:true: it only actually pops up when the window is unfocused / minimized (the user isn't watching);
 * it is skipped automatically while the user is looking at the conversation (see electron/services/notificationService.mjs).
 * All copy goes through i18n (for a global audience); outside a React context use translate / translateWith.
 * In a non-Electron environment sendNotification safely degrades to a no-op.
 */
import { sendNotification } from "@/lib/electron/notification";
import { getNotifyPrefs } from "@/lib/ai/notifyPrefs";
import { translate, translateWith } from "@/lib/i18n";

/** Build the in-app route that jumps to the given conversation; falls back to the conversation home when there is no id. */
function chatRoute(conversationId?: string | null): string {
  return conversationId ? `/agent/chat?c=${encodeURIComponent(conversationId)}` : "/agent/chat";
}

/** Take a one-line preview of the body text (collapse whitespace/first line + truncate) for use as the notification body; falls back to a localized message when empty. */
function preview(text?: string | null, max = 90): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return translate("notif.replyComplete.empty");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Trigger 1: AI reply complete (reply-complete notification). Clicking the notification jumps to the matching conversation.
 * Controlled by the replyCompleteMode preference: never = no notification; unfocused = pop only when the app is unfocused; always = always pop.
 * The same conversation is merged via groupKey to avoid stacking up spam across consecutive rounds.
 */
export function notifyReplyComplete(conversationId: string | null, replyText?: string | null): void {
  const mode = getNotifyPrefs().replyCompleteMode;
  if (mode === "never") return;
  void sendNotification({
    title: translate("notif.replyComplete.title"),
    body: preview(replyText),
    type: "success",
    route: chatRoute(conversationId),
    groupKey: conversationId ? `agent-reply:${conversationId}` : "agent-reply",
    whenBackground: mode === "unfocused", // always → pop even in the foreground
  });
}

/**
 * Trigger 3: permission notification. Remind when the AI requests a sensitive operation (write file / delete / run command, etc.) and is waiting for user authorization.
 * Controlled by the permissionEnabled preference. Only pops when the app is unfocused (if the user is watching they'll see the confirmation panel directly).
 */
export function notifyPermissionRequest(conversationId: string | null, toolName?: string): void {
  if (!getNotifyPrefs().permissionEnabled) return;
  void sendNotification({
    title: translate("notif.permission.title"),
    body: toolName
      ? translateWith("notif.permission.body", { tool: toolName })
      : translate("notif.permission.bodyGeneric"),
    type: "warning",
    priority: "high",
    route: chatRoute(conversationId),
    groupKey: conversationId ? `agent-permission:${conversationId}` : "agent-permission",
    whenBackground: true,
  });
}

/**
 * Trigger 4: question notification. Remind when the AI needs user input to continue (ask_user).
 * Controlled by the questionEnabled preference. Only pops when the app is unfocused.
 */
export function notifyQuestion(conversationId: string | null, question?: string): void {
  if (!getNotifyPrefs().questionEnabled) return;
  void sendNotification({
    title: translate("notif.question.title"),
    body: preview(question, 120),
    type: "info",
    priority: "high",
    route: chatRoute(conversationId),
    groupKey: conversationId ? `agent-question:${conversationId}` : "agent-question",
    whenBackground: true,
  });
}

/** AI error category: api = interface/network error; limit = call-count limit reached. */
export type AgentErrorKind = "api" | "limit";

/**
 * Trigger 2: AI page error. Clicking the notification jumps back to the matching conversation for easy review/retry.
 * api: detail is the raw error message (technical content, shown as-is).
 * limit: detail is the limit value; the body uses the localized template notif.error.limitBody.
 */
export function notifyAgentError(
  kind: AgentErrorKind,
  detail: string | number | null,
  conversationId?: string | null,
): void {
  const title = translate(kind === "limit" ? "notif.error.limitTitle" : "notif.error.apiTitle");
  const body =
    kind === "limit"
      ? translateWith("notif.error.limitBody", { max: detail ?? "" })
      : preview(detail == null ? "" : String(detail), 120);
  void sendNotification({
    title,
    body,
    type: kind === "limit" ? "warning" : "error",
    priority: "high", // errors don't auto-dismiss, ensuring the user sees them
    route: chatRoute(conversationId),
    groupKey: conversationId ? `agent-error:${conversationId}` : "agent-error",
    whenBackground: true,
  });
}
