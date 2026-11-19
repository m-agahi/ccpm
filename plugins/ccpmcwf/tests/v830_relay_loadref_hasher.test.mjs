// fleet 8.3.0 (#91, #92): load-ref and hasher relays.
// #91 (run wf_3234140b-2b7): a 2-part plan ref (53690 cp, parts of 32000 cp)
// failed at load-ref. Each part's JSON was over the ~30 KB Bash inline limit,
// the `:retry` re-reads ran on the same model, and part 0 was never checked
// after its re-read. Now: parts of 8000 cp (plan_ref.py, parked.py and
// REF_PART_CHARS stay equal), every load-ref/load-parked `:retry` steps up a
// tier, and a failed join re-reads part 0 for its content and every bad part.
// #92 (run wf_36f683a0-f7e): a hasher relay with a quoted file_sha256 stopped
// the run. Now the value is trimmed of quotes and whitespace before the exact
// compare, and a hasher relay off its program gets one fresh-agent retry one
// tier up. A truly wrong value still stops at the contract gate.
//
// dont_care: gate line wording; the order of the part reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF, PC, SOURCE, SCRIPTS_SRC, happy, runOne, noUnscripted, inputsOf, planRefFor, buildArgs, loadStub, partOut, programSha, PART_CHARS, PARKED_PART } from "./harness.mjs";

const pyPart = (f) => Number(/^PART = (\d+)$/m.exec(readFileSync(join(SCRIPTS_SRC, f), "utf8"))[1]);
const srcPart = () => Number(/^const REF_PART_CHARS = (\d+);$/m.exec(SOURCE)[1]);
const modelsOf = (out, re) => out.calls.filter((x) => re.test(x.label)).map((x) => [x.label, x.opts.model]);

function bigHappy(kb) {
  return happy({ brief: { ...BRIEF, description: 'Large "plan" ref: ünï 🚀 — '.repeat(Math.ceil((kb * 1024) / 20)) } });
}

test("8.3.0 #91: the part size is 8000 cp at most and equal in plan_ref.py, parked.py, REF_PART_CHARS and the harness", () => {
  const n = srcPart();
  assert.ok(n <= 8000 && n >= 4000, "REF_PART_CHARS " + n);
  assert.equal(pyPart("plan_ref.py"), n);
  assert.equal(pyPart("parked.py"), n);
  assert.equal(PART_CHARS, n);
  assert.equal(PARKED_PART, n);
});

test("8.3.0 #91: the 53690-cp ref of wf_3234140b-2b7 relays every part under 30000 chars", () => {
  const content = JSON.stringify({ x: 'ünï 🚀 "q" — '.repeat(Math.ceil(53690 / 13)) }).slice(0, 53690);
  const n = Math.ceil([...content].length / PART_CHARS);
  for (let k = 0; k < n; k++) {
    const r = { status: "ok", reason: "read", refs: [], ...partOut(content, k) };
    assert.ok(JSON.stringify(r).length < 30000, "part " + k + ": " + JSON.stringify(r).length);
  }
});

test("8.3.0 #91: a ref over 30 KB loads", async () => {
  const s = bigHappy(52);
  const tiny = await planRefFor(s);
  assert.ok([...s.__store[PC]].length > 30000);
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.notEqual(out.result.status, "failed", out.result.reason);
  assert.ok(!/load-ref/.test(out.result.reason || ""), out.result.reason);
});

