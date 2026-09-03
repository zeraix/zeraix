/**
 * The media viewer's pure parts (src/components/media/mediaDownload.ts, src/store/mediaViewerStore.ts).
 *
 * The viewer itself is a DOM component and is exercised in the app; what can be pinned down here is the
 * naming rule a download follows — noticed only when it is wrong — and the index arithmetic a gallery
 * relies on to never point past its end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { fileNameOf, mimeOfDataUrl, mimeOf } = await import("../src/components/media/mediaDownload.ts");
const { clampIndex } = await import("../src/store/mediaViewerStore.ts");

test("a disk path names the download, before anything else", () => {
  assert.equal(
    fileNameOf({ src: "https://cdn.test/x.png", kind: "image", path: "C:\\media\\cat.png", name: "A cat" }),
    "cat.png",
  );
  assert.equal(fileNameOf({ src: "https://cdn.test/x.png", kind: "image", path: "/w/media/cat.png" }), "cat.png");
});

test("a URL whose last segment is a file name is used as one", () => {
  assert.equal(fileNameOf({ src: "app://localhost/__media/a%20b.mp4", kind: "video" }), "a b.mp4");
  assert.equal(fileNameOf({ src: "https://cdn.test/gen/123.jpeg?sig=1", kind: "image" }), "123.jpeg");
});

test("a URL without a file name falls back to the display name plus the mime's extension", () => {
  assert.equal(
    fileNameOf({ src: "https://cdn.test/render/abc", kind: "image", mime: "image/png", name: "a cat in space" }),
    "a cat in space.png",
  );
});

test("a data: URL takes its extension from its own header, and a name is not doubled", () => {
  assert.equal(fileNameOf({ src: "data:image/jpeg;base64,AAAA", kind: "image", name: "Attachment 1" }), "Attachment 1.jpg");
  assert.equal(fileNameOf({ src: "data:image/png;base64,AAAA", kind: "image", name: "shot.png" }), "shot.png");
});

test("path characters are cleaned out of a display name, and an empty one becomes 'media'", () => {
  assert.equal(
    fileNameOf({ src: "data:text/plain,hi", kind: "document", name: 'a/b\\c:d*e?f"g<h>i|j' }),
    "a b c d e f g h i j.txt",
  );
  assert.equal(fileNameOf({ src: "data:image/webp;base64,AAAA", kind: "image", name: "" }), "media.webp");
  assert.equal(fileNameOf({ src: "blob:app://localhost/uuid", kind: "other" }), "media");
});

test("mime comes from the item, else from the data: URL, lower-cased", () => {
  assert.equal(mimeOfDataUrl("data:Image/PNG;base64,AAAA"), "image/png");
  assert.equal(mimeOfDataUrl("data:text/plain,hi"), "text/plain");
  assert.equal(mimeOfDataUrl("https://x/y.png"), "");
  assert.equal(mimeOf({ src: "data:image/png;base64,AAAA", kind: "image", mime: "Image/WebP" }), "image/webp");
  assert.equal(mimeOf({ src: "data:image/png;base64,AAAA", kind: "image" }), "image/png");
});

test("clampIndex keeps the index inside the list, and an empty list at 0", () => {
  assert.equal(clampIndex(3, 5), 3);
  assert.equal(clampIndex(-1, 5), 0);
  assert.equal(clampIndex(9, 5), 4);
  assert.equal(clampIndex(2.7, 5), 2);
  assert.equal(clampIndex(Number.NaN, 5), 0);
  assert.equal(clampIndex(0, 0), 0);
  assert.equal(clampIndex(4, 0), 0);
});
