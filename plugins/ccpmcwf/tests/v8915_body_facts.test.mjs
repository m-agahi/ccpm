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
import { ARGS, HASHES, CSHA, PB, happy, run, runOne, call, inputsOf, stateJsonOf } from "./harness.mjs";

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
  const r = { status: "ok", reason: "read", mode: "body", head: a[4], body_sha256: "2".repeat(64), headers_missing: [], short: sp.min_chars === null ? null : false, quotes: sp.quotes.map(() => false), checks: sp.checks.map((name) => ({ name, bucket: "pass" })), template_read: sp.template ? true : null, checker: sp.checker ? { ran: true, exit: 0, timed_out: false, excerpt: null, reason: null } : null, error: null, args: a };
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

// review of d9ae4c6 (R1): a failing body check counts only together with a quote or header fact
const FMTQ = Object.assign({}, FMT, { body_quote: "no. The change adds two RPCs" });
test("8.9.15 R1: a failing body-reading check alone is no fact; the pr_body_format finding goes to the coder", async () => {
  const s = withChecks(fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [FMTC]), "infra:pr-body:route:v1": BODY({ checks: [{ name: "PR body / check", bucket: "fail" }] }) }, CODE_ROUND)));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(toCoder(out), out.labels.join(", "));
  assert.deepEqual(specOf(out, "infra:pr-body:route:v1").checks, ["PR body / check"]);
});

