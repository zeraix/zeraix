import { callTool } from "@/lib/ai/toolkit";
import { mediaSrcFor, registerMedia } from "@/lib/ai/mediaLibrary";
import { useAgentChatStore } from "@/store/agentChatStore";
import type { SandboxStatus } from "@/lib/ai/sandbox";
import { buildImageParts, composeWireText, saveAttachments } from "./sendPrep";
import type { ApiMsg, Attachment, ContentPart, DisplayMsg } from "./types";
import type { GoalState } from "./goalState";

/** The turn is under way: where the user's message landed, in the buffer and on disk. */
export interface LandedMessage {
  ok: true;
  /**
   * The conversation this generation belongs to, captured as a stable value: it drives the spinner on that
   * conversation's sidebar row and every record/clear below, rather than relying on whichever conversation
   * the user happens to be looking at when an await returns.
   */
  convId: string;
  /**
   * Index of the turn just added, in the buffer and on disk. A change event is written into THIS turn after
   * compaction has run, so both positions have to be known exactly — locating it later by scanning could hit
   * an older turn.
   */
  userWireIdx: number;
  userStoredIdx: number;
  /**
   * The round's own buffer, captured BEFORE any further await. The user can switch conversations while
   * compaction spends seconds in the summariser, after which convoRef belongs to a different conversation
   * entirely — re-reading it later would splice this round's turns into someone else's history.
   */
  roundConvo: ApiMsg[];
}

/** An attachment could not be read; the turn never starts. */
export interface LandFailed {
  ok: false;
  /** Already-translated message for the error banner. */
  error: string;
}

export interface LandMessageDeps {
  text: string;
  attachments: Attachment[];
  /** The directory this session runs in, already resolved by the working-directory policy. */
  effectiveWorkdir: string;
  toolsReady: boolean;
  isLocalModel: boolean;
  selectedModelId: string | null;
  workdirChosen: boolean;
  secureEnv: boolean;
  sandboxStatus: SandboxStatus | null;
  t: (key: string, vars?: Record<string, string>) => string;
  convoRef: React.RefObject<ApiMsg[]>;
  convIdRef: React.RefObject<string | null>;
  /** A goal set with `/goal` before any conversation record existed. */
  pendingGoalRef: React.RefObject<GoalState | null>;
  /** messages[0], composed before the record existed and frozen onto it here. */
  pendingSystemPromptRef: React.RefObject<string>;
  setConvId: (id: string | null) => void;
  setGoalFor: (convId: string | null, g: GoalState) => void;
  pushDisplay: (m: DisplayMsg) => void;
}

/**
 * Land the user's message: into the wire buffer, onto the screen, and onto disk.
 *
 * Everything here happens before the model is contacted, and all of it is about making the turn findable
 * afterwards — the conversation record exists from the first message, the attachments are saved and indexed,
 * and the two indices the change-event writer needs are settled while they are still certainly correct.
 */
