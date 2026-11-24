// ccpmcwf 8.5.6 (yaadgaar #108 step 3 + item 8, ADR-1397): plan checkpoint and run cost budget.
// P1: a stop after an approving plan-audit parks the audited plan (raw planner output, the doc's sha256,
//     base HEAD, task source hash, version, round, fingerprint); the stop result names it (`checkpoint`).
//     A re-run with args.checkpoint that proves it still holds runs no planner and no audit: the draft goes
//     back into the worktree (parked.py unpark) and every other plan check runs on it again.
// P3: the parked round count and findings fingerprint carry into the re-run (same task source only).
// Item 8: a per-run budget of output tokens (budget.spent() growth), checked between steps only.
//
// Run: node --test plugins/ccpmcwf/tests/v856_plan_checkpoint.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, BRIEF, PB, PC, HASHES_FLAT, H, SCRIPTS_SRC, happy, runOne, inputsOf, sha256, spawnSync, commitStub, PARK_WRITES, NONCE } from "./harness.mjs";

const DRAFT = "# plan for thing\n\nthe audited draft\n";
const DSHA = sha256(DRAFT);
const PLAN_PATH = "docs/plans/x.md";
const RUN2 = "n2-0000002";
const pieces = (t) => {
  const out = [];
  for (let i = 0; i < t.length; i += 1000) out.push(t.slice(i, i + 1000));
  return out;
};
// the parked meta stub (harness turns it into parked.py read + read-part relays)
const parkedStub = (findings, draft = DRAFT, run = NONCE) => (prompt) => {
  const i = inputsOf(prompt);
  return { status: "ok", reason: "read", parked: { run, plan_path: PLAN_PATH, draft_chunks: pieces(draft), findings_chunks: pieces(findings) }, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
};
// a scenario whose staged and formatted doc is DRAFT
function withDraft(s) {
  s["infra:stage-plan"] = { status: "ok", reason: "staged", plan_sha256: DSHA };
  s["infra:commit-plan"] = commitStub(s.__store, PC, DSHA);
  return s;
}
// run 1: plan-audit approves, then stage-plan fails (a stop after the approval)
async function stopAfterAudit(mut) {
  const s = withDraft(happy());
  s["infra:stage-plan"] = { status: "failed", reason: "disk full", plan_sha256: DSHA };
  if (mut) mut(s);
  const out = await runOne(s, ARGS);
  return { out, findings: PARK_WRITES.get(NONCE) };
}
async function resume(findings, over = {}, mut, draft) {
  const s = withDraft(happy());
  s["infra:load-parked"] = parkedStub(findings, draft);
  if (mut) mut(s);
  return runOne(s, Object.assign({}, ARGS, { run_nonce: RUN2 }, over));
}
const planner = (o) => o.labels.filter((l) => /^role:scope-and-plan/.test(l));
const audits = (o) => o.labels.filter((l) => /^role:plan-audit/.test(l));
const reckpt = (findings, f) => {
  const j = JSON.parse(findings);
  const c = JSON.parse(j.ckpt);
  f(c);
  j.ckpt = JSON.stringify(c);
  return { findings: JSON.stringify(j), checkpoint: { run: NONCE, sha256: sha256(j.ckpt) } };
};

// ---------------------------------------------------------------- P1

test("8.5.6 P1: a stop after an approved audit parks a checkpoint; the re-run runs no planner and no audit and reaches confirmation", async () => {
  const { out, findings } = await stopAfterAudit();
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(planner(out).length === 1 && audits(out).length === 1);
  assert.equal(out.result.checkpoint.run, NONCE);
  assert.match(out.result.checkpoint.sha256, /^[0-9a-f]{64}$/);
  const j = JSON.parse(findings);
  assert.equal(sha256(j.ckpt), out.result.checkpoint.sha256);
  const c = JSON.parse(j.ckpt);
  assert.equal(c.sha, DSHA);
  assert.equal(c.base, PB);
  // the held-out examples went to their store (run 1 had not reached the seal); the checkpoint carries only the store meta
  assert.ok(out.labels.includes("infra:held-out:write"), out.labels.join(", "));
  assert.equal(c.held.count, 1);
  assert.ok(!JSON.stringify(c).includes("held(1)"), "no held-out example text in the park");
  const r = await resume(findings, { checkpoint: out.result.checkpoint });
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.deepEqual(planner(r), [], r.labels.join(", "));
  assert.deepEqual(audits(r), [], r.labels.join(", "));
  assert.ok(r.labels.includes("infra:unpark-plan"), r.labels.join(", "));
  assert.match(r.labels.find((l) => l === "infra:unpark-plan"), /unpark/);
  assert.ok(r.result.gate_log.some((g) => /^checkpoint of run n1-0000001: resumed after plan-audit/.test(g)), r.result.gate_log.join("\n"));
  // the seal keeps the held-out store meta of run 1 (no example is lost)
  assert.ok(r.result.gate_log.every((g) => !/held-out: .*held_out null/.test(g)), r.result.gate_log.filter((g) => /held-out/.test(g)).join("\n"));
  // the saving, measured: today's re-run of the same parked plan (no checkpoint) vs the resumed run
  const full = await resume(findings, {});
  assert.equal(full.result.status, "awaiting_confirmation");
  console.log("8.5.6 agents: re-run without checkpoint " + full.result.agents + " (" + full.labels.filter((l) => /^role:/.test(l)).join(", ") + "), resumed run " + r.result.agents + " (" + r.labels.filter((l) => /^role:/.test(l)).join(", ") + ")");
  assert.equal(full.result.agents - r.result.agents, 2);
});

test("8.5.6 P1: the unpark step runs parked.py unpark with the worktree, plan path, scratch, run and audited sha256", async () => {
  const { out, findings } = await stopAfterAudit();
  const r = await resume(findings, { checkpoint: out.result.checkpoint });
  const c = r.calls.find((x) => x.label === "infra:unpark-plan");
  assert.match(c.prompt, new RegExp("parked\\.py' 'unpark' '[^']*' '" + PLAN_PATH + "' '[^']*/scratch' '" + NONCE + "' '" + DSHA + "'"));
});

test("8.5.6 P1 fail-safe: a changed task source, base HEAD, draft, version or no args.checkpoint falls back to a full plan and logs why", async () => {
  const { out, findings } = await stopAfterAudit();
  const ck = { checkpoint: out.result.checkpoint };
  const cases = [
    ["the task source changed", () => resume(findings, ck, (s) => (s.intake = Object.assign({}, s.intake, { brief: Object.assign({}, BRIEF, { sources: [Object.assign({}, BRIEF.sources[0], { body: "task body, edited" })] }) })))],
    ["base HEAD " + PB + " is now", () => resume(findings, ck, (s) => (s["infra:branch-scan"] = Object.assign({}, s["infra:branch-scan"], { head: "c0ffee12345" })))],
    ["the parked draft is not the audited one", () => resume(findings, ck, null, DRAFT + "tampered\n")],
    ["parked by ccpmcwf 8.0.0", () => {
      const x = reckpt(findings, (c) => (c.v = "8.0.0"));
      return resume(x.findings, { checkpoint: x.checkpoint });
    }],
    ["args.checkpoint does not name it", () => resume(findings, {})],
    ["args.checkpoint does not name it", () => resume(findings, { checkpoint: { run: NONCE, sha256: "0".repeat(64) } })],
  ];
  for (const [why, go] of cases) {
    const r = await go();
    assert.equal(planner(r).length, 1, why + ": " + r.labels.join(", "));
    assert.equal(audits(r).length, 1, why);
    assert.ok(!r.labels.includes("infra:unpark-plan"), why);
    assert.ok(r.result.gate_log.some((g) => g.startsWith("checkpoint of run " + NONCE + " not used (" + why)), why + "\n" + r.result.gate_log.filter((g) => /checkpoint/.test(g)).join("\n"));
  }
});

test("8.5.6 P1 non-weakening: the hook surface and the command allowlist still stop a resumed plan", async () => {
  const { out, findings } = await stopAfterAudit();
  const hook = reckpt(findings, (c) => {
    const p = JSON.parse(c.plan);
    p.allowed_additions = { files: [".github/workflows/ci.yml"], symbols: [], deps: [], settings: [] };
    c.plan = JSON.stringify(p);
  });
  const h = await resume(hook.findings, { checkpoint: hook.checkpoint });
  assert.equal(h.result.stop_gate, "hooks", h.result.reason);
  assert.deepEqual(planner(h), []);
  const cmd = reckpt(findings, (c) => {
    const p = JSON.parse(c.plan);
    p.test_cmd = { command: "pytest `id`" };
    c.plan = JSON.stringify(p);
  });
  const k = await resume(cmd.findings, { checkpoint: cmd.checkpoint });
  assert.equal(k.result.stop_gate, "commands", k.result.reason);
  assert.deepEqual(planner(k), []);
  // the plan sweep runs on a resumed plan that touches a gate
  const sw = reckpt(findings, (c) => {
    const p = JSON.parse(c.plan);
    p.touches_gate = true;
    c.plan = JSON.stringify(p);
  });
  const w = await resume(sw.findings, { checkpoint: sw.checkpoint });
  assert.ok(w.labels.includes("role:gate-change-nonweakening-sweep:plan"), w.labels.join(", "));
});

test("8.5.6 P1 non-weakening: a relaxed audited plan stays relaxed on resume (confirm default asks)", async () => {
  const { out, findings } = await stopAfterAudit();
  const x = reckpt(findings, (c) => (c.prior = { reason: "r", findings: [], symbols: [], changed_symbols: [], round0: { change_kind: "feature", new_behaviour: true, criteria: [] }, criteria_by_round: [], relaxed: ["change_kind feature→bug_fix"] }));
  const r = await resume(x.findings, { checkpoint: x.checkpoint, confirm: "default" });
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.match(r.result.confirm_reason, /re-plan relaxed/);
});

test("8.5.6 P1: a resumed doc that formats to another sha256 stops at gate scope", async () => {
  const { out, findings } = await stopAfterAudit();
  const r = await resume(findings, { checkpoint: out.result.checkpoint }, (s) => (s["infra:stage-plan"] = { status: "ok", reason: "staged", plan_sha256: "b".repeat(64) }));
  assert.equal(r.result.status, "needs_human", r.result.reason);
  assert.equal(r.result.stop_gate, "scope");
  assert.match(r.result.reason, /resumed plan doc hashes/);
});

test("8.5.6 P1: a stop before the approval parks no checkpoint", async () => {
  const s = happy();
  s["role:plan-audit"] = s["role:plan-audit:audit-fix"] = s["role:plan-audit:audit-fix-2"] = { status: "ok", reason: "x", verdict: "plan_defect", routed_findings: [{ criterion: "AC1", finding: "same" }] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.checkpoint, undefined);
  assert.equal(JSON.parse(PARK_WRITES.get(NONCE)).ckpt, null);
});

// ---------------------------------------------------------------- P3

const DEFECT = { status: "ok", reason: "x", verdict: "plan_defect", routed_findings: [{ criterion: "AC1", finding: "the same defect" }] };
async function noProgressRun() {
  const s = happy();
  s["role:plan-audit"] = s["role:plan-audit:audit-fix"] = DEFECT;
  const out = await runOne(s, ARGS);
  return { out, findings: PARK_WRITES.get(NONCE) };
}

test("8.5.6 P3: the parked round count continues, and an identical parked fingerprint stops at once", async () => {
  const { out, findings } = await noProgressRun();
  assert.match(out.result.reason, /no progress/);
  const j = JSON.parse(findings);
  assert.equal(j.round, 1);
  assert.match(j.fp, /^[0-9a-f]{16}$/);
  const r = await resume(findings, {}, (s) => (s["role:plan-audit"] = s["role:plan-audit:audit-fix"] = s["role:plan-audit:audit-fix-2"] = DEFECT));
  assert.equal(r.result.status, "needs_human", r.result.reason);
  assert.match(r.result.reason, /no progress/);
  assert.equal(planner(r).length, 1, r.labels.join(", "));
  assert.ok(r.result.gate_log.includes("plan findings fingerprint round 1: " + j.fp), r.result.gate_log.filter((g) => /fingerprint/.test(g)).join("\n"));
  assert.ok(Array.isArray(r.result.options) && r.result.options.length >= 2);
});

test("8.5.6 P3: a changed task source starts at round 0 and gets its re-plan round", async () => {
  const { findings } = await noProgressRun();
  const r = await resume(findings, {}, (s) => {
    s["role:plan-audit"] = DEFECT;
    s.intake = Object.assign({}, s.intake, { brief: Object.assign({}, BRIEF, { sources: [Object.assign({}, BRIEF.sources[0], { body: "task body, edited" })] }) });
  });
  assert.match(r.result.reason, /round 1 repeats round 0/);
  assert.ok(r.labels.includes("role:scope-and-plan:audit-fix"), r.labels.join(", "));
  assert.ok(r.result.gate_log.includes("plan findings fingerprint round 0: " + JSON.parse(findings).fp));
});

// ---------------------------------------------------------------- item 8: the budget

const spending = (per) => {
  let n = 0;
  return { total: null, spent: () => (n += per), remaining: () => Infinity };
};

test("8.5.6 budget: a plan run over the budget stops between steps at gate budget with a checkpoint; the re-run resumes", async () => {
  const s = withDraft(happy());
  s.__budget = spending(100000);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "budget");
  assert.match(out.result.reason, /^run budget: \d+ output tokens of 600000 spent before the plan commit/);
  assert.ok(Array.isArray(out.result.options) && out.result.options.length === 3);
  assert.ok(!out.labels.includes("infra:stage-plan"), "no step after the budget stop");
  assert.ok(out.result.checkpoint, "the budget stop parks the checkpoint");
  const r = await resume(PARK_WRITES.get(NONCE), { checkpoint: out.result.checkpoint });
  assert.equal(r.result.status, "awaiting_confirmation", r.result.reason);
  assert.deepEqual(planner(r), []);
});

