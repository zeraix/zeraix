/**
 * The media library index (src/lib/ai/mediaLibrary.ts).
 *
 * Assets live together in one folder with the index at its root, inside the working directory — which is what
 * lets the model process its own output, since the sandbox mounts a command's cwd and nothing else. So every property here is about the
 * INDEX being trustworthy — the mapping is written by code precisely so the UI can render from it without
 * checking, and the moment a row can be wrong that guarantee is gone.
 *
 * Two rules carry most of the weight. Re-registering the same file must UPDATE its row rather than
 * accumulate duplicates that all point at one asset. And a re-registered asset must keep whatever the model
 * wrote about it, since the description describes the picture and the picture has not changed just because
 * the row was rewritten.
 *
 * The index is a JSON file in the workspace, and file access does nothing under a test runner, which is why
 * the logic is separated from the reading and writing — everything below is pure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { kindOfMime, parseLibrary, addEntry, annotateEntry, searchLibrary, makeEntry, MAX_ENTRIES } =
  await import("../src/lib/ai/mediaLibrary.ts");

const entry = (over = {}) => ({
  id: "m1",
  kind: "video",
  mime: "video/mp4",
  path: "/w/a.mp4",
  src: "https://cdn.test/a.mp4",
  createdAt: 1000,
  origin: "generated",
  ...over,
});

// ── Categories ──────────────────────────────────────────────────────────────────────────────────────────

test("categories come from the mime, so a caller cannot mislabel what it stores", () => {
  assert.equal(kindOfMime("image/png"), "image");
  assert.equal(kindOfMime("video/mp4"), "video");
  assert.equal(kindOfMime("audio/mpeg"), "audio");
  assert.equal(kindOfMime("application/pdf"), "document");
  assert.equal(kindOfMime("text/markdown"), "document");
  assert.equal(kindOfMime("application/json"), "document");
});

test("an unrecognised mime is `other`, not guessed into a category that renders wrongly", () => {
  assert.equal(kindOfMime("application/x-thing"), "other");
  assert.equal(kindOfMime(""), "other");
  assert.equal(kindOfMime(undefined ?? ""), "other");
});

// ── Reading a stored index ──────────────────────────────────────────────────────────────────────────────

test("nothing stored reads as an empty library, never as a crash", () => {
  for (const raw of [undefined, null, "", "  ", 42, {}, "not json", "["]) {
    assert.deepEqual(parseLibrary(raw), [], String(raw));
  }
});

test("malformed rows are dropped; the assets they described are still on disk", () => {
  const list = parseLibrary(
    JSON.stringify([entry({ id: "ok" }), { id: "no-src", createdAt: 1 }, { src: "x" }, null, "nonsense"]),
  );
  assert.deepEqual(list.map((e) => e.id), ["ok"]);
});

test("a row written before `kind` existed is categorised on read rather than dropped", () => {
  const [restored] = parseLibrary(JSON.stringify([{ id: "old", src: "x", createdAt: 1, mime: "image/png" }]));
  assert.equal(restored.kind, "image");
});

// ── Adding ──────────────────────────────────────────────────────────────────────────────────────────────

test("the newest entry is first, because the library is browsed backwards from now", () => {
  const list = addEntry(addEntry([], entry({ id: "a", path: "/w/a" })), entry({ id: "b", path: "/w/b" }));
  assert.deepEqual(list.map((e) => e.id), ["b", "a"]);
});

test("re-registering the same file updates its row instead of duplicating it", () => {
  const first = addEntry([], entry({ id: "a", path: "/w/same.mp4", createdAt: 1 }));
  const again = addEntry(first, entry({ id: "b", path: "/w/same.mp4", createdAt: 2 }));
  assert.equal(again.length, 1, "one file must not become two library tiles");
  assert.equal(again[0].id, "b");
});

test("identity falls back to src when there is no path", () => {
  const first = addEntry([], entry({ id: "a", path: undefined, src: "https://cdn/x" }));
  const again = addEntry(first, entry({ id: "b", path: undefined, src: "https://cdn/x" }));
  assert.equal(again.length, 1);
});

test("different files are different rows", () => {
  const list = addEntry(addEntry([], entry({ path: "/w/a" })), entry({ path: "/w/b" }));
  assert.equal(list.length, 2);
});

test("a re-registered asset keeps what the model wrote about it", () => {
  // The description describes the picture; the picture did not change because the row was rewritten.
  const described = annotateEntry(addEntry([], entry({ path: "/w/a.mp4" })), "m1", {
    description: "a lighthouse at dusk",
    tags: ["lighthouse"],
  });
  const again = addEntry(described, entry({ id: "m2", path: "/w/a.mp4", createdAt: 2 }));
  assert.equal(again[0].description, "a lighthouse at dusk");
  assert.deepEqual(again[0].tags, ["lighthouse"]);
});

test("the index is capped, dropping the oldest — the bytes are still on disk", () => {
  let list = [];
  for (let i = 0; i < MAX_ENTRIES + 10; i++) {
    list = addEntry(list, entry({ id: `m${i}`, path: `/w/${i}`, createdAt: i }));
  }
  assert.equal(list.length, MAX_ENTRIES);
  assert.equal(list[0].id, `m${MAX_ENTRIES + 9}`, "newest kept");
  assert.equal(list.some((e) => e.id === "m0"), false, "oldest dropped");
});

// ── Annotating ──────────────────────────────────────────────────────────────────────────────────────────

test("an unknown id is a no-op, never an insert", () => {
  const list = addEntry([], entry());
  const after = annotateEntry(list, "does-not-exist", { description: "x" });
  assert.deepEqual(after, list, "the model must not be able to create a row for an asset that does not exist");
});

test("a blank description does not erase an existing one", () => {
  const list = annotateEntry(addEntry([], entry()), "m1", { description: "real" });
  assert.equal(annotateEntry(list, "m1", { description: "   " })[0].description, "real");
});

test("tags are trimmed, and empty ones dropped", () => {
  const [e] = annotateEntry(addEntry([], entry()), "m1", { tags: [" a ", "", "b"] });
  assert.deepEqual(e.tags, ["a", "b"]);
});

// ── Searching ───────────────────────────────────────────────────────────────────────────────────────────

const library = [
  entry({ id: "v1", kind: "video", path: "/w/v1", prompt: "a slow dolly-in on a lighthouse", convId: "c1" }),
  entry({ id: "i1", kind: "image", mime: "image/png", path: "/w/i1", description: "Lighthouse logo", convId: "c1" }),
  entry({ id: "i2", kind: "image", mime: "image/png", path: "/w/i2", filename: "invoice.png", convId: "c2" }),
  entry({ id: "v2", kind: "video", path: "/w/v2", tags: ["demo"], convId: "c2" }),
];

test("searching matches the fields a human would search by", () => {
  assert.deepEqual(searchLibrary(library, { text: "lighthouse" }).map((e) => e.id), ["v1", "i1"]);
  assert.deepEqual(searchLibrary(library, { text: "invoice" }).map((e) => e.id), ["i2"]);
  assert.deepEqual(searchLibrary(library, { text: "demo" }).map((e) => e.id), ["v2"]);
});

test("matching is case-insensitive", () => {
  assert.equal(searchLibrary(library, { text: "LIGHTHOUSE" }).length, 2);
});

test("kind and conversation narrow the result", () => {
  assert.deepEqual(searchLibrary(library, { kind: "video" }).map((e) => e.id), ["v1", "v2"]);
  assert.deepEqual(searchLibrary(library, { convId: "c2" }).map((e) => e.id), ["i2", "v2"]);
  assert.deepEqual(searchLibrary(library, { kind: "image", convId: "c1" }).map((e) => e.id), ["i1"]);
});

test("no match returns nothing rather than something close", () => {
  // A near-miss returning the wrong clip is worse than returning nothing and being asked again.
  assert.deepEqual(searchLibrary(library, { text: "submarine" }), []);
});

test("an empty query returns the library, and the limit is honoured", () => {
  assert.equal(searchLibrary(library).length, 4);
  assert.equal(searchLibrary(library, { limit: 2 }).length, 2);
  assert.equal(searchLibrary(library, { limit: 0 }).length, 1, "a zero limit still returns something usable");
});

// ── Building an entry ───────────────────────────────────────────────────────────────────────────────────

test("an entry is built with its category derived and its optionals omitted when absent", () => {
  const e = makeEntry({ src: "https://cdn/a.mp4", mime: "video/mp4", origin: "generated", now: () => 5 });
  assert.equal(e.kind, "video");
  assert.equal(e.createdAt, 5);
  assert.equal("path" in e, false, "an absent path must not be stored as undefined and rendered as a link");
  assert.equal("prompt" in e, false);
});

test("ids are unique across entries created in the same millisecond", () => {
  const a = makeEntry({ src: "a", mime: "image/png", origin: "upload", now: () => 1 });
  const b = makeEntry({ src: "b", mime: "image/png", origin: "upload", now: () => 1 });
  assert.notEqual(a.id, b.id);
});

// ── Concurrent writes ───────────────────────────────────────────────────────────────────────────────────
//
// Every index write is read-modify-write over one file, so two that overlap both read the same list and both
// write it back — the second silently erasing the first. Not a rare interleaving either: sending three
// attachments registers three assets in a loop. What follows pins the reducer's part of that contract; the
// serialisation itself is in registerMedia, which needs a filesystem and so cannot run here.

test("adding is a pure fold, so a queued sequence produces every entry", () => {
  // What the write queue guarantees, expressed over the reducer it queues: fold three additions in order and
  // all three survive. A concurrent implementation that read once and wrote three times would keep one.
  const added = [entry({ id: "a", path: "/w/a" }), entry({ id: "b", path: "/w/b" }), entry({ id: "c", path: "/w/c" })];
  const list = added.reduce((acc, e) => addEntry(acc, e), []);
  assert.deepEqual(list.map((e) => e.id).sort(), ["a", "b", "c"]);
});

test("a fold never loses an unrelated entry", () => {
  const existing = addEntry([], entry({ id: "old", path: "/w/old", createdAt: 1 }));
  const after = addEntry(existing, entry({ id: "new", path: "/w/new", createdAt: 2 }));
  assert.equal(after.some((e) => e.id === "old"), true);
  assert.equal(after.length, 2);
});

// ── What a tile says about an asset ─────────────────────────────────────────────────────────────────────
//
// These are the numbers the library page claims are true of a file, so the rule they share matters more than
// the formatting: a fact that could not be measured is ABSENT, never zero. "0×0" and "0 B" both read as a
// broken asset, which is a worse answer than saying nothing.

const { formatResolution, formatSize, formatDuration, describeEntry } = await import(
  "../src/lib/ai/mediaLibrary.ts"
);

test("resolution is shown only when both dimensions are known", () => {
  assert.equal(formatResolution({ width: 1920, height: 1080 }), "1920×1080");
  assert.equal(formatResolution({ width: 1920 }), "", "half a measurement is not a measurement");
  assert.equal(formatResolution({}), "");
  assert.equal(formatResolution({ width: 0, height: 0 }), "", "0×0 reads as broken, not as unmeasured");
});

test("size is coarse, and unknown reads as nothing rather than as an empty file", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatSize(3 * 1024 * 1024 * 1024), "3.0 GB");
  assert.equal(formatSize(0), "");
  assert.equal(formatSize(undefined), "");
});

test("duration is clock-formatted, and pads only where it must", () => {
  assert.equal(formatDuration(7_000), "0:07");
  assert.equal(formatDuration(83_000), "1:23");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(undefined), "");
});

test("the summary omits what was never measured instead of standing in for it", () => {
  assert.equal(
    describeEntry(entry({ width: 1280, height: 720, durationMs: 12_000, bytes: 2 * 1024 * 1024 })),
    "1280×720 · 0:12 · 2.0 MB",
  );
  // A still image has no duration; a document has neither dimensions nor duration.
  assert.equal(describeEntry(entry({ width: 800, height: 600, bytes: 1024 })), "800×600 · 1.0 KB");
  assert.equal(describeEntry(entry({ bytes: 1024 })), "1.0 KB");
  assert.equal(describeEntry(entry({})), "", "nothing known says nothing at all");
});

test("an entry only records dimensions it actually has", () => {
  const measured = makeEntry({ src: "x", mime: "video/mp4", origin: "generated", width: 1920, height: 1080, durationMs: 5000, now: () => 1 });
  assert.equal(measured.width, 1920);
  assert.equal(measured.durationMs, 5000);
  const unmeasured = makeEntry({ src: "x", mime: "video/mp4", origin: "generated", now: () => 1 });
  assert.equal("width" in unmeasured, false, "an unmeasured asset must not carry undefined fields into index.json");
  assert.equal("durationMs" in unmeasured, false);
});

// ── Renderable sources ──────────────────────────────────────────────────────────────────────────────────
//
// A local path is not a source: `<img src="C:\Users\…">` renders nothing, which is exactly what a broken
// library tile was. Library files are served from the app's own origin instead. The rule that matters most
// here is the last one — a stored entry is DATA, and data that can name ../../.ssh/id_rsa would turn the
// library into a file-read primitive.

const { mediaSrcFor, srcOf, MEDIA_URL_PREFIX } = await import("../src/lib/ai/mediaLibrary.ts");

test("a library file is addressed through the app's own scheme", () => {
  assert.equal(mediaSrcFor("/store/media/clip.mp4", true), `${MEDIA_URL_PREFIX}clip.mp4`);
  // Windows separators too — the path comes from whichever platform wrote it.
  assert.equal(mediaSrcFor("C:\\store\\media\\clip.mp4", true), `${MEDIA_URL_PREFIX}clip.mp4`);
});

test("a file outside the library has no renderable form", () => {
  // An attachment left in the working directory: the tile falls back to its type icon rather than showing a
  // broken image, which is more honest than a src that will never load.
  assert.equal(mediaSrcFor("/work/notes.txt", false), "");
  assert.equal(mediaSrcFor("", true), "");
});

test("only the basename is addressable, so an entry cannot name its way out of the folder", () => {
  assert.equal(mediaSrcFor("/store/media/../../.ssh/id_rsa", true), `${MEDIA_URL_PREFIX}id_rsa`);
  assert.equal(mediaSrcFor("../../etc/passwd", true), `${MEDIA_URL_PREFIX}passwd`);
  // Whatever survives is a bare name; the main process resolves it against the media folder and nothing else.
  for (const p of ["/a/b/../c.png", "..\\..\\x.png"]) {
    assert.equal(mediaSrcFor(p, true).includes(".."), false, p);
  }
});

test("a name needing escaping is encoded rather than breaking the URL", () => {
  assert.equal(mediaSrcFor("/store/media/my clip #1.mp4", true), `${MEDIA_URL_PREFIX}my%20clip%20%231.mp4`);
});

test("the local copy is preferred over a vendor URL, which expires", () => {
  assert.equal(
    srcOf(entry({ path: "/store/media/a.mp4", src: "https://cdn.test/a.mp4" })),
    `${MEDIA_URL_PREFIX}a.mp4`,
  );
});

test("an entry with no local copy still renders from whatever it has", () => {
  assert.equal(srcOf(entry({ path: undefined, src: "https://cdn.test/a.mp4" })), "https://cdn.test/a.mp4");
});
