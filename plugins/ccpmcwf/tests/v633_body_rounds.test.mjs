// fleet 6.3.3 (ledger 2144), AC5: a pr-opener body update uses no code round.
// rounds.code after a body-only review equals its value before it, also when
// all 3 code rounds are already used.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, PB, happy, run } from "./harness.mjs";

const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };

function bodyReview(script) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  return Object.assign(F, {
    "role:pr-review:v1": { status: "ok", reason: "x", verdict: "changes_requested", findings: [BODY], touches_gate: false, checked: [] },
    "role:fleet-pr-opener:body-v1": OPEN7,
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
  }, script);
}

test("AC5 ex1: a body update after all 3 code rounds uses no code round", async () => {
  const fix = { status: "ok", reason: "x", verdict: "fix_code", routed_findings: [{ target: "code", criterion: "AC1", finding: "x" }], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 1 } };
  const script = {
    "role:fleet-code-judge:r1": fix,
    "role:fleet-code-judge:r2": fix,
    "role:fleet-code-judge:r3": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
  };
  for (const m of [2, 3]) {
    script["role:fleet-coder:r" + m] = { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } };
    script["hasher:post-coder:r" + m] = { status: "ok", fingerprint: { head: PB, tree: "K" + m }, hashes: HASHES };
    script["hasher:fp-post:code-judge:r" + m] = { status: "ok", fingerprint: { head: PB, tree: "K" + m } };
  }
  const out = await run(bodyReview(script), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 3);
  assert.ok(out.labels.includes("role:fleet-pr-opener:body-v1"), out.labels.join(", "));
  assert.ok(out.labels.includes("role:pr-review:v2"));
  assert.ok(!out.labels.includes("role:fleet-coder:r4"));
  assert.ok(!String(out.result.reason).includes("code rounds exhausted"));
});

test("AC5 ex2: a body update after one code round keeps rounds.code at 1", async () => {
  const out = await run(bodyReview({}), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 1);
  assert.ok(out.labels.includes("role:fleet-pr-opener:body-v1"));
});