export async function landUserMessage(deps: LandMessageDeps): Promise<LandedMessage | LandFailed> {
  const {
    text, attachments: atts, effectiveWorkdir, toolsReady, isLocalModel,
    selectedModelId, workdirChosen, secureEnv, sandboxStatus, t,
    convoRef, convIdRef, pendingGoalRef, pendingSystemPromptRef,
    setConvId, setGoalFor, pushDisplay,
  } = deps;

  // Binary/oversized attachments: under Electron, persist them to the working directory first (workdir is already mounted into the sandbox),
  // so the model can process them directly with file tools / sandbox commands; the browser environment keeps to file names only.
  const savedPaths = toolsReady ? await saveAttachments(atts) : new Map<number, string>();
  // Assemble this round's content: images go multimodal via image_url, everything else is composed into the
  // body (inlined text, or a note pointing at the path it was saved to). With images, use a content array;
  // otherwise a plain string (compatible with non-vision models).
  const images = await buildImageParts(atts, isLocalModel);
  if (!images.ok) return { ok: false, error: t("chat.uploadFail", { name: images.name, err: images.err }) };

  const imageParts = images.parts;
  const composed = composeWireText(text, atts, savedPaths, sandboxStatus);
  const userContent: string | ContentPart[] =
    imageParts.length > 0
      ? [...(composed ? [{ type: "text" as const, text: composed }] : []), ...imageParts]
      : composed;
  convoRef.current = [...convoRef.current, { role: "user", content: userContent }];
  const userWireIdx = convoRef.current.length - 1;
  const roundConvo = convoRef.current;

  // Conversational memory: the user may have just stated a durable project rule ("we use npm here, not
  // pnpm"). Nothing in the repository records that, and the model does not reliably volunteer
  // remember_project, so the main process gates and extracts it. Fire-and-forget: a cheap keyword gate
  // rejects almost everything before any token is spent, and nothing here can delay or fail the send.
  if (composed.trim()) void callTool("note_conversation", { text: composed });

  const userFiles = atts
    .filter((a) => a.kind !== "image")
    .map((a) => ({ name: a.name, size: a.size, embedded: a.kind === "text" }));
  // The display bubble and the send share the same source: cloud = OSS URL; local = data URI (the preview blob is revoked at send time, and it must remain visible across restarts).
  const userImages = imageParts.map((p) => p.image_url.url);
  pushDisplay({ kind: "user", content: text, images: userImages, files: userFiles });

  // Persistence: the conversation record is created as soon as the user starts chatting, then appended to one by one.
  const store = useAgentChatStore.getState();
  let convId = convIdRef.current;
  if (!convId) {
    // Projects are grouped by folder: an explicitly chosen folder → that folder's project, otherwise the default project.
    convId = store.createConversation({
      workdir: effectiveWorkdir || undefined,
      projectWorkdir: workdirChosen ? effectiveWorkdir : undefined,
      // Stamp the environment this session is starting in — the value the page already resolved (inherited from the
      // project's last session, or the app default). Recorded even when the user never touched the toggle, because it is
      // what the NEXT session in this project inherits.
      secureEnv,
    });
    setConvId(convId);
    // Firmly bind the new conversation to the currently selected model (conversation-level binding).
    if (selectedModelId) store.setConversationModel(convId, selectedModelId);
    // A goal set with /goal before this record existed (see pendingGoalRef) is attached here, so the loop it
    // starts belongs to the conversation from its very first turn.
    if (pendingGoalRef.current) {
      setGoalFor(convId, pendingGoalRef.current);
      pendingGoalRef.current = null;
    }
    // Freeze messages[0] on the brand-new record (it was composed by the caller, before this record existed).
    if (pendingSystemPromptRef.current) {
      store.setConversationSystemPrompt(convId, pendingSystemPromptRef.current);
      pendingSystemPromptRef.current = "";
    }
  }
  // Bound to a const so the closures downstream (active(), the RunCtx, the log calls) capture a settled
  // string rather than the still-reassignable `convId` above.
  const genConvId = convId;

  // Index what the user just handed over, at the point it lands on disk. Placed here rather than beside the
  // save because the conversation id is what makes an entry findable later, and it is only settled now.
  // Only what was actually saved: a save can fail, and an entry pointing at nothing would be a library row
  // the user can click and get an error from.
  for (const a of atts) {
    const savedPath = savedPaths.get(a.id);
    if (!savedPath) continue;
    void registerMedia({
      // The renderable source. A local path is not one — an <img src="C:\…"> shows nothing — so an asset
      // in the library is addressed through the app's own scheme, and only an actual URL is used as-is.
      src: a.url || mediaSrcFor(savedPath, true),
      // The browser's own verdict, when there is one. `image/*` was a placeholder that could not be
      // categorised, so an uploaded PNG landed under "other" and a document under nothing at all.
      mime: a.file?.type || (a.kind === "image" ? "image/png" : "application/octet-stream"),
      path: savedPath,
      bytes: a.size,
      origin: "upload",
      convId: genConvId,
      // The name on DISK, which is not the name it arrived with: storing a file replaces spaces and
      // reserved punctuation with underscores. Recording the original here made the index disagree with
      // its own `path`, so the library showed a title no file on disk answered to.
      filename: savedPath.split(/[\\/]/).pop() || a.name,
    });
  }

  store.appendMessage(genConvId, {
    role: "user",
    content: text,
    // `text` is what the bubble shows; `composed` is what the model was actually sent (it also carries
    // inlined text-file contents and saved attachment paths). Store the difference so replaying this
    // conversation reproduces the message the model saw, not just the one the user typed.
    ...(composed !== text ? { wireText: composed } : {}),
    images: userImages.length ? userImages : undefined,
    files: userFiles.length ? userFiles : undefined,
    ts: Date.now(),
  });
  const userStoredIdx = (store.getConversation(genConvId)?.messages.length ?? 0) - 1;

  return { ok: true, convId: genConvId, userWireIdx, userStoredIdx, roundConvo };
}
