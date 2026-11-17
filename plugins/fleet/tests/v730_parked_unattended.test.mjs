// fleet 7.3.0 (#53, L2188; Max ruled "Decide + log") A26: under unattended an
// unreadable parked prior is decided by the run, not asked, when plan-audit
// and the intent judge both pass; the decision is recorded in auto_decisions.
// A refusing intent judge still stops. Without unattended nothing changes.
//
// dont_care: the wording of the decision reason after its first words; the
// order of unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, happy, runOne, inputsOf } from "./harness.mjs";

const PRUN = "n0-1234567";
// a parked prior whose findings are not JSON: unreadable (fail closed)
const unreadable = (prompt) => {
  const i = inputsOf(prompt);
  return { status: "ok", reason: "read", parked: { run: PRUN, plan_path: "docs/plans/x.md", draft_chunks: ["# draft plan\n"], findings_chunks: ["{not json"] }, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
};
function gated(verdict = "approve") {
  const s = happy();
  Object.assign(s, {
    "infra:load-parked": unreadable,
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "judged", verdict, deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return s;
}
const U = { ...ARGS, unattended: true };

test("7.3.0 #53 A26: unattended decides an unreadable parked prior when plan-audit and the intent judge pass, and logs it", async () => {
  const out = await runOne(gated(), U);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-intent-judge"));
  assert.ok(!out.logs.some((l) => /^unattended: asking Max/.test(l)), out.logs.filter((l) => /unattended/.test(l)).join("\n"));
  const d = out.result.auto_decisions.filter((x) => x.gate === "default-blocker" && x.decision === "decided" && /^parked prior unreadable \(fail closed\)/.test(x.reason));
  assert.equal(d.length, 1, JSON.stringify(out.result.auto_decisions));
  assert.match(d[0].reason, /plan-audit passed; the intent judge rules on it/);
});

test("7.3.0 #53 A26: unattended with a refusing intent judge stops; nothing is built", async () => {
  const out = await runOne(gated("refuse"), U);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.failed_check, "intent");
  assert.ok(!out.labels.some((l) => /^role:fleet-(test-writer|coder)/.test(l)), out.labels.join(", "));
});

test("7.3.0 #53 A26: without unattended, confirm auto still fails closed on an unreadable parked prior", async () => {
  const out = await runOne(gated(), { ...ARGS, confirm: "auto" });
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.failed_check, "intent");
  assert.match(out.result.reason, /parked prior unreadable \(fail closed\)/);
  assert.ok(!out.labels.includes("role:fleet-intent-judge"));
});
