// fleet 7.3.0 (#52, L2185; Max ruled Q2 (b)) A27: a build-mode resume after
// the freeze (freeze_digest) accepts the coder's dirty worktree when every
// frozen map (tests and frozen config) still has its frozen hash: the digest
// is computed over the freeze ref's tree, and the coder continues from the
// dirty state with freeze_tree = the freeze tree. A frozen-map change still
// refuses.
//
// dont_care: the wording of the gate line beyond the dirty tree's name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, HASHES_FLAT, H, happy, run, runOne, call, inputsOf } from "./harness.mjs";

const freezeRefOf = (planRef) => planRef.plan_ref.replace(/\/plan$/, "/freeze");
function buildArgsOf(planRef, over) {
  const b = Object.assign({}, ARGS, { mode: "build", plan_ref: planRef }, over || {});
  delete b.input;
  return b;
}
function frozenState(planRef, o) {
  const h = H(o.flat || HASHES_FLAT);
  h.git["fleetref:" + freezeRefOf(planRef)] = "T1";
  return { status: "ok", fingerprint: { head: PB, tree: o.tree }, hashes: h };
}
async function coderStop() {
  const s = happy({ script: { "role:fleet-coder:r1": { status: "needs_human", reason: "coder stuck" } } });
  const out = await run(s, ARGS);
  return { s, out, planRef: out.planResult.plan_ref };
}

test("7.3.0 #52 A27: a frozen resume with the coder's dirty tree and every frozen map unchanged resumes at the coder", async () => {
  const { s, out, planRef } = await coderStop();
  s["role:fleet-coder:r1"] = happy()["role:fleet-coder:r1"];
  s["hasher:resume-frozen"] = frozenState(planRef, { tree: "K1" });
  const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: out.result.freeze_digest }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "frozen");
  assert.equal(inputsOf(call(r, "role:fleet-coder:r1").prompt).freeze_tree, "T1");
  assert.ok(r.logs.some((l) => /frozen resume: .*K1/.test(l) && /T1/.test(l)), r.logs.filter((l) => /frozen/.test(l)).join("\n"));
  assert.ok(!r.labels.some((l) => /^role:fleet-test-(writer|judge)/.test(l)));
});

test("7.3.0 #52 A27: a dirty tree with one frozen test file changed still refuses the frozen resume", async () => {
  const { s, out, planRef } = await coderStop();
  s["hasher:resume-frozen"] = frozenState(planRef, { tree: "T9", flat: Object.assign({}, HASHES_FLAT, { "tests/test_a.py": "hX" }) });
  const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: out.result.freeze_digest }));
  assert.equal(r.result.status, "needs_human");
  assert.equal(r.result.stop_gate, "resume");
  assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
});
