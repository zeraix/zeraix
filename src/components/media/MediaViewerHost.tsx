"use client";

import { useMediaViewerStore } from "@/store/mediaViewerStore";
import { MediaViewer } from "./MediaViewer";

/** The app-wide viewer: one instance, mounted by the shell, showing whatever `openMediaViewer` was last given. */
export default function MediaViewerHost() {
  const open = useMediaViewerStore((s) => s.open);
  const items = useMediaViewerStore((s) => s.items);
  const index = useMediaViewerStore((s) => s.index);
  const close = useMediaViewerStore((s) => s.close);
  const setIndex = useMediaViewerStore((s) => s.setIndex);
  return <MediaViewer open={open} items={items} index={index} onClose={close} onIndexChange={setIndex} />;
}
