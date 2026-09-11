/**
 * Composite components at render time: turning `custom:energyCard` plus its props into the
 * template's node tree with `{{param}}` placeholders replaced.
 *
 * Substitution is text-only, on purpose. A placeholder inside a string prop becomes the string
 * form of the argument; nothing is evaluated, concatenated, formatted or looked up. A placeholder
 * for a param the caller did not pass becomes the empty string; text that is not a declared
 * placeholder is left exactly as written. This is the whole "template engine".
 */
import type { ComponentNode, CompositeComponentDef, LayoutNode, Primitive, Props } from "./schema";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,31})\s*\}\}/g;

export function substituteString(text: string, params: Props, declared: readonly string[]): string {
  if (!text.includes("{{")) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    if (!declared.includes(name)) return whole;
    const v = params[name];
    return v === undefined ? "" : String(v);
  });
}

const WHOLE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,31})\s*\}\}$/;

/**
 * A prop that is exactly one placeholder takes the argument's own type: `"value": "{{value}}"` with
 * `value: 80` becomes the number 80, which is what a ProgressBar's schema expects. Still a
 * substitution, not an evaluation -- the argument is copied, never computed.
 */
function substituteProp(v: Primitive, params: Props, declared: readonly string[]): Primitive {
  if (typeof v !== "string") return v;
  const whole = WHOLE.exec(v);
  if (whole && declared.includes(whole[1])) {
    const arg = params[whole[1]];
    return arg === undefined ? "" : arg;
  }
  return substituteString(v, params, declared);
}

function substituteProps(props: Props | undefined, params: Props, declared: readonly string[]): Props | undefined {
  if (!props) return props;
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) out[k] = substituteProp(v, params, declared);
  return out;
}

/** A deep copy of `node` with placeholders in string props replaced. */
export function substituteNode(node: LayoutNode, params: Props, declared: readonly string[]): LayoutNode {
  if (node.type === "container") {
    return { ...node, children: node.children.map((c) => substituteNode(c, params, declared)) };
  }
  const out: ComponentNode = { ...node, props: substituteProps(node.props, params, declared) };
  if (node.children) out.children = node.children.map((c) => substituteNode(c, params, declared));
  return out;
}

/** The arguments a `custom:` node passes: its primitive props, restricted to the declared param names. */
export function paramsFrom(node: ComponentNode, def: CompositeComponentDef): Props {
  const out: Props = {};
  for (const name of def.params) {
    const v = node.props?.[name];
    if (v !== undefined) out[name] = v as Primitive;
  }
  return out;
}

/** Instantiate a composite for one placement. */
export function instantiate(node: ComponentNode, def: CompositeComponentDef): LayoutNode {
  return substituteNode(def.template, paramsFrom(node, def), def.params);
}
