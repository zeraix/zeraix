"use client";

/**
 * The recursive renderer for a validated layout tree.
 *
 * Containers become flex or grid boxes; component nodes are routed by ref prefix -- `app:` to
 * COMPONENT_REGISTRY, `primitive:` to PRIMITIVE_REGISTRY, `custom:` to the active package's
 * composites, whose template is instantiated (composites.ts) and rendered through the same path.
 * An unresolvable ref renders a visible placeholder in development and nothing in production.
 *
 * Each node is a component, so visibleWhen can read React state (the slot context) and so a
 * subtree that stops being visible unmounts cleanly. The depth guard is belt and braces: the tree
 * was validated at install time and again when fetched, but a renderer that can recurse without
 * bound is a renderer waiting for the check it does not know about.
 */
import type React from "react";
import { useMemo } from "react";
import { PRIMITIVE_REGISTRY } from "../primitives";
import { instantiate } from "./composites";
import { COMPONENT_REGISTRY } from "./registry";
import { MAX_EXPANDED_DEPTH, splitRef, type ComponentMap, type ComponentNode, type ContainerNode, type LayoutNode } from "./schema";
import { useSlotState } from "./slotContext";
import { isVisible } from "./visibleWhen";

const DEV = process.env.NODE_ENV !== "production";

export interface LayoutRendererProps {
  node: LayoutNode;
  components: ComponentMap;
  depth?: number;
}

const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };
const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
};

function containerStyle(n: ContainerNode): React.CSSProperties {
  const s: React.CSSProperties = { gap: n.gap };
  switch (n.direction) {
    case "row":
    case "column":
      s.display = "flex";
      s.flexDirection = n.direction;
      break;
    case "grid":
      s.display = "grid";
      s.gridTemplateColumns = n.gridTemplate;
      break;
    case "stack":
      // Every child in the same cell: a layered composition (a gradient under a text, say).
      s.display = "grid";
      s.gridTemplateColumns = "minmax(0, 1fr)";
      break;
  }
  if (n.align) s.alignItems = ALIGN[n.align];
  if (n.justify) s.justifyContent = JUSTIFY[n.justify];
  return s;
}

function sizeStyle(n: ComponentNode): React.CSSProperties | undefined {
  if (!n.size) return undefined;
  const s: React.CSSProperties = {};
  if (n.size.flex !== undefined) s.flex = `${n.size.flex} 1 0%`;
  if (n.size.width !== undefined) s.width = n.size.width;
  if (n.size.height !== undefined) s.height = n.size.height;
  return s;
}

function Placeholder({ text }: { text: string }) {
  if (!DEV) return null;
  return (
    <div className="rounded border border-dashed border-danger/60 bg-danger/10 px-2 py-1 font-mono text-[11px] text-danger-ink" role="note">
      {text}
    </div>
  );
}

function ContainerView({ node, components, depth }: { node: ContainerNode; components: ComponentMap; depth: number }) {
  const stack = node.direction === "stack";
  return (
    <div style={containerStyle(node)} className="min-w-0">
      {node.children.map((child, i) =>
        stack ? (
          <div key={i} style={{ gridArea: "1 / 1" }} className="min-w-0">
            <NodeView node={child} components={components} depth={depth + 1} />
          </div>
        ) : (
          <NodeView key={i} node={child} components={components} depth={depth + 1} />
        ),
      )}
    </div>
  );
}

function ComponentView({ node, components, depth }: { node: ComponentNode; components: ComponentMap; depth: number }) {
  const state = useSlotState();
  const ref = splitRef(node.ref);
  // Composite instantiation is per placement; memoised on the node identity so a re-render of the
  // host does not re-substitute every template.
  const instance = useMemo(() => {
    if (ref?.prefix !== "custom") return null;
    const def = components[ref.key];
    return def ? instantiate(node, def) : null;
  }, [ref?.prefix, ref?.key, components, node]);

  if (!isVisible(node.visibleWhen, state)) return null;
  if (!ref) return <Placeholder text={`invalid ref: ${node.ref}`} />;

  let body: React.ReactNode;
  if (ref.prefix === "custom") {
    if (!instance) return <Placeholder text={`unknown composite: ${node.ref}`} />;
    body = <NodeView node={instance} components={components} depth={depth + 1} />;
  } else if (ref.prefix === "primitive") {
    const def = (PRIMITIVE_REGISTRY as Record<string, (typeof PRIMITIVE_REGISTRY)[keyof typeof PRIMITIVE_REGISTRY] | undefined>)[ref.key];
    if (!def) return <Placeholder text={`unknown primitive: ${node.ref}`} />;
    const C = def.component;
    const children = def.acceptsChildren && node.children?.length ? node.children.map((c, i) => <NodeView key={i} node={c} components={components} depth={depth + 1} />) : undefined;
    body = <C {...(node.props ?? {})}>{children}</C>;
  } else {
    const def = (COMPONENT_REGISTRY as Record<string, (typeof COMPONENT_REGISTRY)[keyof typeof COMPONENT_REGISTRY] | undefined>)[ref.key];
    if (!def) return <Placeholder text={`unknown component: ${node.ref}`} />;
    const C = def.component;
    body = <C {...(node.props ?? {})} />;
  }

  const style = sizeStyle(node);
  return style ? (
    <div style={style} className="min-w-0">
      {body}
    </div>
  ) : (
    <>{body}</>
  );
}

export function NodeView({ node, components, depth = 0 }: LayoutRendererProps) {
  if (depth > MAX_EXPANDED_DEPTH) {
    if (DEV) console.warn(`[layout] stopped rendering at depth ${depth}`);
    return null;
  }
  return node.type === "container" ? <ContainerView node={node} components={components} depth={depth} /> : <ComponentView node={node} components={components} depth={depth} />;
}

/** Render a validated layout tree (one region's root node). */
export function LayoutRenderer({ node, components, depth = 0 }: LayoutRendererProps) {
  return <NodeView node={node} components={components} depth={depth} />;
}
