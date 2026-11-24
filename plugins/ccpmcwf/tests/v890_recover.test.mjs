// ccpmcwf 8.9.0 (yaadgaar #108 step 6, ADR-1387, ADR-1397, ADR-1406): every stop result carries
// recover: {class, action}, built in script code from the stop class and the run's own resume facts.
// 1. recover per class: safety none, judgment ask (the script options), mechanical resume_build,
//    transient rerun (with the exact resume args) or none (no clean resume point / already a re-run).
// 2. safety is never re-run: budget, agent cap, hook surface, relay mismatch.
// 3. each transient site's resume args re-enter at or before the failed check: stop, re-run with
//    the args, assert the failed step runs again.
// 4. the class, gate and options ride on the Stop: a cleanup halt never relabels the real stop;
//    two competing stops give the most severe class.
// 5. args.rerun_of: shape check (typeof first) and the once-only rule in the engine.
// 6. the SKILL text pins the once-only re-run rule.
//
// Run: node --test plugins/ccpmcwf/tests/v890_recover.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, PB, NONCE, DIST, HERE, HASHES, HASHES_FLAT, H, happy, run, runOne, inputsOf, programOf, programSha, relayDigestOf, K, stateJsonOf, commitStub } from "./harness.mjs";

const SKILL = readFileSync(join(HERE, "..", "skills", "build-task", "SKILL.md"), "utf8");
const README = readFileSync(join(HERE, "..", "README.md"), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const RUN2 = "n2-0000002";
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (caps) => (p) => ({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, caps), matched: "no policy file", error: null, now: 1000, args: inputsOf(p).args });
const watchOut = (st) => (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "w", state: st, checks: [{ name: "test", state: st === "green" ? "SUCCESS" : "PENDING", bucket: st === "green" ? "pass" : "pending", url: "https://github.com/o/r/actions/runs/77/job/88" }], failed: [], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
};
function rsErr(p, error) {
  const r = { status: "failed", reason: "the program reported an error", surface: [], sources: [], read: [], unreadable: [], error, args: inputsOf(p).args };
  r.program = programOf("ruleset_surface");
  r.file_sha256 = programSha("ruleset_surface");
  r.digest = relayDigestOf(r, K("ruleset_surface"));
  return r;
}
// the skill's re-launch: the stopped launch's args minus checkpoint and freeze_digest, a fresh nonce,
// every key of recover.args set; a build re-run drops input
function relaunch(args, rec) {
  const a = Object.assign({}, args, { run_nonce: RUN2 });
  delete a.checkpoint;
  delete a.freeze_digest;
  Object.assign(a, rec.args);
  if (a.mode === "build") delete a.input;
  return a;
}
const has = (out, l) => out.labels.includes(l);

// ---------------------------------------------------------------- 1: recover per class

test("8.9.0: ok and awaiting_confirmation carry recover null", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation");
  assert.ok("recover" in out.result);
  assert.equal(out.result.recover, null);
  const ok = await run(happy(), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.equal(ok.result.recover, null);
});

test("8.9.0: a safety stop recovers with action none", async () => {
  const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: [".fleet/x"], commits: [] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_class, "safety", out.result.reason);
  assert.deepEqual(out.result.recover, { class: "safety", action: "none" });
});

test("8.9.0: a judgment stop recovers with action ask and the script options, never picked", async () => {
  const s = happy();
  s["role:scope-and-plan"].criteria[1].id = "AC1";
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_class, "judgment", out.result.reason);
  assert.equal(out.result.recover.action, "ask");
  assert.equal(out.result.recover.class, "judgment");
  assert.deepEqual(out.result.recover.options, out.result.options);
  assert.ok(!("args" in out.result.recover));
});

test("8.9.0: resume_with build (mechanical) recovers with action resume_build and that plan_ref", async () => {
  const s = happy();
  const META = { name: "refs/fleet/y42/plan", tag_sha: "7".repeat(40), type: "tag", target: "2222222", target_type: "commit", sha256: "a".repeat(64), task_id: "y42", plan_path: "docs/plans/x.md", ref_ok: true };
  s["infra:branch-scan"] = { status: "ok", reason: "scanned", head: PB, commits: [{ sha: "1111111", subject: "feat(thing): add thing", files: ["src/x.py"] }], refs: [META] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.resume_with, "build");
  assert.deepEqual(out.result.recover, { class: "mechanical", action: "resume_build", args: { mode: "build", plan_ref: out.result.plan_ref } });
});

