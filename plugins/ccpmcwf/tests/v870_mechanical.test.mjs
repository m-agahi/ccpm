// ccpmcwf 8.7.0 (yaadgaar #108 step 4, ADR-1397): mechanical handlers and the transient gap.
// 1. Transient: a null agent result of a read-only step (ccpmcwf:judge) gets one retry on the same
//    tier and agent type, recorded in auto_decisions; a second null stops as before. A write step
//    (any other agent type) keeps the stop: its first attempt may have written.
// 2. Mechanical: a refused PR body block (test block, stats block) is written once more; a second
//    refusal stops as before. The safety checks (program identity, the unattended header, the
//    truncated claims list) still stop at once.
// 3. Mechanical: one symbol over the inline relay cap goes to the on-disk caller path (no stop).
// 4. Budget: the run budget is checked before each code re-round, before each test-writer round
//    after the freeze, and before each review; each stop resumes.
// 5. args.checkpoint: typeof guards (NONCE_RE.test(undefined) matched "undefined").
//
// Run: node --test plugins/ccpmcwf/tests/v870_mechanical.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, HASHES, HASHES_FLAT, FP_K1, FP_K2, FP_PLAN, CSHA, H, happy, run, runOne, inputsOf, stateJsonOf, noUnscripted } from "./harness.mjs";

const autoOf = (out) => (out.result.auto_decisions || []).map((d) => d.gate + ":" + d.decision);
const count = (out, label) => out.labels.filter((l) => l === label).length;
const buildArgs = (plan) => {
  const b = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref });
  delete b.input;
  return b;
};

// ---------------------------------------------------------------- 1: transient

test("8.7.0 transient: a null result of a read-only step is retried once on the same tier and type, and recorded", async () => {
  const s = happy();
  s.intake = [null, s.intake];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(count(out, "intake"), 2);
  const two = out.calls.filter((c) => c.label === "intake");
  assert.equal(two[1].opts.model, two[0].opts.model);
  assert.equal(two[1].opts.agentType, "ccpmcwf:judge");
  assert.match(two[1].prompt, /returned no result/);
  assert.deepEqual(autoOf(out), ["transient:retry"]);
  assert.ok(out.result.gate_log.some((l) => /^auto: transient: retry \(intake returned no result/.test(l)), out.result.gate_log.join("\n"));
});

test("8.7.0 transient: a second null still stops", async () => {
  const s = happy();
  s.intake = [null, null];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /^agent intake returned no result/);
  assert.equal(count(out, "intake"), 2);
});

test("8.7.0 transient: a write step's null result is never retried (its first attempt may have written)", async () => {
  const s = happy();
  s.workspace = [null, s.workspace];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /^agent workspace returned no result/);
  assert.equal(count(out, "workspace"), 1);
});

// ---------------------------------------------------------------- 2: PR body blocks

const badBlock = (prompt) => {
  const a = inputsOf(prompt).args;
  return { status: "ok", reason: "written", replaced: false, edited: true, block_sha256: "9".repeat(64), claims: [], claims_truncated: false, body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: [], error: null, args: a };
};

test("8.7.0 PR body: a refused test block is written once more, recorded; the run goes on", async () => {
  const s = happy();
  s["infra:pr-tests"] = badBlock;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.labels.includes("infra:pr-tests:regen"), out.build.labels.join(", "));
  assert.ok(out.result.gate_log.some((l) => /^auto: pr-body: regenerate \(infra:pr-tests: the PR body's test block is not the script's block/.test(l)), out.result.gate_log.join("\n"));
});

test("8.7.0 PR body: a second refusal of the test block stops as before", async () => {
  const s = happy();
  s["infra:pr-tests"] = badBlock;
  s["infra:pr-tests:regen"] = badBlock;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "stats");
  assert.match(out.result.reason, /^infra:pr-tests:regen: the PR body's test block is not the script's block/);
});

