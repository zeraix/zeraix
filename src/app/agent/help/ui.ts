/** Presentation bits shared by the help page and the feedback page it links to. */

export const CARD = "rounded-xl border border-line bg-surface-muted/50";

export const FIELD =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10";

/**
 * Open an external link. https URLs are handed to the system browser by the main process
 * (setWindowOpenHandler); in a plain browser this is an ordinary new tab.
 */
export const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
