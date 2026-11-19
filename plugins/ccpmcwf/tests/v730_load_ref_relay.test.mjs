// fleet 7.3.0 (#47b, #47c) A5, A6: load-ref.
// - b: an intact ref (every relay's metadata check passed) whose parts never
//   join to ref_sha256 stops failed with a relay-failure text, not "plan ref
//   missing or changed"; a ref whose metadata changed still stops needs_human.
// - c: the part-0 count re-read runs once in every path (also after a first
//   part-0 re-read), and a part 0 with no part count is read once more first.
//
// dont_care: the gate line wording; the order of the part reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIEF, PC, happy, runOne, noUnscripted, inputsOf, planRefFor, buildArgs, loadStub, PART_CHARS } from "./harness.mjs";

function bigHappy(kb) {
  return happy({ brief: { ...BRIEF, description: "Large plan ref: ünï 🚀 — ".repeat(Math.ceil((kb * 1024) / 20)) } });
}
const count = (out, l) => out.labels.filter((x) => x === l).length;

test("7.3.0 #47b A5: an intact ref whose part 1 is mis-copied on every read stops failed with the relay text", async () => {
  const s = bigHappy(128);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  const bad = (p) => {
    const r = good(p);
    r.chunks = r.chunks.slice();
    r.chunks[1] = "[truncated]";
    return r;
  };
  s["infra:load-ref:p1"] = bad;
  s["infra:load-ref:p1:retry"] = bad;
  // 8.3.0 (#91): and its re-reads after the failed join
  s["infra:load-ref:p1:r1:retry"] = s["infra:load-ref:p1:r2:retry"] = bad;
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.includes("the plan ref"), out.result.reason);
  assert.ok(out.result.reason.includes("is intact; re-run build with the same plan_ref"), out.result.reason);
  assert.ok(!out.result.reason.includes("missing or changed"), out.result.reason);
  assert.ok(!out.labels.some((x) => x.startsWith("role:")));
});

test("7.3.0 #47b A5 control: a meta relay whose ref_sha256 differs stops needs_human 'plan ref missing or changed'", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref"] = (p) => {
    const r = good(p);
    r.refs = r.refs.map((e) => (e.name === tiny.plan_ref ? { ...e, sha256: "e".repeat(64) } : e));
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /plan ref missing or changed/);
});

test("7.3.0 #47c A6: after a first part-0 re-read relays count 1 (true count 2), one more part-0 read runs and the ref loads", async () => {
  const s = bigHappy(10);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  const n = Math.ceil([...s.__store[PC]].length / PART_CHARS);
  assert.equal(n, 2, "parts: " + n);
  // the first read of part 0 is mis-copied (a re-read follows); the re-read says 1 part
  // (unscripted part reads fall back to this stub: only part 0 is mis-copied)
  s["infra:load-ref"] = (p) => {
    const r = good(p);
    if (inputsOf(p).part === 0) r.chunks = r.chunks.slice(0, -1);
    return r;
  };
  let k = 0;
  s["infra:load-ref:retry"] = (p) => {
    const r = good(p);
    if (k++ === 0 && inputsOf(p).part === 0) r.part = { ...r.part, count: 1 };
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(count(out, "infra:load-ref:retry"), 2, out.labels.join(", "));
});

test("7.3.0 #47c A6: a part 0 with no part count once is read once more before any stop", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref"] = (p) => {
    const r = good(p);
    delete r.part;
    return r;
  };
  s["infra:load-ref:retry"] = good;
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(count(out, "infra:load-ref:retry"), 1, out.labels.join(", "));
});
