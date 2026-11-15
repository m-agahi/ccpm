// fleet 7.0.0 AC2 (yaadgaar #699): a yaadgaar source on a project outside
// yadgarhq/ plans, builds and is written back through infra:yaadgaar-read and
// infra:yaadgaar-writeback, with the same id, number and project checks as a
// yadgarhq/ project. A read answer that names another project is refused.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, PB, FP_PLAN, happy, runOne, inputsOf, call, noUnscripted } from "./harness.mjs";

const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };
const P = "m-agahi/ccpm";
const YQ = { ...ARGS, input: "#622", project: P, confirm: "ask" };
const written = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
const read = (over) => (p) => ({
  status: "ok",
  reason: "read",
  results: inputsOf(p).tasks.map((t) => Object.assign({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false }, over || {})),
});
// happy plus the auto-gate stubs (local: harness.mjs exports no such helper)
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
async function build(rd, buildOver) {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, YQ);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:yaadgaar-read"] = rd;
  s["infra:yaadgaar-writeback"] = written;
  if (buildOver && buildOver.confirm === "auto") {
    s["intake:rulings"] = { status: "ok", reason: "re-read", brief: YBRIEF, tried: [{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: null }] };
    s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
    s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
    s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  }
  return runOne(s, Object.assign({ mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: P }, buildOver || {}));
}

test("7.0.0 AC2: a yaadgaar task on a non-yadgarhq/ project is written back through the yaadgaar steps", async () => {
  const out = await build(read());
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /^infra:ledger-/.test(l)), out.labels.join(", "));
  assert.ok(out.labels.indexOf("infra:yaadgaar-read") >= 0 && out.labels.indexOf("infra:yaadgaar-read") < out.labels.indexOf("infra:yaadgaar-writeback"));
  const i = inputsOf(call(out, "infra:yaadgaar-writeback").prompt);
  assert.equal(i.project, P);
  assert.deepEqual(i.tasks, [{ key: "s0", id: YURN, number: 622, version: 3 }]);
  assert.equal(call(out, "infra:yaadgaar-read").opts.agentType, "fleet:judge");
  assert.equal(out.result.ledger_adapter, "yaadgaar");
  assert.equal(out.result.ledger_status, "ok");
  assert.deepEqual(out.result.write_back.ledger.map((e) => [e.ref, e.status]), [["yaadgaar #622", "written"]]);
});

test("7.0.0 AC2: a read answer naming another project is refused; nothing is edited", async () => {
  const out = await build(read({ project: "o/other" }));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("infra:yaadgaar-writeback"));
  const e = out.result.write_back.ledger[0];
  assert.equal(e.ref, "yaadgaar #622");
  assert.equal(e.status, "failed");
  assert.match(e.reason, /"o\/other", not args\.project m-agahi\/ccpm/);
  assert.match(e.section_text, /fleet:y622/);
});

test("7.0.0 AC2: confirm auto re-reads the yaadgaar task on a non-yadgarhq/ project and hands it to the intent judge", async () => {
  const out = await build(read(), { confirm: "auto" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const rr = inputsOf(call(out, "intake:rulings").prompt);
  assert.equal(rr.input, "yaadgaar #622");
  assert.equal(rr.ledger, "yaadgaar");
  assert.equal(inputsOf(call(out, "role:fleet-intent-judge:rerun").prompt).ledger_task.ref, "622");
  assert.ok(out.labels.includes("infra:yaadgaar-writeback"));
});
