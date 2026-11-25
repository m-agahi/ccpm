// ccpmcwf 8.9.6 (yaadgaar #109): plan-mode intake relaunches on a relayed request at any
// status, as the intake:rulings re-read does. The RELAUNCH_REASON answer halts with relaunch
// at any status too. A general delegation still passes a delegated launch.
//
// Run: node --test plugins/*/tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, triedFor } from "./harness.mjs";

const TAIL = "; re-launch the workflow once in a turn whose latest human message is the build request";
const RELAUNCH = "relayed user request does not reference args.input";

function stub(it) {
  const s = happy();
  s.intake = it;
  return s;
}
function assertRelaunch(out) {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "relaunch");
  assert.equal(out.result.relaunch, "intake");
  assert.ok(!out.labels.includes("workspace"), "no workspace: " + out.labels.join(", "));
}

test("#109: needs_human with a non-RELAUNCH reason and a request relay halts with relaunch", async () => {
  const out = await runOne(stub({ status: "needs_human", reason: "cannot proceed", tried: [], relay: { kind: "request", text: "fix the login page" } }), ARGS);
  assertRelaunch(out);
  assert.equal(out.result.reason, "intake: relayed message is a request, not the build input: fix the login page" + TAIL);
});

test("#109: failed with a request relay halts with relaunch (unattended)", async () => {
  const out = await runOne(stub({ status: "failed", reason: "tool error", tried: [], relay: { kind: "request", text: "do task 140 instead" } }), { ...ARGS, unattended: true });
  assertRelaunch(out);
  assert.equal(out.result.reason, "intake: relayed message is a request, not the build input: do task 140 instead" + TAIL);
});

test("#109: ok with a request relay halts with relaunch", async () => {
  const out = await runOne(stub({ status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF), relay: { kind: "request", text: "fix the login page" } }), ARGS);
  assertRelaunch(out);
  assert.equal(out.result.reason, "intake: relayed message is a request, not the build input: fix the login page" + TAIL);
});

test("#109: a RELAUNCH_REASON answer at status failed halts with relaunch", async () => {
  const out = await runOne(stub({ status: "failed", reason: RELAUNCH + ": also fix the login page", tried: [], relay: { kind: "none", text: "" } }), ARGS);
  assertRelaunch(out);
  assert.equal(out.result.reason, "intake: " + RELAUNCH + ": also fix the login page" + TAIL);
});

test("#109: a RELAUNCH_REASON answer at status ok halts with relaunch", async () => {
  const out = await runOne(stub({ status: "ok", reason: RELAUNCH + ": do something else", brief: BRIEF, tried: triedFor(BRIEF), relay: { kind: "none", text: "" } }), ARGS);
  assertRelaunch(out);
  assert.equal(out.result.reason, "intake: " + RELAUNCH + ": do something else" + TAIL);
});

test("#109: needs_human with a delegation relay keeps the generic halt (no relaunch)", async () => {
  const out = await runOne(stub({ status: "needs_human", reason: "cannot proceed", tried: [], relay: { kind: "delegation", text: "run the loop" } }), { ...ARGS, unattended: true });
  assert.equal(out.result.status, "needs_human");
  assert.notEqual(out.result.stop_gate, "relaunch");
  assert.ok(out.result.reason.startsWith("intake needs_human: "), out.result.reason);
});

test("#109: a general delegation still passes an unattended launch and records one relaunch auto decision", async () => {
  const out = await runOne(stub({ status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF), relay: { kind: "delegation", text: "run the loop" } }), { ...ARGS, unattended: true });
  assert.ok(out.labels.includes("workspace"), out.labels.join(", "));
  assert.notEqual(out.result.stop_gate, "relaunch");
  assert.deepEqual(
    (out.result.auto_decisions || []).filter((d) => d.gate === "relaunch"),
    [{ gate: "relaunch", decision: "pass", reason: "general delegation: run the loop" }],
  );
});

test("#109 (review of #122): a task id with every ledger tried absent and a request relay halts with relaunch, ahead of the no-ledger stop", async () => {
  const s = happy();
  s.preflight = { ledger_tools: [] };
  s.intake = {
    status: "needs_human",
    reason: "no task ledger available; give a URL, Jira key or text",
    tried: [{ ledger: "yaadgaar", project: "o/r", call: "mcp__yaadgaar__read_task", error: "absent" }],
    relay: { kind: "request", text: "fix the login page" },
  };
  const out = await runOne(s, { ...ARGS, input: "123", project: "o/r", confirm: "ask" });
  assertRelaunch(out);
  assert.equal(out.result.reason, "intake: relayed message is a request, not the build input: fix the login page" + TAIL);
  assert.ok(!out.result.reason.includes("no task ledger available"), out.result.reason);
});
