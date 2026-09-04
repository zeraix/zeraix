/**
 * Out-of-line storage for the large strings in a project's conversation file.
 *
 * A project's conversations are one JSON document, rewritten in full on every change (conversationStore.mjs).
 * That was fine while nothing in it was big. A `read_file` result is now as long as the file it read — nothing
 * caps it (2026-09-04) — and one 100 MB result in a transcript made every later save of that project a 100 MB
 * serialisation, a 100 MB encryption, and a 100 MB write, repeated each time the assistant streamed a sentence.
 *
 * So a string of BLOB_MIN_CHARS or more does not go into the document. It is written once to its own file, named
 * by its content hash, and the document keeps a reference: `{ "$blob": "<sha256>", "n": <length> }`. Content
 * addressing is what makes the write happen once: the same text saved again hashes to a file that already exists.
 * On load the references are resolved and the text put back, so nothing outside the store ever sees one.
 *
 * This module is the pure half — the walk, the hash, the reference shape. Where the files live, how they are
 * encrypted, and when orphans are swept is conversationStore's business.
 */
import { createHash } from "node:crypto";

/** Strings at least this long are stored out of line. A 2,000-line read is about 80 KB and stays inline. */
export const BLOB_MIN_CHARS = 256 * 1024;

/**
 * Blobs longer than this are not read back on load.
 *
 * Loading a project used to mean loading every result it ever held: a 200 MB read_file result was decrypted in the
 * main process, turned into a string, cloned over IPC and kept in the renderer's store — four copies and 1.4 GB of
 * resident memory half a minute after launch (2026-09-04), for text no model can be sent (the wire ceiling is a
 * fraction of any context window) and no transcript shows beyond its first 32 KB. Above this size the conversation
 * gets a note naming the blob instead (unloadedBlobNote); the file stays on disk and the note becomes the same
 * reference again when the project is next saved, so nothing is lost — it is just not in memory.
 */
export const INLINE_LOAD_MAX_CHARS = 4 * 1024 * 1024;

/**
 * The most text a project's blobs may add to memory when it is loaded, all of them together.
 *
 * The per-blob cap bounds one result; this bounds a project that has hundreds under the cap — a month of 3 MB
 * reads is 300 MB in the renderer for as long as the project is open. References are met in document order, and
 * the store lists the newest conversation first, so it is the oldest results that turn into notes when the
 * budget runs out.
 */
export const INLINE_LOAD_TOTAL_MAX_CHARS = 64 * 1024 * 1024;

/**
 * Which of a document's references to read back, under both caps. Pure, so the policy is testable without a
 * store: `refs` is what collectBlobRefs returns, and the answer is the set of hashes worth reading.
 */
export function selectBlobsToLoad(refs, perBlob = INLINE_LOAD_MAX_CHARS, total = INLINE_LOAD_TOTAL_MAX_CHARS) {
  const chosen = new Set();
  let used = 0;
  for (const [hash, n] of refs) {
    if (n > perBlob || used + n > total) continue;
    used += n;
    chosen.add(hash);
  }
  return chosen;
}

const KEY = "$blob";
const HASH_RE = /^[0-9a-f]{64}$/;
/** Fed to the hash in slices so a 100 MB string is never copied into one 100 MB buffer. */
const HASH_SLICE = 1 << 20;

/** SHA-256 of the text, as the blob's file name. */
export function blobHash(text) {
  const h = createHash("sha256");
  for (let i = 0; i < text.length; i += HASH_SLICE) h.update(text.slice(i, i + HASH_SLICE));
  return h.digest("hex");
}

function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Whether a value is a reference written by detachLargeStrings. */
export function isBlobRef(v) {
  return isPlainObject(v) && typeof v[KEY] === "string" && HASH_RE.test(v[KEY]);
}

/** What stands in for a blob whose file is gone. A note the reader can understand, never an empty string. */
export function missingBlobNote(n) {
  return `[…… a ${Number(n).toLocaleString("en-US")}-character tool result that is no longer available on disk ……]`;
}

