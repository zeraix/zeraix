/**
 * Workflow definition schema + validation. See docs/automation-workflow-design.md §4.
 *
 * Definitions are hand-editable JSON files, so validation is a real trust boundary, not a formality:
 * a malformed or cyclic graph must be rejected at save/load time rather than discovered halfway
 * through a run when nodes have already touched the filesystem.
 *
 * v1 note: the model is a DAG (edges[], design doc §4.1) but the runtime only accepts a single
 * linear chain. Keeping edges[] in the schema preserves the migration path without shipping a class
 * of workflow the editor cannot render -- see design doc §13, open question 4.
 */

export const RUNTIME_KINDS = ["agent", "shell", "python", "browser", "mcp", "webhook"];
/** Implemented so far. Everything else parses but cannot run yet (design doc §4.2). */
export const IMPLEMENTED_RUNTIMES = ["shell"];

export const TRIGGER_TYPES = ["cron", "manual", "file-watch", "deeplink"];
export const MISSED_RUN_POLICIES = ["skip", "run-once-on-launch", "backfill"];
export const CONCURRENCY_MODES = ["single", "queue", "parallel"];
// `file` holds an absolute path the user picked at run time (a resume, a spreadsheet). The path is
// stored, never the bytes -- run records would otherwise balloon and the document would end up
// duplicated inside the event log.
export const VARIABLE_TYPES = ["string", "number", "boolean", "json", "secret", "file"];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
/** Ids appear in file paths and data-bus refs, so keep them boring. */
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate a workflow definition.
 * @param {any} def
 * @returns {{ ok: boolean, errors: string[] }} Every problem found, not just the first -- a hand-edited
 *   file with three mistakes should report three, not force three save/fix rounds.
 */
