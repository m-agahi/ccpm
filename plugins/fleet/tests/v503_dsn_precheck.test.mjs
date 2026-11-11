// fleet 5.0.3 (ledger 2010): a plan doc that holds mysql:// gets a re-plan
// finding before the plan commit.
//
// Run wf_9b66f476-b14 (yadgarhq/iam-db) passed plan-audit after 2 re-plans
// (53 minutes, 33 agents) and then stopped at infra:verify-plan-commit with
// stop_gate db: the committed plan held two placeholder DSNs
// (`mysql://<db>:<pw>@...`). The gate (4.0.0) refuses any mysql:// text, any
// case, placeholders included; no role told the planner. Max's ruling: keep
// the ban as it is, tell the planner, and check the plan bytes before the
// commit so a hit is a re-plan finding, not a stop. The post-commit gate
// stays unchanged as the backstop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HERE, SOURCE, SCRIPTS_SRC, ARGS, happy, runOne, call, inputsOf, redigest, spawnSync, scratchRepo, sh, K, PROGRAM_LABELS, PROGRAMS, sha256, canon } from "./harness.mjs";

const PLAN_DSN = join(SCRIPTS_SRC, "plan_dsn.py");
const PLAN_FILES = join(SCRIPTS_SRC, "plan_files.py");
const ROLE = readFileSync(join(HERE, "..", "roles", "scope-and-plan.md"), "utf8");
const WORKFLOW = join(HERE, "..", "workflows", "build-task-run.js");
const DSN_RE = /mysql:\/\//i;

function py(script, ...args) {
  const r = spawnSync("python3", ["-I", script, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}

function planRepo(text) {
  const wt = scratchRepo("fleet-dsn-");
  mkdirSync(join(wt, "docs/plans"), { recursive: true });
  writeFileSync(join(wt, "docs/plans/p.md"), text);
  return wt;
}

// the digest the workflow recomputes (relayDigestOk): the PROGRAM_KEYS keys and program
const digestOf = (o) => sha256(canon(Object.assign(Object.fromEntries(K("plan_dsn").map((k) => [k, o[k]])), { program: o.program })));

// a format-plan relay whose plan_dsn output holds (or not) mysql://
function fmtWith(holds, lines) {
  return (prompt) => {
    const i = inputsOf(prompt);
    return { status: "ok", reason: "formatted", changed_paths: [i.plan_path], dsn_check: { holds, lines: lines || [], args: [i.worktree, i.plan_path] } };
  };
}

// ---------------------------------------------------------------- the program

test("5.0.3 plan_dsn.py: a placeholder DSN in the plan doc holds, with its line", () => {
  const wt = planRepo("# plan\n\nrun with mysql://<db>:<pw>@127.0.0.1:<port>/<db>\nok\nMySQL://fleet_tw_ac1:<pw>@127.0.0.1:<port>/fleet_tw_ac1\n");
  const r = py(PLAN_DSN, wt, "docs/plans/p.md");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.holds, true);
  assert.deepEqual(r.out.lines, [3, 5]);
  assert.deepEqual(r.out.args, [wt, "docs/plans/p.md"]);
  assert.equal(r.out.program.name, "plan_dsn");
  assert.match(r.out.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.out.digest, digestOf(r.out), "the Python digest is the one the workflow recomputes");
  rmSync(wt, { recursive: true, force: true });
});

test("5.0.3 plan_dsn.py: a clean plan doc does not hold", () => {
  const wt = planRepo("# plan\n\nThe tests read the YADGAR_TEST_DSN URL from the environment.\n");
  const r = py(PLAN_DSN, wt, "docs/plans/p.md");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.holds, false);
  assert.deepEqual(r.out.lines, []);
  assert.equal(r.out.digest, digestOf(r.out));
  rmSync(wt, { recursive: true, force: true });
});

