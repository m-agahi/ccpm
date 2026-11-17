// fleet 7.3.0 (car-3 leftover of #32): the orch_scan warning text (state.scanWarn) is saved in
// the run-state as scan_warn, and a resumed run restores it, so the PR test block it writes or
// re-checks keeps the warning.
//
// dont_care: the other run-state keys; the gate line wording.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, happy, runOne, inputsOf, stateJsonOf } from "./harness.mjs";

// a scan that errors with no sign: the run ships with the warning
const ERR = (msg) => (p) => ({ status: "ok", reason: "s", orchestrator: false, iac_repo: false, apply_on_merge: false, hook_surface_pr: false, reasons: [], error: msg, args: inputsOf(p).args });
const WARN = "Orchestrator/IaC scan error: truncated tree. Next step: re-run the build with the same plan_ref (the scan runs again), or check the PR by hand before any merge.";

test("7.3.0 #32 leftover: the shipped run-state carries scan_warn; a resume restores it into the PR test block", async () => {
  const states = {};
  const s = happy();
  s["infra:orch-scan"] = ERR("truncated tree");
  s["infra:orch-scan:retry"] = ERR("truncated tree");
  for (const label of ["infra:state:pr_open:p1", "infra:state:shipped"]) {
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" };
  const first = await runOne(s, bargs);
  assert.ok(first.labels.includes("infra:pr-tests:scan-warning"), first.labels.join(", "));
  assert.equal(states.shipped.scan_warn, WARN);
  assert.equal(states.pr_open.scan_warn, null);
  // a resume at pr_open whose run-state carries the warning re-checks the block with it
  const x = Object.assign({}, states.pr_open, { scan_warn: WARN });
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
  const h = JSON.parse(JSON.stringify(HASHES));
  h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
  s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
  const out = await runOne(s, bargs);
  const c = out.calls.find((k) => k.label === "infra:pr-tests:resume");
  assert.ok(c, out.labels.join(", "));
  const tb = Buffer.from(inputsOf(c.prompt).args[3], "base64").toString("utf8");
  assert.ok(tb.includes(WARN), tb);
});
