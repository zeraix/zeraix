/**
 * The declarative layout schema (Stage 6) and composite components (Stage 6.2), as zod.
 *
 * This mirrors native/skin-engine/src/layout.rs, and the mirroring is deliberate: the engine
 * validates at install time, this validates what the renderer fetched from `skin://current`, and
 * neither trusts the other to have run. Every rule below has a twin in Rust -- the forbidden prop
 * keys, the plain-CSS-value charsets, the visibleWhen grammar, the depth / node / expansion caps.
 * Change one, change both.
 *
 * No React here: test/skin-layout.test.mjs imports this file under plain Node.
 */
import { z } from "zod";
import { parseVisibleWhen } from "./visibleWhen";

export const MAX_DEPTH = 20;
export const MAX_NODES = 500;
export const MAX_EXPANDED_NODES = 2000;
export const MAX_EXPANDED_DEPTH = 32;
export const MAX_PROPS = 32;
export const MAX_STRING_LEN = 2000;
export const MAX_COMPOSITES = 200;
export const MAX_PARAMS = 32;
export const MAX_REGIONS = 32;

export const REF_PREFIXES = ["app:", "primitive:", "custom:"] as const;

export type Primitive = string | number | boolean;
export type Props = Record<string, Primitive>;

/** Keys refused whatever their value: handlers, sinks, React internals. Case-insensitive, plus any `on<Letter>…`. */
export const FORBIDDEN_PROP_KEYS = new Set([
  "eval", "script", "function", "callback", "handler", "__proto__", "constructor", "prototype",
  "dangerouslysetinnerhtml", "innerhtml", "outerhtml", "href", "action", "formaction", "srcdoc",
  "style", "class", "classname", "ref", "key", "children", "is", "as", "html", "xlink:href",
]);

export function isForbiddenPropKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (!key || key.length > 64) return true;
  if (lower.startsWith("on") && (lower.length === 2 || /[a-z]/.test(lower[2]))) return true;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return true;
  return FORBIDDEN_PROP_KEYS.has(lower);
}

/** Digits, letters, `% . , - / ( ) + *` and spaces: enough for `repeat(2, minmax(0, 1fr))` or `calc(100% - 8px)`, nothing that loads. */
const PLAIN_CSS = /^[A-Za-z0-9 %.,\-/()+*]+$/;
const plainCss = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(PLAIN_CSS)
    .refine((v) => !/url\(|expression\(/i.test(v), { message: "must be a plain CSS value" });

/** Names that would land on Object.prototype rather than on the map they are written into. */
const PROTO_NAMES = new Set(["__proto__", "constructor", "prototype"]);
export const IDENT = /^[A-Za-z0-9_-]{1,64}$/;
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const REF = /^(app|primitive|custom):[A-Za-z0-9_.\-]{1,64}$/;
const ident = z.string().regex(IDENT).refine((s) => !PROTO_NAMES.has(s), { message: "reserved name" });

/**
 * The key check runs on the RAW object, before zod's record transform: JSON.parse gives
 * `{"__proto__":"x"}` an own `__proto__` key, but copying it into a fresh object assigns the
 * prototype instead, and a refinement on the copy would never see the key.
 */
const rawKeys = z.any().superRefine((raw, ctx) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    ctx.addIssue({ code: "custom", message: "props must be an object" });
    return;
  }
  const keys = Object.keys(raw as object);
  if (keys.length > MAX_PROPS) ctx.addIssue({ code: "custom", message: `more than ${MAX_PROPS} props` });
  for (const k of keys) {
    if (isForbiddenPropKey(k)) ctx.addIssue({ code: "custom", message: `prop "${k}" is not allowed`, path: [k] });
  }
});

export const propsSchema = rawKeys.pipe(z.record(z.string(), z.union([z.string().max(MAX_STRING_LEN), z.number(), z.boolean()])));

/** A map keyed by names (composites, regions): every raw key checked, then the record, for the same reason as props. */
function namedMap<T extends z.ZodType>(value: T, max: number, what: string) {
  const names = z.any().superRefine((raw, ctx) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      ctx.addIssue({ code: "custom", message: `${what} must be an object` });
      return;
    }
    const keys = Object.keys(raw as object);
    if (keys.length > max) ctx.addIssue({ code: "custom", message: `more than ${max} ${what}` });
    for (const k of keys) {
      if (!IDENT.test(k) || PROTO_NAMES.has(k)) ctx.addIssue({ code: "custom", message: `"${k}" is not a valid name`, path: [k] });
    }
  });
  return names.pipe(z.record(ident, value));
}

export const sizeSchema = z
  .object({
    flex: z.number().min(0).max(100).optional(),
    width: plainCss(64).optional(),
    height: plainCss(64).optional(),
  })
  .strict();

