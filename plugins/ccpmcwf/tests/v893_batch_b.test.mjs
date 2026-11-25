// ccpmcwf 8.9.3 (yaadgaar #117, #108 follow-ups batch B; ADR-1415, ADR-1406, ADR-1387).
// (d) a run-state milestone after ready (ready -> ci) records the stats post and pr_ready; a transient CI stop
//     records its CI write-back in that run-state, so the re-run resumes at the CI watch and posts neither again.
// (f) a plan stop after the plan ref is committed (before the build) re-runs as a build of that ref.
// (i) automatic decisions made after the PR body was written reach the CI write-back (gate and decision only).
//
// Run: node --test plugins/ccpmcwf/tests/v893_batch_b.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, PB, NONCE, HERE, DIST, HASHES, happy, runOne, inputsOf, stateJsonOf } from "./harness.mjs";

const README = readFileSync(join(HERE, "..", "README.md"), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const RUN2 = "n2-0000002";
const has = (out, l) => out.labels.includes(l);
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (caps) => (p) => ({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, caps), matched: "no policy file", error: null, now: 1000, args: inputsOf(p).args });
const watchOut = (st) => (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "w", state: st, checks: [{ name: "test", state: st === "green" ? "SUCCESS" : "PENDING", bucket: st === "green" ? "pass" : "pending", url: "https://github.com/o/r/actions/runs/77/job/88" }], failed: [], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
};
function relaunch(args, rec) {
  const a = Object.assign({}, args, { run_nonce: RUN2 });
  delete a.checkpoint;
  delete a.freeze_digest;
  Object.assign(a, rec.args);
  if (a.mode === "build") delete a.input;
  return a;
}

// A first build that records every run-state write by label; resume(label) scripts a build re-run from one
const STATE_LABELS = ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back", "infra:state:ready", "infra:state:ready:ci-wb", "infra:state:shipped"];
async function built(s, bargs0) {
  const states = {};
  for (const label of STATE_LABELS) {
    const o = s[label];
    s[label] = (prompt, opts) => {
      states[label] = stateJsonOf(prompt);
      if (typeof o === "function") return o(prompt, opts);
      return o || { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref }, bargs0 || {});
  delete bargs.input;
  const first = await runOne(s, bargs);
  const resume = (label, edit) => {
    assert.ok(states[label], "the first build wrote " + label);
    const x = JSON.parse(JSON.stringify(states[label]));
    if (edit) edit(x);
    s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
    s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
    const h = JSON.parse(JSON.stringify(HASHES));
    h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
    s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
    return s;
  };
  return { first, bargs, resume, states, planRef: plan.result.plan_ref };
}

// ---------------------------------------------------------------- (d) the ready milestone and the CI write-back record

test("8.9.3 (d): a build writes the run-state ready after the stats block and ready, before the CI watch; it records pr_ready", async () => {
  const s = happy();
  const { first, states } = await built(s);
  assert.equal(first.result.status, "ok", first.result.reason);
  const L = first.labels;
  const i = L.indexOf("infra:state:ready");
  assert.ok(i > L.indexOf("infra:pr-stats") && i > L.indexOf("infra:pr-ready") && i < L.indexOf("infra:ci-watch:w1"), L.join(", "));
  assert.equal(states["infra:state:ready"].last_gate, "ready");
  assert.equal(states["infra:state:ready"].pr_ready, true);
  assert.ok(!("ci_write_back" in states["infra:state:ready"]));
  // the shipped run-state holds the run's CI write-back
  assert.deepEqual(states["infra:state:shipped"].ci_write_back, first.result.ci_write_back);
  assert.ok(!has(first, "infra:state:ready:ci-wb"), L.join(", "));
});

test("8.9.3 (d): a CI-timeout stop records its CI write-back in the ready run-state; the re-run resumes at the CI watch and posts no stats block, ready or CI write-back again", async () => {
  const s = happy();
  s["infra:policy"] = polOut(PERSONAL);
  s["infra:ci-watch:w1"] = watchOut("timeout");
  const { first, bargs, resume, states, planRef } = await built(s);
  assert.equal(first.result.stop_gate, "ci", first.result.reason);
  assert.equal(first.result.stop_class, "transient");
  assert.deepEqual(first.result.recover, { class: "transient", action: "rerun", args: { mode: "build", plan_ref: planRef, rerun_of: NONCE } });
  const L = first.labels;
  assert.ok(L.indexOf("infra:yaadgaar-writeback:ci") < L.indexOf("infra:state:ready:ci-wb"), L.join(", "));
  const rec = states["infra:state:ready:ci-wb"];
  assert.equal(rec.last_gate, "ready");
  assert.deepEqual(rec.ci_write_back, first.result.ci_write_back);
  assert.equal(rec.ci_write_back.ledger_status, "ok");
  resume("infra:state:ready:ci-wb");
  s["infra:ci-watch:w1"] = watchOut("green");
  const r = await runOne(s, relaunch(bargs, first.result.recover));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "ci", r.result.reason);
  assert.ok(has(r, "infra:ci-watch:w1"), r.labels.join(", "));
  for (const l of ["infra:pr-stats", "infra:pr-ready", "infra:yaadgaar-read:ci", "infra:yaadgaar-writeback:ci", "infra:yaadgaar-writeback"]) assert.ok(!has(r, l), l + ": " + r.labels.join(", "));
  // the policy merges the green PR (no run-end stats refresh on a merged PR); the result names the recorded write-back
  assert.ok(has(r, "infra:pr-merge") && has(r, "infra:state:shipped"), r.labels.join(", "));
  assert.deepEqual(r.result.ci_write_back, rec.ci_write_back);
  assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
});