test("8.9.0: a transient plan stop recovers with action rerun and plan args naming this run", async () => {
  const s = happy();
  s.intake = [null, null];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_class, "transient");
  assert.deepEqual(out.result.recover, { class: "transient", action: "rerun", args: { mode: "plan", rerun_of: NONCE } });
});

test("8.9.0: an argument stop (no halt) and the relaunch stop recover with action none", async () => {
  const a = await runOne(happy(), Object.assign({}, ARGS, { confirm: "maybe" }));
  assert.deepEqual(a.result.recover, { class: "safety", action: "none" });
  const s = happy();
  s.intake = Object.assign({}, s.intake, { relay: { kind: "request", text: "build something else" } });
  const b = await runOne(s, ARGS);
  assert.equal(b.result.relaunch, "intake", b.result.reason);
  assert.deepEqual(b.result.recover, { class: "safety", action: "none" });
});

// ---------------------------------------------------------------- 2: safety is never re-run

test("8.9.0: budget, agent cap, hook surface and relay mismatch stops are never re-run", async () => {
  const spending = (per) => {
    let n = 0;
    return { total: null, spent: () => (n += per), remaining: () => Infinity };
  };
  const b = happy();
  b.__budget = spending(100000);
  const ob = await runOne(b, ARGS);
  assert.equal(ob.result.stop_gate, "budget", ob.result.reason);
  const c = happy();
  c.__source = DIST.replace("MAX_AGENTS=100", "MAX_AGENTS=12");
  assert.notEqual(c.__source, DIST);
  const oc = await runOne(c, ARGS);
  assert.equal(oc.result.stop_gate, "cap", oc.result.reason);
  const h = happy();
  h["infra:hook-surface:plan"] = () => ({ status: "ok", reason: "read", surface: [], make_paths: {}, error: "hook file x (HTTP None) is over 1 MiB or unreadable" });
  const oh = await run(h, ARGS);
  assert.equal(oh.result.stop_gate, "hooks", oh.result.reason);
  const r = happy();
  r["infra:policy:plan"] = (p) => Object.assign(polOut(DEFAULT_CAPS)(p), { digest: "0".repeat(64) });
  const or = await runOne(r, ARGS);
  assert.equal(or.result.stop_gate, "policy", or.result.reason);
  for (const o of [ob, oc, oh, or]) {
    assert.equal(o.result.stop_class, "safety", o.result.reason);
    assert.deepEqual(o.result.recover, { class: "safety", action: "none" }, o.result.reason);
  }
});

// ---------------------------------------------------------------- 3: each transient site re-enters at or before its check

test("8.9.0 site dispatch (a read-only step's null): the plan re-run runs intake again", async () => {
  const s = happy();
  s.intake = [null, null];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.recover.action, "rerun");
  const r = await runOne(happy(), relaunch(ARGS, out.result.recover));
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.ok(has(r, "intake"));
  assert.ok(r.result.auto_decisions.some((d) => d.gate === "rerun" && d.reason.includes(NONCE)), JSON.stringify(r.result.auto_decisions));
});

test("8.9.0 site callRole (a judge role's null): the plan re-run runs plan-audit again", async () => {
  const s = happy();
  s["role:plan-audit"] = [null];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun");
  assert.equal(out.result.recover.args.mode, "plan");
  const r = await runOne(happy(), relaunch(ARGS, out.result.recover));
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.ok(has(r, "role:plan-audit"));
});

test("8.9.0 site retryOnDrift (a judge role's null drift retry): the plan re-run runs plan-audit again", async () => {
  const s = happy();
  const ok = s["role:plan-audit"];
  s["role:plan-audit"] = Object.assign({}, ok, { verdict: "maybe" });
  s["role:plan-audit:retry"] = [null];
  const out = await runOne(s, ARGS);
  assert.match(out.result.reason, /role:plan-audit:retry returned no result/);
  assert.equal(out.result.stop_class, "transient");
  const r = await runOne(happy(), relaunch(ARGS, out.result.recover));
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.ok(has(r, "role:plan-audit"));
});

