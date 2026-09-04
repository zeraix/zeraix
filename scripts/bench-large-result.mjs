/**
 * The large-result benchmark: what one 100 MB `read_file` result costs the app after the tool returns.
 *
 * Two halves, each against the real module in plain Node:
 *   store  — a project whose one conversation holds the result: first save (writes the blob), steady-state
 *            save (the document only), load (blob read back), document size, and the heap the save leaves.
 *   wire   — the withholding rule on the same result: what the model would be sent, and what deciding costs.
 *
 * Targets were set before the change (2026-09-04) from the measured baseline, and the script exits non-zero
 * when one is missed so it can gate a change — including a future port of either half to the Rust runtime,
 * which has to beat these numbers, not merely match the interface.
 *
 *   node --expose-gc scripts/bench-large-result.mjs [sizeMB]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import "./electron-stub-hook.mjs";

register("../test/helpers/srcResolve.mjs", import.meta.url);
const store = await import("../electron/store/conversationStore.mjs");
const { encryptionStatus } = await import("../electron/integrity/integrityStore.mjs");
const { buildWireContext, indexCalls, resultCeilingTokens, withholdOversizedResults } = await import(
  "../src/app/agent/chat/contextCompress.ts"
);
const { countMessagesTokens } = await import("../src/lib/ai/tokenizer.ts");

const MB = 1024 * 1024;
const sizeMB = Number(process.argv[2]) || 100;
const gc = () => globalThis.gc?.();
const heapMB = () => process.memoryUsage().heapUsed / MB;
const rows = [];
const check = (metric, value, unit, target, ok) => rows.push({ metric, value, unit, target, ok });
async function timed(fn) {
  gc();
  const h0 = heapMB();
  const t0 = performance.now();
  const v = await fn();
  const ms = performance.now() - t0;
  gc();
  return { v, ms, heapDelta: heapMB() - h0 };
}

const line = "const value = compute(index) + otherValue * 3; // a fairly typical line of source text here\n";
let content = "";
while (content.length < sizeMB * MB) content += line;
content = content.slice(0, sizeMB * MB);
content.indexOf("\n"); // flatten, as a string that arrived over IPC already is

// ── store ───────────────────────────────────────────────────────────────────────
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zeraix-bench-"));
await store.setStorePath(dir);
const conv = {
  id: "conv-1",
  projectId: "p1",
  messages: [
    { role: "user", content: "read the whole log" },
    { role: "tool", tool_call_id: "c1", name: "read_file", content },
    { role: "assistant", content: "that is a lot of log" },
  ],
};
const first = await timed(() => store.saveProject("p1", [conv]));
check("store: first save (writes the blob)", first.ms, "ms", "informational", true);
const steady = await timed(() => store.saveProject("p1", [conv]));
check("store: steady-state save", steady.ms, "ms", "≤ 350", steady.ms <= 350);
check("store: heap left by a save", steady.heapDelta, "MB", "≤ 16", steady.heapDelta <= 16);
const doc = await fs.stat(path.join(dir, "conversations", "p1.json"));
check("store: document size", doc.size / 1024, "KB", "≤ 64", doc.size <= 64 * 1024);
const blobFiles = await fs.readdir(path.join(dir, "conversations", "p1.blobs"));
check("store: blob files", blobFiles.length, "", "= 1", blobFiles.length === 1);
// Over INLINE_LOAD_MAX_CHARS the blob is not read at all: the document comes back with a note in its place and the
// process holds no copy of the result. Reading it — decrypt, stringify, clone to the renderer — used to be the whole
// cost of opening the app (1.4 GB resident for a 200 MB result, 2026-09-04), so the target here is "did not read it".
const encrypted = encryptionStatus().enabled;
const load = await timed(() => store.loadProject("p1"));
check(`store: load (${encrypted ? "encrypted" : "plaintext"})`, load.ms, "ms", "≤ 100", load.ms <= 100);
check("store: heap after load", load.heapDelta, "MB", "≤ 16", load.heapDelta <= 16);
const loadedContent = load.v.conversations[0].messages[1].content;
const asNote = /^\[…… a [\d,]+-character tool result from an earlier session is kept on disk/.test(loadedContent);
check("store: oversized result loads as a note", asNote ? 1 : 0, "", "= 1", asNote);
// The renderer saves the conversation back with the note in it; the blob must survive that.
await store.saveProject("p1", load.v.conversations);
const kept = (await fs.readdir(path.join(dir, "conversations", "p1.blobs"))).length;
check("store: blob kept after re-saving the note", kept, "", "= 1", kept === 1);
await fs.rm(dir, { recursive: true, force: true });

// ── wire ────────────────────────────────────────────────────────────────────────
const convo = [
  { role: "system", content: "sys" },
  { role: "user", content: "read the whole log" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "big.log" }) } }] },
  { role: "tool", tool_call_id: "c1", content },
];
const ceiling = resultCeilingTokens(128_000, 0);
withholdOversizedResults(convo, indexCalls(convo), ceiling); // warm the tokenizer
const rule = await timed(() => withholdOversizedResults(convo, indexCalls(convo), ceiling));
check("wire: rule cost per request", rule.ms, "ms", "≤ 100", rule.ms <= 100);
const wire = buildWireContext(convo, null, ceiling);
const sent = JSON.stringify(wire).length;
check("wire: request body for that result", sent / 1024, "KB", "≤ 8", sent <= 8 * 1024);
check("wire: request tokens", countMessagesTokens(wire), "tokens", `≤ ${ceiling}`, countMessagesTokens(wire) <= ceiling);

// ── report ──────────────────────────────────────────────────────────────────────
console.log(`\n${sizeMB} MB read_file result\n`);
for (const r of rows) {
  const val = typeof r.value === "number" ? r.value.toFixed(r.unit === "ms" || r.unit === "MB" || r.unit === "KB" ? 0 : 0) : r.value;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.metric.padEnd(40)} ${String(val).padStart(8)} ${r.unit.padEnd(6)} target ${r.target}`);
}
const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} target(s) missed`);
  process.exit(1);
}
