/**
 * Routes sub-agent scheduling between the renderer and the Rust runtime.
 *
 * The split, from docs/agent-runtime-stage4-report.md: the runtime decides *whether, when and how
 * many* — order, coalescing, the per-turn cap, a process-global concurrency limit, the cancellation
 * tree, delivering each outcome exactly once. The renderer decides *what a sub-agent says*, because
 * that means holding a model conversation, and the model transport lives there.
 *
 * Neither can reach the other directly: the sidecar is a child of the main process, and the renderer
 * is sandboxed. So this sits in the middle and does exactly two things.
 *
 * ## Which renderer
 *
 * A delegation has to run in the window that started the turn — that is where the conversation, the
 * tool consent queue and the display sinks are. Ownership is recorded when the renderer spawns, which
 * is the one moment both the turn id and the sender are in the same place. A `subagent.run` for a turn
 * whose window has since closed is refused rather than broadcast: running someone else's delegation in
 * another window would attach its output to the wrong conversation.
 *
 * ## Opt-in, deliberately
 *
 * Off unless `ZERAIX_RUST_SUBAGENTS` says otherwise, independently of `ZERAIX_RUST_RUNTIME`. Every
 * other stage of this migration was proven by an A/B harness comparing byte-for-byte output; a
 * delegation's output comes from a model, so no such comparison exists and the only real test is
 * running the app. Until that has happened, a packaged build keeps the renderer's own scheduler — the
 * one that has been in front of users — rather than defaulting to a path nothing has exercised.
 */
import { ipcMain } from "electron";

import { onRequest, subagentCancel, subagentJoin, subagentSpawn } from "../tools/rustRuntime.mjs";

/** How long a delegation may sit unclaimed before the runtime is told it cannot be run. */
const RUN_TIMEOUT_MS = 30 * 60_000;

/** turnId -> the webContents that owns it. */
const owners = new Map();
/** requestId -> { resolve, reject, timer } for a delegation the renderer is running. */
const inflight = new Map();
let seq = 0;

/** Whether the runtime should schedule sub-agents. See the header: off until smoke-tested. */
export function subagentsEnabled() {
  const raw = String(process.env.ZERAIX_RUST_SUBAGENTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}

/** Forget a window's turns when it goes away, so a closed window cannot be sent work. */
function dropOwner(contents) {
  for (const [turnId, wc] of [...owners.entries()]) {
    if (wc === contents) owners.delete(turnId);
  }
}

/**
 * Ask the renderer to run one delegation, and wait for its conclusion.
 *
 * Registered as the handler for the runtime's `subagent.run` request. Every path ends in a value or a
 * throw, because the runtime is blocking a job on this answer — silence would read as a sub-agent that
 * worked for thirty minutes.
 */
async function runDelegationInRenderer({ turn, job, meta, depth }) {
  const target = owners.get(turn);
  if (!target || target.isDestroyed()) {
    throw new Error(`no window is running turn ${turn}`);
  }
  const requestId = `sr${++seq}`;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(requestId);
      reject(new Error("the window did not answer in time"));
    }, RUN_TIMEOUT_MS);
    // Registered BEFORE the send. The renderer can reply in the same tick it receives, and an answer
    // arriving before this entry existed would be dropped -- the registration race that has now cost
    // this migration four fixes (see D12 in docs/agent-runtime-migration.md).
    inflight.set(requestId, { resolve, reject, timer });
  });
  target.send("subagent:run", { requestId, turnId: turn, jobId: job, meta, depth });
  return answer;
}

/** Wire the bridge up. Safe to call when the runtime is off: it registers handlers and starts nothing. */
export function initSubagentBridge() {
  onRequest("subagent.run", runDelegationInRenderer);

  ipcMain.handle("subagent:spawn", async (e, { turnId, jobs }) => {
    // Refused here as well as in preload. Two gates rather than one because they fail differently: a
    // preload built before this flag existed would still expose the bridge, and this is the side that
    // would then hand real delegations to the runtime.
    if (!subagentsEnabled()) return null;
    // Recorded here because this is the one moment the turn id and the window are both in hand.
    owners.set(turnId, e.sender);
    e.sender.once("destroyed", () => dropOwner(e.sender));
    return subagentSpawn(turnId, jobs);
  });

  ipcMain.handle("subagent:join", async (_e, { turnId, ids, mode, timeoutMs, block }) =>
    subagentJoin(turnId, { ids, mode, timeoutMs, block }),
  );

  ipcMain.handle("subagent:cancel", async (_e, { turnId, reason }) => {
    owners.delete(turnId);
    await subagentCancel(turnId, reason);
    return { ok: true };
  });

  // One-way, like ai-tools:cancel: this settles a promise created by a different call, so there is no
  // invoke to reply to.
  ipcMain.on("subagent:reply", (_e, { requestId, result, error }) => {
    const entry = inflight.get(requestId);
    if (!entry) return; // already timed out, or the turn was cancelled
    inflight.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(String(error)));
    else entry.resolve({ result: String(result ?? "") });
  });
}

/** Stop tracking a window. Called when one closes. */
export function releaseSubagentWindow(contents) {
  dropOwner(contents);
}
