// fleet 7.4.0 car 6 (#60 step 3, Max ruling Q3 (a)+(c)): the plan-mode sweep. After plan-audit
// approves and before the plan doc is committed, a plan whose planned paths (criteria test_files,
// allowed_additions.files, repo obligation files, changed_symbols occurrence files) match
// GATE_PATH_RE, or whose planner set touches_gate, runs the gate-change-nonweakening-sweep role
// with mode "plan": the shipped gate at base_ref is measured on each criterion example and 2-3
// known-bad inputs, the planned behaviour read from the plan doc.
// - Z1: a gate path in allowed_additions.files -> the sweep runs (mode plan) after the audit and
//   before the plan commit; touches_gate alone triggers it too.
// - Z2: verdict weakening -> each loose unit is a routed finding (naming the unit) and a re-plan
//   runs; no freeze. At the last audit round -> needs_human (stop_gate intent).
// - Z3: no gate path and no touches_gate -> no sweep call (no change for such plans).
// - Z4: non_weakening with a unit not measured -> needs_human, as in the post-PR sweep.
//
// dont_care: the finding's wording after the unit name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, call, inputsOf } from "./harness.mjs";

const SW = "role:gate-change-nonweakening-sweep:plan";
const SFX = ["", ":audit-fix", ":audit-fix-2"];
const fence = (files) => ({ files, symbols: [], deps: [], settings: [] });
const NONW = { status: "ok", reason: "0 loosened", verdict: "non_weakening", units: [{ unit: "check.py", mutation: "x at base", shipped_refuses: true, new_refuses: true }], findings: [] };
const WEAK = { status: "ok", reason: "1 loosened", verdict: "weakening", units: [{ unit: "stale base dist", mutation: "old dist at base", shipped_refuses: true, new_refuses: false }], findings: [] };

function gatePlan(over, sweep) {
  const s = happy();
  for (const x of SFX) {
    s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan"], { allowed_additions: fence(["plugins/x/hooks/check.py"]) }, over || {});
    s["role:plan-audit" + x] = s["role:plan-audit"];
    if (sweep) s[SW + x] = sweep;
  }
  return s;
}

test("7.4.0 #60 Z1: a planned gate path runs the plan-mode sweep after the audit, before the plan commit", async () => {
  const out = await runOne(gatePlan(null, NONW), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const i = inputsOf(call(out, SW).prompt);
  assert.equal(i.mode, "plan");
  assert.equal(i.base_ref, "B0");
  assert.equal(i.plan_path, "docs/plans/x.md");
  assert.deepEqual(i.criteria.map((c) => c.id), ["AC1", "AC2"]);
  assert.ok(i.brief && i.brief.title, "the brief");
  assert.ok(typeof i.scratch_copy_cmd === "string" && i.scratch_copy_cmd.includes("scratch_copy.py"));
  const L = out.labels;
  assert.ok(L.indexOf("role:plan-audit") < L.indexOf(SW) && L.indexOf(SW) < L.indexOf("infra:commit-plan"), L.join(", "));
  assert.ok(out.logs.some((l) => /plan sweep: non_weakening/.test(l)), out.logs.join("\n"));
  // touches_gate alone (no gate path) triggers it too
  const t = await runOne(gatePlan({ allowed_additions: fence(["src/x.py"]), touches_gate: true }, NONW), ARGS);
  assert.equal(t.result.status, "awaiting_confirmation", t.result.reason);
  assert.ok(t.labels.includes(SW), t.labels.join(", "));
});

test("7.4.0 #60 Z2: a weakening plan sweep routes the loose unit to a re-plan; the last round stops", async () => {
  const s = gatePlan(null, WEAK);
  s[SW + ":audit-fix"] = NONW;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const pr = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).prior_round;
  assert.ok(pr.findings.some((f) => /stale base dist/.test(f.finding)), JSON.stringify(pr.findings));
  assert.ok(!out.labels.some((l) => /freeze/.test(l)));
  // weakening every round: needs_human after the last round
  const all = await runOne(gatePlan(null, WEAK), ARGS);
  assert.equal(all.result.status, "needs_human", all.result.reason);
  assert.equal(all.result.stop_gate, "intent");
  assert.match(all.result.reason, /stale base dist/);
  assert.ok(!all.labels.includes("infra:commit-plan"), all.labels.join(", "));
});

test("7.4.0 #60 Z3: a plan with no gate path and touches_gate false runs no sweep", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(!out.labels.some((l) => /gate-change-nonweakening-sweep/.test(l)), out.labels.join(", "));
  const f = await runOne(gatePlan({ allowed_additions: fence(["src/x.py"]), touches_gate: false }), ARGS);
  assert.equal(f.result.status, "awaiting_confirmation", f.result.reason);
  assert.ok(!f.labels.some((l) => /gate-change-nonweakening-sweep/.test(l)), f.labels.join(", "));
});

test("7.4.0 #60 Z4: a non_weakening plan sweep with an unmeasured unit stops needs_human", async () => {
  const um = Object.assign({}, NONW, { units: [{ unit: "check.py", mutation: "0 units examined", shipped_refuses: null, new_refuses: true }] });
  const out = await runOne(gatePlan(null, um), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /sweep unit check\.py not measured/);
  assert.ok(!out.labels.includes("infra:commit-plan"));
});
