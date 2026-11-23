// fleet 8.5.0 AC7 (yaadgaar #105): an ok intake answer whose relay is none or
// names_input passes intake in every mode and in the intake:rulings re-read,
// with no delegation gate line and no relaunch auto_decisions entry.
// guards_existing: the pass is today's behaviour and must stay.
//
// Run: node --test plugins/ccpmcwf/tests/v850_relay_absent.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, PB, FP_PLAN, happy, runOne, inputsOf, triedFor } from "./harness.mjs";

const MODES = [
  ["ARGS", ARGS],
  ["confirm ask", { ...ARGS, confirm: "ask" }],
  ["confirm auto", { ...ARGS, confirm: "auto" }],
  ["confirm default", { ...ARGS, confirm: "default" }],
  ["unattended", { ...ARGS, unattended: true }],
  ["auto and unattended", { ...ARGS, confirm: "auto", unattended: true }],
];

const okWith = (relay) => ({ status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF), relay });

function checkPassed(out, why) {
  assert.ok(out.labels.includes("workspace"), why + ": labels " + out.labels.join(", "));
  assert.notEqual(out.result.stop_gate, "relaunch", why);
  const log = out.result.gate_log || [];
  assert.ok(!log.some((l) => l.startsWith("intake: relayed message")), why + ": gate_log " + JSON.stringify(log));
  assert.ok(!(out.result.auto_decisions || []).some((d) => d.gate === "relaunch"), why + ": auto_decisions");
}

for (const kind of ["none", "names_input"]) {
  for (const [name, args] of MODES) {
    // AC7: relay kind <kind> passes intake in every mode, no delegation record
    test("8.5.0 AC7: relay " + kind + " passes intake under " + name, async () => {
      const s = happy();
      s.intake = okWith({ kind, text: "" });
      const out = await runOne(s, args);
      checkPassed(out, kind + " / " + name);
    });
  }
}

// AC7 triangulation: a different input and project still pass under a delegated mode
test("8.5.0 AC7: relay none passes intake for another input and project", async () => {
  const s = happy();
  s.intake = okWith({ kind: "none", text: "" });
  const out = await runOne(s, { ...ARGS, input: "#42", project: "o/other", confirm: "default" });
  checkPassed(out, "other project");
});

// ---- the intake:rulings re-read (build mode, confirm auto): fixture of v700_yaadgaar_writeback
const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };
const P = "m-agahi/ccpm";
const YQ = { ...ARGS, input: "#622", project: P, confirm: "ask" };
const written = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
const read = (p) => ({
  status: "ok",
  reason: "read",
  results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false })),
});
function autoHappy(over = {}) {
  const s = happy(over);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return s;
}
async function buildAuto(rulings, buildOver) {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, YQ);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:yaadgaar-read"] = read;
  s["infra:yaadgaar-writeback"] = written;
  s["intake:rulings"] = rulings;
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
  s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  return runOne(s, Object.assign({ mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: P, confirm: "auto" }, buildOver || {}));
}
const rulings = (relay) => ({
  status: "ok",
  reason: "re-read",
  brief: YBRIEF,
  tried: [{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: null }],
  relay,
});

for (const kind of ["none", "names_input"]) {
  // AC7: the re-read passes with relay <kind>, no relayed-message gate line
  test("8.5.0 AC7: intake:rulings re-read passes with relay " + kind, async () => {
    const out = await buildAuto(rulings({ kind, text: "" }));
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(!(out.result.gate_log || []).some((l) => l.startsWith("intake:rulings: relayed message")), JSON.stringify(out.result.gate_log));
    assert.ok(!(out.result.auto_decisions || []).some((d) => d.gate === "relaunch"));
  });
}

// AC7 triangulation: the same re-read under unattended still records no relaunch decision
test("8.5.0 AC7: intake:rulings re-read with relay none records no relaunch decision when unattended", async () => {
  const out = await buildAuto(rulings({ kind: "none", text: "" }), { unattended: true });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!(out.result.gate_log || []).some((l) => l.startsWith("intake:rulings: relayed message")));
  assert.ok(!(out.result.auto_decisions || []).some((d) => d.gate === "relaunch"));
});
