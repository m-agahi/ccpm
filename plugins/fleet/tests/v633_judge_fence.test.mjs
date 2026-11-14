// fleet 6.3.3 (ledger 2144), AC7 (guards existing): the code-judge guard's
// fences. A fleet-code-judge fix_code stays fix_code and starts the next coder
// round with the judge's findings when the routed findings are empty, when the
// only findings are tagged and the suite is failing or unmeasured, or when a
// finding is not in the exact tagged shape.
// Spec (plugins/fleet/README.md step table row 12): `fix_code` -> coder
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, PB, happy, run, call, inputsOf } from "./harness.mjs";

const TAGF = { target: "code", criterion: null, finding: "review R1 [pr_body_claim] PR body: body says 147 passed; the suite gives 133 (evidence: npm test: 133 pass)" };

function fixture(findings, suite) {
  return happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", reason: "x", verdict: "fix_code", routed_findings: findings, hash_check: { match: true, mismatched: [] }, suite_result: suite },
      "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
      "hasher:post-coder:r2": { status: "ok", fingerprint: { head: PB, tree: "K2" }, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: PB, tree: "K2" } },
    },
  });
}
async function coderGets(findings, suite) {
  const out = await run(fixture(findings, suite), ARGS);
  assert.ok(out.labels.includes("role:fleet-coder:r2"), out.labels.join(", ") + " / " + out.result.reason);
  return inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
}

test("AC7 ex1: an empty fix_code still starts a coder round", async () => {
  assert.deepEqual(await coderGets([], { command: "pytest", exit_code: 0 }), []);
});

test("AC7 ex2: a tagged-only fix_code with a failing suite stays fix_code", async () => {
  assert.deepEqual(await coderGets([TAGF], { command: "pytest", exit_code: 1, failed: 2, errors: 0 }), [TAGF]);
});

test("AC7 ex3: a suite with no exit_code is no evidence of a pass", async () => {
  assert.deepEqual(await coderGets([TAGF], { command: "pytest" }), [TAGF]);
});

test("AC7 ex4: a null exit_code is no evidence of a pass", async () => {
  assert.deepEqual(await coderGets([TAGF], { command: "pytest", exit_code: null }), [TAGF]);
});

test("AC7 ex5: errors above 0 count as failing", async () => {
  assert.deepEqual(await coderGets([TAGF], { command: "pytest", exit_code: 0, failed: 0, errors: 1 }), [TAGF]);
});

test("AC7 ex6: a tagged text with a criterion set is no tagged finding", async () => {
  const f = { target: "code", criterion: "AC2", finding: TAGF.finding };
  assert.deepEqual(await coderGets([f], { command: "pytest", exit_code: 0 }), [f]);
});

// security review (PR #69): the tag counts only in its fixed position, right after "review <id> "
test("security: a review finding of category other that quotes [pr_body_claim] in its summary stays fix_code", async () => {
  const f = { target: "code", criterion: null, finding: "review R2 [other] src/x.py:3: the guard matches [pr_body_claim] anywhere (evidence: e)" };
  assert.deepEqual(await coderGets([f], { command: "pytest", exit_code: 0 }), [f]);
});

test("AC7 ex7: a finding that does not start with 'review ' is no tagged finding", async () => {
  const f = { target: "code", criterion: null, finding: 'BODY_TAG must stay "[pr_body_claim]" in src/x.js' };
  assert.deepEqual(await coderGets([f], { command: "pytest", exit_code: 0 }), [f]);
});
