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
  ARGS, PB, PC, FP_TESTS, HASHES_FLAT, SOURCE, SCRIPTS_SRC, H, happy, run, runOne, call, inputsOf, noUnscripted, commitStub, spawnSync, stateJsonOf,
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
  const out = await runOne(mk(), U);
  assert.notEqual(out.result.failed_check, "intent", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-intent-judge").prompt).relaxed, ["criterion AC2 dropped"]);
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
function planWrong(s) {
  return Object.assign(s, {
    "role:fleet-code-judge:r1": { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: split AC2" }] },
    "infra:replan-worktree": { status: "ok", reason: "ok", head: PC },
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: "d".repeat(64) },
    "infra:commit-plan:replan": commitStub(s.__store, PC2, "d".repeat(64)),
    "infra:replan-reset": { status: "ok", reason: "reset", head: PB, superseded_head: "5555555" },
    "hasher:pre-intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "hasher:fp-post:intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge:replan": s["role:fleet-intent-judge"],
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } },
  });
}

test("6.3.0 B: a plan_wrong re-plan under unattended runs the auto gates on the new plan and builds it in the same run", async () => {
  const s = planWrong(gated());
  const out = await runOne(s, U);
  assert.ok(out.labels.includes("role:fleet-intent-judge:replan"), out.labels.join(", "));
  assert.ok(decisions(out).some((d) => /^plan_wrong: build \(code-judge re-plan 1: the auto gates, then the build in this run\)$/.test(d)), decisions(out).join("\n"));
  const i = out.labels.indexOf("infra:replan-reset");
  // a second build from the new plan (the fixture's verify stub knows only the first plan, so it stops there)
  assert.ok(i > 0 && out.labels.slice(i).includes("infra:load-ref") && out.labels.slice(i).includes("infra:verify-plan"), out.labels.slice(i).join(", "));
  assert.notEqual(out.result.status, "awaiting_confirmation");
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
  ["commit integrity", (s) => { const f = s["infra:commit:r1"]; s["infra:commit:r1"] = (p, o) => Object.assign(typeof f === "function" ? f(p, o) : JSON.parse(JSON.stringify(f)), { staged_tree: "BAD" }); }, (o) => assert.equal(o.result.stop_gate, "commit")],
];

test("6.3.0 B (ADR-1239): unattended never bypasses a safety stop (hooks, IaC, intent, scope, commands, contract, DSN, relaunch, fingerprint, freeze, ownership, hash, commit)", async () => {
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
