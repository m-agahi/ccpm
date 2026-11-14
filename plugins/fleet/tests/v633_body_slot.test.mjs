// fleet 6.3.3 (ledger 2144), AC9: own slot. A body-only re-review does not use
// a MAX_REVIEWS slot on the normal path: a run with one body re-review can
// still get one code fix round from a later review, and a body-only review 2
// still gets its body update.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf } from "./harness.mjs";

const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const CODE2 = { id: "R5", severity: "blocking", category: "correctness", file: "src/x.py", line: 7, summary: "still wrong", evidence: "e" };
const REV = (fs) => ({ status: "ok", reason: "x", verdict: "changes_requested", findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const APPROVE = { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] };

function fixture(script) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  for (let k = 2; k <= 3; k++) {
    F["infra:review-paths:v" + k] = { status: "ok", reason: "listed", changed_paths: ["src/x.py"] };
    F["hasher:pre-review:v" + k] = rs;
    F["hasher:fp-post:pr-review:v" + k] = rs;
    F["infra:review-cleanup:v" + k] = { status: "ok", reason: "clean" };
  }
  return Object.assign(
    F,
    {
      "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
      "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
      "role:fleet-pr-opener:p2": OPEN7,
      "role:fleet-pr-opener:body-v1": OPEN7,
      "role:pr-review:v1": REV([BODY]),
      "role:pr-review:v2": REV([CODE]),
      "role:pr-review:v3": APPROVE,
    },
    script,
  );
}

test("AC9 ex1: body re-review, then a code fix round from review 2, then review 3", async () => {
  const out = await run(fixture({}), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:fleet-pr-opener:body-v1", "role:fleet-coder:r2", "infra:push:p2", "role:pr-review:v3"]) assert.ok(out.labels.includes(l), l);
  assert.equal(out.result.review.rounds, 3);
  assert.equal(out.result.rounds.code, 2);
});

test("AC9 ex2: a body-only review 2 still gets its body update", async () => {
  const F = fixture({ "role:pr-review:v1": REV([CODE]), "role:pr-review:v2": REV([BODY]), "role:fleet-pr-opener:body-v2": OPEN7 });
  delete F["role:fleet-pr-opener:body-v1"];
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-pr-opener:body-v2"), out.labels.join(", "));
  assert.ok(out.labels.includes("role:pr-review:v3"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:body-v2").prompt).body_findings, [BODY]);
  assert.ok(!String(out.result.reason).includes("requested changes again"));
});

test("AC9 ex3: a code finding in review 3 after one body re-review hits the review cap", async () => {
  const out = await run(fixture({ "role:pr-review:v3": REV([CODE2]) }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.ok(out.result.reason.includes("review round 3 requested changes again"), out.result.reason);
  assert.ok(out.result.reason.includes("still wrong"), out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r3"));
});