// relay fakes of the wf_3234140b-2b7 failures
const truncate = (r) => Object.assign(r, { chunks: r.chunks.slice(0, -1).concat(["PLACEHOLDER"]) });
const duplicate = (r) => Object.assign(r, { chunks: [r.chunks[0], r.chunks[0].slice(0, 127)].concat(r.chunks.slice(1)) });
const escape2 = (r) => Object.assign(r, { chunks: r.chunks.map((c) => c.replace(/"/g, '\\"')) });

for (const [name, fake] of [["truncates", truncate], ["duplicates a record", duplicate], ["double-escapes quotes", escape2]]) {
  test("8.3.0 #91: a part-0 relay that " + name + " is re-read one tier up and the ref loads", async () => {
    const s = bigHappy(20);
    const tiny = await planRefFor(s);
    const good = loadStub(s.__store);
    s["infra:load-ref"] = (p) => (inputsOf(p).part === 0 ? fake(good(p)) : good(p));
    s["infra:load-ref:retry"] = good;
    const out = await runOne(s, buildArgs(tiny));
    noUnscripted(out);
    assert.notEqual(out.result.status, "failed", out.result.reason);
    assert.deepEqual(modelsOf(out, /^infra:load-ref:retry$/), [["infra:load-ref:retry", "opus"]]);
  });
  test("8.3.0 #91: a part-1 relay that " + name + " is re-read one tier up and the ref loads", async () => {
    const s = bigHappy(20);
    const tiny = await planRefFor(s);
    const good = loadStub(s.__store);
    s["infra:load-ref:p1"] = (p) => fake(good(p));
    const out = await runOne(s, buildArgs(tiny));
    noUnscripted(out);
    assert.notEqual(out.result.status, "failed", out.result.reason);
    assert.deepEqual(modelsOf(out, /^infra:load-ref:p1(:retry)?$/), [["infra:load-ref:p1", "sonnet"], ["infra:load-ref:p1:retry", "opus"]]);
  });
}

test("8.3.0 #91: a part 0 with a correct count but wrong content on both reads recovers via the q0 re-read", async () => {
  const s = bigHappy(20);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  // part 0 keeps its count and sha256 field but its text is wrong on the first two reads
  let k = 0;
  const bad0 = (p) => {
    const r = good(p);
    if (inputsOf(p).part === 0 && k++ < 2) r.chunks = r.chunks.map((c) => c.replace(/a/g, "b"));
    return r;
  };
  s["infra:load-ref"] = bad0;
  s["infra:load-ref:retry"] = bad0;
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.notEqual(out.result.status, "failed", out.result.reason);
  assert.equal(out.labels.filter((x) => x === "infra:load-ref:retry").length, 2, out.labels.join(", "));
  assert.ok(!out.labels.some((x) => /^infra:load-ref:p0:r\d+:retry$/.test(x)), "q0's content was used: " + out.labels.join(", "));
});

test("8.3.0 #91: a part bad on its read and its re-read is read again after the failed join, within MAX_CHUNK_RETRIES", async () => {
  const s = bigHappy(20);
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref:p1"] = s["infra:load-ref:p1:retry"] = (p) => truncate(good(p));
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.notEqual(out.result.status, "failed", out.result.reason);
  assert.deepEqual(modelsOf(out, /^infra:load-ref:p1:r1:retry$/), [["infra:load-ref:p1:r1:retry", "opus"]]);
});

// #92
const SHA = programSha("hasher");
const LBL = "hasher:pre-writers:r1";

test("8.3.0 #92: a hasher relay whose file_sha256 is quoted is accepted (no retry)", async () => {
  for (const q of ['"' + SHA + '"', '\\"' + SHA + '\\"', " '" + SHA + "'\n"]) {
    const s = happy();
    s.__mutate = { label: LBL, fn: (r) => Object.assign(r, { file_sha256: q }) };
    const tiny = await planRefFor(s);
    const out = await runOne(s, buildArgs(tiny));
    assert.ok(!/did not run the shipped program hasher/.test(out.result.reason || ""), out.result.reason);
    assert.ok(!out.labels.includes(LBL + ":digest-retry"), out.labels.join(", "));
  }
});

test("8.3.0 #92: a hasher relay with a mis-copied file_sha256 gets one fresh agent one tier up and recovers", async () => {
  const s = happy();
  s.__mutate = { label: LBL, fn: (r, p, l) => (l === LBL ? Object.assign(r, { file_sha256: SHA.slice(0, 63) }) : r) };
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs(tiny));
  assert.ok(!/did not run the shipped program hasher/.test(out.result.reason || ""), out.result.reason);
  assert.deepEqual(modelsOf(out, new RegExp("^" + LBL + "(:digest-retry)?$")), [[LBL, "sonnet"], [LBL + ":digest-retry", "opus"]]);
});

test("8.3.0 #92: a truly wrong hasher file_sha256 still stops at the contract gate after the retry", async () => {
  const s = happy();
  s.__mutate = { label: LBL, fn: (r) => Object.assign(r, { file_sha256: '"' + "0".repeat(64) + '"' }) };
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /^hasher hasher:pre-writers:r1(:digest-retry)?: did not run the shipped program hasher/);
  assert.ok(out.labels.includes(LBL + ":digest-retry"), out.labels.join(", "));
});
