/**
 * The skin:// protocol handler (electron/skins/protocol.mjs), driven with the URLs an attacker would
 * try. Stage 9 of docs/theming-feature-prompt-set-v2-rust-en.md: `skin://current/../../../../etc/passwd`
 * must be a 404, never a read. The handler is a plain function of a URL and two values, so this is
 * the exact code the app registers with `protocol.handle`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkinRequest, serveSkinRequest, SKIN_SCHEME_PRIVILEGES } from "../electron/skins/protocol.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skin-protocol-"));
const skinsDir = path.join(root, "skin-packages");
const pkg = path.join(skinsDir, "aurora-night");
fs.mkdirSync(path.join(pkg, "assets"), { recursive: true });
fs.writeFileSync(path.join(pkg, "tokens.css"), ":root{--primary:#0af}");
fs.writeFileSync(path.join(pkg, "manifest.json"), "{}");
fs.writeFileSync(path.join(pkg, "assets", "bg.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(pkg, "assets", "run.exe"), "MZ");
// A file OUTSIDE every package, at the skins root and above it: the targets a traversal would reach.
fs.writeFileSync(path.join(skinsDir, "secret.css"), "outside");
fs.writeFileSync(path.join(root, "secret.css"), "outside");
let symlinks = true;
try {
  fs.symlinkSync(path.join(root, "secret.css"), path.join(pkg, "assets", "link.css"));
} catch {
  symlinks = false;
}

const ctx = { skinsDir, activeId: "aurora-night" };
const status = async (url, c = ctx) => (await serveSkinRequest(url, c)).status;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the scheme is registered standard + secure + fetchable, once, before ready", () => {
  assert.equal(SKIN_SCHEME_PRIVILEGES.scheme, "skin");
  assert.deepEqual(SKIN_SCHEME_PRIVILEGES.privileges, { standard: true, secure: true, supportFetchAPI: true });
});

test("the active package's files are served with the right type", async () => {
  const r = await serveSkinRequest("skin://current/tokens.css?t=123", ctx);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await r.text(), ":root{--primary:#0af}");
  const png = await serveSkinRequest("skin://current/assets/bg.png", ctx);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  // A specific package by id, for the gallery's previews; host case does not matter.
  assert.equal(await status("skin://aurora-night/manifest.json"), 200);
  assert.equal(await status("skin://Current/tokens.css"), 200);
});

test("path traversal is a 404, whichever way it is spelled", async () => {
  for (const url of [
    "skin://current/../../../../etc/passwd",
    "skin://current/../secret.css",
    "skin://current/../../secret.css",
    "skin://current/assets/../../secret.css",
    "skin://current/%2e%2e/secret.css",
    "skin://current/%2E%2E%2Fsecret.css",
    "skin://current/..%5csecret.css",
    "skin://current/assets\\..\\..\\secret.css",
    "skin://current/assets/%5c../secret.css",
    "skin://current/secret%00.css",
  ]) {
    assert.equal(await status(url), 404, url);
    assert.equal(resolveSkinRequest(url, ctx), null, url);
  }
});

test("only whitelisted extensions, only regular files, only inside the package", async () => {
  assert.equal(await status("skin://current/assets/run.exe"), 404, "extension not allowed even though the file exists");
  assert.equal(await status("skin://current/assets"), 404, "a directory");
  assert.equal(await status("skin://current/"), 404, "the package root");
  assert.equal(await status("skin://current"), 404);
  assert.equal(await status("skin://current/missing.css"), 404);
  if (symlinks) assert.equal(await status("skin://current/assets/link.css"), 404, "a symlink out of the package");
});

test("hosts that are not an installed package id are refused", async () => {
  for (const url of [
    "skin://current/tokens.css",
    "skin://default/tokens.css",
    "skin://builtin-midnight/tokens.css",
    "skin://none/tokens.css",
    "skin:///tokens.css",
    "skin://Aurora_Night/tokens.css",
    "skin://../tokens.css",
  ]) {
    assert.equal(await status(url, { skinsDir, activeId: null }), 404, url);
  }
  assert.equal(await status("skin://ghost-skin/tokens.css"), 404, "valid id shape, not installed");
  assert.equal(await status("skin://current/tokens.css", { skinsDir, activeId: "../aurora-night" }), 404, "a bad active id from a corrupt state file");
});

test("other schemes, garbage and oversized URLs never throw", async () => {
  for (const url of ["app://localhost/index.html", "file:///etc/passwd", "not a url", "", null, 42, `skin://current/${"a".repeat(3000)}.css`]) {
    assert.equal(await status(url), 404, String(url));
  }
});