export const directionSchema = z.enum(["row", "column", "grid", "stack"]);
export const alignSchema = z.enum(["start", "center", "end", "stretch", "baseline"]);
export const justifySchema = z.enum(["start", "center", "end", "space-between", "space-around", "space-evenly"]);

export interface ContainerNode {
  type: "container";
  direction: z.infer<typeof directionSchema>;
  gap?: number;
  align?: z.infer<typeof alignSchema>;
  justify?: z.infer<typeof justifySchema>;
  gridTemplate?: string;
  children: LayoutNode[];
}

export interface ComponentNode {
  type: "component";
  ref: string;
  props?: Props;
  visibleWhen?: string;
  size?: z.infer<typeof sizeSchema>;
  /** Rendered only by primitives that accept children (Box); ignored by everything else. */
  children?: LayoutNode[];
}

export type LayoutNode = ContainerNode | ComponentNode;

const visibleWhenSchema = z
  .string()
  .max(120)
  .refine((s) => parseVisibleWhen(s) !== null, { message: "visibleWhen must be a single comparison such as state.theme === 'dark'" });

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("container"),
        direction: directionSchema,
        gap: z.number().min(0).max(200).optional(),
        align: alignSchema.optional(),
        justify: justifySchema.optional(),
        gridTemplate: plainCss(200).optional(),
        children: z.array(layoutNodeSchema).default([]),
      })
      .strict()
      .refine((n) => n.gridTemplate === undefined || n.direction === "grid", { message: "gridTemplate needs direction: grid", path: ["gridTemplate"] }),
    z
      .object({
        type: z.literal("component"),
        ref: z.string().regex(REF, "ref must be app:<key>, primitive:<key> or custom:<key>"),
        props: propsSchema.optional(),
        visibleWhen: visibleWhenSchema.optional(),
        size: sizeSchema.optional(),
        children: z.array(layoutNodeSchema).optional(),
      })
      .strict(),
  ]),
) as z.ZodType<LayoutNode>;

export const compositeDefSchema = z
  .object({
    params: z
      .array(z.string().regex(PARAM_NAME))
      .max(MAX_PARAMS)
      .default([])
      .refine((p) => new Set(p).size === p.length, { message: "duplicate param" }),
    template: layoutNodeSchema,
  })
  .strict();

export type CompositeComponentDef = z.infer<typeof compositeDefSchema>;
export type ComponentMap = Record<string, CompositeComponentDef>;

export const componentsSchema = namedMap(compositeDefSchema, MAX_COMPOSITES, "composites");

export const layoutTreeSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    regions: namedMap(layoutNodeSchema, MAX_REGIONS, "regions"),
  })
  .strict();

export type LayoutTree = z.infer<typeof layoutTreeSchema>;

/* ------------------------------------------------------------ structural checks */

// No parameter properties: Node's type stripping (which the tests run under) does not support them.
export class LayoutError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function splitRef(ref: string): { prefix: "app" | "primitive" | "custom"; key: string } | null {
  const m = /^(app|primitive|custom):(.+)$/.exec(ref);
  return m ? { prefix: m[1] as "app" | "primitive" | "custom", key: m[2] } : null;
}

