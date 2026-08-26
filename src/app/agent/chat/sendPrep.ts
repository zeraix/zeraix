/**
 * The self-contained steps of one send, lifted out of the chat page's `send()`.
 *
 * `send()` is a long orchestration: it validates, prepares the outgoing turn, persists it, then drives the
 * tool loop. Everything in THIS file is the part of that work which depends only on its arguments — turning
 * attachments into wire content, resolving and grouping the model's tool calls, and snapshotting the standing
 * state a change event announces. Keeping them here means `send()` reads as the sequence it is, and each of
 * these can be reasoned about (and changed) without the surrounding component state.
 *
 * Nothing here touches React state, refs, or the store. Steps that must (the workdir policy, persistence, the
 * loop's own bookkeeping) deliberately stayed in the component.
 */
import { formatBytes, uploadFileToOSS, type Attachment } from "@/lib/ai/attachments";
import { isSandboxEngine, sandboxEnvHint, type SandboxStatus } from "@/lib/ai/sandbox";
import { ASSET_MOUNT, modelPathFor, saveToLibrary } from "@/lib/ai/mediaLibrary";
import { resolveToolCall } from "@/lib/ai/toolRouter";
import type { ReminderState, ToolCall } from "./types";

/** An image as it travels on the wire: an OSS link (cloud) or an inline data URI (local model). */
export type ImagePart = { type: "image_url"; image_url: { url: string } };

/** Read bytes as a data URI. A string source is fetched first (an OSS link → base64). Internal to buildImageParts. */
async function toDataUrl(src: Blob | string): Promise<string> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * Copy binary and image attachments into the media library, returning attachment id → saved absolute path.
 *
 * Images are persisted too, not just binaries: image_url only lets the model LOOK at the picture. Anything it is
 * asked to DO with it — edit the pixels, run OCR, feed it to ffmpeg — happens through file tools and sandbox
 * commands, which need a real path. Without this the model has to ask the user to copy the file in by hand.
 *
 * Electron only — the caller gates on toolsReady, since there is nowhere to save to in the browser.
 */
export async function saveAttachments(atts: Attachment[]): Promise<Map<number, string>> {
  // Attachments land in the MEDIA LIBRARY — one folder for everything the user has ever handed over, which is
  // what makes the library a library rather than a filter over whichever project happened to be open.
  //
  // The library is read-only to the model (see tools/paths.mjs), so an attachment it is asked to CHANGE is
  // copied into the working directory first and the result written there. That is the rule that keeps an
  // original the user handed over from being altered or deleted by a tool call that misfired.
  const savedPaths = new Map<number, string>();
  for (const a of atts) {
    if (a.kind !== "binary" && a.kind !== "image") continue;
    // EVERYTHING the user sends goes to the media library — a picture, a spreadsheet, a JSON dump, all of it.
    // One folder is what makes the library a library rather than a filter over whichever project happened to
    // be open, and it is what the user asked for.
    //
    // The library is read-only to the model, so an attachment it needs to CHANGE is copied into the working
    // directory first and the result written there. That is not a workaround — it is the rule that keeps an
    // original the user handed over from being altered or deleted by a tool call that misfired.
    const put = async (payload: { name: string; srcPath?: string; bytes?: ArrayBuffer; url?: string }) => {
      const path = await saveToLibrary(payload);
      if (path) savedPaths.set(a.id, path);
    };
    try {
      if (a.hostPath) {
        // A real disk file: the main process does a kernel-level copy by host path, with bytes not going through IPC (efficient even for large files).
        await put({ name: a.name, srcPath: a.hostPath });
      } else if (a.file && a.size <= 100 * 1024 * 1024) {
        // A synthetic file (a Blob dragged out of the webview / generated) has bytes only in memory with no other source — pass them in via IPC to persist.
        await put({ name: a.name, bytes: await a.file.arrayBuffer() });
      } else if (a.kind === "image" && a.url) {
        // A URL-only image: no local File / hostPath, only a link — happens when the user edits/resends a
        // message (images are rebuilt from their stored URLs), on a home-page handoff, or from restored
        // history. Materialize it from the URL (OSS link or data: URI) so it too exists in the working
        // directory and can be EDITED, not just viewed; the main process does the download (no renderer CORS).
        await put({ name: a.name, url: a.url });
      }
    } catch (e) {
      // Surface the reason rather than swallowing it: a silent failure here is exactly why the model
      // later reports "the image isn't in the working directory" and fabricates a replacement.
      console.error(`[attachment] failed to save "${a.name}" to the working directory:`, e);
    }
  }
  return savedPaths;
}

