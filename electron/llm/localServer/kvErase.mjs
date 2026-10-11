/**
 * Forgetting deleted conversations' persisted KV (main process): the erase calls the renderer drives through IPC, and the
 * on-disk queue that carries ids deleted while no server was running until one becomes ready.
 *
 * Part of localServer.mjs, which re-exports the public names here.
 */
import path from "node:path";
import fs from "node:fs";
import { state, kvDiskDir, pushLog } from "./state.mjs";

/**
 * Tell the server to forget ONE conversation's persisted KV. Shorthand for the list form below, which is where the
 * behaviour is described.
 */
export async function eraseConversationKv(conversationId) {
  return eraseConversationsKv([conversationId]);
}

/**
 * Ids waiting to be forgotten. Deleting a conversation with no local server running is the COMMON case, and the
 * ids die with the conversation record — so without this file the KV of everything deleted while the server was
 * down would stay on disk forever, unnameable.
 *
 * Kept beside the KV it refers to, so a storage-dir change moves (or leaves) the two together.
 */
const pendingErasePath = () => path.join(kvDiskDir(), "pending-erase.json");

function readPendingErase() {
  try {
    const v = JSON.parse(fs.readFileSync(pendingErasePath(), "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return []; // absent or corrupt — the queue is an optimisation over a leak, never a source of truth
  }
}

function writePendingErase(ids) {
  try {
    if (!ids.length) { fs.rmSync(pendingErasePath(), { force: true }); return; }
    fs.mkdirSync(kvDiskDir(), { recursive: true });
    fs.writeFileSync(pendingErasePath(), JSON.stringify(ids));
  } catch { /* a queue we cannot persist still works for this session */ }
}

/**
 * Forget the persisted KV of one or more conversations.
 *
 * The server keeps a conversation's KV on disk for as long as its tip manifest exists, and nothing else ever removes
 * one — so without this call, deleting a conversation in the UI left its KV behind permanently and the kv directory
 * only grew. The server also detaches any slot still holding one, otherwise an eviction spill would write the tip
 * straight back.
 *
 * A LIST because deleting one thing in the UI can mean several conversations here: a conversation and every
 * sub-agent it ran, or a project and everything in it. The app is what knows they belong together — to the
 * server they are unrelated ids — so it names them all in one call, which the server erases in a single pass.
 *
 * Recorded BEFORE the request, not after: a crash mid-call must not lose the id. A queue that is a superset of
 * what is on disk is harmless (erasing an id that never spilled is a no-op the server reports as erased: 0);
 * the other direction leaks.
 *
 * Never throws, and never blocks a delete: the server may be stopped, mid-restart, or an older build without the
 * route. `ok:false` means the ids stayed queued for the next server that becomes ready — "later", not "lost".
 */
export async function eraseConversationsKv(conversationIds) {
  const ids = [...new Set((conversationIds ?? []).map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (!ids.length) return { ok: true, erased: 0 };
  // No KV directory means no server ever wrote a tip here, so there is nothing to forget and nothing to queue.
  // Without this a cloud-only user — who never runs a local model — would accumulate a queue of ids for KV that
  // does not exist, and have an empty kv/ folder created just to hold it.
  if (!fs.existsSync(kvDiskDir())) return { ok: true, erased: 0 };
  const queued = readPendingErase();
  const merged = [...new Set([...queued, ...ids])];
  if (merged.length !== queued.length) writePendingErase(merged);
  return flushPendingErase();
}

/**
 * Send the queue to the running server, dropping what it accepted.
 *
 * Chunked because a project delete can carry thousands of ids (one per sub-agent run), and one unbounded body
 * is a needless bet on the server's request limit. Each chunk is a single task on the server's main loop.
 *
 * Called on every erase and again when a server becomes ready, which is what makes "deleted while stopped"
 * eventually consistent rather than lost.
 */
export async function flushPendingErase() {
  const pending = readPendingErase();
  if (!pending.length) return { ok: true, erased: 0 };
  if (!state.port || !state.proc || !state.ready) return { ok: false, reason: "server not running", pending: pending.length };

  let erased = 0;
  for (let i = 0; i < pending.length; i += 256) {
    const chunk = pending.slice(i, i + 256);
    try {
      let res = await fetch(`http://127.0.0.1:${state.port}/kv/conversations/erase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk }),
      });
      let body = res.ok ? await res.json().catch(() => ({})) : null;
      // A runtime older than the batch route (it 404s) still has the per-id one. The app and the llama build ship
      // separately, so an app update can land on an installed runtime that predates it — without this, erasing would
      // silently stop working for exactly as long as that lasts, which is worse than before the batch route existed.
      // `erased` reads the same either way: the old route answers with a bool, and Number(true) is 1.
      if (res.status === 404) {
        let n = 0;
        for (const id of chunk) {
          const one = await fetch(`http://127.0.0.1:${state.port}/kv/conversation/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (!one.ok) return { ok: false, reason: `HTTP ${one.status}`, pending: readPendingErase().length };
          const ob = await one.json().catch(() => ({}));
          n += Number(ob?.erased ?? 0);
        }
        res = { ok: true };
        body = { erased: n };
      }
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, pending: readPendingErase().length };
      erased += Number(body?.erased ?? 0);
      // Re-read: an erase queued while the request was in flight must not be dropped with this chunk.
      const sent = new Set(chunk);
      writePendingErase(readPendingErase().filter((id) => !sent.has(id)));
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e), pending: readPendingErase().length };
    }
  }
  if (erased) pushLog(`[llama] forgot KV for ${erased} deleted conversation(s)\n`);
  return { ok: true, erased };
}
