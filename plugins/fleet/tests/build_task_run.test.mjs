// Scenario tests for workflows/build-task-run.js.
//
// The workflow runs inside the Claude Code workflow runtime, which supplies
// agent/parallel/pipeline/phase/log/args as globals and allows a top-level
// `return`. This harness loads the script source, drops `export ` from the
// meta declaration, and wraps the body in an AsyncFunction with stubbed
// globals. Each stubbed agent call is answered from a script keyed by the
// agent's label. An unscripted label is recorded and fails the test, so label
// drift is loud.
//
// Run: node --test plugins/fleet/tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "..", "workflows", "build-task-run.js");
const SOURCE = readFileSync(SCRIPT_PATH, "utf8");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compile() {
  const body = SOURCE.replace(/^export const meta/m, "const meta");
  return new AsyncFunction(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    "Date",
    "Math",
    body,
  );
}

const ThrowingDate = function () {
  throw new Error("Date is unavailable in workflow scripts");
};
ThrowingDate.now = () => {
  throw new Error("Date.now is unavailable in workflow scripts");
};
const SafeMath = Object.create(Math);
SafeMath.random = () => {
  throw new Error("Math.random is unavailable in workflow scripts");
};

// Extract the JSON inputs a role-runner or infra prompt carries.
function inputsOf(prompt) {
  const m = /^Inputs: (.*)$/m.exec(prompt);
  assert.ok(m, "prompt has an Inputs: line:\n" + prompt);
  return JSON.parse(m[1]);
}

// The minimum role versions the workflow was built against.
const FROZEN_VERSIONS = {
  "scope-and-plan": 16,
  "plan-audit": 11,
  "fleet-test-writer": 7,
  "fleet-test-judge": 7,
  "fleet-coder": 10,
  "fleet-code-judge": 9,
  "fleet-pr-opener": 5,
};

// Keys each role must return on status ok (the frozen fleet-v2 contract).
// The harness fills missing ones with neutral defaults for terse override
// stubs; a stub with __raw: true is returned as written (drift tests).
const REQUIRED_DEFAULTS = {
  "scope-and-plan": { plan_path: "docs/plans/x.md", criteria: [], est_diff_lines: 80, new_behaviour: true, allowed_additions: { files: [], symbols: [], deps: [], settings: [] }, held_out_examples: [], tldr: "adds a thing", plan_diff: ["new plan"], repo_obligations: [], test_cmd: { command: "pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: [] } },
  "plan-audit": { verdict: "approve", routed_findings: [] },
  "fleet-test-writer": { criterion_id: "AC1", tests: [], commit: null },
  "fleet-test-judge": { verdict: "approve", routed_findings: [], checked: [] },
  "fleet-coder": { commits: [], suite_result: { command: "pytest", exit_code: 0 }, added_symbols: [], frozen_tests_red_at_start: true, obligations_done: [] },
  "fleet-code-judge": { verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 }, hash_check: { match: true, mismatched: [] }, gates_not_run: [], obligations_check: [] },
  "fleet-pr-opener": { pr_url: null, pr_number: null, created: true, template_used: null, gates_not_run_stated: true },
};

async function runOne(script, args) {
  const calls = [];
  const unscripted = [];
  const logs = [];
  const counters = {};
  const agent = async (prompt, opts = {}) => {
    const label = opts.label;
    calls.push({ label, prompt, opts });
    // the bytecode purge is mechanical; unscripted purges succeed by default
    if (!(label in script) && /^infra:purge-bytecode:/.test(label)) return { status: "ok", reason: "purged", purged: 0 };
    if (!(label in script)) {
      unscripted.push(label);
      return null;
    }
    let r = script[label];
    if (Array.isArray(r)) {
      const i = counters[label] || 0;
      counters[label] = i + 1;
      r = r[Math.min(i, r.length - 1)];
    }
    if (typeof r === "function") r = r(prompt, opts);
    if (r === undefined || r === null) return null;
    r = JSON.parse(JSON.stringify(r));
    const raw = r.__raw === true;
    delete r.__raw;
    if (label.startsWith("role:") && !raw) {
      const role = label.split(":")[1];
      // role runners report the version and contract marker they loaded
      if (!("role_version" in r)) {
        const pv = script.preflight && script.preflight.versions ? script.preflight.versions[role] : undefined;
        r.role_version = pv !== undefined ? pv : FROZEN_VERSIONS[role];
      }
      if (!("role_contract" in r)) r.role_contract = "CONTRACT: fleet-v2";
      if (r.status === "ok")
        for (const [k, v] of Object.entries(REQUIRED_DEFAULTS[role] || {})) if (!(k in r)) r[k] = v;
    }
    return r;
  };
  const parallel = async (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = async (items, ...stages) =>
    Promise.all(
      items.map(async (item, idx) => {
        let prev = item;
        try {
          for (const s of stages) prev = await s(prev, item, idx);
          return prev;
        } catch {
          return null;
        }
      }),
    );
  const fn = compile();
  const result = await fn(
    agent,
    parallel,
    pipeline,
    () => {},
    (m) => logs.push(m),
    args,
    { total: null, spent: () => 0, remaining: () => Infinity },
    async () => {
      throw new Error("nested workflow not expected");
    },
    ThrowingDate,
    SafeMath,
  );
  return { result, calls, unscripted, logs, labels: calls.map((c) => c.label) };
}

// Plan mode, then (when it returns awaiting_confirmation) build mode with the
// returned plan_ref, as the skill does after Max confirms. The merged view
// holds both runs' calls; .plan and .build hold each run alone.
async function run(script, args, buildOver) {
  const plan = await runOne(script, args);
  if (!plan.result || plan.result.status !== "awaiting_confirmation" || !args || typeof args !== "object" || args.mode !== "plan")
    return Object.assign({}, plan, { plan, build: null });
  const bargs = Object.assign({}, args, { mode: "build", plan_ref: plan.result.plan_ref }, buildOver || {});
  delete bargs.input;
  const build = await runOne(script, bargs);
  return {
    result: build.result,
    planResult: plan.result,
    calls: plan.calls.concat(build.calls),
    unscripted: plan.unscripted.concat(build.unscripted),
    logs: plan.logs.concat(build.logs),
    labels: plan.labels.concat(build.labels),
    plan,
    build,
  };
}

function call(out, label) {
  const c = out.calls.find((x) => x.label === label);
  assert.ok(c, "expected a call labelled " + label + "; got " + out.labels.join(", "));
  return c;
}

function noUnscripted(out) {
  assert.deepEqual(out.unscripted, [], "unscripted agent labels");
}

const ARGS = {
  mode: "plan",
  input: "L42",
  repo: "/r",
  project: "o/r",
  date: "2026-11-04",
};
const PC = "abc1234def0";
const PSHA = "a".repeat(64);
const BRIEF = {
  title: "Add Thing!",
  description: "add a thing",
  sources: [{ kind: "ledger", ref: "42", url: null, body: "task body" }],
  repo: "/r",
  plan_path: null,
};
const FP_PLAN = { head: "P1", status_sha256: "s", diff_sha256: "d" };
const FP_K1 = { head: "K1", status_sha256: "s", diff_sha256: "d" };
const FP_K2 = { head: "K2", status_sha256: "s", diff_sha256: "d" };
const FP_M3 = { head: "M3", status_sha256: "s", diff_sha256: "d" };
// Hasher output is four maps plus a suspicious list. Fixtures are written as
// flat prefixed keys and converted: "git:<k>" -> git, "symlink:<k>" ->
// symlinks, a key with "#" -> sections, anything else -> files.
function H(flat, suspicious) {
  const h = { files: {}, sections: {}, git: {}, symlinks: {}, suspicious: suspicious || [] };
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith("git:")) h.git[k.slice(4)] = v;
    else if (k.startsWith("symlink:")) h.symlinks[k.slice(8)] = v;
    else if (k.includes("#")) h.sections[k] = v;
    else h.files[k] = v;
  }
  return h;
}
const HASHES_FLAT = {
  "tests/test_a.py": "ha",
  "tests/test_b.py": "hb",
  "pyproject.toml#tool.pytest": "hp",
};
const HASHES = H(HASHES_FLAT);
const CONFIG_ONLY = H({ "pyproject.toml#tool.pytest": "hp" });

function criteria(n = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: "AC" + (i + 1),
    text: "behaviour " + (i + 1),
    test_files: ["tests/test_" + String.fromCharCode(97 + i) + ".py"],
  }));
}

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// The ref file content the commit-plan prompt writes (heredoc body + newline).
function refContentOf(prompt) {
  const m = /<<'FLEET_REF_JSON'\n([\s\S]*?)\nFLEET_REF_JSON/.exec(prompt);
  return m ? m[1] + "\n" : null;
}

// commit-plan stub: records the committed ref file per commit sha in store.
function commitStub(store, head, planSha) {
  return (prompt) => {
    const c = refContentOf(prompt);
    if (c == null) return { status: "failed", reason: "no ref content in the prompt" };
    store[head] = c;
    return { status: "ok", reason: "committed", head, plan_sha256: planSha, ref_sha256: sha256(c), ref_content: c };
  };
}

// load-ref stub: `git show <plan_commit>:<ref_path>` from the store.
function loadStub(store) {
  return (prompt) => {
    const i = inputsOf(prompt);
    const c = store[i.plan_commit];
    if (c === undefined) return { status: "failed", reason: "no ref file at " + i.plan_commit };
    return { status: "ok", reason: "read", content: c, sha256: sha256(c) };
  };
}

function happy(over = {}) {
  const crit = over.criteria || criteria(2);
  const store = {};
  const s = {
    __store: store,
    preflight: {
      reachable: true,
      missing: [],
      versions: { ...FROZEN_VERSIONS },
      contract: Object.fromEntries(Object.keys(FROZEN_VERSIONS).map((k) => [k, "CONTRACT: fleet-v2"])),
    },
    intake: { status: "ok", reason: "resolved", brief: over.brief || BRIEF },
    "infra:branch-scan": { status: "ok", reason: "scanned", commits: [] },
    "infra:stage-plan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan": commitStub(store, PC, PSHA),
    "infra:load-ref": loadStub(store),
    "infra:verify-plan": {
      status: "ok",
      reason: "verified",
      head: PC,
      plan_sha256: PSHA,
      plan_sha256_head: PSHA,
      is_ancestor: true,
      commits_since: [],
      plan_touched: [],
    },
    "infra:push": (prompt) => ({ status: "ok", reason: "pushed", remote_head: inputsOf(prompt).approved_sha }),
    "infra:ledger-writeback": (prompt) => ({
      status: "ok",
      reason: "ok",
      results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "written" })),
    }),
    workspace: {
      status: "ok",
      reason: "created",
      default_branch: "master",
      base_ref: "B0",
      remote_slug: "o/r",
    },
    "role:scope-and-plan": {
      status: "ok",
      reason: "planned",
      artefacts: ["docs/plans/x.md"],
      plan_path: "docs/plans/x.md",
      criteria: crit,
      est_diff_lines: 80,
      new_behaviour: true,
      tldr: "adds a thing",
      plan_diff: ["new plan"],
      fleet_estimate: { criteria: crit.length, agents: 20, rounds: 1 },
      yadgar_findings: ["planner fact"],
    },
    "role:plan-audit": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:prepare": { status: "ok", reason: "ok", head: PC },
    "hasher:fp-pre:test-judge:r1": { status: "ok", fingerprint: FP_PLAN },
    "role:fleet-test-judge:r1": {
      status: "ok",
      reason: "good",
      verdict: "approve",
      routed_findings: [],
      checked: [],
      yadgar_findings: ["judge fact"],
    },
    "hasher:fp-post:test-judge:r1": { status: "ok", fingerprint: FP_PLAN },
    "infra:integrate:r1": { status: "ok", reason: "merged", head: "P1" },
    "hasher:freeze:f1": { status: "ok", fingerprint: FP_PLAN, hashes: HASHES },
    "role:fleet-coder:r1": {
      status: "ok",
      reason: "done",
      commits: ["k1"],
      frozen_tests_red_at_start: true,
      suite_result: { command: "pytest", exit_code: 0 },
    },
    "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES },
    "role:fleet-code-judge:r1": {
      status: "ok",
      reason: "good",
      verdict: "approve",
      routed_findings: [],
      hash_check: { match: true, mismatched: [] },
      suite_result: { command: "pytest", exit_code: 0 },
    },
    "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: FP_K1 },
    "role:fleet-pr-opener": {
      status: "ok",
      reason: "opened",
      pr_url: "https://github.com/o/r/pull/7",
      pr_number: 7,
      created: true,
      template_used: ".github/pull_request_template.md",
      gates_not_run_stated: true,
      yadgar_findings: ["pr fact"],
    },
  };
  for (const c of crit) {
    s["role:fleet-test-writer:" + c.id + ":r1"] = {
      status: "ok",
      reason: "red",
      criterion_id: c.id,
      tests: [],
      commit: "t-" + c.id,
    };
  }
  return Object.assign(s, over.script || {});
}

// ---------------------------------------------------------------- args

test("no args returns needs_human and dispatches nothing", async () => {
  const out = await run({}, undefined);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /\/build-task/);
  assert.equal(out.calls.length, 0);
});

test("string args are parsed as JSON", async () => {
  const out = await runOne(happy(), JSON.stringify(ARGS));
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation");
});

test("missing repo or date is rejected before any agent", async () => {
  for (const args of [
    { mode: "plan", input: "L42", date: "2026-11-04" },
    { mode: "plan", input: "L42", repo: "/r" },
    { mode: "plan", input: "  ", repo: "/r", date: "2026-11-04" },
  ]) {
    const out = await runOne({}, args);
    assert.equal(out.result.status, "needs_human", JSON.stringify(args));
    assert.equal(out.calls.length, 0);
  }
});

test("branch name derives deterministically from a ledger id and title", async () => {
  const out = await run(happy(), ARGS);
  const ws = inputsOf(call(out, "workspace").prompt);
  assert.equal(ws.branch, "fleet/l42-add-thing");
  assert.equal(ws.main_worktree, "/r/.claude/worktrees/fleet-l42-add-thing/main");
  assert.equal(out.result.branch, "fleet/l42-add-thing");
});

test("an ingested plan: task id plan, slug from the brief title, plan_path forwarded in the brief", async () => {
  const brief = {
    title: "Foo Bar",
    description: "d",
    sources: [{ kind: "plan", ref: "docs/plans/Foo_Bar-2026-11-04.md", url: null, body: "# plan" }],
    repo: "/r",
    plan_path: "./docs/plans/Foo_Bar-2026-11-04.md",
  };
  const s = happy({ brief });
  s["role:scope-and-plan"].plan_path = "docs/plans/Foo_Bar-2026-11-04.md";
  s["role:scope-and-plan"].plan_diff = ["AC2 added"];
  const out = await runOne(s, { ...ARGS, input: "docs/plans/Foo_Bar-2026-11-04.md" });
  noUnscripted(out);
  const ws = inputsOf(call(out, "workspace").prompt);
  assert.equal(ws.branch, "fleet/plan-foo-bar");
  const plan = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.equal(plan.brief.plan_path, "docs/plans/Foo_Bar-2026-11-04.md");
  assert.equal(plan.date, "2026-11-04");
  assert.ok(!("task" in plan) && !("title" in plan), "v1 task/title inputs are gone");
  assert.deepEqual(out.result.plan_diff, ["AC2 added"]);
});

// ---------------------------------------------------------------- preflight