test("8.9.3 (d): a re-run from a ready run-state with no CI write-back record watches CI and writes the CI write-back", async () => {
  const s = happy();
  const { first, bargs, resume } = await built(s);
  assert.equal(first.result.status, "ok", first.result.reason);
  resume("infra:state:ready");
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "ci");
  assert.ok(has(r, "infra:ci-watch:w1") && has(r, "infra:yaadgaar-writeback:ci"), r.labels.join(", "));
  assert.ok(!has(r, "infra:pr-stats") && !has(r, "infra:pr-ready"), r.labels.join(", "));
});

test("8.9.3 (d): a ready run-state with pr_ready false resumes with the PR as a draft: no CI watch", async () => {
  const s = happy();
  const { bargs, resume } = await built(s);
  resume("infra:state:ready", (x) => (x.pr_ready = false));
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(!has(r, "infra:ci-watch:w1"), r.labels.join(", "));
  assert.match(r.result.reason, /CI not run on draft/);
});

test("8.9.3 (d): an older run-state at written_back (no ready milestone, no new keys) still resumes at stats, ready, then CI", async () => {
  const s = happy();
  s["infra:policy"] = polOut(PERSONAL);
  s["infra:ci-watch:w1"] = watchOut("timeout");
  const { first, bargs, resume } = await built(s);
  resume("infra:state:written_back", (x) => {
    delete x.pr_ready;
    delete x.ci_write_back;
  });
  s["infra:ci-watch:w1"] = watchOut("green");
  const r = await runOne(s, relaunch(bargs, first.result.recover));
  assert.equal(r.result.resumed_at, "stats", r.result.reason);
  for (const l of ["infra:pr-stats", "infra:pr-ready", "infra:ci-watch:w1", "infra:state:ready"]) assert.ok(has(r, l), l + ": " + r.labels.join(", "));
});

test("8.9.3 (d): a malformed pr_ready or ci_write_back is a run-state mismatch (no role runs)", async () => {
  const cases = [
    ["infra:state:ready", (x) => delete x.pr_ready, /^run-state mismatch: pr_ready /],
    ["infra:state:ready", (x) => (x.pr_ready = "yes"), /^run-state mismatch: pr_ready /],
    ["infra:state:reviewed:v1", (x) => (x.pr_ready = 1), /^run-state mismatch: pr_ready /],
    ["infra:state:ready", (x) => (x.ci_write_back = "ok"), /^run-state mismatch: ci_write_back /],
    ["infra:state:ready", (x) => (x.ci_write_back = { ledger_status: "ok" }), /^run-state mismatch: ci_write_back /],
    ["infra:state:ready", (x) => (x.ci_write_back = null), /^run-state mismatch: ci_write_back /],
  ];
  for (const [label, edit, re] of cases) {
    const s = happy();
    const { bargs, resume } = await built(s);
    resume(label, edit);
    const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
    assert.equal(r.result.status, "needs_human", label + " " + edit);
    assert.match(r.result.reason, re, r.result.reason);
    assert.equal(r.result.stop_class, "safety");
    assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
  }
});

