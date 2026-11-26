// ccpmcwf 8.9.15 (yaadgaar #131, #130).
// #131: a blocking review finding of a body category (pr_body_claim, or pr_body_format with no file)
// takes the body route (pr-opener update, re-review, no coder) only with a program fact read by
// pr_state.py body: (b) its body_quote (12+ characters) is in the current body; for pr_body_format
// also (a) its quote is a header the body lacks, or (c) a required check that reads the body fails
// at the head (pending is no fact). With no fact the finding goes to the coder, tagged so the
// code-judge guard never drops it. After the body update, a finding no review flags again counts as
// resolved only when the program finds its facts gone; else the run stops (no second repair).
// #130: before the review, the pr-opener's body is checked against the template headings, the
// required sections and min_chars; a miss gets one pr-opener rewrite, a second miss goes on.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf } from "./harness.mjs";

const CLAIM = { id: "R1", severity: "blocking", category: "pr_body_claim", file: null, line: null, summary: "the empty-input path returns 200", evidence: "ran x", target: "code", body_quote: null };
const FMT = { id: "R1", severity: "blocking", category: "pr_body_format", file: null, line: null, summary: "the Breaking? section is missing", evidence: "template", target: "code", body_quote: "## Breaking?" };
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const APPROVE = REV("approve", []);
const CODER2 = { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } };
const JUDGE2 = { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };
// a scripted pr_state body read: fields over the passing default
const BODY = (o) => (p) => {
  const a = inputsOf(p).args;
  const sp = JSON.parse(Buffer.from(a[5], "base64").toString("utf8"));
  const r = { status: "ok", reason: "read", mode: "body", head: a[4], body_sha256: "2".repeat(64), headers_missing: [], short: sp.min_chars === null ? null : false, quotes: sp.quotes.map(() => false), checks: sp.checks.map((name) => ({ name, bucket: "pass" })), template_read: sp.template ? true : null, error: null, args: a };
  return Object.assign(r, typeof o === "function" ? o(sp) : o);
};
const specOf = (out, l) => JSON.parse(Buffer.from(inputsOf(call(out, l).prompt).args[5], "base64").toString("utf8"));

function fixture(script) {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  F["infra:review-paths:v2"] = { status: "ok", reason: "listed", changed_paths: ["src/x.py"] };
  F["hasher:pre-review:v2"] = rs;
  F["hasher:fp-post:pr-review:v2"] = rs;
  F["infra:review-cleanup:v2"] = { status: "ok", reason: "clean" };
  return Object.assign(F, script);
}
const CODE_ROUND = {
  "role:fleet-coder:r2": CODER2,
  "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
  "role:fleet-code-judge:r2": JUDGE2,
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
  "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
  "role:fleet-pr-opener:p2": OPEN7,
  "role:pr-review:v2": APPROVE,
};
const bodyRouted = (out) => out.labels.includes("role:fleet-pr-opener:body-v1") && !out.labels.includes("role:fleet-coder:r2");
const toCoder = (out) => out.labels.includes("role:fleet-coder:r2") && !out.labels.includes("role:fleet-pr-opener:body-v1");

// #131 RED at f005d1a: a CODE defect labelled pr_body_claim with no quote took the body route and shipped unfixed
test("8.9.15 #131: a mislabelled code defect (pr_body_claim, no program fact) goes to the coder, never the body route", async () => {
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [CLAIM]) }, CODE_ROUND)), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(toCoder(out), out.labels.join(", "));
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings, [
    { target: "code", criterion: null, finding: "review R1 [pr_body_claim: no PR-body fact] -: the empty-input path returns 200 (evidence: ran x)" },
  ]);
  assert.ok(out.result.gate_log.some((l) => /1 PR body finding\(s\) with no program fact -> coder/.test(l)), out.result.gate_log.join("\n"));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, undefined);
});

test("8.9.15 #131: the next review gets a demoted finding as a code finding (category other), never as a body finding", async () => {
  const B = Object.assign({}, CLAIM, { id: "R2", body_quote: "the empty-input path returns 200" });
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [CLAIM, B]), "infra:pr-body:route:v1": BODY({ quotes: [true] }) }, CODE_ROUND)), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const prior = inputsOf(call(out, "role:pr-review:v2").prompt).prior_findings;
  assert.deepEqual(prior.map((f) => [f.id, f.category]), [["R1", "other"], ["R2", "pr_body_claim"]]);
});

