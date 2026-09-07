/**
 * Store durability (docs/agent-runtime-crash-recovery.md C1).
 *
 * The audit that produced these found one real data-loss path and one file that was the least crash-safe thing in
 * the store despite being the most important. Both are asserted here against the shipped source, because the store
 * imports Electron's `app` and cannot be loaded in a plain node test.
 *
 * The path worth stating plainly: `loadProject` answers any failure with an empty list, the renderer shows a project
 * with no conversations, and the first change writes that empty document back — destroying bytes a person could
 * otherwise have recovered. Nothing about that is theoretical; it is what the code did.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const store = fs.readFileSync(path.join(root, "electron/store/conversationStore.mjs"), "utf8");

/** The body of a named function in the store, up to the next top-level declaration. */
function fn(name) {
  const start = store.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} exists`);
  const next = store.indexOf("\nasync function ", start + 1);
  const next2 = store.indexOf("\nexport ", start + 1);
  const end = Math.min(...[next, next2].filter((n) => n > 0));
  return store.slice(start, Number.isFinite(end) ? end : start + 3000);
}

test("an atomic write has a real durability point, not just an atomic swap", () => {
  const body = fn("writeAtomic");
  // The rename makes the swap atomic. Without the flush the rename can reach the disk before the bytes do, which
  // produces exactly the file this pattern exists to prevent.
  assert.match(body, /await handle\.sync\(\)/, "the bytes are flushed before anything points at them");
  assert.match(body, /await fs\.rename\(tmp, file\)/);
  assert.match(body, /await syncDir\(path\.dirname\(file\)\)/, "and the directory entry is flushed after");
  const order = [body.indexOf("handle.sync()"), body.indexOf("fs.rename"), body.indexOf("syncDir")];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "flush, rename, flush — in that order");
});

test("flushing is best effort and never fails a write that otherwise succeeded", () => {
  const body = fn("syncDir");
  assert.match(body, /catch\s*\{/, "Windows refuses to open a directory; that is not a write failure");
});

test("the index is written atomically like everything else", () => {
  // It was a direct overwrite — which made the one file naming every project the least crash-safe file in the
  // store. A torn index is every project disappearing at once.
  const save = store.slice(store.indexOf("export async function saveIndex"), store.indexOf("export async function saveIndex") + 900);
  assert.match(save, /await writeAtomic\(indexFile\(\)/);
  assert.doesNotMatch(save, /fs\.writeFile\(indexFile\(\)/, "no direct overwrite is left");
});

test("a project that could not be read is never overwritten", () => {
  // The guard that turns a read failure into an inconvenience rather than data loss.
  const write = store.slice(store.indexOf("async function writeProject("), store.indexOf("async function writeProject(") + 700);
  assert.match(write, /if \(unreadable\.has\(projectId\)\)/);
  assert.match(write, /return false;/);
  const guard = write.indexOf("unreadable.has");
  const disk = write.indexOf("writeAtomic");
  assert.ok(guard !== -1 && (disk === -1 || guard < disk), "the refusal comes before anything touches the disk");
});

test("a missing file is an empty project, not a damaged one", () => {
  const load = fn("loadProject");
  assert.match(load, /if \(e\?\.code === "ENOENT"\)/);
  const enoent = load.slice(load.indexOf('e?.code === "ENOENT"'), load.indexOf('e?.code === "ENOENT"') + 160);
  assert.match(enoent, /unreadable\.delete\(projectId\)/, "a project that never existed is not marked unreadable");
});

test("only structurally invalid bytes are moved aside", () => {
  const load = fn("loadProject");
  assert.match(load, /const corruptJson = e instanceof SyntaxError;/);
  assert.match(load, /if \(corruptJson && \(await quarantine\(/);
  // The distinction that matters: ciphertext may be perfectly good with only the key missing, and renaming a
  // user's intact data because their keychain was locked would be the worse error. Asserted on the reasoning as
  // well as the branch, because the branch alone reads as an arbitrary narrowing.
  assert.match(store, /decryption\* failure is deliberately not quarantined|A \*decryption\* failure is deliberately not/);
  // ...and the else branch marks it unreadable instead, which is what actually protects the bytes.
  assert.match(load, /unreadable\.add\(projectId\)/);
});

test("a successful read clears the mark, so a transient failure is not permanent", () => {
  const load = fn("loadProject");
  const ok = load.slice(0, load.indexOf("} catch"));
  assert.match(ok, /unreadable\.delete\(projectId\)/, "opening the project normally restores writes");
});

test("both outcomes leave a record", () => {
  assert.match(store, /recordRecovery\("store", "quarantined"/);
  assert.match(store, /recordRecovery\("store", "unreadable"/);
});

test("quarantine keeps the bytes under a new name rather than deleting them", () => {
  const q = fn("quarantine");
  assert.match(q, /\.corrupt-\$\{Date\.now\(\)\}/);
  assert.match(q, /await fs\.rename\(file, target\)/);
  assert.doesNotMatch(q, /rm\(|unlink\(/, "nothing is deleted; the point is that a person can still recover it");
});

// ── the pattern the sweep has to agree with ─────────────────────────────────────────────────────

test("the temp names this store writes are the ones the launch sweep collects", () => {
  // writeAtomic produces `<file>.<pid>.<n>.tmp`; the sweep matches a trailing `.tmp`. If either side changed
  // shape, abandoned files would accumulate forever with nothing reporting it.
  const body = fn("writeAtomic");
  const m = /const tmp = `\$\{file\}\.\$\{process\.pid\}\.\$\{\+\+tmpSeq\}\.tmp`;/.exec(body);
  assert.ok(m, "the temp name still ends in .tmp");
  const sweep = fs.readFileSync(path.join(root, "electron/store/tempSweep.mjs"), "utf8");
  assert.match(sweep, /const TMP_SUFFIX = "\.tmp";/);
  assert.match(sweep, /endsWith\(TMP_SUFFIX\)/);
});

test("a quarantined file is not itself collected by the sweep", () => {
  // `.corrupt-<ts>` deliberately does not end in .tmp: the whole point is that it survives for recovery.
  const sweep = fs.readFileSync(path.join(root, "electron/store/tempSweep.mjs"), "utf8");
  assert.doesNotMatch(sweep, /corrupt/, "the sweep has no knowledge of quarantined files, which is correct");
  const name = `conversations.json.corrupt-${Date.now()}`;
  assert.equal(name.endsWith(".tmp"), false);
});
