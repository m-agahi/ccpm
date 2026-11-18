// fleet 6.3.3 (ledger 2144), AC2: a mixed review (pr_body_claim findings and
// other blocking findings) sends only the other findings to the coder; after
// the code judge approves and the new commit is pushed, the PR step's
// pr-opener call carries body_findings and that review's nits; then the review
// runs again. No separate body-v<k> call runs.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf } from "./harness.mjs";

const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
const BODY2 = { id: "R4", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says no weakening", evidence: "none" };
const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const SEC = { id: "R3", severity: "blocking", category: "security", file: "src/y.py", line: 5, summary: "token logged", evidence: "grep log" };
const NIT = { id: "N1", severity: "nit", category: "style", file: "src/x.py", line: 2, summary: "nit text", evidence: "e" };
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };

function fixture(v1Findings) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  return Object.assign(F, {
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
    "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    "role:fleet-pr-opener:p2": OPEN7,
    "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
    "role:pr-review:v1": REV("changes_requested", v1Findings),
  });
}
const idx = (out, l) => {
  const i = out.labels.indexOf(l);
  assert.ok(i >= 0, "label " + l + " in " + out.labels.join(", "));
  return i;
};

test("AC2 ex1: the coder gets only the code finding; the p2 pr-opener call carries body_findings and the nits", async () => {
  const out = await run(fixture([BODY, CODE, NIT]), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [
    { target: "code", criterion: null, finding: "review R2 [correctness] src/x.py:3: empty input passes (evidence: ran x)" },
  ]);
  assert.ok(!call(out, "role:fleet-code-judge:r2").prompt.includes("147 passed"));
  const p2 = inputsOf(call(out, "role:fleet-pr-opener:p2").prompt);
  assert.deepEqual(p2.body_findings, [BODY]);
  assert.deepEqual(p2.review_notes, [NIT]);
  const order = ["role:fleet-code-judge:r2", "infra:commit:r2", "infra:push:p2", "role:fleet-pr-opener:p2", "role:pr-review:v2"].map((l) => idx(out, l));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-pr-opener:body-v")));
  assert.equal(out.result.rounds.code, 2);
});

test("AC2 ex2: two body findings and one code finding", async () => {
  const out = await run(fixture([BODY, BODY2, CODE]), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const rf = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(rf.length, 1);
  assert.equal(rf[0].finding, "review R2 [correctness] src/x.py:3: empty input passes (evidence: ran x)");
  const p2 = inputsOf(call(out, "role:fleet-pr-opener:p2").prompt);
  assert.deepEqual(p2.body_findings, [BODY, BODY2]);
  assert.deepEqual(p2.review_notes, []);
});

test("AC2 ex3: a security finding before the body finding", async () => {
  const out = await run(fixture([SEC, BODY]), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [
    { target: "code", criterion: null, finding: "review R3 [security] src/y.py:5: token logged (evidence: grep log)" },
  ]);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, [BODY]);
});
