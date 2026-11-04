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
  "scope-and-plan": 9,
  "plan-audit": 8,
  "fleet-test-writer": 3,
  "fleet-test-judge": 3,
  "fleet-coder": 3,
  "fleet-code-judge": 4,
  "fleet-pr-opener": 3,
};

// Keys each role must return on status ok (the frozen fleet-v1 contract).
// The harness fills missing ones with neutral defaults for terse override
// stubs; a stub with __raw: true is returned as written (drift tests).
const REQUIRED_DEFAULTS = {
  "scope-and-plan": { plan_path: "docs/plans/x.md", criteria: [], est_diff_lines: 80, new_behaviour: true, allowed_additions: { files: [], symbols: [], deps: [], settings: [] }, held_out_examples: [] },
  "plan-audit": { verdict: "approve", routed_findings: [] },
  "fleet-test-writer": { criterion_id: "AC1", tests: [], commit: null },
  "fleet-test-judge": { verdict: "approve", routed_findings: [], checked: [] },
  "fleet-coder": { commits: [], suite_result: { command: "pytest", exit_code: 0 }, added_symbols: [], frozen_tests_red_at_start: true },
  "fleet-code-judge": { verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 }, hash_check: { match: true, mismatched: [] }, gates_not_run: [] },
  "fleet-pr-opener": { pr_url: null, pr_number: null, created: true, template_used: null, gates_not_run_stated: true },
};

