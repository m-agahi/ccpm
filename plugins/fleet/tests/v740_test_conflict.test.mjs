// fleet 7.4.0 car 6 (#61): test conflicts and plan-target review findings.
// - Y1: the coder returns needs_human with a well-formed test_conflict {test, findings, why} ->
//   no halt: the code judge runs this round with the input test_conflict; its plan_wrong starts a
//   re-plan (planWrong("code-judge")). Any verdict but plan_wrong or fix_tests -> the role halt.
// - Y2: the coder returns needs_human with no test_conflict -> the halt as before (stop_gate role).
//   A coder that changed a frozen file AND returns test_conflict still stops at the hash gate.
// - Y3: a blocking pr-review finding with target "plan" -> no coder round; planWrong("pr-review").
// - Q4 (Max ruling (b), NOT the plan's default (a)): under unattended with the PR open, that
//   re-plan is built in the same run (once per run, the auto gates first: the intent judge rules
//   on a relaxed re-plan, and every safety stop applies), and the new commits go on the open PR
//   with no force push: the rebuilt first commit is made on the open PR's head (the superseded
//   head, kept on its superseded ref), so the push is a fast-forward. An interactive run asks.
//
// dont_care: gate-log wording beyond the pinned phrases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, PB, PC, PSHA, FP_K1, FP_TESTS, H, HASHES, happy, run, runOne, call, inputsOf, commitStub, spawnSync } from "./harness.mjs";

const U = { ...ARGS, unattended: true };
const PC2 = "0123456789ab";
const OLD_HEAD = "5555555";
const CONFLICT = { test: "tests/test_a.py", findings: ["S1"], why: "the test expects 3 but AC1's example says 4" };
const coderConflict = (extra) => Object.assign({ status: "needs_human", reason: "frozen test contradicts AC1", changed_paths: null, suite_result: null, added_symbols: null, frozen_tests_red_at_start: null, obligations_done: null, test_conflict: CONFLICT }, extra || {});
const PLAN_WRONG = { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC1", finding: "AC1 example conflicts — Proposed plan change: fix AC1's example" }], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 1 }, gates_not_run: [], obligations_check: [] };

// the re-plan steps (as v630_unattended's planWrong helper)
function replanStubs(s) {
  return Object.assign(s, {
    "infra:replan-worktree": [{ status: "ok", reason: "ok", head: PC }, { status: "ok", reason: "ok", head: PC2 }],
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan:replan": [commitStub(s.__store, PC2, PSHA), commitStub(s.__store, "0123456789cd", PSHA)],
    "infra:replan-reset": { status: "ok", reason: "reset", head: PB, superseded_head: OLD_HEAD },
    "hasher:pre-intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "hasher:fp-post:intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  });
}
// happy plus the auto-gate stubs (v630_unattended's gated)
function gated() {
  const s = happy();
  return Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
}
const decisions = (out) => (out.result.auto_decisions || []).map((d) => d.gate + ": " + d.decision + " (" + d.reason + ")");

// ---------------------------------------------------------------- Y1, Y2: the coder's test conflict

test("7.4.0 #61 Y1: a coder test_conflict goes to the code judge (input test_conflict); its plan_wrong re-plans", async () => {
  const s = replanStubs(happy());
  s["role:fleet-coder:r1"] = coderConflict();
  s["role:fleet-code-judge:r1"] = PLAN_WRONG;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.match(out.result.reason, /code-judge plan_wrong: re-planned/);
  const ji = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(ji.test_conflict, CONFLICT);
  assert.ok(out.logs.some((l) => /code round 1: the coder names a test conflict in tests\/test_a\.py \(S1\) -> code judge/.test(l)), out.logs.join("\n"));
  assert.ok(out.labels.includes("infra:replan-reset"));
});

test("7.4.0 #61 Y1: on a test conflict, a judge verdict other than plan_wrong or fix_tests is the role halt", async () => {
  for (const verdict of ["approve", "fix_code"]) {
    const s = replanStubs(happy());
    s["role:fleet-coder:r1"] = coderConflict();
    s["role:fleet-code-judge:r1"] = Object.assign({}, PLAN_WRONG, { verdict, routed_findings: verdict === "fix_code" ? [{ target: "code", criterion: null, finding: "x" }] : [] });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", verdict + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "role", verdict);
    assert.match(out.result.reason, /fleet-coder returned needs_human: frozen test contradicts AC1/);
    assert.ok(!out.labels.includes("infra:commit:r1"), verdict);
  }
});

test("7.4.0 #61 Y2: a coder needs_human with no test_conflict, or a malformed one, halts as before", async () => {
  for (const tc of [undefined, null, { test: "tests/test_a.py" }, { test: "", findings: [], why: "x" }, { test: "t", findings: "S1", why: "x" }]) {
    const s = happy();
    const c = coderConflict();
    if (tc === undefined) delete c.test_conflict;
    else c.test_conflict = tc;
    s["role:fleet-coder:r1"] = c;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(tc));
    assert.equal(out.result.stop_gate, "role", JSON.stringify(tc));
    assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), JSON.stringify(tc));
  }
});