test("8.9.15 #131: the code judge keeps fix_code for a demoted body finding (the guard drops only [pr_body_claim])", async () => {
  // the judge routes the engine's own prior finding back unchanged (not fixed)
  const script = Object.assign({ "role:pr-review:v1": REV("changes_requested", [CLAIM]) }, CODE_ROUND, {
    "role:fleet-code-judge:r2": (p) => ({ status: "ok", reason: "not fixed", verdict: "fix_code", routed_findings: inputsOf(p).prior_findings, hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } }),
    "role:fleet-coder:r3": CODER2,
    "hasher:post-coder:r3": { status: "ok", fingerprint: { head: CSHA(1), tree: "K3" }, hashes: HASHES },
    "role:fleet-code-judge:r3": JUDGE2,
    "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: { head: CSHA(1), tree: "K3" } },
  });
  const out = await run(fixture(script), ARGS);
  assert.equal(inputsOf(call(out, "role:fleet-code-judge:r2").prompt).prior_findings.length, 1);
  assert.ok(!out.result.gate_log.some((l) => /fix_code -> approve/.test(l)), out.result.gate_log.join("\n"));
  assert.ok(out.labels.includes("role:fleet-coder:r3"), out.labels.join(", "));
});

test("8.9.15 #131 (b): a pr_body_claim whose quote is in the body takes the body route; the read gets the quote and no wait", async () => {
  const F = Object.assign({}, CLAIM, { body_quote: "  the empty-input path\n returns 200 " });
  const out = await run(fixture({ "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ quotes: [true] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(bodyRouted(out), out.labels.join(", "));
  assert.deepEqual(specOf(out, "infra:pr-body:route:v1").quotes, ["the empty-input path returns 200"]);
  assert.equal(call(out, "infra:pr-body:route:v1").opts.agentType, "ccpmcwf:judge");
  // the v2 approve checks the quote is gone (the harness default after the update)
  assert.deepEqual(specOf(out, "infra:pr-body:confirm:v2").quotes, ["the empty-input path returns 200"]);
  assert.ok(out.result.gate_log.some((l) => /review v2: 1 PR body fact\(s\) gone after the body update \(program\)/.test(l)), out.result.gate_log.join("\n"));
});

for (const [name, q, quotes] of [
  ["a quote under 12 characters", "returns 200", null],
  ["a quote over 300 characters", "x".repeat(301), null],
  ["a quote not in the body", "the empty-input path returns 200", [false]],
]) {
  test("8.9.15 #131 (b): " + name + " gives no fact; the finding goes to the coder", async () => {
    const F = Object.assign({}, CLAIM, { body_quote: q });
    const s = { "role:pr-review:v1": REV("changes_requested", [F]) };
    if (quotes) s["infra:pr-body:route:v1"] = BODY({ quotes });
    const out = await run(fixture(Object.assign(s, CODE_ROUND)), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(toCoder(out), out.labels.join(", "));
    if (!quotes) assert.deepEqual(specOf(out, "infra:pr-body:route:v1").quotes, []);
  });
}

test("8.9.15 #131 (a): a pr_body_format finding whose quote is a header the body lacks takes the body route", async () => {
  const out = await run(fixture({ "role:pr-review:v1": REV("changes_requested", [FMT]), "infra:pr-body:route:v1": BODY({ headers_missing: ["## Breaking?"] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(bodyRouted(out), out.labels.join(", "));
  assert.deepEqual(specOf(out, "infra:pr-body:confirm:v2").headers, ["## Breaking?"]);
});

test("8.9.15 #131 (a): a header fact counts for pr_body_format only; a pr_body_claim quoting a missing header goes to the coder", async () => {
  const F = Object.assign({}, CLAIM, { body_quote: "## Breaking change notes" });
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ headers_missing: ["## Breaking change notes"] }) }, CODE_ROUND)), ARGS);
  assert.ok(toCoder(out), out.labels.join(", "));
});

// the body-reading required check: a workflow path or a check name that names pr-body
const CHECKS = [
  { type: "workflows", ruleset_id: 1, workflow: "q/actions@refs/heads/main:.github/workflows/pr-body.yml", check: "PR body / check" },
  { type: "required_status_checks", ruleset_id: 1, workflow: null, check: "build" },
];
function withChecks(s) {
  for (const sfx of ["", ":audit-fix"])
    s["infra:ruleset-surface:plan" + sfx] = (p) => ({ status: "ok", reason: "read", surface: [], sources: [], read: ["rules/branches/main: 2 rule(s)"], unreadable: [], checks: CHECKS, error: null, args: inputsOf(p).args });
  return s;
}
const FMTC = Object.assign({}, FMT, { body_quote: null });

test("8.9.15 #131 (c): a failing required check that reads the body makes a pr_body_format fact; only that check is read", async () => {
  const s = withChecks(fixture({ "role:pr-review:v1": REV("changes_requested", [FMTC]), "infra:pr-body:route:v1": BODY({ checks: [{ name: "PR body / check", bucket: "fail" }] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(bodyRouted(out), out.labels.join(", "));
  assert.deepEqual(specOf(out, "infra:pr-body:route:v1").checks, ["PR body / check"]);
  assert.deepEqual(specOf(out, "infra:pr-body:confirm:v2").checks, ["PR body / check"]);
});

test("8.9.15 #131 (c): a pending body check is no fact; the finding goes to the coder", async () => {
  const s = withChecks(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [FMTC]), "infra:pr-body:route:v1": BODY({ checks: [{ name: "PR body / check", bucket: "pending" }] }) }, CODE_ROUND)));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(toCoder(out), out.labels.join(", "));
});

test("8.9.15 #131 (c): a check fact counts for pr_body_format only; a pr_body_claim with a failing body check goes to the coder", async () => {
  const s = withChecks(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [CLAIM]), "infra:pr-body:route:v1": BODY({ checks: [{ name: "PR body / check", bucket: "fail" }] }) }, CODE_ROUND)));
  const out = await run(s, ARGS);
  assert.ok(toCoder(out), out.labels.join(", "));
});

