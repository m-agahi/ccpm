// #93: an intent judge answer that files a plan_diff entry neither as a deviation nor in bookkept
// (daneel wf_2196c06c-a51: the judge cut the entry's last clause) earns ONE re-ask naming the
// unfiled entries. The second answer replaces the first and passes every check again: an entry
// still unfiled, a refused one or one that does not fail closed stops the run. Exact match stays.
//
// dont_care: the wording of the re-ask line; the order of the intent-gate reasons.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PB, happy, runOne, ARGS, inputsOf } from "./harness.mjs";

const CUT = "stricter rules; the 30 s leeway edges are inclusive.";
const DIFF = ["adds f()", CUT];
const dev = (item, o = {}) => Object.assign({ item, allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }, o);
const answer = (deviations) => ({
  status: "ok",
  reason: "matches the task",
  verdict: "approve",
  deviations,
  bookkept: [],
  coverage: { covered: true, missing: [] },
  classification: { change_kind: "approve", new_behaviour: "approve", quote: "add f" },
});
const FIRST = answer([dev("adds f()"), dev("stricter rules.")]);
function auto(first, second) {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { plan_diff: DIFF.slice() });
  const fp = { status: "ok", fingerprint: { head: PB, tree: "P0" } };
  for (const l of ["hasher:pre-intent", "hasher:fp-post:intent", "hasher:pre-intent:reask", "hasher:fp-post:intent:reask"]) s[l] = fp;
  s["role:fleet-intent-judge"] = first;
  if (second) s["role:fleet-intent-judge:reask"] = second;
  return s;
}
const gateLine = (out) => out.logs.find((l) => /^auto-confirm: intent (approve|check failed)/.test(l)) || "";
const reasks = (out) => out.calls.filter((c) => c.label === "role:fleet-intent-judge:reask");

test("#93: an entry unfiled on the first ask and filed, allowed, on the re-ask passes", async () => {
  const out = await runOne(auto(FIRST, answer([dev("adds f()"), dev(CUT)])), { ...ARGS, confirm: "auto" });
  assert.equal(reasks(out).length, 1, out.labels.join("\n"));
  assert.deepEqual(inputsOf(reasks(out)[0].prompt).unfiled_plan_diff, [CUT]);
  assert.ok(out.logs.some((l) => /^auto-confirm: re-asking the intent judge: 1 unfiled plan_diff entry\(s\)/.test(l)), out.logs.join("\n"));
  assert.match(gateLine(out), /^auto-confirm: intent approve/, out.logs.join("\n"));
});

test("#93: an entry unfiled twice stops the run", async () => {
  const out = await runOne(auto(FIRST, FIRST), { ...ARGS, confirm: "auto" });
  assert.equal(reasks(out).length, 1, out.result.reason + "\n" + out.labels.join("\n"));
  assert.match(gateLine(out), /intent check failed: .*plan_diff entry "stricter rules; the 30 s leeway edges are inclusive\." is neither a deviation nor bookkept/, out.logs.join("\n"));
  assert.equal(out.result.status, "needs_human");
});

test("#93: a re-ask that refuses the entry, or files it not fail-closed, stops the run", async () => {
  for (const [o, re] of [
    [{ verdict: "refuse" }, /deviation .*refused/],
    [{ fails_closed: false }, /does not fail closed/],
  ]) {
    const out = await runOne(auto(FIRST, answer([dev("adds f()"), dev(CUT, o)])), { ...ARGS, confirm: "auto" });
    assert.equal(reasks(out).length, 1, out.result.reason + "\n" + out.labels.join("\n"));
    assert.match(gateLine(out), re, out.logs.join("\n"));
    assert.equal(out.result.status, "needs_human");
  }
  const ref = await runOne(auto(FIRST, Object.assign(answer([dev("adds f()"), dev(CUT)]), { verdict: "refuse", reason: "no" })), { ...ARGS, confirm: "auto" });
  assert.match(gateLine(ref), /intent verdict refuse/, ref.logs.join("\n"));
});

test("#93: no re-ask when every entry is filed, or when the first answer fails for another reason too", async () => {
  const ok = await runOne(auto(answer([dev("adds f()"), dev(CUT)])), { ...ARGS, confirm: "auto" });
  assert.equal(reasks(ok).length, 0);
  assert.match(gateLine(ok), /^auto-confirm: intent approve/, ok.logs.join("\n"));
  const both = await runOne(auto(Object.assign({}, FIRST, { verdict: "refuse", reason: "no" }), answer([dev("adds f()"), dev(CUT)])), { ...ARGS, confirm: "auto" });
  assert.equal(reasks(both).length, 0);
  assert.match(gateLine(both), /neither a deviation nor bookkept.*intent verdict refuse|intent verdict refuse.*neither/, both.logs.join("\n"));
  // a refuse reason worded like the unfiled-entry reason is no re-ask and no crash
  const worded = await runOne(auto(Object.assign(answer([dev("adds f()"), dev(CUT)]), { verdict: "refuse", reason: 'plan_diff entry "x" is neither a deviation nor bookkept' }), FIRST), { ...ARGS, confirm: "auto" });
  assert.equal(reasks(worded).length, 0);
  assert.match(gateLine(worded), /intent check failed: intent verdict refuse/, worded.logs.join("\n"));
  assert.equal(worded.result.status, "needs_human");
});
