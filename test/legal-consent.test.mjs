/**
 * The first-launch consent gate's pure parts (electron/legal/consentState.mjs, consentStrings.mjs).
 *
 * The screen itself needs Electron; what can be pinned down here is the rule that decides whether it shows —
 * nothing on disk, a broken file, or an agreement to an older version all mean "ask" — and the text it shows:
 * every language complete, and the link placeholder present exactly once on every agreement line, since a
 * line without it would lose the document it agrees to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { LEGAL_VERSION, PRIVACY_URL, TERMS_URL, isAccepted, readConsent, writeConsent } = await import("../electron/legal/consentState.mjs");
const { LANGUAGES, DEFAULT_LANGUAGE, STRINGS, stringsFor } = await import("../electron/legal/consentStrings.mjs");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-consent-")), "legal-consent.json");

test("nothing on disk, or nothing readable, means the screen is shown", () => {
  const file = tmp();
  assert.equal(readConsent(file), null, "no file");
  assert.equal(isAccepted(null), false);
  fs.writeFileSync(file, "{not json");
  assert.equal(readConsent(file), null, "a broken file");
  fs.writeFileSync(file, '"just a string"');
  assert.equal(isAccepted(readConsent(file)), false, "the wrong shape");
});

test("an agreement is recorded with the version it was given to, and is then honoured", () => {
  const file = tmp();
  const at = new Date("2026-09-03T10:00:00Z");
  const record = writeConsent(file, LEGAL_VERSION, at);
  assert.deepEqual(record, { version: LEGAL_VERSION, acceptedAt: at.toISOString() });
  assert.deepEqual(readConsent(file), record, "round-trips through disk");
  assert.equal(isAccepted(readConsent(file)), true);
});

test("a new version of the documents brings the screen back once", () => {
  const file = tmp();
  writeConsent(file, "2020-01-01");
  assert.equal(isAccepted(readConsent(file), LEGAL_VERSION), false, "an old agreement is not an agreement to this version");
  writeConsent(file, LEGAL_VERSION);
  assert.equal(isAccepted(readConsent(file), LEGAL_VERSION), true);
});

test("the document URLs are the published ones", () => {
  assert.equal(PRIVACY_URL, "https://zeraix.com/privacy.html");
  assert.equal(TERMS_URL, "https://zeraix.com/terms.html");
});

test("the page offers English and Chinese, opens in English, and every line exists in both", () => {
  assert.deepEqual(LANGUAGES.map((l) => l.code), ["en", "zh"]);
  assert.equal(DEFAULT_LANGUAGE, "en", "a fixed default, not a guess from the OS locale");
  assert.deepEqual(Object.keys(STRINGS).sort(), ["en", "zh"], "no stray or missing languages");
  const keys = Object.keys(STRINGS.en);
  for (const { code } of LANGUAGES) {
    const s = STRINGS[code];
    for (const k of keys) assert.ok(typeof s[k] === "string" && s[k].trim(), `${code}.${k} is empty`);
    // A line without the placeholder would lose the document it agrees to.
    assert.equal(s.agreePrivacy.split("{link}").length, 2, `${code}: agreePrivacy needs one {link}`);
    assert.equal(s.agreeTerms.split("{link}").length, 2, `${code}: agreeTerms needs one {link}`);
  }
  assert.equal(stringsFor("xx"), STRINGS.en, "an unknown code gets English, never blanks");
});