test("8.9.15 #131: a program error on the route read gives no fact (toward the coder)", async () => {
  const F = Object.assign({}, CLAIM, { body_quote: "the empty-input path returns 200" });
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ quotes: [true], error: "gh pr view: HTTP 502" }) }, CODE_ROUND)), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(toCoder(out), out.labels.join(", "));
});

// confirmation: v2 does not flag the body finding again, but the program finds the fact still holds
for (const [name, script, re] of [
  ["the quoted span is still in the body", { "infra:pr-body:confirm:v2": BODY({ quotes: [true] }) }, /R1 quote/],
  ["the header is still missing", { "infra:pr-body:route:v1": BODY({ headers_missing: ["## Breaking?"] }), "infra:pr-body:confirm:v2": BODY({ headers_missing: ["## Breaking?"] }) }, /R1 header "## Breaking\?"/],
  ["the confirm read fails", { "infra:pr-body:confirm:v2": BODY({ error: "gh pr view: HTTP 502" }) }, /could not read the body facts/],
]) {
  test("8.9.15 #131 confirm: v2 approves but " + name + ": the resolved is refused and the run stops", async () => {
    const F = name.startsWith("the header") ? FMT : Object.assign({}, CLAIM, { body_quote: "the empty-input path returns 200" });
    const base = { "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ quotes: [true] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE };
    const out = await run(fixture(Object.assign(base, script)), ARGS);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "review");
    assert.equal(out.result.stop_class, "judgment");
    assert.match(out.result.reason, /review v2: PR body finding\(s\) R1 count as resolved after the body update, but the program/);
    assert.match(out.result.reason, re);
    assert.ok(!out.result.reason.includes("the empty-input path"), "the stop names ids and kinds, never the quote");
    assert.ok(!out.labels.includes("role:fleet-coder:r2"));
    assert.ok(!out.labels.some((l) => /^infra:state:reviewed/.test(l)), out.labels.join(", "));
  });
}

