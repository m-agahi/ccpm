// fleet 8.5.0 AC9 (yaadgaar #105): the intake:rulings re-read (build mode, confirm auto)
// checks the intake relay like plan-mode intake: a delegation passes with a gate line
// (and an auto_decisions entry when unattended); a missing or malformed relay halts with
// relaunch on any status; a request halts with relaunch.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, PB, FP_PLAN, happy, runOne, inputsOf } from "./harness.mjs";

const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };
const P = "m-agahi/ccpm";
const YQ = { ...ARGS, input: "#622", project: P, confirm: "ask" };
const TRIED = [{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: null }];
const PREFIX = "intake:rulings: missing or malformed relay field";
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
// plan run (confirm ask), then a build run with the intake:rulings stub `rs`
async function build(rs, buildOver) {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, YQ);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:yaadgaar-read"] = read;
  s["infra:yaadgaar-writeback"] = written;
  s["intake:rulings"] = rs;
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
  s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  return runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: P, ...buildOver });
}
const RS = (relay) => ({ status: "ok", reason: "re-read", brief: YBRIEF, tried: TRIED, relay });
const RAW = (extra) => ({ status: "ok", reason: "re-read", brief: YBRIEF, tried: TRIED, __raw: true, ...extra });

function assertRelaunch(out) {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "relaunch");
  assert.equal(out.result.relaunch, "intake");
  assert.ok(!out.labels.includes("role:fleet-intent-judge:rerun"), out.labels.join(", "));
}

test("AC9: a delegation passes the rulings re-read under confirm auto, with a gate line", async () => {
  // AC9: relay delegation "run the loop" passes
  const out = await build(RS({ kind: "delegation", text: "run the loop" }), { confirm: "auto" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-intent-judge:rerun"), out.labels.join(", "));
  assert.ok(out.result.gate_log.includes("intake:rulings: relayed message passes as a general delegation (confirm auto): run the loop"), JSON.stringify(out.result.gate_log));
});

test("AC9: triangulation: another delegation text is echoed in the gate line", async () => {
  // AC9: the gate line carries the relayed text, not a constant
  const out = await build(RS({ kind: "delegation", text: "go ahead" }), { confirm: "auto" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.includes("intake:rulings: relayed message passes as a general delegation (confirm auto): go ahead"), JSON.stringify(out.result.gate_log));
});

test("AC9: an unattended delegation pass also records an auto_decisions entry", async () => {
  // AC9: unattended auto run records {gate: relaunch, decision: pass}
  const out = await build(RS({ kind: "delegation", text: "run the loop" }), { confirm: "auto", unattended: true });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(
    out.result.auto_decisions.filter((d) => d.gate === "relaunch"),
    [{ gate: "relaunch", decision: "pass", reason: "general delegation: run the loop" }],
  );
});

test("AC9: triangulation: another unattended delegation text reaches the auto_decisions reason", async () => {
  // AC9: the reason carries the relayed text
  const out = await build(RS({ kind: "delegation", text: "go ahead" }), { confirm: "auto", unattended: true });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(
    out.result.auto_decisions.filter((d) => d.gate === "relaunch"),
    [{ gate: "relaunch", decision: "pass", reason: "general delegation: go ahead" }],
  );
});

test("AC9: an ok answer with no relay field halts with relaunch", async () => {
  // AC9: missing relay, ok status
  const out = await build(RAW(), { confirm: "auto" });
  assertRelaunch(out);
  assert.ok(out.result.reason.startsWith(PREFIX), out.result.reason);
});

test("AC9: a relay with an unknown kind halts with relaunch", async () => {
  // AC9: relay {kind: other}
  const out = await build(RS({ kind: "other", text: "x" }), { confirm: "auto" });
  assertRelaunch(out);
  assert.ok(out.result.reason.startsWith(PREFIX), out.result.reason);
});

test("AC9: triangulation: a string relay halts with relaunch", async () => {
  // AC9: malformed relay (not an object)
  const out = await build(RS("delegation"), { confirm: "auto" });
  assertRelaunch(out);
  assert.ok(out.result.reason.startsWith(PREFIX), out.result.reason);
});

test("AC9: a needs_human answer with no relay halts with the relay reason", async () => {
  // AC9: missing relay on a non-ok status
  const out = await build({ status: "needs_human", reason: "task not found", tried: [], __raw: true }, { confirm: "auto" });
  assertRelaunch(out);
  assert.ok(out.result.reason.startsWith(PREFIX), out.result.reason);
});

test("AC9: a relayed request halts with relaunch", async () => {
  // AC9: kind request
  const out = await build(RS({ kind: "request", text: "fix the login page" }), { confirm: "auto" });
  assertRelaunch(out);
  assert.ok(out.result.reason.startsWith("intake:rulings: relayed message is a request, not the build input: fix the login page"), out.result.reason);
});

test("AC9: triangulation: another relayed request text reaches the halt reason", async () => {
  // AC9: the reason carries the relayed text
  const out = await build(RS({ kind: "request", text: "do task 140 instead" }), { confirm: "auto" });
  assertRelaunch(out);
  assert.ok(out.result.reason.startsWith("intake:rulings: relayed message is a request, not the build input: do task 140 instead"), out.result.reason);
});