test("8.9.15 R1: a failing body check with a quote fact joins the facts; the confirmation reads only that check", async () => {
  const s = withChecks(fixture({ "role:pr-review:v1": REV("changes_requested", [FMTQ]), "infra:pr-body:route:v1": BODY({ quotes: [true], checks: [{ name: "PR body / check", bucket: "fail" }] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(bodyRouted(out), out.labels.join(", "));
  assert.deepEqual(specOf(out, "infra:pr-body:confirm:v2").checks, ["PR body / check"]);
  assert.ok(out.result.gate_log.some((l) => /review v2: 2 PR body fact\(s\) gone/.test(l)), out.result.gate_log.join("\n"));
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

// review of d9ae4c6 (R2): a pending body check waits once (ci_watch.py, the policy's CI-watch minutes), then holds
const PEND = { checks: [{ name: "PR body / check", bucket: "pending" }] };
const confirmBase = () => withChecks(fixture({ "role:pr-review:v1": REV("changes_requested", [FMTQ]), "infra:pr-body:route:v1": BODY({ quotes: [true], checks: [{ name: "PR body / check", bucket: "fail" }] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": APPROVE, "infra:pr-body:confirm:v2": BODY(PEND) }));
test("8.9.15 R2: a pending body check at the confirmation waits once, then passing clears it", async () => {
  const out = await run(Object.assign(confirmBase(), { "infra:pr-body:confirm:v2:again": BODY({}) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const w = inputsOf(call(out, "infra:ci-watch:body-v2").prompt).args;
  assert.equal(w[4], "3600", "the policy's ci_watch_minutes (60) in seconds");
  assert.equal(call(out, "infra:ci-watch:body-v2").opts.agentType, "ccpmcwf:judge");
  const at = (l) => out.labels.indexOf(l);
  assert.ok(at("infra:pr-body:confirm:v2") < at("infra:ci-watch:body-v2") && at("infra:ci-watch:body-v2") < at("infra:pr-body:confirm:v2:again"), out.labels.join(", "));
});

for (const [name, again, watch] of [["still pending", PEND, true], ["failing", { checks: [{ name: "PR body / check", bucket: "fail" }] }, true], ["still pending with the CI watch off", PEND, false]]) {
  test("8.9.15 R2: a body check " + name + " after the wait is not resolved: the run stops (J_PR, review)", async () => {
    const s = Object.assign(confirmBase(), { "infra:pr-body:confirm:v2:again": BODY(again) });
    if (!watch) s["infra:policy"] = (p) => ({ status: "ok", reason: "read", profile: null, file: "/home/u/.config/fleet/policy.json", policy_sha256: null, caps: { pr_ready: true, ci_watch: false, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" }, matched: "no policy file", error: null, args: inputsOf(p).args });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "review");
    assert.equal(out.result.stop_class, "judgment");
    assert.match(out.result.reason, /R1 check "PR body \/ check"/);
    assert.ok(out.labels.includes("infra:ci-watch:body-v2"), out.labels.join(", "));
  });
}

test("8.9.15 R2: a relayed wait that is not the program's stops (safety)", async () => {
  const out = await run(Object.assign(confirmBase(), { "infra:ci-watch:body-v2": (p) => ({ status: "ok", reason: "watched", state: "green", checks: [], failed: [], required: true, head: "a".repeat(40), elapsed_s: 1, error: null, args: ["x"] }) }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_class, "safety");
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

// review of d9ae4c6 (R8, B2): the template warning and the repo's body checker before the review
test("8.9.15 R8: a template the read cannot find gets a warning gate line", async () => {
  const s = conv(happy(), BC);
  s["infra:pr-body:open"] = BODY({ template_read: false });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.some((l) => /infra:pr-body:open: warning: the PR template \.github\/pull_request_template\.md could not be read on the default branch/.test(l)), out.result.gate_log.join("\n"));
});

const BCK = (checker) => Object.assign({}, BC, { checker });
// review of cae63d3: a 40-hex plan base (the harness PB is short)
const PB40 = PB + "0".repeat(40 - PB.length);
test("8.9.15 B2: a checker of this repo runs at the plan base; a non-zero exit gets the one rewrite with its exit code and stderr only", async () => {
  const s = conv(happy({ planBase: PB40 }), BCK("o/r/.github/scripts/pr_body_check.py"));
  s["infra:pr-body:open"] = BODY({ checker: { ran: true, exit: 1, timed_out: false, excerpt: "## Breaking? must open with yes or no", reason: null } });
  s["role:fleet-pr-opener:body"] = OPEN7;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const sp = specOf(out, "infra:pr-body:open");
  assert.equal(sp.checker.path, ".github/scripts/pr_body_check.py");
  assert.equal(sp.checker.base, PB40);
  assert.notEqual(sp.checker.base, inputsOf(call(out, "infra:pr-body:open").prompt).args[4], "the plan base, not the PR head");
  assert.equal(sp.checker.worktree, inputsOf(call(out, "role:pr-review:v1").prompt).worktree);
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener:body").prompt).retry_reason, 'the PR body misses the repo\'s PR template or body rules: the repo\'s body checker exited 1 (stderr: "## Breaking? must open with yes or no"); write each missing heading as its own line, meet the checker\'s rule, and keep every other section');
  assert.equal(out.labels.filter((l) => /^role:fleet-pr-opener:body/.test(l)).length, 1);
});

test("8.9.15 B2: a header miss and a checker miss share the one rewrite; a second miss goes on", async () => {
  const s = conv(happy({ planBase: PB40 }), BCK("O/R/check.py"));
  const bad = { headers_missing: ["## Testing"], checker: { ran: true, exit: 2, timed_out: false, excerpt: null, reason: null } };
  s["infra:pr-body:open"] = BODY(bad);
  s["infra:pr-body:open:body"] = BODY(bad);
  s["role:fleet-pr-opener:body"] = OPEN7;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => /^role:fleet-pr-opener:body/.test(l)).length, 1);
  assert.match(inputsOf(call(out, "role:fleet-pr-opener:body").prompt).retry_reason, /"## Testing"; the repo's body checker exited 2;/);
  assert.ok(out.result.gate_log.some((l) => /infra:pr-body:open:body: the PR body still misses .*the review sees it/.test(l)));
});

for (const [name, checker] of [
  ["another repo's checker", "q/actions/pr-body-convention/pr_body_check.py"],
  ["a workflow path (the checker was not readable)", "o/r:.github/workflows/pr_body.yml"],
  ["a path with ..", "o/r/../x.py"],
]) {
  test("8.9.15 B2: " + name + " is not run: a gate line, no checker in the read", async () => {
    const s = conv(happy({ planBase: PB40 }), BCK(checker));
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(specOf(out, "infra:pr-body:open").checker, null);
    assert.ok(out.result.gate_log.some((l) => l.startsWith("infra:pr-body:open: the repo's body checker ") && l.endsWith("is not a script of o/r at the plan base; not run")), out.result.gate_log.join("\n"));
  });
}

test("8.9.15 B2: a checker the sandbox could not run is skipped with a gate line (no rewrite)", async () => {
  const s = conv(happy({ planBase: PB40 }), BCK("o/r/check.py"));
  s["infra:pr-body:open"] = BODY({ checker: { ran: false, exit: null, timed_out: false, excerpt: null, reason: "sandbox unavailable: bwrap is not on PATH" } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /^role:fleet-pr-opener:body/.test(l)));
  assert.ok(out.result.gate_log.some((l) => /the repo's body checker did not run \(sandbox unavailable: bwrap is not on PATH\); skipped/.test(l)));
});

// review of d9ae4c6 (B1): the body route's state survives a resume
// the first build's last run-state (the one a resume reads); over: stubs of the first build (a stop in it)
async function bodyBuilt(over) {
  const F = Object.assign({}, CLAIM, { body_quote: "the empty-input path returns 200" });
  const states = {};
  const s = fixture(Object.assign({ "role:pr-review:v1": REV("changes_requested", [F]), "infra:pr-body:route:v1": BODY({ quotes: [true] }), "role:fleet-pr-opener:body-v1": OPEN7, "role:pr-review:v2": { status: "failed", reason: "stop here", verdict: null, findings: null, touches_gate: null, checked: null } }, over || {}));
  for (const l of ["infra:state:pr_open:pre-body-v1", "infra:state:pr_open:body-v1"])
    s[l] = (prompt) => {
      states.body = stateJsonOf(prompt);
      states.labels = (states.labels || []).concat(l);
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  const plan = await runOne(s, ARGS);
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" };
  const first = await runOne(s, bargs);
  assert.notEqual(first.result.status, "ok", first.result.reason);
  assert.ok(states.body, "the body-only route writes a pr_open run-state before the body update");
  const x = states.body;
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
  const h = JSON.parse(JSON.stringify(HASHES));
  h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
  s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
  return { s, x, F, bargs, saved: states.labels };
}

test("8.9.15 B1: the body-only route saves the body state; a resume confirms the persisted fact (still holds: J_PR)", async () => {
  const { s, x, bargs } = await bodyBuilt();
  assert.equal(x.last_gate, "pr_open");
  assert.equal(x.body_fixes, 1);
  assert.deepEqual(x.body_check, [{ id: "R1", kind: "quote", value: "the empty-input path returns 200" }]);
  s["role:pr-review:v2"] = APPROVE;
  s["infra:pr-body:confirm:v2"] = BODY({ quotes: [true] });
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_class, "judgment");
  assert.match(out.result.reason, /review v2: PR body finding\(s\) R1 count as resolved after the body update/);
});

test("8.9.15 B1: a resume keeps the cap of one body update (a body finding again stops; no second update)", async () => {
  const { s, F, bargs } = await bodyBuilt();
  s["role:pr-review:v2"] = REV("changes_requested", [F]);
  s["infra:pr-body:route:v2"] = BODY({ quotes: [true] });
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /PR body finding still flagged after one body update/);
  assert.ok(!out.labels.includes("role:fleet-pr-opener:body-v2"), out.labels.join(", "));
});

test("8.9.15 B1: a run-state with a malformed or partial body state is refused (resume)", async () => {
  for (const bad of [{ body_check: [{ id: "R1", kind: "guess", value: "x" }] }, { body_fixes: "1" }, { body_demoted: undefined }]) {
    const { s, x, bargs } = await bodyBuilt();
    const y = Object.assign({}, x, bad);
    if ("body_demoted" in bad) delete y.body_demoted;
    s["infra:read-state"] = Object.assign({}, s["infra:read-state"], { message: JSON.stringify(y) });
    const out = await runOne(s, bargs);
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.match(out.result.reason, /run-state mismatch: body route state/);
  }
});

// review of cae63d3: the body route saves before the body update and again before stats
test("8.9.15 B1: a stats stop right after the body update resumes with the facts: an approving review gives the J_PR stop", async () => {
  const { s, x, bargs, saved } = await bodyBuilt({ "infra:pr-stats:body-v1": { status: "failed", reason: "stats write failed" } });
  assert.deepEqual(saved, ["infra:state:pr_open:pre-body-v1", "infra:state:pr_open:body-v1"]);
  assert.equal(x.body_fixes, 1);
  s["infra:pr-stats:body-v1"] = undefined;
  delete s["infra:pr-stats:body-v1"];
  s["role:pr-review:v2"] = APPROVE;
  s["infra:pr-body:confirm:v2"] = BODY({ quotes: [true] });
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_class, "judgment");
  assert.match(out.result.reason, /review v2: PR body finding\(s\) R1 count as resolved after the body update/);
});

test("8.9.15 B1: a stop inside the body-v pr-opener resumes with body_fixes 1: no second body update", async () => {
  const { s, x, F, bargs, saved } = await bodyBuilt({ "role:fleet-pr-opener:body-v1": { status: "needs_human", reason: "gh pr edit refused" } });
  assert.deepEqual(saved, ["infra:state:pr_open:pre-body-v1"]);
  assert.equal(x.body_fixes, 1);
  assert.deepEqual(x.body_check, [{ id: "R1", kind: "quote", value: "the empty-input path returns 200" }]);
  s["role:fleet-pr-opener:body-v1"] = OPEN7;
  s["role:pr-review:v2"] = REV("changes_requested", [F]);
  s["infra:pr-body:route:v2"] = BODY({ quotes: [true] });
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /PR body finding still flagged after one body update/);
  assert.ok(!out.labels.some((l) => /^role:fleet-pr-opener:body-v/.test(l)), out.labels.join(", "));
});

test("8.9.15 B2: a plan base that is not 40 or 64 hex skips the checker with a gate line", async () => {
  const out = await run(conv(happy(), BCK("o/r/check.py")), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(specOf(out, "infra:pr-body:open").checker, null);
  assert.ok(out.result.gate_log.some((l) => /the repo's body checker "o\/r\/check\.py" is not a script of o\/r at the plan base; not run/.test(l)), out.result.gate_log.join("\n"));
});