test("8.9.15 #131 confirm: v2 changes_requested on code but the body fact still holds: the stop comes first, no coder round", async () => {
  const F = Object.assign({}, CLAIM, { body_quote: "the empty-input path returns 200" });
  const CODE = { id: "R3", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x", body_quote: null };
  const out = await run(fixture({ "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ quotes: [true] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": REV("changes_requested", [CODE]), "infra:pr-body:confirm:v2": BODY({ quotes: [true] }) }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /count as resolved after the body update/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("8.9.15 #131 confirm: a check fact: pending clears only while the CI step watches it; fail stops", async () => {
  const base = () => withChecks(fixture({ "role:pr-review:v1": REV("changes_requested", [FMTC]), "infra:pr-body:route:v1": BODY({ checks: [{ name: "PR body / check", bucket: "fail" }] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }));
  const pend = await run(Object.assign(base(), { "infra:pr-body:confirm:v2": BODY({ checks: [{ name: "PR body / check", bucket: "pending" }] }) }), ARGS);
  assert.equal(pend.result.status, "ok", pend.result.reason);
  const off = Object.assign(base(), { "infra:pr-body:confirm:v2": BODY({ checks: [{ name: "PR body / check", bucket: "pending" }] }) });
  off["infra:policy"] = (p) => ({ status: "ok", reason: "read", profile: null, file: "/home/u/.config/fleet/policy.json", policy_sha256: null, caps: { pr_ready: true, ci_watch: false, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" }, matched: "no policy file", error: null, args: inputsOf(p).args });
  const unwatched = await run(off, ARGS);
  assert.equal(unwatched.result.status, "needs_human", unwatched.result.reason);
  assert.match(unwatched.result.reason, /R1 check "PR body \/ check"/);
  const fail = await run(Object.assign(base(), { "infra:pr-body:confirm:v2": BODY({ checks: [{ name: "PR body / check", bucket: "fail" }] }) }), ARGS);
  assert.equal(fail.result.status, "needs_human");
  assert.match(fail.result.reason, /R1 check "PR body \/ check"/);
});

test("8.9.15 #131 confirm: a body finding v2 flags again keeps the 8.9.9 stop (still flagged), not the confirm stop", async () => {
  const F = Object.assign({}, CLAIM, { body_quote: "the empty-input path returns 200" });
  const out = await run(fixture({ "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ quotes: [true] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": REV("changes_requested", [F]), "infra:pr-body:route:v2": BODY({ quotes: [true] }) }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /PR body finding still flagged after one body update/);
  assert.ok(!out.labels.includes("infra:pr-body:confirm:v2"));
});

test("8.9.15 #131 confirm: a mixed review's body facts are checked at the review after the p2 pr-opener", async () => {
  const F = Object.assign({}, CLAIM, { body_quote: "the empty-input path returns 200" });
  const CODE = { id: "R3", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x", body_quote: null };
  const out = await run(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [F, CODE]), "infra:pr-body:route:v1": BODY({ quotes: [true] }) }, CODE_ROUND, { "infra:pr-body:confirm:v2": BODY({ quotes: [true] }) })), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, [F]);
  assert.match(out.result.reason, /review v2: PR body finding\(s\) R1 count as resolved/);
});

// #130: the pre-review body check
const conv = (s, body) => {
  s["infra:pr-convention:plan"] = (p) => ({ status: "ok", reason: "read", title: { style: "conventional", types: ["feat", "fix", "chore"], key_required: false }, body, source: ["x"], unreadable: [], args: inputsOf(p).args });
  return s;
};
const BC = { template: ".github/pull_request_template.md", template_repo: null, required_sections: ["## Summary"], min_chars: 50, checker: null };

test("8.9.15 #130: a body missing a template header gets one pr-opener rewrite before the review", async () => {
  const s = conv(happy(), BC);
  s["infra:pr-body:open"] = BODY({ headers_missing: ["## Testing"] });
  s["role:fleet-pr-opener:body"] = OPEN7;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const sp = specOf(out, "infra:pr-body:open");
  assert.deepEqual([sp.headers, sp.min_chars, sp.quotes, sp.checks], [["## Summary"], 50, [], []]);
  // the template is read on the default branch, never at the PR head
  assert.deepEqual(sp.template, { repo: "o/r", path: ".github/pull_request_template.md", ref: null });
  assert.match(inputsOf(call(out, "role:fleet-pr-opener:body").prompt).retry_reason, /misses the repo's PR template or body rules: "## Testing"/);
  const at = (l) => out.labels.indexOf(l);
  assert.ok(at("infra:pr-body:open") < at("role:fleet-pr-opener:body") && at("role:fleet-pr-opener:body") < at("infra:pr-body:open:body"));
  assert.ok(at("infra:pr-body:open:body") < at("infra:pr-tests") && at("infra:pr-tests") < at("role:pr-review:v1"), out.labels.join(", "));
});

test("8.9.15 #130: a second miss goes to the review as before (no second rewrite, no stop)", async () => {
  const s = conv(happy(), BC);
  s["infra:pr-body:open"] = BODY({ short: true });
  s["infra:pr-body:open:body"] = BODY({ short: true });
  s["role:fleet-pr-opener:body"] = OPEN7;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => /^role:fleet-pr-opener:body/.test(l)).length, 1);
  assert.ok(out.result.gate_log.some((l) => /infra:pr-body:open:body: the PR body still misses fewer than 50 characters; the review sees it/.test(l)), out.result.gate_log.join("\n"));
  assert.ok(out.labels.includes("role:pr-review:v1"));
});

test("8.9.15 #130: a passing body gets no rewrite; no body convention, no read", async () => {
  const out = await run(conv(happy(), BC), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:pr-body:open"));
  assert.ok(!out.labels.some((l) => /^role:fleet-pr-opener:body/.test(l)));
  const none = await run(happy(), ARGS);
  assert.ok(!none.labels.some((l) => /^infra:pr-body/.test(l)), none.labels.join(", "));
});
