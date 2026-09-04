/**
 * The main-process conversation store with a large tool result in it (electron/store/conversationStore.mjs).
 *
 * Pins the property the change exists for: a result above BLOB_MIN_CHARS is written once, as its own file,
 * and the project document stays small however many times the project is saved afterwards. Runs against the
 * real module through the Electron stub, so the encryption envelope (plain-key mode, no keychain) is on the
 * path too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "../scripts/electron-stub-hook.mjs";

const store = await import("../electron/store/conversationStore.mjs");
const { BLOB_MIN_CHARS } = await import("../electron/store/resultBlobs.mjs");

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zeraix-store-test-"));
await store.setStorePath(dir);
const convFile = (pid) => path.join(dir, "conversations", `${pid}.json`);
const blobDir = (pid) => path.join(dir, "conversations", `${pid}.blobs`);
const blobs = async (pid) => (await fs.readdir(blobDir(pid)).catch(() => [])).sort();

const big = "line of a large tool result\n".repeat(Math.ceil((4 * 1024 * 1024) / 28)); // ~4 MB
const conv = (content) => ({
  id: "conv-1",
  projectId: "p1",
  messages: [
    { role: "user", content: "read the log" },
    { role: "tool", tool_call_id: "c1", name: "read_file", content },
    { role: "assistant", content: "it is long" },
  ],
});

test("a large result is stored out of line, the document stays small, and load puts it back", async () => {
  assert.ok(await store.saveProject("p1", [conv(big)]));
  const doc = await fs.stat(convFile("p1"));
  assert.ok(doc.size < 64 * 1024, `document is ${doc.size} bytes; the 4 MB result must not be in it`);
  const files = await blobs("p1");
  assert.equal(files.length, 1, `one blob file, got ${files}`);
  assert.match(files[0], /^[0-9a-f]{64}\.(txt|enc)$/);

  const loaded = await store.loadProject("p1");
  assert.deepEqual(loaded.conversations, [conv(big)]);
});

test("saving again writes no new blob and does not rewrite the existing one", async () => {
  const [name] = await blobs("p1");
  const before = await fs.stat(path.join(blobDir("p1"), name));
  await new Promise((r) => setTimeout(r, 20));
  const t0 = performance.now();
  await store.saveProject("p1", [conv(big)]);
  const ms = performance.now() - t0;
  const after = await fs.stat(path.join(blobDir("p1"), name));
  assert.deepEqual(await blobs("p1"), [name]);
  assert.equal(after.mtimeMs, before.mtimeMs, "the blob was not rewritten");
  assert.ok(ms < 1000, `steady-state save took ${ms.toFixed(0)} ms`);
});

test("a result that leaves the conversation has its blob swept; a small one never gets a blob", async () => {
  await store.saveProject("p1", [conv("short")]);
  assert.deepEqual(await blobs("p1"), []);
  const loaded = await store.loadProject("p1");
  assert.equal(loaded.conversations[0].messages[1].content, "short");
});

test("a blob whose file is gone loads as a note, not as an error or an empty string", async () => {
  await store.saveProject("p1", [conv(big)]);
  for (const f of await blobs("p1")) await fs.rm(path.join(blobDir("p1"), f));
  const loaded = await store.loadProject("p1");
  const content = loaded.conversations[0].messages[1].content;
  assert.match(content, /no longer available/);
  assert.match(content, new RegExp(big.length.toLocaleString("en-US")));
});

test("overlapping saves of one project are serialised and the last state wins", async () => {
  const a = store.saveProject("p1", [conv(big)]);
  const b = store.saveProject("p1", [conv(big + "\nsecond")]);
  const c = store.saveProject("p1", [conv("final")]);
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  const loaded = await store.loadProject("p1");
  assert.equal(loaded.conversations[0].messages[1].content, "final");
  assert.deepEqual(await blobs("p1"), [], "blobs of the states that were superseded are swept");
});

test("deleting the project removes its blobs too", async () => {
  await store.saveProject("p1", [conv(big)]);
  assert.equal((await blobs("p1")).length, 1);
  await store.deleteProject("p1");
  assert.deepEqual(await blobs("p1"), []);
  assert.equal(await fs.stat(convFile("p1")).catch((e) => e.code), "ENOENT");
});

test("the threshold is the one resultBlobs exports", () => {
  assert.equal(BLOB_MIN_CHARS, 256 * 1024);
});
