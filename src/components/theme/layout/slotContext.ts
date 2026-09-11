"use client";

/**
 * What a region's host hands to the components rendered inside it.
 *
 * The greeting slot, for example, is rendered by ChatTranscript, which owns the translated title
 * and hint; `app:greetingTitle` reads them from here. The same values are merged into the
 * visibleWhen `state`, so a layout can also test them (`state.toolsReady`).
 */
import { createContext, useContext } from "react";
import type { AppState } from "./visibleWhen";

export interface SlotContextValue {
  region: string;
  /** Host-provided values for app components (title, hint ...). */
  values: Record<string, unknown>;
  /** The full visibleWhen state: app state plus the values above. */
  state: AppState;
}

export const SlotContext = createContext<SlotContextValue>({ region: "", values: {}, state: {} });

export const useSlotValues = () => useContext(SlotContext).values;
export const useSlotState = () => useContext(SlotContext).state;
