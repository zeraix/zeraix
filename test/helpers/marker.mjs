/**
 * Counting appends to a marker file, independent of the shell's output encoding.
 *
 * Several resume tests prove "this node did not run twice" by having it append a line and counting
 * the lines. On Windows the shell runtime spawns PowerShell, and PowerShell 5.1's `>>` writes
 * **UTF-16LE with a BOM** -- so `readFileSync(f, "utf8").split("\n")` sees a stray NUL after every
 * newline and reports 2 lines for a single append. That turns an encoding default into a failing
 * assertion about re-execution, which is about as misleading as a test failure gets.
 *
 * Decoding by BOM rather than forcing an encoding in the fixtures keeps the commands themselves
 * plain: the test still writes `echo x >> file`, exactly what a user's workflow would.
 */
import fs from "node:fs";

/** Number of non-empty lines in a marker file, whatever encoding the shell chose. */
export function appendCount(file) {
  const raw = fs.readFileSync(file);
  const text =
    raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe
      ? raw.toString("utf16le").replace(/^﻿/, "")
      : raw.toString("utf8").replace(/^﻿/, "");
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}