test("7.4.0 #61 Y2: a coder that changed a frozen file and names a test conflict stops at the hash gate", async () => {
  const s = happy();
  s["role:fleet-coder:r1"] = coderConflict();
  const h = JSON.parse(JSON.stringify(HASHES));
  h.files["tests/test_a.py"] = "edited";
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: h };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hash");
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

// ---------------------------------------------------------------- Y3: a plan-target review finding

const REVIEW_PLAN = {
  status: "ok",
  reason: "plan conflict",
  verdict: "changes_requested",
  findings: [{ id: "R1", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "the fix contradicts frozen test tests/test_a.py", evidence: "AC1 says 4", target: "plan" }],
  touches_gate: false,
  checked: ["diff"],
};

test("7.4.0 #61 Y3: a blocking pr-review finding with target plan re-plans; no coder round runs (interactive: asks)", async () => {
  const s = replanStubs(happy());
  s["role:pr-review:v1"] = REVIEW_PLAN;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.match(out.result.reason, /pr-review plan_wrong: re-planned/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"), out.labels.join(", "));
  assert.ok(out.result.plan_findings.some((f) => /R1 \[correctness\] src\/x\.py:3: the fix contradicts frozen test/.test(f.finding)), JSON.stringify(out.result.plan_findings));
  // the replan reset saves the pushed head and the shipped tree
  const ri = inputsOf(call(out, "infra:replan-reset").prompt);
  assert.equal(ri.expected_head, "c000001");
});

test("7.4.0 #61 Y3: code-target findings of the same review still go to the coder when no finding targets the plan", async () => {
  const s = happy();
  s["role:pr-review:v1"] = [Object.assign({}, REVIEW_PLAN, { findings: [Object.assign({}, REVIEW_PLAN.findings[0], { target: "code" })] }), happy()["role:pr-review:v1"]];
  s["role:fleet-coder:r2"] = s["role:fleet-coder:r1"];
  s["hasher:post-coder:r2"] = s["hasher:post-coder:r1"];
  s["role:fleet-code-judge:r2"] = s["role:fleet-code-judge:r1"];
  s["hasher:fp-post:code-judge:r2"] = s["hasher:fp-post:code-judge:r1"];
  s["infra:review-paths:v2"] = s["infra:review-paths:v1"];
  s["hasher:pre-review:v2"] = s["hasher:pre-review:v1"];
  s["role:pr-review:v2"] = happy()["role:pr-review:v1"];
  s["hasher:fp-post:pr-review:v2"] = s["hasher:fp-post:pr-review:v1"];
  s["infra:review-cleanup:v2"] = s["infra:review-cleanup:v1"];
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("role:fleet-coder:r2"), out.result.reason + "\n" + out.labels.join(", "));
  assert.ok(!out.labels.includes("infra:replan-reset"));
});

// ---------------------------------------------------------------- Q4 (b): unattended with the PR open

function q4(over) {
  const s = replanStubs(gated());
  s["role:fleet-intent-judge:replan"] = s["role:fleet-intent-judge"];
  s["role:pr-review:v1"] = [REVIEW_PLAN, happy()["role:pr-review:v1"]];
  // the freeze and post-coder stubs carry the maps forward (harness: a stub's own git map gets the
  // run-state refs added on its first call only, so the second build would see stale refs)
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_TESTS };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1 };
  return Object.assign(s, over || {});
}
const commits = (out) => out.calls.filter((c) => c.label === "infra:commit:r1");

