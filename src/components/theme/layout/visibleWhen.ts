/**
 * The `visibleWhen` conditional language: one comparison, nothing else.
 *
 *   expr    := [ "!" ] path | path op literal
 *   path    := "state" ("." ident)+          (at most 6 segments)
 *   op      := "===" | "!==" | "==" | "!=" | ">" | "<" | ">=" | "<="
 *   literal := 'text' | "text" | number | true | false | null
 *
 * Parsed by hand, evaluated by a switch; there is no eval, no Function, no operator that combines
 * two conditions. The Rust validator (layout.rs::parse_visible_when) accepts exactly this grammar,
 * so an expression that installs is an expression this file understands.
 */

export type Literal = { kind: "str"; value: string } | { kind: "num"; value: number } | { kind: "bool"; value: boolean } | { kind: "null" };

export interface Condition {
  path: string[];
  negate: boolean;
  op: string | null;
  literal: Literal | null;
}

const OPS = ["===", "!==", ">=", "<=", "==", "!=", ">", "<"] as const;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const MAX_LEN = 120;

function parsePath(s: string): string[] | null {
  const parts = s.split(".");
  if (parts[0] !== "state") return null;
  const rest = parts.slice(1);
  if (rest.length === 0 || rest.length > 6 || !rest.every((p) => IDENT.test(p))) return null;
  return rest;
}

function parseLiteral(s: string): Literal | null {
  if (!s) return null;
  const q = s[0];
  if ((q === "'" || q === '"') && s.length >= 2 && s.endsWith(q)) {
    const inner = s.slice(1, -1);
    if (/['"\\]/.test(inner)) return null;
    return { kind: "str", value: inner };
  }
  if (s === "true") return { kind: "bool", value: true };
  if (s === "false") return { kind: "bool", value: false };
  if (s === "null") return { kind: "null" };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? { kind: "num", value: n } : null;
}

export function parseVisibleWhen(expr: string): Condition | null {
  let s = expr.trim();
  if (!s || s.length > MAX_LEN) return null;
  let negate = false;
  if (s.startsWith("!")) {
    negate = true;
    s = s.slice(1).trimStart();
  }
  let opAt = -1;
  let op: string | null = null;
  for (const candidate of OPS) {
    const i = s.indexOf(candidate);
    if (i >= 0 && (opAt < 0 || i < opAt)) {
      opAt = i;
      op = candidate;
    }
  }
  if (op !== null) {
    if (negate) return null;
    const literal = parseLiteral(s.slice(opAt + op.length).trim());
    if (!literal) return null;
    const path = parsePath(s.slice(0, opAt).trimEnd());
    if (!path) return null;
    return { path, negate: false, op, literal };
  }
  const path = parsePath(s);
  return path ? { path, negate, op: null, literal: null } : null;
}

export type AppState = Record<string, unknown>;

function lookup(state: AppState, path: string[]): unknown {
  let cur: unknown = state;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    // Own properties only: `state.constructor` must not walk up to Object.
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function literalValue(l: Literal): unknown {
  return l.kind === "null" ? null : l.value;
}

/** Loose equality without coercion tricks: same value, or both nullish, or equal as strings. */
function loose(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export function evaluateCondition(cond: Condition, state: AppState): boolean {
  const value = lookup(state, cond.path);
  if (cond.op === null) return cond.negate ? !value : !!value;
  const rhs = literalValue(cond.literal!);
  switch (cond.op) {
    case "===":
      return value === rhs;
    case "!==":
      return value !== rhs;
    case "==":
      return loose(value, rhs);
    case "!=":
      return !loose(value, rhs);
    default: {
      const a = Number(value);
      const b = Number(rhs);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return cond.op === ">" ? a > b : cond.op === "<" ? a < b : cond.op === ">=" ? a >= b : a <= b;
    }
  }
}

/** `true` when the node should show. An expression that does not parse hides the node. */
export function isVisible(expr: string | undefined, state: AppState): boolean {
  if (expr === undefined) return true;
  const cond = parseVisibleWhen(expr);
  return cond ? evaluateCondition(cond, state) : false;
}
