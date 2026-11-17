// fleet 7.3.0 (#47a) A4: a run-state or park-findings payload over one
// writer's bound (CHUNKS_PER_WRITER = 8 chunks of 4000 base64 characters,
// ADR-1267) is written by parallel chunk writers; the program step then
// carries no chunk text, and its exit-3 bad_chunks list sends only those
// chunks to fresh writers. A payload within the bound stays inline, as before.
//
// dont_care: the wording of the prompts; the order of unrelated labels; the
// state labels other than infra:state:committed:r1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, happy, run, runOne, call, inputsOf, writerChunksOf, CHUNK_STORE, sha256 } from "./harness.mjs";

const BIG = "x".repeat(40000);
const L = "infra:state:committed:r1";
const W = "infra:state-chunks:committed:r1";
function bigState() {
  const s = happy();
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { suite_result: { command: "pytest", exit_code: 0, tail: BIG } });
  return s;
}
// the state_write command's chunk sha256 list (its last argument)
const shasOf = (prompt) => {
  const m = /state_write\.py'(?: '[^']*'){5} '(\[[^']*\])'/.exec(String(prompt));
  return m ? JSON.parse(m[1]) : null;
};
// state_write over the chunk files the writers wrote: exit 3 with the bad chunk ids, else the ref lands
function stateWriteStub(forceBad) {
  return (prompt) => {
    const shas = shasOf(prompt);
    const files = CHUNK_STORE.get(inputsOf(prompt).chunk_dir) || {};
    const bad = forceBad ? forceBad() : shas.filter((e) => typeof files[e.i] !== "string" || sha256(files[e.i]) !== e.sha256).map((e) => e.i);
    if (bad && bad.length) return { status: "failed", reason: "bad chunks", bad_chunks: bad };
    return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
  };
}
const writersOf = (out, prefix) => out.labels.filter((l) => l.startsWith(prefix));

test("7.3.0 #47a A4: a run-state within the bound stays inline; no state-chunks writer runs", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(writersOf(out, "infra:state-chunks"), []);
  assert.ok(Object.keys(writerChunksOf(call(out, L).prompt)).length >= 1, "the state prompt holds the chunks");
});

test("7.3.0 #47a A4: a run-state of 9+ chunks goes to parallel writers; the state step holds no chunk text", async () => {
  const s = bigState();
  s[L] = stateWriteStub();
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes(W + ":r0w0") && out.labels.includes(W + ":r0w1"), out.labels.join(", "));
  const ids = [];
  for (const l of writersOf(out, W + ":r0w")) {
    const ch = Object.keys(writerChunksOf(call(out, l).prompt)).map(Number);
    assert.ok(ch.length >= 1 && ch.length <= 8, l + " carries " + ch.length);
    ids.push(...ch);
  }
  const p = call(out, L).prompt;
  assert.deepEqual(writerChunksOf(p), {}, "the state step carries no chunk text");
  assert.equal(shasOf(p).length, ids.length, "the program checks every chunk");
  assert.ok(ids.length >= 9);
  for (const l of writersOf(out, W + ":r0w")) assert.ok(out.labels.indexOf(l) < out.labels.indexOf(L), l + " runs before the state step");
});

test("7.3.0 #47a A4: state_write exit 3 bad_chunks [1] sends only chunk 1 to r1w0 (on opus)", async () => {
  const s = bigState();
  let first = true;
  s[L] = stateWriteStub(() => (first ? ((first = false), [1]) : null));
  s[L + ":rewrite-1"] = stateWriteStub();
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(writersOf(out, W + ":r1"), [W + ":r1w0"]);
  assert.deepEqual(Object.keys(writerChunksOf(call(out, W + ":r1w0").prompt)), ["1"]);
  assert.equal(out.calls.find((c) => c.label === W + ":r1w0").opts.model, "opus");
  assert.ok(out.labels.includes(L + ":rewrite-1"));
});

test("7.3.0 #47a A4: chunks still bad after 2 rewrite rounds halt failed", async () => {
  const s = bigState();
  const bad = stateWriteStub(() => [1]);
  s[L] = s[L + ":rewrite-1"] = s[L + ":rewrite-2"] = bad;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.match(out.result.reason, /chunk\(s\) 1 still do not match/);
  assert.ok(!out.labels.includes(L + ":rewrite-3"));
});

// park findings: three refused rounds with long findings
const REFUSE = (finding) => ({ status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding }] });
function bigPark() {
  const s = happy();
  s["role:plan-audit"] = REFUSE("r0 " + "y".repeat(12000));
  s["role:plan-audit:audit-fix"] = REFUSE("r1 " + "y".repeat(12000));
  s["role:plan-audit:audit-fix-2"] = REFUSE("r2 " + "y".repeat(12000));
  return s;
}

test("7.3.0 #47a A4: park findings of 9+ chunks go to infra:park-chunks writers; the park step holds no chunk text", async () => {
  const out = await runOne(bigPark(), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.labels.includes("infra:park-chunks:r0w0") && out.labels.includes("infra:park-chunks:r0w1"), out.labels.join(", "));
  const pk = call(out, "infra:park-plan").prompt;
  assert.deepEqual(writerChunksOf(pk), {}, "the park step carries no chunk text");
  assert.match(pk, /parked\.py' 'write'/);
  assert.match(out.result.reason, /draft plan moved to /);
});

test("7.3.0 #47a A4: a park writer that returns nothing logs a gate line and never halts; the park stop text stays", async () => {
  const s = bigPark();
  s["infra:park-chunks:r0w0"] = () => null;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /^plan-audit verdict plan_defect/);
  assert.ok(out.logs.some((l) => /infra:park-chunks:r0w0 returned no result/.test(l)), out.logs.join("\n"));
});

test("7.3.0 #47a A4: the park writers run on the soft cap (no reserve: a cap-skipped writer logs and never halts)", () => {
  const fn = SOURCE.slice(SOURCE.indexOf("async function writeChunksParallel("), SOURCE.indexOf("\n}\n", SOURCE.indexOf("async function writeChunksParallel(")));
  assert.match(fn, /if \(!soft\) reserve\(/);
  const park = SOURCE.slice(SOURCE.indexOf("const parkOnStop = async"), SOURCE.indexOf("const confirm0 ="));
  assert.match(park, /writeChunksParallel\("infra:park-chunks"[^\n]*true\)/);
  assert.ok(!/reserve\(/.test(park), "parkOnStop reaches no reserve()");
});
