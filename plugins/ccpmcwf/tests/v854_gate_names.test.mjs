// ccpmcwf 8.5.4 (yaadgaar #108 step 1, ADR-1397): each stop_gate name means one thing.
// - The plan-audit verdict stop is `audit` (was `role`).
// - The test-round and code-round exhaustion stops, and the pre_freeze_hooks stop after the last
//   test round, are `rounds` (were `cap`); `cap` is the agent cap only.
// - The hasher relay-size overflow is `relay-size` (was `hash`); `hash` is a hash mismatch only.
// - The plan_ref checks for fleet 2.0.3, 2.1.0 and 2.1.4 refs give one plain refusal; an old ref
//   still fails closed. The 6.0.0 checks stay (a live 5.0.10 ref exists).
//
// Run: node --test plugins/ccpmcwf/tests/v854_gate_names.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, FP_K2, FP_M3, SOURCE, happy, run, runOne, planRefFor, buildArgs, sha256, canon } from "./harness.mjs";

const STOP_GATES = JSON.parse(/const STOP_GATES = (\[[^\]]*\]);/.exec(SOURCE)[1]);
const LEGACY = "plan_ref from an unsupported fleet version; re-run plan";

test("8.5.4: STOP_GATES names audit, rounds and relay-size", () => {
  for (const g of ["audit", "rounds", "relay-size", "cap", "hash", "role"]) assert.ok(STOP_GATES.includes(g), g);
});

test("8.5.4: the agent cap (reserve) is the only stop at gate cap", () => {
  const body = SOURCE.replace(/\nconst STOP_GATES = [^\n]*/, "");
  const hits = body.match(/"cap"/g) || [];
  assert.equal(hits.length, 1, "one \"cap\" literal in src outside STOP_GATES");
  assert.match(SOURCE, /function reserve\(n, what\) \{[\s\S]{0,200}"cap",/);
});

test("8.5.4: a plan-audit refusal after the re-plan rounds stops at gate audit", async () => {
  const s = happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding: "bad" }] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^plan-audit verdict plan_defect/);
  assert.equal(out.result.stop_gate, "audit");
});

test("8.5.4: code rounds exhausted stops at gate rounds", async () => {
  const t = happy();
  for (const m of [1, 2, 3]) t["role:fleet-coder:r" + m] = Object.assign({}, t["role:fleet-coder:r1"], { added_symbols: "[]" });
  t["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2 };
  t["hasher:post-coder:r3"] = { status: "ok", fingerprint: FP_M3 };
  const out = await run(t, ARGS);
  assert.match(out.result.reason, /^code rounds exhausted \(3\)/);
  assert.equal(out.result.stop_gate, "rounds");
});

test("8.5.4: the hasher relay-size overflow stops at gate relay-size, not hash", async () => {
  const s = happy();
  s["hasher:pre-writers:r1"] = { status: "failed", reason: "FLEET_HASHER_RELAY_CAP: the hasher output is over the 65536-byte relay cap (153000 bytes; largest: files 1500 keys)\n", fingerprint: { head: "", tree: "" } };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /over the 65536-byte relay cap \(largest: files 1500 keys\)/);
  assert.equal(out.result.stop_gate, "relay-size");
});

test("8.5.4: a plan_ref with ref_path (fleet 2.1.3 or earlier) fails closed with the plain refusal", async () => {
  const tiny = await planRefFor(happy());
  const out = await runOne(happy(), buildArgs({ ...tiny, ref_path: ".fleet/y42/plan_ref.json" }));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.reason, LEGACY);
  assert.equal(out.calls.length, 0);
});

// a sealed ref from this install, edited the way an old fleet version wrote it
async function oldRef(edit) {
  const s = happy();
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[tiny.plan_commit]);
  edit(ref);
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  return { s, tiny: { ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) } };
}

test("8.5.4: a plan_ref with no plan_facts.test_cmd (fleet 2.0.2 or earlier) fails closed with the plain refusal", async () => {
  const { s, tiny } = await oldRef((r) => delete r.plan_facts.test_cmd);
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.reason, LEGACY);
  assert.ok(!out.labels.includes("infra:verify-plan"));
});

test("8.5.4: a plan_ref with no plan_diff (fleet 2.0.x) fails closed under confirm auto with the plain refusal", async () => {
  const { s, tiny } = await oldRef((r) => delete r.plan_diff);
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: { head: PB, tree: "P0" } };
  const out = await runOne(s, buildArgs(tiny, { confirm: "auto" }));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.reason, LEGACY);
  assert.ok(!out.labels.some((l) => /^role:fleet-test-writer/.test(l)), out.labels.join(", "));
});
