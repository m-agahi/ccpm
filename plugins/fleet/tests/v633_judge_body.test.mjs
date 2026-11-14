// fleet 6.3.3 (ledger 2144), AC3: the code-judge guard. A fleet-code-judge
// fix_code whose routed findings include a tagged finding (target code,
// criterion null or absent, a string that starts with "review " and contains
// " [pr_body_claim] ") drops the tagged findings; with no other finding left
// and a passing suite (exit_code the number 0, failed and errors absent, null
// or 0) the verdict becomes approve; other findings go to the next coder round.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, PB, CSHA, happy, run, call, inputsOf } from "./harness.mjs";

const TAGF = { target: "code", criterion: null, finding: "review R1 [pr_body_claim] PR body: body says 147 passed; the suite gives 133 (evidence: npm test: 133 pass)" };
const judge = (findings, suite) => ({ status: "ok", reason: "good", verdict: "fix_code", routed_findings: findings, hash_check: { match: true, mismatched: [] }, suite_result: suite });
const CODER2 = { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } };
const APPROVE2 = { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };

test("AC3 ex1: tagged-only fix_code with a passing suite becomes approve", async () => {
  const F = happy({ script: { "role:fleet-code-judge:r1": judge([TAGF], { command: "pytest", exit_code: 0 }) } });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.ok(out.labels.includes("infra:commit:r1"));
  assert.equal(out.result.rounds.code, 1);
});

test("AC3 ex2: a mixed list keeps only the other findings for the next coder round", async () => {
  const OTHER = { target: "code", criterion: "AC1", finding: "x is wrong" };
  const F = happy({
    script: {
      "role:fleet-code-judge:r1": judge([TAGF, OTHER], { command: "pytest", exit_code: 0 }),
      "role:fleet-coder:r2": CODER2,
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: PB, tree: "K2" }, hashes: HASHES },
      "role:fleet-code-judge:r2": APPROVE2,
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: PB, tree: "K2" } },
    },
  });
  const out = await run(F, ARGS);
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [OTHER]);
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC3 ex3: failed 0 and errors 0 count as passing", async () => {
  const F = happy({ script: { "role:fleet-code-judge:r1": judge([TAGF], { command: "pytest", exit_code: 0, failed: 0, errors: 0 }) } });
  const out = await run(F, ARGS);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.ok(out.labels.includes("infra:commit:r1"));
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC3 ex4: failed and errors null, criterion key absent", async () => {
  const t = { target: "code", finding: TAGF.finding };
  const F = happy({ script: { "role:fleet-code-judge:r1": judge([t], { command: "pytest", exit_code: 0, failed: null, errors: null }) } });
  const out = await run(F, ARGS);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.ok(out.labels.includes("infra:commit:r1"));
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC3 ex5: on the mixed review path a tagged-only judge fix_code in round 2 becomes approve", async () => {
  const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
  const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  Object.assign(F, {
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:pr-review:v1": { status: "ok", reason: "x", verdict: "changes_requested", findings: [BODY, CODE], touches_gate: false, checked: [] },
    "role:fleet-coder:r2": CODER2,
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": judge([TAGF], { command: "pytest", exit_code: 0 }),
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
    "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
    "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
  });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r3"));
  assert.ok(out.labels.includes("infra:commit:r2"));
  assert.ok(out.labels.includes("infra:push:p2"));
  assert.equal(out.result.rounds.code, 2);
});
