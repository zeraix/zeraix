"use client";

/**
 * A region of the UI a skin package may rearrange.
 *
 *   <LayoutSlot name="greeting" values={{ title, hint }} fallback={<DefaultGreeting />} />
 *
 * If the active package's layout.json defines this region, it is rendered with LayoutRenderer;
 * otherwise the fallback -- the app's own hardcoded layout -- renders unchanged. `values` are
 * handed to the app components inside (app:greetingTitle reads `title`) and merged into the
 * visibleWhen state.
 */
import type React from "react";
import { useMemo } from "react";
import type { LayoutRegion } from "../../../../electron/skins/layoutRefs.mjs";
import { useLayoutAppState } from "./appState";
import { LayoutRenderer } from "./LayoutRenderer";
import { SlotContext } from "./slotContext";
import { useSkinLayout } from "./useSkinLayout";

export interface LayoutSlotProps {
  name: LayoutRegion;
  fallback: React.ReactNode;
  values?: Record<string, unknown>;
  className?: string;
}

export function LayoutSlot({ name, fallback, values, className }: LayoutSlotProps) {
  const layout = useSkinLayout();
  const node = layout.tree?.regions[name];
  // Only primitives reach the visibleWhen state; a React element in `values` (the hint) is not something an expression can compare.
  const primitives = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values ?? {})) if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
    return out;
  }, [values]);
  const state = useLayoutAppState(primitives);
  const ctx = useMemo(() => ({ region: name, values: values ?? {}, state }), [name, values, state]);

  if (!node) return <>{fallback}</>;
  return (
    <SlotContext.Provider value={ctx}>
      <div data-layout-region={name} className={className}>
        <LayoutRenderer node={node} components={layout.components} />
      </div>
    </SlotContext.Provider>
  );
}