async function run(script, args) {
  const calls = [];
  const unscripted = [];
  const logs = [];
  const counters = {};
  const agent = async (prompt, opts = {}) => {
    const label = opts.label;
    calls.push({ label, prompt, opts });
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
      if (!("role_contract" in r)) r.role_contract = "CONTRACT: fleet-v1";
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

function call(out, label) {
  const c = out.calls.find((x) => x.label === label);
  assert.ok(c, "expected a call labelled " + label + "; got " + out.labels.join(", "));
  return c;
}

function noUnscripted(out) {
  assert.deepEqual(out.unscripted, [], "unscripted agent labels");
}

const ARGS = {
  task: "L42",
  title: "Add Thing!",
  repo: "/r",
  project: "o/r",
  date: "2026-11-04",
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

function happy(over = {}) {
  const crit = over.criteria || criteria(2);
  const s = {
    preflight: {
      reachable: true,
      missing: [],
      versions: { ...FROZEN_VERSIONS },
      contract: Object.fromEntries(Object.keys(FROZEN_VERSIONS).map((k) => [k, "CONTRACT: fleet-v1"])),
    },
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
      yadgar_findings: ["planner fact"],
    },
    "role:plan-audit": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:prepare": { status: "ok", reason: "ok", head: "P1" },
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
  const out = await run(happy(), JSON.stringify(ARGS));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
});

test("missing repo or date is rejected before any agent", async () => {
  const out = await run({}, { task: "L42" });
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.calls.length, 0);
});

test("branch name derives deterministically from a ledger id and title", async () => {
  const out = await run(happy(), ARGS);
  const ws = inputsOf(call(out, "workspace").prompt);
  assert.equal(ws.branch, "fleet/l42-add-thing");
  assert.equal(ws.main_worktree, "/r/.claude/worktrees/fleet-l42-add-thing/main");
  assert.equal(out.result.branch, "fleet/l42-add-thing");
});

test("branch name derives from a plan path stem", async () => {
  const out = await run(happy(), {
    ...ARGS,
    task: "docs/plans/Foo_Bar-2026-11-04.md",
    title: undefined,
  });
  const ws = inputsOf(call(out, "workspace").prompt);
  assert.equal(ws.branch, "fleet/plan-foo-bar-2026-11-04");
  const plan = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.equal(plan.plan_path, "docs/plans/Foo_Bar-2026-11-04.md");
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
  const roles = r.yadgar_findings.map((y) => y.role);
  assert.ok(roles.includes("scope-and-plan"));
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

test("short path is disabled in v1: a small no-new-behaviour plan still takes the full path", async () => {
  const s = happy();
  s["role:scope-and-plan"].est_diff_lines = 10;
  s["role:scope-and-plan"].new_behaviour = false;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.equal(out.result.path, "full");
  assert.ok(out.labels.includes("role:plan-audit"));
  assert.ok(out.labels.includes("role:fleet-test-writer:AC1:r1"));
  assert.ok(out.logs.some((l) => /short path disabled in v1/.test(l)));
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

test("plan_wrong from the code-judge stops before the PR", async () => {
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
  assert.ok(out.calls.length <= 60, "dispatched " + out.calls.length);
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
  assert.deepEqual(h.test_files.sort(), ["tests/test_a.py", "tests/test_b.py"]);
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
  assert.equal(tj.base_ref, "P1");
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

const NOT_RUN = /^v1: /;

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
  assert.equal(out.result.agents, out.calls.length, "retries count toward the agent cap");
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
    "fleet/l42-add-thing--t-AC1",
    "fleet/l42-add-thing--t-AC2",
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
  s.preflight.versions["fleet-coder"] = 2;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder version 2 < frozen 3/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("S-8: a higher role version is logged as prose-only and recorded", async () => {
  const s = happy();
  s.preflight.versions["fleet-code-judge"] = 6;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(out.result.gate_log.some((l) => /role fleet-code-judge v6 > frozen v4: prose-only changes assumed/.test(l)));
  assert.equal(out.result.role_versions["fleet-code-judge"], 6);
  assert.equal(out.result.role_versions["fleet-coder"], 3);
});

test("S-8: a role runner that loaded a different version than preflight is discarded", async () => {
  const s = happy();
  s["role:fleet-coder:r1"].role_version = 4;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-coder/);
  assert.match(out.result.reason, /version 4/);
  assert.ok(!out.labels.includes("hasher:post-coder:r1"));
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

test("S-6: a ledger-id task without a title is rejected before any agent", async () => {
  const out = await run({}, { ...ARGS, title: undefined });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /title/);
  assert.equal(out.calls.length, 0);
  const blank = await run({}, { ...ARGS, title: "  " });
  assert.equal(blank.result.status, "needs_human");
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
  assert.deepEqual(inputsOf(call(out, "hasher:freeze:f1").prompt).test_files, ["tests/test_a.py"]);
  assert.ok(!inputsOf(call(out, "role:fleet-test-judge:r1").prompt).criteria.some((c) => c.id === "AC9"));
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.ok(pr.criteria.some((c) => c.id === "AC9" && c.test_files.length === 0));
});


// ---------------------------------------------------------------- contract marker + output asserts

test("contract marker: missing or fleet-v2 in preflight stops; fleet-v1 passes", async () => {
  const missing = happy();
  missing.preflight.contract["fleet-coder"] = null;
  let out = await run(missing, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder contract null != fleet-v1/);
  assert.deepEqual(out.labels, ["preflight"]);

  const v2 = happy();
  v2.preflight.contract["plan-audit"] = "CONTRACT: fleet-v2";
  out = await run(v2, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role plan-audit contract fleet-v2 != fleet-v1/);

  out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok");
});

test("contract marker: a role runner that loaded another contract is discarded", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"].role_contract = "CONTRACT: fleet-v2";
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-test-judge/);
  assert.match(out.result.reason, /contract fleet-v2 != fleet-v1/);
  assert.ok(!out.labels.includes("hasher:freeze:f1"));
});

test("contract drift: planner ok output missing a required key stops", async () => {
  const s = happy();
  const p = Object.assign({}, s["role:scope-and-plan"], { __raw: true, role_version: 9, role_contract: "CONTRACT: fleet-v1" });
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
    role_version: 4,
    role_contract: "CONTRACT: fleet-v1",
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
  const pr = Object.assign({}, s["role:fleet-pr-opener"], { __raw: true, role_version: 3, role_contract: "CONTRACT: fleet-v1" });
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
  s["role:fleet-coder:r1"] = { __raw: true, role_version: 3, role_contract: "CONTRACT: fleet-v1", status: "needs_human", reason: "test AC1 wrong" };
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
