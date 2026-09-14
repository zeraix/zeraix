/**
 * Conversations an earlier release encrypted (electron/store/legacyDecrypt.mjs).
 *
 * Releases up to v2.1.0 wrote every project file as an AES-256-GCM envelope and every blob as ZXB1 bytes, under a
 * master key in userData/agent/integrity/master.key.json. Nothing writes that format any more, so the files are built
 * here the way those releases built them. The store has to read them, write plaintext on the next save, and never
 * destroy ciphertext it merely failed to decrypt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import "../scripts/electron-stub-hook.mjs";

const { app } = await import("electron");
const store = await import("../electron/store/conversationStore.mjs");
const { blobHash } = await import("../electron/store/resultBlobs.mjs");

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zeraix-legacy-store-test-"));
await store.setStorePath(dir);
const convFile = (pid) => path.join(dir, "conversations", `${pid}.json`);
const blobDir = (pid) => path.join(dir, "conversations", `${pid}.blobs`);
const blobs = async (pid) => (await fs.readdir(blobDir(pid)).catch(() => [])).sort();

// The key as a release without an OS credential store kept it ("plain" mode: the stub has no safeStorage).
const key = randomBytes(32);
const keyFile = path.join(app.getPath("userData"), "agent", "integrity", "master.key.json");
await fs.mkdir(path.dirname(keyFile), { recursive: true });
await fs.writeFile(keyFile, JSON.stringify({ v: 1, mode: "plain", key: key.toString("base64") }));

/** An encrypted project file: { v, alg, iv, authTag, ciphertext }, all base64. */
function envelope(value, withKey = key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", withKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, alg: "AES-256-GCM", iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ct.toString("base64") };
}

/** An encrypted blob: magic "ZXB1" | iv | auth tag | ciphertext. */
function encryptedBlob(text, withKey = key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", withKey, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("ZXB1", "latin1"), iv, cipher.getAuthTag(), ct]);
}

// ~1 MB: stored out of line, and small enough that a load reads it back.
const big = "line of a large tool result\n".repeat(Math.ceil((1024 * 1024) / 28));
const conv = (content) => ({
  id: "conv-1",
  messages: [
    { role: "user", content: "read the log" },
    { role: "tool", tool_call_id: "c1", name: "read_file", content },
    { role: "assistant", content: "it is long" },
  ],
});
// Project ids no other test file uses: node --test runs files concurrently, the stub's store-config.json is shared,
// and setStorePath copies whatever store that config names into the new directory.
const [P1, P2, P3] = ["legacy-1", "legacy-2", "legacy-3"];

test("an encrypted project and its encrypted blob load, and the next save leaves only plaintext", async () => {
  const hash = blobHash(big);
  const doc = { conversations: [conv({ $blob: hash, n: big.length })] };
  await fs.mkdir(blobDir(P1), { recursive: true });
  await fs.writeFile(path.join(blobDir(P1), `${hash}.enc`), encryptedBlob(big));
  await fs.writeFile(convFile(P1), JSON.stringify(envelope(doc)));

  const loaded = await store.loadProject(P1);
  assert.deepEqual(loaded.conversations, [conv(big)]);

  assert.ok(await store.saveProject(P1, loaded.conversations));
  assert.deepEqual(JSON.parse(await fs.readFile(convFile(P1), "utf8")), doc, "the document is plain JSON, not an envelope");
  assert.deepEqual(await blobs(P1), [`${hash}.txt`], "the .enc copy is replaced by plaintext");
  assert.equal(await fs.readFile(path.join(blobDir(P1), `${hash}.txt`), "utf8"), big);
  assert.deepEqual((await store.loadProject(P1)).conversations, [conv(big)]);
});

test("a leftover .enc next to its plaintext copy (a crash mid-migration) is removed by the next save", async () => {
  const hash = blobHash(big);
  await fs.writeFile(path.join(blobDir(P1), `${hash}.enc`), encryptedBlob(big));
  assert.ok(await store.saveProject(P1, [conv(big)]));
  assert.deepEqual(await blobs(P1), [`${hash}.txt`]);
});

test("an encrypted blob that cannot be decrypted loads as a kept note, and a re-save does not sweep it", async () => {
  const text = `${big}unreadable`;
  const hash = blobHash(text);
  await fs.mkdir(blobDir(P2), { recursive: true });
  await fs.writeFile(path.join(blobDir(P2), `${hash}.enc`), encryptedBlob(text, randomBytes(32))); // not this key
  await fs.writeFile(convFile(P2), JSON.stringify({ conversations: [conv({ $blob: hash, n: text.length })] }));

  const loaded = await store.loadProject(P2);
  const content = loaded.conversations[0].messages[1].content;
  assert.match(content, /kind="stored-result"/, "not the \"missing\" note, which would drop the reference");
  assert.ok(content.includes(hash));

  assert.ok(await store.saveProject(P2, loaded.conversations));
  assert.deepEqual(await blobs(P2), [`${hash}.enc`], "the ciphertext survives the save");
});

test("an encrypted project that cannot be decrypted is refused a save and left byte for byte", async () => {
  const before = JSON.stringify(envelope({ conversations: [conv("kept")] }, randomBytes(32)));
  await fs.mkdir(path.dirname(convFile(P3)), { recursive: true });
  await fs.writeFile(convFile(P3), before);

  assert.deepEqual((await store.loadProject(P3)).conversations, []);
  assert.equal(store.isProjectUnreadable(P3), true);
  assert.equal(await store.saveProject(P3, []), false);
  assert.equal(await fs.readFile(convFile(P3), "utf8"), before);
});