test("5.0.3 plan_dsn.py: a symlinked plan, a path outside the worktree or a missing plan fails closed", () => {
  const wt = planRepo("# plan\n");
  writeFileSync(join(wt, "outside.md"), "mysql://x\n");
  symlinkSync(join(wt, "outside.md"), join(wt, "docs/plans/link.md"));
  for (const p of ["docs/plans/link.md", "../x.md", "/etc/passwd", "docs/plans/none.md"]) {
    const r = py(PLAN_DSN, wt, p);
    assert.notEqual(r.code, 0, p + " must fail");
    assert.equal(r.out, null, p + " prints no JSON");
  }
  rmSync(wt, { recursive: true, force: true });
});

test("5.0.3 plan_dsn.py matches exactly what the post-commit gate (plan_files.py) refuses", () => {
  const cases = [
    "mysql://<db>:<pw>@127.0.0.1:<port>/<db>",
    "MySQL://u:p@h/d",
    "MYSQL://",
    "see mysql://",
    "mysql:/ /x",
    "mysqlx://u@h",
    "postgres://u@h/d",
    "the YADGAR_TEST_DSN URL",
    "mysql:\\/\\/x",
  ];
  for (const c of cases) {
    const wt = planRepo("# plan\n" + c + "\n");
    // 6.0.0 (ledger 2042): plan_files lists a commit against its parent
    sh(wt, "git", "commit", "-q", "--allow-empty", "-m", "base");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "p");
    const gate = py(PLAN_FILES, wt, "HEAD");
    const pre = py(PLAN_DSN, wt, "docs/plans/p.md");
    assert.equal(gate.code, 0, gate.err);
    assert.equal(pre.code, 0, pre.err);
    assert.equal(pre.out.holds, gate.out.dsn_paths.length > 0, JSON.stringify(c));
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the workflow

test("5.0.3 the format-plan step runs plan_dsn.py on the final plan bytes, and the slot is declared", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const p = call(out, "infra:format-plan").prompt;
  assert.ok(p.includes("/plan_dsn.py"), "the prompt runs the shipped program");
  // after the hooks: the program runs on the bytes the commit holds
  assert.ok(p.indexOf("pre-commit run --files") < p.indexOf("/plan_dsn.py"));
  assert.ok(PROGRAMS.some(([n]) => n === "plan_dsn"));
  assert.deepEqual(K("plan_dsn"), ["holds", "lines", "args"]);
  assert.ok(PROGRAM_LABELS.some(([re, slots]) => re.test("infra:format-plan") && slots.some(([s, n]) => s === "dsn_check" && n === "plan_dsn")));
  assert.ok(!out.labels.some((l) => /audit-fix/.test(l)), "a clean plan gets no re-plan round");
});

test("5.0.3 a placeholder mysql:// in the plan gets a re-plan finding before the audit and before any commit", async () => {
  const s = happy();
  s["infra:format-plan"] = fmtWith(true, [3]);
  s["infra:format-plan:audit-fix"] = fmtWith(false);
  s["role:scope-and-plan:audit-fix"] = s["role:scope-and-plan"];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const l = out.labels;
  // the first round never reaches the audit or a commit
  assert.ok(!l.includes("role:plan-audit"), "no audit for the refused round");
  assert.ok(l.indexOf("role:scope-and-plan:audit-fix") > l.indexOf("infra:format-plan"));
  const firstCommit = l.findIndex((x) => /^infra:(stage|commit)-plan/.test(x));
  assert.ok(firstCommit > l.indexOf("role:scope-and-plan:audit-fix"), "no commit before the re-plan");
  // the planner gets the finding, with the sanctioned wording and no literal
  const b = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt);
  const src = b.brief.sources.find((x) => x.kind === "text" && /YADGAR_TEST_DSN URL/.test(x.body));
  assert.ok(src, "a text source names the sanctioned wording");
  assert.match(src.body, /line 3/);
  assert.ok(!DSN_RE.test(src.body), "the finding holds no mysql:// literal");
  assert.ok(!DSN_RE.test(JSON.stringify(b.prior_round)), "prior_round holds no mysql:// literal");
});

