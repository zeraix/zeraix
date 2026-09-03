/**
 * The download-progress reporter rations broadcasts, not bytes.
 *
 * Pinned because the failure it prevents is invisible in a test that only checks the final number: the first-run
 * download used to broadcast once per network chunk, and the app was sluggish for the whole download because of it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createProgressReporter } from "../electron/tools/sandbox/progress.mjs";

const MB = 1048576;

function harness({ total, intervalMs = 250 }) {
  let t = 0;
  const reports = [];
  const r = createProgressReporter({
    total,
    intervalMs,
    now: () => t,
    onProgress: (pct, text) => reports.push({ pct, text }),
  });
  return { r, reports, tick: (ms) => (t += ms) };
}

test("a chunk storm inside one interval is one report, not thousands", () => {
  const { r, reports } = harness({ total: 2000 * MB });
  r.milestone(); // the initial report, as the download loop issues it
  // 500 chunks of 16 KB, all inside the same 250 ms window and all inside the same percent.
  for (let i = 0; i < 500; i++) r.add(16 * 1024);
  assert.equal(reports.length, 1, "nothing new to say: same percent, same interval");
  assert.equal(r.done, 500 * 16 * 1024, "bytes are still counted exactly");
});

test("time moves the report along even while the percentage does not", () => {
  const { r, reports, tick } = harness({ total: 2000 * MB });
  r.milestone();
  tick(250);
  r.add(16 * 1024);
  assert.equal(reports.length, 2);
  assert.match(reports[1].text, /^Downloading runtime environment 0\/2000 MB$/);
});

test("a whole-percent change reports at once, whatever the clock says", () => {
  const { r, reports } = harness({ total: 100 * MB });
  r.milestone();
  r.add(MB - 1);
  assert.equal(reports.length, 1);
  r.add(1); // 1%
  assert.equal(reports.length, 2);
  assert.equal(reports[1].pct, 1);
});

test("the percentage never claims 100 before the files are verified, and is null when the size is unknown", () => {
  const { r, reports } = harness({ total: 10 * MB });
  r.add(10 * MB);
  assert.equal(reports.at(-1).pct, 99, "100 is the caller's to say, after verification");
  const unknown = harness({ total: 0 });
  unknown.r.add(5 * MB);
  assert.equal(unknown.reports.at(-1).pct, null);
});

test("a milestone always lands, so a finished file shows its exact final number", () => {
  const { r, reports } = harness({ total: 100 * MB });
  r.milestone();
  r.add(512 * 1024);
  assert.equal(reports.length, 1);
  r.milestone();
  assert.equal(reports.length, 2);
  assert.match(reports[1].text, /1\/100 MB$/);
});