/**
 * Turn image attachments into multimodal image_url parts.
 *
 * Cloud models get the OSS publicUrl (the provider's server fetches it itself); local llama-server cannot fetch
 * remote URLs (it reports 400 Failed to load image / download failure), so it gets an inline base64 data URI —
 * usable offline too. The byte source prefers a.file (the File object, unaffected by the previewUrl being
 * revoked — the send flow releases the preview blob URL first), falling back to fetch(a.url).
 *
 * A failed OSS upload aborts the send, so it is reported rather than skipped: sending the turn without the
 * picture would have the model answer about an image it never received.
 */
export async function buildImageParts(
  atts: Attachment[],
  isLocalModel: boolean,
): Promise<{ ok: true; parts: ImagePart[] } | { ok: false; name: string; err: string }> {
  const parts: ImagePart[] = [];
  for (const a of atts) {
    if (a.kind !== "image" || !(a.url || a.file)) continue;
    let url = a.url || "";
    if (isLocalModel && a.file) {
      try {
        url = await toDataUrl(a.file); // Original bytes → data URI (bypassing OSS/CDN, avoiding WebP transcoding and usable offline)
      } catch {
        url = a.url || ""; // Read failed: fall back to the URL (likely still fails, but at least does not drop the message)
      }
    } else if (!isLocalModel && !url && a.file) {
      // An image attached in local mode (not uploaded), then switched to a cloud model before sending: upload to OSS now.
      try {
        url = await uploadFileToOSS(a.file, () => {});
      } catch (e) {
        return { ok: false, name: a.name, err: e instanceof Error ? e.message : String(e) };
      }
    }
    if (url) parts.push({ type: "image_url", image_url: { url } });
  }
  return { ok: true, parts };
}


/**
 * What the model actually receives as the turn's text: what the user typed, plus one block per attachment.
 *
 * Text-type attachments are inlined (separated by file name); binary and image attachments note the path they
 * were saved to, or say plainly that they could not be saved. Images get a note even for a vision model: the
 * picture in the wire is something it can only read, while this is the same picture as an editable file. It also
 * keeps a text-only model useful — the image_url part gets stripped, but the file is still there to run through
 * a command-line tool.
 */
export function composeWireText(
  text: string,
  atts: Attachment[],
  savedPaths: Map<number, string>,
  sandbox: SandboxStatus | null,
): string {
  const sandboxed = isSandboxEngine(sandbox?.active);
  let composed = text;
  const sep = () => (composed ? "\n\n" : "");
  for (const a of atts) {
    const size = formatBytes(a.size);
    const saved = savedPaths.get(a.id);
    // The library has two names and only ONE of them resolves at a time. Inside the sandbox it is mounted at
    // /assets and the host path exists on neither side; natively there is no mount, so the host path is the
    // only name that works. Naming /assets unconditionally sent a native model after a folder that is not there.
    const diskName = saved ? (saved.split(/[\\/]/).pop() ?? "") : "";
    const shown = modelPathFor(saved ?? "", sandboxed);
    // Storing a file RENAMES it: spaces and reserved punctuation become underscores (mediaStore.uniqueTarget).
    // The name the user chose is worth repeating back so they recognise their own file, but it is not a path —
    // quoting it alone let the model rebuild a path from a filename that does not exist on disk.
    const named = diskName && diskName !== a.name ? `${a.name}, saved as ${diskName}` : a.name;
    if (a.kind === "binary") {
      composed += saved
        ? `${sep()}[Attachment: ${named} (${size}) has been saved to the media library at ${shown} — use that exact path, do not rebuild one from the file name. Read it directly with file tools or commands. The library is READ-ONLY: to change the file, copy it into the working directory first and edit the copy, and write every result you produce to the working directory]`
        : `${sep()}[Attachment: ${named} (${size}) could not be saved to disk, so there is no path for it]`;
    } else if (a.kind === "image") {
      // Save failed (or there was nothing to save from). Tell the model the truth so it does NOT recreate the
      // image from scratch — a redrawn copy differs from the original and is never what the user wants. It can
      // still see the picture via image_url.
      composed += saved
        ? `${sep()}[Image: ${named} (${size}) is attached and visible to you above. A copy is in the media library at ${shown} — use that exact path, do not rebuild one from the file name. It is READ-ONLY: you may read it, but to edit or process it (crop, annotate, OCR, convert, feed to a script) copy it into the working directory first and work on the copy. Do not ask the user to place the file anywhere]`
        : `${sep()}[Image: ${named} (${size}) is attached and visible to you in this message, but it could NOT be auto-saved to the working directory. Do NOT recreate, redraw, or regenerate it from scratch — a rebuilt image will differ from the original. If you need it as an editable file on disk, ask the user to save it into the working directory (or attach it again), then edit that file.]`;
    }
  }
  return composed;
}

