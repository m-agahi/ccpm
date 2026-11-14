// fleet 6.3.3 (ledger 2144), AC1: on the normal path a review whose blocking
// findings are all category pr_body_claim gets one pr-opener body update
// (label role:fleet-pr-opener:body-v<k>, input body_findings), then the review
// runs again; no coder, code judge, commit or push runs for it. Every later
// pr-opener call of the run (:notes and p<k>) carries the same body_findings.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf, noUnscripted } from "./harness.mjs";

const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
const BODY2 = { id: "R4", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says no weakening", evidence: "none" };
const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const NIT = { id: "N1", severity: "nit", category: "style", file: "src/x.py", line: 2, summary: "nit text", evidence: "e" };
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const APPROVE = { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] };

// happy() plus the review stubs for reviews 2..n
function fixture(script, n = 3) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  for (let k = 2; k <= n; k++) {
    F["infra:review-paths:v" + k] = { status: "ok", reason: "listed", changed_paths: ["src/x.py"] };
    F["hasher:pre-review:v" + k] = rs;
    F["hasher:fp-post:pr-review:v" + k] = rs;
    F["infra:review-cleanup:v" + k] = { status: "ok", reason: "clean" };
  }
  return Object.assign(F, script);
}
const idx = (out, l) => {
  const i = out.labels.indexOf(l);
  assert.ok(i >= 0, "label " + l + " in " + out.labels.join(", "));
  return i;
};

test("AC1 ex1: a body-only review gets one pr-opener body update and a re-review; no code round", async () => {
  const F = fixture({ "role:pr-review:v1": REV("changes_requested", [BODY, NIT]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }, 2);
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "role:fleet-pr-opener:body-v1").length, 1);
  const bi = inputsOf(call(out, "role:fleet-pr-opener:body-v1").prompt);
  assert.deepEqual(bi.body_findings, [BODY]);
  assert.deepEqual(bi.review_notes, [NIT]);
  assert.equal(bi.pr_number, 7);
  assert.ok(idx(out, "role:fleet-pr-opener:body-v1") < idx(out, "role:pr-review:v2"));
  for (const l of ["role:fleet-coder:r2", "role:fleet-code-judge:r2", "infra:commit:r2", "infra:push:p2"]) assert.ok(!out.labels.includes(l), l);
  assert.equal(out.result.rounds.code, 1);
  assert.equal(out.result.review.rounds, 2);
  noUnscripted(out);
});

test("AC1 ex2: two body findings go to one body update with no nits", async () => {
  const F = fixture({ "role:pr-review:v1": REV("changes_requested", [BODY, BODY2]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }, 2);
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "role:fleet-pr-opener:body-v1").length, 1);
  assert.ok(!out.labels.includes("role:fleet-pr-opener:body-v2"));
  const bi = inputsOf(call(out, "role:fleet-pr-opener:body-v1").prompt);
  assert.deepEqual(bi.body_findings, [BODY, BODY2]);
  assert.deepEqual(bi.review_notes, []);
  assert.equal(out.result.rounds.code, 1);
});

test("AC1 ex3: a blocking body finding counts whatever the verdict", async () => {
  const F = fixture({ "role:pr-review:v1": REV("approve", [BODY]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }, 2);
  const out = await run(F, ARGS);
  assert.ok(out.labels.includes("role:fleet-pr-opener:body-v1"), out.labels.join(", "));
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:body-v1").prompt).body_findings, [BODY]);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC1 ex4: the :notes pr-opener call carries the fixed body findings", async () => {
  const F = fixture(
    { "role:pr-review:v1": REV("changes_requested", [BODY]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": REV("approve", [NIT]), "role:fleet-pr-opener:notes": OPEN7 },
    2,
  );
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const ni = inputsOf(call(out, "role:fleet-pr-opener:notes").prompt);
  assert.deepEqual(ni.body_findings, [BODY]);
  assert.deepEqual(ni.review_notes, [NIT]);
  assert.ok(idx(out, "role:pr-review:v2") < idx(out, "role:fleet-pr-opener:notes"));
});

test("AC1 ex5: the p2 pr-opener call after a later code round carries the fixed body findings", async () => {
  const F = fixture({
    "role:pr-review:v1": REV("changes_requested", [BODY]),
    "role:fleet-pr-opener:body-v1": OPEN7,
    "role:pr-review:v2": REV("changes_requested", [CODE]),
    "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
    "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    "role:fleet-pr-opener:p2": OPEN7,
    "role:pr-review:v3": APPROVE,
  });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, [BODY]);
  const order = ["role:fleet-pr-opener:body-v1", "role:fleet-coder:r2", "infra:push:p2", "role:fleet-pr-opener:p2", "role:pr-review:v3"].map((l) => idx(out, l));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  assert.equal(out.result.rounds.code, 2);
});