test("8.5.6 budget: a re-plan round over the budget stops before the planner runs again", async () => {
  const s = happy();
  s["role:plan-audit"] = DEFECT;
  s.__budget = spending(100000);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_gate, "budget", out.result.reason);
  assert.match(out.result.reason, /before re-plan round 1;/);
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix"));
});

test("8.5.6 budget: under the budget (or with no runtime budget) nothing stops", async () => {
  const s = withDraft(happy());
  s.__budget = spending(1000);
  const a = await runOne(s, ARGS);
  assert.equal(a.result.status, "awaiting_confirmation", a.result.reason);
  const t = withDraft(happy());
  t.__budget = { total: null };
  const b = await runOne(t, ARGS);
  assert.equal(b.result.status, "awaiting_confirmation", b.result.reason);
});

test("8.5.6 budget: a build over the budget stops after the freeze, before the coder, with freeze_digest; the re-run resumes at the coder", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation");
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref });
  delete bargs.input;
  s.__budget = spending(100000);
  const b = await runOne(s, bargs);
  assert.equal(b.result.stop_gate, "budget", b.result.reason);
  assert.match(b.result.reason, /before the coder(;|$)/);
  assert.ok(!b.labels.includes("role:fleet-coder:r1"));
  assert.match(b.result.freeze_digest, /^[0-9a-f]{64}$/);
  delete s.__budget;
  const h = H(HASHES_FLAT);
  h.git["fleetref:" + plan.result.plan_ref.plan_ref.replace(/\/plan$/, "/freeze")] = "T1";
  s["hasher:resume-frozen"] = { status: "ok", fingerprint: { head: PB, tree: "T1" }, hashes: h };
  const r = await runOne(s, Object.assign({}, bargs, { freeze_digest: b.result.freeze_digest }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "frozen");
});

