/**
 * The path an attachment is announced under (src/app/agent/chat/sendPrep.ts).
 *
 * Two facts about a saved attachment are easy to get wrong together, and getting either wrong produces the
 * same symptom: the model runs a file command against a file that is sitting right there and is told the
 * system cannot find it.
 *
 * The first is that the library has TWO names and only one of them resolves at a time. Inside the sandbox it
 * is mounted at /assets and the host path exists on neither side of the boundary; natively there is no mount,
 * so the host path is the only name that works. Announcing /assets unconditionally is not a harmless
 * approximation — natively it names a directory that does not exist.
 *
 * The second is that storing a file RENAMES it. `mediaStore.uniqueTarget` replaces spaces and reserved
 * punctuation with underscores, so "新建 文本文档 (2).txt" lands as "新建_文本文档_(2).txt". Quoting the name
 * the upload arrived with, next to a directory that does exist, is an invitation to concatenate the two into
 * a path that does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { composeWireText } = await import("../src/app/agent/chat/sendPrep.ts");

/** A name with spaces is the interesting case: it is the one the store rewrites. */
const ORIGINAL = "新建 文本文档 (2).txt";
const ON_DISK = "新建_文本文档_(2).txt";
const HOST_PATH = `C:\\Users\\hp\\AppData\\Roaming\\Zeraix\\agent\\media\\${ON_DISK}`;

/** RegExp-safe: the names under test are full of parentheses and dots. */
const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const attachment = (over = {}) => ({ id: 1, kind: "binary", name: ORIGINAL, size: 12, ...over });
const saved = (path = HOST_PATH) => new Map([[1, path]]);

test("natively, the announced path is the host path — /assets does not exist there", () => {
  const out = composeWireText("这是什么", [attachment()], saved(), null);
  assert.ok(out.includes(HOST_PATH), `host path missing from: ${out}`);
  assert.ok(!out.includes("/assets"), "named the sandbox mount on a native host");
});

test("in the sandbox, the announced path is the mount — the host path is unreachable there", () => {
  const out = composeWireText("这是什么", [attachment()], saved(), { active: "qemu" });
  assert.ok(out.includes(`/assets/${ON_DISK}`), `mount path missing from: ${out}`);
  assert.ok(!out.includes(HOST_PATH), "named a host path that does not exist inside the guest");
});

test("the name on disk is announced, not the name the upload arrived with", () => {
  const out = composeWireText("", [attachment()], saved(), null);
  // Asserted on the IDENTIFIER, not on the string appearing anywhere: the disk name was always present inside
  // the path, so a bare `includes` passes against the bug this test exists for. What was missing is the
  // rename being stated where the file is named, which is the only place the model was reading it from.
  assert.match(out, new RegExp(`Attachment: ${escape(ORIGINAL)}, saved as ${escape(ON_DISK)}`));
  // The original is still there, so the user recognises their own file — but never alone.
  assert.ok(out.includes(ORIGINAL), "dropped the name the user knows the file by");
});

test("a name the store did not rewrite is not reported as though it had been renamed", () => {
  const plain = "report.pdf";
  const out = composeWireText("", [attachment({ name: plain })], saved(`/media/${plain}`), null);
  assert.ok(!out.includes("saved as"), `spurious rename note in: ${out}`);
});

test("an image announces the same path as a binary — it is a file either way", () => {
  const out = composeWireText("", [attachment({ kind: "image", name: "my shot.png" })], saved("/media/my_shot.png"), null);
  assert.ok(out.includes("/media/my_shot.png"), `image path missing from: ${out}`);
  assert.ok(out.includes("my_shot.png"), "image announced only under its pre-save name");
});

test("an attachment that could not be saved is not given a path at all", () => {
  const out = composeWireText("", [attachment()], new Map(), null);
  assert.ok(!out.includes("/assets"), "invented a library path for a file that was never saved");
  assert.ok(/could not be saved/.test(out), `no failure note in: ${out}`);
});
