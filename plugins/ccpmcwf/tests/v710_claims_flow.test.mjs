// fleet 7.1.0 (L2145, yaadgaar #37), AC5 (openPr path): a count phrase the
// program reports that is not inside a workflow-supplied string gets one
// checked pr-opener rewrite (role:fleet-pr-opener<sfx>:counts, then
// infra:pr-tests<sfx>:counts); a phrase still present stops needs_human with
// stop gate role and a literal reason. Supplied strings (ruling "Allow the
// filter"): tldr, criterion text, [manual] examples, review notes, intent
// reason and deviations, unattended section, gates_not_run. body_findings are
// not supplied strings.
//
// Expected values come only from the plan's AC5 examples 1-16.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, happy, run, call, inputsOf, stateJsonOf, sha256 } from "./harness.mjs";

const URL7 = "https://github.com/o/r/pull/7";
const OPEN7 = { status: "ok", reason: "updated", pr_url: URL7, pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const STILL = (label, claims) => label + ": the PR body still states test counts outside the script-written test block: " + claims + "; remove them from the body of " + URL7 + " by hand, then re-run the build with the same plan_ref";
const RETRY = (claims) => "the PR body states test counts outside the script-written test block: " + claims + "; write no test count anywhere in your text (the workflow writes the measured counts into its own block)";
const IGNORED = (label) => label + ": ignored 1 claim(s) found in workflow-supplied text";

// the program's relay: the block sent comes back as written, claims as given
const tests = (claims) => (prompt) => {
  const a = inputsOf(prompt).args;
  const block = Buffer.from(a[3], "base64").toString("utf8");
  return { status: "ok", reason: "written", replaced: false, edited: true, block_sha256: sha256(block), claims, claims_truncated: false, body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: [], error: null, args: a };
};
const planWith = (s, over) => (s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], over));
const counts = (out) => out.labels.filter((l) => l.endsWith(":counts"));
const ignored = (out, label) => assert.ok(out.logs.includes(IGNORED(label)), out.logs.join("\n"));
const stop = (out, reason) => {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "role");
  assert.equal(out.result.reason, reason);
};
// review v1 approves with nits: the notes opener runs
const withNotes = (s, nits) => Object.assign(s, { "role:pr-review:v1": REV("approve", nits), "role:fleet-pr-opener:notes": OPEN7 });
// review v1 asks for a body fix: body-v1 opener, then review v2
function withBodyFix(s, finding) {
  const rs = s["hasher:pre-review:v1"];
  return Object.assign(s, {
    "role:pr-review:v1": REV("changes_requested", [finding]),
    "role:fleet-pr-opener:body-v1": OPEN7,
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:pr-review:v2": REV("approve", []),
  });
}

test("AC5 ex1: an own claim gets one checked rewrite with the literal retry_reason", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:counts"] = OPEN7;
  s["infra:pr-tests:counts"] = tests([]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "role:fleet-pr-opener:counts").length, 1);
  const i = inputsOf(call(out, "role:fleet-pr-opener:counts").prompt);
  assert.equal(i.pr_url, URL7);
  assert.equal(i.pr_number, 7);
  assert.equal(i.retry_reason, RETRY('"147 passed"'));
  assert.ok(out.labels.indexOf("role:fleet-pr-opener:counts") < out.labels.indexOf("infra:pr-tests:counts"));
});

test("AC5 ex2: a claim still present after the rewrite stops needs_human, stop gate role", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:counts"] = OPEN7;
  s["infra:pr-tests:counts"] = tests(["147 passed"]);
  stop(await run(s, ARGS), STILL("infra:pr-tests:counts", '"147 passed"'));
});

test("AC5 ex3: no claims: no rewrite, the written gate line", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests([]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(counts(out), []);
  assert.ok(out.logs.includes("infra:pr-tests: test block written in " + URL7), out.logs.join("\n"));
});

test("AC5 ex4: two claims are quoted in order", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests(["147 passed", "12 tests"]);
  s["role:fleet-pr-opener:counts"] = OPEN7;
  s["infra:pr-tests:counts"] = tests([]);
  const out = await run(s, ARGS);
  assert.ok(inputsOf(call(out, "role:fleet-pr-opener:counts").prompt).retry_reason.includes('"147 passed", "12 tests"'));
});

test("AC5 ex5: a claim inside the plan tldr is ignored", async () => {
  const s = happy();
  planWith(s, { tldr: "Fixes the 3 failed retries" });
  s["infra:pr-tests"] = tests(["3 failed"]);
  const out = await run(s, ARGS);
  assert.deepEqual(counts(out), []);
  ignored(out, "infra:pr-tests");
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC5 ex6: a claim inside a criterion text is ignored", async () => {
  const crit = [{ id: "AC1", text: "[unit] reports 5 passed checks", test_files: ["tests/test_a.py"] }];
  const s = happy({ criteria: crit });
  s["infra:pr-tests"] = tests(["5 passed"]);
  const out = await run(s, ARGS);
  assert.deepEqual(counts(out), []);
  ignored(out, "infra:pr-tests");
});

