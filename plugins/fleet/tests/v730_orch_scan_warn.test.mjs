// fleet 7.3.0 (#32, L2139) A18, A19: an orch_scan error gets one retry. A
// clean retry is used and leaves no warning. An error on the retry too: the
// PR is still marked ready (no draft is kept for an error), nothing merges,
// no CI rerun runs, result.warnings holds the error, and the script-written
// test block in the PR body names the error and the next step.
//
// dont_care: the gate line wording.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf } from "./harness.mjs";

const CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "auto", update_branch: "never", ci_trigger: true, review_post: "none" };
const pol = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args });
const ERR = (msg) => (p) => ({ status: "ok", reason: "s", orchestrator: true, iac_repo: true, apply_on_merge: true, hook_surface_pr: true, reasons: [], error: msg, args: inputsOf(p).args });
const CLEAN = (p) => ({ status: "ok", reason: "s", orchestrator: false, iac_repo: false, apply_on_merge: false, hook_surface_pr: false, reasons: [], error: null, args: inputsOf(p).args });
const RED = (p) => {
  const a = inputsOf(p).args;
  const u = "https://github.com/o/r/actions/runs/77/job/88";
  return { status: "ok", reason: "w", state: "red", checks: [{ name: "test", state: "FAILURE", bucket: "fail", url: u }], failed: [{ name: "test", url: u, run_id: "77", verified: true }], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
};
const blockText = (out, label) => Buffer.from(inputsOf(out.build.calls.find((c) => c.label === label).prompt).args[3], "base64").toString("utf8");

test("7.3.0 A18: an orch_scan error once, then a clean retry: the clean result is used, no warning", async () => {
  const s = happy();
  s["infra:policy"] = pol;
  s["infra:orch-scan"] = ERR("gh pr view: HTTP 502");
  s["infra:orch-scan:retry"] = CLEAN;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.warnings, []);
  const L = out.build.labels;
  assert.ok(L.indexOf("infra:orch-scan") < L.indexOf("infra:orch-scan:retry") && L.indexOf("infra:orch-scan:retry") < L.indexOf("infra:pr-ready"), L.join(", "));
  // the clean scan lets the clean personal repo merge
  assert.ok(L.includes("infra:pr-merge"), L.join(", "));
  assert.ok(!L.includes("infra:pr-tests:scan-warning"), L.join(", "));
});

test("7.3.0 A19: \"truncated tree\" twice: ready, no merge, no rerun, a warning in the result and the test block", async () => {
  for (const watch of [null, RED]) {
    const s = happy();
    s["infra:policy"] = pol;
    s["infra:orch-scan"] = ERR("truncated tree");
    s["infra:orch-scan:retry"] = ERR("truncated tree");
    if (watch) {
      s["infra:ci-watch:w1"] = watch;
      s["role:fleet-ci-classifier:w1"] = { status: "ok", reason: "c", checks: [{ name: "test", cause: "flaky" }] };
    }
    const out = await run(s, ARGS);
    const L = out.build.labels;
    assert.ok(L.includes("infra:pr-ready"), L.join(", "));
    assert.ok(!L.some((l) => /^infra:(pr-merge|ci-rerun)/.test(l)), L.join(", "));
    assert.equal(out.result.warnings.length, 1, JSON.stringify(out.result.warnings));
    assert.equal(out.result.warnings[0].gate, "orch_scan");
    assert.match(out.result.warnings[0].error, /truncated tree/);
    const tb = blockText(out, "infra:pr-tests:scan-warning");
    assert.match(tb, /Orchestrator\/IaC scan error: truncated tree\./);
    assert.match(tb, /Next step: /);
    // B4: never ok with no warning
    assert.ok(out.result.status !== "ok" || out.result.warnings.length === 1);
  }
});

test("7.3.0 A33: a merge-time scan that errors twice blocks the merge and leaves a warning", async () => {
  const s = happy();
  s["infra:policy"] = pol;
  s["infra:orch-scan:merge"] = ERR("gh api: HTTP 502");
  s["infra:orch-scan:merge:retry"] = ERR("gh api: HTTP 502");
  const out = await run(s, ARGS);
  const L = out.build.labels;
  assert.ok(L.includes("infra:orch-scan:merge:retry"), L.join(", "));
  assert.ok(!L.some((l) => /^infra:pr-merge/.test(l)), L.join(", "));
  assert.deepEqual(out.result.warnings, [{ gate: "orch_scan", error: "gh api: HTTP 502" }]);
  // the body line comes only from the ready scan
  assert.ok(!L.includes("infra:pr-tests:scan-warning"), L.join(", "));
});