/**
 * What stands in for a blob too large to load (INLINE_LOAD_MAX_CHARS). Carries the hash so the save path can turn
 * it back into the reference — see parseUnloadedNote — and reads as a note to the model, which is told to call
 * the tool again rather than look for the text here. Same `[…… … ……]` shape as every other marker of ours, so the
 * file tools refuse it as content.
 */
export function unloadedBlobNote(hash, n) {
  return `[…… a ${Number(n).toLocaleString("en-US")}-character tool result from an earlier session is kept on disk (${hash}) and not loaded into the conversation; call the tool again if you need it ……]`;
}

const UNLOADED_RE = /^\[…… a ([\d,]+)-character tool result from an earlier session is kept on disk \(([0-9a-f]{64})\) and not loaded into the conversation; call the tool again if you need it ……\]$/;

/** The `{ hash, n }` an unloaded-blob note names, or null for any other string. */
export function parseUnloadedNote(text) {
  // The prefix test first: this runs on every string in the document, the 100 MB ones included, and a regex
  // anchored at the start still has to be reached through trim() and exec() — the prefix check is a few chars.
  if (typeof text !== "string" || text.length > 512 || !text.trimStart().startsWith("[…… a ")) return null;
  const m = UNLOADED_RE.exec(text.trim());
  return m ? { hash: m[2], n: Number(m[1].replace(/,/g, "")) } : null;
}

/**
 * Replace every string of `minChars` or more with a reference, handing the text to `sink(hash, text)`.
 *
 * Returns a new graph only along the paths where something changed; an unchanged subtree is the same object,
 * so a project with nothing large in it costs a walk and no allocation.
 */
export function detachLargeStrings(value, sink, minChars = BLOB_MIN_CHARS) {
  if (typeof value === "string") {
    // A note left by a load that skipped the blob: the reference comes back as it was, and the file it names
    // stays referenced — without this, the next save would see a short string and the sweep would delete it.
    const unloaded = parseUnloadedNote(value);
    if (unloaded) return { [KEY]: unloaded.hash, n: unloaded.n };
    if (value.length < minChars) return value;
    const hash = blobHash(value);
    sink(hash, value);
    return { [KEY]: hash, n: value.length };
  }
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = detachLargeStrings(value[i], sink, minChars);
      if (v !== value[i]) {
        if (!out) out = value.slice();
        out[i] = v;
      }
    }
    return out ?? value;
  }
  if (isPlainObject(value)) {
    let out = null;
    for (const k of Object.keys(value)) {
      const v = detachLargeStrings(value[k], sink, minChars);
      if (v !== value[k]) {
        if (!out) out = { ...value };
        out[k] = v;
      }
    }
    return out ?? value;
  }
  return value;
}

/** Every hash referenced anywhere in the graph, with the length each reference records. */
export function collectBlobRefs(value, into = new Map()) {
  if (isBlobRef(value)) {
    into.set(value[KEY], Number(value.n) || 0);
  } else if (Array.isArray(value)) {
    for (const v of value) collectBlobRefs(v, into);
  } else if (isPlainObject(value)) {
    for (const k of Object.keys(value)) collectBlobRefs(value[k], into);
  }
  return into;
}

/**
 * Put the text back where each reference is. `lookup(hash, n)` returns the text, or the note that replaces
 * a blob that could not be read — it must return a string either way, so the document never carries a
 * reference out of the store.
 */
export function inlineBlobs(value, lookup) {
  if (isBlobRef(value)) return lookup(value[KEY], value.n);
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = inlineBlobs(value[i], lookup);
      if (v !== value[i]) {
        if (!out) out = value.slice();
        out[i] = v;
      }
    }
    return out ?? value;
  }
  if (isPlainObject(value)) {
    let out = null;
    for (const k of Object.keys(value)) {
      const v = inlineBlobs(value[k], lookup);
      if (v !== value[k]) {
        if (!out) out = { ...value };
        out[k] = v;
      }
    }
    return out ?? value;
  }
  return value;
}
