// fleet 6.3.0, part B: ADR-1239, the opt-in unattended mode (ledger 2108).
//
// Off by default. On by a policy.json profile or repos key `unattended: true`
// or by args.unattended (the /build-task argument --unattended); the result
// records the source. Plan mode reads the policy too (infra:policy:plan).
// Unattended decides the Build confirmation (the auto gates, then the build in
// the same run), the default-mode blockers change_kind, new_behaviour and a
// task id that exactly one ledger answered, a relaxed re-plan (the intent
// judge rules on it), the fleet-brief marker, and a plan_wrong re-plan (built
// in the same run). It never bypasses a safety stop. Every decision is
// recorded as {gate, decision, reason}: result, run-state, PR body.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARGS, PB, PC, PSHA, FP_TESTS, HASHES_FLAT, SOURCE, SCRIPTS_SRC, H, happy, run, runOne, call, inputsOf, noUnscripted, commitStub, spawnSync, stateJsonOf, pathRecheckOut, tfGateRelay, sha256, canon,
} from "./harness.mjs";

const U = { ...ARGS, unattended: true };
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64), caps: Object.assign({}, DEFAULT_CAPS), matched: "profile personal", error: null, args: inputsOf(p).args }, over);
const polUn = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { unattended: true }) });

// happy plus the auto-gate stubs; the plan is a feature with new behaviour (default mode would ask)
function gated(over = {}) {
  const s = happy(over);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return Object.assign(s, over.script || {});
}
const decisions = (out) => (out.result.auto_decisions || []).map((d) => d.gate + ": " + d.decision + " (" + d.reason + ")");

// ---------------------------------------------------------------- policy.py