test("7.4.0 #61 Q4 (b): unattended with the PR open: the re-plan is built in this run and its commit goes on the open PR's head", async () => {
  const out = await runOne(q4(), U);
  // the rebuilt head is pushed; its review does not fit the 100-agent cap of one run (a whole build
  // with a PR, a re-plan and a second whole build): the run stops there, after the fast-forward push
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "cap");
  assert.match(out.result.reason, /more needed for review 1$/);
  assert.equal(out.labels.filter((l) => l === "infra:push").length, 2);
  assert.ok(decisions(out).includes("plan_wrong: build (pr-review re-plan 1: the auto gates, then the build in this run; the PR is open: the new commits go on its head " + OLD_HEAD + ", never force-pushed)"), decisions(out).join("\n"));
  const i = out.labels.indexOf("infra:replan-reset");
  assert.ok(i > 0);
  for (const l of ["role:fleet-intent-judge:replan", "infra:verify-plan", "role:fleet-coder:r1", "infra:push"]) assert.ok(out.labels.slice(i).includes(l), l);
  const cs = commits(out);
  assert.equal(cs.length, 2);
  // the first build's commit is made on the plan base; the rebuilt one on the open PR's head
  assert.ok(!("parent" in inputsOf(cs[0].prompt)));
  assert.equal(inputsOf(cs[1].prompt).parent, OLD_HEAD);
  assert.match(cs[1].prompt, /reset --soft <parent>/);
  assert.doesNotMatch(cs[1].prompt, /--force/);
  // no push forces; the second push is a plain push of the new head
  for (const c of out.calls.filter((x) => /^infra:push/.test(x.label))) assert.doesNotMatch(c.prompt.replace(/Never --force/g, ""), /--force|\+refs/);
  assert.ok(out.logs.some((l) => /committed tree .* on the open PR's head 5555555/.test(l)), out.logs.join("\n"));
});

test("7.4.0 #61 Q4 (b): a commit not made on the open PR's head stops (the push would need a force)", async () => {
  const s = q4();
  let n = 0;
  const orig = s["infra:commit:r1"];
  s["infra:commit:r1"] = (p) => Object.assign(orig(p), ++n === 2 ? { parent: PB } : {});
  const out = await runOne(s, U);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "commit");
  assert.match(out.result.reason, /not the open PR's head 5555555/);
  assert.ok(out.labels.filter((l) => l === "infra:push").length === 1, out.labels.join(", "));
});

test("7.4.0 #61 Q4 (b): with the PR open the auto path keeps every safety stop", async () => {
  // the intent judge refuses the re-plan
  const ij = await runOne(q4({ "role:fleet-intent-judge:replan": { status: "ok", reason: "no", verdict: "refuse", deviations: [], coverage: { covered: false, missing: ["AC1"] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } } }), U);
  assert.equal(ij.result.status, "needs_human", ij.result.reason);
  assert.equal(ij.result.failed_check, "intent");
  // the re-plan touches the hook surface
  const s = q4();
  s["role:scope-and-plan:replan"] = Object.assign({}, s["role:scope-and-plan:replan"], { allowed_additions: { files: [".github/workflows/ci.yml"], symbols: [], deps: [], settings: [] } });
  const hk = await runOne(s, U);
  assert.equal(hk.result.status, "needs_human", hk.result.reason);
  assert.equal(hk.result.stop_gate, "hooks");
  assert.equal(commits(hk).length, 1);
  // the re-plan touches an IaC path: asks (as the first plan does)
  const t = q4();
  t["role:scope-and-plan:replan"] = Object.assign({}, t["role:scope-and-plan:replan"], { allowed_additions: { files: ["src/main.tf"], symbols: [], deps: [], settings: [] } });
  const iac = await runOne(t, U);
  assert.equal(iac.result.status, "awaiting_confirmation", iac.result.reason);
  assert.ok(decisions(iac).includes("plan_wrong: ask (pr-review re-plan 1: plan touches IaC path src/main.tf)"), decisions(iac).join("\n"));
  assert.ok(!iac.labels.includes("role:fleet-intent-judge:replan"));
  assert.equal(commits(iac).length, 1);
});

test("7.4.0 #61 Q4: an interactive run with the PR open still asks; a second re-plan in one run asks", async () => {
  const ask = await runOne(q4(), { ...ARGS, confirm: "auto" });
  assert.equal(ask.result.status, "awaiting_confirmation", ask.result.reason);
  assert.ok(!ask.labels.includes("role:fleet-intent-judge:replan"));
  assert.equal(commits(ask).length, 1);
  // the rebuilt run's code judge finds the plan wrong again: once per run, so it asks
  const two = await runOne(q4({ "role:fleet-code-judge:r1": [happy()["role:fleet-code-judge:r1"], PLAN_WRONG] }), U);
  assert.equal(two.result.status, "awaiting_confirmation", two.result.reason);
  assert.ok(decisions(two).some((d) => /^plan_wrong: ask \(code-judge re-plan 2: the run already built one re-plan\)$/.test(d)), decisions(two).join("\n"));
  assert.equal(commits(two).length, 1);
});

// ---------------------------------------------------------------- the commit on the PR head, real git

test("7.4.0 #61 Q4 (b): the commit-step recipe on real git: the new commit sits on the old head, the push is a fast-forward", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-740q4-"));
  try {
    const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(home, ".gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    const g = (cwd, ...a) => {
      const r = spawnSync("git", ["-C", cwd, "-c", "commit.gpgsign=false"].concat(a), { encoding: "utf8", env });
      assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
      return r.stdout.trim();
    };
    const origin = join(home, "origin.git");
    const wt = join(home, "wt");
    spawnSync("git", ["init", "-q", "--bare", origin], { env });
    spawnSync("git", ["init", "-q", "-b", "main", wt], { env });
    writeFileSync(join(wt, "a.txt"), "base\n");
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", "base");
    const planBase = g(wt, "rev-parse", "HEAD");
    g(wt, "remote", "add", "origin", origin);
    g(wt, "checkout", "-q", "-b", "fleet/x");
    // the first build: pushed, the PR is open on it
    writeFileSync(join(wt, "a.txt"), "old build\n");
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", "fix(x): old");
    const oldHead = g(wt, "rev-parse", "HEAD");
    g(wt, "push", "-q", "origin", "fleet/x");
    // the re-plan reset: superseded ref, then the branch back at plan_base
    g(wt, "branch", "fleet/x--superseded-1", oldHead);
    g(wt, "reset", "-q", "--hard", planBase);
    // the rebuilt work, then the commit step with <parent>
    writeFileSync(join(wt, "a.txt"), "new build\n");
    g(wt, "add", "-A");
    const codeTree = g(wt, "write-tree");
    g(wt, "reset", "--soft", oldHead);
    assert.equal(g(wt, "write-tree"), codeTree, "the index keeps the code tree after reset --soft");
    g(wt, "commit", "-q", "-m", "fix(x): new");
    assert.equal(g(wt, "rev-parse", "HEAD^"), oldHead);
    assert.equal(g(wt, "rev-parse", "HEAD^{tree}"), codeTree);
    // a plain push (no force) is accepted: a fast-forward
    g(wt, "push", "-q", "origin", "fleet/x");
    assert.equal(g(origin, "rev-parse", "fleet/x"), g(wt, "rev-parse", "HEAD"));
    assert.equal(g(wt, "rev-parse", "fleet/x--superseded-1"), oldHead, "the superseded work stays on its ref");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
