/**
 * Data Bus: resolves a node's declared inputs. See docs/automation-workflow-design.md §7.1.
 *
 * Deliberately **pull-by-reference, not broadcast**. A node receives exactly what its `inputs[]`
 * declares and nothing else -- there is no ambient blackboard it can read from. That is what keeps
 * a chain's context from growing with every step, which is the failure mode already fought in agent
 * chat (see docs/context-compression.md).
 *
 * Ref forms:
 *   run://<nodeId>/<key>   an upstream node's output value
 *   var://<key>            a workflow variable
 */

/** Marker for a value too large to inline; the node fetches it from the artifact store on demand. */
const MAX_INLINE_BYTES = 256 * 1024;

/**
 * Resolve one node's inputs.
 * @param {object} node        NodeDef with `inputs[]`.
 * @param {object} ctx
 * @param {Record<string, Record<string, unknown>>} ctx.outputs  nodeId -> that node's output values.
 * @param {Record<string, unknown>} ctx.variables
 * @returns {{ ok: true, inputs: Record<string, unknown> } | { ok: false, error: string }}
 */
export function resolveInputs(node, { outputs = {}, variables = {} } = {}) {
  const inputs = {};
  for (const binding of node.inputs ?? []) {
    const { as, ref } = binding ?? {};
    if (!as || !ref) return { ok: false, error: `node "${node.id}" has an input with no as/ref` };

    const runMatch = /^run:\/\/([^/]+)\/(.+)$/.exec(ref);
    if (runMatch) {
      const [, fromNode, key] = runMatch;
      const produced = outputs[fromNode];
      if (!produced) {
        // Reaching this means the graph let a node run before its dependency -- a scheduling bug,
        // not a user error, so fail loudly rather than passing undefined downstream.
        return { ok: false, error: `input "${as}" reads node "${fromNode}" which has not produced output` };
      }
      if (!(key in produced)) {
        return { ok: false, error: `input "${as}": node "${fromNode}" produced no "${key}"` };
      }
      inputs[as] = cap(produced[key]);
      continue;
    }

    const varMatch = /^var:\/\/(.+)$/.exec(ref);
    if (varMatch) {
      const key = varMatch[1];
      if (!(key in variables)) return { ok: false, error: `input "${as}": unknown variable "${key}"` };
      inputs[as] = variables[key];
      continue;
    }

    return { ok: false, error: `input "${as}": unsupported ref "${ref}"` };
  }
  return { ok: true, inputs };
}

/**
 * Keep a single value from ballooning the checkpoint and event log. Oversized strings are truncated
 * with an explicit marker -- silent truncation would make a node look like it saw complete input.
 */
function cap(value) {
  if (typeof value !== "string" || value.length <= MAX_INLINE_BYTES) return value;
  return `${value.slice(0, MAX_INLINE_BYTES)}\n…[truncated ${value.length - MAX_INLINE_BYTES} bytes]`;
}

/**
 * Recover a JSON array from an agent's reply.
 *
 * "Reply with ONLY a JSON array" is a request, not a guarantee: models wrap the answer in a ```json
 * fence or open with a sentence of preamble often enough that a strict parse here fails the run for
 * a reason that has nothing to do with the workflow — and it fails *after* the step was paid for.
 * Parse strictly first, then recover, in narrowing order of confidence.
 *
 * What it deliberately does NOT do is dig an array out of an enclosing object: `{"targets":[…]}`
 * has no single obvious answer once there are two keys, and a fan-out guessing wrong runs the wrong
 * list rather than reporting a problem.
 * @returns {unknown[]|null}
 */
function parseJsonList(text) {
  const trimmed = text.trim();
  const attempt = (s) => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(trimmed);
  if (direct) return direct;

  // ```json … ``` — by far the most common wrapper.
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  if (fence) {
    const fenced = attempt(fence[1].trim());
    if (fenced) return fenced;
  }

  // Prose on either side: take the outermost bracket pair and parse that.
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const sliced = attempt(trimmed.slice(start, end + 1));
    if (sliced) return sliced;
  }

  return null;
}

/** One line of what actually arrived. An error that quotes nothing sends the user to the event log. */
function preview(text, max = 140) {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Resolve a `forEach` ref to the list a node should iterate over.
 *
 * Accepts a real array, or a JSON array in a string — an upstream agent node returns its answer as
 * `text`, so "produce a JSON list" is the natural way to feed a fan-out and would otherwise need a
 * separate parsing step.
 * @returns {{ok:true, items:unknown[]} | {ok:false, error:string}}
 */
export function resolveList(ref, { outputs = {}, variables = {} } = {}) {
  const probe = { id: "__forEach", inputs: [{ as: "items", ref }] };
  const res = resolveInputs(probe, { outputs, variables });
  if (!res.ok) return { ok: false, error: res.error };

  let value = res.inputs.items;
  if (typeof value === "string") {
    const list = parseJsonList(value);
    if (!list) {
      // cap() leaves an explicit marker, so this case is knowable. Reporting it as bad JSON would
      // send the user off rewriting a prompt that was already producing exactly the right answer.
      if (value.includes("…[truncated ")) {
        return {
          ok: false,
          error: `forEach "${ref}" was cut off at the inline size limit before it could be parsed; have the previous step return fewer or smaller items`,
        };
      }
      return {
        ok: false,
        error: `forEach "${ref}" is a string that is not valid JSON; got: ${preview(value)}`,
      };
    }
    value = list;
  }
  if (!Array.isArray(value)) return { ok: false, error: `forEach "${ref}" did not resolve to a list` };
  return { ok: true, items: value };
}

/**
 * Build the variable map for a run: declared defaults overlaid with per-run overrides.
 * Secrets are intentionally NOT resolved here -- they stay as refs until the moment of use, so they
 * never reach a checkpoint or the event log (§7.2).
 */
export function buildVariables(definition, overrides = {}) {
  const vars = {};
  for (const decl of definition.variables ?? []) {
    if (decl.type === "secret") continue;
    if (decl.default !== undefined) vars[decl.key] = decl.default;
  }
  return { ...vars, ...overrides };
}
