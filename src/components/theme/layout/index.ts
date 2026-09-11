/**
 * Declarative layouts for skin packages (Stages 6, 6.2, 7): schema.ts (what a layout.json may
 * contain, mirrored from the Rust validator), visibleWhen.ts (the conditional language),
 * composites.ts (template instantiation), registry.tsx (the app's own components), LayoutRenderer
 * (the recursive renderer) and LayoutSlot (the region wrapper the app places).
 */
export { LayoutSlot, type LayoutSlotProps } from "./LayoutSlot";
export { LayoutRenderer, NodeView } from "./LayoutRenderer";
export { APP_COMPONENT_LIST, COMPONENT_REGISTRY, type AppComponentDef } from "./registry";
export { useSkinLayout, type SkinLayout } from "./useSkinLayout";
export { useLayoutAppState } from "./appState";
export { evaluateCondition, isVisible, parseVisibleWhen, type AppState, type Condition } from "./visibleWhen";
export {
  MAX_DEPTH,
  MAX_EXPANDED_DEPTH,
  MAX_EXPANDED_NODES,
  MAX_NODES,
  checkComponents,
  checkLayout,
  componentsSchema,
  layoutNodeSchema,
  layoutTreeSchema,
  parsePackageLayout,
  splitRef,
  type ComponentMap,
  type ComponentNode,
  type CompositeComponentDef,
  type ContainerNode,
  type LayoutNode,
  type LayoutTree,
} from "./schema";