/**
 * Resolve every tool call ONCE, before anything dispatches or groups.
 *
 * A cold tool arrives wrapped as call_tool{name, arguments} (see toolRouter.ts), and everything downstream keys
 * on the tool NAME: the consent gate (toolNeedsConsent / SENSITIVE_TOOLS — open_path is routed AND sensitive, so
 * a late unwrap would run it with no confirmation prompt, and one "don't ask again" on call_tool would whitelist
 * every routed tool at once), the read-only batching, the usage log, the risky-change and project-memory guards,
 * and the persisted display name. Resolving here means none of them need to know the dispatcher exists.
 *
 * Keyed on the ToolCall object rather than tc.id: the objects are the same references the grouping and the
 * settled loop iterate, so nothing depends on ids being present or unique. `tc` itself is never rewritten — the
 * wire and the persisted tool_calls keep exactly what the model emitted, which is what keeps the prefix stable
 * and the assistant turn valid on the next request.
 */
export function resolveToolCalls(
  calls: ToolCall[],
): Map<ToolCall, { name: string; args: Record<string, unknown> }> {
  const resolved = new Map<ToolCall, { name: string; args: Record<string, unknown> }>();
  for (const tc of calls) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(tc.function.arguments || "{}");
    } catch {
      /* Invalid JSON arguments, call with an empty object */
    }
    resolved.set(tc, resolveToolCall(tc.function.name, parsed));
  }
  return resolved;
}

/**
 * Split this round's tool calls into batches that may run concurrently.
 *
 * The model is told to issue independent calls together; awaiting them one at a time threw that away and made
 * every extra read cost another round of latency. Only *consecutive* parallel-safe calls are batched, so a read
 * can never overtake an edit issued in the same round, and anything with a side effect, a consent prompt, or UI
 * interaction stays strictly serial.
 */
export function groupParallelCalls(
  calls: ToolCall[],
  nameOf: (tc: ToolCall) => string,
  parallelSafe: ReadonlySet<string>,
): ToolCall[][] {
  const groups: ToolCall[][] = [];
  for (const tc of calls) {
    const prev = groups[groups.length - 1];
    if (prev && parallelSafe.has(nameOf(tc)) && parallelSafe.has(nameOf(prev[0]))) prev.push(tc);
    else groups.push([tc]);
  }
  return groups;
}

/**
 * Snapshot the standing state a change event announces, as of this turn.
 *
 * Only the snapshot — diffing it against what was last announced, and writing the delta into the turn, stays at
 * the call site (see reminders.ts). The date and time zone are read here because they are read-at-send values
 * like the rest of it, not inputs the caller has to thread through.
 */
export function buildReminderState(input: {
  workdir: string;
  sandbox: SandboxStatus | null;
  /** Host path of the media library, or "" when there is none. Named for the model by the sandbox state. */
  assetsDir: string;
  activeModel: { label: string; model: string } | null | undefined;
  skills: { id: string; description: string }[];
  imageGenerationAvailable: boolean;
  videoGenerationAvailable: boolean;
  task: string;
  /** The rendered Goal State block, or "" when no goal is in force (see goalState.renderGoalState). */
  goal: string;
}): ReminderState {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    /* Leave empty if reading the time zone fails */
  }
  return {
    workdir: input.workdir,
    // Decides how the line above names itself: the host path is only one of this folder's two names, and in the
    // sandbox it is the one the model must NOT use.
    sandboxed: isSandboxEngine(input.sandbox?.active),
    // Named the way the working directory is. In the sandbox the library is mounted at /assets and the host
    // path exists on neither side, so announcing the host path would send the model after a folder that is
    // not there; natively there is no mount and the host path is the only name that resolves.
    assets: input.assetsDir ? (isSandboxEngine(input.sandbox?.active) ? ASSET_MOUNT : input.assetsDir) : "",
    // The command environment, announced on change rather than baked into messages[0]. It depends on the VM being up, and
    // the VM can fall back to native mid-conversation — a system prompt frozen at the first send cannot express either.
    env: sandboxEnvHint(input.sandbox),
    ctx: {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      model: input.activeModel ? `${input.activeModel.label} (${input.activeModel.model})` : "unknown",
      tz: tz || "unknown",
    },
    skills: input.skills.map((s) => ({ id: s.id, description: s.description })),
    // Declared but unusable — the declaration stays byte-identical across installs, and this is what tells the model it
    // cannot actually be called (see docs/cache-stable-prompt-context.md §"Tool declarations are static").
    disabledTools: [
      ...(input.imageGenerationAvailable ? [] : ["image_generation"]),
      ...(input.videoGenerationAvailable ? [] : ["video_generation"]),
    ],
    task: input.task,
    goal: input.goal,
  };
}