function policyPy(doc) {
  const home = mkdtempSync(join(tmpdir(), "fleet-630u-"));
  try {
    mkdirSync(join(home, ".config", "fleet"), { recursive: true });
    writeFileSync(join(home, ".config", "fleet", "policy.json"), JSON.stringify(doc));
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "policy.py"), "github.com", "m-agahi/ccpm"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const doc = (prof, repo) => ({ version: 1, profiles: [Object.assign({ name: "personal", match: { owners: ["m-agahi"] } }, prof || {}, repo ? { repos: { "m-agahi/ccpm": repo } } : {})] });

test("6.3.0 B (ADR-1239): policy.py: unattended is a bool in a profile or a repos override; unset, the caps carry no key", () => {
  assert.equal(policyPy(doc({ unattended: true })).caps.unattended, true);
  assert.equal(policyPy(doc({ unattended: true }, { unattended: false })).caps.unattended, false);
  assert.equal(policyPy(doc({}, { unattended: true })).caps.unattended, true);
  assert.ok(!("unattended" in policyPy(doc({})).caps));
  for (const bad of ["yes", 1, null, []]) {
    const o = policyPy(doc({ unattended: bad }));
    assert.match(o.error, /unattended must be true or false/, JSON.stringify(bad));
    assert.deepEqual(o.caps, DEFAULT_CAPS, "an invalid file is the strict default: unattended off");
  }
});

// ---------------------------------------------------------------- args and the default

test("6.3.0 B: args.unattended is true or absent; args.brief_marker is a boolean; else a stop before any agent", async () => {
  for (const [k, v] of [["unattended", false], ["unattended", "yes"], ["unattended", 1], ["brief_marker", "yes"]]) {
    const out = await runOne(happy(), { ...ARGS, [k]: v });
    assert.equal(out.result.status, "needs_human", k + "=" + JSON.stringify(v));
    assert.match(out.result.reason, new RegExp("args\\." + k));
    assert.equal(out.calls.length, 0);
  }
});

test("6.3.0 B: off by default: plan mode reads the policy (infra:policy:plan) and asks as before; no unattended keys anywhere", async () => {
  for (const confirm of [undefined, "ask", "default"]) {
    const a = confirm ? { ...ARGS, confirm } : ARGS;
    const out = await runOne(gated(), a);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    assert.ok(out.labels.includes("infra:policy:plan"));
    for (const k of ["unattended", "unattended_source", "auto_decisions"]) assert.ok(!(k in out.result), k);
    assert.ok(!out.labels.includes("role:fleet-intent-judge"));
  }
  assert.match(SOURCE, /\nconst CONFIRMS = \["ask", "auto", "default"\];\n/);
});

// ---------------------------------------------------------------- the decisions

test("6.3.0 B: --unattended (arg): the Build confirmation and the default blockers are decided; the gates pass and the same run builds", async () => {
  const s = gated();
  const out = await runOne(s, { ...U, confirm: "default" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.auto_confirmed, true);
  assert.equal(out.result.unattended, true);
  assert.equal(out.result.unattended_source, "arg");
  const d = decisions(out);
  assert.ok(d.includes("confirm: auto (the Build confirmation (confirm default))"), d.join("\n"));
  assert.ok(d.includes("default-blocker: decided (change_kind feature (only bug_fix skips the confirmation))"), d.join("\n"));
  assert.ok(d.includes("default-blocker: decided (new_behaviour true (only false skips the confirmation))"), d.join("\n"));
  // the PR opener gets the section; the stats step checks its header in the real body
  const sec = inputsOf(call(out, "role:fleet-pr-opener").prompt).unattended_section;
  assert.match(sec, /^### Unattended run\n\nUnattended run \(arg\): automatic decisions: confirm: auto \(/);
  const hdrs = JSON.parse(inputsOf(call(out, "infra:pr-stats").prompt).args[5]);
  assert.ok(hdrs.includes("### Unattended run"));
});

test("6.3.0 B: the policy turns it on (source policy; with the arg too: both); the PR section names the sealed policy sha", async () => {
  const s = gated({ script: { "infra:policy": polUn } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.unattended_source, "policy");
  assert.match(inputsOf(call(out, "role:fleet-pr-opener").prompt).unattended_section, new RegExp("Unattended run \\(policy sha " + "f".repeat(64) + "\\)"));
  const both = await runOne(gated({ script: { "infra:policy": polUn } }), U);
  assert.equal(both.result.unattended_source, "both");
  assert.match(inputsOf(call(both, "role:fleet-pr-opener").prompt).unattended_section, /policy sha f{64} \/ arg\)/);
});

test("6.3.0 B: the run-state records unattended and auto_decisions next to auto_confirmed", async () => {
  const s = gated();
  let st = null;
  s["infra:state:committed:r1"] = (prompt) => {
    st = stateJsonOf(prompt);
    return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
  };
  const out = await runOne(s, U);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(st.unattended, "arg");
  assert.equal(st.auto_confirmed, true);
  assert.deepEqual(st.auto_decisions.map((x) => x.gate), out.result.auto_decisions.filter((x, i) => i < st.auto_decisions.length).map((x) => x.gate));
});

test("6.3.0 B: a PR body with no Unattended run section stops at the stats step (the real body, not the opener's word)", async () => {
  const s = gated();
  s["infra:pr-stats"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "written", replaced: false, wall_s: 120, block_sha256: "0".repeat(64), body_sha256_before: "0".repeat(64), body_sha256_after: "1".repeat(64), headers_missing: ["### Unattended run"], error: "the re-read body lost header(s): ### Unattended run", args: a };
  };
  const out = await runOne(s, U);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "stats");
  assert.match(out.result.reason, /the PR body has no ### Unattended run section/);
});

test("6.3.0 B: a relaxed re-plan goes to the intent judge as `relaxed`; a refusal is the intent stop", async () => {
  const mk = (ij) => {
    const s = gated();
    s["role:plan-audit"] = { status: "ok", reason: "x", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC2", finding: "drop it" }] };
    s["role:plan-audit:audit-fix"] = { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] };
    s["role:scope-and-plan:audit-fix"] = Object.assign({}, s["role:scope-and-plan"], { criteria: s["role:scope-and-plan"].criteria.slice(0, 1) });
    if (ij) s["role:fleet-intent-judge"] = Object.assign({}, s["role:fleet-intent-judge"], ij);
    return s;
  };
  const dev = { item: "criterion AC2 dropped", allowed_by: "task body: 'AC2 is out of scope'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "the task drops it" };
  const out = await runOne(mk({ deviations: [dev] }), U);
  assert.notEqual(out.result.failed_check, "intent", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-intent-judge").prompt).relaxed, ["criterion AC2 dropped"]);
  // fail closed: no deviation, an unbacked one or a refused one for the relaxed item is the intent stop
  for (const d of [[], [Object.assign({}, dev, { allowed_by: "" })], [Object.assign({}, dev, { verdict: "refuse" })], [Object.assign({}, dev, { item: "something else" })]]) {
    const o = await runOne(mk({ deviations: d }), U);
    assert.equal(o.result.failed_check, "intent", JSON.stringify(d));
    assert.match(o.result.reason, /relaxed re-plan item "criterion AC2 dropped" has no approved deviation/);
  }
  assert.ok(decisions(out).some((d) => /^default-blocker: decided \(re-plan relaxed: criterion AC2 dropped; the intent judge rules on it\)$/.test(d)), decisions(out).join("\n"));
  const no = await runOne(mk({ verdict: "refuse" }), U);
  assert.equal(no.result.status, "needs_human");
  assert.equal(no.result.failed_check, "intent");
  // not unattended: confirm auto still stops a relaxed re-plan before the judge
  const auto = await runOne(mk(), { ...ARGS, confirm: "auto" });
  assert.equal(auto.result.failed_check, "intent");
  assert.ok(!auto.labels.includes("role:fleet-intent-judge"));
});

test("6.3.0 B: the fleet-brief marker is a ruling under unattended; a user's own confirm ask still asks", async () => {
  const m = await runOne(gated({ script: { "infra:policy": polUn } }), { ...ARGS, confirm: "ask", brief_marker: true });
  assert.equal(m.result.status, "ok", m.result.reason);
  assert.ok(decisions(m).includes("confirm: auto (the Build confirmation (confirm ask; the fleet-brief marker is treated as a ruling))"), decisions(m).join("\n"));
  const ask = await runOne(gated({ script: { "infra:policy": polUn } }), { ...ARGS, confirm: "ask" });
  assert.equal(ask.result.status, "awaiting_confirmation", ask.result.reason);
  // not unattended: the marker changes nothing
  const off = await runOne(gated(), { ...ARGS, confirm: "ask", brief_marker: true });
  assert.equal(off.result.status, "awaiting_confirmation");
});

test("6.3.0 B: a task id with no project that exactly one ledger answered is decided (ledger_source recorded); none or two answered still asks", async () => {
  const yb = { title: "Add Thing!", description: "add a thing", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "task body", id: "yadgar:task:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", project: null }], repo: "/r", plan_path: null };
  const mk = (tried) => {
    const s = gated({ brief: yb, tried });
    s.__session_project = "o/r";
    return s;
  };
  const a = { ...U, input: "#622" };
  delete a.project;
  const one = await runOne(mk([{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: null }]), a);
  assert.ok(one.labels.includes("role:fleet-intent-judge"), one.result.reason);
  assert.ok(decisions(one).some((d) => /^default-blocker: decided \(task id "#622" with no args\.project; ledger_source yaadgaar 622\)$/.test(d)), decisions(one).join("\n"));
  const two = await runOne(mk([{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: null }, { ledger: "yadgar", project: "o/r", call: "task_get(622)", error: null }]), a);
  assert.equal(two.result.status, "awaiting_confirmation", two.result.reason);
  assert.match(two.result.confirm_reason, /task id "#622" with no args\.project/);
});

// ---------------------------------------------------------------- plan_wrong

const PC2 = "0123456789ab";
const PLAN_WRONG = { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: split AC2" }] };
function planWrong(s, again) {
  const cj = s["role:fleet-code-judge:r1"];
  return Object.assign(s, {
    "role:fleet-code-judge:r1": [PLAN_WRONG, again ? PLAN_WRONG : cj],
    "infra:replan-worktree": [{ status: "ok", reason: "ok", head: PC }, { status: "ok", reason: "ok", head: PC2 }],
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan:replan": [commitStub(s.__store, PC2, PSHA), commitStub(s.__store, "0123456789cd", PSHA)],
    "infra:replan-reset": { status: "ok", reason: "reset", head: PB, superseded_head: "5555555" },
    "hasher:pre-intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "hasher:fp-post:intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge:replan": s["role:fleet-intent-judge"],
  });
}

test("6.3.0 B: a plan_wrong re-plan under unattended runs the auto gates on the new plan and builds it in the same run (once per run)", async () => {
  const out = await runOne(planWrong(gated()), U);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.pr_url);
  const i = out.labels.indexOf("infra:replan-reset");
  assert.ok(i > 0, out.labels.join(", "));
  for (const l of ["role:fleet-intent-judge:replan", "infra:load-ref", "infra:verify-plan", "role:fleet-coder:r1", "role:fleet-pr-opener"]) assert.ok(out.labels.slice(i).includes(l), l);
  assert.ok(decisions(out).includes("plan_wrong: build (code-judge re-plan 1: the auto gates, then the build in this run)"), decisions(out).join("\n"));
  assert.match(inputsOf(call(out, "role:fleet-pr-opener").prompt).unattended_section, /plan_wrong: build \(code-judge re-plan 1/);
  assert.equal(out.result.rounds.code, 1, "the second pass counts its own rounds");
  // a second plan_wrong in the same run asks, as before
  const two = await runOne(planWrong(gated(), true), U);
  assert.equal(two.result.status, "awaiting_confirmation", two.result.reason);
  assert.ok(decisions(two).some((d) => /^plan_wrong: ask \(code-judge re-plan 2: the run already built one re-plan\)$/.test(d)), decisions(two).join("\n"));
  // not unattended: the re-plan asks, as before
  const ask = await runOne(planWrong(gated()), { ...ARGS, confirm: "auto" });
  assert.equal(ask.result.status, "awaiting_confirmation");
  assert.ok(!ask.labels.includes("role:fleet-intent-judge:replan"));
});

// ---------------------------------------------------------------- never bypassed

const fence = (files) => ({ allowed_additions: { files, symbols: [], deps: [], settings: [] } });
const plan = (s, o) => Object.assign(s["role:scope-and-plan"], o);
const RELAY = "relayed user request does not reference args.input";
const OWN = "refs/fleet/l42/freeze";
const fmtWith = (holds) => (prompt) => {
  const i = inputsOf(prompt);
  return { status: "ok", reason: "formatted", changed_paths: [i.plan_path], dsn_check: { holds, lines: holds ? [3] : [], args: [i.worktree, i.plan_path] } };
};
const NEVER = [
  ["hook surface", (s) => plan(s, fence([".github/workflows/ci.yml"])), (o) => assert.equal(o.result.stop_gate, "hooks")],
  ["IaC path (asks)", (s) => plan(s, fence(["src/main.tf"])), (o) => (assert.equal(o.result.status, "awaiting_confirmation"), assert.match(o.result.confirm_reason, /plan touches IaC path src\/main\.tf/))],
  ["intent refusal", (s) => (s["role:fleet-intent-judge"] = Object.assign({}, s["role:fleet-intent-judge"], { verdict: "refuse" })), (o) => assert.equal(o.result.failed_check, "intent")],
  ["scope fence", (s) => plan(s, fence(["config/rulesets/main.json"])), (o) => assert.equal(o.result.failed_check, "scope")],
  ["command allowlist", (s) => plan(s, { test_cmd: { command: "pip install x", paths_placeholder: "<paths>", env: {}, tools: [] } }), (o) => assert.equal(o.result.stop_gate, "commands")],
  ["contract drift", (s) => plan(s, { plan_diff: [] }), (o) => assert.equal(o.result.stop_gate, "contract")],
  ["DSN", (s) => { for (const x of ["", ":audit-fix", ":audit-fix-2"]) s["infra:format-plan" + x] = fmtWith(true); }, (o) => assert.match(o.result.reason, /mysql|DSN|dsn/)],
  ["relaunch", (s) => (s.intake = { status: "needs_human", reason: RELAY + ": something else", tried: [] }), (o) => assert.equal(o.result.stop_gate, "relaunch")],
  ["fingerprint", (s) => (s["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: { head: PB, tree: "MUTATED" } }), (o) => assert.equal(o.result.stop_gate, "fingerprint")],
  ["freeze", (s) => (s["hasher:freeze:f1"] = { status: "ok", fingerprint: { head: PB, tree: "OTHER" }, hashes: H(HASHES_FLAT) }), (o) => assert.equal(o.result.stop_gate, "fingerprint")],
  ["ownership", (s) => (s["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: H(Object.assign({}, HASHES_FLAT, { ["git:fleetref:" + OWN]: "a".repeat(40) })) }), (o) => assert.equal(o.result.stop_gate, "ownership")],
  ["hash", (s) => (s["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: H(Object.assign({}, HASHES_FLAT, { ["git:fleetref:refs/replace/" + "c".repeat(40)]: "a".repeat(40) })) }), (o) => assert.equal(o.result.stop_gate, "hash")],
  ["terraform on PATH", (s) => (s["infra:path-check:plan-audit"] = (p) => { const i = inputsOf(p); return pathRecheckOut({ ["terra" + "form"]: { path: "/usr/bin/x", real: "/usr/bin/x", shim: false } }, [i.repo, i.token]); }), (o) => assert.equal(o.result.stop_gate, "iac")],
  ["IaC push gate", (s) => {
    let sha = null;
    s["infra:policy"] = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { merge: "auto", unattended: true }) });
    s["infra:tf-gate:push"] = (p) => { const i = inputsOf(p); sha = i.approved_sha; return tfGateRelay({ touched: true, iac_files: ["infra/main.tf"], args: [i.main_worktree, i.default_branch, i.approved_sha, i.remote_url] }); };
    s["infra:remote-head:push"] = (p) => { const i = inputsOf(p); const r = { status: "ok", reason: "read", head: sha, args: [i.main_worktree, i.branch, i.remote_url] }; r.digest = sha256(canon({ head: r.head, args: r.args })); return r; };
  }, (o) => (assert.equal(o.result.stop_gate, "iac"), assert.ok(!o.labels.some((l) => /^infra:(pr-ready|pr-merge)/.test(l))))],
  ["commit integrity", (s) => { const f = s["infra:commit:r1"]; s["infra:commit:r1"] = (p, o) => Object.assign(typeof f === "function" ? f(p, o) : JSON.parse(JSON.stringify(f)), { staged_tree: "BAD" }); }, (o) => assert.equal(o.result.stop_gate, "commit")],
];

test("6.3.0 B (ADR-1239): unattended never bypasses a safety stop (hooks, IaC, terraform on PATH, the IaC push gate, intent, scope, commands, contract, DSN, relaunch, fingerprint, freeze, ownership, hash, commit)", async () => {
  for (const [name, mut, check] of NEVER) {
    for (const a of [U, { ...ARGS, confirm: "default" }]) {
      const s = gated({ script: a === U ? {} : { "infra:policy": polUn } });
      mut(s);
      const out = await runOne(s, a);
      assert.notEqual(out.result.status, "ok", name + ": " + out.result.reason);
      // a stop before plan mode reads the policy (relaunch at intake) knows only the arg
      if (name !== "relaunch" || a === U) assert.ok(out.result.unattended, name + ": unattended on");
      check(out);
    }
  }
});

test("6.3.0 B (ADR-1239): unattended never merges on a work owner, never merges an orchestrator PR, and never skips plan-ref integrity", async () => {
  const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true, unattended: true });
  const s = gated();
  s.workspace = Object.assign({}, s.workspace, { remote_slug: "quinyx/app" });
  s.__gh = { "quinyx/app": [{ cmd: "gh", installed: true, push: true }] };
  s["role:fleet-pr-opener"] = Object.assign({}, s["role:fleet-pr-opener"], { pr_url: "https://github.com/quinyx/app/pull/7" });
  s["infra:policy"] = polOut({ profile: "work", caps: PERSONAL });
  const w = await runOne(s, U);
  assert.ok(w.result.unattended);
  assert.ok(!w.labels.some((l) => /^infra:pr-merge/.test(l)), w.labels.join(", "));
  assert.ok(w.logs.some((l) => /^work repo quinyx\/app: merge and update_branch never/.test(l)));
  const t = gated();
  t["infra:policy"] = polOut({ caps: PERSONAL });
  t["infra:orch-scan"] = (p) => ({ status: "ok", reason: "s", orchestrator: true, iac_repo: true, apply_on_merge: true, hook_surface_pr: true, reasons: [], error: "gh pr view: HTTP 502", args: inputsOf(p).args });
  const o = await runOne(t, U);
  assert.ok(!o.labels.some((l) => /^infra:pr-merge/.test(l)), o.labels.join(", "));
  assert.match(o.result.reason, /orchestrator PR: needs Max/);
  // plan-ref integrity: a build with a plan_ref whose sha256 does not match stops
  const p = await runOne(gated(), ARGS);
  const bad = Object.assign({}, p.result.plan_ref, { ref_sha256: "0".repeat(64) });
  const b = await runOne(gated(), { mode: "build", plan_ref: bad, date: ARGS.date, project: "o/r", unattended: true });
  assert.equal(b.result.status, "needs_human", b.result.reason);
  assert.ok(!b.labels.some((l) => /^role:fleet-test-writer/.test(l)));
});

test("6.3.0 B: the skill documents --unattended, the policy skill and README document the key, and the default confirm stays default", () => {
  const R = join(SCRIPTS_SRC, "..");
  const skill = readFileSync(join(R, "skills", "build-task", "SKILL.md"), "utf8");
  assert.match(skill, /--unattended/);
  assert.match(skill, /unattended: true/);
  assert.match(skill, /Pass `confirm: "default"` unless the user named a mode/);
  assert.match(readFileSync(join(R, "skills", "fleet-policy", "SKILL.md"), "utf8"), /unattended/);
  assert.match(readFileSync(join(R, "README.md"), "utf8"), /`unattended`/);
});

// ---------------------------------------------------------------- the plan ref's policy seal (security review)

const BUILD = (plan, over) => Object.assign({ mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" }, over || {});

test("6.3.0 B (security review): a build never runs looser than the plan ref's sealed policy, nor looser than the current file", async () => {
  // the plan ref sealed unattended true; the file now says nothing: the build is not unattended
  const s = gated();
  s["infra:policy:plan"] = polUn;
  const plan = await runOne(s, { ...ARGS, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:policy"] = polOut({});
  const b = await runOne(s, BUILD(plan));
  assert.equal(b.result.status, "ok", b.result.reason);
  assert.ok(!("unattended" in b.result));
  assert.ok(b.logs.some((l) => /^policy: the plan ref's sealed policy is stricter than the current file for unattended undefined -> false; the stricter applies$/.test(l)), b.logs.join("\n"));
  // merge auto sealed, never now: never (and the other way round: never sealed, auto now: never)
  for (const [sealed, now] of [["auto", "never"], ["never", "auto"]]) {
    const t = gated();
    t["infra:policy:plan"] = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { merge: sealed, update_branch: sealed === "auto" ? "once" : "never" }) });
    const p = await runOne(t, { ...ARGS, confirm: "ask" });
    t["infra:policy"] = polOut({ policy_sha256: "e".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { merge: now, update_branch: now === "auto" ? "once" : "never" }) });
    const o = await runOne(t, BUILD(p));
    assert.equal(o.result.policy.caps.merge, "never", sealed + "/" + now);
    assert.equal(o.result.policy.caps.update_branch, "never", sealed + "/" + now);
    assert.ok(!o.labels.some((l) => /^infra:pr-merge/.test(l)), sealed + "/" + now);
  }
  // unattended in both: on
  const u = gated();
  u["infra:policy:plan"] = polUn;
  const pu = await runOne(u, { ...ARGS, confirm: "ask" });
  u["infra:policy"] = polUn;
  assert.equal((await runOne(u, BUILD(pu))).result.unattended_source, "policy");
});

test("6.3.0 B (security review): a plan ref whose sealed policy is malformed is refused like any other plan ref problem", async () => {
  for (const caps of [Object.assign({}, DEFAULT_CAPS, { merge: "sometimes" }), Object.assign({}, DEFAULT_CAPS, { unattended: "yes" }), Object.assign({}, DEFAULT_CAPS, { pr_ready: null })]) {
    const s = gated();
    s["infra:policy:plan"] = polOut({ caps });
    const plan = await runOne(s, { ...ARGS, confirm: "ask" });
    assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
    const b = await runOne(s, BUILD(plan));
    assert.equal(b.result.status, "needs_human", JSON.stringify(caps));
    assert.match(b.result.reason, /policy is malformed/);
    assert.ok(!b.labels.some((l) => /^role:fleet-test-writer/.test(l)));
  }
});

// ---------------------------------------------------------------- review H1, L2, L3

const LOOSE = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true, unattended: true, ci_watch_minutes: 90 });

test("6.3.0 review H1: a plan_wrong re-plan seals the build's policy in the new plan ref; a looser file after it never loosens the build (same run and later build)", async () => {
  // a later separate build: confirm auto, not unattended; the re-plan asks; then the file loosens
  const s = planWrong(gated());
  const first = await runOne(s, { ...ARGS, confirm: "auto" });
  assert.equal(first.result.status, "awaiting_confirmation", first.result.reason);
  assert.deepEqual(JSON.parse(s.__store[PC2]).policy.caps, DEFAULT_CAPS, "the re-plan ref seals the build's policy");
  s["infra:policy"] = polOut({ policy_sha256: "e".repeat(64), caps: LOOSE });
  s["role:fleet-code-judge:r1"] = gated()["role:fleet-code-judge:r1"];
  const b = await runOne(s, BUILD(first));
  assert.equal(b.result.status, "ok", b.result.reason);
  assert.ok(!("unattended" in b.result));
  for (const k of ["merge", "update_branch"]) assert.equal(b.result.policy.caps[k], "never", k);
  assert.equal(b.result.policy.caps.ci_trigger, false);
  assert.equal(b.result.policy.caps.ci_watch_minutes, 60, "review L2: the smaller ci_watch_minutes");
  assert.ok(!b.labels.some((l) => /^infra:pr-merge/.test(l)));
  // the same-run unattended build: the file loosens between the first build's read and the re-plan's build
  const t = planWrong(gated());
  t["infra:policy:plan"] = polOut({});
  t["infra:policy"] = [polOut({}), polOut({ policy_sha256: "e".repeat(64), caps: LOOSE })];
  const o = await runOne(t, U);
  assert.equal(o.result.status, "ok", o.result.reason);
  assert.ok(decisions(o).some((d) => /^plan_wrong: build/.test(d)));
  assert.equal(o.result.policy.caps.merge, "never");
  assert.equal(o.result.policy.caps.update_branch, "never");
  assert.ok(!o.labels.some((l) => /^infra:pr-merge/.test(l)));
});

test("6.3.0 review L3: --unattended never overrides the user's own confirm ask, with or without the brief marker", async () => {
  for (const marker of [true, false]) {
    const out = await runOne(gated(), { ...U, confirm: "ask", user_confirm: "ask", brief_marker: marker });
    assert.equal(out.result.status, "awaiting_confirmation", marker + ": " + out.result.reason);
    assert.ok(!out.labels.includes("role:fleet-intent-judge"));
  }
  // the marker's ask alone (the user named default) is overridden
  const m = await runOne(gated(), { ...U, confirm: "ask", user_confirm: "default", brief_marker: true });
  assert.equal(m.result.status, "ok", m.result.reason);
  const bad = await runOne(gated(), { ...U, user_confirm: "yes" });
  assert.equal(bad.result.status, "needs_human");
  assert.match(bad.result.reason, /args\.user_confirm/);
  assert.equal(bad.calls.length, 0);
});