test("8.9.3 (d): a failed record of the CI write-back fails closed: the stop gets no re-run", async () => {
  const s = happy();
  s["infra:policy"] = polOut(PERSONAL);
  s["infra:ci-watch:w1"] = watchOut("timeout");
  s["infra:state:ready:ci-wb"] = { status: "ok", reason: "written", head: "0".repeat(40), state_sha: "f".repeat(40) };
  const { first } = await built(s);
  assert.equal(first.result.stop_gate, "ci", first.result.reason);
  assert.match(first.result.reason, /^CI unresolved/);
  assert.equal(first.result.stop_class, "safety");
  assert.equal(first.result.recover.action, "none");
});

test("8.9.3 (d): a write-back that failed is not recorded, so the re-run writes it again", async () => {
  const s = happy();
  s["infra:policy"] = polOut(PERSONAL);
  s["infra:ci-watch:w1"] = watchOut("timeout");
  s["infra:yaadgaar-writeback:ci"] = { status: "failed", reason: "down" };
  const { first } = await built(s);
  assert.equal(first.result.stop_class, "transient", first.result.reason);
  assert.equal(first.result.ci_write_back.ledger_status, "failed");
  assert.ok(!has(first, "infra:state:ready:ci-wb"), first.labels.join(", "));
});

test("8.9.3 (d): a resume at the CI watch finds the PR merged: it records shipped, cleans up, done", async () => {
  const s = happy();
  const { bargs, resume, states } = await built(s);
  resume("infra:state:ready");
  s["infra:pr-view:resume"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "read", mode: "view", state: "MERGED", head: a[4], merge_sha: "9".repeat(40), error: null, args: a };
  };
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(has(r, "infra:state:shipped:resume"), r.labels.join(", "));
  assert.ok(!has(r, "infra:ci-watch:w1"), r.labels.join(", "));
  assert.equal(states["infra:state:ready"].pr_ready, true);
});

test("8.9.3 (d): the README milestone table lists ready, and the CI-unresolved re-run resumes at the CI watch", () => {
  const t = flat(README);
  assert.match(t, /\| `ready` \| ready \(8\.9\.3\) \| the CI watch \|/);
  assert.match(t, /CI unresolved \(`buildFromRef`: the last milestone is `ready`/);
  assert.doesNotMatch(t, /it posts the CI write-back once more/);
});

test("8.9.3 (d): after update-branch no ready run-state is written (no resume point there) and no CI write-back is recorded", async () => {
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
    "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: "d".repeat(40), tree: "KU" } },
    "infra:ci-watch:w2": watchOut("timeout"),
  });
  const { first } = await built(s);
  const L = first.labels;
  const u = L.indexOf("infra:pr-update");
  assert.ok(u > 0, L.join(", "));
  assert.ok(L.indexOf("infra:ci-watch:w2") > u, L.join(", "));
  assert.ok(!L.slice(u).some((l) => /^infra:state:ready/.test(l)), L.join(", "));
  assert.equal(first.result.stop_gate, "ci", first.result.reason);
});

// ---------------------------------------------------------------- (f) a plan stop after the plan ref commit re-runs as a build of that ref

const INTENT_OK = {
  "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" } },
  "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
};
const INTENT_RERUN = {
  "hasher:pre-intent:rerun": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  "hasher:fp-post:intent:rerun": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
};
const sealedTiny = async () => (await runOne(happy(), ARGS)).result.plan_ref;

