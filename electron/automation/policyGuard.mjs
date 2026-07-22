/**
 * Policy Guard: budget ceilings and tool permissions. See docs/automation-workflow-design.md §3.1.
 *
 * Enforced at the Node Dispatcher, not inside a runtime, so every node type passes through it and a
 * future runtime author cannot forget to add the check.
 *
 * Two enforcement points, because one is not enough:
 *   - `beforeNode()` runs at dispatch. Catches "we are already over budget, do not start another step."
 *   - `noteUsage()` runs mid-node, after each usage report. Without it a single agent node could burn
 *     an entire budget in one step: nothing would check again until it finished, by which point the
 *     money is spent. This is the check that actually bounds spending.
 *
 * Cost honesty: USD is only enforceable when a price is configured for the model. Providers do not
 * return a price, so an unconfigured model accrues tokens but zero dollars — and `maxCostUsd` would
 * silently never bind. Rather than pretend, the guard reports that once per run so the run log says
 * plainly that the ceiling is inert.
 */

/** Distinguishes a budget stop from a crash, so the manager can record why the run ended. */
export class BudgetExceededError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BudgetExceededError";
  }
}

/**
 * @param {object} opts
 * @param {object} opts.limits        RunLimits from the definition.
 * @param {{tokens:number, costUsd:number}} [opts.seed]  Totals already accrued (a resumed run).
 * @param {number} [opts.startedAt]   Run start, for maxDurationMs.
 * @param {(model:string)=>number|null} [opts.priceFor]  USD per 1M tokens, or null if unknown.
 * @param {() => number} [opts.now]
 */
export function createPolicyGuard({ limits = {}, seed = {}, startedAt = null, priceFor = () => null, now = () => Date.now() } = {}) {
  let tokens = seed.tokens ?? 0;
  let costUsd = seed.costUsd ?? 0;
  let started = startedAt ?? now();
  let warnedNoPrice = false;
  const warnings = [];

  /** The single place a ceiling is compared, so pre-node and mid-node cannot drift apart. */
  function evaluate() {
    if (limits.maxTokens && tokens >= limits.maxTokens) {
      return { allow: false, reason: `token ceiling reached (${tokens}/${limits.maxTokens})` };
    }
    if (limits.maxCostUsd && costUsd >= limits.maxCostUsd) {
      return { allow: false, reason: `cost ceiling reached ($${costUsd.toFixed(4)}/$${limits.maxCostUsd})` };
    }
    if (limits.maxDurationMs && now() - started >= limits.maxDurationMs) {
      return { allow: false, reason: `time limit reached (${Math.round((now() - started) / 1000)}s)` };
    }
    return { allow: true };
  }

  return {
    /** Dispatcher chokepoint: may this node start? */
    beforeNode(ctx) {
      const budget = evaluate();
      if (!budget.allow) return budget;

      // Tool permissions are a workflow-level statement about what a step may touch; `deny` wins so
      // a broad allow-list cannot re-enable something explicitly forbidden.
      const policy = ctx?.config?.toolPolicy;
      if (policy?.deny?.length && ctx?.runtime === "shell") {
        // A shell node can invoke anything, so a deny-list it could trivially bypass is worse than
        // useless -- it reads as protection that is not there.
        return { allow: false, reason: "toolPolicy cannot constrain a shell node; use an agent node" };
      }
      return { allow: true };
    },

    /**
     * Mid-node usage report. Throwing here is deliberate: it aborts the in-flight node immediately
     * rather than letting it run to completion and checking afterwards.
     */
    noteUsage({ tokens: t = 0, costUsd: c = 0, model = null } = {}) {
      tokens += t;
      if (c) {
        costUsd += c;
      } else if (t && model) {
        const perMillion = priceFor(model);
        if (perMillion != null) {
          costUsd += (t / 1_000_000) * perMillion;
        } else if (limits.maxCostUsd && !warnedNoPrice) {
          warnedNoPrice = true;
          warnings.push(
            `maxCostUsd is set but no price is configured for "${model}", so the cost ceiling cannot be enforced (the token ceiling still applies)`,
          );
        }
      }
      const budget = evaluate();
      if (!budget.allow) throw new BudgetExceededError(budget.reason);
      return budget;
    },

    /** Warnings accumulated so far; the manager drains these into the event log. */
    drainWarnings() {
      return warnings.splice(0, warnings.length);
    },

    totals() {
      return { tokens, costUsd };
    },
  };
}
