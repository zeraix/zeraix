"use client";

/**
 * The active skin package's layout.json and components.json, re-validated (schema.ts) before any
 * region renders from them.
 *
 * Read through the shared active-package store (../skinpkg/packageFiles.ts): over IPC, once per
 * package generation, shared by every <LayoutSlot>. A package without a layout.json (the common
 * case: most skins only recolour) resolves to "no layout" and every slot renders its fallback. A
 * package whose files fail validation here -- which the installer should have made impossible, but
 * the directory is user-writable -- is treated the same way, with a console warning, never an
 * exception in a render path.
 */
import { ALLOWED_REFS } from "../../../../electron/skins/layoutRefs.mjs";
import { createActivePackageStore } from "../skinpkg/packageFiles";
import { parsePackageLayout, type ComponentMap, type LayoutTree } from "./schema";

export interface SkinLayout {
  skinId: string;
  tree: LayoutTree | null;
  components: ComponentMap;
}

interface LayoutValue {
  tree: LayoutTree | null;
  components: ComponentMap;
}

const EMPTY: LayoutValue = { tree: null, components: {} };

const store = createActivePackageStore<LayoutValue>({
  name: "layout",
  files: ["layout.json", "components.json"],
  empty: EMPTY,
  parse(skinId, texts) {
    const layout = texts["layout.json"] ?? null;
    const components = texts["components.json"] ?? null;
    if (layout === null && components === null) return EMPTY;
    const parsed = parsePackageLayout(layout, components, ALLOWED_REFS);
    if (parsed.ok) return { tree: parsed.tree, components: parsed.components };
    console.warn(`[layout] ${skinId}: ${parsed.message}`);
    return EMPTY;
  },
});

export function useSkinLayout(): SkinLayout {
  const s = store.useSnapshot();
  return { skinId: s.skinId, tree: s.value.tree, components: s.value.components };
}