for (const [name, extra] of [["confirm auto", { confirm: "auto" }], ["unattended", { unattended: true }]]) {
  test("8.9.3 (f): a " + name + " plan launch whose auto gates stop transiently after the plan ref commit re-runs as a build of that ref with confirm auto", async () => {
    const s = Object.assign(happy(), INTENT_OK, { "role:fleet-intent-judge": [null] });
    const out = await runOne(s, Object.assign({}, ARGS, extra));
    assert.ok(out.labels.indexOf("infra:commit-plan") < out.labels.indexOf("role:fleet-intent-judge"), out.labels.join(", "));
    assert.equal(out.result.stop_class, "transient", out.result.reason);
    const tiny = await sealedTiny();
    const rc = out.result.recover;
    assert.deepEqual(Object.keys(rc.args), ["mode", "plan_ref", "confirm", "rerun_of"]);
    assert.deepEqual([rc.class, rc.action, rc.args.mode, rc.args.confirm, rc.args.rerun_of], ["transient", "rerun", "build", "auto", NONCE]);
    for (const k of ["branch", "plan_commit", "plan_ref", "repo"]) assert.equal(rc.args.plan_ref[k], tiny[k], k);
    assert.match(rc.args.plan_ref.ref_sha256, /^[0-9a-f]{64}$/);
    assert.ok(has(out, "infra:run-lock:rerun"), "the engine marker bounds it");
    // the re-run (the same repo and sealed ref): no planner and no audit; the build-mode :rerun gates run every auto gate again
    const t = Object.assign(s, INTENT_RERUN, { "role:fleet-intent-judge:rerun": INTENT_OK["role:fleet-intent-judge"] });
    const r = await runOne(t, relaunch(Object.assign({}, ARGS, extra), out.result.recover));
    assert.equal(r.result.status, "ok", r.result.reason);
    for (const l of ["role:scope-and-plan", "role:plan-audit", "infra:commit-plan"]) assert.ok(!has(r, l), l + ": " + r.labels.join(", "));
    for (const l of ["intake:rulings", "infra:path-check:intent:rerun", "role:fleet-intent-judge:rerun"]) assert.ok(has(r, l), l + ": " + r.labels.join(", "));
    assert.deepEqual(r.result.auto_decisions[0], { gate: "rerun", decision: "rerun", reason: "the automatic re-run of run " + NONCE + " after a transient stop" });
  });
}

test("8.9.3 (f): a plan stop before the plan ref commit still re-runs the plan", async () => {
  const s = happy();
  s["role:plan-audit"] = [null];
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.ok(!has(out, "infra:commit-plan"), out.labels.join(", "));
  assert.equal(out.result.recover.args.mode, "plan");
});

const RELAXED = "criterion AC2 dropped";
const DEV = { item: RELAXED, allowed_by: "task body: 'AC2 is out of scope'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "the task drops it" };
test("8.9.3 (f): an unattended relaxed plan whose intent judge stops after the commit re-runs as a build; the :rerun intent judge gets the list sealed in the ref", async () => {
  const at = 'budgetStop("the plan commit");';
  assert.equal(DIST.split(at).length, 2, "the dist holds the plan-commit budget check once");
  const src = DIST.replace(at, at + "p.relaxed=[" + JSON.stringify(RELAXED) + "];");
  assert.notEqual(src, DIST);
  const s = Object.assign(happy(), INTENT_OK, { "role:fleet-intent-judge": [null], __source: src });
  const out = await runOne(s, Object.assign({}, ARGS, { unattended: true }));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun", JSON.stringify(out.result.recover));
  assert.equal(out.result.recover.args.mode, "build");
  assert.equal(out.result.recover.args.confirm, "auto");
  assert.ok(!("relaxed" in out.result.recover.args));
  const t = Object.assign(s, INTENT_RERUN, { "role:fleet-intent-judge:rerun": Object.assign({}, INTENT_OK["role:fleet-intent-judge"], { deviations: [DEV] }) });
  const r = await runOne(t, relaunch(Object.assign({}, ARGS, { unattended: true }), out.result.recover));
  const ij = r.calls.find((c) => c.label === "role:fleet-intent-judge:rerun");
  assert.ok(ij, r.labels.join(", "));
  assert.deepEqual(inputsOf(ij.prompt).relaxed, [RELAXED]);
  assert.ok(!has(r, "role:scope-and-plan"), r.labels.join(", "));
});

test("8.9.3 (f): the README names the build re-run of a plan stop after the plan ref commit", () => {
  const t = flat(README);
  assert.match(t, /A plan launch that stopped after its plan ref was committed and before its build \(8\.9\.3, the auto gates\): `mode: "build"`, its `plan_ref` and `confirm: "auto"`/);
});

// ---------------------------------------------------------------- (i) late automatic decisions reach the CI write-back

const statsBad = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "w", replaced: false, wall_s: 5, block_sha256: "0".repeat(64), body_sha256_before: null, body_sha256_after: null, headers_missing: [], error: null, args: a };
};
const ciSection = (out) => {
  const c = out.calls.find((x) => x.label === "infra:yaadgaar-writeback:ci");
  assert.ok(c, out.labels.join(", "));
  return inputsOf(c.prompt).section_text;
};
const LATE = "; automatic decisions after the PR body: ";

