/**
 * The Files panel's routing of a click (src/lib/fileViewer.ts).
 *
 * Which files get a media stage instead of the editor is decided by extension alone — a click on the tree
 * knows nothing else — and the URL a stage is given has to survive the round trip to the main process as
 * the same relative path, spaces and all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { previewKindOf, workspaceFileUrl, WORKSPACE_URL_PREFIX } = await import("../src/lib/fileViewer.ts");

test("pictures, clips, sound and PDFs are previewed; everything else goes to the editor", () => {
  assert.equal(previewKindOf("shots/a.PNG"), "image");
  assert.equal(previewKindOf("a.jpeg"), "image");
  assert.equal(previewKindOf("clip.mp4"), "video");
  assert.equal(previewKindOf("clip.webm"), "video");
  assert.equal(previewKindOf("voice.mp3"), "audio");
  assert.equal(previewKindOf("doc/report.pdf"), "pdf");
  assert.equal(previewKindOf("src/index.ts"), null);
  assert.equal(previewKindOf("README"), null);
  assert.equal(previewKindOf(".gitignore"), null);
  assert.equal(previewKindOf("archive.zip"), null);
});

test("SVG stays with the editor: it is source first", () => {
  assert.equal(previewKindOf("logo.svg"), null);
});

test("the extension is the last segment's, not one hidden in a folder name", () => {
  assert.equal(previewKindOf("photos.png/notes.txt"), null);
  assert.equal(previewKindOf("v1.0/shot.png"), "image");
});

test("a workspace URL encodes each segment and keeps the path shape", () => {
  assert.equal(workspaceFileUrl("docs/my file.png"), `${WORKSPACE_URL_PREFIX}docs/my%20file.png`);
  assert.equal(workspaceFileUrl("a#b/c?d.pdf"), `${WORKSPACE_URL_PREFIX}a%23b/c%3Fd.pdf`);
  assert.equal(workspaceFileUrl("win\\style\\x.jpg"), `${WORKSPACE_URL_PREFIX}win/style/x.jpg`);
  assert.equal(workspaceFileUrl("./a//b.png"), `${WORKSPACE_URL_PREFIX}a/b.png`);
  assert.equal(decodeURIComponent(workspaceFileUrl("docs/my file.png").slice(WORKSPACE_URL_PREFIX.length)), "docs/my file.png");
});
