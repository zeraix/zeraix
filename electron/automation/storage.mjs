/**
 * Where automation data lives.
 *
 * This module holds the root directory and nothing else, deliberately with **no `electron` import**.
 * That is what lets db.mjs, definitions.mjs and everything built on top of them be exercised by a
 * plain Node test process (`npm test`) instead of only on a real app launch -- a named import from
 * `electron` cannot be resolved outside Electron, so a single such import anywhere in the dependency
 * chain makes the whole chain untestable.
 *
 * paths.mjs owns the Electron side and calls setAutomationRoot() during startup; tests point it at a
 * temp directory instead.
 */
import path from "node:path";

let root = null;

/** Configure the root. Called once at startup (see paths.mjs) or by a test with a temp dir. */
export function setAutomationRoot(dir) {
  root = dir;
  return root;
}

/** The configured root. Throws rather than silently writing to a wrong-but-plausible location. */
export function automationRoot() {
  if (!root) {
    throw new Error(
      "automation root is not configured -- call setAutomationRoot() during startup (see paths.mjs)",
    );
  }
  return root;
}

/** Whether a root has been configured (lets callers no-op cleanly before startup finishes). */
export function isConfigured() {
  return root !== null;
}

export const dbFile = () => path.join(automationRoot(), "automation.db");
export const workflowsDir = () => path.join(automationRoot(), "workflows");
