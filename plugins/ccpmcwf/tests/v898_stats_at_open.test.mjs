// ccpmcwf 8.9.8 (yaadgaar #124, Max's ruling: option a): the stats block is written right after the
// first PR open and refreshed after every later pr-opener call (the p<N>, body-v and notes opens),
// so a run that stops after the PR opens still leaves a PR with the block. The step-list stats step
// and the run-end refresh stay. One refresh per PR step: every push is followed by the pr step, so
// no extra write per push.
//
// Run: node --test plugins/ccpmcwf/tests/v898_stats_at_open.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, CSHA, PB, HERE, happy, run, runOne, call, inputsOf, stateJsonOf, HASHES, sha256 } from "./harness.mjs";

const README = readFileSync(join(HERE, "..", "README.md"), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const polOut = (caps) => (p) => ({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, caps), matched: "no policy file", error: null, args: inputsOf(p).args });
const blockOf = (out, label) => Buffer.from(inputsOf(call(out, label).prompt).args[3], "base64").toString("utf8");
const CODE = { id: "R1", severity: "blocking", category: "bug", file: "src/x.py", line: 3, summary: "off by one", evidence: "src/x.py:3" };
const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed; the suite gives 133", evidence: "npm test: 133 pass" };
const NIT = { id: "N1", severity: "nit", category: "docs", file: "src/x.py", line: 3, summary: "name the unit", evidence: "src/x.py:3" };
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const REV = (verdict, findings) => ({ status: "ok", reason: "x", verdict, findings, touches_gate: false, checked: [] });

// the #195 shape: review v1 requests a code change, the coder stops with needs_human
function stopAfterReview() {
  const s = happy();
  s["role:pr-review:v1"] = REV("changes_requested", [CODE]);
  s["role:fleet-coder:r2"] = { status: "needs_human", reason: "coder stuck" };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES };
  return s;
}

test("8.9.8 #124: the first PR open writes the stats block after the pr_open run-state, before the review", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.build.labels;
  const i = L.indexOf("infra:pr-stats:open");
  assert.ok(i > L.indexOf("role:fleet-pr-opener") && i > L.indexOf("infra:state:pr_open:p1") && i < L.indexOf("role:pr-review:v1"), L.join(", "));
  // the step-list stats step and its label stay
  assert.ok(L.indexOf("infra:pr-stats") > L.indexOf("infra:state:written_back"), L.join(", "));
  // truthful for the point it was written: no review yet, no CI row
  const early = blockOf(out, "infra:pr-stats:open");
  assert.ok(early.indexOf("| independent review | not run (sweep: not triggered) |") >= 0, early);
  assert.ok(early.indexOf("| CI |") < 0, early);
  assert.ok(blockOf(out, "infra:pr-stats").indexOf("| independent review | approve (sweep: not triggered) |") >= 0);
});