test("8.7.0 PR body: a test block relay with other args stops at once (no rewrite), as the stats block does", async () => {
  const s = happy();
  s["infra:pr-tests"] = s["infra:pr-tests:args-retry"] = (p) => Object.assign(badBlock(p), { args: ["gh", "o/r", "8"].concat(inputsOf(p).args.slice(3)) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "stats");
  assert.match(out.result.reason, /^infra:pr-tests: the relayed result does not match the program's digest or arguments/);
  assert.ok(!out.build.labels.includes("infra:pr-tests:regen"), out.build.labels.join(", "));
});

test("8.7.0 PR body: a truncated claims list stops at once (safety ahead of the regeneration)", async () => {
  const s = happy();
  s["infra:pr-tests"] = (p) => Object.assign(badBlock(p), { claims_truncated: true });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /more test-count phrases than the program reports/);
  assert.ok(!out.build.labels.includes("infra:pr-tests:regen"));
});

test("8.7.0 PR body: a refused stats block is written once more; a second refusal stops", async () => {
  const err = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "written", replaced: false, wall_s: 120, block_sha256: "9".repeat(64), body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: [], error: null, args: a };
  };
  const s = happy();
  s["infra:pr-stats"] = err;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.labels.includes("infra:pr-stats:regen"), out.build.labels.join(", "));
  const t = happy();
  t["infra:pr-stats"] = err;
  t["infra:pr-stats:regen"] = err;
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.stop_gate, "stats");
  assert.match(o2.result.reason, /^infra:pr-stats:regen: the PR body's stats block is not the script's block/);
});

// ---------------------------------------------------------------- 3: relay size

test("8.7.0 relay size: one symbol over the inline relay cap goes to the on-disk caller path, not a stop", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "big", occurrences: [{ at: "src/big.py:1", criterion: "AC1", dont_care: null }] }];
  s["infra:callers"] = (p) => ({ status: "failed", reason: "FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap (99999 bytes; symbols: " + inputsOf(p).symbols.join(", ") + ")" });
  const out = await runOne(s, ARGS);
  assert.notEqual(out.result.stop_gate, "callers", out.result.reason);
  assert.ok(out.labels.includes("infra:callers:file"), out.labels.join(", "));
  assert.ok(out.result.gate_log.some((l) => /^auto: relay-size: page \(infra:callers: the occurrences of big are over the 65536-byte relay cap/.test(l)), out.result.gate_log.join("\n"));
});

// ---------------------------------------------------------------- 4: budget in the build loop

// spends nothing until on() is called, then 700000 output tokens per agent call
function lateSpend() {
  let n = 0;
  let live = false;
  return { on: () => (live = true), budget: { total: null, spent: () => (live ? (n += 700000) : n), remaining: () => Infinity } };
}
const after = (s, label, f) => {
  const o = s[label];
  s[label] = (p, opts) => {
    f();
    return typeof o === "function" ? o(p, opts) : o;
  };
};

test("8.7.0 budget: a build over the budget stops before a code re-round with freeze_digest; the re-run resumes at the coder", async () => {
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_code", routed_findings: [{ target: "code", criterion: "AC1", finding: "x" }] },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
    },
  });
  const plan = await runOne(s, ARGS);
  const ls = lateSpend();
  after(s, "role:fleet-code-judge:r1", ls.on);
  s.__budget = ls.budget;
  const b = await runOne(s, buildArgs(plan));
  assert.equal(b.result.stop_gate, "budget", b.result.reason);
  assert.match(b.result.reason, /before code round 2(;|$)/);
  assert.ok(!b.labels.includes("role:fleet-coder:r2"), b.labels.join(", "));
  assert.match(b.result.freeze_digest, /^[0-9a-f]{64}$/);
  assert.ok(b.result.plan_ref);
  delete s.__budget;
  const h = H(HASHES_FLAT);
  h.git["fleetref:" + plan.result.plan_ref.plan_ref.replace(/\/plan$/, "/freeze")] = "T1";
  s["hasher:resume-frozen"] = { status: "ok", fingerprint: { head: PB, tree: "K1" }, hashes: h };
  s["role:fleet-code-judge:r1"] = happy()["role:fleet-code-judge:r1"];
  const r = await runOne(s, Object.assign(buildArgs(plan), { freeze_digest: b.result.freeze_digest }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "frozen");
});

test("8.7.0 budget: a fix_tests re-round stops before its writers write, with freeze_digest", async () => {
  const f = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [f] },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [f] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
    },
  });
  const plan = await runOne(s, ARGS);
  const ls = lateSpend();
  after(s, "role:fleet-test-judge:r2", ls.on);
  s.__budget = ls.budget;
  const b = await runOne(s, buildArgs(plan));
  assert.equal(b.result.stop_gate, "budget", b.result.reason);
  assert.match(b.result.reason, /before test round 3(;|$)/);
  assert.ok(!b.labels.some((l) => /^role:fleet-test-writer:.*:r3$/.test(l)), b.labels.join(", "));
  assert.match(b.result.freeze_digest, /^[0-9a-f]{64}$/);
  // not re-frozen yet: the frozen resume runs the coder again on the coder's tree
  delete s.__budget;
  const h = H(HASHES_FLAT);
  h.git["fleetref:" + plan.result.plan_ref.plan_ref.replace(/\/plan$/, "/freeze")] = "T1";
  s["hasher:resume-frozen"] = { status: "ok", fingerprint: { head: PB, tree: "K1" }, hashes: h };
  s["role:fleet-code-judge:r1"] = happy()["role:fleet-code-judge:r1"];
  const r = await runOne(s, Object.assign(buildArgs(plan), { freeze_digest: b.result.freeze_digest }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "frozen");
});