test("8.9.3 (i): an unattended run's decision after the PR body (the stats block written once more) reaches the CI write-back as gate and decision", async () => {
  const s = happy();
  s["infra:pr-stats"] = statsBad;
  const { first, states } = await built(s, { unattended: true, rerun_of: "n0-0000009" });
  assert.equal(first.result.status, "ok", first.result.reason);
  assert.ok(has(first, "infra:pr-stats:regen"), first.labels.join(", "));
  const t = ciSection(first);
  assert.ok(t.includes(LATE + "pr-body regenerate\n") || t.includes(LATE + "pr-body regenerate"), t);
  // the decision before the body (the re-run record) is in the body's Unattended section, not listed again
  assert.ok(!/after the PR body: [^\n]*rerun/.test(t), t);
  assert.ok(!t.includes("infra:pr-stats"), "no reason text in the CI write-back: " + t);
  assert.equal(states["infra:state:pr_open:p1"].body_decided, 1);
  assert.equal(states["infra:state:ready"].body_decided, 1);
});

test("8.9.3 (i): no late decision, or an attended run: the CI write-back line is unchanged", async () => {
  const a = happy();
  const r1 = await built(a, { unattended: true });
  assert.equal(r1.first.result.status, "ok", r1.first.result.reason);
  assert.ok(!ciSection(r1.first).includes(LATE), ciSection(r1.first));
  const b = happy();
  b["infra:pr-stats"] = statsBad;
  const r2 = await built(b);
  assert.equal(r2.first.result.status, "ok", r2.first.result.reason);
  assert.ok(has(r2.first, "infra:pr-stats:regen"));
  assert.ok(!ciSection(r2.first).includes(LATE), ciSection(r2.first));
});

test("8.9.3 (i): a resume after the PR opened lists its own decisions (the re-run record) as late; an older run-state counts every resumed one as in the body", async () => {
  const s = happy();
  const { bargs, resume } = await built(s, { unattended: true });
  resume("infra:state:reviewed:v1", (x) => delete x.body_decided);
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2, rerun_of: NONCE }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(ciSection(r).includes(LATE + "rerun rerun"), ciSection(r));
});

test("8.9.3 (i): a body_decided that is not a count of the run-state's auto_decisions is a run-state mismatch", async () => {
  for (const bad of [-1, 2, "1", 0.5, null]) {
    const s = happy();
    const { bargs, resume } = await built(s, { unattended: true });
    resume("infra:state:reviewed:v1", (x) => (x.body_decided = bad));
    const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
    assert.equal(r.result.status, "needs_human", JSON.stringify(bad));
    assert.match(r.result.reason, /^run-state mismatch: body_decided /, r.result.reason);
    assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
  }
});

test("8.9.3 (i): the README says where late automatic decisions go", () => {
  assert.match(flat(README), /automatic decisions made after the PR body was written \(8\.9\.3\) are listed in the CI write-back/);
});

test("8.9.3 (f): an unattended plan that touches an IaC path asks Max before the auto gates, so it never reaches the build re-run", async () => {
  const s = Object.assign(happy(), INTENT_OK);
  s["role:scope-and-plan"] = JSON.parse(JSON.stringify(s["role:scope-and-plan"]));
  s["role:scope-and-plan"].allowed_additions = { files: ["src/main.tf"], symbols: [], deps: [], settings: [] };
  const out = await runOne(s, Object.assign({}, ARGS, { unattended: true }));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.match(out.result.confirm_reason, /plan touches IaC path src\/main\.tf/);
  assert.equal(out.result.recover, null);
  assert.ok(!has(out, "role:fleet-intent-judge"), out.labels.join(", "));
});

test("8.9.3 (f): the README says which launches check the plan-mode blockers", () => {
  assert.match(flat(README), /A default or unattended launch checks them before the auto gates and asks Max on any of them, so its auto gates ran only on sealed plan facts that passed them\. An attended `confirm: "auto"` launch never checks them, in plan mode or in the build\./);
});