test("8.9.8 #124: a run that stops after the review (coder needs_human) leaves the PR with the stats block; the stop is unchanged", async () => {
  const out = await run(stopAfterReview(), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  // the coder's own stop (as on master): the early write ends before the review
  assert.equal(out.result.reason, "fleet-coder returned needs_human: coder stuck");
  assert.equal(out.result.stop_class, "safety");
  assert.equal(out.result.stop_gate, "role");
  const L = out.build.labels;
  assert.ok(L.includes("infra:pr-stats:open"), L.join(", "));
  assert.ok(!L.includes("infra:pr-stats"), "no step-list stats step on a stop: " + L.join(", "));
  assert.ok(L.indexOf("infra:pr-stats:open") < L.indexOf("role:pr-review:v1"), L.join(", "));
  assert.ok(out.build.logs.some((l) => /^infra:pr-stats:open: stats block added in /.test(l)), out.build.logs.join("\n"));
});

test("8.9.8 #124: a body-only review refreshes the block after the pr-opener body update", async () => {
  const s = happy();
  const rs = s["hasher:pre-review:v1"];
  Object.assign(s, {
    "role:pr-review:v1": REV("changes_requested", [BODY]),
    "role:fleet-pr-opener:body-v1": OPEN7,
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:pr-review:v2": REV("approve", []),
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.build.labels;
  const i = L.indexOf("infra:pr-stats:body-v1");
  assert.ok(i > L.indexOf("role:fleet-pr-opener:body-v1") && i < L.indexOf("role:pr-review:v2"), L.join(", "));
  assert.ok(blockOf(out, "infra:pr-stats:body-v1").indexOf("| independent review | changes_requested (") >= 0);
});

test("8.9.8 #124: an approve with nits refreshes the block after the notes pr-opener call", async () => {
  const s = happy();
  s["role:pr-review:v1"] = REV("approve", [NIT]);
  s["role:fleet-pr-opener:notes"] = OPEN7;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.build.labels;
  const i = L.indexOf("infra:pr-stats:notes:v1");
  assert.ok(i > L.indexOf("role:fleet-pr-opener:notes") && i < L.indexOf("infra:state:reviewed:v1"), L.join(", "));
});

// a CI-fix round (the v600_s3 stubs): the push, then the pr step's opener and its block
function fixRound(s, k) {
  return Object.assign(s, {
    ["role:fleet-coder:r" + k]: { status: "ok", changed_paths: ["src/x.py"] },
    ["hasher:post-coder:r" + k]: { status: "ok", fingerprint: { head: CSHA(k - 1), tree: "K" + k }, hashes: HASHES },
    ["role:fleet-code-judge:r" + k]: { status: "ok", verdict: "approve", routed_findings: [] },
    ["hasher:fp-post:code-judge:r" + k]: { status: "ok", fingerprint: { head: CSHA(k - 1), tree: "K" + k } },
    ["infra:push:p" + k]: (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    ["role:fleet-pr-opener:p" + k]: { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true, title: "feat(thing): add thing" },
    ["infra:review-paths:v" + k]: { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    ["hasher:pre-review:v" + k]: { status: "ok", fingerprint: { head: CSHA(k), tree: "K" + k } },
    ["role:pr-review:v" + k]: { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
    ["hasher:fp-post:pr-review:v" + k]: { status: "ok", fingerprint: { head: CSHA(k), tree: "K" + k } },
    ["infra:review-cleanup:v" + k]: { status: "ok", reason: "clean" },
  });
}
function watchOut(state) {
  return (p) => {
    const a = inputsOf(p).args;
    const failed = state === "red" ? [{ name: "test", url: "https://github.com/o/r/actions/runs/77/job/88", run_id: "77", excerpt: "FAILED tests/test_a.py::test_x", verified: true }] : [];
    return { status: "ok", reason: "w", state, checks: [{ name: "test", state: state === "red" ? "FAILURE" : "SUCCESS", bucket: state === "red" ? "fail" : "pass", url: "https://github.com/o/r/actions/runs/77/job/88" }], failed, required: true, head: a[3], elapsed_s: 60, error: null, args: a };
  };
}

test("8.9.8 #124: a CI-fix round's PR step writes infra:pr-stats:open:p2 (one write per PR step, none per push)", async () => {
  const s = fixRound(happy(), 2);
  s["infra:ci-watch:w1"] = watchOut("red");
  s["role:fleet-ci-classifier:w1"] = { status: "ok", reason: "c", checks: [{ name: "test", cause: "diff" }] };
  s["infra:ci-watch:w2"] = watchOut("green");
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.build.labels;
  const i = L.indexOf("infra:pr-stats:open:p2");
  assert.ok(i > L.indexOf("role:fleet-pr-opener:p2") && i > L.indexOf("infra:state:pr_open:p2") && i < L.indexOf("role:pr-review:v2"), L.join(", "));
  // the step-list labels stay as before (v600_s3)
  assert.ok(L.indexOf("infra:pr-stats:p2") > L.indexOf("role:pr-review:v2"), L.join(", "));
  // the block written then shows the CI outcome the run had seen so far
  assert.match(blockOf(out, "infra:pr-stats:open:p2"), /\| CI \| red \(1 CI-fix rounds, waited /);
  assert.equal(L.filter((l) => /^infra:pr-stats:open/.test(l)).length, L.filter((l) => /^role:fleet-pr-opener(:p\d+)?$/.test(l)).length, L.join(", "));
});

test("8.9.8 #124: policy stats false writes no block at any PR step and logs the off line once", async () => {
  const s = happy();
  s["infra:policy"] = polOut(Object.assign({}, DEFAULT_CAPS, { stats: false }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.build.labels.some((l) => /^infra:pr-stats/.test(l)), out.build.labels.join(", "));
  assert.equal(out.build.logs.filter((l) => l === "stats block off (policy stats false)").length, 1, out.build.logs.join("\n"));
});

test("8.9.8 #124: an early block refused twice stops at stats (needs_human) after the pr_open run-state; no review runs", async () => {
  const s = happy();
  s["infra:pr-stats:open"] = s["infra:pr-stats:open:regen"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "w", replaced: false, wall_s: 5, block_sha256: "0".repeat(64), body_sha256_before: null, body_sha256_after: null, headers_missing: [], error: null, args: a };
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "stats");
  assert.match(out.result.reason, /^infra:pr-stats:open:regen: the PR body's stats block is not the script's block/);
  const L = out.build.labels;
  assert.ok(L.indexOf("infra:state:pr_open:p1") < L.indexOf("infra:pr-stats:open"), L.join(", "));
  assert.ok(!L.includes("role:pr-review:v1"), L.join(", "));
});

test("8.9.8 #124: an early relay mismatch stops at once (integrity, ADR-1406): no regenerate", async () => {
  const s = happy();
  s["infra:pr-stats:open"] = (p) => {
    const a = inputsOf(p).args;
    const block = Buffer.from(a[3], "base64").toString("utf8").replace("@@WALL@@", "2m");
    return { status: "ok", reason: "w", replaced: false, wall_s: 120, block_sha256: sha256(block), body_sha256_before: null, body_sha256_after: null, headers_missing: [], error: null, args: a.slice(0, 5).concat(["[\"## Other\"]"]) };
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "stats");
  assert.ok(!out.build.labels.includes("infra:pr-stats:open:regen"), out.build.labels.join(", "));
});

test("8.9.8 #124: an unattended PR body with no Unattended run section stops at the first-open block (the same check as the stats step)", async () => {
  const s = happy();
  s["infra:pr-stats:open"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "written", replaced: false, wall_s: 120, block_sha256: "0".repeat(64), body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: ["### Unattended run"], error: "the re-read body lost header(s): ### Unattended run", args: a };
  };
  // the auto-gate stubs of v630_unattended (gated())
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  const out = await runOne(s, Object.assign({}, ARGS, { unattended: true }));
  out.build = out;
  if (out.result.status === "needs_human" && out.build && out.build.labels.includes("infra:pr-stats:open")) {
    assert.equal(out.result.stop_gate, "stats");
    assert.match(out.result.reason, /^infra:pr-stats:open: the PR body has no ### Unattended run section/);
    assert.ok(JSON.parse(inputsOf(call(out, "infra:pr-stats:open").prompt).args[5]).includes("### Unattended run"));
  } else assert.fail("the unattended run did not reach the first-open block: " + out.result.status + " " + out.result.reason);
});

test("8.9.8 #124: a resume at pr_open starts at the review: no pr-opener call, no first-open block; the step-list block is written", async () => {
  const s = stopAfterReview();
  let st = null;
  s["infra:state:pr_open:p1"] = (prompt) => {
    st = stateJsonOf(prompt);
    return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
  };
  const plan = await runOne(s, ARGS);
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref });
  delete bargs.input;
  const first = await runOne(s, bargs);
  assert.equal(first.result.status, "needs_human", first.result.reason);
  assert.ok(first.labels.includes("infra:pr-stats:open"), first.labels.join(", "));
  assert.ok(st && st.last_gate === "pr_open", "the first build wrote the pr_open run-state");
  // the early write adds no milestone and no run-state key
  assert.ok(!Object.keys(st).some((k) => /stats/.test(k)), Object.keys(st).join(", "));
  const x = st;
  s["role:pr-review:v1"] = REV("approve", []);
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
  const h = JSON.parse(JSON.stringify(HASHES));
  h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
  s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: "n2-0000002" }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "review", r.result.reason);
  const L = r.labels;
  assert.ok(!L.some((l) => /^role:fleet-pr-opener/.test(l)), L.join(", "));
  assert.ok(!L.some((l) => /^infra:pr-stats:open/.test(l)), L.join(", "));
  assert.ok(L.indexOf("infra:pr-stats") > L.indexOf("role:pr-review:v1"), L.join(", "));
});

test("8.9.8 #124: stats writes are not counted as gates passed", () => {
  const src = readFileSync(join(HERE, "..", "src", "build-engine.js"), "utf8");
  assert.ok(flat(src).indexOf('state.gateLog.filter((x) => !/^(warning:|model used:|fallback:|infra:pr-stats)/.test(x)).length') >= 0);
});

test("8.9.8 #124: the README names the first-open write and the refresh at each later PR step", () => {
  const t = flat(README);
  assert.ok(t.indexOf("8.9.8 (yaadgaar `#124`)") >= 0, "README names 8.9.8 #124");
  assert.ok(t.indexOf("`infra:pr-stats:open`") >= 0);
});
