"use client";

import { createContext, useContext } from "react";

/**
 * The shell's title-bar slot.
 *
 * The conversation header renders into this element so its controls share one row with the window buttons, rather than
 * sitting in a strip underneath them. Lives in its own module because both AgentShell (which provides the slot) and
 * ChatHeader (which fills it) need it, and importing one from the other would close an import cycle through page.tsx.
 *
 * Null on every route but the chat one — the shell mounts the slot only there — and in any tree without an AgentShell.
 * The header falls back to rendering in place, so it is never lost.
 */
export const TitleBarSlotContext = createContext<HTMLElement | null>(null);

export const useTitleBarSlot = () => useContext(TitleBarSlotContext);

/**
 * Title-bar height, shared by the shell strip, the window buttons and the conversation header that sits between them.
 * One constant, so the row cannot end up taller than the buttons floating over it.
 */
export const TITLE_BAR_HEIGHT = "h-[50px]";

/** The same height as a number, for panels that need to reserve part of it rather than fill it. Keep the two in step —
 *  Tailwind only sees class names it can read literally in the source, so the class above cannot be built from this. */
export const TITLE_BAR_HEIGHT_PX = 50;

/** The shell's Files sidebar, as the title bar sees it: is it showing, and flip it. */
export type FilesSidebarControl = { open: boolean; toggle: () => void };

/**
 * Provided by AgentShell, consumed by the conversation header — the Files entry moved out of the sidebar and onto the
 * title bar, and only the shell knows how to swap the two sidebars over. Null in any tree without an AgentShell, where
 * the button is simply not offered.
 */
export const FilesSidebarContext = createContext<FilesSidebarControl | null>(null);

export const useFilesSidebar = () => useContext(FilesSidebarContext);