test("8.9.0 site hookReadStop (a ruleset read with no HTTP status): the plan re-run reads the surfaces again", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => rsErr(p, "rules of o/r branch master not readable (HTTP None)");
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun");
  const r = await runOne(happy(), relaunch(ARGS, out.result.recover));
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.ok(has(r, "infra:surfaces:plan"));
});

// A first build that records each run-state; resume(gate) scripts a build re-run from it
async function built(s) {
  const states = {};
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back", "infra:state:shipped"]) {
    const o = s[label];
    s[label] = (prompt, opts) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      if (typeof o === "function") return o(prompt, opts);
      return o || { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref });
  delete bargs.input;
  const first = await runOne(s, bargs);
  const resume = (gate) => {
    const x = states[gate];
    assert.ok(x, "the first build wrote the run-state " + gate);
    s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
    s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
    const h = JSON.parse(JSON.stringify(HASHES));
    h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
    s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
    return s;
  };
  return { first, bargs, resume, planRef: plan.result.plan_ref };
}

test("8.9.0 site buildFromRef CI unresolved: the build re-run resumes from the run-state and watches CI again", async () => {
  const s = happy();
  s["infra:policy"] = polOut(PERSONAL);
  s["infra:ci-watch:w1"] = watchOut("timeout");
  const { first, bargs, resume, planRef } = await built(s);
  assert.equal(first.result.stop_gate, "ci", first.result.reason);
  assert.equal(first.result.stop_class, "transient");
  assert.deepEqual(first.result.recover, { class: "transient", action: "rerun", args: { mode: "build", plan_ref: planRef, rerun_of: NONCE } });
  resume("written_back");
  s["infra:ci-watch:w1"] = watchOut("green");
  const r = await runOne(s, relaunch(bargs, first.result.recover));
  assert.equal(r.result.resumed_at, "stats", r.result.reason);
  assert.ok(has(r, "infra:ci-watch:w1"), r.labels.join(", "));
  assert.ok(!r.labels.some((l) => /^role:fleet-(test-writer|coder)/.test(l)));
});

test("8.9.0 site callRole after the freeze (code judge null): the frozen re-run runs the coder and the code judge again", async () => {
  const s = happy();
  s["role:fleet-code-judge:r1"] = [null];
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  const planRef = out.planResult.plan_ref;
  assert.deepEqual(out.result.recover, { class: "transient", action: "rerun", args: { mode: "build", plan_ref: planRef, freeze_digest: out.result.freeze_digest, rerun_of: NONCE } });
  const t = s;
  t["role:fleet-code-judge:r1"] = happy()["role:fleet-code-judge:r1"];
  const h = H(HASHES_FLAT);
  h.git["fleetref:" + planRef.plan_ref.replace(/\/plan$/, "/freeze")] = "T1";
  t["hasher:resume-frozen"] = { status: "ok", fingerprint: { head: PB, tree: "K1" }, hashes: h };
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: planRef });
  const r = await runOne(t, relaunch(bargs, out.result.recover));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "frozen");
  assert.ok(has(r, "role:fleet-code-judge:r1"));
  assert.ok(!r.labels.some((l) => /^role:fleet-test-(writer|judge)/.test(l)));
});

test("8.9.0: a judge null after the test writers wrote, before the freeze, has no clean resume point (none)", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"] = [null];
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "none");
  assert.equal(out.result.recover.class, "transient");
  assert.match(out.result.recover.why, /test writers/);
});

test("8.9.0: a judge null in the build before any writer re-runs the build from the start", async () => {
  const s = happy();
  s["infra:verify-plan"] = [null, null];
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  const planRef = out.planResult.plan_ref;
  assert.deepEqual(out.result.recover.args, { mode: "build", plan_ref: planRef, rerun_of: NONCE });
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: planRef });
  s["infra:verify-plan"] = happy()["infra:verify-plan"];
  const r = await runOne(s, relaunch(bargs, out.result.recover));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(has(r, "infra:verify-plan"));
});