test("preflight missing role stops with needs_human naming the role", async () => {
  const s = happy({
    script: {
      preflight: { reachable: true, missing: ["fleet-coder"], versions: { ...FROZEN_VERSIONS } },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-coder/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("preflight unreachable yadgar stops with needs_human", async () => {
  const s = happy({ script: { preflight: { reachable: false, missing: [], versions: {} } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /yadgar unavailable/);
});

// ---------------------------------------------------------------- happy paths

test("full path: plan, audit, tests, freeze, code, judge, PR", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  const r = out.result;
  assert.equal(r.status, "ok");
  assert.equal(r.path, "full");
  assert.equal(r.pr_url, "https://github.com/o/r/pull/7");
  assert.deepEqual(r.rounds, { tests: 1, code: 1 });
  // approved_sha comes from the post-judge fingerprint
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.equal(pr.approved_sha, "K1");
  assert.equal(pr.repo, "o/r");
  // coder gets the frozen map and the freeze ref
  const coder = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  // roles get plain files in frozen_tests and synthetic section keys apart
  assert.deepEqual(coder.frozen_tests, { "tests/test_a.py": "ha", "tests/test_b.py": "hb" });
  // role view: flat keys path#section, git:<k>, symlink:<rel>
  assert.deepEqual(coder.frozen_config_sections, { "pyproject.toml#tool.pytest": "hp" });
  const cjIn = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cjIn.frozen_tests, coder.frozen_tests);
  assert.equal(cjIn.code_base_ref, "P1");
  assert.equal(coder.freeze_ref, "P1");
  // every role's yadgar findings are forwarded
  // plan-run findings come back with the plan result, build-run findings with the build result
  assert.ok(out.planResult.yadgar_findings.some((y) => y.role === "scope-and-plan"));
  const roles = r.yadgar_findings.map((y) => y.role);
  assert.ok(roles.includes("fleet-test-judge"));
  assert.ok(roles.includes("fleet-pr-opener"));
  assert.ok(Array.isArray(r.gate_log) && r.gate_log.length > 0);
});

test("role prompts embed no role text: they load the role from yadgar", async () => {
  const out = await run(happy(), ARGS);
  for (const c of out.calls.filter((x) => x.label.startsWith("role:"))) {
    const role = c.label.split(":")[1];
    assert.ok(
      c.prompt.startsWith(
        'Call mcp__yadgar__agent_prompt_get(pattern="' + role + '", project="m-agahi/yadgar")',
      ),
      c.label,
    );
    assert.ok(c.prompt.length < 4000, c.label + " prompt too long: " + c.prompt.length);
    assert.ok(c.opts.schema, c.label + " has a schema");
  }
});

test("judges run as the read-only fleet:judge agent", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(call(out, "role:fleet-test-judge:r1").opts.agentType, "fleet:judge");
  assert.equal(call(out, "role:fleet-code-judge:r1").opts.agentType, "fleet:judge");
  assert.equal(call(out, "hasher:freeze:f1").opts.agentType, "fleet:judge");
  assert.notEqual(call(out, "role:fleet-coder:r1").opts.agentType, "fleet:judge");
  for (const c of out.calls) assert.notEqual(c.opts.isolation, "worktree", c.label);
});

test("short path is disabled: a small no-new-behaviour plan still takes the full path", async () => {
  const s = happy();
  s["role:scope-and-plan"].est_diff_lines = 10;
  s["role:scope-and-plan"].new_behaviour = false;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.equal(out.result.path, "full");
  assert.ok(out.labels.includes("role:plan-audit"));
  assert.ok(out.labels.includes("role:fleet-test-writer:AC1:r1"));
  assert.ok(out.logs.some((l) => /short path disabled/.test(l)));
  assert.ok(out.logs.some((l) => /est_diff_lines < 20 AND new_behaviour false/.test(l)));
});

test("risk tier: missing estimate takes the full path", async () => {
  const s = happy();
  delete s["role:scope-and-plan"].est_diff_lines;
  s["role:scope-and-plan"].new_behaviour = false;
  const out = await run(s, ARGS);
  assert.equal(out.result.path, "full");
});

// ---------------------------------------------------------------- plan gates

test("plan-audit untestable_criteria stops before any test writer", async () => {
  const s = happy({
    script: {
      "role:plan-audit": {
        status: "ok",
        verdict: "untestable_criteria",
        routed_findings: [{ target: "plan", criterion: "AC1", finding: "vague" }],
      },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /untestable_criteria/);
  assert.ok(!out.labels.includes("infra:prepare"));
});

test("plan-audit plan_defect stops", async () => {
  const s = happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan_defect/);
});

test("overlapping test files across criteria stop with needs_human", async () => {
  const crit = [
    { id: "AC1", text: "a", test_files: ["tests/test_a.py"] },
    { id: "AC2", text: "b", test_files: ["./tests/test_a.py", "tests/test_b.py"] },
  ];
  const out = await run(happy({ criteria: crit }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /overlap/i);
  assert.match(out.result.reason, /tests\/test_a\.py/);
  assert.ok(!out.labels.includes("role:plan-audit"));
});

test("manual criteria get no writer; full path with none testable stops", async () => {
  const crit = [{ id: "AC1", text: "a", test_files: [] }];
  const out = await run(happy({ criteria: crit }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /no testable criteria/);
});

test("a manual criterion is skipped while others get writers", async () => {
  const crit = [...criteria(1), { id: "AC9", text: "manual", test_files: [] }];
  const out = await run(happy({ criteria: crit }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC9:r1"));
});

test("planner needs_human status stops the run and forwards the reason", async () => {
  const s = happy({
    script: { "role:scope-and-plan": { status: "needs_human", reason: "which db?" } },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /which db\?/);
});

// ---------------------------------------------------------------- test rounds

test("test-judge revise routes only the listed criteria back to their writers", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": {
        status: "ok",
        verdict: "revise",
        routed_findings: [{ target: "tests", criterion: "AC2", finding: "weak assert" }],
      },
      "role:fleet-test-writer:AC2:r2": { status: "ok", criterion_id: "AC2", commit: "t2" },
      "infra:integrate:r2": { status: "ok", head: "P2" },
      "hasher:fp-pre:test-judge:r2": { status: "ok", fingerprint: FP_PLAN },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_PLAN },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r2"));
  const w = inputsOf(call(out, "role:fleet-test-writer:AC2:r2").prompt);
  assert.deepEqual(w.routed_findings, [
    { target: "tests", criterion: "AC2", finding: "weak assert" },
  ]);
  assert.deepEqual(w.criterion, { id: "AC2", text: "behaviour 2" });
  assert.deepEqual(w.test_files, ["tests/test_b.py"]);
  assert.equal(out.result.rounds.tests, 2);
});

test("three revise rounds end in needs_human without freezing", async () => {
  const revise = {
    status: "ok",
    verdict: "revise",
    routed_findings: [{ target: "tests", criterion: "AC1", finding: "x" }],
  };
  const extra = {};
  for (const n of [1, 2, 3]) {
    extra["role:fleet-test-judge:r" + n] = revise;
    extra["hasher:fp-pre:test-judge:r" + n] = { status: "ok", fingerprint: FP_PLAN };
    extra["hasher:fp-post:test-judge:r" + n] = { status: "ok", fingerprint: FP_PLAN };
    extra["infra:integrate:r" + n] = { status: "ok", head: "P" + n };
    extra["role:fleet-test-writer:AC1:r" + n] = { status: "ok", criterion_id: "AC1" };
  }
  const out = await run(happy({ script: extra }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /test rounds/);
  assert.equal(out.result.rounds.tests, 3);
  assert.ok(!out.labels.includes("hasher:freeze:f1"));
});

test("a plan finding from the test-judge stops the run", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": {
        status: "ok",
        verdict: "revise",
        routed_findings: [{ target: "plan", criterion: "AC1", finding: "contradicts code" }],
      },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan/);
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r2"));
});

test("test-judge that mutates the worktree is discarded: needs_human", async () => {
  const s = happy({
    script: {
      "hasher:fp-post:test-judge:r1": {
        status: "ok",
        fingerprint: { head: "P1", status_sha256: "CHANGED", diff_sha256: "d" },
      },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree/);
  assert.ok(!out.labels.includes("hasher:freeze:f1"));
});

// ---------------------------------------------------------------- code rounds

function hashViolation(hashes) {
  return happy({
    script: {
      "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes },
      "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  });
}

test("changed frozen test hash rejects the coder round regardless of judge", async () => {
  const out = await run(hashViolation(H({ ...HASHES_FLAT, "tests/test_a.py": "TAMPERED" })), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), "judge not run on a violated round");
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.equal(c2.routed_findings.length, 1);
  assert.equal(c2.routed_findings[0].target, "code");
  assert.match(c2.routed_findings[0].finding, /tests\/test_a\.py/);
  assert.equal(out.result.rounds.code, 2);
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, "K2");
});

test("a new runner-config key (added conftest) is a hash violation", async () => {
  const out = await run(hashViolation(H({ ...HASHES_FLAT, "tests/conftest.py": "new" })), ARGS);
  noUnscripted(out);
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.match(c2.routed_findings[0].finding, /tests\/conftest\.py/);
});

test("a changed pytest section (addopts tamper) is a hash violation", async () => {
  const out = await run(
    hashViolation(H({ ...HASHES_FLAT, "pyproject.toml#tool.pytest": "addopts-changed" })),
    ARGS,
  );
  noUnscripted(out);
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.match(c2.routed_findings[0].finding, /pyproject\.toml#tool\.pytest/);
});

test("a removed frozen file is a hash violation", async () => {
  const h = { ...HASHES_FLAT };
  delete h["tests/test_b.py"];
  const out = await run(hashViolation(H(h)), ARGS);
  noUnscripted(out);
  assert.match(
    inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding,
    /tests\/test_b\.py/,
  );
});

test("fix_code routes code findings back to the coder only", async () => {
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": {
        status: "ok",
        verdict: "fix_code",
        routed_findings: [
          { target: "code", criterion: "AC1", finding: "off by one" },
          { target: "tests", criterion: "AC2", finding: "ignored here" },
        ],
      },
      "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.deepEqual(c2.routed_findings, [
    { target: "code", criterion: "AC1", finding: "off by one" },
  ]);
});

test("fix_tests routes to the test-judge, never the coder, then re-freezes", async () => {
  const testFinding = { target: "tests", criterion: "AC1", finding: "asserts unrequired thing" };
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": {
        status: "ok",
        verdict: "fix_tests",
        routed_findings: [testFinding],
      },
      // re-entry: judge first, with the code-judge findings
      "hasher:fp-pre:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-judge:r2": {
        status: "ok",
        verdict: "revise",
        routed_findings: [testFinding],
      },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "infra:sync:r3": { status: "ok", reason: "merged", head: "M2" },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1", commit: "t1b" },
      "infra:integrate:r3": { status: "ok", head: "M3" },
      "hasher:fp-pre:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "hasher:freeze:f2": {
        status: "ok",
        fingerprint: FP_M3,
        hashes: H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" }),
      },
      "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
      "hasher:post-coder:r2": {
        status: "ok",
        fingerprint: FP_K2,
        hashes: H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" }),
      },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const tj = inputsOf(call(out, "role:fleet-test-judge:r2").prompt);
  assert.deepEqual(tj.code_judge_findings, [testFinding]);
  const iJudge = out.labels.indexOf("role:fleet-test-judge:r2");
  const iCoder2 = out.labels.indexOf("role:fleet-coder:r2");
  assert.ok(iJudge > 0 && iCoder2 > iJudge, "test-judge runs before the next coder round");
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.equal(c2.freeze_ref, "M3");
  assert.equal(c2.frozen_tests["tests/test_a.py"], "ha2");
  assert.ok(!c2.routed_findings.some((f) => f.target === "tests"));
});

test("plan_wrong without a plan finding stops before the PR", async () => {
  const s = happy({
    script: { "role:fleet-code-judge:r1": { status: "ok", verdict: "plan_wrong" } },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan_wrong/);
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

test("three fix_code rounds end in needs_human", async () => {
  const fix = {
    status: "ok",
    verdict: "fix_code",
    routed_findings: [{ target: "code", criterion: "AC1", finding: "x" }],
  };
  const extra = {};
  for (const n of [1, 2, 3]) {
    extra["role:fleet-coder:r" + n] = { status: "ok", commits: ["k" + n] };
    extra["hasher:post-coder:r" + n] = { status: "ok", fingerprint: FP_K1, hashes: HASHES };
    extra["role:fleet-code-judge:r" + n] = fix;
    extra["hasher:fp-post:code-judge:r" + n] = { status: "ok", fingerprint: FP_K1 };
  }
  const out = await run(happy({ script: extra }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /code rounds/);
  assert.equal(out.result.rounds.code, 3);
  assert.ok(!out.labels.includes("role:fleet-coder:r4"));
});

test("code-judge that mutates the worktree is discarded: needs_human", async () => {
  const s = happy({
    script: {
      "hasher:fp-post:code-judge:r1": {
        status: "ok",
        fingerprint: { head: "K1", status_sha256: "s", diff_sha256: "SUITE-LEFT-CHANGES" },
      },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree/);
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

test("coder needs_human stops the run", async () => {
  const s = happy({
    script: { "role:fleet-coder:r1": { status: "needs_human", reason: "test AC1 wrong" } },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /test AC1 wrong/);
});

test("a dead agent (null result) fails the run instead of passing a gate", async () => {
  const s = happy({ script: { "role:fleet-code-judge:r1": null } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

// ---------------------------------------------------------------- agent cap

test("agent cap stops the run with needs_human before exceeding 60 agents", async () => {
  const crit = criteria(6);
  const reviseAll = {
    status: "ok",
    verdict: "revise",
    routed_findings: crit.map((c) => ({ target: "tests", criterion: c.id, finding: "x" })),
  };
  const extra = {
    "role:fleet-test-judge:r1": reviseAll,
    "role:fleet-test-judge:r2": reviseAll,
    "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
    "role:fleet-code-judge:r1": {
      status: "ok",
      verdict: "fix_tests",
      routed_findings: [{ target: "tests", criterion: "AC1", finding: "y" }],
    },
    "role:fleet-test-judge:r4": reviseAll,
    "role:fleet-test-judge:r5": reviseAll,
    "role:fleet-test-judge:r6": reviseAll,
    "infra:sync:r5": { status: "ok", reason: "merged", head: "S5" },
    "infra:sync:r6": { status: "ok", reason: "merged", head: "S6" },
  };
  for (let n = 1; n <= 6; n++) {
    extra["hasher:fp-pre:test-judge:r" + n] = { status: "ok", fingerprint: FP_PLAN };
    extra["hasher:fp-post:test-judge:r" + n] = { status: "ok", fingerprint: FP_PLAN };
    extra["infra:integrate:r" + n] = { status: "ok", head: "P1" };
    for (const c of crit)
      extra["role:fleet-test-writer:" + c.id + ":r" + n] = { status: "ok", criterion_id: c.id };
  }
  const flatHashes = {};
  for (const c of crit) flatHashes[c.test_files[0]] = "h";
  const hashes = H(flatHashes);
  extra["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes };
  extra["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes };
  const out = await run(happy({ criteria: crit, script: extra }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /agent cap/);
  // the cap is per run: the build run alone stays within it
  assert.ok(out.build.calls.length <= 60, "dispatched " + out.build.calls.length);
  assert.ok(out.logs.some((l) => /agent cap/.test(l)));
});

// ---------------------------------------------------------------- hasher

test("hasher prompt carries the extraction rules and the config list", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out, "hasher:freeze:f1").prompt;
  for (const needle of [
    "conftest.py",
    "pytest.ini",
    "tox.ini",
    "setup.cfg",
    "jest.config.",
    "vitest.config.",
    ".mocharc",
    ".pytest.ini",
    "pytest.toml",
    "vitest.workspace",
    "karma.conf.",
    ".babelrc",
    "babel.config.",
    "sitecustomize.py",
    "usercustomize.py",
    "*.pth",
    "noxfile.py",
    ".gitignore",
    "info/exclude",
    "tool.pytest",
    "scripts.test",
    '"jest"',
    '"vitest"',
    '"mocha"',
    "sort_keys=True",
    "status', '--porcelain",
  ]) {
    assert.ok(p.includes(needle), "hasher prompt mentions " + needle);
  }
  const h = inputsOf(p);
  assert.deepEqual(h.test_files.sort(), [".fleet/l42/plan_ref.json", "tests/test_a.py", "tests/test_b.py"]);
  assert.equal(h.mode, "hashes");
});

// The hasher's Python program is embedded in the workflow between markers.
// Run it for real against a scratch git repo.
function hasherPy() {
  const m = /HASHER_PY_BEGIN\n([\s\S]*?)\n\/\/ HASHER_PY_END/.exec(SOURCE);
  assert.ok(m, "HASHER_PY markers present");
  // the block is a String.raw template literal: strip the JS wrapper lines
  const body = m[1].replace(/^const HASHER_PY = String\.raw`\n?/, "").replace(/`;?\s*$/, "");
  return body;
}

function sh(cwd, ...cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(cmd.join(" ") + ": " + r.stderr);
  return r.stdout;
}

function runHasherRaw(wt, mode, files) {
  const r = spawnSync("python3", ["-I", "-", wt, mode, JSON.stringify(files)], {
    input: hasherPy(),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("hasher failed: " + r.stderr);
  return JSON.parse(r.stdout);
}

// Flatten the four maps to prefixed keys for the older assertions.
function runHasher(wt, mode, files) {
  const out = runHasherRaw(wt, mode, files);
  if (!out.hashes) return out;
  const h = out.hashes;
  const flat = Object.assign({}, h.files, h.sections);
  for (const [k, v] of Object.entries(h.git)) flat["git:" + k] = v;
  for (const [k, v] of Object.entries(h.symlinks)) flat["symlink:" + k] = v;
  return { fingerprint: out.fingerprint, hashes: flat, suspicious: h.suspicious };
}

const py = spawnSync("python3", ["-c", "import tomllib"]);
const HAVE_PY = py.status === 0;

test("hasher program: sections, config files, fingerprint", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-hasher-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(
      join(wt, "pyproject.toml"),
      '[project]\nname = "x"\ndependencies = ["a"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\nmarkers = ["slow"]\n',
    );
    writeFileSync(
      join(wt, "package.json"),
      JSON.stringify({ dependencies: { a: "1" }, scripts: { test: "jest", lint: "x" }, jest: { b: 1, a: 2 } }),
    );
    writeFileSync(join(wt, "conftest.py"), "x = 1\n");
    writeFileSync(join(wt, "test_a.py"), "def test(): pass\n");
    writeFileSync(join(wt, ".gitignore"), "ignored.log\n");
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-q", "-m", "init");

    const base = runHasher(wt, "hashes", ["test_a.py", "missing_test.py"]);
    const h = base.hashes;
    assert.match(h["pyproject.toml#tool.pytest"], /^[0-9a-f]{64}$/);
    assert.match(h["package.json#jest"], /^[0-9a-f]{64}$/);
    assert.match(h["package.json#scripts.test"], /^[0-9a-f]{64}$/);
    assert.equal(h["package.json#vitest"], "ABSENT");
    assert.equal(h["package.json#mocha"], "ABSENT");
    assert.match(h["conftest.py"], /^[0-9a-f]{64}$/);
    assert.match(h["test_a.py"], /^[0-9a-f]{64}$/);
    assert.equal(h["missing_test.py"], "MISSING");
    assert.ok(!("pyproject.toml" in h), "whole pyproject is not hashed");
    assert.ok(!("package.json" in h), "whole package.json is not hashed");
    assert.match(base.fingerprint.head, /^[0-9a-f]{40}$/);

    // dependency edits and key reordering stay invisible
    writeFileSync(
      join(wt, "pyproject.toml"),
      '[project]\nname = "x"\ndependencies = ["a", "b"]\n\n[tool.pytest.ini_options]\nmarkers = ["slow"]\naddopts = "-q"\n',
    );
    writeFileSync(
      join(wt, "package.json"),
      JSON.stringify({ jest: { a: 2, b: 1 }, scripts: { lint: "y", test: "jest" }, dependencies: { a: "2" } }),
    );
    const deps = runHasher(wt, "hashes", ["test_a.py"]).hashes;
    assert.equal(deps["pyproject.toml#tool.pytest"], h["pyproject.toml#tool.pytest"]);
    assert.equal(deps["package.json#jest"], h["package.json#jest"]);
    assert.equal(deps["package.json#scripts.test"], h["package.json#scripts.test"]);

    // addopts / deselect tamper is caught; scripts.test tamper is caught
    writeFileSync(
      join(wt, "pyproject.toml"),
      '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q --deselect test_a.py::test"\nmarkers = ["slow"]\n',
    );
    writeFileSync(
      join(wt, "package.json"),
      JSON.stringify({ scripts: { test: "jest --passWithNoTests" }, jest: { a: 2, b: 1 } }),
    );
    const tam = runHasher(wt, "hashes", ["test_a.py"]).hashes;
    assert.notEqual(tam["pyproject.toml#tool.pytest"], h["pyproject.toml#tool.pytest"]);
    assert.notEqual(tam["package.json#scripts.test"], h["package.json#scripts.test"]);

    // a new conftest anywhere appears as a new key
    sh(wt, "mkdir", "-p", "sub");
    writeFileSync(join(wt, "sub", "conftest.py"), "y = 2\n");
    assert.ok("sub/conftest.py" in runHasher(wt, "hashes", []).hashes);

    // fingerprint: ignored files do not change it; untracked and tracked edits do
    sh(wt, "git", "checkout", "-q", "--", ".");
    sh(wt, "rm", "-rf", "sub");
    const fp0 = runHasher(wt, "fingerprint", []).fingerprint;
    assert.ok(!("hashes" in runHasher(wt, "fingerprint", [])));
    writeFileSync(join(wt, "ignored.log"), "noise\n");
    assert.deepEqual(runHasher(wt, "fingerprint", []).fingerprint, fp0);
    writeFileSync(join(wt, "stray.txt"), "x\n");
    assert.notDeepEqual(runHasher(wt, "fingerprint", []).fingerprint, fp0);
    sh(wt, "rm", "stray.txt");
    writeFileSync(join(wt, "test_a.py"), "def test(): assert 1\n");
    const fpEdit = runHasher(wt, "fingerprint", []).fingerprint;
    assert.notEqual(fpEdit.diff_sha256, fp0.diff_sha256);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- v1 role-prompt round 2

const SECRET = "HELD-OUT-SECRET-42";

function richCriteria() {
  return [
    {
      id: "AC1",
      text: "behaviour 1",
      test_files: ["tests/test_a.py"],
      examples: [{ given: "g", when: "f(1)", then: "2", kind: "main" }],
      dont_care: ["log text"],
      property: "idempotent",
      guards_existing: false,
      spec_quote: null,
      held_out_examples: [{ criterion_id: "AC1", given: "g", when: "f(9)", then: SECRET }],
    },
    {
      id: "AC2",
      text: "behaviour 2",
      test_files: ["tests/test_b.py"],
      examples: [{ given: "g2", when: "h()", then: "x", kind: "refusal" }],
      dont_care: [],
      property: null,
      guards_existing: true,
      spec_quote: "README: h() refuses",
    },
  ];
}

function richPlan() {
  const s = happy({ criteria: richCriteria() });
  Object.assign(s["role:scope-and-plan"], {
    allowed_additions: { files: ["src/f.py"], symbols: ["f"], deps: [], settings: [] },
    held_out_examples: [{ criterion_id: "AC2", given: "g", when: "h(0)", then: SECRET }],
  });
  return s;
}

test("held_out_examples never leave the planner: no later prompt or result carries them", async () => {
  const out = await run(richPlan(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const after = out.calls.slice(out.labels.indexOf("role:scope-and-plan") + 1);
  assert.ok(after.length > 5);
  for (const c of after) {
    assert.ok(!c.prompt.includes("held_out_examples"), c.label + " prompt names held_out_examples");
    assert.ok(!c.prompt.includes(SECRET), c.label + " prompt leaks a held-out value");
  }
  assert.ok(!JSON.stringify(out.result).includes(SECRET), "result leaks a held-out value");
});

test("held-out values are stripped from forwarded role outputs too", async () => {
  const s = richPlan();
  s["role:fleet-test-writer:AC1:r1"].held_out_examples = [{ then: SECRET }];
  s["role:fleet-coder:r1"].notes = { held_out_examples: [SECRET] };
  const out = await run(s, ARGS);
  for (const c of out.calls.slice(out.labels.indexOf("role:scope-and-plan") + 1))
    assert.ok(!c.prompt.includes(SECRET), c.label + " leaks a held-out value");
});

test("writers get the full criterion; judges get full criteria, scope fence and estimate", async () => {
  const out = await run(richPlan(), ARGS);
  const w = inputsOf(call(out, "role:fleet-test-writer:AC2:r1").prompt);
  assert.deepEqual(w.criterion, {
    id: "AC2",
    text: "behaviour 2",
    examples: [{ given: "g2", when: "h()", then: "x", kind: "refusal" }],
    dont_care: [],
    property: null,
    guards_existing: true,
    spec_quote: "README: h() refuses",
  });
  const fence = { files: ["src/f.py"], symbols: ["f"], deps: [], settings: [] };
  const tj = inputsOf(call(out, "role:fleet-test-judge:r1").prompt);
  assert.deepEqual(tj.allowed_additions, fence);
  assert.equal(tj.est_diff_lines, 80);
  assert.equal(tj.base_ref, PC);
  assert.deepEqual(tj.criteria[0].examples, richCriteria()[0].examples);
  assert.equal(tj.criteria[0].property, "idempotent");
  assert.equal(tj.criteria[1].spec_quote, "README: h() refuses");
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cj.allowed_additions, fence);
  assert.equal(cj.est_diff_lines, 80);
  const coder = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  assert.deepEqual(coder.allowed_additions, fence);
  assert.equal(coder.est_diff_lines, 80);
  const audit = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(audit.allowed_additions, fence);
});

test("test-judge writer_outputs carry this round's writer results only", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": {
        status: "ok",
        verdict: "revise",
        routed_findings: [{ target: "tests", criterion: "AC2", finding: "weak" }],
      },
      "role:fleet-test-writer:AC2:r2": { status: "ok", criterion_id: "AC2", commit: "t2b" },
      "infra:integrate:r2": { status: "ok", head: "P2" },
      "hasher:fp-pre:test-judge:r2": { status: "ok", fingerprint: FP_PLAN },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_PLAN },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  const r1 = inputsOf(call(out, "role:fleet-test-judge:r1").prompt).writer_outputs;
  assert.deepEqual(r1.map((w) => w.criterion_id).sort(), ["AC1", "AC2"]);
  const r2 = inputsOf(call(out, "role:fleet-test-judge:r2").prompt).writer_outputs;
  assert.deepEqual(r2.map((w) => w.criterion_id), ["AC2"]);
  assert.equal(r2[0].commit, "t2b");
});

const NOT_RUN = /^fleet v2: /;

test("judges get fail-closed not_run gates, never an empty list", async () => {
  const out = await run(happy(), ARGS);
  for (const label of ["role:fleet-test-judge:r1", "role:fleet-code-judge:r1"]) {
    const i = inputsOf(call(out, label).prompt);
    assert.equal(i.script_findings.status, "not_run", label);
    assert.match(i.script_findings.reason, NOT_RUN);
  }
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.equal(cj.held_out_results.status, "not_run");
  assert.match(cj.held_out_results.reason, NOT_RUN);
});

test("approve without a gates_not_run list: script builds it for the PR and the result", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  const gates = pr.gates_not_run.map((g) => g.gate).sort();
  assert.deepEqual(gates, ["coverage", "held_out", "mutation", "security_scan"]);
  for (const g of pr.gates_not_run) assert.match(g.reason, NOT_RUN);
  assert.deepEqual(out.result.gates_not_run, pr.gates_not_run);
});

test("approve with a gates_not_run list: the code-judge list is forwarded", async () => {
  const list = [
    { gate: "coverage", reason: "v1: not run" },
    { gate: "held_out", reason: "v1: not run" },
  ];
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": {
        status: "ok",
        reason: "approved with gates not run: coverage, held_out",
        verdict: "approve",
        routed_findings: [],
        gates_not_run: list,
      },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener").prompt).gates_not_run, list);
  assert.deepEqual(out.result.gates_not_run, list);
});


// ---------------------------------------------------------------- review fixes

test("fix_tests carries its code findings to the next coder round; code_base_ref stays at the first freeze", async () => {
  const testFinding = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const codeFinding = { target: "code", criterion: "AC2", finding: "dead branch" };
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": {
        status: "ok",
        verdict: "fix_tests",
        routed_findings: [testFinding, codeFinding],
      },
      "hasher:fp-pre:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-judge:r2": {
        status: "ok",
        verdict: "revise",
        routed_findings: [testFinding],
      },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "infra:sync:r3": { status: "ok", reason: "merged", head: "M2" },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1", commit: "t1b" },
      "infra:integrate:r3": { status: "ok", head: "M3" },
      "hasher:fp-pre:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: HASHES },
      "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.deepEqual(c2.routed_findings, [codeFinding]);
  assert.equal(c2.freeze_ref, "M3");
  assert.equal(c2.code_base_ref, "P1");
  const cj2 = inputsOf(call(out, "role:fleet-code-judge:r2").prompt);
  assert.equal(cj2.code_base_ref, "P1");
  assert.equal(cj2.freeze_ref, "M3");
});

test("an ignored new conftest plus an ignore-rule edit rejects the coder round", async () => {
  const out = await run(
    hashViolation(H({ ...HASHES_FLAT, ".gitignore": "edited", "sub/conftest.py": "new", "git:info/exclude": "edited" })),
    ARGS,
  );
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding;
  assert.match(f, /\.gitignore/);
  assert.match(f, /sub\/conftest\.py/);
  assert.match(f, /git:info\/exclude/);
});

test("hasher program: ignore rules are frozen and ignored config is still found", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-hasher-ign-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, ".gitignore"), "*.log\n");
    writeFileSync(join(wt, "a.py"), "x = 1\n");
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-q", "-m", "init");
    const base = runHasher(wt, "hashes", []).hashes;
    assert.match(base[".gitignore"], /^[0-9a-f]{64}$/);
    assert.ok("git:info/exclude" in base, "info/exclude is a key");
    assert.ok(!("sub/conftest.py" in base));

    // the bypass: a new conftest hidden by an ignore rule
    sh(wt, "mkdir", "-p", "sub");
    writeFileSync(join(wt, "sub", "conftest.py"), "import os\n");
    writeFileSync(join(wt, ".gitignore"), "*.log\nsub/conftest.py\n");
    const tam = runHasher(wt, "hashes", []).hashes;
    assert.ok("sub/conftest.py" in tam, "ignored conftest found by the filesystem walk");
    assert.notEqual(tam[".gitignore"], base[".gitignore"]);

    // info/exclude edit is visible too
    const ex = sh(wt, "git", "rev-parse", "--git-path", "info/exclude").trim();
    writeFileSync(join(wt, ex), "sub/\n");
    assert.notEqual(runHasher(wt, "hashes", [])["hashes"]["git:info/exclude"], base["git:info/exclude"]);

    // new config globs; *.pth only at the root
    for (const f of [
      ".pytest.ini",
      "pytest.toml",
      "vitest.workspace.ts",
      "karma.conf.js",
      ".babelrc.json",
      "babel.config.js",
      "sitecustomize.py",
      "usercustomize.py",
      "noxfile.py",
      "evil.pth",
    ])
      writeFileSync(join(wt, f), "x\n");
    writeFileSync(join(wt, "sub", "deep.pth"), "x\n");
    const g = runHasher(wt, "hashes", []).hashes;
    for (const f of [
      ".pytest.ini",
      "pytest.toml",
      "vitest.workspace.ts",
      "karma.conf.js",
      ".babelrc.json",
      "babel.config.js",
      "sitecustomize.py",
      "usercustomize.py",
      "noxfile.py",
      "evil.pth",
    ])
      assert.match(g[f] || "", /^[0-9a-f]{64}$/, f);
    assert.ok(!("sub/deep.pth" in g), "*.pth is matched at the repo root only");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher program: symlinks are frozen by target, never followed", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-hasher-link-"));
  const outside = mkdtempSync(join(tmpdir(), "fleet-hasher-outside-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, "a.py"), "x = 1\n");
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-q", "-m", "init");
    const base = runHasher(wt, "hashes", []).hashes;
    assert.ok(!Object.keys(base).some((k) => k.startsWith("symlink:")));

    // a new directory symlink that holds a conftest.py
    writeFileSync(join(outside, "conftest.py"), "import os\n");
    sh(wt, "ln", "-s", outside, "plugins_dir");
    const dirLink = runHasher(wt, "hashes", []).hashes;
    assert.equal(dirLink["symlink:plugins_dir"], outside);
    assert.ok(!("plugins_dir/conftest.py" in dirLink), "the walk does not follow links");

    // a file symlink to a conftest outside the tree, and retargeting it
    sh(wt, "ln", "-s", join(outside, "conftest.py"), "conftest.py");
    const fileLink = runHasher(wt, "hashes", []).hashes;
    assert.equal(fileLink["symlink:conftest.py"], join(outside, "conftest.py"));
    sh(wt, "ln", "-sfn", "/dev/null", "conftest.py");
    assert.equal(runHasher(wt, "hashes", []).hashes["symlink:conftest.py"], "/dev/null");

    // a symlink inside a skipped dir is not a key
    sh(wt, "mkdir", "-p", "node_modules");
    sh(wt, "ln", "-s", outside, "node_modules/x");
    assert.ok(!("symlink:node_modules/x" in runHasher(wt, "hashes", []).hashes));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("script rejects a coder round that adds a symlink key", async () => {
  const out = await run(hashViolation(H({ ...HASHES_FLAT, "symlink:plugins_dir": "/tmp/evil" })), ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  assert.match(
    inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding,
    /symlink:plugins_dir/,
  );
});

test("symlink keys go to frozen_config_sections, not frozen_tests", async () => {
  const s = happy({
    script: {
      "hasher:freeze:f1": {
        status: "ok",
        fingerprint: FP_PLAN,
        hashes: H({ ...HASHES_FLAT, "symlink:lib": "../x" }),
      },
      "hasher:post-coder:r1": {
        status: "ok",
        fingerprint: FP_K1,
        hashes: H({ ...HASHES_FLAT, "symlink:lib": "../x" }),
      },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  const c = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  assert.ok(!("symlink:lib" in c.frozen_tests));
  assert.equal(c.frozen_config_sections["symlink:lib"], "../x");
});

// ---------------------------------------------------------------- per-role model from DISPATCH lines

const DISPATCH = {
  "scope-and-plan": "DISPATCH: model=opus (needs code exploration THEN design synthesis)",
  "plan-audit": "DISPATCH: model=fable (fallback=opus) — adversarial audit",
  "fleet-test-writer": "DISPATCH: model=sonnet (fallback=opus) — mechanical",
  "fleet-test-judge": "garbage line",
  "fleet-coder": null,
  "fleet-code-judge": "DISPATCH: model=gpt5 (fallback=opus)",
  "fleet-pr-opener": "DISPATCH: model=haiku",
};

function withDispatch(s, dispatch) {
  s.preflight = Object.assign({}, s.preflight, { dispatch });
  return s;
}

test("each role runs on the tier its DISPATCH line names; bad lines fall back to sonnet", async () => {
  const out = await run(withDispatch(happy(), DISPATCH), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const model = (l) => call(out, l).opts.model;
  assert.equal(model("role:scope-and-plan"), "opus");
  assert.equal(model("role:plan-audit"), "fable");
  assert.equal(model("role:fleet-test-writer:AC1:r1"), "sonnet");
  assert.equal(model("role:fleet-test-judge:r1"), "sonnet"); // garbage
  assert.equal(model("role:fleet-coder:r1"), "sonnet"); // missing
  assert.equal(model("role:fleet-code-judge:r1"), "sonnet"); // unknown tier
  assert.equal(model("role:fleet-pr-opener"), "haiku");
  for (const role of ["fleet-test-judge", "fleet-coder", "fleet-code-judge"])
    assert.ok(
      out.logs.some((l) => l.includes(role) && /sonnet/.test(l)),
      "logged the sonnet default for " + role,
    );
});

test("infra agents run on sonnet explicitly", async () => {
  const out = await run(withDispatch(happy(), DISPATCH), ARGS);
  for (const c of out.calls)
    if (!c.label.startsWith("role:")) assert.equal(c.opts.model, "sonnet", c.label);
});

test("preflight asks for each role's DISPATCH line", async () => {
  const out = await run(happy(), ARGS);
  const c = call(out, "preflight");
  assert.ok(c.opts.schema.properties.dispatch, "preflight schema has dispatch");
  assert.match(c.prompt, /DISPATCH: model=/);
});

test("a role agent that dies is retried once on its fallback tier", async () => {
  const s = withDispatch(
    happy({
      script: {
        "role:fleet-test-writer:AC1:r1": null,
        "role:fleet-test-writer:AC1:r1:fallback": { status: "ok", criterion_id: "AC1", commit: "t" },
        "role:plan-audit": null,
        "role:plan-audit:fallback": { status: "ok", verdict: "approve", routed_findings: [] },
      },
    }),
    DISPATCH,
  );
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.equal(call(out, "role:plan-audit:fallback").opts.model, "opus");
  assert.equal(call(out, "role:fleet-test-writer:AC1:r1:fallback").opts.model, "opus");
  assert.ok(out.logs.some((l) => /fallback/.test(l) && /plan-audit/.test(l)));
  // caps reset per run: each run counts its own dispatches
  assert.equal(out.planResult.agents, out.plan.calls.length, "retries count toward the agent cap");
  assert.equal(out.result.agents, out.build.calls.length, "retries count toward the agent cap");
});

test("a dead role with no fallback tier fails without a retry", async () => {
  const s = withDispatch(happy({ script: { "role:scope-and-plan": null } }), DISPATCH);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.ok(!out.labels.includes("role:scope-and-plan:fallback"));
});


// ---------------------------------------------------------------- synthetic key collisions

function scratchRepo(prefix) {
  const wt = mkdtempSync(join(tmpdir(), prefix));
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  return wt;
}

test("hasher program: a file named like a synthetic key cannot mask one", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-hasher-collide-");
  try {
    writeFileSync(
      join(wt, "pyproject.toml"),
      '[tool.pytest.ini_options]\naddopts = "-q"\n',
    );
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-q", "-m", "init");
    const base = runHasherRaw(wt, "hashes", []).hashes;
    assert.deepEqual(base.suspicious, []);
    const realSection = base.sections["pyproject.toml#tool.pytest"];
    assert.match(realSection, /^[0-9a-f]{64}$/);

    writeFileSync(join(wt, "symlink:conftest.py"), "import os\n");
    writeFileSync(join(wt, "pyproject.toml#tool.pytest"), "junk\n");
    const h = runHasherRaw(wt, "hashes", []).hashes;
    assert.ok("symlink:conftest.py" in h.files, "real file lands in files");
    assert.ok(!("conftest.py" in h.symlinks), "not in symlinks");
    assert.deepEqual(Object.keys(h.symlinks), []);
    assert.ok(h.suspicious.includes("symlink:conftest.py"));
    assert.ok(h.suspicious.includes("pyproject.toml#tool.pytest"));
    assert.equal(h.sections["pyproject.toml#tool.pytest"], realSection, "section key intact");
    assert.ok(!("pyproject.toml#tool.pytest" in h.sections && h.sections["pyproject.toml#tool.pytest"] !== realSection));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a suspicious path name rejects the coder round", async () => {
  const s = hashViolation(H(HASHES_FLAT, ["symlink:conftest.py"]));
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  assert.match(
    inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding,
    /suspicious path name symlink:conftest\.py/,
  );
});

test("a file key and a synthetic key with the same text are compared separately", async () => {
  // files["git:info/exclude"] changes while git["info/exclude"] stays: still a violation
  const frozen = H(HASHES_FLAT);
  frozen.files["git:info/exclude"] = "f1";
  frozen.git["info/exclude"] = "g1";
  const now = JSON.parse(JSON.stringify(frozen));
  now.files["git:info/exclude"] = "f2";
  const s = happy({
    script: {
      "hasher:freeze:f1": { status: "ok", fingerprint: FP_PLAN, hashes: frozen },
      "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: now },
      "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: frozen },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

test("suspicious path names at freeze stop the run", async () => {
  const s = happy({
    script: { "hasher:freeze:f1": { status: "ok", fingerprint: FP_PLAN, hashes: H(HASHES_FLAT, ["a#b"]) } },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /suspicious/);
});


// ---------------------------------------------------------------- round 3

test("real DISPATCH format with a Why: line parses, and the fallback tier is used", async () => {
  const line = "DISPATCH: model=opus (fallback=fable)\nWhy: the failure this role exists for is a plausible diff";
  const s = withDispatch(
    happy({
      script: {
        "role:fleet-code-judge:r1": null,
        "role:fleet-code-judge:r1:fallback": { status: "ok", verdict: "approve", routed_findings: [] },
      },
    }),
    Object.assign({}, DISPATCH, { "fleet-code-judge": line }),
  );
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.equal(call(out, "role:fleet-code-judge:r1").opts.model, "opus");
  assert.equal(call(out, "role:fleet-code-judge:r1:fallback").opts.model, "fable");
});

test("code-judge gets hash_recheck built from the frozen and post-coder maps", async () => {
  const frozen = H({ ...HASHES_FLAT, "git:info/exclude": "g1", "symlink:lib": "../x" });
  const s = happy({
    script: {
      "hasher:freeze:f1": { status: "ok", fingerprint: FP_PLAN, hashes: frozen },
      "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: frozen },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  const rc = inputsOf(call(out, "role:fleet-code-judge:r1").prompt).hash_recheck;
  assert.deepEqual(rc["files/tests/test_a.py"], { frozen: "ha", current: "ha", match: true });
  assert.deepEqual(rc["sections/pyproject.toml#tool.pytest"], { frozen: "hp", current: "hp", match: true });
  assert.deepEqual(rc["git/info/exclude"], { frozen: "g1", current: "g1", match: true });
  assert.deepEqual(rc["symlinks/lib"], { frozen: "../x", current: "../x", match: true });
  assert.ok(!("suspicious" in rc));
});


// ---------------------------------------------------------------- drift-audit fixes

function fixTestsReentry(extra) {
  const testFinding = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  return happy({
    script: Object.assign(
      {
        "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [testFinding] },
        "hasher:fp-pre:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
        "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [testFinding] },
        "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
        "infra:sync:r3": { status: "ok", reason: "merged", head: "M2" },
        "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1", commit: "t1b" },
        "infra:integrate:r3": { status: "ok", head: "M3" },
        "hasher:fp-pre:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
        "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
        "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
        "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: HASHES },
        "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
        "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
        "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
        "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
      },
      extra || {},
    ),
  });
}

test("MI-1: every test-judge round of a fix_tests re-entry carries the code-judge context", async () => {
  const out = await run(fixTestsReentry(), ARGS);
  noUnscripted(out);
  for (const label of ["role:fleet-test-judge:r2", "role:fleet-test-judge:r3"]) {
    const tj = inputsOf(call(out, label).prompt);
    assert.equal(tj.code_judge_findings.length, 1, label);
    assert.deepEqual(tj.code_commits, ["k1"], label);
  }
  assert.ok(!("code_judge_findings" in inputsOf(call(out, "role:fleet-test-judge:r1").prompt)));
});

test("MI-2: a fix_tests re-entry merges the fleet branch into the criterion branches before writers", async () => {
  const out = await run(fixTestsReentry(), ARGS);
  noUnscripted(out);
  const iSync = out.labels.indexOf("infra:sync:r3");
  const iWriter = out.labels.indexOf("role:fleet-test-writer:AC1:r3");
  assert.ok(iSync >= 0 && iSync < iWriter, "sync runs before the re-entry writers");
  const sync = inputsOf(call(out, "infra:sync:r3").prompt);
  assert.equal(sync.branch, "fleet/l42-add-thing");
  assert.deepEqual(sync.criterion_worktrees.map((w) => w.branch).sort(), [
    "fleet/l42-add-thing--pabc1234d-t-AC1",
    "fleet/l42-add-thing--pabc1234d-t-AC2",
  ]);
  assert.ok(!out.labels.includes("infra:sync:r1"), "no sync on the initial entry");
});

test("S-4: pr-opener repo is the origin owner/name, not the recall project", async () => {
  const out = await run(happy(), { ...ARGS, project: "m-agahi/yadgar" });
  noUnscripted(out);
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.equal(pr.repo, "o/r");
  assert.equal(pr.project, "m-agahi/yadgar");
});

test("S-4: a missing remote_slug stops the run with needs_human", async () => {
  const s = happy();
  delete s.workspace.remote_slug;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /remote/);
  assert.ok(!out.labels.includes("role:scope-and-plan"));
});

test("S-2: roles get only criterion test files in frozen_tests; config files go to frozen_config_sections", async () => {
  const hashes = H({ ...HASHES_FLAT, "conftest.py": "hc", ".gitignore": "hg", "setup.cfg": "hs" });
  const s = happy({
    script: {
      "hasher:freeze:f1": { status: "ok", fingerprint: FP_PLAN, hashes },
      "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  for (const label of ["role:fleet-coder:r1", "role:fleet-code-judge:r1"]) {
    const i = inputsOf(call(out, label).prompt);
    assert.deepEqual(i.frozen_tests, { "tests/test_a.py": "ha", "tests/test_b.py": "hb" }, label);
    assert.equal(i.frozen_config_sections["conftest.py"], "hc");
    assert.equal(i.frozen_config_sections[".gitignore"], "hg");
    assert.equal(i.frozen_config_sections["setup.cfg"], "hs");
    assert.equal(i.frozen_config_sections["pyproject.toml#tool.pytest"], "hp");
  }
});

test("S-8: a role version lower than the frozen minimum stops in preflight", async () => {
  const s = happy();
  s.preflight.versions["fleet-coder"] = 9;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder version 9 < frozen 10/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("S-8: a higher role version is logged as prose-only and recorded", async () => {
  const s = happy();
  s.preflight.versions["fleet-code-judge"] = 10;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(out.result.gate_log.some((l) => /role fleet-code-judge v10 > frozen v9: prose-only changes assumed/.test(l)));
  assert.equal(out.result.role_versions["fleet-code-judge"], 10);
  assert.equal(out.result.role_versions["fleet-coder"], 10);
});

test("S-8: a role runner that loaded a different version than preflight is discarded", async () => {
  const s = happy();
  s["role:fleet-coder:r1"].role_version = 11;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-coder/);
  assert.match(out.result.reason, /version 11/);
  assert.equal(out.result.stop_gate, "contract");
  // 2.0.3: the hash check runs before the role check; the judge does not
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

test("S-8: preflight with no version for a role stops", async () => {
  const s = happy();
  delete s.preflight.versions["plan-audit"];
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan-audit/);
});

test("S-5: gates not stated in the PR body -> needs_human with the PR url", async () => {
  const s = happy();
  s["role:fleet-pr-opener"].gates_not_run_stated = false;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.pr_url, "https://github.com/o/r/pull/7");
  assert.match(out.result.reason, /gates_not_run/);
});

test("S-5: an approve reason without the gates prefix only logs a warning", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok");
  assert.ok(out.logs.some((l) => /warning/.test(l) && /approved with gates not run:/.test(l)));
  const s = happy();
  s["role:fleet-code-judge:r1"].reason = "approved with gates not run: coverage, mutation";
  const out2 = await run(s, ARGS);
  assert.ok(!out2.logs.some((l) => /warning/.test(l) && /approved with gates not run:/.test(l)));
});

test("an intake brief without a title stops before any role", async () => {
  for (const title of [undefined, "  "]) {
    const s = happy({ brief: { ...BRIEF, title } });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.match(out.result.reason, /title/);
    assert.deepEqual(out.labels, ["preflight", "intake"]);
  }
});

test("S-3: the frozen note explains UNPARSEABLE and symlink targets", async () => {
  const out = await run(happy(), ARGS);
  const note = inputsOf(call(out, "role:fleet-coder:r1").prompt).frozen_tests_note;
  assert.match(note, /UNPARSEABLE/);
  assert.match(note, /symlink:.*link targets?, not hashes/);
});

test("workspace excludes the .hypothesis/ cache", async () => {
  const out = await run(happy(), ARGS);
  assert.match(call(out, "workspace").prompt, /\.hypothesis\//);
});

test("manual criteria: no writer, no frozen entry, still listed for the PR opener", async () => {
  const crit = [...criteria(1), { id: "AC9", text: "operator checks the dashboard", test_files: [] }];
  const out = await run(happy({ criteria: crit }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-test-writer:AC9")));
  assert.deepEqual(inputsOf(call(out, "hasher:freeze:f1").prompt).test_files, ["tests/test_a.py", ".fleet/l42/plan_ref.json"]);
  assert.ok(!inputsOf(call(out, "role:fleet-test-judge:r1").prompt).criteria.some((c) => c.id === "AC9"));
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.ok(pr.criteria.some((c) => c.id === "AC9" && c.test_files.length === 0));
});


// ---------------------------------------------------------------- contract marker + output asserts

test("contract marker: missing or fleet-v1 in preflight halts; fleet-v2 passes", async () => {
  const missing = happy();
  missing.preflight.contract["fleet-coder"] = null;
  let out = await run(missing, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder contract null != fleet-v2/);
  assert.deepEqual(out.labels, ["preflight"]);

  const v1 = happy();
  v1.preflight.contract["plan-audit"] = "CONTRACT: fleet-v1";
  out = await run(v1, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role plan-audit contract fleet-v1 != fleet-v2/);
  assert.deepEqual(out.labels, ["preflight"]);

  out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok");
});

test("contract marker: a v1 marker in build-mode preflight halts before any build step", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation");
  s.preflight.contract["fleet-coder"] = "CONTRACT: fleet-v1";
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract fleet-v1 != fleet-v2/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("contract marker: a role runner that loaded another contract is discarded", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"].role_contract = "CONTRACT: fleet-v1";
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-test-judge/);
  assert.match(out.result.reason, /contract fleet-v1 != fleet-v2/);
  assert.ok(!out.labels.includes("hasher:freeze:f1"));
});

test("contract drift: planner ok output missing a required key stops", async () => {
  const s = happy();
  const p = Object.assign({}, s["role:scope-and-plan"], { __raw: true, role_version: FROZEN_VERSIONS["scope-and-plan"], role_contract: "CONTRACT: fleet-v2" });
  delete p.allowed_additions;
  delete p.held_out_examples;
  s["role:scope-and-plan"] = p;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role scope-and-plan contract drift: missing allowed_additions/);
});

test("contract drift: judge ok output missing a required key stops", async () => {
  const s = happy();
  s["role:fleet-code-judge:r1"] = {
    __raw: true,
    role_version: FROZEN_VERSIONS["fleet-code-judge"],
    role_contract: "CONTRACT: fleet-v2",
    status: "ok",
    reason: "approved with gates not run: coverage",
    verdict: "approve",
    routed_findings: [],
    hash_check: { match: true, mismatched: [] },
    gates_not_run: [],
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-code-judge contract drift: missing suite_result/);
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

test("contract drift: pr-opener ok output missing a required key stops", async () => {
  const s = happy();
  const pr = Object.assign({}, s["role:fleet-pr-opener"], { __raw: true, role_version: FROZEN_VERSIONS["fleet-pr-opener"], role_contract: "CONTRACT: fleet-v2" });
  delete pr.template_used;
  s["role:fleet-pr-opener"] = pr;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-pr-opener contract drift: missing template_used/);
});

test("contract drift: null/empty values are fine where allowed", async () => {
  const s = happy();
  s["role:fleet-test-writer:AC1:r1"].commit = null;
  s["role:fleet-pr-opener"].template_used = null;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
});

test("contract drift: a needs_human output may lack the role fields", async () => {
  const s = happy();
  s["role:fleet-coder:r1"] = { __raw: true, role_version: FROZEN_VERSIONS["fleet-coder"], role_contract: "CONTRACT: fleet-v2", status: "needs_human", reason: "test AC1 wrong" };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /test AC1 wrong/);
});

test("contract drift: an unknown verdict value stops (defence in depth over the schema enum)", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"].verdict = "approve_with_nits";
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract drift: fleet-test-judge verdict approve_with_nits/);
});


// ---------------------------------------------------------------- round 4: writer context + re-freeze

test("re-entry writers get code_judge_findings for their own criterion only", async () => {
  const f1 = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const f2 = { target: "tests", criterion: "AC2", finding: "other criterion" };
  const s = fixTestsReentry({
    "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [f1, f2] },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  const w = inputsOf(call(out, "role:fleet-test-writer:AC1:r3").prompt);
  assert.deepEqual(w.code_judge_findings, [f1]);
  assert.ok(!("code_judge_findings" in inputsOf(call(out, "role:fleet-test-writer:AC1:r1").prompt)));
});

test("re-freeze after an approved fix_tests round updates the map and the log", async () => {
  const after = H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" });
  const s = fixTestsReentry({
    "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: after },
    "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: after },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(out.result.refreeze_log, [
    {
      round: 1,
      freeze_ref_before: "P1",
      freeze_ref_after: "M3",
      changed: [{ path: "tests/test_a.py", before: "ha", after: "ha2" }],
    },
  ]);
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.equal(c2.frozen_tests["tests/test_a.py"], "ha2");
  assert.equal(c2.freeze_ref, "M3");
  assert.equal(c2.code_base_ref, "P1");
});

test("re-freeze touching another criterion's test file stops with needs_human", async () => {
  const s = fixTestsReentry({
    "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: H({ ...HASHES_FLAT, "tests/test_b.py": "hb2" }) },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /re-freeze touched unrouted path tests\/test_b\.py/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("re-freeze touching runner config or a symlink stops with needs_human", async () => {
  for (const [k, v] of [["conftest.py", "new"], ["pyproject.toml#tool.pytest", "hp2"], ["symlink:lib", "../x"], ["git:info/exclude", "e2"]]) {
    const s = fixTestsReentry({
      "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: H({ ...HASHES_FLAT, [k]: v }) },
    });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", k);
    assert.ok(out.result.reason.includes("re-freeze touched unrouted path " + k), out.result.reason);
  }
});

test("no fix_tests round means an empty refreeze_log", async () => {
  const out = await run(happy(), ARGS);
  assert.deepEqual(out.result.refreeze_log, []);
});


// ---------------------------------------------------------------- v2: modes

const ROLE_LABEL = /^role:/;

test("mode: missing or invalid mode returns needs_human before any agent", async () => {
  for (const mode of [undefined, "", "deploy", "PLAN", 1]) {
    const out = await runOne(happy(), { ...ARGS, mode });
    assert.equal(out.result.status, "needs_human", String(mode));
    assert.match(out.result.reason, /args\.mode must be "plan" or "build"/);
    assert.equal(out.calls.length, 0);
  }
});

test("mode build without a plan_ref returns needs_human before any agent", async () => {
  const out = await runOne(happy(), { mode: "build", date: "2026-11-04", repo: "/r" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan_ref missing/);
  assert.equal(out.calls.length, 0);
});

// ---------------------------------------------------------------- v2: intake

test("intake ambiguity stops before any role or workspace step", async () => {
  const s = happy({
    script: { intake: { status: "needs_human", reason: "ABC-1 names two repos: o/r, o/s" } },
  });
  const out = await runOne(s, { ...ARGS, input: "ABC-1" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /two repos/);
  assert.deepEqual(out.labels, ["preflight", "intake"]);
});

test("intake runs read-only, gets input, repo and project", async () => {
  const out = await runOne(happy(), ARGS);
  const c = call(out, "intake");
  assert.equal(c.opts.agentType, "fleet:judge");
  assert.equal(c.opts.model, "sonnet");
  assert.deepEqual(inputsOf(c.prompt), { input: "L42", repo: "/r", project: "o/r" });
  assert.match(c.prompt, /Read only/);
  assert.ok(out.labels.indexOf("intake") < out.labels.indexOf("workspace"));
});

test("intake brief with an unknown source kind or a relative repo stops", async () => {
  for (const brief of [
    { ...BRIEF, sources: [{ kind: "slack", ref: "x", body: "" }] },
    { ...BRIEF, repo: "r" },
    { ...BRIEF, sources: [] },
    { ...BRIEF, plan_path: "../outside.md" },
  ]) {
    const out = await runOne(happy({ brief }), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(brief));
    assert.deepEqual(out.labels, ["preflight", "intake"]);
  }
});

test("intake brief repo is where the fleet works; the brief reaches the planner", async () => {
  const brief = {
    title: "Fix login",
    description: "d",
    sources: [{ kind: "jira", ref: "ABC-12", url: "https://x.atlassian.net/browse/ABC-12", body: "names o/s" }],
    repo: "/src/s",
    plan_path: null,
  };
  const out = await runOne(happy({ brief }), { ...ARGS, input: "ABC-12" });
  noUnscripted(out);
  const ws = inputsOf(call(out, "workspace").prompt);
  assert.equal(ws.repo, "/src/s");
  assert.equal(ws.branch, "fleet/abc-12-fix-login");
  assert.deepEqual(inputsOf(call(out, "role:scope-and-plan").prompt).brief, brief);
});

// ---------------------------------------------------------------- v2: plan mode

test("plan mode returns awaiting_confirmation with every field and makes no push, PR or comment call", async () => {
  const out = await runOne(richPlan(), ARGS);
  noUnscripted(out);
  const r = out.result;
  assert.equal(r.status, "awaiting_confirmation");
  assert.equal(r.mode, "plan");
  assert.equal(r.tldr, "adds a thing");
  assert.deepEqual(r.plan_diff, ["new plan"]);
  assert.deepEqual(r.fleet_size, { criteria: 2, est_agents: 20, est_rounds: 1 });
  assert.equal(r.plan_path, "docs/plans/x.md");
  // the caller gets a tiny ref; the full sealed ref is committed in the plan commit
  const tiny = r.plan_ref;
  assert.deepEqual(Object.keys(tiny).sort(), ["branch", "plan_commit", "ref_path", "ref_sha256", "repo"]);
  assert.equal(tiny.branch, "fleet/l42-add-thing");
  assert.equal(tiny.plan_commit, PC);
  assert.equal(tiny.ref_path, ".fleet/l42/plan_ref.json");
  assert.equal(tiny.repo, "/r");
  const content = out.calls.length && richPlanStore(out);
  assert.equal(tiny.ref_sha256, sha256(content));
  const ref = JSON.parse(content);
  for (const k of ["branch", "plan_path", "plan_sha256", "criteria", "brief", "plan_facts", "history", "seal"]) assert.ok(k in ref, k);
  assert.equal(ref.plan_sha256, PSHA);
  assert.deepEqual(ref.brief, BRIEF);
  assert.deepEqual(ref.criteria.map((c) => c.id), ["AC1", "AC2"]);
  assert.ok(!content.includes("held_out_examples") && !content.includes(SECRET), "the ref file holds no held-out example");
  // held-out examples are dropped: never returned
  assert.ok(!JSON.stringify(r).includes('"held_out_examples":'), "no held_out_examples key in the result");
  assert.ok(!JSON.stringify(r).includes(SECRET));
  // the plan is committed locally; nothing is pushed, opened or posted
  assert.deepEqual(out.labels, [
    "preflight",
    "intake",
    "workspace",
    "infra:branch-scan",
    "role:scope-and-plan",
    "role:plan-audit",
    "infra:stage-plan",
    "infra:commit-plan",
  ]);
  const cp = call(out, "infra:commit-plan").prompt;
  assert.match(cp, /LOCALLY/);
  assert.match(cp, /Never push/);
  assert.match(cp, /plan\(l42\): add-thing/);
  assert.deepEqual(inputsOf(cp), {
    worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main",
    branch: "fleet/l42-add-thing",
    plan_path: "docs/plans/x.md",
    ref_path: ".fleet/l42/plan_ref.json",
    task_id: "l42",
    slug: "add-thing",
  });
});

// the ref file the plan run committed at the plan commit
function richPlanStore(out) {
  const c = call(out, "infra:commit-plan");
  return refContentOf(c.prompt);
}

test("plan_diff is forwarded to plan-audit as an array", async () => {
  const s = happy();
  s["role:scope-and-plan"].plan_diff = ["AC1 example changed", "scope: dropped src/old.py"];
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.deepEqual(inputsOf(call(out, "role:plan-audit").prompt).plan_diff, ["AC1 example changed", "scope: dropped src/old.py"]);
  assert.deepEqual(out.result.plan_diff, ["AC1 example changed", "scope: dropped src/old.py"]);
});

test("plan_diff that is not an array of strings is contract drift", async () => {
  for (const bad of ["new", "new plan", [], [1], null]) {
    const s = happy();
    s["role:scope-and-plan"].plan_diff = bad;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    // the generic type check (an array) fires first for non-arrays
    assert.match(out.result.reason, /contract drift: (scope-and-plan )?plan_diff/);
    assert.ok(!out.labels.includes("role:plan-audit"));
  }
});

test("REQUIRED_ON_OK: a planner ok output without tldr or plan_diff stops", async () => {
  for (const k of ["tldr", "plan_diff"]) {
    const s = happy();
    const p = Object.assign({}, REQUIRED_DEFAULTS["scope-and-plan"], s["role:scope-and-plan"], {
      __raw: true,
      role_version: FROZEN_VERSIONS["scope-and-plan"],
      role_contract: "CONTRACT: fleet-v2",
    });
    delete p[k];
    s["role:scope-and-plan"] = p;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.match(out.result.reason, new RegExp("role scope-and-plan contract drift: missing " + k));
  }
});

test("an ingested plan must be updated in place, not replaced", async () => {
  const s = happy({ brief: { ...BRIEF, plan_path: "docs/plans/old.md" } });
  s["role:scope-and-plan"].plan_path = "docs/plans/new.md";
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /updated in place/);
  assert.ok(!out.labels.includes("role:plan-audit"));
});

test("a commit-plan step that returns no sha fails before a plan_ref exists", async () => {
  const s = happy({ script: { "infra:commit-plan": { status: "ok", reason: "x", head: "P1", plan_sha256: PSHA } } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.ok(!("plan_ref" in out.result));
});

// ---------------------------------------------------------------- v2: plan_ref seal

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v === undefined ? null : v);
}

async function planRefFor(s) {
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  return out.result.plan_ref;
}

function buildArgs(ref, over) {
  return Object.assign({ mode: "build", plan_ref: ref, date: "2026-11-04", repo: "/r", project: "o/r" }, over || {});
}

test("ref file seal is the sha256 of its canonical JSON (utf-8, non-ASCII included)", async () => {
  const s = happy({ brief: { ...BRIEF, title: "Add Thing — ünïcode 🚀", description: "em — dash" } });
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[tiny.plan_commit]);
  const o = Object.assign({}, ref);
  delete o.seal;
  assert.equal(ref.seal, createHash("sha256").update(canon(o), "utf8").digest("hex"));
});

test("tiny plan_ref round trip: build mode loads the committed ref and uses it", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  assert.ok(JSON.stringify(tiny).length < 400, "tiny ref is small: " + JSON.stringify(tiny).length);
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const load = call(out, "infra:load-ref");
  assert.equal(load.opts.agentType, "fleet:judge");
  assert.deepEqual(inputsOf(load.prompt), {
    main_worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main",
    plan_commit: PC,
    ref_path: ".fleet/l42/plan_ref.json",
  });
  assert.ok(out.labels.indexOf("infra:load-ref") < out.labels.indexOf("infra:verify-plan"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r1").prompt).criteria.map((c) => c.id), ["AC1", "AC2"]);
});

test("a malformed tiny plan_ref is refused before any agent", async () => {
  const tiny = await planRefFor(happy());
  for (const bad of [
    { ...tiny, ref_sha256: "x" },
    { ...tiny, plan_commit: "P1" },
    { ...tiny, ref_path: "../etc/plan_ref.json" },
    { ...tiny, branch: "main" },
    { ...tiny, repo: "r" },
  ]) {
    const out = await runOne(happy(), buildArgs(bad));
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.equal(out.calls.length, 0);
  }
});

test("a wrong ref_sha256 stops after the load, before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs({ ...tiny, ref_sha256: "e".repeat(64) }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /ref_sha256/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("a tampered ref file stops before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  // the file at the plan commit differs from the one the plan run committed
  const ref = JSON.parse(s.__store[PC]);
  ref.criteria[0].text = "something else";
  s.__store[PC] = JSON.stringify(ref) + "\n";
  let out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /ref_sha256/);
  assert.ok(!out.labels.some((l) => ROLE_LABEL.test(l)));
  // a ref whose bytes match the tiny ref but whose inner seal is broken
  out = await runOne(s, buildArgs({ ...tiny, ref_sha256: sha256(s.__store[PC]) }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /seal mismatch/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("a ref file for another branch or repo stops before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  for (const over of [{ repo: "/other" }, { branch: "fleet/l42-other-slug" }]) {
    const out = await runOne(s, buildArgs({ ...tiny, ...over }));
    assert.equal(out.result.status, "needs_human", JSON.stringify(over));
    assert.match(out.result.reason, /ref file \.fleet\/l42\/plan_ref\.json does not match plan_ref/);
    assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
  }
});

test("a load step that copies the right sha256 but changed content stops", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[PC]);
  ref.tldr = "other";
  s["infra:load-ref"] = { status: "ok", reason: "read", content: JSON.stringify(ref) + "\n", sha256: tiny.ref_sha256 };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /does not match ref_sha256/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("a load step that returns content not matching its own sha256 stops", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  s["infra:load-ref"] = { status: "ok", reason: "read", content: s.__store[PC], sha256: "f".repeat(64) };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("commit-plan: committed ref bytes may be reformatted, but must parse to the same ref", async () => {
  // a formatter hook pretty-printed the file: same object, new bytes -> ok
  const s = happy();
  s["infra:commit-plan"] = (prompt) => {
    const pretty = JSON.stringify(JSON.parse(refContentOf(prompt)), null, 2) + "\n";
    s.__store[PC] = pretty;
    return { status: "ok", reason: "committed", head: PC, plan_sha256: PSHA, ref_sha256: sha256(pretty), ref_content: pretty };
  };
  const tiny = await planRefFor(s);
  assert.equal(tiny.ref_sha256, sha256(s.__store[PC]));
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  // a committed ref that differs from what the script wrote -> failed, no plan_ref
  const bad = happy();
  bad["infra:commit-plan"] = (prompt) => {
    const o = JSON.parse(refContentOf(prompt));
    o.tldr = "changed";
    const c = JSON.stringify(o) + "\n";
    return { status: "ok", reason: "committed", head: PC, plan_sha256: PSHA, ref_sha256: sha256(c), ref_content: c };
  };
  const r = await runOne(bad, ARGS);
  assert.equal(r.result.status, "failed");
  assert.ok(!("plan_ref" in r.result));
});

test("commit-plan: a plan hash that differs from the staged one fails", async () => {
  const s = happy({ script: { "infra:stage-plan": { status: "ok", reason: "staged", plan_sha256: "9".repeat(64) } } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /staged/);
});

test("the ref file is frozen: the hasher hashes it and the coder gets it as read-only config", async () => {
  const s = happy();
  const withRef = H({ ...HASHES_FLAT, ".fleet/l42/plan_ref.json": "hr" });
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes: withRef };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: withRef };
  const out = await run(s, ARGS);
  noUnscripted(out);
  const fz = inputsOf(call(out, "hasher:freeze:f1").prompt);
  assert.ok(fz.test_files.includes(".fleet/l42/plan_ref.json"));
  const coder = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  assert.ok(!(".fleet/l42/plan_ref.json" in coder.frozen_tests));
  assert.equal(coder.frozen_config_sections[".fleet/l42/plan_ref.json"], "hr");
});

test("a coder round that edits the ref file is rejected", async () => {
  const frozenRef = H({ ...HASHES_FLAT, ".fleet/l42/plan_ref.json": "hr" });
  const s = hashViolation(H({ ...HASHES_FLAT, ".fleet/l42/plan_ref.json": "TAMPERED" }));
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes: frozenRef };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2, hashes: frozenRef };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /\.fleet\/l42\/plan_ref\.json/);
});

// ---------------------------------------------------------------- plan mode on a built branch

// A sealed ref file as an earlier plan commit of task l42 holds it.
function priorRef(planPath, over) {
  const o = Object.assign(
    {
      branch: "fleet/l42-add-thing",
      plan_path: planPath,
      plan_sha256: PSHA,
      criteria: criteria(1),
      brief: BRIEF,
      task_id: "l42",
      slug: "add-thing",
      tldr: "t",
      plan_facts: { allowed_additions: null, est_diff_lines: 10 },
      history: { runs: 1, replans: 0, agents: 8 },
    },
    over || {},
  );
  o.seal = sha256(canon(o));
  return JSON.stringify(o) + "\n";
}

const PLAN_MD = "docs/plans/x.md";
const REF_L42 = ".fleet/l42/plan_ref.json";

function planCommit(sha, files, over) {
  return Object.assign({ sha, subject: "plan(l42): add-thing", files, ref_content: priorRef(PLAN_MD) }, over || {});
}

test("plan mode on a branch with build commits stops before the planner", async () => {
  const tampered = JSON.parse(priorRef(PLAN_MD));
  tampered.plan_path = "README.md";
  for (const commits of [
    [{ sha: "1111111", subject: "feat(x): add it", files: ["src/x.py"], ref_content: null }],
    // the right subject with the wrong files
    [planCommit("1111111", [PLAN_MD, "src/x.py"])],
    [planCommit("1111111", ["src/x.py"])],
    // any other .md file is not the plan
    [planCommit("1111111", ["README.md"])],
    [planCommit("1111111", [PLAN_MD, "README.md"])],
    [planCommit("1111111", ["docs/plans/other.md"])],
    // any other file under .fleet/<task>/ is not the ref file
    [planCommit("1111111", [PLAN_MD, ".fleet/l42/notes.txt"])],
    [planCommit("1111111", [".fleet/l42/plan_ref.json.bak"])],
    [planCommit("1111111", [PLAN_MD, ".fleet/l43/plan_ref.json"])],
    // another task's plan subject
    [planCommit("1111111", [PLAN_MD], { subject: "plan(l43): other" })],
    // no files, no ref file at the commit, or a ref whose seal is broken
    [planCommit("1111111", [])],
    [planCommit("1111111", [PLAN_MD], { ref_content: null })],
    [planCommit("1111111", ["README.md"], { ref_content: JSON.stringify(tampered) + "\n" })],
    // a ref file of another task
    [planCommit("1111111", [PLAN_MD], { ref_content: priorRef(PLAN_MD, { task_id: "l43", branch: "fleet/l43-add-thing" }) })],
    [planCommit("1111111", [PLAN_MD, REF_L42]), { sha: "2222222", subject: "test(AC1): behaviour 1", files: ["tests/test_a.py"], ref_content: null }],
  ]) {
    const s = happy({ script: { "infra:branch-scan": { status: "ok", reason: "scanned", commits } } });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(commits.map((c) => [c.subject, c.files])));
    assert.match(out.result.reason, /branch has build commits; run build, or delete branch/);
    assert.ok(!out.labels.includes("role:scope-and-plan"));
    assert.ok(!out.labels.includes("infra:commit-plan"));
  }
});

test("plan mode on a plan-only branch re-plans and adds a new plan commit", async () => {
  for (const commits of [
    [planCommit("1111111", [PLAN_MD])],
    [planCommit("1111111", [PLAN_MD, REF_L42])],
    [planCommit("1111111", ["./" + PLAN_MD, REF_L42]), planCommit("2222222", [REF_L42])],
    // each commit's own ref file names its plan path
    [
      planCommit("1111111", ["docs/plans/old.md", REF_L42], { ref_content: priorRef("docs/plans/old.md") }),
      planCommit("2222222", [PLAN_MD, REF_L42]),
    ],
  ]) {
    const s = happy({ script: { "infra:branch-scan": { status: "ok", reason: "scanned", commits } } });
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(commits.map((c) => c.files)) + " " + out.result.reason);
    assert.ok(out.labels.includes("infra:commit-plan"));
  }
  const out = await runOne(happy(), ARGS);
  const scan = call(out, "infra:branch-scan");
  assert.equal(scan.opts.agentType, "fleet:judge");
  assert.deepEqual(inputsOf(scan.prompt), {
    main_worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main",
    default_branch: "master",
    ref_path: REF_L42,
  });
  // the same load-ref program reads each commit's ref file
  assert.ok(scan.prompt.includes("python3 -I -c") && scan.prompt.includes("'<sha>' '.fleet/l42/plan_ref.json'"));
});

// ---------------------------------------------------------------- v2: build mode verify

test("build mode: preflight first, then workspace, verify, prepare; no planner", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(out.labels.slice(0, 5), ["preflight", "workspace", "infra:load-ref", "infra:verify-plan", "infra:prepare"]);
  assert.ok(!out.labels.some((l) => l.startsWith("role:scope-and-plan") || l.startsWith("role:plan-audit")));
  const v = inputsOf(call(out, "infra:verify-plan").prompt);
  assert.deepEqual(v, {
    main_worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main",
    branch: "fleet/l42-add-thing",
    plan_commit: PC,
    plan_path: "docs/plans/x.md",
    ref_path: ".fleet/l42/plan_ref.json",
  });
  assert.equal(call(out, "infra:verify-plan").opts.agentType, "fleet:judge");
});

test("build mode: a plan hash mismatch stops with 'plan changed since approval'", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  s["infra:verify-plan"] = { ...s["infra:verify-plan"], plan_sha256: "b".repeat(64) };
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan changed since approval/);
  assert.ok(!out.labels.includes("infra:prepare"));
  assert.ok(!out.labels.some((l) => ROLE_LABEL.test(l)));
});

test("build mode: a branch moved off the plan commit stops", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const cases = [
    // HEAD not a descendant of plan_commit
    { head: "fedcba9876", is_ancestor: false, commits_since: [] },
    // a descendant with a non-fleet commit
    { head: "fedcba9876", is_ancestor: true, commits_since: [{ sha: "fedcba9876", subject: "wip: hand edit" }] },
    // a later commit changed the plan file
    { head: "fedcba9876", is_ancestor: true, plan_touched: ["fedcba9876"], commits_since: [{ sha: "fedcba9876", subject: "fix: x" }] },
    { head: "fedcba9876", is_ancestor: true, plan_sha256_head: "c".repeat(64), commits_since: [{ sha: "fedcba9876", subject: "fix: x" }] },
  ];
  for (const c of cases) {
    s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], ...c };
    const out = await runOne(s, buildArgs(ref));
    assert.equal(out.result.status, "needs_human", JSON.stringify(c));
    assert.match(out.result.reason, /plan changed since approval/);
    assert.ok(!out.labels.includes("infra:prepare"), JSON.stringify(c));
  }
});

test("build mode: a descendant made only by fleet steps of this build proceeds", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const head = "fedcba9876";
  s["infra:verify-plan"] = {
    ...s["infra:verify-plan"],
    head,
    commits_since: [
      { sha: "1111111", subject: "test(AC1): behaviour 1" },
      { sha: "2222222", subject: "Merge branch 'fleet/l42-add-thing--pabc1234d-t-AC1'" },
      { sha: "3333333", subject: "Merge branch 'fleet/l42-add-thing' into fleet/l42-add-thing--pabc1234d-t-AC2" },
      { sha: "4444444", subject: "feat(thing): add it" },
    ],
  };
  s["infra:prepare"] = { status: "ok", reason: "ok", head };
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(out.logs.some((l) => /descends from plan_commit by 4 fleet commit/.test(l)));
  // a merge of a criterion branch from another plan is not a fleet step of this build
  s["infra:verify-plan"].commits_since = [{ sha: "5", subject: "Merge branch 'fleet/l42-add-thing--p99999999-t-AC1'" }];
  const other = await runOne(s, buildArgs(ref));
  assert.equal(other.result.status, "needs_human");
});

test("build mode: criterion branches and worktrees are named by the plan commit", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  const prep = inputsOf(call(out, "infra:prepare").prompt);
  assert.deepEqual(prep.criterion_worktrees.map((w) => w.branch), [
    "fleet/l42-add-thing--pabc1234d-t-AC1",
    "fleet/l42-add-thing--pabc1234d-t-AC2",
  ]);
  assert.equal(prep.criterion_worktrees[0].path, "/r/.claude/worktrees/fleet-l42-add-thing/pabc1234d-t-AC1");
  assert.doesNotMatch(call(out, "infra:prepare").prompt, /git -C <main_worktree> commit/);
});

test("build mode: the script pushes the approved sha before the PR opener runs", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  const iPush = out.labels.indexOf("infra:push");
  const iPr = out.labels.indexOf("role:fleet-pr-opener");
  assert.ok(iPush > 0 && iPr > iPush);
  const p = inputsOf(call(out, "infra:push").prompt);
  assert.equal(p.approved_sha, "K1");
  assert.equal(p.branch, "fleet/l42-add-thing");
  assert.match(call(out, "infra:push").prompt, /Never --force/);
});

test("build mode: a push that did not land the approved sha stops before the PR", async () => {
  const s = happy({ script: { "infra:push": { status: "ok", reason: "x", remote_head: "other" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /not the approved K1/);
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

test("plan hash: stage and verify steps embed the same program, and it hashes the committed bytes", { skip: !HAVE_PY }, async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  const build = await runOne(s, buildArgs(plan.result.plan_ref));
  const progs = [call(plan, "infra:stage-plan").prompt, call(build, "infra:verify-plan").prompt].map((p) => {
    const m = p.match(/python3 -I -c ('(?:[^']|'\\'')*')/);
    assert.ok(m, "prompt embeds the plan hash program");
    return m[1];
  });
  assert.equal(progs[0], progs[1]);
  const prog = progs[0].slice(1, -1).replace(/'\\''/g, "'");
  const wt = scratchRepo("fleet-planhash-");
  try {
    const text = "# plan — ü\n";
    sh(wt, "mkdir", "-p", "docs");
    writeFileSync(join(wt, "docs", "p.md"), text);
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-q", "-m", "plan");
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    const got = sh(wt, "python3", "-I", "-c", prog, wt, head, "docs/p.md").trim();
    assert.equal(got, createHash("sha256").update(text, "utf8").digest("hex"));
    assert.equal(sh(wt, "python3", "-I", "-c", prog, wt, "HEAD", "docs/p.md").trim(), got);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- v2: plan_wrong re-plan

const PC2 = "0123456789ab";

function planWrong(findings) {
  const s = happy();
  return Object.assign(s, {
      "role:fleet-code-judge:r1": { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: findings },
      "infra:replan-worktree": { status: "ok", reason: "ok", head: PC },
      "role:scope-and-plan:replan": {
        status: "ok",
        reason: "replanned",
        plan_path: "docs/plans/x.md",
        criteria: [...criteria(2), { id: "AC3", text: "behaviour 3", test_files: ["tests/test_c.py"] }],
        est_diff_lines: 90,
        new_behaviour: true,
        tldr: "adds a thing, now with AC3",
        plan_diff: ["AC3 added: the code judge found a missing behaviour"],
        fleet_estimate: { criteria: 3, agents: 24, rounds: 1 },
        held_out_examples: [{ criterion_id: "AC3", given: "g", when: "w", then: SECRET }],
      },
      "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
      "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: "d".repeat(64) },
      "infra:commit-plan:replan": commitStub(s.__store, PC2, "d".repeat(64)),
      "infra:replan-reset": { status: "ok", reason: "reset", head: PC2, superseded_head: "K1" },
  });
}

test("plan_wrong: re-plan from the approved plan, save the superseded head, return awaiting_confirmation", async () => {
  const f = {
    target: "plan",
    criterion: "AC2",
    finding: "src/x.py:3 — AC2 contradicts AC1 — Proposed plan change: split AC2 into AC2 and AC3",
  };
  const s = planWrong([f, { target: "code", criterion: "AC1", finding: "ignored" }]);
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  const r = out.result;
  assert.equal(r.status, "awaiting_confirmation");
  assert.deepEqual(r.proposed_plan_change, ["split AC2 into AC2 and AC3"]);
  assert.deepEqual(r.plan_findings, [f]);
  assert.equal(r.superseded_ref, "fleet/l42-add-thing--superseded-1");
  assert.equal(r.superseded_head, "K1");
  assert.equal(r.tldr, "adds a thing, now with AC3");
  assert.deepEqual(r.plan_diff, ["AC3 added: the code judge found a missing behaviour"]);
  assert.equal(r.fleet_size.criteria, 3);
  assert.equal(r.plan_ref.plan_commit, PC2);
  assert.equal(r.plan_ref.branch, "fleet/l42-add-thing");
  assert.equal(r.plan_ref.ref_sha256, sha256(s.__store[PC2]));
  assert.equal(JSON.parse(s.__store[PC2]).history.replans, 1);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  // no PR, no push, no write-back on a plan_wrong stop
  for (const l of ["infra:push", "role:fleet-pr-opener", "infra:ledger-writeback", "infra:comments-list", "infra:comments-post"])
    assert.ok(!out.labels.includes(l), l);
  // order: worktree at the old plan commit, planner, audit, commit there, then save + reset
  const tail = out.labels.slice(out.labels.indexOf("hasher:fp-post:code-judge:r1") + 1);
  assert.deepEqual(tail, [
    "infra:replan-worktree",
    "role:scope-and-plan:replan",
    "role:plan-audit:replan",
    "infra:stage-plan:replan",
    "infra:commit-plan:replan",
    "infra:replan-reset",
  ]);
  const rw = inputsOf(call(out, "infra:replan-worktree").prompt);
  assert.equal(rw.plan_commit, PC);
  const planner = inputsOf(call(out, "role:scope-and-plan:replan").prompt);
  assert.equal(planner.worktree, rw.worktree);
  assert.equal(planner.brief.plan_path, "docs/plans/x.md");
  assert.ok(planner.brief.sources.some((x) => x.kind === "text" && x.body.includes("Proposed plan change: split AC2")));
  assert.equal(inputsOf(call(out, "role:plan-audit:replan").prompt).base_ref, PC);
  assert.equal(inputsOf(call(out, "infra:commit-plan:replan").prompt).branch, null);
  const reset = inputsOf(call(out, "infra:replan-reset").prompt);
  assert.deepEqual(
    { superseded_branch: reset.superseded_branch, expected_head: reset.expected_head, new_plan_commit: reset.new_plan_commit },
    { superseded_branch: "fleet/l42-add-thing--superseded-1", expected_head: "K1", new_plan_commit: PC2 },
  );
  assert.match(call(out, "infra:replan-reset").prompt, /Only after step 2 succeeded/);
});

test("plan_wrong: a finding without the marker line falls back to the full text and is logged", async () => {
  const f = { target: "plan", criterion: null, finding: "the plan assumes a sync API that does not exist" };
  const s = planWrong([f]);
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "awaiting_confirmation");
  assert.deepEqual(out.result.proposed_plan_change, ["the plan assumes a sync API that does not exist"]);
  assert.ok(out.logs.some((l) => /no 'Proposed plan change:' line/.test(l)));
});

test("plan_wrong: the next build starts fresh from the new plan with new criterion branches; caps reset, counts accumulate", async () => {
  const s = planWrong([{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: y" }]);
  const ref = await planRefFor(s);
  const first = await runOne(s, buildArgs(ref));
  const ref2 = first.result.plan_ref;
  // second build run: the code judge now approves; the branch sits at the new plan commit
  s["role:fleet-code-judge:r1"] = happy()["role:fleet-code-judge:r1"];
  s["infra:verify-plan"] = { ...s["infra:verify-plan"], head: PC2, plan_sha256: "d".repeat(64), plan_sha256_head: "d".repeat(64) };
  s["infra:prepare"] = { status: "ok", reason: "ok", head: PC2 };
  s["role:fleet-test-writer:AC3:r1"] = { status: "ok", reason: "red", criterion_id: "AC3", tests: [], commit: "t-AC3" };
  const hashes = H({ ...HASHES_FLAT, "tests/test_c.py": "hc" });
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes };
  const second = await runOne(s, buildArgs(ref2));
  noUnscripted(second);
  assert.equal(second.result.status, "ok");
  const prep = inputsOf(call(second, "infra:prepare").prompt);
  assert.deepEqual(prep.criterion_worktrees.map((w) => w.branch), [
    "fleet/l42-add-thing--p01234567-t-AC1",
    "fleet/l42-add-thing--p01234567-t-AC2",
    "fleet/l42-add-thing--p01234567-t-AC3",
  ]);
  assert.equal(inputsOf(call(second, "hasher:freeze:f1").prompt).test_files.length, 4);
  assert.deepEqual(second.result.rounds, { tests: 1, code: 1 });
  assert.equal(second.result.agents, second.calls.length);
  assert.equal(second.result.cumulative.runs, 3);
  assert.equal(second.result.cumulative.replans, 1);
  assert.equal(second.result.cumulative.agents, JSON.parse(s.__store[PC]).history.agents + first.result.agents + second.result.agents);
});

// ---------------------------------------------------------------- v2: write-back

function withSources(sources, over) {
  return happy({ brief: { ...BRIEF, sources }, script: over || {} });
}

const GH = { kind: "github", ref: "o/r#5", url: "https://github.com/o/r/issues/5", body: "issue" };
const JIRA = { kind: "jira", ref: "ABC-9", url: "https://x.atlassian.net/browse/ABC-9", body: "ticket" };

function listing(hasMarker) {
  return (prompt) => ({
    status: "ok",
    reason: "listed",
    results: inputsOf(prompt).sources.map((x) => ({ key: x.key, status: "ok", has_marker: !!hasMarker[x.ref] })),
  });
}

function posting(fail) {
  return (prompt) => ({
    status: "ok",
    reason: "posted",
    results: inputsOf(prompt).posts.map((x) =>
      fail && fail[x.ref] ? { key: x.key, status: "failed", reason: "403" } : { key: x.key, status: "posted", url: "u" },
    ),
  });
}

test("write-back: the ledger is written only for ledger sources", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  const lw = inputsOf(call(out, "infra:ledger-writeback").prompt);
  assert.equal(lw.project, "o/r");
  assert.deepEqual(lw.tasks, [{ key: "s0", ref: "42" }]);
  assert.match(lw.section_text, /adds a thing/);
  assert.match(lw.section_text, /docs\/plans\/x\.md/);
  assert.match(lw.section_text, /https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(lw.section_text, /fleet:l42/);
  assert.equal(out.result.ledger_status, "ok");
  assert.equal(out.result.comment_status, "none");

  const gh = await run(withSources([GH], { "infra:comments-list": listing({}), "infra:comments-post": posting() }), {
    ...ARGS,
    input: GH.url,
  });
  noUnscripted(gh);
  assert.ok(!gh.labels.includes("infra:ledger-writeback"));
  assert.equal(gh.result.ledger_status, "none");
});

test("write-back: one marked comment per external source; GitHub hides the marker, Jira ends with it", async () => {
  const s = withSources([JIRA, GH], { "infra:comments-list": listing({}), "infra:comments-post": posting() });
  const out = await run(s, { ...ARGS, input: "ABC-9" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.equal(out.result.comment_status, "posted");
  const posts = inputsOf(call(out, "infra:comments-post").prompt).posts;
  assert.equal(posts.length, 2);
  const jira = posts.find((x) => x.kind === "jira").text;
  const gh = posts.find((x) => x.kind === "github").text;
  assert.match(jira, /\n\nfleet:abc-9$/);
  assert.match(gh, /\n\n<!-- fleet:abc-9 -->$/);
  for (const t of [jira, gh]) {
    assert.match(t, /^adds a thing/);
    assert.match(t, /Plan: https:\/\/github\.com\/o\/r\/blob\/fleet\/abc-9-add-thing\/docs\/plans\/x\.md/);
    assert.match(t, /PR: https:\/\/github\.com\/o\/r\/pull\/7/);
  }
  assert.equal(call(out, "infra:comments-list").opts.agentType, "fleet:judge");
  assert.match(call(out, "infra:comments-post").prompt, /Never edit an issue, ticket or PR body/);
  assert.ok(out.labels.indexOf("infra:comments-post") > out.labels.indexOf("role:fleet-pr-opener"));
});

test("write-back: a source whose comments already carry the marker is skipped, not posted", async () => {
  const s = withSources([JIRA, GH], { "infra:comments-list": listing({ "o/r#5": true }), "infra:comments-post": posting() });
  const out = await run(s, { ...ARGS, input: "ABC-9" });
  noUnscripted(out);
  const posts = inputsOf(call(out, "infra:comments-post").prompt).posts;
  assert.deepEqual(posts.map((x) => x.ref), ["ABC-9"]);
  const all = withSources([GH], { "infra:comments-list": listing({ "o/r#5": true }) });
  const out2 = await run(all, { ...ARGS, input: GH.url });
  noUnscripted(out2);
  assert.ok(!out2.labels.includes("infra:comments-post"));
  assert.equal(out2.result.comment_status, "skipped");
  assert.equal(out2.result.write_back.comments[0].status, "skipped");
});

test("write-back: a comment failure reports comment_status failed with the text; the run stays ok", async () => {
  for (const over of [
    { "infra:comments-list": listing({}), "infra:comments-post": posting({ "o/r#5": true }) },
    { "infra:comments-list": listing({}), "infra:comments-post": null },
    { "infra:comments-list": { status: "failed", reason: "MCP absent" } },
  ]) {
    const out = await run(withSources([GH], over), { ...ARGS, input: GH.url });
    assert.equal(out.result.status, "ok");
    assert.equal(out.result.pr_url, "https://github.com/o/r/pull/7");
    assert.equal(out.result.comment_status, "failed");
    assert.match(out.result.comment_text, /<!-- fleet:o-r-5 -->/);
    assert.equal(out.result.write_back.comments[0].comment_text, out.result.comment_text);
  }
});

test("write-back: a ledger failure is reported and never stops the run", async () => {
  const out = await run(happy({ script: { "infra:ledger-writeback": null } }), ARGS);
  assert.equal(out.result.status, "ok");
  assert.equal(out.result.ledger_status, "failed");
  assert.match(out.result.write_back.ledger[0].section_text, /fleet:l42/);
  const noProject = await run(happy(), ARGS, { project: undefined });
  assert.equal(noProject.result.status, "ok");
  assert.ok(!noProject.build.labels.includes("infra:ledger-writeback"));
  assert.equal(noProject.result.ledger_status, "failed");
});

test("write-back: comment text with a line starting with a terraform-bot word is refused in code", async () => {
  const word = ["dig", "ger"].join("");
  for (const tldr of [word + " apply", "  Atlantis plan -p x", "fine\n" + word.toUpperCase() + " unlock"]) {
    const s = withSources([GH], { "infra:comments-list": listing({}), "infra:comments-post": posting() });
    s["role:scope-and-plan"].tldr = tldr;
    const out = await run(s, { ...ARGS, input: GH.url });
    assert.equal(out.result.status, "ok", tldr);
    assert.ok(!out.labels.includes("infra:comments-list"), tldr);
    assert.ok(!out.labels.includes("infra:comments-post"), tldr);
    assert.equal(out.result.comment_status, "failed");
    assert.match(out.result.write_back.comments[0].reason, /refused/);
  }
});

// ---------------------------------------------------------------- 2.0.2: ignore-rule scope, cache dirs

// "Mismatch" as the script sees it: any of the four maps differs, or the
// suspicious list is non-empty.
function hasherMismatch(a, b) {
  for (const m of ["files", "sections", "git", "symlinks"])
    if (JSON.stringify(a.hashes[m]) !== JSON.stringify(b.hashes[m])) return true;
  return b.hashes.suspicious.length > 0;
}

function cacheRepo(prefix, rootIgnore) {
  const wt = scratchRepo(prefix);
  writeFileSync(join(wt, ".gitignore"), rootIgnore);
  sh(wt, "mkdir", "-p", "tests");
  writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    pass\n");
  sh(wt, "git", "add", ".");
  sh(wt, "git", "commit", "-q", "-m", "init");
  return wt;
}

test("hasher 2.0.2: an untracked .gitignore in an ignored .ruff_cache/ may be rewritten", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-ruff-", ".ruff_cache/\n.import_linter_cache/\n");
  try {
    for (const d of [".ruff_cache", ".import_linter_cache"]) {
      sh(wt, "mkdir", "-p", d);
      writeFileSync(join(wt, d, ".gitignore"), "# Automatically created\n*");
    }
    const a = runHasherRaw(wt, "hashes", []);
    assert.ok(!(".ruff_cache/.gitignore" in a.hashes.files), "cache .gitignore is not a key");
    for (const d of [".ruff_cache", ".import_linter_cache"]) writeFileSync(join(wt, d, ".gitignore"), "# rewritten by a hook\n*\n");
    const b = runHasherRaw(wt, "hashes", []);
    assert.equal(hasherMismatch(a, b), false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: a self-ignoring cache dir (no root rule) is skipped too", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-selfcache-", "*.log\n");
  try {
    sh(wt, "mkdir", "-p", ".ruff_cache/0.6.0");
    writeFileSync(join(wt, ".ruff_cache", ".gitignore"), "*");
    const a = runHasherRaw(wt, "hashes", []);
    writeFileSync(join(wt, ".ruff_cache", ".gitignore"), "# Automatically created by ruff.\n*\n");
    const b = runHasherRaw(wt, "hashes", []);
    assert.equal(hasherMismatch(a, b), false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: a .gitignore inside a dir ignored from outside is not frozen", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-out-", "out/\n");
  try {
    sh(wt, "mkdir", "-p", "out/sub");
    writeFileSync(join(wt, "out", ".gitignore"), "a\n");
    writeFileSync(join(wt, "out", "sub", ".gitignore"), "a\n");
    const a = runHasherRaw(wt, "hashes", []);
    assert.ok(!("out/.gitignore" in a.hashes.files));
    writeFileSync(join(wt, "out", ".gitignore"), "b\n");
    writeFileSync(join(wt, "out", "sub", ".gitignore"), "b\n");
    assert.equal(hasherMismatch(a, runHasherRaw(wt, "hashes", [])), false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: a new untracked non-ignored tests/.gitignore is a mismatch", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-newign-", ".ruff_cache/\n");
  try {
    const a = runHasherRaw(wt, "hashes", []);
    writeFileSync(join(wt, "tests", ".gitignore"), "hidden_*.py\n");
    const b = runHasherRaw(wt, "hashes", []);
    assert.ok("tests/.gitignore" in b.hashes.files);
    assert.equal(hasherMismatch(a, b), true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: a self-ignoring tests/.gitignore hiding a nested pyproject is a mismatch", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-selfign-", ".ruff_cache/\n");
  try {
    const a = runHasherRaw(wt, "hashes", []);
    writeFileSync(join(wt, "tests", ".gitignore"), "*\n");
    writeFileSync(join(wt, "tests", "pyproject.toml"), '[tool.pytest.ini_options]\naddopts = "-k nothing"\n');
    const b = runHasherRaw(wt, "hashes", []);
    assert.ok("tests/.gitignore" in b.hashes.files, "a .gitignore that ignores itself is still frozen");
    assert.equal(hasherMismatch(a, b), true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: an ignored new conftest plus a tracked .gitignore edit is a mismatch", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-regress-", ".ruff_cache/\n");
  try {
    const a = runHasherRaw(wt, "hashes", []);
    writeFileSync(join(wt, ".gitignore"), ".ruff_cache/\ntests/conftest.py\n");
    writeFileSync(join(wt, "tests", "conftest.py"), "import os\n");
    const b = runHasherRaw(wt, "hashes", []);
    assert.ok("tests/conftest.py" in b.hashes.files);
    assert.notEqual(b.hashes.files[".gitignore"], a.hashes.files[".gitignore"]);
    assert.equal(hasherMismatch(a, b), true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: runner config dropped into an ignored cache dir is suspicious", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-cacheconf-", ".ruff_cache/\n__pycache__/\n.hypothesis/\n");
  try {
    for (const d of [".ruff_cache", "tests/__pycache__", ".hypothesis"]) sh(wt, "mkdir", "-p", d);
    writeFileSync(join(wt, "tests", "__pycache__", "test_a.cpython-312.pyc"), "x");
    const a = runHasherRaw(wt, "hashes", []);
    assert.deepEqual(a.hashes.suspicious, []);
    for (const [d, f] of [[".ruff_cache", "conftest.py"], ["tests/__pycache__", "conftest.py"], [".hypothesis", "pytest.ini"]]) {
      writeFileSync(join(wt, d, f), "x\n");
      const b = runHasherRaw(wt, "hashes", []);
      assert.ok(b.hashes.suspicious.some((s) => s.includes(d + "/" + f)), d + "/" + f + " in " + JSON.stringify(b.hashes.suspicious));
      assert.equal(hasherMismatch(a, b), true);
      rmSync(join(wt, d, f));
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: deleting a cache dir is not a mismatch", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-delcache-", ".ruff_cache/\n.mypy_cache/\n");
  try {
    for (const d of [".ruff_cache", ".mypy_cache"]) {
      sh(wt, "mkdir", "-p", d);
      writeFileSync(join(wt, d, ".gitignore"), "*\n");
      writeFileSync(join(wt, d, "data"), "x\n");
    }
    const a = runHasherRaw(wt, "hashes", []);
    rmSync(join(wt, ".ruff_cache"), { recursive: true, force: true });
    rmSync(join(wt, ".mypy_cache"), { recursive: true, force: true });
    assert.equal(hasherMismatch(a, runHasherRaw(wt, "hashes", [])), false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: a cache-named dir that is NOT ignored is walked normally", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-notign-", "*.log\n");
  try {
    sh(wt, "mkdir", "-p", "__pycache__");
    writeFileSync(join(wt, "__pycache__", "conftest.py"), "x\n");
    const h = runHasherRaw(wt, "hashes", []);
    assert.ok("__pycache__/conftest.py" in h.hashes.files);
    assert.deepEqual(h.hashes.suspicious, []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher prompt names the cache dirs and the ignore-rule scope", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out, "hasher:freeze:f1").prompt;
  for (const d of [".ruff_cache", ".import_linter_cache", ".mypy_cache", ".pytest_cache", ".hypothesis", "__pycache__"])
    assert.ok(p.includes(d), "hasher prompt names " + d);
  assert.match(p, /ls-files -z --cached --others --exclude-standard -- ':\(glob\)\*\*\/\.gitignore' \.gitignore/);
});

test("a cache-dir suspicious entry at freeze stops the run with a clear reason", async () => {
  const s = happy({
    script: {
      "hasher:freeze:f1": {
        status: "ok",
        fingerprint: FP_PLAN,
        hashes: H(HASHES_FLAT, ["runner config in a skipped cache dir: .ruff_cache/conftest.py"]),
      },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /runner config in a skipped cache dir: \.ruff_cache\/conftest\.py/);
});

// ---------------------------------------------------------------- 2.0.2: typed role outputs

// The array fields each role schema must type (present, not required).
const TYPED_ARRAYS = {
  "fleet-coder": ["commits", "added_symbols", "addressed_findings"],
  "fleet-test-writer": ["tests", "addressed_findings"],
  "plan-audit": ["routed_findings"],
  "fleet-test-judge": ["routed_findings", "checked"],
  "fleet-code-judge": ["routed_findings", "gates_not_run"],
};

// Minimal JSON-schema type check: enough to show the schema rejects a value.
function schemaTypeOk(prop, v) {
  const types = [].concat(prop.type);
  return types.some((t) =>
    t === "array" ? Array.isArray(v) : t === "null" ? v === null : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t,
  );
}

test("role schemas type every array field and still do not require it", async () => {
  const out = await run(happy(), ARGS);
  const seen = {};
  for (const c of out.calls.concat(out.build ? out.build.calls : [])) {
    const m = /^role:([a-z-]+)/.exec(c.label);
    if (m && c.opts && c.opts.schema) seen[m[1]] = c.opts.schema;
  }
  for (const [role, keys] of Object.entries(TYPED_ARRAYS)) {
    const sc = seen[role];
    assert.ok(sc, "saw schema for " + role);
    for (const k of keys) {
      assert.ok(sc.properties[k], role + " types " + k);
      assert.equal(sc.properties[k].type, "array", role + " " + k);
      assert.ok(sc.properties[k].items, role + " " + k + " has items");
      assert.equal(schemaTypeOk(sc.properties[k], "[]"), false, role + " " + k + " rejects the string []");
      assert.ok(!sc.required.includes(k), role + " " + k + " not schema-required");
    }
  }
});

test("contract drift: a string \"[]\" for a required array key is rejected in code", async () => {
  const s = happy();
  s["role:fleet-coder:r1"].added_symbols = "[]";
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract drift: fleet-coder added_symbols type/);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

test("contract drift: wrong object and boolean types are rejected in code", async () => {
  for (const [label, key, val, role] of [
    ["role:fleet-code-judge:r1", "hash_check", "{}", "fleet-code-judge"],
    ["role:fleet-coder:r1", "frozen_tests_red_at_start", "true", "fleet-coder"],
    ["role:fleet-test-judge:r1", "checked", "[]", "fleet-test-judge"],
  ]) {
    const s = happy();
    s[label][key] = val;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", label);
    assert.match(out.result.reason, new RegExp("contract drift: " + role + " " + key + " type"), label);
  }
});

test("contract drift: a coder ok output missing added_symbols is still rejected", async () => {
  const s = happy();
  const c = Object.assign({}, REQUIRED_DEFAULTS["fleet-coder"], s["role:fleet-coder:r1"], {
    __raw: true,
    role_version: FROZEN_VERSIONS["fleet-coder"],
    role_contract: "CONTRACT: fleet-v2",
    status: "ok",
    reason: "done",
  });
  delete c.added_symbols;
  s["role:fleet-coder:r1"] = c;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder contract drift: missing added_symbols/);
});

// ---------------------------------------------------------------- 2.0.2: push / fetch robustness

test("push prompt retries with backoff, reads remote_head through the gh api, keeps non-ff fatal", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out, "infra:push").prompt;
  const inp = inputsOf(p);
  assert.ok(inp.remote_slug, "push gets the remote slug");
  assert.match(p, /5 15 45/);
  assert.match(p, /retry up to 3 times/);
  assert.match(p, /timeout 600000 ms/);
  assert.match(p, /api repos\/<owner>\/<name>\/branches\/<branch> --jq \.commit\.sha/);
  assert.match(p, /gh-personal/);
  assert.match(p, /non-fast-forward[^.]*needs_human/i);
  assert.match(p, /ls-remote/, "ls-remote only as the fallback");
  assert.match(p, /Never --force/);
});

test("workspace prompt retries fetch with backoff and treats only ls-remote exit 2 as absent", async () => {
  const out = await run(happy(), ARGS);
  const ws = out.calls.concat(out.build ? out.build.calls : []).find((c) => /^(infra:)?workspace$/.test(c.label));
  assert.ok(ws, "workspace call");
  assert.match(ws.prompt, /fetch origin --prune[^\n]*5 15 45/);
  assert.match(ws.prompt, /exit code 2/);
});

test("the script still compares the gh-api remote_head to the approved sha", async () => {
  const s = happy({ script: { "infra:push": { status: "ok", reason: "x", remote_head: "deadbeef" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /deadbeef, not the approved K1/);
});

// ---------------------------------------------------------------- 2.0.2: bytecode poisoning

test("a bytecode purge runs before every hasher check and every code-judge, in that order", async () => {
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_code", routed_findings: [{ target: "code", criterion: "AC1", finding: "x" }] },
      "role:fleet-coder:r2": { status: "ok", commits: ["k2"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const L = out.build.labels;
  for (const m of [1, 2]) {
    const iCoder = L.indexOf("role:fleet-coder:r" + m);
    const iPurge = L.indexOf("infra:purge-bytecode:code-r" + m);
    const iHash = L.indexOf("hasher:post-coder:r" + m);
    const iJudge = L.indexOf("role:fleet-code-judge:r" + m);
    assert.ok(iCoder >= 0 && iCoder < iPurge && iPurge < iHash && iHash < iJudge, "round " + m + ": " + L.join(", "));
  }
  const iFp = L.indexOf("infra:purge-bytecode:freeze-f1");
  assert.ok(iFp >= 0 && iFp < L.indexOf("hasher:freeze:f1"), "purge before the freeze hasher");
  const p = call(out, "infra:purge-bytecode:code-r1").prompt;
  assert.ok(inputsOf(p).worktree, "purge names the worktree");
  assert.match(p, /__pycache__/);
  assert.match(p, /\.pytest_cache/);
  assert.match(p, /purged/);
});

test("a failed bytecode purge stops the run before the code-judge", async () => {
  const s = happy({ script: { "infra:purge-bytecode:code-r1": { status: "failed", reason: "rm failed" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

test("the purge command deletes bytecode and pytest caches, sparing venvs and .git", () => {
  const out0 = (async () => run(happy(), ARGS))();
  return out0.then((out) => {
    const p = call(out, "infra:purge-bytecode:code-r1").prompt;
    const m = /^PURGE: (.*)$/m.exec(p);
    assert.ok(m, "prompt carries a PURGE: command line");
    const wt = mkdtempSync(join(tmpdir(), "fleet-purge-"));
    try {
      for (const d of ["a/__pycache__", ".pytest_cache/v", "b", ".venv/lib/__pycache__", ".git/x", "venv/__pycache__"])
        sh(wt, "mkdir", "-p", d);
      for (const f of ["a/__pycache__/m.cpython-313.pyc", "b/old.pyc", "b/old.pyo", ".pytest_cache/v/x", ".venv/lib/__pycache__/k.pyc", ".git/x/y.pyc", "venv/__pycache__/z.pyc", "b/keep.py"])
        writeFileSync(join(wt, f), "x");
      const r = spawnSync("bash", ["-c", m[1].split("<worktree>").join(shq(wt))], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /purged=4\b/);
      const left = sh(wt, "find", ".", "-type", "f").split("\n").filter(Boolean).sort();
      assert.deepEqual(left, ["./.git/x/y.pyc", "./.venv/lib/__pycache__/k.pyc", "./b/keep.py", "./venv/__pycache__/z.pyc"]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

function shq(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

test("code-judge and coder get test_env; the coder gets it as a note for frozen-test runs", async () => {
  const out = await run(happy(), ARGS);
  const want = { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" };
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).test_env, want);
  const c = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  assert.deepEqual(c.test_env, want);
  assert.match(c.test_env_note, /frozen/);
});

test("hasher 2.0.2: a planted pyc for a frozen test is suspicious and rejects the round", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-pyc-", "__pycache__/\n");
  try {
    writeFileSync(join(wt, "tests", "test_frozen.py"), "def test_f():\n    assert False\n");
    const a = runHasherRaw(wt, "hashes", ["tests/test_frozen.py"]);
    assert.deepEqual(a.hashes.suspicious, []);
    sh(wt, "mkdir", "-p", "tests/__pycache__");
    writeFileSync(join(wt, "tests", "__pycache__", "test_frozen.cpython-313.pyc"), "poison");
    const b = runHasherRaw(wt, "hashes", ["tests/test_frozen.py"]);
    assert.ok(b.hashes.suspicious.some((x) => x.includes("tests/__pycache__/test_frozen.cpython-313.pyc")), JSON.stringify(b.hashes.suspicious));
    assert.equal(hasherMismatch(a, b), true);
    // pytest's assertion-rewrite name and a pyc in a NOT-ignored cache dir are caught too
    rmSync(join(wt, "tests", "__pycache__"), { recursive: true });
    writeFileSync(join(wt, ".gitignore"), "*.log\n");
    sh(wt, "mkdir", "-p", "tests/__pycache__");
    writeFileSync(join(wt, "tests", "__pycache__", "test_frozen.cpython-313-pytest-8.3.4.pyc"), "poison");
    const c = runHasherRaw(wt, "hashes", ["tests/test_frozen.py"]);
    assert.ok(c.hashes.suspicious.some((x) => x.includes("test_frozen.cpython-313-pytest-8.3.4.pyc")), JSON.stringify(c.hashes.suspicious));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hasher 2.0.2: pyc files unrelated to frozen tests are no violation", { skip: !HAVE_PY }, () => {
  const wt = cacheRepo("fleet-202-pycok-", "__pycache__/\n");
  try {
    writeFileSync(join(wt, "tests", "test_frozen.py"), "def test_f():\n    pass\n");
    const a = runHasherRaw(wt, "hashes", ["tests/test_frozen.py"]);
    sh(wt, "mkdir", "-p", "src/__pycache__");
    writeFileSync(join(wt, "src", "__pycache__", "mod.cpython-313.pyc"), "x");
    writeFileSync(join(wt, "src", "__pycache__", "test_frozen_helpers.cpython-313.pyc"), "x");
    const b = runHasherRaw(wt, "hashes", ["tests/test_frozen.py"]);
    assert.deepEqual(b.hashes.suspicious, []);
    assert.equal(hasherMismatch(a, b), false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a stale-bytecode suspicious entry after the coder rejects the round", async () => {
  const s = happy({
    script: {
      "hasher:post-coder:r1": {
        status: "ok",
        fingerprint: FP_K1,
        hashes: H(HASHES_FLAT, ["bytecode for a frozen file: tests/__pycache__/test_a.cpython-313.pyc"]),
      },
    },
  });
  const out = await run(s, ARGS);
  assert.ok(out.logs.some((l) => /hash violation on suspicious bytecode for a frozen file/.test(l)), out.logs.join("\n"));
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

test("role versions: coder 10 and code-judge 9 are the minimums; coder v9 stops", async () => {
  const s = happy();
  s.preflight.versions["fleet-coder"] = 9;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder version 9 < frozen 10/);
  const j = happy();
  j.preflight.versions["fleet-code-judge"] = 8;
  const outJ = await runOne(j, ARGS);
  assert.match(outJ.result.reason, /role fleet-code-judge version 8 < frozen 9/);
});

// ---------------------------------------------------------------- 2.0.3: repo obligations, test_cmd, honest stop reasons

const TEST_CMD = { command: "uv run --extra test pytest <paths> -n0", paths_placeholder: "<paths>", env: {}, tools: ["mypy"] };
const OB_BUMP = {
  id: "OB1",
  kind: "version_bump",
  rule_source: "scripts/check_version_bump.py:1",
  files: ["pyproject.toml", "server.json"],
  instruction: "bump the core version in pyproject.toml and its mirrors",
  check_cmd: "python3 scripts/check_version_bump.py",
};
const OB_LOG = {
  id: "OB2",
  kind: "changelog",
  rule_source: ".pre-commit-config.yaml:check-changelog",
  files: ["CHANGELOG.md"],
  instruction: "add a CHANGELOG line",
};

// A happy run whose planner returns obligations and a test_cmd.
function withObligations(obs, over) {
  const s = happy(over);
  s["role:scope-and-plan"].repo_obligations = obs;
  s["role:scope-and-plan"].test_cmd = TEST_CMD;
  s["role:fleet-code-judge:r1"].obligations_check = obs.map((o) => ({ id: o.id, met: true, evidence: "diff" }));
  s["infra:verify-commands"] = verifyAll({});
  return s;
}

// Plan-mode verify step stub: every ref passes unless named in fail.
function verifyAll(fail, files) {
  files = files || {};
  return (prompt) => {
    const i = inputsOf(prompt);
    const checks = {};
    for (const r of i.refs)
      checks[r.id] = fail[r.id]
        ? { ok: false, reason: fail[r.id], files: [] }
        : { ok: true, reason: "ok", files: files[r.id] || [r.kind === "file" ? r.name : r.kind === "hook" ? ".pre-commit-config.yaml" : "Makefile"] };
    return { status: "ok", reason: "verified", checks };
  };
}

// Build-mode obligations step result; prechecks pass unless overridden.
function obResults(results, prechecks, sandbox) {
  const pc = { OB1: { ok: true, reason: "ok" }, OB2: { ok: true, reason: "ok" } };
  for (const r of results) if (r && r.id) pc[r.id] = { ok: true, reason: "ok" };
  return {
    status: "ok",
    reason: "ran",
    prechecks: Object.assign(pc, prechecks || {}),
    sandbox: sandbox === undefined ? "unshare" : sandbox,
    results,
  };
}

test("2.0.3 plan_ref: plan_facts carries test_cmd and repo_obligations, covered by the seal", async () => {
  const s = withObligations([OB_BUMP, OB_LOG]);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation");
  const ref = JSON.parse(s.__store[PC]);
  assert.deepEqual(ref.plan_facts.test_cmd, TEST_CMD);
  assert.deepEqual(ref.plan_facts.repo_obligations, [Object.assign({}, OB_BUMP, { check_files: ["scripts/check_version_bump.py"] }), OB_LOG]);
  const o = Object.assign({}, ref);
  delete o.seal;
  assert.equal(ref.seal, sha256(canon(o)));
});

test("2.0.3 scope-and-plan: repo_obligations and test_cmd are required on ok", async () => {
  for (const k of ["repo_obligations", "test_cmd"]) {
    const s = happy();
    const p = Object.assign({}, REQUIRED_DEFAULTS["scope-and-plan"], s["role:scope-and-plan"], {
      __raw: true,
      role_version: FROZEN_VERSIONS["scope-and-plan"],
      role_contract: "CONTRACT: fleet-v2",
    });
    delete p[k];
    s["role:scope-and-plan"] = p;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", k);
    assert.match(out.result.reason, new RegExp("role scope-and-plan contract drift: missing " + k));
    assert.equal(out.result.stop_gate, "contract");
    assert.ok(!out.labels.includes("role:plan-audit"));
  }
});

test("2.0.3 scope-and-plan: wrong types for repo_obligations or test_cmd are contract drift", async () => {
  for (const [k, v, re] of [
    ["repo_obligations", "[]", /contract drift: scope-and-plan repo_obligations type/],
    ["test_cmd", "pytest", /contract drift: scope-and-plan test_cmd type/],
    ["test_cmd", { paths_placeholder: "<paths>" }, /contract drift: scope-and-plan test_cmd\.command/],
    ["test_cmd", { command: "  " }, /contract drift: scope-and-plan test_cmd\.command/],
    ["repo_obligations", [{ id: "OB1", kind: "bogus", instruction: "x" }], /contract drift: scope-and-plan repo_obligations/],
    ["repo_obligations", [{ kind: "other", instruction: "x" }], /contract drift: scope-and-plan repo_obligations/],
    ["repo_obligations", [OB_LOG, OB_LOG], /contract drift: scope-and-plan repo_obligations/],
  ]) {
    const s = happy();
    s["role:scope-and-plan"][k] = v;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", k + " " + JSON.stringify(v));
    assert.match(out.result.reason, re);
    assert.equal(out.result.stop_gate, "contract");
  }
});

test("2.0.3 allowlist: a check_cmd outside the allowed shapes becomes judge-only, never run", async () => {
  for (const cmd of [
    "git push origin HEAD",
    "g''it push",
    "python -c print(1)",
    "python3 -c x",
    "bash scripts/x.sh",
    "scripts/x.sh $(id)",
    "make check; rm -rf x",
    "make check && echo",
    "make check | tee x",
    "scripts/x.sh `id`",
    "scripts/x.sh > out",
    "/usr/bin/check",
    "../outside/check.py",
    "python3 ../x.py",
    "pytest",
    "pre-commit run",
    "pre-commit run x --hook-stage",
    "pre-commit run x --from-ref a",
    "pre-commit install",
    "make",
    "make a b",
    "uv run pytest",
    "uv run --extra test python3 scripts/x.sh",
    "make check\nscripts/x.sh",
    "scripts/x.sh 'a b'",
    "terraform plan",
    "make check-tofu",
    "scripts/run-tfp.sh",
    "pre-commit run digger-lint --all-files",
    "make Atlantis",
  ]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(cmd) + " " + out.result.reason);
    assert.ok(!out.labels.includes("infra:verify-commands"), cmd);
    const ob = JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0];
    assert.ok(!("check_cmd" in ob), cmd);
    assert.equal(ob.check_cmd_rejected, cmd);
    assert.equal(typeof ob.check_rejected_reason, "string");
    assert.ok(out.logs.some((l) => /OB1 check_cmd not auto-run \(judge-only\)/.test(l)), cmd);
    assert.deepEqual(inputsOf(call(out, "role:plan-audit").prompt).repo_obligations[0].check_cmd_rejected, cmd);
  }
});

test("2.0.3 allowlist: the allowed shapes go to the read-only verify step with their reference", async () => {
  for (const [cmd, ref] of [
    ["pre-commit run check-changelog", { kind: "hook", name: "check-changelog" }],
    ["pre-commit run check-versions --all-files --hook-stage pre-push --from-ref origin/master --to-ref HEAD", { kind: "hook", name: "check-versions" }],
    ["make check", { kind: "make", name: "check" }],
    ["python3 scripts/check_version_bump.py", { kind: "file", name: "scripts/check_version_bump.py" }],
    ["python scripts/c.py --base origin/master", { kind: "file", name: "scripts/c.py" }],
    ["uv run python3 scripts/c.py", { kind: "file", name: "scripts/c.py" }],
    ["uv run --extra test python scripts/c.py -q", { kind: "file", name: "scripts/c.py" }],
    ["scripts/check.sh", { kind: "file", name: "scripts/check.sh" }],
    ["./scripts/check.sh --strict", { kind: "file", name: "scripts/check.sh" }],
    ["./check.sh", { kind: "file", name: "check.sh" }],
  ]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", cmd);
    const v = call(out, "infra:verify-commands");
    assert.equal(v.opts.agentType, "fleet:judge");
    const vi = inputsOf(v.prompt);
    assert.deepEqual(vi.refs, [Object.assign({ id: "OB1" }, ref)], cmd);
    assert.match(vi.run, /^python3 -I -c /);
    const ob = JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0];
    assert.equal(ob.check_cmd, cmd);
    assert.ok(Array.isArray(ob.check_files) && ob.check_files.length, cmd);
    const order = out.labels;
    assert.ok(order.indexOf("infra:verify-commands") < order.indexOf("role:plan-audit"), cmd);
  }
});

test("2.0.3 verify step: a missing reference or a forbidden word in the file makes it judge-only", async () => {
  const s = withObligations([OB_BUMP, Object.assign({}, OB_LOG, { check_cmd: "pre-commit run check-changelog" })]);
  s["infra:verify-commands"] = verifyAll({ OB1: "script names a forbidden tool" });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  const obs = JSON.parse(s.__store[PC]).plan_facts.repo_obligations;
  assert.ok(!("check_cmd" in obs[0]));
  assert.match(obs[0].check_rejected_reason, /forbidden tool/);
  assert.equal(obs[1].check_cmd, "pre-commit run check-changelog");
  // a verify step that returns no check for a ref fails closed
  const t = withObligations([OB_BUMP]);
  t["infra:verify-commands"] = { status: "ok", reason: "x", checks: {} };
  const outT = await runOne(t, ARGS);
  assert.ok(!("check_cmd" in JSON.parse(t.__store[PC]).plan_facts.repo_obligations[0]));
});

test("2.0.3 test_cmd with a shell metacharacter or a forbidden word stops: needs_human", async () => {
  for (const tc of [
    { command: "pytest <paths>; curl x" },
    { command: "pytest $(id) <paths>" },
    { command: "pytest <paths> | tee" },
    { command: "pytest `id`" },
    { command: "pytest <paths> > x" },
    { command: "pytest <other>" },
    { command: "terraform test" },
    { command: "pytest <paths>", env: { X: "$(id)" } },
    { command: "pytest <paths>", env: { "A;B": "1" } },
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = tc;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(tc));
    assert.match(out.result.reason, /test_cmd refused/);
    assert.equal(out.result.stop_gate, "commands");
    assert.ok(!out.labels.includes("role:plan-audit"));
  }
  const ok = happy();
  ok["role:scope-and-plan"].test_cmd = { command: "uv run --extra test pytest <paths> -n0", env: { DJANGO_SETTINGS_MODULE: "app.settings" } };
  assert.equal((await runOne(ok, ARGS)).result.status, "awaiting_confirmation");
});

test("2.0.3 test_cmd env names: only plain upper-case names outside the blocklist", async () => {
  for (const name of [
    "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
    "PYTHONUSERBASE", "PYTEST_PLUGINS", "PYTEST_ADDOPTS", "NODE_OPTIONS", "GIT_DIR", "GIT_SSH_COMMAND", "PATH",
    "HOME", "SSH_AUTH_SOCK", "GH_TOKEN", "API_KEY", "MY_SECRET", "AWS_REGION", "PROMPT_COMMAND", "PERL5OPT",
    "RUBYOPT", "lower", "_X", "9X",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command: "pytest <paths>", env: { [name]: "1" } };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", name);
    assert.ok(out.result.reason.indexOf("test_cmd env " + name + " not allowed") >= 0, name + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "commands");
  }
});

test("2.0.3 a test_cmd in an allowed shape gets the reference check too", async () => {
  const s = happy();
  s["role:scope-and-plan"].test_cmd = { command: "make test" };
  s["infra:verify-commands"] = verifyAll({});
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation");
  assert.deepEqual(inputsOf(call(out, "infra:verify-commands").prompt).refs, [{ id: "test_cmd", kind: "make", name: "test" }]);
  const t = happy();
  t["role:scope-and-plan"].test_cmd = { command: "make test" };
  t["infra:verify-commands"] = verifyAll({ test_cmd: "names a forbidden tool" });
  const outT = await runOne(t, ARGS);
  assert.equal(outT.result.status, "needs_human");
  assert.match(outT.result.reason, /test_cmd refused: reference check failed: names a forbidden tool/);
  assert.equal(outT.result.stop_gate, "commands");
  assert.ok(!outT.labels.includes("role:plan-audit"));
});

test("2.0.3 a check whose files the change edits becomes judge-only", async () => {
  for (const [obs, aa] of [
    [[OB_BUMP, Object.assign({}, OB_LOG, { files: ["scripts/check_version_bump.py"] })], null],
    [[OB_BUMP], { files: ["scripts/helper.py"], symbols: [], deps: [], settings: [] }],
  ]) {
    const s = withObligations(obs);
    s["infra:verify-commands"] = verifyAll({}, { OB1: ["scripts/check_version_bump.py", "scripts/helper.py"] });
    if (aa) s["role:scope-and-plan"].allowed_additions = aa;
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    const ob = JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0];
    assert.ok(!("check_cmd" in ob));
    assert.match(ob.check_rejected_reason, /the change edits a file its check reads: scripts\/(check_version_bump|helper)\.py/);
  }
});

test("2.0.3 check files are frozen at freeze and re-checked after the coder", async () => {
  const s = withObligations([OB_BUMP]);
  s["infra:verify-commands"] = verifyAll({}, { OB1: ["scripts/check_version_bump.py", "scripts/lib.py"] });
  s["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }]);
  s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
  const out = await run(s, ARGS);
  noUnscripted(out);
  for (const l of ["hasher:freeze:f1", "hasher:post-coder:r1"]) {
    const tf = inputsOf(call(out, l).prompt).test_files;
    assert.ok(tf.includes("scripts/check_version_bump.py") && tf.includes("scripts/lib.py"), l);
  }
  // frozen for the coder too, as read-only config, never as a frozen test
  const ci = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  assert.ok(!("scripts/lib.py" in ci.frozen_tests));
});

test("2.0.3 awaiting_confirmation lists every command verbatim with its rule_source; sealed in plan_facts", async () => {
  const s = withObligations([OB_BUMP, Object.assign({}, OB_LOG, { check_cmd: "python -c x" })]);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  const cmds = out.result.commands;
  assert.deepEqual(cmds.map((c) => c.command), [TEST_CMD.command, OB_BUMP.check_cmd, "python -c x"]);
  assert.deepEqual(cmds.map((c) => c.rule_source), ["test_cmd", OB_BUMP.rule_source, OB_LOG.rule_source]);
  assert.deepEqual(cmds.map((c) => c.run_by), ["roles", "workflow", "nobody"]);
  assert.deepEqual(cmds[0].env, {});
  assert.deepEqual(cmds[0].tools, ["mypy"]);
  assert.equal(cmds[1].exec, "python3 -I scripts/check_version_bump.py");
  assert.deepEqual(cmds[1].env, { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" });
  assert.deepEqual(cmds[1].check_files, ["scripts/check_version_bump.py"]);
  assert.deepEqual(JSON.parse(s.__store[PC]).plan_facts.commands, cmds);
  // uv run never resolves or installs: --frozen --no-sync is added
  const u = withObligations([Object.assign({}, OB_BUMP, { check_cmd: "uv run --extra test python scripts/c.py -q" })]);
  const outU = await runOne(u, ARGS);
  assert.equal(outU.result.commands[1].exec, "uv run --frozen --no-sync --extra test python -I scripts/c.py -q");
});

test("2.0.3 build from a 2.0.2 plan_ref stops: plan_ref predates 2.0.3", async () => {
  const s = happy();
  const content = priorRef(PLAN_MD);
  s.__store[PC] = content;
  const out = await runOne(s, {
    mode: "build",
    plan_ref: { branch: "fleet/l42-add-thing", plan_commit: PC, ref_path: REF_L42, ref_sha256: sha256(content), repo: "/r" },
    date: "2026-11-04",
    project: "o/r",
  });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan_ref predates 2\.0\.3; re-run plan/);
  assert.ok(!out.labels.includes("infra:verify-plan"));
});

test("2.0.3 inputs: plan-audit, coder and code-judge get repo_obligations and test_cmd; writers and test-judge get test_cmd", async () => {
  const s = withObligations([OB_LOG]);
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:plan-audit", "role:fleet-coder:r1", "role:fleet-code-judge:r1"]) {
    const i = inputsOf(call(out, l).prompt);
    assert.deepEqual(i.repo_obligations, [OB_LOG], l);
    assert.deepEqual(i.test_cmd, TEST_CMD, l);
  }
  for (const l of ["role:fleet-test-writer:AC1:r1", "role:fleet-test-judge:r1"])
    assert.deepEqual(inputsOf(call(out, l).prompt).test_cmd, TEST_CMD, l);
  // no obligation has a check_cmd: no obligations step
  assert.ok(!out.labels.some((l) => /^infra:obligations/.test(l)));
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).obligation_results, []);
});

test("2.0.3 obligations step runs check_cmd read-only between hasher and code-judge, fingerprinted", async () => {
  const s = withObligations([OB_BUMP, OB_LOG]);
  s["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }]);
  s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const ob = call(out, "infra:obligations:r1");
  assert.equal(ob.opts.agentType, "fleet:judge");
  const oi = inputsOf(ob.prompt);
  assert.deepEqual(oi.obligations.map((o) => o.id), ["OB1"]);
  const wt = "/r/.claude/worktrees/fleet-l42-add-thing/main";
  const sc = "/r/.claude/worktrees/fleet-l42-add-thing/scratch/obligations";
  const envs =
    "env -i HOME='" + sc + "/home' PATH=\"$PATH\" XDG_CACHE_HOME='" + sc + "/cache' UV_CACHE_DIR='" + sc + "/cache/uv' " +
    "PIP_CACHE_DIR='" + sc + "/cache/pip' LANG='C.UTF-8' GIT_CONFIG_GLOBAL='/dev/null' " +
    "GIT_CONFIG_NOSYSTEM='1' GIT_TERMINAL_PROMPT='0' PYTEST_ADDOPTS='-p no:cacheprovider' PYTHONDONTWRITEBYTECODE='1'";
  const argv = " timeout 300 python3 -I scripts/check_version_bump.py";
  assert.equal(oi.obligations[0].run_unshare, "cd '" + wt + "' && mkdir -p '" + sc + "/home' '" + sc + "/cache' && unshare -rn " + envs + argv);
  assert.match(oi.obligations[0].run_bwrap, /^cd '[^']+' && mkdir -p .* && bwrap --die-with-parent --unshare-net --dev-bind \/ \/ --tmpfs "\$HOME" --bind '/);
  assert.ok(oi.obligations[0].run_bwrap.endsWith(" -- " + envs + argv));
  assert.match(oi.obligations[0].run_bwrap, /--ro-bind "\$\(git -C '[^']+' rev-parse --path-format=absolute --git-common-dir\)"/);
  assert.ok(!("run" in oi.obligations[0]), "no unsandboxed variant is ever handed out");
  for (const r of [oi.obligations[0].run_unshare, oi.obligations[0].run_bwrap]) assert.doesNotMatch(r, /bash -c|SSH_AUTH_SOCK|GH_TOKEN|\.cache"/);
  assert.match(oi.precheck, /^python3 -I -c /);
  assert.deepEqual(oi.refs, [{ id: "OB1", kind: "file", name: "scripts/check_version_bump.py" }]);
  assert.equal(oi.plan_commit, PC);
  const order = out.labels;
  assert.ok(order.indexOf("hasher:post-coder:r1") < order.indexOf("infra:obligations:r1"));
  assert.ok(order.indexOf("infra:obligations:r1") < order.indexOf("hasher:fp-post:obligations:r1"));
  assert.ok(order.indexOf("hasher:fp-post:obligations:r1") < order.indexOf("role:fleet-code-judge:r1"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).obligation_results, [{ id: "OB1", exit_code: 0, tail: "ok" }]);
});

test("2.0.3 an obligations step that changes the worktree stops: fingerprint gate", async () => {
  const s = withObligations([OB_BUMP]);
  s["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }]);
  s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: { head: "K1", status_sha256: "DIRTY", diff_sha256: "d" } };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /obligation check changed the worktree/);
  assert.equal(out.result.stop_gate, "fingerprint");
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

// Scripts a second code round that passes, after a first round whose
// approval the obligations gate converts.
function secondRoundPasses(s, check) {
  s["role:fleet-coder:r2"] = { status: "ok", commits: ["k2"] };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2, hashes: HASHES };
  s["infra:obligations:r2"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }]);
  s["hasher:fp-post:obligations:r2"] = { status: "ok", fingerprint: FP_K2 };
  s["role:fleet-code-judge:r2"] = { status: "ok", verdict: "approve", routed_findings: [], obligations_check: check };
  s["hasher:fp-post:code-judge:r2"] = { status: "ok", fingerprint: FP_K2 };
}

test("2.0.3 approve with a failing check_cmd is converted to fix_code and counts as a code round", async () => {
  const s = withObligations([OB_BUMP]);
  s["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 1, tail: "version not bumped" }]);
  s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
  secondRoundPasses(s, [{ id: "OB1", met: true, evidence: "ok" }]);
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 2);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "code");
  assert.match(f[0].finding, /OB1/);
  assert.match(f[0].finding, /version not bumped/);
  assert.ok(out.logs.some((l) => /obligations gate/.test(l)), out.logs.join("\n"));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, "K2");
});

test("2.0.3 approve without met:true for every obligation is converted to fix_code", async () => {
  for (const check of [[], [{ id: "OB1", met: true, evidence: "x" }], [{ id: "OB1", met: true }, { id: "OB2", met: false, evidence: "no line" }]]) {
    const s = withObligations([OB_BUMP, OB_LOG]);
    s["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }]);
    s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
    s["role:fleet-code-judge:r1"].obligations_check = check;
    secondRoundPasses(s, [{ id: "OB1", met: true, evidence: "ok" }, { id: "OB2", met: true, evidence: "ok" }]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", JSON.stringify(check) + " " + out.result.reason);
    assert.equal(out.result.rounds.code, 2, JSON.stringify(check));
    assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding).join("\n"), /OB2/);
  }
});

test("2.0.3 a check_cmd obligation with no result or a non-integer exit code is unmet (fail closed)", async () => {
  for (const results of [[], [{ id: "OB1", exit_code: "0", tail: "" }], [{ id: "OB9", exit_code: 0, tail: "" }]]) {
    const s = withObligations([OB_BUMP]);
    s["infra:obligations:r1"] = obResults(results);
    s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
    secondRoundPasses(s, [{ id: "OB1", met: true, evidence: "ok" }]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.rounds.code, 2, JSON.stringify(results));
    const r1 = inputsOf(call(out, "role:fleet-code-judge:r1").prompt).obligation_results;
    assert.equal(r1.length, 1);
    assert.equal(r1[0].id, "OB1");
  }
});

test("2.0.3 obligations gate failing every round stops at the cap with the gate named", async () => {
  const s = withObligations([OB_BUMP]);
  for (const m of [1, 2, 3]) {
    const fp = { head: "K" + m, status_sha256: "s", diff_sha256: "d" };
    s["role:fleet-coder:r" + m] = { status: "ok", commits: ["k" + m] };
    s["hasher:post-coder:r" + m] = { status: "ok", fingerprint: fp, hashes: HASHES };
    s["infra:obligations:r" + m] = obResults([{ id: "OB1", exit_code: 2, tail: "nope" }]);
    s["hasher:fp-post:obligations:r" + m] = { status: "ok", fingerprint: fp };
    s["role:fleet-code-judge:r" + m] = { status: "ok", verdict: "approve", routed_findings: [], obligations_check: [{ id: "OB1", met: true, evidence: "x" }] };
    s["hasher:fp-post:code-judge:r" + m] = { status: "ok", fingerprint: fp };
  }
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /code rounds exhausted \(3\)/);
  assert.match(out.result.reason, /obligations/);
  assert.equal(out.result.stop_gate, "cap");
});

test("2.0.3 coder and code-judge: obligations_done and obligations_check are required arrays", async () => {
  for (const [label, role, key] of [
    ["role:fleet-coder:r1", "fleet-coder", "obligations_done"],
    ["role:fleet-code-judge:r1", "fleet-code-judge", "obligations_check"],
  ]) {
    const s = happy();
    const r = Object.assign({}, REQUIRED_DEFAULTS[role], s[label], {
      __raw: true,
      role_version: FROZEN_VERSIONS[role],
      role_contract: "CONTRACT: fleet-v2",
    });
    delete r[key];
    s[label] = r;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", key);
    assert.match(out.result.reason, new RegExp("role " + role + " contract drift: missing " + key));
    const t = happy();
    t[label][key] = "[]";
    const outT = await run(t, ARGS);
    assert.match(outT.result.reason, new RegExp("contract drift: " + role + " " + key + " type"));
  }
});

test("2.0.3 B3: a coder output missing a key AND a hash violation reports the hash violation", async () => {
  const s = happy();
  const c = Object.assign({}, REQUIRED_DEFAULTS["fleet-coder"], s["role:fleet-coder:r1"], {
    __raw: true,
    role_version: FROZEN_VERSIONS["fleet-coder"],
    role_contract: "CONTRACT: fleet-v2",
  });
  delete c.added_symbols;
  s["role:fleet-coder:r1"] = c;
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: H({ ...HASHES_FLAT, "tests/test_a.py": "TAMPERED" }) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^code round 1: hash violation on .*tests\/test_a\.py/);
  assert.doesNotMatch(out.result.reason.split("(role output also")[0], /contract drift/);
  assert.equal(out.result.stop_gate, "hash");
  assert.ok(!out.labels.includes("role:fleet-coder:r2"), "no re-dispatch after a malformed output");
});

test("2.0.3 B3: a coder needs_human with a hash violation reports the hash violation", async () => {
  const s = happy();
  s["role:fleet-coder:r1"] = { status: "needs_human", reason: "a tool rewrote .gitignore" };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: H({ ...HASHES_FLAT, "tests/test_b.py": "X" }) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^code round 1: hash violation on .*tests\/test_b\.py/);
  assert.match(out.result.reason, /a tool rewrote \.gitignore/);
  assert.equal(out.result.stop_gate, "hash");
});

test("2.0.3 B3: a clean coder needs_human reports the role's reason; contract drift alone is contract", async () => {
  const s = happy();
  s["role:fleet-coder:r1"] = { status: "needs_human", reason: "test AC1 contradicts the plan" };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /test AC1 contradicts the plan/);
  assert.equal(out.result.stop_gate, "role");
  const t = happy();
  t["role:fleet-coder:r1"].added_symbols = "[]";
  const outT = await run(t, ARGS);
  assert.equal(outT.result.stop_gate, "contract");
});

test("2.0.3 B3: a role's needs_human beats a version mismatch (contract drift is last)", async () => {
  const s = happy();
  s["role:fleet-code-judge:r1"] = { status: "needs_human", reason: "suite cannot run", role_version: 1 };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /suite cannot run/);
  assert.equal(out.result.stop_gate, "role");
});

test("2.0.3 B3: a judge that mutates the worktree and drifts reports the fingerprint", async () => {
  const s = happy();
  s["role:fleet-code-judge:r1"].hash_check = "{}";
  s["hasher:fp-post:code-judge:r1"] = { status: "ok", fingerprint: { head: "K1", status_sha256: "CHANGED", diff_sha256: "d" } };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^judge mutated worktree/);
  assert.equal(out.result.stop_gate, "fingerprint");
});

test("2.0.3 stop_gate: null on ok and awaiting; fingerprint at freeze", async () => {
  const ok = await run(happy(), ARGS);
  assert.equal(ok.result.status, "ok");
  assert.equal(ok.result.stop_gate, null);
  assert.equal(ok.planResult.stop_gate, null);
  const s = happy({ script: { "hasher:freeze:f1": { status: "ok", fingerprint: { head: "P9", status_sha256: "s", diff_sha256: "d" }, hashes: HASHES } } });
  const out = await run(s, ARGS);
  assert.match(out.result.reason, /worktree changed between test approval and freeze/);
  assert.equal(out.result.stop_gate, "fingerprint");
});

test("2.0.3 obligations step: a refused precheck is never a pass, whatever the agent reports", async () => {
  const s = withObligations([OB_BUMP]);
  s["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }], {
    OB1: { ok: false, reason: "scripts/check_version_bump.py changed since the approved plan" },
  });
  s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
  secondRoundPasses(s, [{ id: "OB1", met: true, evidence: "ok" }]);
  const out = await run(s, ARGS);
  noUnscripted(out);
  const r1 = inputsOf(call(out, "role:fleet-code-judge:r1").prompt).obligation_results;
  assert.equal(r1[0].exit_code, null);
  assert.match(r1[0].tail, /refused by precheck: .*changed since the approved plan/);
  assert.equal(out.result.rounds.code, 2);
  // a missing precheck entry fails closed too
  const t = withObligations([OB_BUMP]);
  const res = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }]);
  res.prechecks = {};
  t["infra:obligations:r1"] = res;
  t["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
  secondRoundPasses(t, [{ id: "OB1", met: true, evidence: "ok" }]);
  const outT = await run(t, ARGS);
  assert.equal(inputsOf(call(outT, "role:fleet-code-judge:r1").prompt).obligation_results[0].exit_code, null);
});

test("2.0.3 obligations step: no sandbox means the checks do not count (fail closed, judge-only)", async () => {
  for (const sb of ["none", undefined, "plain"]) {
    const s = withObligations([OB_BUMP]);
    const res = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }], null, sb === undefined ? "none" : sb);
    if (sb === undefined) delete res.sandbox;
    s["infra:obligations:r1"] = res;
    s["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", String(sb) + " " + out.result.reason);
    const ji = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
    assert.deepEqual(ji.obligation_results, { status: "not_run", reason: "network isolation unavailable" });
    assert.ok(!("check_cmd" in ji.repo_obligations[0]));
    assert.equal(ji.repo_obligations[0].check_cmd_rejected, OB_BUMP.check_cmd);
    assert.ok(out.result.gates_not_run.some((g) => g.gate === "obligation_checks" && /network isolation unavailable/.test(g.reason)));
    assert.ok(inputsOf(call(out, "role:fleet-pr-opener").prompt).gates_not_run.some((g) => g.gate === "obligation_checks"));
  }
  const b = withObligations([OB_BUMP]);
  b["infra:obligations:r1"] = obResults([{ id: "OB1", exit_code: 0, tail: "ok" }], null, "bwrap");
  b["hasher:fp-post:obligations:r1"] = { status: "ok", fingerprint: FP_K1 };
  const outB = await run(b, ARGS);
  assert.deepEqual(inputsOf(call(outB, "role:fleet-code-judge:r1").prompt).obligation_results, [{ id: "OB1", exit_code: 0, tail: "ok" }]);
  assert.ok(outB.logs.some((l) => /sandbox bwrap/.test(l)));
});

// A 2.0.3-shaped ref file for build-mode tests.
function refWithFacts(facts) {
  return priorRef(PLAN_MD, {
    plan_facts: Object.assign({ allowed_additions: null, est_diff_lines: 10, test_cmd: TEST_CMD, repo_obligations: [], commands: [] }, facts),
  });
}

async function buildFrom(content) {
  const s = happy();
  s.__store[PC] = content;
  return runOne(s, {
    mode: "build",
    plan_ref: { branch: "fleet/l42-add-thing", plan_commit: PC, ref_path: REF_L42, ref_sha256: sha256(content), repo: "/r" },
    date: "2026-11-04",
    project: "o/r",
  });
}

test("2.0.3 build re-checks the sealed commands: a disallowed check_cmd or test_cmd stops", async () => {
  const bad = await buildFrom(refWithFacts({ repo_obligations: [Object.assign({}, OB_BUMP, { check_cmd: "python -c x" })] }));
  assert.equal(bad.result.status, "needs_human");
  assert.match(bad.result.reason, /OB1 check_cmd/);
  assert.equal(bad.result.stop_gate, "commands");
  assert.ok(!bad.labels.includes("infra:verify-plan"));
  const noFiles = await buildFrom(refWithFacts({ repo_obligations: [OB_BUMP] }));
  assert.match(noFiles.result.reason, /OB1 check_cmd refused: no check_files/);
  const badEnv = await buildFrom(refWithFacts({ test_cmd: { command: "pytest <paths>", env: { LD_PRELOAD: "x" } } }));
  assert.match(badEnv.result.reason, /test_cmd env LD_PRELOAD not allowed/);
  const badT = await buildFrom(refWithFacts({ test_cmd: { command: "pytest; id" } }));
  assert.match(badT.result.reason, /test_cmd refused/);
  const noCmds = await buildFrom(priorRef(PLAN_MD, { plan_facts: { allowed_additions: null, est_diff_lines: 10, test_cmd: TEST_CMD, repo_obligations: [] } }));
  assert.match(noCmds.result.reason, /plan_ref predates 2\.0\.3/);
});

// The reference-check program is embedded in the workflow between markers.
function cmdCheckPy() {
  const m = /CMD_CHECK_PY_BEGIN\n([\s\S]*?)\n\/\/ CMD_CHECK_PY_END/.exec(SOURCE);
  assert.ok(m, "CMD_CHECK_PY markers present");
  return m[1].replace(/^const CMD_CHECK_PY = String\.raw`\n?/, "").replace(/`;?\s*$/, "");
}

function runCmdCheck(wt, rev, refs) {
  const r = spawnSync("python3", ["-I", "-", wt, rev, JSON.stringify(refs)], { input: cmdCheckPy(), encoding: "utf8" });
  if (r.status !== 0) throw new Error("cmd check failed: " + r.stderr);
  return JSON.parse(r.stdout);
}

// A scratch git repo with the given files committed.
function mkRepo(files, links) {
  const wt = mkdtempSync(join(tmpdir(), "fleet-cmdcheck-"));
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@t");
  sh(wt, "git", "config", "user.name", "t");
  for (const [f, c] of Object.entries(files)) {
    sh(wt, "mkdir", "-p", dirname(join(wt, f)));
    writeFileSync(join(wt, f), c);
  }
  for (const [l, target] of Object.entries(links || {})) sh(wt, "ln", "-s", target, l);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "init");
  return wt;
}

const W = ["terra", "form"].join("");

test("command reference program: hooks, make, files, includes, forbidden words, frozen files, changes", { skip: !HAVE_PY }, () => {
  const repos = [];
  try {
    const cfg =
      "repos:\n  - repo: local\n    hooks:\n      - id: check-changelog\n        entry: python3 scripts/ok.py\n        language: system\n" +
      "      - id: bad-hook\n        entry: python3 scripts/bad.py\n        language: system\n" +
      "      - id: dup\n        entry: echo a\n        language: system\n" +
      "  - repo: https://example.com/hooks\n    rev: v1.0.0\n    hooks:\n      - id: dup\n      - id: remote-hook\n";
    const wt = mkRepo(
      {
        ".pre-commit-config.yaml": cfg,
        "scripts/ok.py": "print(1)\n",
        "scripts/other.py": "X = 1\n",
        "scripts/bad.py": "import subprocess\nsubprocess.run(['" + W + "', 'apply'])\n",
        "scripts/run.sh": "#!/bin/sh\n. scripts/lib.sh\n",
        "scripts/lib.sh": W + " apply\n",
        "Makefile": "check: helper\n\tpython3 scripts/ok.py\n\nhelper:\n\techo hi\n",
      },
      { "scripts/link.py": "ok.py" },
    );
    repos.push(wt);
    writeFileSync(join(wt, "scripts/new.py"), "print(2)\n");
    const refs = [
      { id: "H1", kind: "hook", name: "check-changelog" },
      { id: "H2", kind: "hook", name: "bad-hook" },
      { id: "H3", kind: "hook", name: "missing" },
      { id: "H4", kind: "hook", name: "dup" },
      { id: "H5", kind: "hook", name: "remote-hook" },
      { id: "M1", kind: "make", name: "check" },
      { id: "M3", kind: "make", name: "nope" },
      { id: "F1", kind: "file", name: "scripts/ok.py" },
      { id: "F2", kind: "file", name: "scripts/bad.py" },
      { id: "F3", kind: "file", name: "scripts/new.py" },
      { id: "F4", kind: "file", name: "scripts/link.py" },
      { id: "F5", kind: "file", name: "scripts/run.sh" },
    ];
    const out = runCmdCheck(wt, "", refs);
    const ok = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.ok]));
    assert.deepEqual(ok, { H1: true, H2: false, H3: false, H4: false, H5: true, M1: true, M3: false, F1: true, F2: false, F3: false, F4: false, F5: false });
    assert.match(out.H2.reason, /forbidden/);
    assert.match(out.H4.reason, /duplicate hook id/);
    assert.match(out.F3.reason, /not tracked/);
    assert.match(out.F5.reason, /forbidden/, "a sourced helper is scanned");
    assert.deepEqual(out.H1.files, [".pre-commit-config.yaml", "scripts/ok.py"]);
    assert.deepEqual(out.M1.files, ["Makefile", "scripts/ok.py"]);
    // a python script freezes every tracked .py in its directory
    assert.deepEqual(out.F1.files, ["scripts/bad.py", "scripts/link.py", "scripts/ok.py", "scripts/other.py"]);
    // after approval: a changed file, recipe script or repo rev is refused against the plan commit
    writeFileSync(join(wt, "scripts/ok.py"), "print(3)\n");
    writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg.replace("rev: v1.0.0", "rev: v6.6.6"));
    const later = runCmdCheck(wt, "HEAD", [refs[0], refs[4], refs[5], refs[7]]);
    for (const k of ["H1", "H5", "M1", "F1"]) {
      assert.equal(later[k].ok, false, k);
      assert.match(later[k].reason, /changed since/, k);
    }
    // make: prerequisites, variables and included makefiles are scanned
    for (const files of [
      { Makefile: "check: plan\n\techo ok\n\nplan:\n\t" + W + " plan\n" },
      { Makefile: "TF := " + W + "\ncheck:\n\t$(TF) apply\n" },
      { Makefile: "include extra.mk\ncheck:\n\techo ok\n", "extra.mk": "x:\n\t" + W + " apply\n" },
    ]) {
      const m = mkRepo(files);
      repos.push(m);
      const r = runCmdCheck(m, "", [{ id: "M", kind: "make", name: "check" }]);
      assert.equal(r.M.ok, false, JSON.stringify(files));
      assert.match(r.M.reason, /forbidden/);
    }
    const inc = mkRepo({ Makefile: "include extra.mk\ncheck:\n\techo ok\n", "extra.mk": "x:\n\techo y\n" });
    repos.push(inc);
    assert.deepEqual(runCmdCheck(inc, "", [{ id: "M", kind: "make", name: "check" }]).M.files, ["Makefile", "extra.mk"]);
  } finally {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  }
});
