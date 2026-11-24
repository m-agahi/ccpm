// fleet 7.3.0 review fixes (minor and nit findings).
// m1 (#33): a draft PR with an orchestrator or IaC sign keeps the read-only CI watch (ADR-1199).
// m2: the run's warnings ride the run-state and come back on a resume; a clean rescan takes the
//   scan warning out of the PR test block.
// m3: parked.py retire moves only <x>/scratch/parked/<run> into <x>/scratch/parked/used.
// loadParked: a parked part read over the agent cap is soft (the draft is ignored, no cap stop).
// #63: the intake text says what briefProblem checks (any dot dir, scratch, parked).
// nits: #53 decision text, policy-draft finish reason.
//
// dont_care: gate line wording beyond what is pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, HASHES, DIST, SCRIPTS_SRC, happy, run, runOne, call, inputsOf, stateJsonOf, spawnSync } from "./harness.mjs";

const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "no policy file", error: null, now: 1000, args: inputsOf(p).args }, over);
const scan = (over) => (p) => Object.assign({ status: "ok", reason: "s", orchestrator: false, iac_repo: false, apply_on_merge: false, hook_surface_pr: false, reasons: [], error: null, args: inputsOf(p).args }, over);

test("7.3.0 review m1: a policy draft with an IaC sign keeps the CI watch and merges nothing; without a sign it is not run", async () => {
  const s = happy();
  s["infra:policy"] = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { pr_ready: false }) });
  s["infra:orch-scan"] = scan({ iac_repo: true, reasons: ["IaC repo"] });
  const out = await run(s, ARGS);
  assert.ok(out.build.labels.some((l) => /^infra:ci-watch/.test(l)), out.build.labels.join(", "));
  assert.ok(!out.build.labels.some((l) => /^infra:pr-(merge|ready)/.test(l)), out.build.labels.join(", "));
  const plain = happy();
  plain["infra:policy"] = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { pr_ready: false }) });
  const p = await run(plain, ARGS);
  assert.ok(!p.build.labels.some((l) => /^infra:ci-watch/.test(l)));
  // nit: a policy draft's finish reason names the policy
  assert.match(p.result.reason, /^draft PR \(policy pr_ready false\)/);
});

test("7.3.0 review m1: a red check on that draft IaC PR is report-only: no CI-fix round, no push, no rerun", async () => {
  const s = happy();
  s["infra:policy"] = polOut({ caps: Object.assign({}, DEFAULT_CAPS, { pr_ready: false, ci_trigger: true }) });
  s["infra:orch-scan"] = scan({ iac_repo: true, reasons: ["IaC repo"] });
  s["infra:ci-watch:w1"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "w", state: "red", checks: [{ name: "test", state: "FAILURE", bucket: "fail", url: "https://github.com/o/r/actions/runs/77/job/88" }], failed: [{ name: "test", url: "https://github.com/o/r/actions/runs/77/job/88", run_id: "77", excerpt: "FAILED", verified: true }], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
  };
  s["role:fleet-ci-classifier:w1"] = { status: "ok", reason: "c", checks: [{ name: "test", cause: "diff" }] };
  const out = await run(s, ARGS);
  const after = out.build.labels.slice(out.build.labels.indexOf("infra:ci-watch:w1"));
  assert.ok(out.build.labels.includes("infra:ci-watch:w1"), out.build.labels.join(", "));
  assert.ok(!after.some((l) => /^role:fleet-coder|^infra:push|^infra:ci-rerun|^infra:pr-(merge|ready)/.test(l)), after.join(", "));
});

