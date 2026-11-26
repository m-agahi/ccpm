// fleet 8.9.9 (yaadgaar #122): a blocking review finding of category
// pr_body_format (the PR body breaks a rule the repo checks or documents for
// it: its template, body convention, an obligation or a CI check that reads
// the body) goes to the pr-opener as body_findings, as a pr_body_claim finding
// does; it never goes to the coder, who cannot edit a PR. The incident:
// yadgarhq/iam-db#195 (8.9.6 run wf_29ad47bb-640), where R1 ("## Breaking?"
// must open with "no" alone) went "-> coder (fix_code)" and the run stopped.
// A pr_body_format finding whose file is one of the program-listed changed
// paths is a code finding and goes to the coder (only moves toward the coder).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf, noUnscripted } from "./harness.mjs";

// the #195 shape: category pr_body_format, no file, target code
const FMT = {
  id: "R1",
  severity: "blocking",
  category: "pr_body_format",
  file: null,
  line: null,
  summary: "The PR body's ## Breaking? section opens with 'no. The change adds two RPCs' instead of 'no' alone on its first line",
  evidence: "check run 'ci / template' at head_sha has conclusion=failure",
  target: "code",
  // 8.9.15 (#131): the body route needs a program fact; this quote is in the body (the harness's body read)
  body_quote: "no. The change adds two RPCs",
};
const TNIT = { id: "R2", severity: "nit", category: "other", file: null, line: null, summary: "the PR title is cut off mid-word", evidence: "gh pr view 195", target: "code" };
const CODE = { id: "R3", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const APPROVE = { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] };
const CODER2 = { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } };
const JUDGE2 = { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };

function fixture(script) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  F["infra:review-paths:v2"] = { status: "ok", reason: "listed", changed_paths: ["src/x.py"] };
  F["hasher:pre-review:v2"] = rs;
  F["hasher:fp-post:pr-review:v2"] = rs;
  F["infra:review-cleanup:v2"] = { status: "ok", reason: "clean" };
  return Object.assign(F, script);
}
// the coder round, its commit and push, then the p2 pr-opener and the v2 review
const CODE_ROUND = {
  "role:fleet-coder:r2": CODER2,
  "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
  "role:fleet-code-judge:r2": JUDGE2,
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
  "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
  "role:fleet-pr-opener:p2": OPEN7,
  "role:pr-review:v2": APPROVE,
};
const idx = (out, l) => {
  const i = out.labels.indexOf(l);
  assert.ok(i >= 0, "label " + l + " in " + out.labels.join(", "));
  return i;
};

test("8.9.9 #122 ex1 (#195 shape): one blocking pr_body_format finding gets a pr-opener body update and a re-review; no coder round", async () => {
  const F = fixture({ "role:pr-review:v1": REV("changes_requested", [FMT, TNIT]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "role:fleet-pr-opener:body-v1").length, 1);
  const bi = inputsOf(call(out, "role:fleet-pr-opener:body-v1").prompt);
  assert.deepEqual(bi.body_findings, [FMT]);
  assert.deepEqual(bi.review_notes, [TNIT]);
  assert.ok(idx(out, "role:fleet-pr-opener:body-v1") < idx(out, "role:pr-review:v2"));
  for (const l of ["role:fleet-coder:r2", "role:fleet-code-judge:r2", "infra:commit:r2", "infra:push:p2"]) assert.ok(!out.labels.includes(l), l);
  assert.ok(!out.result.gate_log.some((l) => /-> coder \(fix_code\)/.test(l)), out.result.gate_log.join("\n"));
  assert.equal(out.result.rounds.code, 1);
  assert.equal(out.result.review.rounds, 2);
  noUnscripted(out);
});

test("8.9.9 #122 ex2: a mixed code + pr_body_format review: the coder gets the code finding only; the p2 pr-opener fixes the body", async () => {
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [FMT, CODE]) }, CODE_ROUND)), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [
    { target: "code", criterion: null, finding: "review R3 [correctness] src/x.py:3: empty input passes (evidence: ran x)" },
  ]);
  assert.ok(!call(out, "role:fleet-coder:r2").prompt.includes("Breaking?"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, [FMT]);
  const order = ["role:fleet-code-judge:r2", "infra:commit:r2", "infra:push:p2", "role:fleet-pr-opener:p2", "role:pr-review:v2"].map((l) => idx(out, l));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-pr-opener:body-v")));
  assert.equal(out.result.rounds.code, 2);
});

// 8.9.9 review of a175cf9 (M1): the body route takes a pr_body_format finding only with no file
// (null or absent); any file, a changed path or not, in any spelling, goes to the coder
for (const file of ["src/x.py", "lib/caller.py", "/src/x.py", "src//x.py", "SRC/x.py", "src/x.py:3", "PR body"]) {
  test("8.9.9 #122 ex3: a pr_body_format finding with file " + JSON.stringify(file) + " is a code finding and goes to the coder", async () => {
    const MIS = Object.assign({}, FMT, { file, line: 3 });
    const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [MIS]) }, CODE_ROUND)), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    const rf = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
    assert.equal(rf.length, 1);
    assert.ok(rf[0].finding.startsWith("review R1 [pr_body_format] " + file + ":3: "), rf[0].finding);
    assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-pr-opener:body-v")));
    assert.equal(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, undefined);
  });
}

test("8.9.9 #122 ex3b: a pr_body_format finding with no file key at all takes the body route", async () => {
  const NOFILE = Object.assign({}, FMT);
  delete NOFILE.file;
  const F = fixture({ "role:pr-review:v1": REV("changes_requested", [NOFILE]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:body-v1").prompt).body_findings, [NOFILE]);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("8.9.9 #122 ex4: a pr_body_format finding still flagged after the one body update stops at the review", async () => {
  const F = fixture({ "role:pr-review:v1": REV("changes_requested", [FMT]), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": REV("changes_requested", [FMT]) });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "review");
  assert.match(out.result.reason, /PR body finding still flagged after one body update/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

// 8.9.9 review of a175cf9 (B1): a [pr_body_format] finding reaches the code judge only when the
// script routed it to the coder; the judge guard must not flip that fix_code to approve
test("8.9.9 #122 ex5: a pr_body_format finding routed to the coder and quoted by a judge fix_code gets another coder round", async () => {
  const MIS = Object.assign({}, FMT, { file: "src/x.py", line: 3 });
  const TAGF = { target: "code", criterion: null, finding: "review R1 [pr_body_format] src/x.py:3: " + FMT.summary + " (evidence: " + FMT.evidence + ")" };
  const script = Object.assign({ "role:pr-review:v1": REV("changes_requested", [MIS]) }, CODE_ROUND, {
    "role:fleet-code-judge:r2": { status: "ok", reason: "not fixed", verdict: "fix_code", routed_findings: [TAGF], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
    "role:fleet-coder:r3": CODER2,
    "hasher:post-coder:r3": { status: "ok", fingerprint: { head: CSHA(1), tree: "K3" }, hashes: HASHES },
    "role:fleet-code-judge:r3": JUDGE2,
    "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: { head: CSHA(1), tree: "K3" } },
  });
  const out = await run(fixture(script), ARGS);
  assert.ok(!out.result.gate_log.some((l) => /fix_code -> approve/.test(l)), out.result.gate_log.join("\n"));
  assert.ok(out.labels.includes("role:fleet-coder:r3"), out.labels.join(", "));
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r3").prompt).routed_findings, [TAGF]);
  assert.equal(out.result.status, "ok", out.result.reason);
});
