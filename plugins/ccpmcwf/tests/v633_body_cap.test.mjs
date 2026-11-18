// fleet 6.3.3 (ledger 2144), AC4: the body cap. After one pr-opener body
// update in the run (the body-only branch, or a PR step that carried pending
// body findings from a mixed review), a later normal-path review with any
// blocking pr_body_claim finding stops needs_human at the review gate. One body
// update per RUN, not per review round (declared deviation from brief B4).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, inputsOf } from "./harness.mjs";

const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
const BODY2 = { id: "R4", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says no weakening", evidence: "none" };
const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const REV = (fs) => ({ status: "ok", reason: "x", verdict: "changes_requested", findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const CAP = "PR body claim still flagged after one body update";

function fixture(script) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  for (let k = 2; k <= 3; k++) {
    F["infra:review-paths:v" + k] = { status: "ok", reason: "listed", changed_paths: ["src/x.py"] };
    F["hasher:pre-review:v" + k] = rs;
    F["hasher:fp-post:pr-review:v" + k] = rs;
    F["infra:review-cleanup:v" + k] = { status: "ok", reason: "clean" };
  }
  return Object.assign(F, script);
}
const ROUND2 = {
  "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
  "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
  "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
  "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
  "role:fleet-pr-opener:p2": OPEN7,
};
function capStop(out, summary) {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.ok(out.result.reason.includes(CAP), out.result.reason);
  assert.ok(out.result.reason.includes(summary), out.result.reason);
}

test("AC4 ex1: the same body finding after one body update stops needs_human", async () => {
  const out = await run(fixture({ "role:pr-review:v1": REV([BODY]), "role:pr-review:v2": REV([BODY]), "role:fleet-pr-opener:body-v1": OPEN7 }), ARGS);
  capStop(out, "body says 147 passed; the suite gives 133");
  assert.ok(out.labels.includes("role:fleet-pr-opener:body-v1"));
  assert.ok(!out.labels.includes("role:fleet-pr-opener:body-v2"));
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("AC4 ex2: any other body finding after one body update stops too", async () => {
  const out = await run(fixture({ "role:pr-review:v1": REV([BODY]), "role:pr-review:v2": REV([BODY2]), "role:fleet-pr-opener:body-v1": OPEN7 }), ARGS);
  capStop(out, "body says no weakening");
  assert.ok(!out.labels.includes("role:fleet-pr-opener:body-v2"));
});

test("AC4 ex3: a body finding with a code finding after one body update stops; no coder round", async () => {
  const out = await run(fixture({ "role:pr-review:v1": REV([BODY]), "role:pr-review:v2": REV([BODY, CODE]), "role:fleet-pr-opener:body-v1": OPEN7 }), ARGS);
  capStop(out, "body says 147 passed; the suite gives 133");
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("AC4 ex4: a mixed review first, then a body finding stops", async () => {
  const out = await run(fixture(Object.assign({}, ROUND2, { "role:pr-review:v1": REV([BODY, CODE]), "role:pr-review:v2": REV([BODY]) })), ARGS);
  capStop(out, "body says 147 passed; the suite gives 133");
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-pr-opener:body-v")));
  assert.ok(!out.labels.includes("role:fleet-coder:r3"));
});

test("AC4 ex5: one body update per run, not per review round", async () => {
  const out = await run(
    fixture(Object.assign({}, ROUND2, { "role:pr-review:v1": REV([BODY]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": REV([CODE]), "role:pr-review:v3": REV([BODY]) })),
    ARGS,
  );
  capStop(out, "body says 147 passed; the suite gives 133");
  assert.ok(!out.labels.includes("role:fleet-pr-opener:body-v3"));
  assert.ok(!out.labels.includes("role:fleet-coder:r3"));
});