/** Every `{{name}}` in a string; `{{ name }}` is the same placeholder. */
export function placeholders(s: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

interface WalkCtx {
  components: ComponentMap;
  allowed: ReadonlySet<string>;
  params: { name: string; declared: string[] } | null;
  nodes: number;
}

function walk(node: LayoutNode, depth: number, region: string, ctx: WalkCtx) {
  if (depth > MAX_DEPTH) throw new LayoutError("layoutTooDeep", `layout "${region}" nests deeper than ${MAX_DEPTH} levels`);
  ctx.nodes += 1;
  if (ctx.nodes > MAX_NODES) throw new LayoutError("layoutTooManyNodes", `the layout has more than ${MAX_NODES} nodes`);
  if (node.type === "container") {
    for (const c of node.children) walk(c, depth + 1, region, ctx);
    return;
  }
  const r = splitRef(node.ref);
  if (!r) throw new LayoutError("layoutInvalidRef", `invalid ref "${node.ref}"`);
  if (r.prefix === "custom" ? !(r.key in ctx.components) : !ctx.allowed.has(node.ref)) {
    throw new LayoutError("layoutUnknownRef", `"${node.ref}" is not a registered component`);
  }
  if (ctx.params && node.props) {
    for (const v of Object.values(node.props)) {
      if (typeof v !== "string") continue;
      for (const p of placeholders(v)) {
        if (!ctx.params.declared.includes(p)) throw new LayoutError("layoutUndeclaredParam", `composite "${ctx.params.name}" uses {{${p}}} which is not in its params`);
      }
    }
  }
  for (const c of node.children ?? []) walk(c, depth + 1, region, ctx);
}

interface Expander {
  components: ComponentMap;
  total: number;
  sizes: Map<string, { nodes: number; depth: number }>;
  stack: string[];
}

function add(ex: Expander, n: number) {
  ex.total += n;
  if (ex.total > MAX_EXPANDED_NODES) throw new LayoutError("layoutExpansionTooLarge", `expanding the composites would render more than ${MAX_EXPANDED_NODES} nodes`);
}

function expandNode(node: LayoutNode, depth: number, ex: Expander): { nodes: number; deepest: number } {
  if (depth > MAX_EXPANDED_DEPTH) throw new LayoutError("layoutExpansionTooDeep", `expanding the composites would nest deeper than ${MAX_EXPANDED_DEPTH} levels`);
  add(ex, 1);
  let nodes = 1;
  let deepest = depth;
  if (node.type === "component") {
    const r = splitRef(node.ref);
    if (r?.prefix === "custom") {
      const c = expandComposite(r.key, depth, ex);
      nodes += c.nodes;
      deepest = Math.max(deepest, c.deepest);
    }
  }
  for (const child of node.type === "container" ? node.children : (node.children ?? [])) {
    const c = expandNode(child, depth + 1, ex);
    nodes += c.nodes;
    deepest = Math.max(deepest, c.deepest);
  }
  return { nodes, deepest };
}

function expandComposite(name: string, depth: number, ex: Expander): { nodes: number; deepest: number } {
  const memo = ex.sizes.get(name);
  if (memo) {
    add(ex, memo.nodes);
    const deepest = depth + memo.depth;
    if (deepest > MAX_EXPANDED_DEPTH) throw new LayoutError("layoutExpansionTooDeep", `expanding the composites would nest deeper than ${MAX_EXPANDED_DEPTH} levels`);
    return { nodes: memo.nodes, deepest };
  }
  const at = ex.stack.indexOf(name);
  if (at >= 0) throw new LayoutError("layoutCircularReference", `composite components reference each other in a cycle: ${[...ex.stack.slice(at), name].join(" -> ")}`);
  const def = ex.components[name];
  if (!def) throw new LayoutError("layoutUnknownRef", `"custom:${name}" is not defined`);
  ex.stack.push(name);
  const r = expandNode(def.template, depth + 1, ex);
  ex.stack.pop();
  ex.sizes.set(name, { nodes: r.nodes, depth: r.deepest - depth });
  return r;
}

/** Composite graph checks: params, template refs and placeholders, cycles, expanded size. */
export function checkComponents(components: ComponentMap, allowedRefs: Iterable<string>): void {
  const allowed = new Set(allowedRefs);
  const names = Object.keys(components).sort();
  for (const name of names) {
    const def = components[name];
    walk(def.template, 1, name, { components, allowed, params: { name, declared: def.params }, nodes: 0 });
  }
  for (const name of names) {
    expandComposite(name, 0, { components, total: 0, sizes: new Map(), stack: [] });
  }
}

/** Layout checks against validated composites and the registry: depth, node count, refs, expansion. */
export function checkLayout(tree: LayoutTree, components: ComponentMap, allowedRefs: Iterable<string>): void {
  const allowed = new Set(allowedRefs);
  const ctx: WalkCtx = { components, allowed, params: null, nodes: 0 };
  for (const [region, node] of Object.entries(tree.regions)) walk(node, 1, region, ctx);
  for (const node of Object.values(tree.regions)) expandNode(node, 1, { components, total: 0, sizes: new Map(), stack: [] });
}

export type Parsed = { ok: true; tree: LayoutTree | null; components: ComponentMap } | { ok: false; code: string; message: string };

/**
 * Parse and check both files the way the installer does. `layoutJson` / `componentsJson` are the raw
 * texts (either may be absent).
 */
export function parsePackageLayout(layoutJson: string | null, componentsJson: string | null, allowedRefs: Iterable<string>): Parsed {
  try {
    let components: ComponentMap = {};
    if (componentsJson !== null) {
      const parsed = componentsSchema.safeParse(JSON.parse(componentsJson));
      if (!parsed.success) return { ok: false, code: "layoutMalformed", message: `components.json: ${parsed.error.issues[0]?.message ?? "invalid"}` };
      components = parsed.data;
      checkComponents(components, allowedRefs);
    }
    let tree: LayoutTree | null = null;
    if (layoutJson !== null) {
      const parsed = layoutTreeSchema.safeParse(JSON.parse(layoutJson));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, code: "layoutMalformed", message: `layout.json: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}` };
      }
      tree = parsed.data;
      checkLayout(tree, components, allowedRefs);
    }
    return { ok: true, tree, components };
  } catch (e) {
    if (e instanceof LayoutError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "layoutMalformed", message: String((e as Error)?.message ?? e) };
  }
}
