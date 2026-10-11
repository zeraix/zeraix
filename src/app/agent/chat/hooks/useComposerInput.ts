"use client";

import { useEffect, useRef, useState } from "react";
import { getPathForFile } from "@/lib/ai/toolkit";
import { supportsFieldSizing } from "../constants";
import type { Attachment } from "../types";

export interface ComposerInput {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /** The input box, for the auto-fit height fallback. */
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  /** Source of attachment ids — also used when a resend reconstructs a message's images. */
  attachIdRef: React.RefObject<number>;
  addFiles: (files: FileList | null) => void;
  removeAttachment: (id: number) => void;
}

/**
 * Owns what the user is composing: the input text, the attachments pending send, and the input box's height.
 *
 * Nothing here is sent anywhere — `send` takes a snapshot of `input` and `attachments` and clears them. `onError`
 * is the page's error banner, raised when an attachment is refused before it is ever staged.
 */
export function useComposerInput({
  onChatRoute,
  onError,
  t,
}: {
  onChatRoute: boolean;
  onError: (text: string) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}): ComposerInput {
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null); // For the input box's auto-fit height
  // Attachments pending send: images go multimodal, text files are inlined into the prompt, the rest attach only the file name.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Input-box auto-fit height: grows with content, up to 30vh, then scrolls internally.
  // FALLBACK ONLY. Where the engine has `field-sizing: content` the box sizes itself in CSS
  // (.composer-autosize, globals.css) and this effect returns immediately -- setting a height and then
  // reading scrollHeight forces a synchronous layout of the entire transcript, on every keystroke, which
  // is the single most expensive thing typing used to do.
  // The deps include onChatRoute: this component is permanently mounted by AgentShell, so before the first entry the composer is hidden (scrollHeight=0),
  // and pinning the height to 0px then would keep it collapsed. So when hidden (scrollHeight=0), skip measuring and keep the rows=1 default single-line height,
  // then re-measure and correct after the route becomes active and visible.
  useEffect(() => {
    if (supportsFieldSizing()) return;
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight === 0) return; // Hidden / not yet laid out: do not measure, to avoid collapsing to 0
    const max = Math.round(window.innerHeight * 0.3);
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input, onChatRoute]);

  // Images go multimodal, which every provider bounds; ≤10MB is the common floor. Nothing else has a size
  // limit any more: a non-image is saved to the library and referenced by path, never read into the prompt.
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const pushAttachment = (a: Attachment) => setAttachments((list) => [...list, a]);

  // Select a file of any type: images defer the upload decision to send time based on the model (local → base64,
  // not uploaded; cloud → uploaded to OSS at send time); everything else is saved to the media library on send
  // and referenced by its path, whatever its type.
  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const id = ++attachIdRef.current;
      const meta = { id, name: file.name, size: file.size };
      const hostPath = getPathForFile(file); // Only present for Electron drag-in/selection; empty string for web / synthetic files
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_BYTES) {
          onError(t("chat.imageTooLarge", { name: file.name }));
          continue;
        }
        // Do not upload when attaching: decide only before sending based on the model selected at that time (avoids an upload/privacy mismatch caused by switching models after attaching).
        // Keep the file reference: local models read the original bytes and convert to base64 when sending (cannot rely on the previewUrl, which will be revoked, and cannot fetch
        // the OSS link — the CDN transcodes it to WebP, which llama cannot decode); cloud models use file to upload to OSS and get the publicUrl when sending. See send().
        // hostPath is captured for images as well: on send they are copied into the working directory
        // like binary attachments, so file tools / sandbox commands can open the actual file. A model
        // that can *see* an image still cannot *edit* it without a path on disk.
        const previewUrl = URL.createObjectURL(file);
        pushAttachment({ ...meta, kind: "image", file, previewUrl, hostPath });
      } else {
        // Every non-image attachment is a FILE: copied to the working directory on send and handed to the
        // model as a path. Nothing is inlined any more — see addFilesTo in lib/ai/attachments.ts for why a
        // path beats a transcript of the file's contents.
        pushAttachment({ ...meta, kind: "binary", hostPath, file });
      }
    }
  };
  const removeAttachment = (id: number) =>
    setAttachments((list) => {
      const target = list.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl); // Release the local preview
      return list.filter((a) => a.id !== id);
    });

  return {
    input,
    setInput,
    taRef,
    fileInputRef,
    attachments,
    setAttachments,
    attachIdRef,
    addFiles,
    removeAttachment,
  };
}