test("8.7.0 budget: a code round after the first commit is not checked (the run-state resume refuses the coder's edits); the next review is", async () => {
  const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
  const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
  const s = happy();
  const rs = s["hasher:pre-review:v1"];
  Object.assign(s, {
    "role:pr-review:v1": REV("changes_requested", [CODE]),
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { exit_code: 0 } },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
    "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
    "role:pr-review:v2": REV("approve", []),
  });
  const plan = await runOne(s, ARGS);
  const ls = lateSpend();
  after(s, "role:pr-review:v1", ls.on);
  s.__budget = ls.budget;
  const b = await runOne(s, buildArgs(plan));
  assert.equal(b.result.stop_gate, "budget", b.result.reason);
  assert.match(b.result.reason, /before the review v2(;|$)/);
  assert.ok(b.labels.includes("role:fleet-coder:r2"), b.labels.join(", "));
});

test("8.7.0 budget: the first test round before the freeze is not checked (no resumable state before the freeze)", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": { status: "ok", verdict: "revise", routed_findings: [{ target: "tests", criterion: "AC2", finding: "weak assert" }] },
      "role:fleet-test-writer:AC2:r2": { status: "ok", criterion_id: "AC2" },
      "hasher:post-writers:r2": { status: "ok", fingerprint: FP_PLAN },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_PLAN },
    },
  });
  const plan = await runOne(s, ARGS);
  const ls = lateSpend();
  after(s, "role:fleet-test-judge:r1", ls.on);
  s.__budget = ls.budget;
  const b = await runOne(s, buildArgs(plan));
  assert.equal(b.result.stop_gate, "budget", b.result.reason);
  assert.match(b.result.reason, /before the coder(;|$)/);
  assert.ok(b.labels.includes("role:fleet-test-writer:AC2:r2"));
});

// the build's run-state writes, recorded per last_gate (as v600_s1)
function recording(s, states) {
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  return s;
}
function rerun(s, st) {
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: st.approved_sha, commits_since: [{ sha: st.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true };
  const h = JSON.parse(JSON.stringify(HASHES));
  h.git["fleetref:refs/fleet/y42/freeze"] = "T1";
  s["hasher:resume"] = { status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: h };
  return s;
}

test("8.7.0 budget: a build over the budget stops before the review, after the pr_open run-state; the re-run resumes at the review", async () => {
  const states = {};
  const s = recording(happy(), states);
  const plan = await runOne(s, ARGS);
  const ls = lateSpend();
  after(s, "role:fleet-pr-opener", ls.on);
  s.__budget = ls.budget;
  const b = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(b.result.stop_gate, "budget", b.result.reason);
  assert.match(b.result.reason, /before the review v1(;|$)/);
  assert.equal(states.pr_open.last_gate, "pr_open");
  assert.ok(!b.labels.includes("role:pr-review:v1"), b.labels.join(", "));
  assert.match(b.result.freeze_digest, /^[0-9a-f]{64}$/);
  delete s.__budget;
  rerun(s, states.pr_open);
  const r = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  noUnscripted(r);
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "review");
  assert.ok(r.labels.includes("role:pr-review:v1"));
  assert.ok(!r.labels.some((l) => /^role:fleet-coder/.test(l)), r.labels.join(", "));
});

// ---------------------------------------------------------------- 5: args.checkpoint shape

test("8.7.0 args.checkpoint: a missing run or a non-string sha256 is refused by the shape check", async () => {
  for (const ck of [{ sha256: "a".repeat(64) }, { run: "n1-0000001", sha256: ["a".repeat(64)] }, { run: ["n1-0000001"], sha256: "a".repeat(64) }]) {
    const out = await runOne(happy(), Object.assign({}, ARGS, { checkpoint: ck }));
    assert.equal(out.result.status, "needs_human", JSON.stringify(ck));
    assert.match(out.result.reason, /^args\.checkpoint must be the \{run, sha256\}/, JSON.stringify(ck));
    assert.deepEqual(out.labels, [], JSON.stringify(ck));
  }
});