test("AC5 ex7: a claim inside an example of a [manual] criterion is ignored", async () => {
  const crit = [
    { id: "AC1", text: "behaviour 1", test_files: ["tests/test_a.py"] },
    { id: "AC2", text: "[manual] the page", test_files: [], examples: [{ kind: "main", given: "a page", when: "opened", then: "shows 2 tests" }] },
  ];
  const s = happy({ criteria: crit });
  s["infra:pr-tests"] = tests(["2 tests"]);
  const out = await run(s, ARGS);
  assert.deepEqual(counts(out), []);
  ignored(out, "infra:pr-tests");
});

test("AC5 ex8: an example of an automated criterion is not a supplied string", async () => {
  const crit = [{ id: "AC1", text: "behaviour 1", test_files: ["t.mjs"], examples: [{ kind: "main", given: "a page", when: "opened", then: "shows 9 tests" }] }];
  const s = happy({ criteria: crit });
  s["infra:pr-tests"] = tests(["9 tests"]);
  s["role:fleet-pr-opener:counts"] = OPEN7;
  s["infra:pr-tests:counts"] = tests([]);
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("role:fleet-pr-opener:counts"), out.labels.join(", "));
});

test("AC5 ex9: a claim inside a review nit is ignored on the notes path", async () => {
  const s = withNotes(happy(), [{ id: "N1", severity: "nit", category: "docs", file: "a.py", line: 3, summary: "only 4 tests cover it", evidence: "a.py:3" }]);
  s["infra:pr-tests:notes"] = tests(["4 tests"]);
  const out = await run(s, ARGS);
  assert.deepEqual(counts(out), []);
  ignored(out, "infra:pr-tests:notes");
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC5 ex10: a claim inside a gates_not_run reason is ignored", async () => {
  const s = happy();
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { reason: "approved with gates not run: coverage", gates_not_run: [{ gate: "coverage", reason: "2 tests skipped by the runner" }] });
  s["infra:pr-tests"] = tests(["2 tests"]);
  const out = await run(s, ARGS);
  assert.deepEqual(counts(out), []);
  ignored(out, "infra:pr-tests");
});

test("AC5 ex11: a claim inside the intent reason is ignored", async () => {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "keeps 7 tests green", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier"], parser: "yaml", error: null },
  });
  s["infra:pr-tests"] = tests(["7 tests"]);
  const out = await run(s, { ...ARGS, confirm: "auto" });
  assert.ok(out.labels.includes("infra:pr-tests"), out.result.reason + " / " + out.labels.join(", "));
  assert.deepEqual(counts(out), []);
  ignored(out, "infra:pr-tests");
});

test("AC5 ex12: body_findings are not supplied strings: the body-v1 rewrite runs", async () => {
  const s = withBodyFix(happy(), { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, body_quote: "the change is fully verified", summary: "body says 147 passed", evidence: "npm test" });
  s["infra:pr-tests:body-v1"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:body-v1:counts"] = OPEN7;
  s["infra:pr-tests:body-v1:counts"] = tests([]);
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("role:fleet-pr-opener:body-v1:counts"), out.labels.join(", "));
});

test("AC5 ex13: a rewrite that names another PR stops; no second check", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:counts"] = Object.assign({}, OPEN7, { pr_url: "https://github.com/o/r/pull/8", pr_number: 8 });
  const out = await run(s, ARGS);
  stop(out, "pr-opener retry named https://github.com/o/r/pull/8 (#8), not https://github.com/o/r/pull/7 (#7); check both PRs");
  assert.ok(!out.labels.includes("infra:pr-tests:counts"), out.labels.join(", "));
});

test("AC5 ex14: a rewrite with a wrong title stops; no second check", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:counts"] = Object.assign({}, OPEN7, { title: "wrong" });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "role");
  assert.ok(out.result.reason.startsWith('pr-opener set the PR title "wrong", not '), out.result.reason);
  assert.ok(!out.labels.includes("infra:pr-tests:counts"), out.labels.join(", "));
});

test("AC5 ex15: the rewrite keeps created of the first call", async () => {
  const s = happy();
  s["infra:pr-tests"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:counts"] = OPEN7;
  s["infra:pr-tests:counts"] = tests([]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "role:fleet-pr-opener:counts").length, 1);
  assert.equal(stateJsonOf(call(out, "infra:state:pr_open:p1").prompt).pr_created, true);
});

test("AC5 ex16: a claim that stays after the notes rewrite stops", async () => {
  const s = withNotes(happy(), [{ id: "N1", severity: "nit", category: "style", file: "README.md", line: 1, summary: "typo", evidence: "q" }]);
  s["infra:pr-tests:notes"] = tests(["147 passed"]);
  s["role:fleet-pr-opener:notes:counts"] = OPEN7;
  s["infra:pr-tests:notes:counts"] = tests(["147 passed"]);
  stop(await run(s, ARGS), STILL("infra:pr-tests:notes:counts", '"147 passed"'));
});