test("8.5.6 budget: the policy's run_budget replaces the default", async () => {
  const s = withDraft(happy());
  s.__budget = spending(100000);
  s["infra:policy:plan"] = (prompt) => {
    const i = inputsOf(prompt);
    return { status: "ok", reason: "read", profile: "p", file: "/c/fleet/policy.json", policy_sha256: "c".repeat(64), caps: { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none", run_budget: 100000000 }, matched: "profile p", error: null, now: 1, args: i.args || ["github.com", "o/r"] };
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

// ---------------------------------------------------------------- the shipped programs

function py(name, args, env) {
  return spawnSync("python3", ["-I", join(SCRIPTS_SRC, name + ".py"), ...args], { encoding: "utf8", env: Object.assign({ PATH: process.env.PATH }, env || {}) });
}
function git(cwd, ...a) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

test("8.5.6 parked.py unpark: copies the parked draft into a clean worktree only when its bytes hash to the sha256", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-856u-"));
  try {
    const wt = join(root, "main");
    const scratch = join(root, "scratch");
    mkdirSync(wt);
    git(wt, "init", "-q");
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-q", "-m", "a");
    mkdirSync(join(scratch, "parked", "n1-0000001", "docs", "plans"), { recursive: true });
    writeFileSync(join(scratch, "parked", "n1-0000001", PLAN_PATH), DRAFT);
    const bad = py("parked", ["unpark", wt, PLAN_PATH, scratch, "n1-0000001", "b".repeat(64)]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /hashes/);
    assert.ok(!existsSync(join(wt, PLAN_PATH)));
    writeFileSync(join(wt, "a.txt"), "dirty\n");
    const dirty = py("parked", ["unpark", wt, PLAN_PATH, scratch, "n1-0000001", DSHA]);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /not clean/);
    git(wt, "checkout", "--", "a.txt");
    const ok = py("parked", ["unpark", wt, PLAN_PATH, scratch, "n1-0000001", DSHA]);
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.sha256, DSHA);
    assert.deepEqual(out.args, [wt, PLAN_PATH, scratch, "n1-0000001", DSHA]);
    assert.equal(readFileSync(join(wt, PLAN_PATH), "utf8"), DRAFT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8.5.6 policy.py: run_budget is an integer 10000-100000000 in a profile or a repos override; anything else is the strict default", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-856p-"));
  try {
    mkdirSync(join(home, ".config", "fleet"), { recursive: true });
    const run = (prof, repo) => {
      writeFileSync(join(home, ".config", "fleet", "policy.json"), JSON.stringify({ version: 1, profiles: [Object.assign({ name: "p", match: { owners: ["m-agahi"] } }, prof, repo ? { repos: { "m-agahi/ccpm": repo } } : {})] }));
      const r = py("policy", ["github.com", "m-agahi/ccpm"], { HOME: home });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assert.equal(run({ run_budget: 900000 }).caps.run_budget, 900000);
    assert.equal(run({ run_budget: 900000 }, { run_budget: 50000 }).caps.run_budget, 50000);
    assert.ok(!("run_budget" in run({}).caps));
    for (const bad of [true, "900000", 5, 1.5]) {
      const o = run({ run_budget: bad });
      assert.match(o.error, /run_budget must be an integer/);
      assert.ok(!("run_budget" in o.caps));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