const INTENT_OK = {
  "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" } },
  "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
};
test("8.9.0: a plan launch that built in the same run re-runs as a build with confirm auto (the gates run again)", async () => {
  const s = Object.assign(happy(), INTENT_OK);
  s["role:fleet-code-judge:r1"] = [null];
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun");
  assert.equal(out.result.recover.args.mode, "build");
  assert.equal(out.result.recover.args.confirm, "auto");
  assert.deepEqual(out.result.recover.args.plan_ref, out.result.plan_ref);
  assert.equal(out.result.recover.args.freeze_digest, out.result.freeze_digest);
  // and a stop in the auto gates (before the build) re-runs the plan
  const g = Object.assign(happy(), INTENT_OK, { "role:fleet-intent-judge": [null] });
  const og = await runOne(g, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(og.result.stop_class, "transient", og.result.reason);
  assert.deepEqual(og.result.recover.args, { mode: "plan", rerun_of: NONCE });
  const r = await runOne(Object.assign(happy(), INTENT_OK), relaunch(Object.assign({}, ARGS, { confirm: "auto" }), og.result.recover));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(has(r, "role:fleet-intent-judge"));
});

// ---------------------------------------------------------------- 4: the class on the Stop

test("8.9.0: a swallowed cleanup halt after a transient stop never relabels its gate; the most severe class wins", async () => {
  // the transient ruleset stop in plan; main's cleanup halts safety (another gate) and swallows it
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => rsErr(p, "rules of o/r branch master not readable (HTTP None)");
  const at = "async function lockRelease(){";
  s.__source = DIST.replace(at, at + 'try{halt("s","failed","cleanup y","ci")}catch(e){}');
  assert.notEqual(s.__source, DIST);
  const out = await runOne(s, ARGS);
  assert.ok(out.result.gate_log.includes("cleanup y"), "the injected halt ran");
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
  assert.match(out.result.reason, /transient GitHub read failure/);
  assert.equal(out.result.stop_class, "safety");
  assert.deepEqual(out.result.recover, { class: "safety", action: "none" });
});

test("8.9.0: a swallowed transient halt in main's cleanup never relabels a safety stop", async () => {
  const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: [".fleet/x"], commits: [] } } });
  // fault injection: lockRelease halts transient (with another gate) and swallows it
  const at = "async function lockRelease(){";
  assert.ok(DIST.includes(at), "the dist holds " + at);
  s.__source = DIST.replace(at, at + 'try{halt("t","failed","cleanup x","ci")}catch(e){}');
  assert.notEqual(s.__source, DIST);
  const out = await run(s, ARGS);
  assert.ok(out.result.gate_log.includes("cleanup x"), "the injected halt ran");
  assert.equal(out.result.stop_gate, "scope", out.result.reason);
  assert.equal(out.result.stop_class, "safety");
  assert.deepEqual(out.result.recover, { class: "safety", action: "none" });
});

test("8.9.0: a swallowed halt before the real stop does not count (only stops raised after it compete)", async () => {
  const s = happy();
  s["role:fleet-code-judge:r1"] = [null];
  const at = "async function preflightStep(";
  assert.ok(DIST.includes(at), "the dist holds " + at);
  s.__source = DIST.replace(/async function preflightStep\(([^)]*)\)\{/, (m) => m + 'try{halt("s","failed","early x")}catch(e){}');
  assert.notEqual(s.__source, DIST);
  const out = await run(s, ARGS);
  assert.ok(out.result.gate_log.includes("early x"), "the injected halt ran");
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun");
});

// ---------------------------------------------------------------- review: re-plan and update-branch

const PC2 = "0123456789ab";
const PLAN_WRONG = { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: split AC2" }] };
test("8.9.0 review: a build launch that re-planned and built the new plan in the run re-runs with confirm auto and the new plan_ref", async () => {
  const s = Object.assign(happy(), INTENT_OK, { "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" } });
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  Object.assign(s, {
    "role:fleet-code-judge:r1": [PLAN_WRONG, null],
    "infra:replan-worktree": [{ status: "ok", reason: "ok", head: plan.result.plan_ref.plan_commit }, { status: "ok", reason: "ok", head: PC2 }],
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: "a".repeat(64) },
    "infra:commit-plan:replan": commitStub(s.__store, PC2, "a".repeat(64)),
    "infra:replan-reset": (p) => ({ status: "ok", reason: "reset", head: PB, superseded_head: inputsOf(p).expected_head }),
    "hasher:pre-intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "hasher:fp-post:intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge:replan": s["role:fleet-intent-judge"],
  });
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref, unattended: true });
  delete bargs.input;
  const out = await runOne(s, bargs);
  assert.ok(out.labels.includes("infra:replan-reset"), out.labels.join(", "));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun");
  assert.equal(out.result.recover.args.confirm, "auto");
  assert.notDeepEqual(out.result.recover.args.plan_ref, plan.result.plan_ref);
  assert.equal(out.result.recover.args.plan_ref.plan_commit, PC2);
});