export function validateDefinition(def) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!isPlainObject(def)) return { ok: false, errors: ["definition must be an object"] };

  if (!ID_RE.test(def.id ?? "")) err("id must match [a-zA-Z0-9_-]{1,64}");
  if (!Number.isInteger(def.version) || def.version < 1) err("version must be an integer >= 1");
  if (!isNonEmptyString(def.name)) err("name is required");

  /* ------------------------------------------------------------------ triggers */
  const triggers = def.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0) {
    err("triggers must be a non-empty array");
  } else {
    const seen = new Set();
    triggers.forEach((t, i) => {
      const at = `triggers[${i}]`;
      if (!isPlainObject(t)) return err(`${at} must be an object`);
      if (!ID_RE.test(t.id ?? "")) err(`${at}.id must match [a-zA-Z0-9_-]{1,64}`);
      else if (seen.has(t.id)) err(`${at}.id "${t.id}" is duplicated`);
      else seen.add(t.id);
      if (!TRIGGER_TYPES.includes(t.type)) err(`${at}.type must be one of ${TRIGGER_TYPES.join("|")}`);
      // Only time-driven triggers can miss a fire while the app is closed; requiring the policy on
      // manual/deeplink triggers would be noise (design doc §12.2).
      if (t.type === "cron" || t.type === "file-watch") {
        if (!MISSED_RUN_POLICIES.includes(t.missedRunPolicy)) {
          err(`${at}.missedRunPolicy must be one of ${MISSED_RUN_POLICIES.join("|")}`);
        }
        if (t.type === "cron" && !isNonEmptyString(t.config?.expression)) {
          err(`${at}.config.expression is required for cron triggers`);
        }
      }
      if ("lastFiredAt" in t) {
        // Run state must not live in the definition, or editing a workflow would rewrite scheduling
        // history (design doc §2, principle 1). It belongs in the trigger_state table.
        err(`${at}.lastFiredAt must not be stored in the definition (it is run state)`);
      }
    });
  }

  /* ----------------------------------------------------------------- variables */
  if (def.variables != null) {
    if (!Array.isArray(def.variables)) err("variables must be an array");
    else {
      const seen = new Set();
      def.variables.forEach((v, i) => {
        const at = `variables[${i}]`;
        if (!isPlainObject(v)) return err(`${at} must be an object`);
        if (!isNonEmptyString(v.key)) err(`${at}.key is required`);
        else if (seen.has(v.key)) err(`${at}.key "${v.key}" is duplicated`);
        else seen.add(v.key);
        if (!VARIABLE_TYPES.includes(v.type)) err(`${at}.type must be one of ${VARIABLE_TYPES.join("|")}`);
        // A literal secret in a definition file would be committed, synced, and exported in plain
        // text. Secrets are referenced, never inlined (design doc §7.2).
        if (v.type === "secret" && v.default != null) {
          err(`${at}: secret variables must use secretRef, never an inline default`);
        }
        if (v.required != null && typeof v.required !== "boolean") {
          err(`${at}.required must be a boolean`);
        }
        // A required variable with a default can never actually be required -- the default always
        // satisfies it, so the user is never asked and the "required" reads as a guarantee that is
        // not there.
        if (v.required && v.default !== undefined) {
          err(`${at}: a required variable cannot also have a default`);
        }
        if (v.label != null && typeof v.label !== "string") {
          err(`${at}.label must be a string`);
        }
      });
    }
  }

  /* -------------------------------------------------------------------- limits */
  const limits = def.limits;
  if (!isPlainObject(limits)) {
    err("limits is required (a runaway scheduled workflow spends real money)");
  } else {
    if (!CONCURRENCY_MODES.includes(limits.concurrency)) {
      err(`limits.concurrency must be one of ${CONCURRENCY_MODES.join("|")}`);
    }
    for (const k of ["maxTokens", "maxCostUsd", "maxDurationMs"]) {
      if (limits[k] != null && !(typeof limits[k] === "number" && limits[k] > 0)) {
        err(`limits.${k} must be a positive number when present`);
      }
    }
  }

  /* --------------------------------------------------------------------- nodes */
  const nodes = def.nodes;
  const nodeIds = new Set();
  if (!Array.isArray(nodes) || nodes.length === 0) {
    err("nodes must be a non-empty array");
  } else {
    nodes.forEach((n, i) => {
      const at = `nodes[${i}]`;
      if (!isPlainObject(n)) return err(`${at} must be an object`);
      if (!ID_RE.test(n.id ?? "")) err(`${at}.id must match [a-zA-Z0-9_-]{1,64}`);
      else if (nodeIds.has(n.id)) err(`${at}.id "${n.id}" is duplicated`);
      else nodeIds.add(n.id);
      if (!RUNTIME_KINDS.includes(n.runtime)) err(`${at}.runtime must be one of ${RUNTIME_KINDS.join("|")}`);
      if (n.inputs != null && !Array.isArray(n.inputs)) err(`${at}.inputs must be an array`);
      if (n.retry != null) {
        if (!Number.isInteger(n.retry.attempts) || n.retry.attempts < 1) {
          err(`${at}.retry.attempts must be an integer >= 1`);
        }
      }
      if (n.timeoutMs != null && !(typeof n.timeoutMs === "number" && n.timeoutMs > 0)) {
        err(`${at}.timeoutMs must be a positive number`);
      }
      // Human approval gate. `approvalTimeoutMs` bounds how long the run waits; without a bound an
      // unanswered gate would hold a run open forever, which for something like "apply to this
      // company" silently means the opportunity lapses with no record of a decision.
      if (n.requiresApproval != null && typeof n.requiresApproval !== "boolean") {
        err(`${at}.requiresApproval must be a boolean`);
      }
      if (n.approvalTimeoutMs != null && !(typeof n.approvalTimeoutMs === "number" && n.approvalTimeoutMs > 0)) {
        err(`${at}.approvalTimeoutMs must be a positive number`);
      }
      if (n.onApprovalTimeout != null && !["reject", "approve"].includes(n.onApprovalTimeout)) {
        err(`${at}.onApprovalTimeout must be "reject" or "approve"`);
      }
      // Auto-approving an outward-facing action on a timer defeats the point of the gate, so it has
      // to be spelled out rather than inherited from a default.
      if (n.onApprovalTimeout === "approve" && !n.approvalTimeoutMs) {
        err(`${at}.onApprovalTimeout "approve" requires an explicit approvalTimeoutMs`);
      }
      // Fan-out: run this node once per item of a list produced upstream.
      //
      // Modelled as iteration WITHIN a node rather than as graph-level parallelism, so `edges[]`
      // stays a plain chain and the Timeline stays readable. Each item gets its own checkpoint,
      // attempt row and (if gated) approval, keyed `<nodeId>#<index>`.
      if (n.forEach != null) {
        if (!isNonEmptyString(n.forEach)) {
          err(`${at}.forEach must be a ref string`);
        } else if (!/^(run:\/\/[^/]+\/.+|var:\/\/.+)$/.test(n.forEach)) {
          err(`${at}.forEach must be run://<nodeId>/<key> or var://<key>`);
        }
        // An unbounded fan-out over a model-generated list is how a workflow accidentally makes a
        // thousand paid calls, so a cap is required rather than defaulted.
        if (!Number.isInteger(n.maxItems) || n.maxItems < 1) {
          err(`${at}.maxItems is required with forEach (an integer >= 1)`);
        }
        if (n.onItemError != null && !["fail", "continue"].includes(n.onItemError)) {
          err(`${at}.onItemError must be "fail" or "continue"`);
        }
      } else if (n.maxItems != null || n.onItemError != null) {
        err(`${at}.maxItems/onItemError only apply with forEach`);
      }
      // Wait-for-event gate: suspend until a matching inbound event arrives.
      if (n.waitFor != null) {
        const w = n.waitFor;
        if (!isPlainObject(w)) {
          err(`${at}.waitFor must be an object`);
        } else {
          if (!isNonEmptyString(w.key)) err(`${at}.waitFor.key is required`);
          if (w.timeoutMs != null && !(typeof w.timeoutMs === "number" && w.timeoutMs > 0)) {
            err(`${at}.waitFor.timeoutMs must be a positive number`);
          }
          if (w.onTimeout != null && !["fail", "continue"].includes(w.onTimeout)) {
            err(`${at}.waitFor.onTimeout must be "fail" or "continue"`);
          }
          // A wait with no deadline holds a run open forever. For "did the employer reply?" that
          // means the run silently never finishes and nothing ever says why.
          if (!w.timeoutMs) {
            err(`${at}.waitFor.timeoutMs is required (an unbounded wait never resolves or reports)`);
          }
        }
      }
      // Canvas coordinates for the visual editor. Purely presentational -- the runtime derives
      // execution order from edges[], never from geometry -- but validated so a hand-edited file
      // with a malformed position fails at save time instead of breaking the editor on open.
      if (n.position != null) {
        const p = n.position;
        if (!isPlainObject(p) || typeof p.x !== "number" || typeof p.y !== "number") {
          err(`${at}.position must be { x: number, y: number }`);
        }
      }
    });
  }

  /* --------------------------------------------------------------------- edges */
  const edges = def.edges ?? [];
  if (!Array.isArray(edges)) {
    err("edges must be an array");
  } else if (nodeIds.size > 0) {
    edges.forEach((e, i) => {
      const at = `edges[${i}]`;
      if (!isPlainObject(e)) return err(`${at} must be an object`);
      if (!nodeIds.has(e.from)) err(`${at}.from references unknown node "${e.from}"`);
      if (!nodeIds.has(e.to)) err(`${at}.to references unknown node "${e.to}"`);
      if (e.from === e.to) err(`${at} is a self-loop`);
    });
    if (errors.length === 0) {
      const cycle = findCycle(nodes, edges);
      if (cycle) err(`edges form a cycle: ${cycle.join(" -> ")}`);
    }
  }

  /* ------------------------------------------------- inputs reference real nodes */
  if (nodeIds.size > 0) {
    nodes.forEach((n, i) => {
      (n.inputs ?? []).forEach((inp, j) => {
        const at = `nodes[${i}].inputs[${j}]`;
        if (!isPlainObject(inp)) return err(`${at} must be an object`);
        if (!isNonEmptyString(inp.as)) err(`${at}.as is required`);
        const ref = inp.ref;
        if (!isNonEmptyString(ref)) return err(`${at}.ref is required`);
        // run://<nodeId>/<key> resolves against this run; var://<key> against the variable store.
        const m = /^run:\/\/([^/]+)\/(.+)$/.exec(ref);
        if (m) {
          if (!nodeIds.has(m[1])) err(`${at}.ref points at unknown node "${m[1]}"`);
        } else if (!/^var:\/\/.+$/.test(ref)) {
          err(`${at}.ref must be run://<nodeId>/<key> or var://<key>`);
        }
      });
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Depth-first cycle detection. Returns the offending path, or null when the graph is acyclic.
 * A cycle would make the run never terminate, so this is a hard reject rather than a warning.
 */
function findCycle(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(nodes.map((n) => [n.id, WHITE]));
  const stack = [];

  const visit = (id) => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      if (color.get(next) === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (color.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = visit(n.id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Topologically order a validated definition, rejecting anything the v1 runtime cannot execute.
 * Enforcing "single linear chain" here (rather than in the schema) is what lets edges[] stay a DAG
 * in the file format while the runtime stays simple.
 * @returns {{ ok: boolean, order?: string[], error?: string }}
 */
export function linearOrder(def) {
  const nodes = def.nodes ?? [];
  const edges = def.edges ?? [];
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    out.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

  const roots = nodes.filter((n) => indeg.get(n.id) === 0);
  if (roots.length !== 1) return { ok: false, error: `expected exactly 1 start node, found ${roots.length}` };

  const order = [];
  let cur = roots[0].id;
  for (;;) {
    order.push(cur);
    const next = out.get(cur);
    if (next.length === 0) break;
    if (next.length > 1) return { ok: false, error: `node "${cur}" branches; v1 supports a single chain` };
    cur = next[0];
  }
  if (order.length !== nodes.length) {
    return { ok: false, error: "graph is not a single connected chain (unreachable nodes)" };
  }
  return { ok: true, order };
}
