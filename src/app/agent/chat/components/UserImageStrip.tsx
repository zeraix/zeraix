"use client";

/**
 * The pictures attached to a user message, as thumbnails that open in the media viewer.
 *
 * Shared by the bubble and by the edit box (where they are shown to say that they stay attached). A button
 * per picture rather than a bare <img>: once a message is sent this strip is the only way back to what was
 * in it, and an 80px thumbnail is not a way to look at a picture.
 */
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { openMediaViewer, type MediaViewerItem } from "@/store/mediaViewerStore";

export function UserImageStrip({
  images,
  size = "md",
  className,
}: {
  images: string[];
  size?: "sm" | "md";
  className?: string;
}) {
  const t = useT();
  if (images.length === 0) return null;
  // Built on the click, not per render: the names come from the live locale, and a memo keyed on `t` would
  // be no memo at all — useT hands out a fresh function every render.
  const items = (): MediaViewerItem[] =>
    images.map((src, i) => ({
      id: String(i),
      src,
      kind: "image",
      name: t("chat.attachmentN", { n: i + 1 }),
    }));
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {images.map((src, i) => (
        <button
          key={i}
          type="button"
          title={t("viewer.open")}
          aria-label={t("chat.attachmentN", { n: i + 1 })}
          onClick={() => openMediaViewer(items(), i)}
          className={cn(
            "shrink-0 cursor-zoom-in select-none overflow-hidden rounded-lg border border-line transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-primary",
            size === "sm" ? "size-16" : "size-20",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- an https: or data: URL from the message, which next/image cannot optimise */}
          <img src={src} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} className="size-full object-cover" />
        </button>
      ))}
    </div>
  );
}
