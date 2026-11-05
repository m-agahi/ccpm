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
  "scope-and-plan": 24,
  "plan-audit": 13,
  "fleet-test-writer": 9,
  "fleet-test-judge": 9,
  "fleet-coder": 16,
  "fleet-code-judge": 13,
  "fleet-pr-opener": 10,
  "fleet-intent-judge": 2,
  "pr-review": 17,
  "gate-change-nonweakening-sweep": 4,
};
const ROLE_NAMES = Object.keys(FROZEN_VERSIONS);

// Keys each role must return on status ok (the frozen fleet-v3 contract).
// The harness fills missing ones with neutral defaults for terse override
// stubs; a stub with __raw: true is returned as written (drift tests).
const REQUIRED_DEFAULTS = {
  "scope-and-plan": { plan_path: "docs/plans/x.md", criteria: [], est_diff_lines: 80, new_behaviour: true, allowed_additions: { files: [], symbols: [], deps: [], settings: [] }, held_out_examples: [], tldr: "adds a thing", plan_diff: ["new plan"], repo_obligations: [], test_cmd: { command: "pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: [] } },
  "plan-audit": { verdict: "approve", routed_findings: [] },
  "fleet-test-writer": { criterion_id: "AC1", tests: [], files: [] },
  "fleet-test-judge": { verdict: "approve", routed_findings: [], checked: [] },
  "fleet-coder": { changed_paths: [], suite_result: { command: "pytest", exit_code: 0 }, added_symbols: [], frozen_tests_red_at_start: true, obligations_done: [] },
  "fleet-code-judge": { verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 }, hash_check: { match: true, mismatched: [] }, gates_not_run: [], obligations_check: [] },
  "fleet-pr-opener": { pr_url: null, pr_number: null, created: true, template_used: null, gates_not_run_stated: true },
  "fleet-intent-judge": { verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
  "pr-review": { verdict: "approve", findings: [], touches_gate: false, checked: [] },
  "gate-change-nonweakening-sweep": { verdict: "non_weakening", units: [], findings: [] },
};

async function runOne(script, args) {
  const calls = [];
  const unscripted = [];
  const logs = [];
  const counters = {};
  // before the freeze, the worktree holds what the first freeze will hash
  const f1 = script["hasher:freeze:f1"];
  let lastHashes = f1 && typeof f1 === "object" && !Array.isArray(f1) && f1.hashes ? f1.hashes : null;
  const fleetRefs = {};
  const agent = async (prompt, opts = {}) => {
    const label = opts.label;
    calls.push({ label, prompt, opts });
    // the bytecode purge is mechanical; unscripted purges succeed by default
    if (!(label in script) && /^infra:purge-bytecode:/.test(label)) return { status: "ok", reason: "purged", purged: 0 };
    // unscripted IaC hook reads see no .pre-commit-config.yaml (no IaC hooks)
    if (!(label in script) && /^infra:iac-hooks/.test(label))
      return { status: "ok", reason: "absent", present: false, parser: null, sha256: "MISSING", default_stages: null, hooks: [] };
    // run-state writes are mechanical too: the ref lands on the expected head
    if (!(label in script) && /^infra:state:/.test(label)) {
      fleetRefs["fleetref:" + inputsOf(prompt).state_ref] = "f".repeat(40);
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    }
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
    // hasher stubs that give only a fingerprint carry the maps of the last
    // hasher result forward (nothing changed; the judge fingerprint compares
    // the maps too) and list no changed paths
    if (label.startsWith("hasher:") && !raw && r.status === "ok") {
      if (!("hashes" in r)) r.hashes = JSON.parse(JSON.stringify(lastHashes || DEFAULT_HASHES));
      if (!("changed" in r)) r.changed = [];
      // the real hasher sees the run-state refs the workflow's own state writes made
      const g = r.hashes.git || (r.hashes.git = {});
      if (!Object.keys(g).some((k) => k.startsWith("fleetref:"))) Object.assign(g, fleetRefs);
      lastHashes = r.hashes;
    }
    // a run-state write moves its ref
    if (label.startsWith("infra:state:") && !raw && r.status === "ok" && typeof r.state_sha === "string")
      fleetRefs["fleetref:" + inputsOf(prompt).state_ref] = r.state_sha;
    // a terse writer stub reports exactly its criterion's test files
    if (label.startsWith("role:fleet-test-writer:") && !raw && r.status === "ok" && !("files" in r))
      r.files = inputsOf(prompt).test_files;
    if (label.startsWith("role:") && !raw) {
      const role = label.split(":")[1];
      // role runners report the version and contract marker they loaded
      if (!("role_version" in r)) {
        const pv = script.preflight && script.preflight.versions ? script.preflight.versions[role] : undefined;
        r.role_version = pv !== undefined ? pv : FROZEN_VERSIONS[role];
      }
      if (!("role_contract" in r)) r.role_contract = "CONTRACT: fleet-v3";
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
// Fingerprints are {head, tree}. Writers and the coder never commit, so the
// head stays at the plan commit until the commit step; only the tree moves.
// FP_PRE: the plan commit before the writers; FP_PLAN (= FP_TESTS): the
// worktree holding the approved tests.
const FP_PRE = { head: PC, tree: "T0" };
const FP_TESTS = { head: PC, tree: "T1" };
const FP_PLAN = FP_TESTS;
const FP_K1 = { head: PC, tree: "K1" };
const FP_K2 = { head: PC, tree: "K2" };
const FP_M3 = { head: PC, tree: "M3" };
// the commit step's head for code round m
const CSHA = (m) => "c00000" + m;
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
const DEFAULT_HASHES = HASHES;
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

// commit-step stub: hooks pass; the commit holds exactly the judged tree.
function commitStepStub(m, live) {
  return (prompt) => {
    const code = inputsOf(prompt).code_tree;
    if (live) Object.assign(live, { head: CSHA(m), tree: code });
    return {
      status: "ok",
      reason: "committed",
      commit_result: "committed",
      staged_tree: code,
      worktree_tree: code,
      head: CSHA(m),
      head_tree: code,
    };
  };
}

function happy(over = {}) {
  const crit = over.criteria || criteria(2);
  const store = {};
  // the last commit the commit step made: the review's worktree state
  const live = {};
  const reviewState = () => ({ status: "ok", fingerprint: { head: live.head, tree: live.tree } });
  const s = {
    __store: store,
    preflight: {
      reachable: true,
      missing: [],
      versions: { ...FROZEN_VERSIONS },
      contract: Object.fromEntries(ROLE_NAMES.map((k) => [k, "CONTRACT: fleet-v3"])),
      dispatch: Object.fromEntries(ROLE_NAMES.map((k) => [k, "DISPATCH: model=sonnet"])),
    },
    intake: { status: "ok", reason: "resolved", brief: over.brief || BRIEF },
    "infra:branch-scan": { status: "ok", reason: "scanned", commits: [] },
    "infra:stage-plan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan": commitStub(store, PC, PSHA),
    "infra:load-ref": loadStub(store),
    "infra:read-state": { status: "ok", reason: "no run-state", exists: false },
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
    "infra:push": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
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
    "hasher:pre-writers:r1": { status: "ok", fingerprint: FP_PRE },
    "hasher:post-writers:r1": (prompt) => ({
      status: "ok",
      fingerprint: FP_TESTS,
      changed: crit.flatMap((c) => c.test_files),
    }),
    "role:fleet-test-judge:r1": {
      status: "ok",
      reason: "good",
      verdict: "approve",
      routed_findings: [],
      checked: [],
      yadgar_findings: ["judge fact"],
    },
    "hasher:fp-post:test-judge:r1": { status: "ok", fingerprint: FP_TESTS },
    "hasher:freeze:f1": { status: "ok", fingerprint: FP_TESTS, hashes: HASHES },
    "role:fleet-coder:r1": {
      status: "ok",
      reason: "done",
      changed_paths: ["src/x.py"],
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
    "infra:commit:r1": commitStepStub(1, live),
    "infra:commit:r2": commitStepStub(2, live),
    "infra:commit:r3": commitStepStub(3, live),
    "infra:review-paths:v1": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v1": reviewState,
    "role:pr-review:v1": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: ["diff"] },
    "hasher:fp-post:pr-review:v1": reviewState,
    "infra:review-cleanup:v1": { status: "ok", reason: "clean" },
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
      files: c.test_files.slice(),
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
  // approved_sha is the commit the commit step made after the judge approved
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.equal(pr.approved_sha, CSHA(1));
  assert.equal(pr.repo, "o/r");
  // coder gets the frozen map and the freeze ref
  const coder = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  // roles get plain files in frozen_tests and synthetic section keys apart
  assert.deepEqual(coder.frozen_tests, { "tests/test_a.py": "ha", "tests/test_b.py": "hb" });
  // role view: flat keys path#section, git:<k>, symlink:<rel>
  assert.deepEqual(coder.frozen_config_sections, { "pyproject.toml#tool.pytest": "hp" });
  const cjIn = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cjIn.frozen_tests, coder.frozen_tests);
  assert.equal(cjIn.code_base_ref, PC);
  assert.equal(coder.freeze_ref, PC);
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
  assert.ok(!out.labels.includes("hasher:pre-writers:r1"));
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
      "role:fleet-test-writer:AC2:r2": { status: "ok", criterion_id: "AC2" },
      "hasher:post-writers:r2": { status: "ok", fingerprint: FP_PLAN },
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
    extra["hasher:post-writers:r" + n] = { status: "ok", fingerprint: FP_PLAN };
    extra["hasher:fp-post:test-judge:r" + n] = { status: "ok", fingerprint: FP_PLAN };
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
        fingerprint: { head: PC, tree: "CHANGED" },
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
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
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
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, CSHA(2));
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
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
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
  const out = await run(fixTestsReentry({}, H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" })), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const tj = inputsOf(call(out, "role:fleet-test-judge:r2").prompt);
  assert.deepEqual(tj.code_judge_findings, [{ target: "tests", criterion: "AC1", finding: "wrong expectation" }]);
  const iJudge = out.labels.indexOf("role:fleet-test-judge:r2");
  const iCoder2 = out.labels.indexOf("role:fleet-coder:r2");
  assert.ok(iJudge > 0 && iCoder2 > iJudge, "test-judge runs before the next coder round");
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.equal(c2.freeze_tree, "M3");
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
    extra["role:fleet-coder:r" + n] = { status: "ok", changed_paths: ["src/x.py"] };
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
        fingerprint: { head: PC, tree: "SUITE-LEFT-CHANGES" },
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

test("agent cap stops the run with needs_human before exceeding 100 agents", async () => {
  const crit = criteria(15);
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
  };
  for (let n = 1; n <= 6; n++) {
    extra["hasher:post-writers:r" + n] = { status: "ok", fingerprint: FP_PLAN };
    // r4 is the judge-first re-entry round: it judges the code judge's state
    extra["hasher:fp-post:test-judge:r" + n] = { status: "ok", fingerprint: n === 4 ? FP_K1 : FP_PLAN };
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
  assert.ok(out.build.calls.length <= 100, "dispatched " + out.build.calls.length);
  assert.ok(out.build.calls.length > 60, "the old cap of 60 would have stopped earlier");
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
    "GIT_INDEX_FILE",
    "'read-tree', 'HEAD'",
    "'add', '-A'",
    "write-tree",
  ]) {
    assert.ok(p.includes(needle), "hasher prompt mentions " + needle);
  }
  const h = inputsOf(p);
  assert.deepEqual(h.test_files.sort(), [".fleet/l42/plan_ref.json", "tests/test_a.py", "tests/test_b.py"]);
  assert.ok(!("mode" in h));
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

// mode is kept for the older call sites; the program always hashes.
function runHasherRaw(wt, mode, files, baseTree) {
  const r = spawnSync("python3", ["-I", "-", wt, JSON.stringify(files)].concat(baseTree ? [baseTree] : []), {
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
    const fp0 = runHasher(wt, "hashes", []).fingerprint;
    writeFileSync(join(wt, "ignored.log"), "noise\n");
    assert.deepEqual(runHasher(wt, "hashes", []).fingerprint, fp0);
    writeFileSync(join(wt, "stray.txt"), "x\n");
    assert.notDeepEqual(runHasher(wt, "hashes", []).fingerprint, fp0);
    sh(wt, "rm", "stray.txt");
    writeFileSync(join(wt, "test_a.py"), "def test(): assert 1\n");
    const fpEdit = runHasher(wt, "hashes", []).fingerprint;
    assert.notEqual(fpEdit.tree, fp0.tree);
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
      "role:fleet-test-writer:AC2:r2": { status: "ok", criterion_id: "AC2" },
      "hasher:post-writers:r2": { status: "ok", fingerprint: FP_PLAN },
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
  assert.deepEqual(r2[0].files, ["tests/test_b.py"]);
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
  const s = fixTestsReentry({
    "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [testFinding, codeFinding] },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.deepEqual(c2.routed_findings, [codeFinding]);
  assert.equal(c2.freeze_tree, "M3");
  assert.equal(c2.code_base_ref, PC);
  const cj2 = inputsOf(call(out, "role:fleet-code-judge:r2").prompt);
  assert.equal(cj2.code_base_ref, PC);
  assert.equal(cj2.freeze_tree, "M3");
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
  "fleet-test-judge": "DISPATCH: model=sonnet",
  "fleet-coder": "DISPATCH: model=opus",
  "fleet-code-judge": "DISPATCH: model=opus (fallback=sonnet)",
  "fleet-pr-opener": "DISPATCH: model=haiku",
  "fleet-intent-judge": "DISPATCH: model=fable (fallback=opus)",
  "pr-review": "DISPATCH: model=opus (fallback=sonnet for small/mechanical PRs) — review depth",
  "gate-change-nonweakening-sweep": "DISPATCH: model=sonnet (fallback=opus) — mechanical measurement",
};

function withDispatch(s, dispatch) {
  s.preflight = Object.assign({}, s.preflight, { dispatch });
  return s;
}

test("each role runs on the tier its DISPATCH line names; a bad or missing line halts (no default tier)", async () => {
  const out = await run(withDispatch(happy(), DISPATCH), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const model = (l) => call(out, l).opts.model;
  assert.equal(model("role:scope-and-plan"), "opus");
  assert.equal(model("role:plan-audit"), "fable");
  assert.equal(model("role:fleet-test-writer:AC1:r1"), "sonnet");
  assert.equal(model("role:fleet-test-judge:r1"), "sonnet");
  assert.equal(model("role:fleet-coder:r1"), "opus");
  assert.equal(model("role:fleet-code-judge:r1"), "opus");
  assert.equal(model("role:fleet-pr-opener"), "haiku");
  assert.equal(model("role:pr-review:v1"), "opus");
  for (const bad of ["garbage line", null, "DISPATCH: model=gpt5 (fallback=opus)"]) {
    const o = await runOne(withDispatch(happy(), Object.assign({}, DISPATCH, { "fleet-coder": bad })), ARGS);
    assert.equal(o.result.status, "needs_human", String(bad));
    assert.match(o.result.reason, /fleet-coder has no usable DISPATCH line/);
    assert.ok(!o.labels.includes("intake"), "halts in preflight");
  }
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
        "role:fleet-test-writer:AC1:r1:fallback": { status: "ok", criterion_id: "AC1" },
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
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
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

// A fix_tests re-entry: the judge runs first on the code judge's state (K1),
// then AC1's writer rewrites its test in the fleet worktree (tree M3, maps
// `after`), the judge approves and the tests are re-frozen.
function fixTestsReentry(extra, after) {
  const testFinding = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const h = after || HASHES;
  return happy({
    script: Object.assign(
      {
        "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [testFinding] },
        "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [testFinding] },
        "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
        "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1" },
        "hasher:post-writers:r3": { status: "ok", fingerprint: FP_M3, changed: ["tests/test_a.py"], hashes: h },
        "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
        "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
        "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: h },
        "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
        "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: h },
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
    assert.equal(tj.code_tree, "K1", label);
  }
  assert.ok(!("code_judge_findings" in inputsOf(call(out, "role:fleet-test-judge:r1").prompt)));
});

test("MI-2: fix_tests re-entry writers work in the fleet worktree on top of the coder's uncommitted code", async () => {
  const out = await run(fixTestsReentry(), ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.some((l) => /^infra:(sync|integrate|prepare)/.test(l)));
  const w = inputsOf(call(out, "role:fleet-test-writer:AC1:r3").prompt);
  assert.equal(w.worktree, "/r/.claude/worktrees/fleet-l42-add-thing/main");
  // the ownership delta starts at the code judge's tree, not the plan commit
  assert.equal(inputsOf(call(out, "hasher:post-writers:r3").prompt).base_tree, "K1");
  assert.ok(!out.labels.includes("hasher:pre-writers:r3"));
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
  s.preflight.versions["fleet-coder"] = 15;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder version 15 < frozen 16/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("S-8: a higher role version is logged as prose-only and recorded", async () => {
  const s = happy();
  s.preflight.versions["fleet-code-judge"] = 14;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(out.result.gate_log.some((l) => /role fleet-code-judge v14 > frozen v13: prose-only changes assumed/.test(l)));
  assert.equal(out.result.role_versions["fleet-code-judge"], 14);
  assert.equal(out.result.role_versions["fleet-coder"], 16);
});

test("S-8: a role runner that loaded a different version than preflight is discarded", async () => {
  const s = happy();
  s["role:fleet-coder:r1"].role_version = 12;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-coder/);
  assert.match(out.result.reason, /version 12/);
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

test("contract marker: missing or fleet-v1 in preflight halts; fleet-v3 passes", async () => {
  const missing = happy();
  missing.preflight.contract["fleet-coder"] = null;
  let out = await run(missing, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder contract null != fleet-v3/);
  assert.deepEqual(out.labels, ["preflight"]);

  const v1 = happy();
  v1.preflight.contract["plan-audit"] = "CONTRACT: fleet-v1";
  out = await run(v1, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role plan-audit contract fleet-v1 != fleet-v3/);
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
  assert.match(out.result.reason, /contract fleet-v1 != fleet-v3/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("contract marker: a role runner that loaded another contract is discarded", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"].role_contract = "CONTRACT: fleet-v1";
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-test-judge/);
  assert.match(out.result.reason, /contract fleet-v1 != fleet-v3/);
  assert.ok(!out.labels.includes("hasher:freeze:f1"));
});

test("contract drift: planner ok output missing a required key stops", async () => {
  const s = happy();
  const p = Object.assign({}, s["role:scope-and-plan"], { __raw: true, role_version: FROZEN_VERSIONS["scope-and-plan"], role_contract: "CONTRACT: fleet-v3" });
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
    role_contract: "CONTRACT: fleet-v3",
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
  const pr = Object.assign({}, s["role:fleet-pr-opener"], { __raw: true, role_version: FROZEN_VERSIONS["fleet-pr-opener"], role_contract: "CONTRACT: fleet-v3" });
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
  s["role:fleet-coder:r1"] = { __raw: true, role_version: FROZEN_VERSIONS["fleet-coder"], role_contract: "CONTRACT: fleet-v3", status: "needs_human", reason: "test AC1 wrong" };
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
  const out = await run(fixTestsReentry({}, after), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(out.result.refreeze_log, [
    {
      round: 1,
      freeze_tree_before: "T1",
      freeze_tree_after: "M3",
      changed: [{ path: "tests/test_a.py", before: "ha", after: "ha2" }],
    },
  ]);
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.equal(c2.frozen_tests["tests/test_a.py"], "ha2");
  assert.equal(c2.freeze_tree, "M3");
  assert.equal(c2.freeze_ref, PC);
  assert.equal(c2.code_base_ref, PC);
});

test("re-entry touching another criterion's test file stops with needs_human (ownership, then re-freeze)", async () => {
  const out = await run(fixTestsReentry({}, H({ ...HASHES_FLAT, "tests/test_b.py": "hb2" })), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer touched tests\/test_b\.py/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  // the re-freeze check backs it: a change that reached the freeze anyway
  const s = fixTestsReentry({
    "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: H({ ...HASHES_FLAT, "tests/test_b.py": "hb2" }) },
    "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3, hashes: H({ ...HASHES_FLAT, "tests/test_b.py": "hb2" }) },
  });
  const out2 = await run(s, ARGS);
  assert.equal(out2.result.status, "needs_human");
  assert.match(out2.result.reason, /judge mutated worktree|re-freeze touched unrouted path tests\/test_b\.py/);
});

test("re-entry touching runner config or a symlink stops with needs_human", async () => {
  for (const [k, v] of [["conftest.py", "new"], ["pyproject.toml#tool.pytest", "hp2"], ["symlink:lib", "../x"], ["git:info/exclude", "e2"]]) {
    const out = await run(fixTestsReentry({}, H({ ...HASHES_FLAT, [k]: v })), ARGS);
    assert.equal(out.result.status, "needs_human", k);
    assert.ok(out.result.reason.includes("writer touched " + k), out.result.reason);
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
    "infra:iac-hooks:commit-plan",
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
      role_contract: "CONTRACT: fleet-v3",
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

test("build mode: preflight first, then workspace, verify, then the writers' base state; no planner", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(out.labels.slice(0, 7), ["preflight", "workspace", "infra:load-ref", "infra:verify-plan", "infra:read-state", "infra:iac-hooks", "hasher:pre-writers:r1"]);
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
  assert.ok(!out.labels.includes("hasher:pre-writers:r1"));
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
    assert.ok(!out.labels.includes("hasher:pre-writers:r1"), JSON.stringify(c));
  }
});

test("build mode: commit-step commits pass verify; without a run-state the build stops as unresumable", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const head = "fedcba9876";
  s["infra:verify-plan"] = {
    ...s["infra:verify-plan"],
    head,
    commits_since: [
      { sha: "1111111", subject: "feat(l42): add thing" },
      { sha: "2222222", subject: "fix(l42): code round 2" },
    ],
  };
  const out = await runOne(s, buildArgs(ref));
  assert.ok(out.logs.some((l) => /descends from plan_commit by 2 fleet commit/.test(l)));
  assert.match(out.result.reason, /approved but unresumable/);
  // any other subject is not a commit step of this plan (writers and the coder never commit)
  for (const subject of ["test(AC1): behaviour 1", "Merge branch 'fleet/l42-add-thing--pabc1234d-t-AC1'", "feat(thing): add it", "fix(l43): code round 2"]) {
    s["infra:verify-plan"].commits_since = [{ sha: "5555555", subject }];
    const other = await runOne(s, buildArgs(ref));
    assert.equal(other.result.status, "needs_human", subject);
    assert.match(other.result.reason, /non-fleet commit/);
  }
});

test("build mode: the script pushes the approved sha before the PR opener runs", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  const iPush = out.labels.indexOf("infra:push");
  const iPr = out.labels.indexOf("role:fleet-pr-opener");
  assert.ok(iPush > 0 && iPr > iPush);
  const p = inputsOf(call(out, "infra:push").prompt);
  assert.equal(p.approved_sha, CSHA(1));
  assert.equal(p.branch, "fleet/l42-add-thing");
  assert.match(call(out, "infra:push").prompt, /Never --force/);
});

test("build mode: a push that did not land the approved sha stops before the PR", async () => {
  const s = happy({ script: { "infra:push": { status: "ok", reason: "x", push_result: "ok", remote_head: "other" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /not the approved c000001/);
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
      "infra:replan-reset": { status: "ok", reason: "reset", head: PC2, superseded_head: "5555555" },
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
  assert.equal(r.superseded_head, "5555555");
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
    "infra:iac-hooks:commit-plan:replan",
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
  // the coder's work is uncommitted: the reset keeps the old head on the
  // superseded branch and the judged tree under a ref, creating no commit
  assert.deepEqual(
    { superseded_branch: reset.superseded_branch, expected_head: reset.expected_head, expected_tree: reset.expected_tree, new_plan_commit: reset.new_plan_commit },
    { superseded_branch: "fleet/l42-add-thing--superseded-1", expected_head: PC, expected_tree: "K1", new_plan_commit: PC2 },
  );
  const rp = call(out, "infra:replan-reset").prompt;
  assert.match(rp, /Only after step 2 succeeded/);
  assert.match(rp, /branch <superseded_branch> <expected_head>/);
  assert.match(rp, /clean -fd` \(never -x/);
  assert.ok(!/git -C <main_worktree> commit -/.test(rp));
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
  s["role:fleet-test-writer:AC3:r1"] = { status: "ok", reason: "red", criterion_id: "AC3", tests: [] };
  const hashes = H({ ...HASHES_FLAT, "tests/test_c.py": "hc" });
  // the branch now sits at the new plan commit
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: { head: PC2, tree: "T0" }, hashes };
  s["hasher:post-writers:r1"] = { status: "ok", fingerprint: { head: PC2, tree: "T1" }, hashes, changed: ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py"] };
  s["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: { head: PC2, tree: "T1" }, hashes };
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: { head: PC2, tree: "T1" }, hashes };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: { head: PC2, tree: "K1" }, hashes };
  s["hasher:fp-post:code-judge:r1"] = { status: "ok", fingerprint: { head: PC2, tree: "K1" }, hashes };
  const second = await runOne(s, buildArgs(ref2));
  noUnscripted(second);
  assert.equal(second.result.status, "ok", second.result.reason);
  for (const id of ["AC1", "AC2", "AC3"]) assert.ok(second.labels.includes("role:fleet-test-writer:" + id + ":r1"), id);
  assert.equal(inputsOf(call(second, "infra:commit:r1").prompt).expected_head, PC2);
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
  "fleet-coder": ["changed_paths", "added_symbols", "addressed_findings"],
  "fleet-test-writer": ["tests", "files", "addressed_findings"],
  "pr-review": ["findings", "checked"],
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
    role_contract: "CONTRACT: fleet-v3",
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
  const s = happy({ script: { "infra:push": { status: "ok", reason: "x", push_result: "ok", remote_head: "deadbeef" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /deadbeef, not the approved c000001/);
});

// ---------------------------------------------------------------- 2.0.2: bytecode poisoning

test("a bytecode purge runs before every hasher check and every code-judge, in that order", async () => {
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_code", routed_findings: [{ target: "code", criterion: "AC1", finding: "x" }] },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
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

test("role versions: scope-and-plan 24, coder 16 and code-judge 13 are the minimums", async () => {
  for (const [role, v] of [["scope-and-plan", 23], ["fleet-coder", 15], ["fleet-code-judge", 12]]) {
    const s = happy();
    s.preflight.versions[role] = v;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", role);
    assert.match(out.result.reason, new RegExp("role " + role + " version " + v + " < frozen " + (v + 1)));
  }
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
  s["infra:check-scripts"] = checkScriptsAll({});
  for (const m of [1, 2, 3]) s["infra:check-scripts:r" + m] = checkScriptsAll({});
  return s;
}

// Plan-time script check stub: every path passes unless named in fail.
function checkScriptsAll(fail) {
  return (prompt) => {
    const checks = {};
    for (const path of inputsOf(prompt).paths) checks[path] = fail[path] ? { ok: false, reason: fail[path] } : { ok: true, reason: "ok" };
    return { status: "ok", reason: "checked", checks };
  };
}

// Scripts a second code round that passes and pushes.
// head: HEAD under the second round (the first round's commit when its push
// was rejected; the commit step only ever adds commits)
function secondRoundPasses(s, check, pushLabel, head) {
  const fp = { head: head || PC, tree: "K2" };
  s["role:fleet-coder:r2"] = { status: "ok", changed_paths: ["src/x.py"] };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: fp, hashes: HASHES };
  s["role:fleet-code-judge:r2"] = { status: "ok", verdict: "approve", routed_findings: [], obligations_check: check };
  s["hasher:fp-post:code-judge:r2"] = { status: "ok", fingerprint: fp };
  if (pushLabel) s[pushLabel] = (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha });
}

test("2.0.3 plan_ref: plan_facts carries test_cmd, repo_obligations and commands, covered by the seal", async () => {
  const s = withObligations([OB_BUMP, OB_LOG]);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation");
  const ref = JSON.parse(s.__store[PC]);
  assert.deepEqual(ref.plan_facts.test_cmd, TEST_CMD);
  assert.deepEqual(ref.plan_facts.repo_obligations, [OB_BUMP, OB_LOG]);
  assert.deepEqual(ref.plan_facts.commands, out.result.commands);
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
      role_contract: "CONTRACT: fleet-v3",
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
    "./check.sh",
    "lib/check.sh",
    "src/scripts/check.sh",
    "scripts/.venv/bin/check",
    "scripts/node_modules/x/run",
    "tools/__pycache__/x",
    "bin/.git/hooks/x",
    "ci/.tox/x",
    "bin/python3",
    "scripts/pip",
    "tools/npm",
    "bin/npx",
    "scripts/bash",
    "hack/uv",
    "bin/make",
    "ci/node",
    "python3 src/check.py",
    "python3 check.py",
    "uv run python scripts/venv/x.py",
  ]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(cmd) + " " + out.result.reason);
    const ob = JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0];
    assert.ok(!("check_cmd" in ob), cmd);
    assert.equal(ob.check_cmd_rejected, cmd);
    assert.equal(typeof ob.check_rejected_reason, "string");
    assert.ok(out.logs.some((l) => /OB1 check_cmd refused \(judge-only\)/.test(l)), cmd);
    assert.deepEqual(inputsOf(call(out, "role:plan-audit").prompt).repo_obligations[0].check_cmd_rejected, cmd);
  }
});

test("2.0.3 allowlist: the allowed shapes keep their check_cmd; the workflow runs none of them", async () => {
  for (const cmd of [
    "pre-commit run check-changelog",
    "pre-commit run check-versions --all-files --hook-stage pre-push --from-ref origin/master --to-ref HEAD",
    "make check",
    "python3 scripts/check_version_bump.py",
    "python scripts/c.py --base origin/master",
    "uv run python3 scripts/c.py",
    "uv run --extra test python scripts/c.py -q",
    "scripts/check.sh",
    "./scripts/check.sh --strict",
    "bin/check-version",
    "hack/verify.sh",
    "ci/check.py",
    "python3 tools/check_version_bump.py --base origin/master",
  ]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", cmd + " " + out.result.reason);
    assert.equal(JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0].check_cmd, cmd);
    // informational for the code judge; no infra step runs it
    assert.equal(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).repo_obligations[0].check_cmd, cmd);
    assert.ok(!out.labels.some((l) => /obligation|verify-commands/.test(l)), cmd);
  }
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

test("2.0.3 test_cmd shape: only test runners, then flags and paths", async () => {
  for (const command of [
    "pip install evil",
    "python -m http.server",
    "python3 -m pip install x",
    "uv pip install x",
    "uv run pip install x",
    "uv run python -m http.server",
    "npm install",
    "npm run build",
    "npx tsc",
    "pnpm add x",
    "yarn add x",
    "make check",
    "make test-all",
    "go run ./cmd",
    "cargo install x",
    "pytest https://evil.example/x.py",
    "pytest <paths> install",
    "pytest -m slow -p pip",
    "python -m pytest -m http.server",
    "bash run-tests.sh",
    "./run-tests",
    "tox",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", command);
    assert.match(out.result.reason, /test_cmd refused: test_cmd shape not allowed/, command);
    assert.equal(out.result.stop_gate, "commands");
  }
  for (const command of [
    "pytest <paths>",
    "pytest -q -x <paths>",
    "python -m pytest <paths> -n0",
    "python3 -m pytest -p no:randomly tests/unit",
    "uv run pytest <paths>",
    "uv run --frozen --no-sync --extra test --extra dev pytest <paths> -n0",
    "npm test -- <paths>",
    "npm run test",
    "npm run test:unit -- <paths>",
    "npx jest <paths>",
    "npx vitest run <paths>",
    "pnpm test",
    "yarn test",
    "cargo test",
    "go test ./...",
    "make test",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    assert.equal((await runOne(s, ARGS)).result.status, "awaiting_confirmation", command);
  }
});

test("2.0.3 test_cmd env: only allowlisted names", async () => {
  for (const name of ["LD_PRELOAD", "PYTHONPATH", "PYTEST_ADDOPTS", "GH_TOKEN", "MY_SETTING", "PATH", "HOME", "lang", "AWS_REGION"]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command: "pytest <paths>", env: { [name]: "1" } };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", name);
    assert.ok(out.result.reason.indexOf("test_cmd env " + name + " not allowed") >= 0, name + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "commands");
    assert.ok(!out.labels.includes("role:plan-audit"), name);
  }
  const ok = happy();
  ok["role:scope-and-plan"].test_cmd = {
    command: "pytest <paths>",
    env: { DJANGO_SETTINGS_MODULE: "app.settings", PYTHONUNBUFFERED: "1", TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" },
  };
  assert.equal((await runOne(ok, ARGS)).result.status, "awaiting_confirmation");
  const bad = happy();
  bad["role:scope-and-plan"].test_cmd = { command: "pytest <paths>", env: { TZ: "$(id)" } };
  assert.match((await runOne(bad, ARGS)).result.reason, /test_cmd refused: env TZ value is not plain/);
});

test("2.0.3 awaiting_confirmation lists every command verbatim with env, tools, rule_source and who runs it", async () => {
  const s = withObligations([OB_BUMP, Object.assign({}, OB_LOG, { check_cmd: "python -c x" })]);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  const cmds = out.result.commands;
  assert.deepEqual(cmds.map((c) => c.command), [TEST_CMD.command, OB_BUMP.check_cmd, "python -c x"]);
  assert.deepEqual(cmds.map((c) => c.rule_source), ["test_cmd", OB_BUMP.rule_source, OB_LOG.rule_source]);
  assert.deepEqual(cmds.map((c) => c.run_by), ["roles", "code-judge (optional)", "nobody"]);
  assert.deepEqual(cmds[0].env, {});
  assert.deepEqual(cmds[0].tools, ["mypy"]);
  assert.match(cmds[2].note, /^refused: /);
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
  assert.ok(!("obligation_results" in inputsOf(call(out, "role:fleet-code-judge:r1").prompt)));
});

test("2.0.3 approve without met:true for every obligation is converted to fix_code", async () => {
  for (const check of [[], [{ id: "OB1", met: true, evidence: "x" }], [{ id: "OB1", met: true }, { id: "OB2", met: false, evidence: "no line" }]]) {
    const s = withObligations([OB_BUMP, OB_LOG]);
    s["role:fleet-code-judge:r1"].obligations_check = check;
    secondRoundPasses(s, [{ id: "OB1", met: true, evidence: "ok" }, { id: "OB2", met: true, evidence: "ok" }]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", JSON.stringify(check) + " " + out.result.reason);
    assert.equal(out.result.rounds.code, 2, JSON.stringify(check));
    assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding).join("\n"), /OB2/);
    assert.ok(out.logs.some((l) => /obligations gate/.test(l)));
    // no push of an unconfirmed approval
    assert.equal(out.labels.filter((l) => /^infra:push/.test(l)).length, 1);
  }
});

test("2.0.3 obligations gate failing every round stops at the cap with the gate named", async () => {
  const s = withObligations([OB_BUMP]);
  for (const m of [1, 2, 3]) {
    const fp = { head: PC, tree: "K" + m };
    s["role:fleet-coder:r" + m] = { status: "ok", changed_paths: ["src/x.py"] };
    s["hasher:post-coder:r" + m] = { status: "ok", fingerprint: fp, hashes: HASHES };
    s["role:fleet-code-judge:r" + m] = { status: "ok", verdict: "approve", routed_findings: [], obligations_check: [{ id: "OB1", met: false, evidence: "x" }] };
    s["hasher:fp-post:code-judge:r" + m] = { status: "ok", fingerprint: fp };
  }
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /code rounds exhausted \(3\).*obligations gate/);
  assert.equal(out.result.stop_gate, "cap");
});

test("2.0.3 push rejected by a repo hook routes to the coder as fix_code; the judge re-approves before the next push", async () => {
  const s = happy();
  s["infra:push"] = { status: "ok", reason: "hook", push_result: "hook_rejected", hook_tail: "check_version_bump: core version not bumped\nerror: failed to push some refs" };
  secondRoundPasses(s, [], "infra:push:p2", CSHA(1));
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 2);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "code");
  assert.match(f[0].finding, /push rejected by a repo hook/);
  assert.match(f[0].finding, /core version not bumped/);
  const L = out.labels;
  assert.ok(L.indexOf("infra:push") < L.indexOf("role:fleet-coder:r2"));
  assert.ok(L.indexOf("role:fleet-code-judge:r2") < L.indexOf("infra:push:p2"));
  // the fix is a new commit on top of the rejected one
  assert.equal(inputsOf(call(out, "infra:commit:r2").prompt).expected_head, CSHA(1));
  assert.match(call(out, "infra:commit:r2").prompt, /'fix\(l42\): code round 2'/);
  assert.equal(inputsOf(call(out, "infra:push:p2").prompt).approved_sha, CSHA(2));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, CSHA(2));
  assert.ok(out.logs.some((l) => /rejected by a repo hook -> coder/.test(l)));
});

test("2.0.3 push hook rejection on the last round stops at the cap, naming the push hook", async () => {
  const s = happy();
  for (const m of [1, 2, 3]) {
    const fp = { head: m === 1 ? PC : CSHA(m - 1), tree: "K" + m };
    s["role:fleet-coder:r" + m] = { status: "ok", changed_paths: ["src/x.py"] };
    s["hasher:post-coder:r" + m] = { status: "ok", fingerprint: fp, hashes: HASHES };
    s["role:fleet-code-judge:r" + m] = { status: "ok", verdict: "approve", routed_findings: [] };
    s["hasher:fp-post:code-judge:r" + m] = { status: "ok", fingerprint: fp };
    s["infra:push" + (m > 1 ? ":p" + m : "")] = { status: "ok", reason: "hook", push_result: "hook_rejected", hook_tail: "nope" };
  }
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /code rounds exhausted \(3\).*push hook/);
  assert.equal(out.result.stop_gate, "cap");
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

test("2.0.3 push: non-fast-forward stops for a human, network exhaustion fails, an unclassified ok fails", async () => {
  const nf = happy({ script: { "infra:push": { status: "needs_human", reason: "non_ff", push_result: "non_ff" } } });
  const a = await run(nf, ARGS);
  assert.equal(a.result.status, "needs_human");
  assert.ok(!a.labels.includes("role:fleet-coder:r2"));
  const nw = happy({ script: { "infra:push": { status: "failed", reason: "network", push_result: "network" } } });
  assert.equal((await run(nw, ARGS)).result.status, "failed");
  const un = happy({ script: { "infra:push": (prompt) => ({ status: "ok", reason: "x", remote_head: inputsOf(prompt).approved_sha }) } });
  const c = await run(un, ARGS);
  assert.equal(c.result.status, "failed");
  assert.match(c.result.reason, /push_result null/);
});

test("2.0.3 push prompt classifies hook_rejected, non_ff and network, and never bypasses hooks", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out, "infra:push").prompt;
  for (const w of ["hook_rejected", "non_ff", "network", "failed to push some refs", "hook_tail", "push_result", "never --no-verify"])
    assert.ok(p.toLowerCase().indexOf(w.toLowerCase()) >= 0, w);
  // classification reads git's own lines only, never the hook's output or the URL
  assert.ok(p.indexOf("Classify on git's own lines only") >= 0);
  assert.ok(p.indexOf("` ! [rejected]`") >= 0 && p.indexOf("` ! [remote rejected]`") >= 0);
  assert.ok(p.indexOf("remote_rejected") >= 0);
  assert.ok(p.indexOf("exit code 128") >= 0);
  assert.ok(p.indexOf("`HTTP`") < 0, "no free-text word list over the whole output");
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
      role_contract: "CONTRACT: fleet-v3",
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
    role_contract: "CONTRACT: fleet-v3",
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
  s["hasher:fp-post:code-judge:r1"] = { status: "ok", fingerprint: { head: PC, tree: "CHANGED" } };
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
  const s = happy({ script: { "hasher:freeze:f1": { status: "ok", fingerprint: { head: PC, tree: "T9" }, hashes: HASHES } } });
  const out = await run(s, ARGS);
  assert.match(out.result.reason, /worktree changed between test approval and freeze/);
  assert.equal(out.result.stop_gate, "fingerprint");
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
  const badEnv = await buildFrom(refWithFacts({ test_cmd: { command: "pytest <paths>", env: { LD_PRELOAD: "x" } } }));
  assert.match(badEnv.result.reason, /test_cmd env LD_PRELOAD not allowed/);
  const badT = await buildFrom(refWithFacts({ test_cmd: { command: "pytest; id" } }));
  assert.match(badT.result.reason, /test_cmd refused/);
  const noCmds = await buildFrom(priorRef(PLAN_MD, { plan_facts: { allowed_additions: null, est_diff_lines: 10, test_cmd: TEST_CMD, repo_obligations: [] } }));
  assert.match(noCmds.result.reason, /plan_ref predates 2\.0\.3/);
});

// ---------------------------------------------------------------- 2.0.4: deny-by-default test args, script path checks

test("2.0.4 test_cmd args are deny-by-default per runner", async () => {
  for (const command of [
    "pytest -p pytest_cov <paths>",
    "pytest -c other.ini <paths>",
    "pytest --rootdir=/ <paths>",
    "pytest --rootdir x <paths>",
    "pytest --basetemp=x <paths>",
    "pytest --config x <paths>",
    "pytest --tb=auto <paths>",
    "pytest -k a.b <paths>",
    "pytest /abs/tests",
    "pytest ../outside",
    "pytest tests/a.py:3",
    "pytest x=1",
    "go test -exec x ./...",
    "go test -toolexec x ./...",
    "go test -run a.b ./...",
    "go test -count=x ./...",
    "cargo test --manifest-path x",
    "cargo test --features x",
    "cargo test -- a.b",
    "npm test x",
    "npm test -- --watch",
    "yarn test --coverage",
    "npx jest --config x",
    "npx vitest --root x",
    "make test -f other.mk",
    "make -C x test",
    "make test VAR=x",
    "make test x",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", command);
    assert.match(out.result.reason, /not allowed/, command);
    assert.equal(out.result.stop_gate, "commands", command);
    assert.ok(!out.labels.includes("role:plan-audit"), command);
  }
  for (const command of [
    "pytest -q -v -vv -x -s -n4 -n0 --maxfail=2 -k slow -m unit -p no:randomly --tb=short -ra -rA --no-header --durations=5 --timeout=30 <paths>",
    "pytest -k not <paths>",
    "go test -run TestX -count=1 -v -race -short ./...",
    "cargo test --lib --tests --all-features --workspace -q -- parser::tests round_trip",
    "npm test",
    "npm test -- <paths>",
    "pnpm test -- tests/a.test.ts",
    "npx jest --silent --passWithNoTests <paths>",
    "npx vitest --run tests/x.test.ts",
    "make test",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", command + " " + out.result.reason);
  }
});

test("2.0.4 check_cmd script path: case-folded segments, extension allowlist", async () => {
  for (const cmd of ["scripts/.VENV/bin/check", "tools/Node_Modules/x", "bin/check.rb", "scripts/x.js", "hack/run.exe", "ci/check.PY"]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    const ob = JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0];
    assert.ok(!("check_cmd" in ob), cmd);
    assert.ok(out.logs.some((l) => /OB1 check_cmd refused \(judge-only\)/.test(l)), cmd);
  }
  for (const cmd of ["scripts/check.sh", "bin/check.bash", "bin/check-version", "tools/x.py"]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    await runOne(s, ARGS);
    assert.equal(JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0].check_cmd, cmd);
  }
});

test("2.0.4 plan-time script check: realpath, regular file, tracked; a failure is judge-only", async () => {
  const s = withObligations([OB_BUMP, Object.assign({}, OB_LOG, { check_cmd: "pre-commit run check-changelog" })]);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  const c = call(out, "infra:check-scripts");
  assert.equal(c.opts.agentType, "fleet:judge");
  const ci = inputsOf(c.prompt);
  assert.deepEqual(ci.paths, ["scripts/check_version_bump.py"]);
  assert.match(ci.run, /^python3 -I -c /);
  assert.ok(out.labels.indexOf("infra:check-scripts") < out.labels.indexOf("role:plan-audit"));
  // no script path -> no step
  const n = withObligations([Object.assign({}, OB_LOG, { check_cmd: "make check" })]);
  assert.ok(!(await runOne(n, ARGS)).labels.includes("infra:check-scripts"));
  // a failed or missing check is judge-only
  for (const stub of [checkScriptsAll({ "scripts/check_version_bump.py": "symlink" }), { status: "ok", reason: "x", checks: {} }]) {
    const f = withObligations([OB_BUMP]);
    f["infra:check-scripts"] = stub;
    const outF = await runOne(f, ARGS);
    noUnscripted(outF);
    const ob = JSON.parse(f.__store[PC]).plan_facts.repo_obligations[0];
    assert.ok(!("check_cmd" in ob));
    assert.match(ob.check_rejected_reason, /script check failed/);
    assert.ok(outF.logs.some((l) => /OB1 check_cmd refused \(judge-only\): script check failed/.test(l)));
  }
});

function scriptCheckPy() {
  const m = /SCRIPT_CHECK_PY_BEGIN\n([\s\S]*?)\n\/\/ SCRIPT_CHECK_PY_END/.exec(SOURCE);
  assert.ok(m, "SCRIPT_CHECK_PY markers present");
  return m[1].replace(/^const SCRIPT_CHECK_PY = String\.raw`\n?/, "").replace(/`;?\s*$/, "");
}

test("script check program: regular tracked file whose realpath stays under its root", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-scriptcheck-"));
  const outside = mkdtempSync(join(tmpdir(), "fleet-outside-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@t");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "mkdir", "-p", "scripts", "tools", "bin");
    writeFileSync(join(wt, "scripts/ok.py"), "print(1)\n");
    writeFileSync(join(wt, "tools/real.sh"), "true\n");
    writeFileSync(join(outside, "evil.sh"), "true\n");
    sh(wt, "ln", "-s", "ok.py", "scripts/link.py");
    sh(wt, "ln", "-s", "../tools/real.sh", "scripts/cross.sh");
    sh(wt, "ln", "-s", outside, "bin/out");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "init");
    writeFileSync(join(wt, "scripts/new.py"), "print(2)\n");
    const paths = ["scripts/ok.py", "scripts/link.py", "scripts/cross.sh", "bin/out/evil.sh", "scripts/new.py", "scripts/missing.py"];
    const r = spawnSync("python3", ["-I", "-", wt, JSON.stringify(paths)], { input: scriptCheckPy(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(
      Object.fromEntries(paths.map((x) => [x, out[x].ok])),
      { "scripts/ok.py": true, "scripts/link.py": false, "scripts/cross.sh": false, "bin/out/evil.sh": false, "scripts/new.py": false, "scripts/missing.py": false },
    );
    assert.match(out["scripts/new.py"].reason, /not tracked/);
    assert.match(out["bin/out/evil.sh"].reason, /outside/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("2.0.4 coordinator cases: rejected and accepted test_cmd args", async () => {
  for (const command of [
    "pytest -p evil",
    "pytest -c x.ini",
    "pytest --rootdir /",
    "pytest --basetemp /tmp",
    "go test -exec sh ./...",
    "go test -toolexec x ./...",
    "cargo test --manifest-path x",
    "make test -f x",
    "make test VAR=1",
    "npm test -- --config x",
    "pytest ../x",
    'pytest -k "a;b"',
    'pytest -k "a" -m "b c"x',
    'pytest "tests/a.py"',
    'pytest -k ""',
    "pytest -k 'a'",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", command);
    assert.equal(out.result.stop_gate, "commands", command);
  }
  for (const command of [
    "uv run --extra test pytest <paths> -n0",
    "pytest -q -x tests/unit",
    'pytest -p no:cacheprovider -k "foo and not bar"',
    'pytest -m "unit or smoke" <paths>',
    "go test -race ./...",
    "cargo test --lib -- my_test",
    "npm test",
    "make test",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", command + " " + out.result.reason);
  }
});

// ---------------------------------------------------------------- 2.0.5: character allowlist, path args, build-time script re-check

test("2.0.5 test_cmd: any character outside the allowlist rejects the whole command", async () => {
  for (const command of [
    "pytest\t<paths>",
    "pytest <paths>\t",
    "pytest\v<paths>",
    "pytest\f<paths>",
    "pytest\r<paths>",
    "pytest <paths>\n",
    "pytest <paths>",
    "pytest <paths>",
    'pytest -k "a\tb"',
    'pytest -k "foo bar"',
    "pytest tests/a+b.py",
    "pytest tests/a%b.py",
    "pytest -k foo,bar",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(command));
    assert.equal(out.result.stop_gate, "commands", JSON.stringify(command));
  }
  for (const command of ['pytest -k "foo and (bar or baz)" <paths>', "pytest  -q   <paths>", 'pytest -m "not slow"']) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    assert.equal((await runOne(s, ARGS)).result.status, "awaiting_confirmation", command);
  }
  const q = happy();
  q["role:scope-and-plan"].test_cmd = { command: 'pytest -k "a ) b"x' };
  assert.equal((await runOne(q, ARGS)).result.status, "needs_human");
});

test("2.0.5 test_cmd path args: start with a word character; no @file, no dot start", async () => {
  for (const command of ["pytest @args.txt", "pytest .hidden/x.py", "pytest tests/../x", "pytest -- x"]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", command);
  }
  for (const command of ["pytest tests/unit/test_a.py", "go test ./...", "go test ./pkg/...", "pytest tests/a-b_c.py"]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    assert.equal((await runOne(s, ARGS)).result.status, "awaiting_confirmation", command);
  }
});

test("2.0.5 build re-checks check_cmd scripts before each code-judge run; a failure is judge-only", async () => {
  const s = withObligations([OB_BUMP]);
  s["infra:check-scripts:r1"] = checkScriptsAll({ "scripts/check_version_bump.py": "is a symlink" });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = call(out, "infra:check-scripts:r1");
  assert.equal(c.opts.agentType, "fleet:judge");
  assert.deepEqual(inputsOf(c.prompt).paths, ["scripts/check_version_bump.py"]);
  assert.equal(inputsOf(c.prompt).worktree, "/r/.claude/worktrees/fleet-l42-add-thing/main");
  const L = out.labels;
  assert.ok(L.indexOf("hasher:post-coder:r1") < L.indexOf("infra:check-scripts:r1"));
  assert.ok(L.indexOf("infra:check-scripts:r1") < L.indexOf("role:fleet-code-judge:r1"));
  const ob = inputsOf(call(out, "role:fleet-code-judge:r1").prompt).repo_obligations[0];
  assert.ok(!("check_cmd" in ob));
  assert.equal(ob.check_cmd_rejected, OB_BUMP.check_cmd);
  assert.match(ob.check_rejected_reason, /symlink/);
  assert.ok(out.logs.some((l) => /OB1 check_cmd refused \(judge-only\): script check failed/.test(l)));
  // passing check: the judge still gets check_cmd; no script -> no step
  const ok = withObligations([OB_BUMP]);
  const outOk = await run(ok, ARGS);
  assert.equal(inputsOf(call(outOk, "role:fleet-code-judge:r1").prompt).repo_obligations[0].check_cmd, OB_BUMP.check_cmd);
  const none = withObligations([OB_LOG]);
  assert.ok(!(await run(none, ARGS)).labels.some((l) => /^infra:check-scripts:r/.test(l)));
});

// ================================================================ 2.1.0

// A repo whose pre-commit hook runs the full suite: committing a RED test
// always fails, so nothing may commit until the code judge approves.
test("2.1.0 no RED commit: writers share the fleet worktree, nothing commits before approve, then one commit step", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  for (const l of out.labels) assert.ok(!/^infra:(prepare|integrate|sync)/.test(l), "no per-criterion branch step: " + l);
  for (const c of criteria(2)) {
    const w = inputsOf(call(out, "role:fleet-test-writer:" + c.id + ":r1").prompt);
    assert.equal(w.worktree, "/r/.claude/worktrees/fleet-l42-add-thing/main");
    assert.equal(w.branch, "fleet/l42-add-thing");
  }
  const commits = out.labels.filter((l) => /^infra:commit:/.test(l));
  assert.deepEqual(commits, ["infra:commit:r1"]);
  assert.ok(out.labels.indexOf("infra:commit:r1") > out.labels.indexOf("hasher:fp-post:code-judge:r1"));
  assert.ok(out.labels.indexOf("infra:commit:r1") < out.labels.indexOf("infra:push"));
  const cp = call(out, "infra:commit:r1").prompt;
  assert.match(cp, /`<git> add -A`/);
  assert.match(cp, /never --no-verify/i);
  assert.match(cp, /'feat\(l42\): add thing'/);
  assert.equal(inputsOf(cp).code_tree, "K1");
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, CSHA(1));
  assert.equal(inputsOf(call(out, "infra:push").prompt).approved_sha, CSHA(1));
});

test("2.1.0 commit step: a hook rejection routes to fix_code with the hook tail; the next round makes a new commit", async () => {
  const s = happy({
    script: {
      "infra:commit:r1": (prompt) => {
        const code = inputsOf(prompt).code_tree;
        return { status: "ok", reason: "hook failed", commit_result: "hook_rejected", staged_tree: code, worktree_tree: code, hook_tail: "pytest: 2 failed" };
      },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
      "hasher:pre-review:v1": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
      "hasher:fp-post:pr-review:v1": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(f.length, 1);
  assert.match(f[0].finding, /commit hook/i);
  assert.match(f[0].finding, /pytest: 2 failed/);
  assert.equal(out.result.rounds.code, 2);
  assert.equal(inputsOf(call(out, "infra:commit:r2").prompt).code_tree, "K2");
  assert.match(call(out, "infra:commit:r2").prompt, /'feat\(l42\): add thing'/);
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, CSHA(2));
});

test("2.1.0 commit step: hook-modified files, a staged-tree mismatch or a committed tree mismatch stop for a human", async () => {
  const cases = [
    { commit_result: "hook_rejected", staged_tree: "K1", worktree_tree: "FORMATTED", hook_tail: "prettier fixed 1 file", re: /hook modified files/ },
    { commit_result: "tree_mismatch", staged_tree: "OTHER", worktree_tree: "K1", re: /staged tree OTHER != code tree K1/ },
    { commit_result: "committed", staged_tree: "K1", worktree_tree: "K1", head: CSHA(1), head_tree: "RESTAGED", re: /hook modified files/ },
    { commit_result: "committed", staged_tree: "K1", worktree_tree: "DIRTY", head: CSHA(1), head_tree: "K1", re: /hook modified files/ },
  ];
  for (const c of cases) {
    const { re, ...r } = c;
    const out = await run(happy({ script: { "infra:commit:r1": { status: "ok", reason: "x", ...r } } }), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(c));
    assert.match(out.result.reason, re);
    assert.equal(out.result.stop_gate, "commit");
    assert.ok(!out.labels.includes("infra:push"));
  }
});

test("2.1.0 a writer or the coder that commits stops the run", async () => {
  let out = await run(happy({ script: { "hasher:post-writers:r1": { status: "ok", fingerprint: { head: "fff0001", tree: "T1" }, changed: [] } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer committed/);
  out = await run(happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: { head: "fff0002", tree: "K1" }, hashes: HASHES } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /coder committed/);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

test("2.1.0 ownership: changed paths must be the pending criteria's test files, reported by their writers", async () => {
  const post = (changed, hashes) => ({ "hasher:post-writers:r1": { status: "ok", fingerprint: FP_TESTS, changed, hashes: hashes || HASHES } });
  let out = await run(happy({ script: post(["tests/test_a.py", "tests/test_b.py", "src/x.py"]) }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer touched src\/x\.py/);
  assert.ok(!out.labels.includes("role:fleet-test-judge:r1"));
  // a writer that reports another criterion's file
  out = await run(happy({ script: { "role:fleet-test-writer:AC1:r1": { status: "ok", criterion_id: "AC1", files: ["tests/test_a.py", "tests/test_b.py"] } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer AC1 touched tests\/test_b\.py/);
  // a change no writer reported
  out = await run(happy({ script: { "role:fleet-test-writer:AC2:r1": { status: "ok", criterion_id: "AC2", files: [] } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer touched tests\/test_b\.py.*not reported/);
  // a runner-config key changed during the writer round (an ignored conftest)
  out = await run(happy({ script: post(["tests/test_a.py", "tests/test_b.py"], H({ ...HASHES_FLAT, "tests/conftest.py": "new" })) }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer touched tests\/conftest\.py/);
});

test("2.1.0 ownership on a revise round: only the pending criterion's files may change; the tree delta is from the round start", async () => {
  const s = happy({
    script: {
      "role:fleet-test-judge:r1": { status: "ok", verdict: "revise", routed_findings: [{ target: "tests", criterion: "AC2", finding: "weak" }] },
      "role:fleet-test-writer:AC2:r2": { status: "ok", criterion_id: "AC2", files: ["tests/test_b.py"] },
      "hasher:post-writers:r2": { status: "ok", fingerprint: { head: PC, tree: "T2" }, changed: ["tests/test_a.py", "tests/test_b.py"] },
    },
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /writer touched tests\/test_a\.py/);
  // the round's base tree is the last judged state, not the plan commit
  assert.equal(inputsOf(call(out, "hasher:post-writers:r2").prompt).base_tree, "T1");
  assert.ok(!out.labels.includes("hasher:pre-writers:r2"));
});

test("2.1.0 judge fingerprint: a tree change or a changed hasher map discards the verdict", async () => {
  let out = await run(happy({ script: { "hasher:fp-post:test-judge:r1": { status: "ok", fingerprint: { head: PC, tree: "CHANGED" } } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree/);
  out = await run(
    happy({ script: { "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: FP_K1, hashes: H({ ...HASHES_FLAT, "sub/conftest.py": "ignored" }) } } }),
    ARGS,
  );
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree/);
  assert.equal(out.result.stop_gate, "fingerprint");
});

test("2.1.0 judges get freeze_tree, code_tree and plan_commit; the hasher returns a tree fingerprint", async () => {
  const out = await run(happy(), ARGS);
  const tj = inputsOf(call(out, "role:fleet-test-judge:r1").prompt);
  assert.equal(tj.plan_commit, PC);
  assert.equal(tj.freeze_tree, null);
  assert.equal(tj.code_tree, null);
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.equal(cj.plan_commit, PC);
  assert.equal(cj.freeze_tree, "T1");
  assert.equal(cj.code_tree, "K1");
  const coder = inputsOf(call(out, "role:fleet-coder:r1").prompt);
  assert.equal(coder.freeze_tree, "T1");
  assert.equal(coder.freeze_ref, PC);
  const hp = call(out, "hasher:freeze:f1").prompt;
  assert.match(hp, /GIT_INDEX_FILE/);
  assert.match(hp, /write-tree/);
  assert.ok(!/status_sha256|diff_sha256/.test(hp));
});

test("2.1.0 re-freeze after fix_tests records the tree before and after", async () => {
  const tf = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const A2 = H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" });
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [tf] },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [tf] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1", files: ["tests/test_a.py"] },
      "hasher:post-writers:r3": { status: "ok", fingerprint: FP_M3, changed: ["tests/test_a.py"], hashes: A2 },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3, hashes: A2 },
      "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: A2 },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: A2 },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2, hashes: A2 },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  // the re-entry writers start from the code judge's state: no sync, no commit
  assert.equal(inputsOf(call(out, "hasher:post-writers:r3").prompt).base_tree, "K1");
  assert.equal(out.result.refreeze_log.length, 1);
  assert.equal(out.result.refreeze_log[0].freeze_tree_before, "T1");
  assert.equal(out.result.refreeze_log[0].freeze_tree_after, "M3");
  const tj2 = inputsOf(call(out, "role:fleet-test-judge:r2").prompt);
  assert.equal(tj2.code_tree, "K1");
});

// REQUIRED_ON_OK as written in the script source
function REQUIRED_OF(src) {
  const m = /const REQUIRED_ON_OK = (\{[\s\S]*?\n\});/.exec(src);
  return Function("return " + m[1])();
}

test("2.1.0 REQUIRED_ON_OK: writer files and coder changed_paths are required arrays; commit keys are gone", async () => {
  let out = await run(happy({ script: { "role:fleet-test-writer:AC1:r1": { __raw: true, status: "ok", reason: "x", role_version: FROZEN_VERSIONS["fleet-test-writer"], role_contract: "CONTRACT: fleet-v3", criterion_id: "AC1", tests: [] } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-test-writer contract drift: missing files/);
  out = await run(happy({ script: { "role:fleet-coder:r1": { status: "ok", changed_paths: "src/x.py" } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-coder changed_paths type/);
  const req = REQUIRED_OF(SOURCE);
  assert.ok(!/"commits?"/.test(JSON.stringify(req)));
  assert.deepEqual(req["fleet-test-writer"], ["criterion_id", "tests", "files"]);
  assert.deepEqual(req["fleet-intent-judge"], ["verdict", "deviations", "coverage"]);
  assert.deepEqual(req["pr-review"], ["verdict", "findings", "touches_gate", "checked"]);
  assert.deepEqual(req["gate-change-nonweakening-sweep"], ["verdict", "units", "findings"]);
});

// ---------------------------------------------------------------- 2.1.0 auto confirm

const AUTO = { ...ARGS, confirm: "auto" };

function autoHappy(over = {}) {
  const s = happy(over);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return Object.assign(s, over.script || {});
}

test("2.1.0 confirm: a value other than ask or auto is refused before any agent", async () => {
  const out = await runOne(happy(), { ...ARGS, confirm: "yes" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /confirm/);
  assert.equal(out.calls.length, 0);
});

test("2.1.0 confirm ask (default) stays interactive: no intent judge", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation");
  assert.ok(!out.labels.some((l) => /intent|precommit-ids/.test(l)));
});

test("2.1.0 confirm auto: gates pass, the same run builds through the shared verify path", async () => {
  const out = await runOne(autoHappy(), AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.auto_confirmed, true);
  assert.equal(out.result.intent.verdict, "approve");
  assert.equal(out.labels.filter((l) => l === "preflight").length, 1);
  assert.equal(out.labels.filter((l) => l === "workspace").length, 1);
  const i = out.labels.indexOf("role:fleet-intent-judge");
  assert.ok(i > out.labels.indexOf("infra:commit-plan"));
  assert.ok(out.labels.indexOf("infra:load-ref") > i);
  assert.ok(out.labels.indexOf("infra:verify-plan") > i);
  assert.equal(call(out, "role:fleet-intent-judge").opts.agentType, "fleet:judge");
  const ij = inputsOf(call(out, "role:fleet-intent-judge").prompt);
  for (const k of ["brief", "ledger_task", "plan_path", "criteria", "plan_diff", "allowed_additions", "repo_obligations", "commands"])
    assert.ok(k in ij, "intent judge input " + k);
  assert.equal(ij.brief.sources[0].body, "task body");
  assert.equal(ij.ledger_task.body, "task body");
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.equal(pr.auto_confirmed, true);
  assert.equal(pr.intent.verdict, "approve");
  assert.equal(pr.intent.deviations[0].allowed_by, "task body: 'add f'");
  // no check_cmd: the pre-commit config is not read
  assert.ok(!out.labels.includes("infra:precommit-ids"));
  // cumulative agents: no double count of the plan part
  assert.equal(out.result.cumulative.agents, out.calls.length);
});

function autoFail(out, check) {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.failed_check, check, out.result.reason);
  assert.ok(out.result.plan_ref && out.result.plan_ref.plan_commit);
  assert.equal(out.result.plan_path, "docs/plans/x.md");
  assert.match(out.result.needs_max_section, /docs\/plans\/x\.md/);
  assert.match(out.result.needs_max_section, /re-run with the same plan_ref after a ruling/);
  assert.match(out.result.needs_max_section, new RegExp(check));
  assert.ok(!out.labels.includes("infra:load-ref"));
  assert.ok(!out.labels.some((l) => /test-writer/.test(l)));
}

test("2.1.0 G1 intent: refuse, an unbacked deviation or missing coverage fail the gate", async () => {
  const dev = (o) => ({ item: "x", allowed_by: "task", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "r", ...o });
  for (const ij of [
    { verdict: "refuse", deviations: [], coverage: { covered: true, missing: [] } },
    { verdict: "approve", deviations: [dev({ allowed_by: "" })], coverage: { covered: true, missing: [] } },
    { verdict: "approve", deviations: [dev({ fails_closed: false })], coverage: { covered: true, missing: [] } },
    { verdict: "approve", deviations: [dev({ verdict: "refuse" })], coverage: { covered: true, missing: [] } },
    { verdict: "approve", deviations: [], coverage: { covered: false, missing: ["AC for f(0)"] } },
    { status: "needs_human", reason: "task unclear" },
  ]) {
    const out = await runOne(autoHappy({ script: { "role:fleet-intent-judge": { status: "ok", reason: "r", ...ij } } }), AUTO);
    autoFail(out, "intent");
    assert.ok(out.result.intent, "intent output carried");
  }
});

test("2.1.0 G2 commands: only test_cmd and `pre-commit run <id>` hooks that exist at plan_commit", async () => {
  const withCheck = (cmd, extra) =>
    autoHappy({
      script: Object.assign(
        {
          "role:scope-and-plan": Object.assign({}, happy()["role:scope-and-plan"], {
            repo_obligations: [{ id: "fmt", kind: "other", instruction: "format", check_cmd: cmd }],
          }),
          "role:fleet-code-judge:r1": Object.assign({}, happy()["role:fleet-code-judge:r1"], { obligations_check: [{ id: "fmt", met: true, evidence: "ran" }] }),
        },
        extra || {},
      ),
    });
  let out = await runOne(withCheck("pre-commit run prettier --all-files"), AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const pi = call(out, "infra:precommit-ids");
  assert.equal(pi.opts.agentType, "fleet:judge");
  assert.match(pi.prompt, /\.pre-commit-config\.yaml/);
  assert.equal(inputsOf(pi.prompt).plan_commit, PC);
  for (const [cmd, extra] of [
    ["pre-commit run missing-hook", null],
    ["make lint", null],
    ["pre-commit run prettier --from-ref a --to-ref b", null],
    ["pre-commit run prettier", { "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "prettier"], parser: "yaml" } }],
    ["pre-commit run prettier", { "infra:precommit-ids": { status: "ok", reason: "absent", present: false, ids: [], parser: null } }],
    ["pre-commit run prettier", { "infra:precommit-ids": { status: "ok", reason: "no yaml", present: true, ids: [], parser: null, error: "PyYAML unavailable" } }],
    ["pre-commit run prettier --hook-stage manual --all-files", null],
  ]) {
    out = await runOne(withCheck(cmd, extra), AUTO);
    autoFail(out, "commands");
  }
});

test("2.1.0 G3 scope fence: infra, CI, secrets, rulesets and a foreign repo are refused", async () => {
  const planWith = (o) => autoHappy({ script: { "role:scope-and-plan": Object.assign({}, happy()["role:scope-and-plan"], o) } });
  const fence = (files) => ({ allowed_additions: { files, symbols: [], deps: [], settings: [] } });
  for (const o of [
    fence(["infra/main.tf"]),
    fence(["envs/prod.tfvars"]),
    fence(["terraform/x.py"]),
    fence(["mod/.terraform/x"]),
    fence(["k8s/deploy.yaml"]),
    fence(["deploy/kustomization.yml"]),
    fence(["charts/app/templates/svc.yaml"]),
    fence(["manifests/a.yml"]),
    fence([".github/workflows/ci.yml"]),
    fence(["config/rulesets/main.json"]),
    fence([".env.local"]),
    fence(["src/db_secret.py"]),
    fence(["certs/server.pem"]),
    fence(["keys/deploy.key"]),
    fence(["home/id_rsa.pub"]),
    fence(["aws_credentials.json"]),
    { criteria: [{ id: "AC1", text: "a", test_files: [".github/tests/test_a.py"] }] },
    { repo_obligations: [{ id: "o", kind: "other", instruction: "x", files: ["deploy/x.tf"] }] },
  ]) {
    const out = await runOne(planWith(o), AUTO);
    autoFail(out, "scope");
  }
  // the work repo must be the caller's repo
  const out = await runOne(autoHappy({ brief: { ...BRIEF, repo: "/other" } }), AUTO);
  autoFail(out, "scope");
  assert.match(out.result.needs_max_section, /\/other/);
});

test("2.1.0 build with confirm auto re-runs the gates against the current ledger rulings", async () => {
  const s = autoHappy();
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation");
  s["intake:rulings"] = { status: "ok", reason: "re-read", brief: { ...BRIEF, sources: [{ kind: "ledger", ref: "42", url: null, body: "task body\n\nRuling: no new deps" }] } };
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "violates ruling", verdict: "refuse", deviations: [], coverage: { covered: true, missing: [] } };
  s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r", confirm: "auto" };
  const build = await runOne(s, bargs);
  assert.equal(build.result.status, "needs_human");
  assert.equal(build.result.failed_check, "intent");
  assert.equal(inputsOf(call(build, "intake:rulings").prompt).input, "L42");
  assert.match(inputsOf(call(build, "role:fleet-intent-judge:rerun").prompt).ledger_task.body, /Ruling: no new deps/);
  assert.ok(!build.labels.some((l) => /test-writer/.test(l)));
  // approve on the re-run: the build proceeds
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
  const ok = await runOne(s, bargs);
  noUnscripted(ok);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.equal(ok.result.auto_confirmed, true);
  // a re-read that resolves to another task stops
  s["intake:rulings"] = { status: "ok", reason: "x", brief: { ...BRIEF, sources: [{ kind: "ledger", ref: "43", url: null, body: "b" }] } };
  const b2 = await runOne(s, bargs);
  assert.equal(b2.result.status, "needs_human");
  assert.match(b2.result.reason, /re-read/);
});

// ---------------------------------------------------------------- 2.1.0 review

test("2.1.0 review: after the draft PR, pr-review gets the PR, the diff paths and no plan reasoning; cleanup always runs", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const order = ["infra:commit:r1", "infra:push", "role:fleet-pr-opener", "infra:review-paths:v1", "role:pr-review:v1", "infra:review-cleanup:v1"];
  for (let i = 1; i < order.length; i++) assert.ok(out.labels.indexOf(order[i]) > out.labels.indexOf(order[i - 1]), order[i]);
  const rp = inputsOf(call(out, "infra:review-paths:v1").prompt);
  assert.equal(rp.base_ref, PC);
  assert.equal(rp.head_sha, CSHA(1));
  const rv = call(out, "role:pr-review:v1");
  assert.equal(rv.opts.agentType, "fleet:judge");
  const ri = inputsOf(rv.prompt);
  assert.equal(ri.mode, "self-authored");
  assert.equal(ri.fleet, true);
  assert.equal(ri.pr_number, 7);
  assert.equal(ri.pr_url, "https://github.com/o/r/pull/7");
  assert.equal(ri.repo, "o/r");
  assert.equal(ri.base_ref, PC);
  assert.equal(ri.head_sha, CSHA(1));
  assert.deepEqual(ri.changed_paths, ["src/x.py", "tests/test_a.py"]);
  assert.equal(ri.scratch_dir, "/r/.claude/worktrees/fleet-l42-add-thing/scratch");
  assert.deepEqual(ri.criteria, [{ id: "AC1", text: "behaviour 1" }, { id: "AC2", text: "behaviour 2" }]);
  for (const k of ["tldr", "plan_path", "plan_diff", "brief"]) assert.ok(!(k in ri), "no " + k);
  assert.match(call(out, "infra:review-cleanup:v1").prompt, /worktree remove --force/);
  assert.match(call(out, "infra:review-cleanup:v1").prompt, /worktree prune/);
  assert.deepEqual(out.result.review, { verdict: "approve", blocking: [], nits: [], rounds: 1, sweep: null, model: "sonnet" });
  assert.ok(!out.labels.some((l) => /sweep/.test(l)));
});

function blockingReview(extra) {
  const finding = { id: "R1", severity: "blocking", category: "fail_open", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
  return happy({
    script: Object.assign(
      {
        "role:pr-review:v1": { status: "ok", reason: "x", verdict: "approve", findings: [finding], touches_gate: false, checked: [] },
        "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
        "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
        "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
        "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
        "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
        "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
        "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
        "hasher:pre-review:v2": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
        "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
        "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
        "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
      },
      extra || {},
    ),
  });
}

test("2.1.0 review: a blocking finding is changes_requested whatever the verdict; coder, judge, a NEW commit, push, PR update, review again", async () => {
  const out = await run(blockingReview(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(f[0].target, "code");
  assert.match(f[0].finding, /empty input passes/);
  const cp = call(out, "infra:commit:r2").prompt;
  assert.match(cp, /'fix\(l42\): code round 2'/);
  assert.equal(inputsOf(cp).expected_head, CSHA(1));
  const pr2 = inputsOf(call(out, "role:fleet-pr-opener:p2").prompt);
  assert.equal(pr2.pr_number, 7);
  assert.equal(pr2.approved_sha, CSHA(2));
  assert.equal(inputsOf(call(out, "role:pr-review:v2").prompt).head_sha, CSHA(2));
  assert.equal(out.result.review.rounds, 2);
  assert.equal(out.result.review.verdict, "approve");
  assert.equal(out.result.rounds.code, 2);
});

test("2.1.0 review: a second blocking review stops with the findings; a review fix past the code cap stops at the cap", async () => {
  const b = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 9, summary: "still wrong", evidence: "e" };
  let out = await run(blockingReview({ "role:pr-review:v2": { status: "ok", reason: "x", verdict: "changes_requested", findings: [b], touches_gate: false, checked: [] } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /review/);
  assert.match(out.result.reason, /still wrong/);
  assert.equal(out.result.stop_gate, "review");
  assert.ok(out.labels.includes("infra:review-cleanup:v2"));
  // review fixes count as code rounds
  const fix = { status: "ok", verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "x" }] };
  out = await run(
    blockingReview({
      "role:fleet-code-judge:r2": fix,
      "role:fleet-coder:r3": { status: "ok", changed_paths: [] },
      "hasher:post-coder:r3": { status: "ok", fingerprint: { head: CSHA(1), tree: "K3" } },
      "role:fleet-code-judge:r3": fix,
      "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: { head: CSHA(1), tree: "K3" } },
    }),
    ARGS,
  );
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /code rounds exhausted/);
});

test("2.1.0 review: nits go to the pr-opener as review_notes", async () => {
  const nit = { id: "R1", severity: "nit", category: "other", file: "README.md", line: 1, summary: "typo", evidence: "q" };
  const s = happy({
    script: {
      "role:pr-review:v1": { status: "ok", reason: "x", verdict: "approve", findings: [nit], touches_gate: false, checked: [] },
      "role:fleet-pr-opener:notes": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:notes").prompt).review_notes, [nit]);
  assert.deepEqual(out.result.review.nits, [nit]);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("2.1.0 sweep: runs when the review flags a gate or a gate path changed; weakening is blocking", async () => {
  const sweepScript = (verdict) => ({
    "role:gate-change-nonweakening-sweep:v1": { status: "ok", reason: "s", verdict, units: [{ unit: "hook", mutation: "m", shipped_refuses: true, new_refuses: verdict !== "weakening" }], findings: [] },
    "hasher:fp-post:sweep:v1": { status: "ok", fingerprint: { head: CSHA(1), tree: "K1" } },
  });
  let out = await run(happy({ script: Object.assign({ "role:pr-review:v1": { status: "ok", reason: "x", verdict: "approve", findings: [], touches_gate: true, checked: [] } }, sweepScript("non_weakening")) }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  const sw = inputsOf(call(out, "role:gate-change-nonweakening-sweep:v1").prompt);
  assert.equal(sw.base_ref, PC);
  assert.equal(sw.head_sha, CSHA(1));
  assert.equal(sw.fleet, true);
  assert.equal(call(out, "role:gate-change-nonweakening-sweep:v1").opts.agentType, "fleet:judge");
  assert.equal(out.result.review.sweep.verdict, "non_weakening");
  for (const p of [".pre-commit-config.yaml", "src/hooks/pre_push.py", "lib/validators.py", "Makefile", ".github/workflows/ci.yml", "app/auth_policy.py", "ci/run.sh"]) {
    out = await run(happy({ script: Object.assign({ "infra:review-paths:v1": { status: "ok", reason: "l", changed_paths: [p] } }, sweepScript("non_weakening")) }), ARGS);
    assert.ok(out.labels.includes("role:gate-change-nonweakening-sweep:v1"), p);
  }
  for (const p of ["src/checkout.py", "docs/guide.md"]) {
    out = await run(happy({ script: { "infra:review-paths:v1": { status: "ok", reason: "l", changed_paths: [p] } } }), ARGS);
    assert.ok(!out.labels.includes("role:gate-change-nonweakening-sweep:v1"), p);
  }
  out = await run(happy({ script: Object.assign({ "infra:review-paths:v1": { status: "ok", reason: "l", changed_paths: ["hooks/x.py"] } }, sweepScript("weakening")) }), ARGS);
  assert.ok(out.labels.includes("role:fleet-coder:r2"), "weakening routes back to the coder");
  assert.match(JSON.stringify(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings), /weaken/);
});

test("2.1.0 review: a review that stops still gets its scratch cleanup", async () => {
  const out = await run(happy({ script: { "role:pr-review:v1": { status: "needs_human", reason: "cannot read PR" } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /cannot read PR/);
  assert.ok(out.labels.indexOf("infra:review-cleanup:v1") > out.labels.indexOf("role:pr-review:v1"));
});

test("2.1.0 review skipped when no PR exists: listed in gates_not_run", async () => {
  const out = await run(happy({ script: { "role:fleet-pr-opener": { status: "ok", reason: "x", pr_url: null, pr_number: null, created: false, template_used: null, gates_not_run_stated: true } } }), ARGS);
  assert.ok(!out.labels.includes("role:pr-review:v1"));
  assert.ok(out.result.gates_not_run.some((g) => g.gate === "review"));
  assert.equal(out.result.review, null);
});

// ---------------------------------------------------------------- 2.1.0 contract

test("2.1.0 contract fleet-v3: preflight loads ten roles; fleet-v2 pages halt", async () => {
  let out = await run(happy(), ARGS);
  const pf = inputsOf(call(out, "preflight").prompt);
  assert.deepEqual(pf.roles.slice().sort(), ROLE_NAMES.slice().sort());
  const s = happy();
  s.preflight.contract["pr-review"] = "CONTRACT: fleet-v2";
  out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /pr-review contract fleet-v2 != fleet-v3/);
});

test("2.1.0 models: a role without a usable DISPATCH line halts (no hardcoded tier); the tier used is logged", async () => {
  const s = happy();
  delete s.preflight.dispatch["gate-change-nonweakening-sweep"];
  let out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /gate-change-nonweakening-sweep has no usable DISPATCH line/);
  assert.equal(out.result.stop_gate, "contract");
  const s2 = happy();
  s2.preflight.dispatch["pr-review"] = "DISPATCH: model=opus (fallback=sonnet for small/mechanical PRs) — review depth";
  out = await run(s2, ARGS);
  assert.equal(call(out, "role:pr-review:v1").opts.model, "opus");
  assert.equal(out.result.review.model, "opus");
  assert.ok(out.result.gate_log.some((l) => /model used: role:pr-review:v1 -> opus/.test(l)));
});

test("2.1.0 hasher program: tree fingerprint leaves the real index alone and sees untracked content; changed paths from a base tree", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-tree-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "a.py");
    sh(wt, "git", "commit", "-qm", "i");
    const h0 = runHasherRaw(wt, "hashes", []);
    assert.match(h0.fingerprint.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(h0.fingerprint).sort(), ["head", "tree"]);
    writeFileSync(join(wt, "new.py"), "x\n");
    const h1 = runHasherRaw(wt, "hashes", [], h0.fingerprint.tree);
    assert.notEqual(h1.fingerprint.tree, h0.fingerprint.tree);
    assert.deepEqual(h1.changed, ["new.py"]);
    writeFileSync(join(wt, "new.py"), "y\n");
    assert.notEqual(runHasherRaw(wt, "hashes", []).fingerprint.tree, h1.fingerprint.tree);
    assert.equal(sh(wt, "git", "diff", "--cached", "--name-only"), "");
    assert.match(sh(wt, "git", "status", "--porcelain"), /\?\? new\.py/);
    // the same tree git write-tree gives after a real `git add -A`
    const before = runHasherRaw(wt, "hashes", []).fingerprint.tree;
    sh(wt, "git", "add", "-A");
    assert.equal(sh(wt, "git", "write-tree").trim(), before);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 2.1.0 security review fixes

test("2.1.0 scope fence on the REAL changes: a coder that writes CI, IaC or a secret file stops (every mode)", async () => {
  for (const p of [".github/workflows/ci.yml", "infra/main.tf", ".env.local"]) {
    const s = happy({
      script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py", p] } },
    });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", p);
    assert.equal(out.result.stop_gate, "scope", p);
    assert.ok(out.result.reason.includes(p), out.result.reason);
    assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), p);
    assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)), p);
  }
  // the post-coder listing diffs the whole change from the first freeze's HEAD
  const out = await run(happy(), ARGS);
  assert.equal(inputsOf(call(out, "hasher:post-coder:r1").prompt).base_tree, PC);
  // writers' changed paths are fenced too (limited to test files, so it does not fire in practice)
  const w = await run(happy({ criteria: [{ id: "AC1", text: "a", test_files: [".github/tests/test_a.py"] }] }), ARGS);
  assert.equal(w.result.status, "needs_human");
  assert.equal(w.result.stop_gate, "scope");
});

test("2.1.0 the hook surface is frozen: .pre-commit-config.yaml, local hook entries, core.hooksPath and the hooks dir", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-hooks-");
  try {
    writeFileSync(
      join(wt, ".pre-commit-config.yaml"),
      "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        language: system\n        entry: python3 scripts/chk.py\n",
    );
    sh(wt, "mkdir", "-p", "scripts");
    writeFileSync(join(wt, "scripts", "chk.py"), "print(1)\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes;
    assert.ok(".pre-commit-config.yaml" in a.files);
    assert.ok("scripts/chk.py" in a.files, "local hook entry file is frozen");
    assert.equal(a.git["core.hooksPath"], "UNSET");
    // editing the config, the entry script, adding a hook file or setting hooksPath: all changes
    writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos: []\n");
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.files[".pre-commit-config.yaml"], a.files[".pre-commit-config.yaml"]);
    sh(wt, "git", "checkout", "-q", "--", ".");
    writeFileSync(join(wt, "scripts", "chk.py"), "print(2)\n");
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.files["scripts/chk.py"], a.files["scripts/chk.py"]);
    sh(wt, "git", "checkout", "-q", "--", ".");
    const hooksDir = sh(wt, "git", "rev-parse", "--git-path", "hooks").trim();
    const hd = hooksDir.startsWith("/") ? hooksDir : join(wt, hooksDir);
    sh(wt, "mkdir", "-p", hd);
    writeFileSync(join(hd, "pre-commit"), "#!/bin/sh\nexit 0\n");
    const b = runHasherRaw(wt, "hashes", []).hashes;
    assert.ok("hooks/pre-commit" in b.git, "a file in the hooks dir is frozen");
    sh(wt, "git", "config", "core.hooksPath", ".githooks");
    assert.equal(runHasherRaw(wt, "hashes", []).hashes.git["core.hooksPath"], ".githooks");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 a coder that edits .pre-commit-config.yaml or adds a hook file is a hash violation", async () => {
  for (const [k, v] of [[".pre-commit-config.yaml", "edited"], ["git:hooks/pre-commit", "new"], ["git:core.hooksPath", ".githooks"]]) {
    const frozen = H({ ...HASHES_FLAT, ".pre-commit-config.yaml": "pc", "git:core.hooksPath": "UNSET" });
    const s = hashViolation(H({ ...HASHES_FLAT, ".pre-commit-config.yaml": "pc", "git:core.hooksPath": "UNSET", [k]: v }));
    s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes: frozen };
    s["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2, hashes: frozen };
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), k);
    assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, new RegExp(k.replace(/[.]/g, "\\.")));
  }
});

test("2.1.0 G3 behaviour: a check_cmd hook named for helm passes G2 and is refused by the scope fence", async () => {
  const s = autoHappy({
    script: {
      "role:scope-and-plan": Object.assign({}, happy()["role:scope-and-plan"], {
        repo_obligations: [{ id: "docs", kind: "docs", instruction: "regen", check_cmd: "pre-commit run helm-docs" }],
      }),
      "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["helm-docs"], parser: "yaml" },
    },
  });
  const out = await runOne(s, AUTO);
  autoFail(out, "scope");
  assert.ok(out.labels.includes("infra:precommit-ids"));
});

test("2.1.0 an auto build reports mode build", async () => {
  const out = await runOne(autoHappy(), AUTO);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.mode, "build");
});

test("2.1.0 write-back follows the review (the run-state milestone order)", async () => {
  const out = await run(happy({ script: { "role:pr-review:v1": { status: "needs_human", reason: "cannot read PR" } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(!out.labels.includes("infra:ledger-writeback"));
  const ok = await run(happy(), ARGS);
  assert.ok(ok.labels.indexOf("infra:ledger-writeback") > ok.labels.indexOf("role:pr-review:v1"));
});

test("2.1.0 re-plan keeps the uncommitted work under a non-branch ref to the tree: no commit object", async () => {
  const s = planWrong([{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: y" }]);
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "awaiting_confirmation");
  const rp = call(out, "infra:replan-reset").prompt;
  assert.ok(!/commit-tree/.test(rp));
  assert.match(rp, /update-ref <superseded_tree_ref> <expected_tree>/);
  assert.equal(inputsOf(rp).superseded_tree_ref, "refs/fleet/l42-add-thing/superseded-1-tree");
  assert.equal(out.result.superseded_tree_ref, "refs/fleet/l42-add-thing/superseded-1-tree");
});

test("2.1.0 agent cap 100: an auto run with a revise round and a review fix round passes 60 agents and completes", async () => {
  const crit = criteria(8);
  const s = autoHappy({ criteria: crit });
  const b = blockingReview();
  const base = happy();
  for (const k of Object.keys(b)) if (!(k in base) || k === "role:pr-review:v1") s[k] = b[k];
  s["role:fleet-test-judge:r1"] = {
    status: "ok",
    verdict: "revise",
    routed_findings: crit.map((c) => ({ target: "tests", criterion: c.id, finding: "x" })),
  };
  for (const c of crit) s["role:fleet-test-writer:" + c.id + ":r2"] = { status: "ok", criterion_id: c.id };
  s["hasher:post-writers:r2"] = { status: "ok", fingerprint: FP_TESTS };
  s["role:fleet-test-judge:r2"] = { status: "ok", verdict: "approve", routed_findings: [] };
  s["hasher:fp-post:test-judge:r2"] = { status: "ok", fingerprint: FP_TESTS };
  const out = await runOne(s, AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.review.rounds, 2);
  assert.ok(out.calls.length > 60, "dispatched " + out.calls.length);
  assert.ok(out.calls.length <= 100);
  assert.equal(out.result.agents, out.calls.length);
});

test("2.1.0 every agent cap hit is logged", () => {
  // every cap check in the script logs its hit: reserve and the soft paths
  const hits = SOURCE.match(/agent cap " \+ MAX_AGENTS \+ " reached/g) || [];
  assert.equal(hits.length, 3);
  assert.match(SOURCE, /const MAX_AGENTS = 100;/);
});

test("2.1.0 git config exec vectors are frozen: local config, include targets, .gitattributes, info/attributes", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-gitcfg-");
  try {
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes;
    assert.ok("config:local" in a.git, "local config frozen");
    assert.ok("info/attributes" in a.git, "info/attributes frozen");
    // core.fsmonitor set by the coder
    sh(wt, "git", "config", "core.fsmonitor", "./x.sh");
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.git["config:local"], a.git["config:local"]);
    sh(wt, "git", "config", "--unset", "core.fsmonitor");
    assert.equal(runHasherRaw(wt, "hashes", []).hashes.git["config:local"], a.git["config:local"]);
    // a .gitattributes filter driver
    writeFileSync(join(wt, ".gitattributes"), "*.py filter=evil\n");
    assert.ok(".gitattributes" in runHasherRaw(wt, "hashes", []).hashes.files, "a new .gitattributes is a new key");
    sh(wt, "rm", ".gitattributes");
    // an include.path target: the file it names is frozen
    writeFileSync(join(wt, "inc.cfg"), "[core]\n\tpager = cat\n");
    sh(wt, "git", "config", "include.path", join(wt, "inc.cfg"));
    const b = runHasherRaw(wt, "hashes", []).hashes;
    const k = "config:include:" + join(wt, "inc.cfg");
    assert.ok(k in b.git, "include target frozen: " + Object.keys(b.git).join(", "));
    writeFileSync(join(wt, "inc.cfg"), "[core]\n\tfsmonitor = ./x.sh\n");
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.git[k], b.git[k]);
    // branch tracking (set by the workflow's own push -u) is not frozen
    const c = runHasherRaw(wt, "hashes", []).hashes.git["config:local"];
    sh(wt, "git", "config", "branch.master.remote", "origin");
    sh(wt, "git", "config", "remote.origin.gh-resolved", "base");
    assert.equal(runHasherRaw(wt, "hashes", []).hashes.git["config:local"], c);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 local hook args and -m modules are frozen with their package's .py files", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-hookargs-");
  try {
    writeFileSync(
      join(wt, ".pre-commit-config.yaml"),
      "repos:\n  - repo: local\n    hooks:\n      - id: x\n        name: x\n        language: system\n        entry: python\n        args: [scripts/x.py]\n      - id: y\n        name: y\n        language: system\n        entry: python3 -m tools.chk\n",
    );
    sh(wt, "mkdir", "-p", "scripts", "tools");
    writeFileSync(join(wt, "scripts", "x.py"), "print(1)\n");
    writeFileSync(join(wt, "scripts", "helper.py"), "h = 1\n");
    writeFileSync(join(wt, "tools", "__init__.py"), "");
    writeFileSync(join(wt, "tools", "chk.py"), "print(2)\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes.files;
    for (const f of ["scripts/x.py", "scripts/helper.py", "tools/chk.py", "tools/__init__.py"]) assert.ok(f in a, f + " frozen");
    writeFileSync(join(wt, "scripts", "x.py"), "print('pwned')\n");
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.files["scripts/x.py"], a["scripts/x.py"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 the commit step and the tree command run git with fsmonitor off, no system config and the frozen hooks path", async () => {
  const out = await run(happy(), ARGS);
  const cp = call(out, "infra:commit:r1").prompt;
  assert.match(cp, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(cp, /-c core\.fsmonitor=false/);
  assert.match(cp, /-c core\.hooksPath=/);
  assert.ok(!/git -C <main_worktree> commit -m/.test(cp), "the commit runs through the hardened git prefix");
  assert.equal(inputsOf(cp).hooks_path, null);
  const hp = call(out, "hasher:freeze:f1").prompt;
  assert.match(hp, /core\.fsmonitor=false/);
  assert.match(hp, /GIT_CONFIG_NOSYSTEM/);
});

test("2.1.0 ignored paths are listed: a .pth in a venv is frozen, tool caches are not", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-ign2-");
  try {
    writeFileSync(join(wt, ".gitignore"), ".venv/\n.pytest_cache/\nout/\n");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes;
    assert.deepEqual(a.ignored, {});
    sh(wt, "mkdir", "-p", ".venv/lib/python3.12/site-packages", ".pytest_cache", "out");
    writeFileSync(join(wt, ".venv/lib/python3.12/site-packages/evil.pth"), "import os\n");
    writeFileSync(join(wt, ".venv/lib/python3.12/site-packages/mod.py"), "x = 1\n");
    writeFileSync(join(wt, ".pytest_cache", "x"), "c\n");
    writeFileSync(join(wt, "out", "out.txt"), "o\n");
    const b = runHasherRaw(wt, "hashes", []).hashes;
    assert.ok(".venv/lib/python3.12/site-packages/evil.pth" in b.ignored, Object.keys(b.ignored).join(", "));
    assert.ok(!(".venv/lib/python3.12/site-packages/mod.py" in b.ignored), "inside a venv only startup hooks");
    assert.ok(!(".pytest_cache/x" in b.ignored), "tool caches are not frozen");
    assert.ok("out/out.txt" in b.ignored, "any other ignored file is");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 a writer or a coder that writes an ignored path is stopped", async () => {
  const ign = (p) => Object.assign(H(HASHES_FLAT), { ignored: { [p]: "h" } });
  let out = await run(happy({ script: { "hasher:post-writers:r1": (prompt) => ({ status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: ign(".venv/lib/x/site-packages/evil.pth") }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /ignored path written: \.venv\/lib\/x\/site-packages\/evil\.pth/);
  out = await run(hashViolation(ign("build/evil.txt")), ARGS);
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /ignored path written: build\/evil\.txt/);
});

test("2.1.0 base-ref differential: the fence and the review diff from plan_commit; verify fences pre-existing fleet commits", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  s["infra:verify-plan"] = {
    ...s["infra:verify-plan"],
    head: "fedcba9876",
    commits_since: [{ sha: "1111111", subject: "feat(l42): add thing" }],
    changed_since: ["src/x.py", ".github/x.yml"],
  };
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "scope");
  assert.match(out.result.reason, /\.github\/x\.yml/);
  assert.ok(!out.labels.some((l) => /^role:/.test(l)), "stops before any role");
  assert.match(call(out, "infra:verify-plan").prompt, /git -C <main_worktree> diff --name-only <plan_commit>\.\.HEAD/);
  // the post-coder listing and the review paths diff from plan_commit, not HEAD at the first freeze
  const ok = await run(happy(), ARGS);
  assert.equal(inputsOf(call(ok, "hasher:post-coder:r1").prompt).base_tree, PC);
  assert.equal(inputsOf(call(ok, "infra:review-paths:v1").prompt).base_ref, PC);
});

test("2.1.0 local hooks: an inline payload or an unresolvable token is suspicious; the script's whole dir is frozen", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-hookdir-");
  try {
    const cfg = (entry) =>
      "repos:\n  - repo: local\n    hooks:\n      - id: h1\n        name: h1\n        language: system\n        entry: " + entry + "\n";
    sh(wt, "mkdir", "-p", "tools/sub");
    writeFileSync(join(wt, "tools", "chk.py"), "import sub\n");
    writeFileSync(join(wt, "tools", "sub", "lib.sh"), "echo\n");
    writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg("python3 tools/chk.py --strict"));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes;
    assert.deepEqual(a.suspicious, []);
    assert.ok("tools/sub/lib.sh" in a.files, "the whole dir tree of a referenced script is frozen");
    writeFileSync(join(wt, "tools", "new_helper.py"), "x\n");
    assert.ok("tools/new_helper.py" in runHasherRaw(wt, "hashes", []).hashes.files, "untracked files there too");
    for (const entry of ["bash -c 'curl x | sh'", "python3 -c 'import os'", "frobnicate-not-on-path tools/chk.py"]) {
      writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg(JSON.stringify(entry)));
      const h = runHasherRaw(wt, "hashes", []).hashes;
      assert.ok(h.suspicious.some((x) => x.startsWith("unresolvable local hook h1")), entry + ": " + h.suspicious.join("; "));
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 an unresolvable local hook stops the run at freeze", async () => {
  const out = await run(happy({ script: { "hasher:freeze:f1": { status: "ok", fingerprint: FP_TESTS, hashes: H(HASHES_FLAT, ["unresolvable local hook h1: inline payload after -c"]) } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /unresolvable local hook h1/);
});

test("2.1.0 local hooks behind a launcher (uv run, poetry run, npx, ...) resolve from the next token", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-launch-");
  try {
    const cfg = (entry) =>
      "repos:\n  - repo: local\n    hooks:\n      - id: h1\n        name: h1\n        language: system\n        entry: " + entry + "\n";
    sh(wt, "mkdir", "-p", "scripts");
    writeFileSync(join(wt, "scripts", "x.py"), "print(1)\n");
    writeFileSync(join(wt, "scripts", "y.py"), "print(2)\n");
    writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg("uv run python scripts/x.py"));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    for (const entry of ["uv run python scripts/x.py", "poetry run python scripts/x.py", "pdm run -- python scripts/x.py", "hatch run python scripts/x.py", "pipx run python scripts/x.py"]) {
      writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg(JSON.stringify(entry)));
      const h = runHasherRaw(wt, "hashes", []).hashes;
      assert.deepEqual(h.suspicious, [], entry);
      assert.ok("scripts/x.py" in h.files && "scripts/y.py" in h.files, entry + ": scripts/ frozen");
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 ignored build and coverage output is not frozen; *.egg-info still is", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-build-");
  try {
    writeFileSync(join(wt, ".gitignore"), "build/\ndist/\nhtmlcov/\n.eggs/\ncoverage.xml\n.coverage.*\njunit*.xml\n*.egg-info/\n");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    sh(wt, "mkdir", "-p", "build/lib", "dist", "htmlcov", ".eggs", "pkg.egg-info");
    for (const f of ["build/lib/x.py", "dist/x.whl", "htmlcov/index.html", ".eggs/x", "coverage.xml", ".coverage.host.1", "junit-report.xml", "pkg.egg-info/entry_points.txt"])
      writeFileSync(join(wt, f), "x\n");
    const ign = runHasherRaw(wt, "hashes", []).hashes.ignored;
    assert.deepEqual(Object.keys(ign), ["pkg.egg-info/entry_points.txt"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 launcher hooks freeze the script tables; npm run needs the script; npx/uvx need a repo-declared tool", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-scripts-");
  try {
    const cfg = (entry) =>
      "repos:\n  - repo: local\n    hooks:\n      - id: h1\n        name: h1\n        language: system\n        entry: " + entry + "\n";
    writeFileSync(join(wt, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "jest" }, devDependencies: { eslint: "9" } }));
    writeFileSync(
      join(wt, "pyproject.toml"),
      '[project]\nname = "x"\ndependencies = ["ruff>=0.5"]\n\n[project.scripts]\nmycli = "x:main"\n\n[tool.hatch.envs.default.scripts]\ncheck = "ruff check"\n',
    );
    writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg("npm run lint"));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes;
    assert.deepEqual(a.suspicious, []);
    for (const k of ["package.json#scripts", "pyproject.toml#project.scripts", "pyproject.toml#tool.poetry.scripts", "pyproject.toml#tool.pdm.scripts", "pyproject.toml#tool.hatch.envs.*.scripts"])
      assert.ok(k in a.sections, k + " frozen: " + Object.keys(a.sections).join(", "));
    // the coder edits scripts.lint: a section change
    writeFileSync(join(wt, "package.json"), JSON.stringify({ scripts: { lint: "true", test: "jest" }, devDependencies: { eslint: "9" } }));
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.sections["package.json#scripts"], a.sections["package.json#scripts"]);
    sh(wt, "git", "checkout", "-q", "--", ".");
    const sus = (entry) => {
      writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg(JSON.stringify(entry)));
      return runHasherRaw(wt, "hashes", []).hashes.suspicious;
    };
    assert.ok(sus("npm run missing").some((x) => /unresolvable local hook h1: npm script missing/.test(x)));
    assert.deepEqual(sus("npx eslint ."), [], "npx tool in devDependencies");
    assert.deepEqual(sus("uvx ruff check"), [], "uvx tool in pyproject dependencies");
    assert.deepEqual(sus("uv run mycli"), [], "uv run of a [project.scripts] entry");
    assert.ok(sus("npx ls").some((x) => /unresolvable local hook h1: ls/.test(x)), "a PATH lookup alone is not enough for npx");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 build-output exclusions apply only at the top level; egg-info is always frozen", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-toplvl-");
  try {
    writeFileSync(join(wt, ".gitignore"), "build/\ncoverage.xml\n*.egg-info/\n");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    sh(wt, "mkdir", "-p", "build/lib", "src/build", "sub", "build/x.egg-info");
    for (const f of ["build/lib/ok.py", "src/build/x.py", "coverage.xml", "sub/coverage.xml", "build/x.egg-info/entry_points.txt"])
      writeFileSync(join(wt, f), "x\n");
    const ign = Object.keys(runHasherRaw(wt, "hashes", []).hashes.ignored).sort();
    assert.deepEqual(ign, ["build/x.egg-info/entry_points.txt", "src/build/x.py", "sub/coverage.xml"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 a coder that edits package.json scripts (a launcher hook's table) is a hash violation", async () => {
  const frozen = H({ ...HASHES_FLAT, "package.json#scripts": "s1" });
  const s = hashViolation(H({ ...HASHES_FLAT, "package.json#scripts": "s2" }));
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes: frozen };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2, hashes: frozen };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /package\.json#scripts/);
});

// ---------------------------------------------------------------- 2.1.0 run-state resume

// The state JSON a run-state write step carries (quoted heredoc body).
function stateJsonOf(prompt) {
  const m = /<<'FLEET_STATE_JSON'\n([\s\S]*?)\nFLEET_STATE_JSON/.exec(prompt);
  return m ? JSON.parse(m[1]) : null;
}

// A build run that records every run-state write into `states` (gate -> JSON).
function recording(s, states) {
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  return s;
}

// Build-mode script for a re-run on the approved commit, reading `st`.
function rerunScript(s, st, over) {
  s["infra:verify-plan"] = {
    ...happy()["infra:verify-plan"],
    head: st.approved_sha,
    commits_since: [{ sha: st.approved_sha, subject: "feat(l42): add thing" }],
    changed_since: ["src/x.py", "tests/test_a.py"],
  };
  s["infra:read-state"] = Object.assign(
    { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true },
    (over && over.read) || {},
  );
  s["hasher:resume"] = Object.assign({ status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: HASHES }, (over && over.hasher) || {});
  s["infra:push"] = (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha });
  return s;
}

const NO_REWORK = /^(role:fleet-test-writer|role:fleet-coder|role:fleet-code-judge|role:fleet-test-judge|hasher:pre-writers|hasher:freeze|infra:commit:)/;

test("2.1.0 run-state: every milestone writes the state ref, in order, with a mktag object and no hooks", async () => {
  const states = {};
  const out = await run(recording(happy(), states), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const order = ["infra:state:committed:r1", "infra:push", "infra:state:pushed:p1", "role:fleet-pr-opener", "infra:state:pr_open:p1", "role:pr-review:v1", "infra:state:reviewed:v1", "infra:ledger-writeback", "infra:state:written_back"];
  for (let i = 1; i < order.length; i++) assert.ok(out.labels.indexOf(order[i]) > out.labels.indexOf(order[i - 1]), order[i]);
  const p = call(out, "infra:state:committed:r1").prompt;
  assert.match(p, /mktag/);
  assert.match(p, /update-ref 'refs\/fleet\/l42\/state'/);
  assert.match(p, /GIT_CONFIG_NOSYSTEM=1/);
  assert.equal(states.committed.plan_commit, PC);
  assert.equal(states.committed.approved_sha, CSHA(1));
  assert.equal(states.committed.code_tree, "K1");
  assert.match(states.committed.maps_digest, /^[0-9a-f]{64}$/);
  assert.equal(states.pr_open.pr_number, 7);
  assert.equal(states.written_back.ledger_status, "ok");
});

test("2.1.0 resume: a push that failed resumes at push on the re-run; no writer, coder or judge runs", async () => {
  const s = recording(happy(), {});
  const states = {};
  recording(s, states);
  s["infra:push"] = { status: "failed", reason: "ssh: permission denied (publickey)" };
  const plan = await runOne(s, ARGS);
  const first = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(first.result.status, "failed");
  assert.equal(states.committed.last_gate, "committed");
  rerunScript(s, states.committed);
  const second = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  noUnscripted(second);
  assert.equal(second.result.status, "ok", second.result.reason);
  assert.ok(!second.labels.some((l) => NO_REWORK.test(l)), second.labels.join(", "));
  assert.ok(second.logs.some((l) => /resuming at push/.test(l)));
  assert.equal(inputsOf(call(second, "infra:push").prompt).approved_sha, CSHA(1));
  assert.ok(second.labels.includes("role:fleet-pr-opener"));
  assert.ok(second.labels.includes("role:pr-review:v1"));
  assert.equal(second.result.pr_url, "https://github.com/o/r/pull/7");
});

test("2.1.0 resume: a run stopped after the PR opened resumes at review", async () => {
  const states = {};
  const s = recording(happy(), states);
  s["role:pr-review:v1"] = { status: "needs_human", reason: "cannot read PR" };
  const plan = await runOne(s, ARGS);
  const first = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(first.result.status, "needs_human");
  assert.ok(!first.labels.includes("infra:ledger-writeback"), "write-back follows the review");
  rerunScript(s, states.pr_open);
  s["role:pr-review:v1"] = happy()["role:pr-review:v1"];
  const second = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  noUnscripted(second);
  assert.equal(second.result.status, "ok", second.result.reason);
  assert.ok(second.logs.some((l) => /resuming at review/.test(l)));
  assert.ok(!second.labels.some((l) => NO_REWORK.test(l) || l === "infra:push" || l === "role:fleet-pr-opener"), second.labels.join(", "));
  assert.equal(inputsOf(call(second, "role:pr-review:v1").prompt).pr_number, 7);
  assert.ok(second.labels.includes("infra:ledger-writeback"));
});

test("2.1.0 resume: written_back returns the recorded result with no role agent", async () => {
  const states = {};
  const s = recording(happy(), states);
  const plan = await runOne(s, ARGS);
  await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  rerunScript(s, states.written_back);
  const again = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  noUnscripted(again);
  assert.equal(again.result.status, "ok", again.result.reason);
  assert.equal(again.result.pr_url, "https://github.com/o/r/pull/7");
  assert.equal(again.result.ledger_status, "ok");
  assert.equal(again.result.resumed_at, "done");
  assert.ok(!again.labels.some((l) => /^role:/.test(l) || l === "infra:push" || /^infra:state:/.test(l)), again.labels.join(", "));
});

test("2.1.0 resume: a run-state that does not match stops with run-state mismatch; never re-runs writers", async () => {
  const states = {};
  const s = recording(happy(), states);
  s["infra:push"] = { status: "failed", reason: "ssh" };
  const plan = await runOne(s, ARGS);
  await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  const st = states.committed;
  for (const [over, re] of [
    [{ read: { head: "abcabcabca" } }, /run-state mismatch: HEAD/],
    [{ read: { head_tree: "OTHER" } }, /run-state mismatch: tree/],
    [{ read: { clean: false } }, /run-state mismatch: worktree not clean/],
    [{ read: { message: JSON.stringify(Object.assign({}, st, { ref_sha256: "0".repeat(64) })) } }, /run-state mismatch: ref_sha256/],
    [{ hasher: { hashes: H({ ...HASHES_FLAT, "tests/test_a.py": "WEAKENED" }) } }, /run-state mismatch: frozen maps/],
  ]) {
    rerunScript(s, st, over);
    const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
    assert.equal(out.result.status, "needs_human", String(re));
    assert.match(out.result.reason, re);
    assert.ok(!out.labels.some((l) => NO_REWORK.test(l)), out.labels.join(", "));
  }
});

test("2.1.0 resume: no run-state but build commits on the branch stops as unresumable", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  s["infra:verify-plan"] = { ...s["infra:verify-plan"], head: "fedcba9876", commits_since: [{ sha: "fedcba9876", subject: "feat(l42): add thing" }], changed_since: ["src/x.py"] };
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /approved but unresumable: branch has build commits without run-state; push manually or delete branch/);
  assert.ok(!out.labels.some((l) => NO_REWORK.test(l)));
});

test("2.1.0 resume: a stale run-state of another plan is ignored when HEAD is the plan commit", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: "1234567", message: JSON.stringify({ plan_commit: "9999999", last_gate: "committed" }), head: PC, head_tree: "T0", clean: true };
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.some((l) => /stale run-state/.test(l)));
});

test("2.1.0 run-state program: the write command and the read program round-trip in a real repo", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-state-");
  try {
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const m = /WRITE_STATE_SH_BEGIN\n([\s\S]*?)\n\/\/ WRITE_STATE_SH_END/.exec(SOURCE);
    assert.ok(m, "WRITE_STATE_SH markers");
    const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
    const writeStateCmd = Function("q", "return (" + m[1].trim().replace(/^function writeStateCmd/, "function").replace(/shQuote/g, "q") + ")")(q);
    const st = { plan_commit: "abc", last_gate: "committed", note: "it's \"quoted\"" };
    const cmd = writeStateCmd(wt, "refs/fleet/l42/state", JSON.stringify(st));
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    assert.equal(sh(wt, "git", "cat-file", "-t", "refs/fleet/l42/state").trim(), "tag");
    assert.equal(sh(wt, "git", "tag", "-l").trim(), "", "no tag name left");
    const rm = /READ_STATE_PY_BEGIN\n([\s\S]*?)\n\/\/ READ_STATE_PY_END/.exec(SOURCE);
    const body = rm[1].replace(/^const READ_STATE_PY = String\.raw`\n?/, "").replace(/`;?\s*$/, "");
    const rr = spawnSync("python3", ["-I", "-", wt, "refs/fleet/l42/state"], { input: body, encoding: "utf8" });
    assert.equal(rr.status, 0, rr.stderr);
    const got = JSON.parse(rr.stdout);
    assert.equal(got.exists, true);
    assert.equal(got.target, head);
    assert.deepEqual(JSON.parse(got.message), st);
    assert.equal(got.head, head);
    assert.equal(got.clean, true);
    const none = JSON.parse(spawnSync("python3", ["-I", "-", wt, "refs/fleet/l43/state"], { input: body, encoding: "utf8" }).stdout);
    assert.equal(none.exists, false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 resume survives a transport fix: remote, url, credential, http and sshCommand config are not frozen", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-transport-");
  try {
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const a = runHasherRaw(wt, "hashes", []).hashes.git["config:local"];
    sh(wt, "git", "remote", "add", "origin", "git@github.com:o/r.git");
    sh(wt, "git", "config", "remote.origin.url", "https://github.com/o/r.git");
    sh(wt, "git", "config", "core.sshCommand", "ssh -i ~/.ssh/other");
    sh(wt, "git", "config", "url.git@github.com:.insteadOf", "https://github.com/");
    sh(wt, "git", "config", "credential.helper", "store");
    sh(wt, "git", "config", "http.postBuffer", "1048576");
    assert.equal(runHasherRaw(wt, "hashes", []).hashes.git["config:local"], a);
    sh(wt, "git", "config", "core.fsmonitor", "./x.sh");
    assert.notEqual(runHasherRaw(wt, "hashes", []).hashes.git["config:local"], a);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 2.1.0 run-state ref snapshot

const FREF = "refs/fleet/l42/state";
const withFleetRef = (sha) => H({ ...HASHES_FLAT, ["git:fleetref:" + FREF]: sha });

test("2.1.0 run-state refs are snapshotted into the git map by the hasher", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-fref-");
  try {
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    assert.ok(!Object.keys(runHasherRaw(wt, "hashes", []).hashes.git).some((k) => k.startsWith("fleetref:")));
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    sh(wt, "git", "update-ref", FREF, head);
    assert.equal(runHasherRaw(wt, "hashes", []).hashes.git["fleetref:" + FREF], head);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.0 a coder that creates a run-state ref is a violation", async () => {
  const out = await run(hashViolation(withFleetRef("1234567890abcdef1234567890abcdef12345678")), ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /run-state ref touched by role: refs\/fleet\/l42\/state/);
});

test("2.1.0 a judge or a writer that touches a run-state ref is stopped", async () => {
  let out = await run(happy({ script: { "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: FP_K1, hashes: withFleetRef("ab".repeat(20)) } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree.*run-state ref touched by role/);
  out = await run(happy({ script: { "hasher:post-writers:r1": { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: withFleetRef("ab".repeat(20)) } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /run-state ref touched by role: refs\/fleet\/l42\/state/);
});

test("2.1.0 the script's own run-state write is no violation: the snapshot follows saveState", async () => {
  // review round 1 requests changes after the committed/pushed/pr_open writes moved the state ref
  const s = blockingReview();
  const moved = withFleetRef("f".repeat(40));
  s["hasher:pre-review:v1"] = { status: "ok", fingerprint: { head: CSHA(1), tree: "K1" }, hashes: moved };
  s["hasher:fp-post:pr-review:v1"] = { status: "ok", fingerprint: { head: CSHA(1), tree: "K1" }, hashes: moved };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: moved };
  s["hasher:fp-post:code-judge:r2"] = { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: moved };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 2);
});

test("2.1.0 the resume digest ignores the run-state ref itself", async () => {
  const states = {};
  const s = recording(happy(), states);
  s["infra:push"] = { status: "failed", reason: "ssh" };
  const plan = await runOne(s, ARGS);
  await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  rerunScript(s, states.committed, { hasher: { hashes: withFleetRef("f".repeat(40)) } });
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(out.result.status, "ok", out.result.reason);
});

// ---------------------------------------------------------------- 2.1.1 role pins, IaC hooks

test("2.1.1 a live-shaped role page with no trailing newline parses: DISPATCH tier and CONTRACT on the last line", async () => {
  // agent_prompt_save strips the final newline: the CONTRACT line can be the
  // page's last line, and the DISPATCH value carries the rest of the page
  const page = "DISPATCH: model=opus (fallback=sonnet) — review depth scales with blast radius\nCONTRACT: fleet-v3";
  assert.ok(!page.endsWith("\n"));
  const s = withDispatch(
    happy({
      script: {
        "role:fleet-code-judge:r1": null,
        "role:fleet-code-judge:r1:fallback": { status: "ok", verdict: "approve", routed_findings: [] },
      },
    }),
    Object.assign({}, DISPATCH, { "fleet-code-judge": page }),
  );
  s.preflight.contract["fleet-code-judge"] = page.split("\n")[1];
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(call(out, "role:fleet-code-judge:r1").opts.model, "opus");
  assert.equal(call(out, "role:fleet-code-judge:r1:fallback").opts.model, "sonnet");
  assert.match(call(out, "preflight").prompt, /last line/);
});

test("2.1.1 tflint and terragrunt are forbidden words in a check_cmd", async () => {
  for (const cmd of ["make tflint", "scripts/run-terragrunt.sh", "pre-commit run tflint-all --all-files"]) {
    const s = withObligations([Object.assign({}, OB_BUMP, { check_cmd: cmd })]);
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(cmd) + " " + out.result.reason);
    const ob = JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0];
    assert.equal(ob.check_cmd_rejected, cmd);
    assert.match(ob.check_rejected_reason, /forbidden tool/, cmd);
  }
});

const IAC_REPO = "https://github.com/antonbabenko/pre-commit-terraform";
function iacCfg(hooks, defaults) {
  return {
    status: "ok",
    reason: "read",
    present: true,
    parser: "yaml",
    sha256: "c".repeat(64),
    default_stages: defaults || null,
    hooks: hooks.map((h) => Object.assign({ repo: IAC_REPO, name: null, entry: null, args: [], stages: null }, h)),
  };
}
function iacScript(cfg, extra) {
  return happy({ script: Object.assign({ "infra:iac-hooks": cfg }, extra || {}) });
}

test("2.1.1 IaC: a pre-commit-terraform hook with no stages runs at pre-push too: commit, then stop before the push", async () => {
  const out = await run(iacScript(iacCfg([{ id: "terraform_fmt" }])), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /pre-push hooks run IaC tooling \(terraform_fmt\); push by hand/);
  assert.ok(out.labels.includes("infra:commit:r1"), "the commit may run");
  assert.ok(out.labels.includes("infra:state:committed:r1"), "last_gate committed is recorded");
  assert.ok(!out.labels.some((l) => /^infra:push/.test(l)), out.labels.join(", "));
  const c = call(out, "infra:iac-hooks");
  assert.equal(c.opts.agentType, "fleet:judge");
  assert.equal(inputsOf(c.prompt).plan_commit, PC);
  // the local Bash guard blocks these words: the command must not carry them
  assert.doesNotMatch(c.prompt, /terraform|tofu|tflint|terragrunt|\btfp\b/i);
  // read once per build, after verify and before the writers
  assert.equal(out.build.labels.filter((l) => /^infra:iac-hooks/.test(l)).length, 1);
  assert.ok(out.build.labels.indexOf("infra:iac-hooks") > out.build.labels.indexOf("infra:verify-plan"));
  assert.ok(out.build.labels.indexOf("infra:iac-hooks") < out.build.labels.indexOf("hasher:pre-writers:r1"));
});

test("2.1.1 IaC: the same hook pinned to the commit stage does not stop the push", async () => {
  for (const stages of [["pre-commit"], ["commit"]]) {
    const out = await run(iacScript(iacCfg([{ id: "terraform_fmt", stages }])), ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", JSON.stringify(stages) + " " + out.result.reason);
    assert.ok(out.labels.includes("infra:push"));
  }
});

test("2.1.1 IaC: default_stages [pre-commit] keeps an unstaged IaC hook off pre-push", async () => {
  const out = await run(iacScript(iacCfg([{ id: "terraform_validate" }, { id: "terraform_docs" }], ["pre-commit"])), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:push"));
});

test("2.1.1 IaC: a non-fmt/validate/tflint/docs IaC hook at commit stage stops before the commit", async () => {
  for (const hooks of [
    [{ id: "terraform_plan_check", stages: ["pre-commit"] }],
    [{ id: "infracost_breakdown", repo: IAC_REPO, stages: ["commit"] }],
    [{ id: "plan", repo: "local", entry: "scripts/run.sh", args: ["terragrunt", "plan"], stages: ["pre-commit"] }],
    // an allowlisted id still runs during git commit at commit-msg: not exempt
    [{ id: "terraform_fmt", stages: ["commit-msg"] }],
  ]) {
    const out = await run(iacScript(iacCfg(hooks)), ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "needs_human", JSON.stringify(hooks) + " " + out.result.reason);
    assert.equal(out.result.stop_gate, "iac");
    assert.match(out.result.reason, /commit hooks run IaC tooling/);
    assert.ok(out.labels.includes("role:fleet-code-judge:r1"), "the build ran up to the commit step");
    assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)), out.labels.join(", "));
  }
});

test("2.1.1 IaC: the plan commit runs commit hooks too: a non-exempt IaC hook stops plan mode before it", async () => {
  for (const hooks of [[{ id: "terraform_plan_check", stages: ["pre-commit"] }], [{ id: "terraform_fmt", stages: ["commit-msg"] }]]) {
    const s = happy({ script: { "infra:iac-hooks:commit-plan": iacCfg(hooks) } });
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "iac");
    assert.match(out.result.reason, /plan commit: commit hooks run IaC tooling/);
    assert.ok(!out.labels.includes("infra:commit-plan"), out.labels.join(", "));
    const c = call(out, "infra:iac-hooks:commit-plan");
    assert.equal(c.opts.agentType, "fleet:judge");
    assert.equal(inputsOf(c.prompt).plan_commit, "HEAD");
  }
  // exempt fmt at pre-commit, even with a pre-push stage: the plan commit runs
  const ok = await runOne(happy({ script: { "infra:iac-hooks:commit-plan": iacCfg([{ id: "terraform_fmt" }]) } }), ARGS);
  noUnscripted(ok);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(ok.labels.indexOf("infra:iac-hooks:commit-plan") < ok.labels.indexOf("infra:commit-plan"));
});

test("2.1.1 IaC: a repo with no IaC hooks keeps the unchanged flow", async () => {
  const cfg = iacCfg([
    { id: "prettier", repo: "https://github.com/pre-commit/mirrors-prettier" },
    { id: "ruff", repo: "https://github.com/astral-sh/ruff-pre-commit", args: ["--fix"] },
  ]);
  const base = await run(happy(), ARGS);
  const out = await run(iacScript(cfg), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.labels, base.labels);
});

test("2.1.1 IaC: an unreadable or unparseable config fails closed before the commit", async () => {
  for (const cfg of [
    { status: "ok", reason: "no yaml", present: true, parser: null, error: "PyYAML unavailable", sha256: "c".repeat(64), default_stages: null, hooks: [] },
    { status: "ok", reason: "bad", present: true, parser: "yaml", error: "unparseable: x", sha256: "c".repeat(64), default_stages: null, hooks: [] },
    { status: "ok", reason: "odd", present: true, parser: "yaml", sha256: "c".repeat(64), default_stages: null },
  ]) {
    const out = await run(iacScript(cfg), ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "iac");
    assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)));
  }
});

test("2.1.1 IaC: the commit step re-checks against the frozen copy of the config", async () => {
  const withCfgHash = (h) => {
    const frozen = H({ ...HASHES_FLAT, ".pre-commit-config.yaml": h });
    return {
      "hasher:freeze:f1": { status: "ok", fingerprint: FP_TESTS, hashes: frozen },
      "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: frozen },
    };
  };
  const cfg = iacCfg([{ id: "prettier", repo: "https://github.com/pre-commit/mirrors-prettier" }]);
  let out = await run(iacScript(cfg, withCfgHash("c".repeat(64))), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  out = await run(iacScript(cfg, withCfgHash("d".repeat(64))), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /frozen/);
  assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)));
});

test("2.1.1 IaC: a resumed run at push still stops before a pre-push IaC hook", async () => {
  const states = {};
  const s = recording(happy(), states);
  s["infra:push"] = { status: "failed", reason: "ssh" };
  const plan = await runOne(s, ARGS);
  await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(states.committed.last_gate, "committed");
  rerunScript(s, states.committed);
  s["infra:iac-hooks"] = iacCfg([{ id: "terraform_fmt" }]);
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "iac");
  assert.ok(!out.labels.some((l) => /^infra:push/.test(l)), out.labels.join(", "));
});

test("2.1.1 IaC: confirm auto refuses at G3 any repo with an IaC hook", async () => {
  for (const hooks of [[{ id: "terraform_fmt", stages: ["pre-commit"] }], [{ id: "tofu_fmt", repo: "https://github.com/tofuutils/pre-commit-opentofu" }]]) {
    const out = await runOne(autoHappy({ script: { "infra:iac-hooks:plan": iacCfg(hooks) } }), AUTO);
    noUnscripted(out);
    autoFail(out, "scope");
    assert.match(out.result.reason, /repo hooks run IaC tooling/);
    assert.equal(call(out, "infra:iac-hooks:plan").opts.agentType, "fleet:judge");
  }
  const ok = await runOne(autoHappy(), AUTO);
  noUnscripted(ok);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.ok(ok.labels.includes("infra:iac-hooks:plan"));
});

const HAVE_YAML = spawnSync("python3", ["-c", "import yaml"]).status === 0;

test("2.1.1 IaC hook reader program: raw hook fields, stages, sha256; absent config; bad rev", { skip: !HAVE_YAML }, () => {
  const wt = scratchRepo("fleet-iac-");
  try {
    writeFileSync(join(wt, "a.txt"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "no config");
    const bare = sh(wt, "git", "rev-parse", "HEAD").trim();
    const cfg =
      "default_stages: [commit]\n" +
      "repos:\n" +
      "  - repo: https://github.com/antonbabenko/pre-commit-terraform\n" +
      "    rev: v1.96.1\n" +
      "    hooks:\n" +
      "      - id: terraform_fmt\n" +
      "      - id: terraform_tflint\n" +
      "        args: [--args=--config=x, 3]\n" +
      "        stages: [pre-push]\n" +
      "  - repo: local\n" +
      "    hooks:\n" +
      "      - id: lint\n" +
      "        name: Lint\n" +
      "        entry: scripts/lint.sh\n" +
      "        language: script\n";
    writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "config");
    const m = /IAC_HOOKS_PY_BEGIN\n([\s\S]*?)\n\/\/ IAC_HOOKS_PY_END/.exec(SOURCE);
    assert.ok(m, "IAC_HOOKS_PY markers");
    const body = m[1].replace(/^const IAC_HOOKS_PY = String\.raw`\n?/, "").replace(/`;?\s*$/, "");
    assert.doesNotMatch(body, /terraform|tofu|tflint|terragrunt|\btfp\b/i, "the Bash guard blocks these words");
    const runPy = (rev) => {
      const r = spawnSync("python3", ["-I", "-", wt, rev], { input: body, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const got = runPy("HEAD");
    assert.equal(got.present, true);
    assert.equal(got.parser, "yaml");
    assert.equal(got.sha256, sha256(cfg));
    assert.deepEqual(got.default_stages, ["commit"]);
    assert.deepEqual(got.hooks, [
      { repo: "https://github.com/antonbabenko/pre-commit-terraform", id: "terraform_fmt", name: null, entry: null, args: [], stages: null },
      { repo: "https://github.com/antonbabenko/pre-commit-terraform", id: "terraform_tflint", name: null, entry: null, args: ["--args=--config=x", "3"], stages: ["pre-push"] },
      { repo: "local", id: "lint", name: "Lint", entry: "scripts/lint.sh", args: [], stages: null },
    ]);
    const none = runPy(bare);
    assert.equal(none.present, false);
    assert.equal(none.sha256, "MISSING");
    const bad = runPy("0".repeat(40));
    assert.equal(bad.present, true, "a bad rev is not an absent config");
    assert.ok(bad.error);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