test("8.9.0 review: a stop after update-branch moved the worktree, before its run-state, has no clean resume point", async () => {
  const s = happy();
  s["infra:policy"] = polOut(PERSONAL);
  s["infra:pr-merge"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
  };
  s["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: "d".repeat(40), base: "c".repeat(40), overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
  Object.assign(s, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: "d".repeat(40), tree: "KU" }, hashes: HASHES },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: "d".repeat(40), tree: "KU" } },
    "role:pr-review:v2": [null],
  });
  const out = await run(s, ARGS);
  assert.ok(out.build.labels.includes("infra:pr-fetch:u1"), out.build.labels.join(", "));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "none");
  assert.match(out.result.recover.why, /after the run-state written_back/);
});

test("8.9.0 review: the no-args return carries recover safety none", () => {
  assert.match(DIST.replace(/\s+/g, ""), /stop_class:"safety",reason:"build-enginewasstartedwithoutargs[^"]*",recover:\{class:"safety",action:"none"\}/);
});

// ---------------------------------------------------------------- 5: rerun_of

test("8.9.0: args.rerun_of must be a run nonce other than this run's (typeof checked first)", async () => {
  for (const bad of [123, null, "undefined x", "", ["n0-0000009"], { a: 1 }, NONCE]) {
    const out = await runOne(happy(), Object.assign({}, ARGS, { rerun_of: bad }));
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.match(out.result.reason, /^args\.rerun_of must be/, JSON.stringify(bad));
    assert.equal(out.result.stop_class, "safety");
  }
  const ok = await runOne(happy(), Object.assign({}, ARGS, { rerun_of: "n0-0000009" }));
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(ok.result.gate_log.some((l) => /rerun: rerun \(the automatic re-run of run n0-0000009 after a transient stop\)/.test(l)), ok.result.gate_log.join("\n"));
});

test("8.9.0: a second transient stop in the re-run is reported, never re-run again (engine once-only)", async () => {
  const s = happy();
  s.intake = [null, null];
  const out = await runOne(s, Object.assign({}, ARGS, { rerun_of: "n0-0000009" }));
  assert.equal(out.result.stop_class, "transient");
  assert.equal(out.result.recover.action, "none");
  assert.match(out.result.recover.why, /already the automatic re-run of run n0-0000009/);
});

// ---------------------------------------------------------------- 6: the SKILL and README text

test("8.9.0: the SKILL re-runs a recover rerun once, with a fresh nonce and recover.args, and reports a second stop", () => {
  const t = flat(SKILL);
  for (const p of [
    'recover.action` is `"rerun"`',
    "re-launch the same Workflow once, in the same turn",
    "a fresh `run_nonce`",
    "minus `checkpoint` and `freeze_digest`",
    "every key of `recover.args`",
    "drop `input`",
    "Never more than one automatic re-run per user launch",
    "A second transient stop: report it",
    "keep `rerun_of` in every later launch",
    'recover.action` is `"ask"`',
    "show each option verbatim as a numbered choice and stop",
    "never pick an option yourself",
    'recover.action` is `"none"`',
    // review: none means no automatic re-run; the per-gate rules (relaunch next turn, iac-push, rulings) still apply
    "`recover` decides only the automatic re-run; the per-gate rules elsewhere in this skill still apply",
    "re-launched on the next turn as step 5 says",
    "no automatic re-run. Report it as in step 9, then follow that stop's own rule in this skill",
    "until the next human message",
    "never `resumeFromRunId`",
    "a newer human message",
  ])
    assert.ok(t.includes(p), "SKILL lacks: " + p);
  // the re-run is recorded in the report
  assert.ok(/automatic re-run[^.]*report/i.test(t) || /report[^.]*automatic re-run/i.test(t));
});

test("8.9.0: the README documents recover per class", () => {
  const t = flat(README);
  for (const p of ["`recover: {class, action}`", "`rerun_of`", "no clean resume point", "at or before the failed check"]) assert.ok(t.includes(p), "README lacks: " + p);
});