test("5.0.3 the re-plan budget spent: the run stops at stop_gate db before any commit", async () => {
  const s = happy();
  s["infra:format-plan"] = fmtWith(true, [3]);
  s["role:scope-and-plan:audit-fix"] = s["role:scope-and-plan"];
  s["role:scope-and-plan:audit-fix-2"] = s["role:scope-and-plan"];
  s.__mutate = {
    label: /^infra:format-plan/,
    fn: (r, prompt) => {
      r.dsn_check.holds = true;
      r.dsn_check.lines = [3];
      return redigest("infra:format-plan", r, prompt);
    },
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /after 2 re-plan rounds/);
  assert.ok(!DSN_RE.test(out.result.reason));
  assert.ok(out.labels.includes("role:scope-and-plan:audit-fix-2"));
  assert.ok(!out.labels.some((x) => /^infra:(stage|commit)-plan|^role:plan-audit/.test(x)), "no audit and no commit");
});

test("5.0.3 a precheck relay that does not match its digest, or ran on other arguments, fails closed", async () => {
  for (const [fn, re] of [
    [(r) => ((r.dsn_check.holds = false), r), /dsn_check|digest/],
    [(r) => (delete r.dsn_check, r), /dsn_check|plan_dsn/],
    [(r, p) => redigest("infra:format-plan", Object.assign(r, { dsn_check: Object.assign(r.dsn_check, { args: ["/x", "docs/plans/x.md"] }) }), p), /other arguments/],
  ]) {
    const s = happy();
    s["infra:format-plan"] = fmtWith(true, [1]);
    s.__mutate = { label: "infra:format-plan", fn };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.match(out.result.reason, re);
    assert.ok(!out.labels.some((x) => /audit-fix|^role:plan-audit|^infra:commit-plan/.test(x)));
  }
});

test("5.0.3 the planner role names the ban and the sanctioned wording", () => {
  assert.match(ROLE, /`mysql:\/\/`/);
  assert.match(ROLE, /placeholder/i);
  assert.match(ROLE, /any case/i);
  assert.match(ROLE, /the YADGAR_TEST_DSN URL/);
  assert.match(ROLE, /plan commit/);
  // review nit: the role quotes the scheme name only, never a DSN shape a planner could copy
  assert.ok(!/mysql:\/\/[^`]/i.test(ROLE), "the role holds no mysql:// example");
});

// ---------------------------------------------------------------- non-weakening

test("5.0.3 the post-commit gate still refuses mysql:// (backstop unchanged)", async () => {
  // the program is 5.0.2's but for 6.0.0 (ledger 2042): it lists a given commit against its parent
  const sha = (/"plan_files": "([0-9a-f]{64})"/.exec(SOURCE) || [])[1];
  assert.equal(sha, "a985309a34cc229fd08087c34933b6b752fa56896c194393b19d59ea99361e14");
  assert.match(readFileSync(PLAN_FILES, "utf8"), /b'mysql:\/\/' in d\.stdout\.lower\(\)/);
  // a clean precheck does not let a held DSN past verify-plan-commit
  const s = happy();
  s.__mutate = {
    label: "infra:verify-plan-commit",
    fn: (r, prompt) => {
      r.plan_files.dsn_paths = [r.plan_files.files[0]];
      return redigest("infra:verify-plan-commit", r, prompt);
    },
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /verify-plan-commit: the committed plan .* holds mysql:\/\//);
  assert.equal(out.result.plan_ref, undefined);
});

test("5.0.3 the workflow stays at most 480000 bytes", () => {
  assert.ok(statSync(WORKFLOW).size <= 480000, "build-task-run.js is " + statSync(WORKFLOW).size + " bytes");
});
