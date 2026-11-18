// fleet 7.1.0 (L2145, yaadgaar #37), AC5 (resume path, ruling AC5 (a) "Re-check
// on resume"): a resumed run whose next step is review, writeback or stats and
// whose run-state names a PR runs infra:pr-tests:resume once at the start of
// shipSteps, before that step, with no rewrite. Its supplied review notes are
// the saved state.review.nits.
//
// Expected values come only from the plan's AC5 examples 17-21.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, happy, runOne, inputsOf, stateJsonOf, sha256 } from "./harness.mjs";

const RESUME = "infra:pr-tests:resume";
const URL7 = "https://github.com/o/r/pull/7";
const OPEN7 = { status: "ok", reason: "updated", pr_url: URL7, pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const tests = (claims) => (prompt) => {
  const a = inputsOf(prompt).args;
  const block = Buffer.from(a[3], "base64").toString("utf8");
  return { status: "ok", reason: "written", replaced: false, edited: true, block_sha256: sha256(block), claims, claims_truncated: false, body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: [], error: null, args: a };
};

// A first full build that records every run-state it writes (by last_gate);
// resume(gate) scripts the re-run from that run-state on the approved commit.
async function built(extra = {}) {
  const states = {};
  const s = Object.assign(happy(), extra);
  const orig = (label) => s[label];
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back", "infra:state:shipped"]) {
    const o = orig(label);
    s[label] = (prompt, opts) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      if (typeof o === "function") return o(prompt, opts);
      return o || { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" };
  const first = await runOne(s, bargs);
  assert.equal(first.result.status, "ok", first.result.reason);
  const resume = (gate) => {
    const x = states[gate];
    assert.ok(x, "the first build wrote the run-state " + gate);
    s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
    s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
    const h = JSON.parse(JSON.stringify(HASHES));
    h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
    s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
    return s;
  };
  return { s, states, bargs, resume };
}
const before = (out, a, b) => {
  const i = out.labels.indexOf(a);
  const j = out.labels.indexOf(b);
  assert.ok(i >= 0, a + " ran; labels: " + out.labels.join(", "));
  assert.ok(j >= 0, b + " ran; labels: " + out.labels.join(", "));
  assert.ok(i < j, a + " before " + b + "; labels: " + out.labels.join(", "));
};

test("AC5 ex17: a resume at pr_open runs infra:pr-tests:resume once, before the review", async () => {
  const { bargs, resume } = await built();
  const s = resume("pr_open");
  s[RESUME] = tests([]);
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === RESUME).length, 1);
  before(out, RESUME, "role:pr-review:v1");
});

test("AC5 ex18: an own claim on the resume check stops; no opener, no review", async () => {
  const { bargs, resume } = await built();
  const s = resume("pr_open");
  s[RESUME] = tests(["147 passed"]);
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "role");
  assert.equal(out.result.reason, 'infra:pr-tests:resume: the PR body still states test counts outside the script-written test block: "147 passed"; remove them from the body of ' + URL7 + " by hand, then re-run the build with the same plan_ref");
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-pr-opener") || l.startsWith("role:pr-review")), out.labels.join(", "));
});

test("AC5 ex19: a resume at reviewed: a claim inside a saved review nit is ignored", async () => {
  const nit = { id: "N1", severity: "nit", category: "docs", file: "a.py", line: 3, summary: "only 4 tests cover it", evidence: "a.py:3" };
  const { states, bargs, resume } = await built({ "role:pr-review:v1": { status: "ok", reason: "x", verdict: "approve", findings: [nit], touches_gate: false, checked: [] }, "role:fleet-pr-opener:notes": OPEN7 });
  assert.equal(states.reviewed.review.nits[0].summary, "only 4 tests cover it");
  const s = resume("reviewed");
  s[RESUME] = tests(["4 tests"]);
  const out = await runOne(s, bargs);
  before(out, RESUME, "infra:yaadgaar-read");
  assert.ok(out.logs.includes("infra:pr-tests:resume: ignored 1 claim(s) found in workflow-supplied text"), out.logs.join("\n"));
  assert.notEqual(out.result.stop_gate, "role", out.result.reason);
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC5 ex20: a resume at written_back runs the check before the stats step", async () => {
  const { bargs, resume } = await built();
  const s = resume("written_back");
  const out = await runOne(s, bargs);
  const firstStats = out.labels.find((l) => l.startsWith("infra:pr-stats"));
  assert.ok(firstStats, out.labels.join(", "));
  before(out, RESUME, firstStats);
});

test("AC5 ex21: a resume at pushed runs no resume check; the PR step's check runs", async () => {
  const { bargs, resume } = await built();
  const s = resume("pushed");
  const out = await runOne(s, bargs);
  assert.ok(!out.labels.includes(RESUME), out.labels.join(", "));
  before(out, "role:fleet-pr-opener", "infra:pr-tests");
});
