/**
 * Removing an automation root that a run was just using.
 *
 * A shell node's cwd is its run directory (electron/automation/storage.mjs runDir), which sits inside
 * the automation root -- so on Windows the root cannot be removed while any child of that run still
 * holds it. That is not a leak the tests can assert their way out of: `shutdown()` aborts a run and
 * disposes the dispatcher, but it does not await the death of a child it signalled, and on Windows a
 * shell node is `powershell.exe`, which is slow both to start and to die. A test that resumes a run
 * and shuts down without awaiting it (approval.test.mjs "a decision cannot be made twice" is the one
 * that actually trips) can reach this line while that process is still coming up.
 *
 * So: retry, because the wait needed is however long the OS takes rather than a number we can pick,
 * and then give up rather than fail. The temp root lives under os.tmpdir() and the OS reclaims it; a
 * test whose assertions all passed must not be reported as failing over its own housekeeping. Anything
 * left behind is named on stderr rather than swallowed, so a genuine leak is still visible.
 */
import fs from "node:fs";

/** Busy-directory errors: someone still holds the tree, as opposed to a real bug in the removal. */
const BUSY = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

/** Remove a test's temp automation root, tolerating a child that has not fully died yet. */
export function removeRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch (e) {
    if (!BUSY.has(e?.code)) throw e;
    console.warn(`[test] left ${root} behind (${e.code}) -- a child of the run still holds it`);
  }
}