test("7.3.0 review m2: warnings ride the run-state; a resume restores them; a clean rescan clears the scan warning", async () => {
  const states = {};
  const s = happy();
  s["infra:orch-scan"] = scan({ error: "truncated tree" });
  s["infra:orch-scan:retry"] = scan({ error: "truncated tree" });
  for (const label of ["infra:state:pr_open:p1", "infra:state:shipped"]) {
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" };
  const first = await runOne(s, bargs);
  assert.deepEqual(states.shipped.warnings, [{ gate: "orch_scan", error: "truncated tree" }]);
  assert.deepEqual(first.result.warnings, [{ gate: "orch_scan", error: "truncated tree" }]);
  // resume at pr_open with the warning; this time the scan is clean
  const x = Object.assign({}, states.pr_open, { scan_warn: "Orchestrator/IaC scan error: truncated tree. x", warnings: [{ gate: "orch_scan", error: "truncated tree" }] });
  const r = happy();
  Object.assign(r, s);
  delete r["infra:orch-scan"];
  delete r["infra:orch-scan:retry"];
  r["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  r["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
  const h = JSON.parse(JSON.stringify(HASHES));
  h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
  r["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
  const out = await runOne(r, bargs);
  assert.deepEqual(out.result.warnings, [{ gate: "orch_scan", error: "truncated tree" }], out.result.reason);
  const c = out.calls.find((k) => k.label === "infra:pr-tests:scan-clear");
  assert.ok(c, out.labels.join(", "));
  const tb = Buffer.from(inputsOf(c.prompt).args[3], "base64").toString("utf8");
  assert.ok(!tb.includes("Orchestrator/IaC scan error"), tb);
  assert.equal(states.shipped.scan_warn, null);
});

test("7.3.0 review m3: parked.py retire moves only <x>/scratch/parked/<run> into <x>/scratch/parked/used", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-730m-")));
  try {
    const parked = join(root, "fleet-k", "scratch", "parked");
    mkdirSync(join(parked, "n1-0000001"), { recursive: true });
    const py = (...a) => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "parked.py"), "retire", ...a], { encoding: "utf8" });
    const other = join(root, "elsewhere", "n1-0000002");
    mkdirSync(other, { recursive: true });
    for (const [src, used] of [
      [other, join(root, "elsewhere", "used")],
      [join(parked, "n1-0000001"), join(root, "used")],
      [join(parked, "n1-0000001"), join(parked, "other")],
      [join(parked, "used"), join(parked, "used")],
    ])
      assert.notEqual(py(src, used).status, 0, src + " -> " + used);
    assert.ok(existsSync(other) && existsSync(join(parked, "n1-0000001")));
    const ok = py(join(parked, "n1-0000001"), join(parked, "used"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).moved, true);
    assert.ok(existsSync(join(parked, "used", "n1-0000001")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const pieces = (t) => {
  const o = [];
  for (let i = 0; i < t.length; i += 1000) o.push(t.slice(i, i + 1000));
  return o;
};
test("7.3.0 review: parked part reads over the agent cap are soft (the draft is ignored), never the cap stop", async () => {
  const s = happy();
  // 9 agents run before the parts; p1 is the 10th; p2 meets the cap
  // 8.6.0 (ADR-1403): the dist writes `MAX_AGENTS=100` (whitespace collapsed)
  s.__source = DIST.replace("MAX_AGENTS=100", "MAX_AGENTS=10");
  assert.notEqual(s.__source, DIST, "the dist holds MAX_AGENTS=100");
  s["infra:load-parked"] = (p) => {
    const i = inputsOf(p);
    return { status: "ok", reason: "read", parked: { run: "n0-1234567", plan_path: "docs/plans/x.md", draft_chunks: pieces("# d\n" + "d".repeat(70000)), findings_chunks: [] }, args: [i.scratch, "null"] };
  };
  const out = await runOne(s, ARGS);
  assert.doesNotMatch(String(out.result.reason), /parked draft parts/);
  assert.ok(out.logs.some((l) => /^parked draft ignored \(/.test(l)), out.logs.join("\n"));
});

test("7.3.0 review #63: the intake TRACKED text names every dot dir, scratch and parked", async () => {
  const out = await runOne(happy(), ARGS);
  const p = call(out, "intake").prompt;
  assert.ok(p.includes("has no path part that starts with a dot (such as `.claude/`) or is `scratch` or `parked`"), p);
});
