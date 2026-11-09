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
// Run: node --test plugins/*/tests/*.test.mjs (the shell expands the list;
// `node --test <dir>` fails on Node 22 and later: it runs the directory as a file)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  PY_SPAWN_LIMITS,
  spawnSync,
  HERE,
  SCRIPT_PATH,
  SOURCE,
  AsyncFunction,
  compile,
  ThrowingDate,
  SafeMath,
  inputsOf,
  FROZEN_VERSIONS,
  CONTRACT_LINE,
  ROLE_NAMES,
  REQUIRED_DEFAULTS,
  NONCE,
  withNonce,
  RELAY_KEYS,
  tfGateRelay,
  pathRecheckOut,
  remoteUrlOut,
  relayDigestOf,
  scanEntry,
  fillArgs,
  withRelayDigest,
  runOne,
  run,
  call,
  noUnscripted,
  ARGS,
  PC,
  PSHA,
  BRIEF,
  FP_PRE,
  FP_TESTS,
  FP_PLAN,
  FP_K1,
  FP_K2,
  FP_M3,
  CSHA,
  H,
  HASHES_FLAT,
  HASHES,
  DEFAULT_HASHES,
  CONFIG_ONLY,
  criteria,
  sha256,
  refContentOf,
  refEntry,
  planRefsOf,
  commitStub,
  loadStub,
  commitStepStub,
  triedFor,
  happy,
  hasherPy,
  sh,
  runHasherRaw,
  runHasher,
  py,
  HAVE_PY,
  scratchRepo,
  canon,
  planRefFor,
  buildArgs,
  gitEnv,
  extractFn,
  extractPy,
  scriptCheckPy,
  stateJsonOf,
  CHUNK,
  chunksOf,
  defsOut,
  SCRIPTS_DIR,
  SCRIPTS_SRC,
  PROGRAMS,
  PROGRAM_BODIES,
  PROGRAMS_TEXT,
  programSha,
  programOf,
  chunkedContentOf,
  verifyStub,
  allScripts,
  planRefWriteCmd,
  stateWriteCmd,
} from "./harness.mjs";


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

test("an ingested plan: task id p<sha256(plan path)[:8]>, slug from the brief title, plan_path forwarded in the brief", async () => {
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
  assert.equal(ws.branch, "fleet/p" + sha256("docs/plans/Foo_Bar-2026-11-04.md").slice(0, 8) + "-foo-bar");
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
  // 4.0.0 (1987): the freeze ref is frozen too (read-only for the coder)
  assert.deepEqual(coder.frozen_config_sections, { "pyproject.toml#tool.pytest": "hp", "git:fleetref:refs/fleet/l42/freeze": "T1" });
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

test("4.0.0 short path: a small no-new-behaviour plan runs one writer and keeps every gate", async () => {
  const s = happy();
  s["role:scope-and-plan"].est_diff_lines = 10;
  s["role:scope-and-plan"].new_behaviour = false;
  s["role:fleet-test-writer:short:r1"] = {
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [{ name: "a", covers: "AC1: a" }, { name: "b", covers: "AC2: b" }],
    files: ["tests/test_a.py", "tests/test_b.py"],
  };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.equal(out.result.path, "short");
  assert.ok(out.labels.includes("role:plan-audit"));
  assert.ok(out.labels.includes("role:fleet-test-judge:r1"));
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r1"));
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
  // the cap is per run: the build run alone stays within it; the PATH
  // re-checks (3.1.1) are not counted against it
  const work = out.build.calls.filter((c) => !/^infra:path-check:/.test(c.label));
  assert.ok(out.build.calls.length > work.length, "the re-checks ran");
  assert.ok(work.length <= 100, "dispatched " + work.length);
  assert.ok(work.length > 60, "the old cap of 60 would have stopped earlier");
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
  ]) {
    assert.ok(p.includes(needle), "hasher prompt mentions " + needle);
  }
  // 4.0.0: the program runs from the shipped file, which builds the temp-index tree
  assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/hasher.py'"));
  const prog = readFileSync(join(SCRIPTS_SRC, "hasher.py"), "utf8");
  for (const needle of ["'read-tree', 'HEAD'", "'add', '-A'", "write-tree"]) assert.ok(prog.includes(needle), "hasher.py has " + needle);
  const h = inputsOf(p);
  // 2.1.4: the plan ref is a git object (frozen as a fleetref), not a file
  assert.deepEqual(h.test_files.sort(), ["tests/test_a.py", "tests/test_b.py"]);
  assert.ok(!("mode" in h));
});


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

test("approve with a gates_not_run list: the code-judge list plus every script default it leaves out (3.1.0: a union)", async () => {
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
  const want = list.concat([
    { gate: "mutation", reason: inputsOf(call(out, "role:fleet-code-judge:r1").prompt).script_findings.reason },
    { gate: "security_scan", reason: inputsOf(call(out, "role:fleet-code-judge:r1").prompt).script_findings.reason },
  ]);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener").prompt).gates_not_run, want);
  assert.deepEqual(out.result.gates_not_run, want);
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

// 4.0.0 (1990): an explicit tier on every infra agent, haiku or sonnet by
// INFRA_TIER (v4_s3 checks each label's tier)
test("infra agents run on an explicit tier", async () => {
  const out = await run(withDispatch(happy(), DISPATCH), ARGS);
  for (const c of out.calls)
    if (!c.label.startsWith("role:")) assert.ok(c.opts.model === "sonnet" || c.opts.model === "haiku", c.label + " " + c.opts.model);
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
  s.preflight.versions["fleet-coder"] = FROZEN_VERSIONS["fleet-coder"] - 1;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, new RegExp("role fleet-coder version " + (FROZEN_VERSIONS["fleet-coder"] - 1) + " < frozen " + FROZEN_VERSIONS["fleet-coder"]));
  assert.deepEqual(out.labels, ["preflight"]);
});

test("S-8: a higher role version is logged as prose-only and recorded", async () => {
  const s = happy();
  const cj = FROZEN_VERSIONS["fleet-code-judge"];
  s.preflight.versions["fleet-code-judge"] = cj + 1;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.ok(out.result.gate_log.some((l) => l.includes("role fleet-code-judge v" + (cj + 1) + " > frozen v" + cj + ": prose-only changes assumed")));
  assert.equal(out.result.role_versions["fleet-code-judge"], cj + 1);
  assert.equal(out.result.role_versions["fleet-coder"], FROZEN_VERSIONS["fleet-coder"]);
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
  assert.deepEqual(inputsOf(call(out, "hasher:freeze:f1").prompt).test_files, ["tests/test_a.py"]);
  assert.ok(!inputsOf(call(out, "role:fleet-test-judge:r1").prompt).criteria.some((c) => c.id === "AC9"));
  const pr = inputsOf(call(out, "role:fleet-pr-opener").prompt);
  assert.ok(pr.criteria.some((c) => c.id === "AC9" && c.test_files.length === 0));
});


// ---------------------------------------------------------------- contract marker + output asserts

test("contract marker: missing or fleet-v1 in preflight halts; fleet-v4 passes", async () => {
  const missing = happy();
  missing.preflight.contract["fleet-coder"] = null;
  let out = await run(missing, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role fleet-coder contract null != fleet-v4/);
  assert.deepEqual(out.labels, ["preflight"]);

  const v1 = happy();
  v1.preflight.contract["plan-audit"] = "CONTRACT: fleet-v1";
  out = await run(v1, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role plan-audit contract fleet-v1 != fleet-v4/);
  assert.deepEqual(out.labels, ["preflight"]);

  out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok");
});

test("contract marker: a v1 marker in build-mode preflight halts before any build step", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation");
  s.preflight.contract["fleet-coder"] = "CONTRACT: fleet-v1";
  // 4.0.0 (1990): a build loads the role pages in preflight only with
  // fresh_preflight (else they come from the plan ref; v4_s3 covers that path)
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r", fresh_preflight: true });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract fleet-v1 != fleet-v4/);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("contract marker: a role runner that loaded another contract is discarded", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"].role_contract = "CONTRACT: fleet-v1";
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-test-judge/);
  assert.match(out.result.reason, /contract fleet-v1 != fleet-v4/);
  assert.ok(!out.labels.includes("hasher:freeze:f1"));
});

test("contract drift: planner ok output missing a required key stops", async () => {
  const s = happy();
  const p = Object.assign({}, s["role:scope-and-plan"], { __raw: true, role_version: FROZEN_VERSIONS["scope-and-plan"], role_contract: CONTRACT_LINE });
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
    role_contract: CONTRACT_LINE,
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
  const pr = Object.assign({}, s["role:fleet-pr-opener"], { __raw: true, role_version: FROZEN_VERSIONS["fleet-pr-opener"], role_contract: CONTRACT_LINE });
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
  s["role:fleet-coder:r1"] = { __raw: true, role_version: FROZEN_VERSIONS["fleet-coder"], role_contract: CONTRACT_LINE, status: "needs_human", reason: "test AC1 wrong" };
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
  assert.deepEqual(inputsOf(c.prompt), { input: "L42", repo: "/r", project: "o/r", ledger: "yadgar" });
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
  // the caller gets a tiny ref; the full sealed ref is a local tag object at refs/fleet/l42/plan
  const tiny = r.plan_ref;
  assert.deepEqual(Object.keys(tiny).sort(), ["branch", "plan_commit", "plan_ref", "ref_sha256", "repo"]);
  assert.equal(tiny.branch, "fleet/l42-add-thing");
  assert.equal(tiny.plan_commit, PC);
  assert.equal(tiny.plan_ref, "refs/fleet/l42/plan");
  assert.equal(tiny.repo, "/r");
  const content = out.calls.length && richPlanStore(out);
  assert.equal(tiny.ref_sha256, sha256(content));
  const ref = JSON.parse(content);
  for (const k of ["branch", "plan_path", "plan_sha256", "criteria", "brief", "plan_facts", "history", "seal"]) assert.ok(k in ref, k);
  assert.equal(ref.plan_sha256, PSHA);
  assert.deepEqual(ref.brief, BRIEF);
  assert.deepEqual(ref.criteria.map((c) => c.id), ["AC1", "AC2"]);
  assert.ok(!content.includes("held_out_examples") && !content.includes(SECRET), "the plan ref holds no held-out example");
  // held-out examples are dropped: never returned
  assert.ok(!JSON.stringify(r).includes('"held_out_examples":'), "no held_out_examples key in the result");
  assert.ok(!JSON.stringify(r).includes(SECRET));
  // the plan is committed locally; nothing is pushed, opened or posted
  assert.deepEqual(out.labels, [
    "preflight",
    "intake",
    "workspace",
    // 4.0.0 (1985): the push-access dry run, after its own PATH re-check
    "infra:path-check:push-probe",
    "infra:push-probe",
    "infra:branch-scan",
    "infra:load-parked",
    "role:scope-and-plan",
    "infra:hook-surface:plan",
    "infra:path-check:format-plan",
    "infra:format-plan",
    "infra:path-check:plan-audit",
    "role:plan-audit",
    "infra:stage-plan",
    "infra:path-check:commit-plan",
    "infra:commit-plan",
    "infra:verify-plan-commit",
  ]);
  const cp = call(out, "infra:commit-plan").prompt;
  assert.match(cp, /LOCALLY/);
  assert.match(cp, /Never push/);
  assert.match(cp, /plan\(l42\): add-thing/);
  assert.deepEqual(inputsOf(cp), {
    worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main",
    branch: "fleet/l42-add-thing",
    plan_path: "docs/plans/x.md",
    task_id: "l42",
    slug: "add-thing",
    reuse_head: null,
    chunk_dir: "/r/.claude/worktrees/fleet-l42-add-thing/scratch/plan-ref-n1-0000001",
  });
  // 2.1.4: the commit holds the plan doc only; the sealed ref is a tag object
  // (git mktag, no hook) at refs/fleet/l42/plan; nothing under .fleet/ is written
  assert.ok(!cp.includes(".fleet/"), "commit-plan names no .fleet/ path");
  assert.ok(!/add -f|add --force/.test(cp));
  assert.match(cp, /mktag/);
  // 4.0.0: the shipped writer program makes the tag object, hooks off
  assert.ok(cp.includes("python3 -I '" + SCRIPTS_DIR + "/plan_ref_write.py' '/r/.claude/worktrees/fleet-l42-add-thing/main' 'l42'"));
  const w = readFileSync(join(SCRIPTS_SRC, "plan_ref_write.py"), "utf8");
  assert.match(w, /'core\.hooksPath=\/dev\/null'/);
  assert.match(w, /ref = 'refs\/fleet\/' \+ target \+ '\/plan'/);
  assert.match(cp, /add -- <plan_path>`/);
});

test("2.1.4 plan mode: a plan commit that holds anything but plan_path fails, no plan_ref", async () => {
  for (const files of [["docs/plans/x.md", ".fleet/l42/plan_ref.json"], [".fleet/l42/plan_ref.json"], [], ["docs/plans/x.md", "src/x.py"]]) {
    const s = happy();
    const base = s["infra:verify-plan-commit"];
    s["infra:verify-plan-commit"] = (prompt) => {
      const r = base(prompt);
      r.plan_files.files = files;
      return r;
    };
    const out = await runOne(s, ARGS);
    assert.ok(out.result.status === "failed" || out.result.status === "needs_human", JSON.stringify(files));
    assert.match(out.result.reason, /plan commit holds/);
    assert.ok(!("plan_ref" in out.result) || out.result.plan_ref == null);
  }
});

test("2.1.4 identical re-plan: an unchanged plan doc on a plan-only HEAD reuses that commit, no new commit, ref valid", async () => {
  const s = happy({ script: scanOut([planCommit(PC, [PLAN_MD])], [refEntry("refs/fleet/l42/plan", PC, priorRef(PLAN_MD))]) });
  // the agent finds the staged plan equal to HEAD's and does not commit
  s["infra:commit-plan"] = (prompt) => {
    const i = inputsOf(prompt);
    const c = refContentOf(prompt);
    s.__store[PC] = c;
    s.__store.__planHead = PC;
    s.__store.__commit = { head: i.reuse_head, planSha: PSHA };
    return { status: "ok", reason: "reused", reused: true, head: i.reuse_head, tag_sha: "7".repeat(40) };
  };
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const cp = call(out, "infra:commit-plan");
  assert.equal(inputsOf(cp.prompt).reuse_head, PC);
  assert.match(cp.prompt, /diff --cached --quiet -- <plan_path>/);
  assert.ok(!/commit --allow-empty|commit [^`]*--allow-empty/.test(cp.prompt.replace(/Never --allow-empty/g, "")), "never --allow-empty");
  assert.equal(out.result.plan_ref.plan_commit, PC);
  assert.equal(out.result.plan_ref.ref_sha256, sha256(s.__store[PC]));
  assert.ok(out.logs.some((l) => /reused plan commit/.test(l)));
  // the build loads the reused ref
  const b = await runOne(s, buildArgs(out.result.plan_ref));
  noUnscripted(b);
  assert.equal(b.result.status, "ok", b.result.reason);
});

test("2.1.4 identical re-plan: reuse is offered only for a plan-only HEAD, and a reuse claim must name it", async () => {
  // no earlier plan commit: no reuse offered
  let out = await runOne(happy(), ARGS);
  assert.equal(inputsOf(call(out, "infra:commit-plan").prompt).reuse_head, null);
  // a claimed reuse with no reuse_head, or on another head, fails
  for (const [scan, head] of [[null, PC], [[planCommit(PC, [PLAN_MD])], "9999999"]]) {
    const s = happy({ script: scan ? scanOut(scan, [refEntry("refs/fleet/l42/plan", PC, priorRef(PLAN_MD))]) : {} });
    const base = s["infra:commit-plan"];
    s["infra:commit-plan"] = (prompt) => Object.assign(base(prompt), { reused: true, head });
    out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", JSON.stringify([scan, head]) + " " + out.result.reason);
    assert.match(out.result.reason, /reuse/);
  }
});

test("2.1.4 re-plan in build (plan_wrong) offers the approved plan commit for reuse", async () => {
  const s = planWrong([{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: y" }]);
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  assert.equal(inputsOf(call(out, "infra:commit-plan:replan").prompt).reuse_head, PC);
});

test("2.1.4 run-state write: update-ref runs with core.hooksPath=/dev/null (no reference-transaction hook)", () => {
  // 4.0.0: the shipped writer program runs every git call with hooks off
  const w = readFileSync(join(SCRIPTS_SRC, "state_write.py"), "utf8");
  assert.match(w, /^G = \['git', '-c', 'core\.fsmonitor=false', '-c', 'core\.hooksPath=\/dev\/null', '-C', wt\]$/m);
  assert.match(w, /^git\('update-ref', target, tag\)$/m);
  assert.doesNotMatch(w, /subprocess\.run\(\['git'/);
});

test("2.1.4 plan mode: the written plan ref must target the plan commit and read back as the sealed ref", async () => {
  const cases = [
    (r) => Object.assign(r, { refs: r.refs.map((e) => Object.assign(e, { target: "9999999" })) }),
    (r) => Object.assign(r, { refs: [] }),
    (r) => Object.assign(r, { refs: r.refs.map((e) => Object.assign(e, { type: "commit" })) }),
    (r) => Object.assign(r, { refs: r.refs.map((e) => Object.assign(e, { sha256: "e".repeat(64) })) }),
    (r, store) => {
      const o = JSON.parse(store[PC]);
      o.tldr = "changed";
      const c = JSON.stringify(o) + "\n";
      r.refs[0] = refEntry("refs/fleet/l42/plan", PC, c);
      delete r.refs[0].content;
      return r;
    },
    // 4.0.0: a ref that is not the tag object the writer printed
    (r) => Object.assign(r, { refs: r.refs.map((e) => Object.assign(e, { tag_sha: "8".repeat(40) })) }),
  ];
  for (const f of cases) {
    const s = happy();
    const base = s["infra:verify-plan-commit"];
    s["infra:verify-plan-commit"] = (prompt) => {
      const r = base(prompt);
      f(r.plan_ref, s.__store);
      return r;
    };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", f.toString());
    assert.ok(!("plan_ref" in out.result) || out.result.plan_ref == null);
  }
});

// the sealed ref the plan run wrote as the tag message
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
      role_contract: CONTRACT_LINE,
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


test("plan ref seal is the sha256 of its canonical JSON (utf-8, non-ASCII included)", async () => {
  const s = happy({ brief: { ...BRIEF, title: "Add Thing — ünïcode 🚀", description: "em — dash" } });
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[tiny.plan_commit]);
  const o = Object.assign({}, ref);
  delete o.seal;
  assert.equal(ref.seal, createHash("sha256").update(canon(o), "utf8").digest("hex"));
});

test("tiny plan_ref round trip: build mode loads the plan ref object and uses it", async () => {
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
    task_id: "l42",
    plan_ref: "refs/fleet/l42/plan",
    mode: "chunks",
  });
  // the reader program runs read-only: cat-file, never a checkout or a write
  assert.ok(load.prompt.includes("python3 -I '" + SCRIPTS_DIR + "/plan_ref.py'"));
  assert.match(load.prompt, /cat-file/);
  assert.ok(out.labels.indexOf("infra:load-ref") < out.labels.indexOf("infra:verify-plan"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r1").prompt).criteria.map((c) => c.id), ["AC1", "AC2"]);
});

test("a malformed tiny plan_ref is refused before any agent", async () => {
  const tiny = await planRefFor(happy());
  for (const bad of [
    { ...tiny, ref_sha256: "x" },
    { ...tiny, plan_commit: "P1" },
    { ...tiny, plan_ref: "../etc/plan" },
    { ...tiny, plan_ref: "refs/fleet/l43/plan" },
    { ...tiny, plan_ref: "refs/fleet/l42/plan; rm -rf /" },
    { ...tiny, plan_ref: "refs/fleet/l42/plan-1" },
    { ...tiny, branch: "main" },
    { ...tiny, repo: "r" },
  ]) {
    const out = await runOne(happy(), buildArgs(bad));
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.equal(out.calls.length, 0);
  }
});

test("2.1.4 a legacy plan_ref with ref_path (2.0.1-2.1.3) is refused before any agent: re-run plan", async () => {
  const tiny = await planRefFor(happy());
  const legacy = { branch: tiny.branch, plan_commit: tiny.plan_commit, ref_path: ".fleet/l42/plan_ref.json", ref_sha256: tiny.ref_sha256, repo: tiny.repo };
  for (const bad of [legacy, { ...tiny, ref_path: ".fleet/l42/plan_ref.json" }]) {
    const out = await runOne(happy(), buildArgs(bad));
    assert.equal(out.result.status, "needs_human");
    assert.match(out.result.reason, /plan_ref predates 2\.1\.4; re-run plan/);
    assert.equal(out.calls.length, 0);
  }
});

test("2.1.4 a missing plan ref stops after the load, before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  s.__store.__planHead = null;
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("2.1.4 a plan ref that targets another commit stops after the load, before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  s.__store["9999999"] = s.__store[PC];
  s.__store.__planHead = "9999999";
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
  // a ref that is not an annotated tag (a plain commit ref) is refused too
  const t = happy();
  const tiny2 = await planRefFor(t);
  t["infra:load-ref"] = () => ({ status: "ok", reason: "read", refs: planRefsOf(t.__store).map((e) => Object.assign(e, { type: "commit", content: null, sha256: null })) });
  const out2 = await runOne(t, buildArgs(tiny2));
  assert.equal(out2.result.status, "needs_human");
  assert.match(out2.result.reason, /plan ref missing or changed; re-run plan/);
});

test("a wrong ref_sha256 stops after the load, before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs({ ...tiny, ref_sha256: "e".repeat(64) }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("a tampered plan ref tag message stops before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  // the tag message at refs/fleet/l42/plan differs from the one the plan run wrote
  const ref = JSON.parse(s.__store[PC]);
  ref.criteria[0].text = "something else";
  s.__store[PC] = JSON.stringify(ref) + "\n";
  let out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan/);
  assert.ok(!out.labels.some((l) => ROLE_LABEL.test(l)));
  // a ref whose bytes match the tiny ref but whose inner seal is broken
  out = await runOne(s, buildArgs({ ...tiny, ref_sha256: sha256(s.__store[PC]) }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan.*seal mismatch/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("a plan ref for another branch or repo stops before any role", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  for (const over of [{ repo: "/other" }, { branch: "fleet/l42-other-slug" }]) {
    const out = await runOne(s, buildArgs({ ...tiny, ...over }));
    assert.equal(out.result.status, "needs_human", JSON.stringify(over));
    assert.match(out.result.reason, /plan ref missing or changed; re-run plan.*does not match plan_ref/);
    assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
  }
});

test("a load step that copies the right sha256 but changed content stops", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[PC]);
  ref.tldr = "other";
  s["infra:load-ref"] = { status: "ok", reason: "read", refs: [Object.assign(refEntry("refs/fleet/l42/plan", PC, JSON.stringify(ref) + "\n"), { sha256: tiny.ref_sha256 })] };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan/);
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("a load step that returns content not matching its own sha256 stops", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  s["infra:load-ref"] = { status: "ok", reason: "read", refs: [Object.assign(refEntry("refs/fleet/l42/plan", PC, s.__store[PC]), { sha256: "f".repeat(64) })] };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.deepEqual(out.labels, ["preflight", "workspace", "infra:load-ref"]);
});

test("commit-plan: a plan hash that differs from the staged one fails", async () => {
  const s = happy({ script: { "infra:stage-plan": { status: "ok", reason: "staged", plan_sha256: "9".repeat(64) } } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /staged/);
});

test("2.1.4 the plan ref is frozen as a fleetref, not a file: the coder never sees .fleet/", async () => {
  const s = happy();
  const withRef = H({ ...HASHES_FLAT, "git:fleetref:refs/fleet/l42/plan": "7".repeat(40) });
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes: withRef };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: withRef };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const fz = inputsOf(call(out, "hasher:freeze:f1").prompt);
  assert.ok(!fz.test_files.some((f) => f.includes(".fleet/")));
  const coder = call(out, "role:fleet-coder:r1").prompt;
  assert.ok(!coder.includes(".fleet/"), "the coder's view names no .fleet/ path");
});

test("2.1.4 a coder round that moves the plan ref is rejected", async () => {
  const frozenRef = H({ ...HASHES_FLAT, "git:fleetref:refs/fleet/l42/plan": "7".repeat(40) });
  const s = hashViolation(H({ ...HASHES_FLAT, "git:fleetref:refs/fleet/l42/plan": "8".repeat(40) }));
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_PLAN, hashes: frozenRef };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2, hashes: frozenRef };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /refs\/fleet\/l42\/plan/);
});

// ---------------------------------------------------------------- plan mode on a built branch

// A sealed ref as an earlier plan run of task l42 wrote it (the tag message).
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

function planCommit(sha, files, over) {
  return Object.assign({ sha, subject: "plan(l42): add-thing", files }, over || {});
}

// branch-scan output: commits plus the plan refs the reader lists.
function scanOut(commits, refs) {
  return { "infra:branch-scan": { status: "ok", reason: "scanned", commits, refs: refs || [] } };
}

test("plan mode on a branch with build commits stops before the planner", async () => {
  const tampered = JSON.parse(priorRef(PLAN_MD));
  tampered.plan_path = "README.md";
  const R1 = (content) => [refEntry("refs/fleet/l42/plan", "1111111", content || priorRef(PLAN_MD))];
  for (const [commits, refs] of [
    [[{ sha: "1111111", subject: "feat(x): add it", files: ["src/x.py"] }], R1()],
    // the right subject with the wrong files
    [[planCommit("1111111", [PLAN_MD, "src/x.py"])], R1()],
    [[planCommit("1111111", ["src/x.py"])], R1()],
    // any other .md file is not the plan
    [[planCommit("1111111", ["README.md"])], R1()],
    [[planCommit("1111111", [PLAN_MD, "README.md"])], R1()],
    [[planCommit("1111111", ["docs/plans/other.md"])], R1()],
    // 2.1.4: a .fleet/ path in the commit makes it a build commit (no ref file any more)
    [[planCommit("1111111", [PLAN_MD, ".fleet/l42/plan_ref.json"])], R1()],
    [[planCommit("1111111", [".fleet/l42/plan_ref.json"])], R1()],
    // another task's plan subject
    [[planCommit("1111111", [PLAN_MD], { subject: "plan(l43): other" })], R1()],
    // no files; no plan ref; a plan ref at another commit; a plan ref whose seal is broken
    [[planCommit("1111111", [])], R1()],
    [[planCommit("1111111", [PLAN_MD])], []],
    [[planCommit("1111111", [PLAN_MD])], [refEntry("refs/fleet/l42/plan", "2222222", priorRef(PLAN_MD))]],
    [[planCommit("1111111", ["README.md"])], R1(JSON.stringify(tampered) + "\n")],
    // a plan ref of another task, or one whose sha256 does not match its message
    [[planCommit("1111111", [PLAN_MD])], R1(priorRef(PLAN_MD, { task_id: "l43", branch: "fleet/l43-add-thing" }))],
    [[planCommit("1111111", [PLAN_MD])], [Object.assign(R1()[0], { sha256: "e".repeat(64) })]],
    // a ref that is not a plan ref name
    [[planCommit("1111111", [PLAN_MD])], [refEntry("refs/fleet/l42/state", "1111111", priorRef(PLAN_MD))]],
    [[planCommit("1111111", [PLAN_MD]), { sha: "2222222", subject: "test(AC1): behaviour 1", files: ["tests/test_a.py"] }], R1()],
  ]) {
    const s = happy({ script: scanOut(commits, refs) });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(commits.map((c) => [c.subject, c.files])) + " " + JSON.stringify(refs.map((r) => [r.name, r.target])));
    assert.match(out.result.reason, /branch has build commits; run build, or delete branch/);
    assert.ok(!out.labels.includes("role:scope-and-plan"));
    assert.ok(!out.labels.includes("infra:commit-plan"));
  }
});

test("2.1.4 plan mode on a plan-only branch: the classifier accepts plan commits via their plan refs and re-plans", async () => {
  for (const [commits, refs] of [
    [[planCommit("1111111", [PLAN_MD])], [refEntry("refs/fleet/l42/plan", "1111111", priorRef(PLAN_MD))]],
    [[planCommit("1111111", ["./" + PLAN_MD])], [refEntry("refs/fleet/l42/plan", "1111111", priorRef(PLAN_MD))]],
    // a re-plan: the earlier plan ref is kept as plan-<n>; each names its own plan path
    [
      [planCommit("1111111", ["docs/plans/old.md"]), planCommit("2222222", [PLAN_MD])],
      [refEntry("refs/fleet/l42/plan", "2222222", priorRef(PLAN_MD)), refEntry("refs/fleet/l42/plan-1", "1111111", priorRef("docs/plans/old.md"))],
    ],
  ]) {
    const s = happy({ script: scanOut(commits, refs) });
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
    task_id: "l42",
  });
  // the same plan-ref reader program lists every refs/fleet/<id>/plan* ref
  assert.ok(scan.prompt.includes("python3 -I '" + SCRIPTS_DIR + "/branch_scan.py'") && scan.prompt.includes("'l42'"));
  assert.ok(!scan.prompt.includes(".fleet/"));
});

test("build mode: preflight first, then workspace, verify, then the writers' base state; no planner", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(out.labels.slice(0, 6), ["preflight", "workspace", "infra:load-ref", "infra:verify-plan", "infra:read-state", "hasher:pre-writers:r1"]);
  assert.ok(!out.labels.some((l) => l.startsWith("role:scope-and-plan") || l.startsWith("role:plan-audit")));
  const v = inputsOf(call(out, "infra:verify-plan").prompt);
  assert.deepEqual(v, {
    main_worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main",
    branch: "fleet/l42-add-thing",
    plan_commit: PC,
    plan_path: "docs/plans/x.md",
    // 4.0.0 (1981): the test database declaration is read at origin/<default>
    default_branch: "master",
  });
  assert.ok(!call(out, "infra:verify-plan").prompt.includes(".fleet/"));
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

test("2.1.4 a PR diff with a .fleet/ path is refused before the push", async () => {
  for (const scan of [
    { diff: ["src/x.py", ".fleet/x/plan_ref.json"], commits: [] },
    { diff: ["src/x.py", "sub/.fleet/l42/notes.txt"], commits: [] },
    // the net diff is clean, but a commit on the branch touched .fleet/
    { diff: ["src/x.py"], commits: [{ sha: PC, files: ["docs/plans/x.md", ".fleet/l42/plan_ref.json"] }] },
  ]) {
    const s = happy({ script: { "infra:fleet-scan:push": Object.assign({ status: "ok", reason: "scanned" }, scan) } });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(scan));
    assert.equal(out.result.stop_gate, "scope");
    assert.match(out.result.reason, /fleet internal files in PR diff: .*\.fleet\//);
    assert.ok(!out.labels.includes("infra:push"), "no push");
    assert.ok(!out.labels.includes("role:fleet-pr-opener"), "no PR");
  }
  // the scan runs read-only, on the approved sha against origin/<default>
  const ok = await run(happy(), ARGS);
  noUnscripted(ok);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  const c = call(ok, "infra:fleet-scan:push");
  assert.equal(c.opts.agentType, "fleet:judge");
  assert.deepEqual(inputsOf(c.prompt), { main_worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main", default_branch: "master", approved_sha: CSHA(1) });
  assert.ok(ok.labels.indexOf("infra:fleet-scan:push") < ok.labels.indexOf("infra:push"));
});

test("2.1.4 a PR diff with a .fleet/ path is refused before the PR opener", async () => {
  const s = happy({ script: { "infra:fleet-scan:fleet-pr-opener": { status: "ok", reason: "scanned", diff: [".fleet/x/plan_ref.json"], commits: [] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "scope");
  assert.match(out.result.reason, /fleet internal files in PR diff: \.fleet\/x\/plan_ref\.json/);
  assert.ok(out.labels.includes("infra:push"));
  assert.ok(!out.labels.includes("role:fleet-pr-opener"));
});

test("2.1.4 a fleet-internal scan that returns no lists stops (fail-closed)", async () => {
  const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "scope");
  assert.ok(!out.labels.includes("infra:push"));
});

test("2.1.4 a coder round that creates a .fleet/ path stops at the scope fence", async () => {
  const s = happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py", ".fleet/l42/notes.txt"] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "scope");
  assert.match(out.result.reason, /\.fleet\/l42\/notes\.txt \(fleet internal/);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});


test("2.1.4 plan ref object: write and read round-trip in a real repo whose global gitignore holds .fleet/", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const wt = join(home, "repo");
  try {
    writeFileSync(join(home, "ignore"), ".fleet/\n");
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[core]\n\texcludesFile = " + join(home, "ignore") + "\n[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    const g = (...a) => {
      const r = spawnSync("git", ["-C", wt].concat(a), { encoding: "utf8", env });
      if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr);
      return r.stdout;
    };
    spawnSync("git", ["init", "-q", wt], { env });
    writeFileSync(join(wt, "a.py"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "i");
    // a reference-transaction hook: the plan-ref write must not run it
    const hooks = join(wt, ".git", "hooks");
    writeFileSync(join(hooks, "reference-transaction"), "#!/bin/sh\ntouch " + JSON.stringify(join(home, "HOOK_RAN")) + "\n", { mode: 0o755 });
    spawnSync("mkdir", ["-p", join(wt, "docs", "plans")]);
    writeFileSync(join(wt, "docs", "plans", "x.md"), "# plan\n");
    g("add", "--", "docs/plans/x.md");
    g("commit", "-qm", "plan(l42): add-thing");
    rmSync(join(home, "HOOK_RAN"), { force: true });
    const head = g("rev-parse", "HEAD").trim();
    const writeCmd = planRefWriteCmd;
    const reader = extractPy("PLAN_REF_PY_BEGIN", "PLAN_REF_PY_END", "PLAN_REF_PY");
    // 3.0.0: no mode prints message text whole; meta lists, chunks rebuild it
    const read = () => {
      const run1 = (mode) => {
        const r = spawnSync("python3", ["-I", "-", wt, "l42", mode], { input: reader, encoding: "utf8", env });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      return run1("meta").refs.map((x) => {
        const ch = run1("chunks:" + x.name).chunks;
        return Object.assign({}, x, { content: Array.isArray(ch) ? ch.join("") : null });
      });
    };
    const ref1 = { task_id: "l42", note: "it's \"quoted\" — ünï", n: 1 };
    let r = spawnSync("bash", ["-c", writeCmd(wt, "l42", JSON.stringify(ref1))], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split(" ")[0], head);
    assert.ok(!existsSync(join(home, "HOOK_RAN")), "no reference-transaction hook ran");
    assert.equal(g("cat-file", "-t", "refs/fleet/l42/plan").trim(), "tag");
    assert.equal(g("tag", "-l").trim(), "", "no tag name left");
    assert.equal(g("status", "--porcelain"), "");
    assert.equal(g("show", "--name-only", "--format=", "HEAD").trim(), "docs/plans/x.md", "the plan commit holds the plan only");
    assert.ok(!existsSync(join(wt, ".fleet")), "nothing written under .fleet/");
    g("update-ref", "refs/fleet/l42/state", head);
    let refs = read();
    assert.deepEqual(refs.map((x) => x.name), ["refs/fleet/l42/plan"], "the state ref is not a plan ref");
    const e = refs[0];
    assert.equal(e.type, "tag");
    assert.equal(e.target, head);
    assert.equal(e.target_type, "commit");
    assert.equal(e.content, JSON.stringify(ref1) + "\n");
    assert.equal(e.sha256, sha256(e.content));
    assert.deepEqual(JSON.parse(e.content), ref1);
    // a re-plan: a new plan commit, a new plan ref; the old one is kept as plan-1
    writeFileSync(join(wt, "docs", "plans", "x.md"), "# plan v2\n");
    g("commit", "-qam", "plan(l42): add-thing");
    const head2 = g("rev-parse", "HEAD").trim();
    const ref2 = { task_id: "l42", n: 2 };
    r = spawnSync("bash", ["-c", writeCmd(wt, "l42", JSON.stringify(ref2))], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    refs = read();
    const by = Object.fromEntries(refs.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(by).sort(), ["refs/fleet/l42/plan", "refs/fleet/l42/plan-1"]);
    assert.equal(by["refs/fleet/l42/plan"].target, head2);
    assert.deepEqual(JSON.parse(by["refs/fleet/l42/plan"].content), ref2);
    assert.equal(by["refs/fleet/l42/plan-1"].target, head);
    assert.equal(by["refs/fleet/l42/plan-1"].tag_sha, e.tag_sha);
    // an identical re-write (same target, same message) archives nothing
    r = spawnSync("bash", ["-c", writeCmd(wt, "l42", JSON.stringify(ref2))], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(read().map((x) => x.name), ["refs/fleet/l42/plan", "refs/fleet/l42/plan-1"]);
    // same target, new message (an identical re-plan reusing HEAD): the old value is kept as plan-2
    const ref3 = { task_id: "l42", n: 3 };
    r = spawnSync("bash", ["-c", writeCmd(wt, "l42", JSON.stringify(ref3))], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const by3 = Object.fromEntries(read().map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(by3).sort(), ["refs/fleet/l42/plan", "refs/fleet/l42/plan-1", "refs/fleet/l42/plan-2"]);
    assert.equal(by3["refs/fleet/l42/plan-2"].target, head2);
    assert.deepEqual(JSON.parse(by3["refs/fleet/l42/plan"].content), ref3);
    assert.equal(by3["refs/fleet/l42/plan"].target, head2);
    // nothing reaches a push of the branch: the branch holds no .fleet/ path
    assert.equal(g("log", "--format=", "--name-only", "master").split("\n").filter((x) => x.includes(".fleet")).length, 0);
    // a ref that points at a commit, not a tag, reads as no message
    g("update-ref", "refs/fleet/l42/plan", head2);
    const plain = read().find((x) => x.name === "refs/fleet/l42/plan");
    assert.equal(plain.type, "commit");
    assert.equal(plain.content, null);
    // missing: another task has no plan refs
    const none = spawnSync("python3", ["-I", "-", wt, "l43", "meta"], { input: reader, encoding: "utf8", env });
    assert.deepEqual(JSON.parse(none.stdout).refs, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("2.1.4 fleet-internal scan program: lists the PR diff and every commit's files in a real repo", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-scan-"));
  const wt = join(home, "repo");
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    const g = (...a) => {
      const r = spawnSync("git", ["-C", wt].concat(a), { encoding: "utf8", env });
      if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr);
      return r.stdout;
    };
    spawnSync("git", ["init", "-q", wt], { env });
    writeFileSync(join(wt, "a.py"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "i");
    g("update-ref", "refs/remotes/origin/master", "HEAD");
    g("checkout", "-qb", "fleet/l42-x");
    spawnSync("mkdir", ["-p", join(wt, ".fleet", "l42")]);
    writeFileSync(join(wt, ".fleet", "l42", "plan_ref.json"), "{}\n");
    g("add", "-A");
    g("commit", "-qm", "plan(l42): x");
    g("rm", "-q", ".fleet/l42/plan_ref.json");
    writeFileSync(join(wt, "b.py"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "feat(l42): x");
    const sha = g("rev-parse", "HEAD").trim();
    const prog = extractPy("FLEET_SCAN_PY_BEGIN", "FLEET_SCAN_PY_END", "FLEET_SCAN_PY");
    const r = spawnSync("python3", ["-I", "-", wt, "master", sha], { input: prog, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.diff, ["b.py"]);
    assert.equal(o.commits.length, 2);
    assert.ok(o.commits.some((c) => c.files.includes(".fleet/l42/plan_ref.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plan hash: stage and verify steps embed the same program, and it hashes the committed bytes", { skip: !HAVE_PY }, async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  const build = await runOne(s, buildArgs(plan.result.plan_ref));
  // 4.0.0: both run the one shipped plan_hash.py
  for (const p of [call(plan, "infra:stage-plan").prompt, call(build, "infra:verify-plan").prompt])
    assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/plan_hash.py'"), "the prompt runs the shipped plan hash program");
  const prog = join(SCRIPTS_SRC, "plan_hash.py");
  const wt = scratchRepo("fleet-planhash-");
  try {
    const text = "# plan — ü\n";
    sh(wt, "mkdir", "-p", "docs");
    writeFileSync(join(wt, "docs", "p.md"), text);
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-q", "-m", "plan");
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    const got = JSON.parse(sh(wt, "python3", "-I", prog, wt, head, "docs/p.md")).plan_sha256;
    assert.equal(got, createHash("sha256").update(text, "utf8").digest("hex"));
    assert.equal(JSON.parse(sh(wt, "python3", "-I", prog, wt, "HEAD", "docs/p.md")).plan_sha256, got);
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
  // 4.0.0 (1992): the re-plan's ref seals the build's project too
  assert.equal(JSON.parse(s.__store[PC2]).project, "o/r");
  assert.ok(!JSON.stringify(r).includes(SECRET));
  // no PR, no push, no write-back on a plan_wrong stop
  for (const l of ["infra:push", "role:fleet-pr-opener", "infra:ledger-writeback", "infra:comments-list", "infra:comments-post"])
    assert.ok(!out.labels.includes(l), l);
  // order: worktree at the old plan commit, planner, audit, commit there, then save + reset
  const tail = out.labels.slice(out.labels.indexOf("hasher:fp-post:code-judge:r1") + 1);
  assert.deepEqual(tail, [
    "infra:replan-worktree",
    "role:scope-and-plan:replan",
    "infra:hook-surface:plan:replan",
    "infra:path-check:format-plan:replan",
    "infra:format-plan:replan",
    "infra:path-check:plan-audit:replan",
    "role:plan-audit:replan",
    "infra:stage-plan:replan",
    "infra:path-check:commit-plan:replan",
    "infra:commit-plan:replan",
    "infra:verify-plan-commit:replan",
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
  // 2.1.4: three criterion files; the plan ref is a git object, not a hashed file
  assert.equal(inputsOf(call(second, "hasher:freeze:f1").prompt).test_files.length, 3);
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
  // 3.1.3 (PR #41 review 2): a legacy ledger source with no project stops the build before any role
  // (4.0.0, 1992: only when the plan run sealed no project either)
  const noProject = await run(happy(), { ...ARGS, project: undefined });
  assert.equal(noProject.result.status, "needs_human");
  assert.match(noProject.result.reason, /needs args\.project.*re-run plan/);
  assert.ok(!noProject.build.labels.includes("infra:ledger-writeback"));
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

// 4.0.0 (1984): a REQUIRED_ON_OK array is schema-required and nullable; the
// code still rejects null and a string on ok
test("role schemas type every array field; only REQUIRED_ON_OK ones are required, nullable", async () => {
  const req = REQUIRED_OF(SOURCE);
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
      const onOk = req[role].includes(k);
      assert.deepEqual(sc.properties[k].type, onOk ? ["array", "null"] : "array", role + " " + k);
      assert.ok(sc.properties[k].items, role + " " + k + " has items");
      assert.equal(schemaTypeOk(sc.properties[k], "[]"), false, role + " " + k + " rejects the string []");
      assert.equal(sc.required.includes(k), onOk, role + " " + k + " schema-required iff required on ok");
    }
  }
});

// 4.0.0 (1984): coder drift on ok is never re-run; it is the one routed
// finding of coder round 2 (no judge on the drifted round). Returns it.
async function coderDriftFinding(s) {
  const out = await run(s, ARGS);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), "no judge on a drifted coder round");
  assert.ok(!out.labels.includes("role:fleet-coder:r1:retry"), "the coder is never retried");
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "code");
  return f[0].finding;
}

test("contract drift: a string \"[]\" for a required array key is rejected in code", async () => {
  const s = happy();
  s["role:fleet-coder:r1"].added_symbols = "[]";
  assert.match(await coderDriftFinding(s), /contract drift: fleet-coder added_symbols type/);
});

test("contract drift: wrong object and boolean types are rejected in code", async () => {
  for (const [label, key, val, role] of [
    ["role:fleet-code-judge:r1", "hash_check", "{}", "fleet-code-judge"],
    ["role:fleet-test-judge:r1", "checked", "[]", "fleet-test-judge"],
  ]) {
    const s = happy();
    s[label][key] = val;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", label);
    assert.match(out.result.reason, new RegExp("contract drift: " + role + " " + key + " type"), label);
  }
  const s = happy();
  s["role:fleet-coder:r1"].frozen_tests_red_at_start = "true";
  assert.match(await coderDriftFinding(s), /contract drift: fleet-coder frozen_tests_red_at_start type/);
});

test("contract drift: a coder ok output missing added_symbols is still rejected", async () => {
  const s = happy();
  const c = Object.assign({}, REQUIRED_DEFAULTS["fleet-coder"], s["role:fleet-coder:r1"], {
    __raw: true,
    role_version: FROZEN_VERSIONS["fleet-coder"],
    role_contract: CONTRACT_LINE,
    status: "ok",
    reason: "done",
  });
  delete c.added_symbols;
  s["role:fleet-coder:r1"] = c;
  assert.match(await coderDriftFinding(s), /role fleet-coder contract drift: missing added_symbols/);
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
  assert.match(p, /`non_ff` or `remote_rejected` -> return status needs_human/);
  assert.match(p, /non-fast-forward\|fetch first/, "the retry loop still stops on a non-fast-forward");
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

test("role versions: every page one below its pin stops (4.0.0 pins)", async () => {
  for (const [role, v] of Object.entries(FROZEN_VERSIONS).map(([r, n]) => [r, n - 1])) {
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
  // 3.1.0 (ledger 1935b): the judge reports the exit code of every check_cmd it ran
  s["role:fleet-code-judge:r1"].obligations_check = obs.map((o) => Object.assign({ id: o.id, met: true, evidence: "diff" }, typeof o.check_cmd === "string" ? { check_exit: 0 } : {}));
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
      role_contract: CONTRACT_LINE,
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
  assert.deepEqual(cmds.map((c) => c.run_by), ["roles", "code-judge (required)", "nobody"]);
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
    plan_ref: { branch: "fleet/l42-add-thing", plan_commit: PC, plan_ref: "refs/fleet/l42/plan", ref_sha256: sha256(content), repo: "/r" },
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
    secondRoundPasses(s, [{ id: "OB1", met: true, evidence: "ok", check_exit: 0 }, { id: "OB2", met: true, evidence: "ok" }]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", JSON.stringify(check) + " " + out.result.reason);
    assert.equal(out.result.rounds.code, 2, JSON.stringify(check));
    assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding).join("\n"), /OB2/);
    assert.ok(out.logs.some((l) => /obligations gate/.test(l)));
    // no push of an unconfirmed approval (4.0.0: the plan run's dry-run probe is no push)
    assert.equal(out.labels.filter((l) => /^infra:push(:p\d+)?$/.test(l)).length, 1);
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
  s["infra:push"] = { status: "ok", reason: "hook", push_result: "hook_rejected", exit_code: 1, hook_tail: "check_version_bump: core version not bumped\nerror: failed to push some refs" };
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
    s["infra:push" + (m > 1 ? ":p" + m : "")] = { status: "ok", reason: "hook", push_result: "hook_rejected", exit_code: 1, hook_tail: "nope" };
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
  // 4.0.0: the classifier's own text ships as a file the prompt runs
  const shipped = readFileSync(join(SCRIPTS_SRC, "push_classify.py"), "utf8");
  assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/push_classify.py'"));
  for (const w of ["hook_rejected", "non_ff", "network", "failed to push some refs", "hook_tail", "push_result", "never --no-verify"])
    assert.ok((p + shipped).toLowerCase().indexOf(w.toLowerCase()) >= 0, w);
  // classification reads git's own lines only, never the hook's output or the
  // URL; since 3.1.0 a program classifies (ledger 1935c), never the agent
  assert.ok(p.indexOf("Never classify the output yourself") >= 0);
  const prog = extractPy("PUSH_CLASSIFY_PY_BEGIN", "PUSH_CLASSIFY_PY_END", "PUSH_CLASSIFY_PY");
  assert.match(prog, /x\.startswith\(\('error:', 'fatal:', ' ! \['\)\)/);
  assert.ok(prog.indexOf("' ! [rejected]'") >= 0 && prog.indexOf("' ! [remote rejected]'") >= 0);
  assert.ok(p.indexOf("remote_rejected") >= 0);
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
      role_contract: CONTRACT_LINE,
    });
    delete r[key];
    s[label] = r;
    const t = happy();
    t[label][key] = "[]";
    // 4.0.0 (1984): coder drift is a round-2 finding; judge drift stops
    if (role === "fleet-coder") {
      assert.match(await coderDriftFinding(s), new RegExp("role " + role + " contract drift: missing " + key));
      assert.match(await coderDriftFinding(t), new RegExp("contract drift: " + role + " " + key + " type"));
      continue;
    }
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", key);
    assert.match(out.result.reason, new RegExp("role " + role + " contract drift: missing " + key));
    const outT = await run(t, ARGS);
    assert.match(outT.result.reason, new RegExp("contract drift: " + role + " " + key + " type"));
  }
});

test("2.0.3 B3: a coder output missing a key AND a hash violation reports the hash violation", async () => {
  const s = happy();
  const c = Object.assign({}, REQUIRED_DEFAULTS["fleet-coder"], s["role:fleet-coder:r1"], {
    __raw: true,
    role_version: FROZEN_VERSIONS["fleet-coder"],
    role_contract: CONTRACT_LINE,
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
  // 4.0.0 (1984): coder drift alone is a finding each round; the cap names the contract gate
  const t = happy();
  for (const m of [1, 2, 3]) t["role:fleet-coder:r" + m] = Object.assign({}, t["role:fleet-coder:r1"], { added_symbols: "[]" });
  t["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2 };
  t["hasher:post-coder:r3"] = { status: "ok", fingerprint: FP_M3 };
  const outT = await run(t, ARGS);
  assert.equal(outT.result.stop_gate, "cap");
  assert.match(outT.result.reason, /last round rejected by the contract gate/);
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
    plan_ref: { branch: "fleet/l42-add-thing", plan_commit: PC, plan_ref: "refs/fleet/l42/plan", ref_sha256: sha256(content), repo: "/r" },
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
  const f = "'" + SCRIPTS_DIR + "/script_check.py'";
  assert.ok(ci.run.startsWith("sha256sum -- " + f + " && python3 -I " + f + " "), ci.run);
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
    const printed = JSON.parse(r.stdout);
    const out = printed.checks;
    assert.equal(printed.digest, sha256(canon({ checks: out, program: printed.program })));
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
  let out = await run(happy({ script: { "role:fleet-test-writer:AC1:r1": { __raw: true, status: "ok", reason: "x", role_version: FROZEN_VERSIONS["fleet-test-writer"], role_contract: CONTRACT_LINE, criterion_id: "AC1", tests: [] } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /fleet-test-writer contract drift: missing files/);
  assert.match(await coderDriftFinding(happy({ script: { "role:fleet-coder:r1": { status: "ok", changed_paths: "src/x.py" } } })), /fleet-coder changed_paths type/);
  const req = REQUIRED_OF(SOURCE);
  assert.ok(!/"commits?"/.test(JSON.stringify(req)));
  assert.deepEqual(req["fleet-test-writer"], ["criterion_id", "tests", "files"]);
  assert.deepEqual(req["fleet-intent-judge"], ["verdict", "deviations", "coverage", "classification"]);
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
          "role:fleet-code-judge:r1": Object.assign({}, happy()["role:fleet-code-judge:r1"], { obligations_check: [{ id: "fmt", met: true, evidence: "ran", check_exit: 0 }] }),
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

test("2.1.0 G3 scope fence: secrets, rulesets and a foreign repo are refused (IaC paths are fleet work since ADR-1172)", async () => {
  const planWith = (o) => autoHappy({ script: { "role:scope-and-plan": Object.assign({}, happy()["role:scope-and-plan"], o) } });
  const fence = (files) => ({ allowed_additions: { files, symbols: [], deps: [], settings: [] } });
  for (const o of [
    fence(["config/rulesets/main.json"]),
    fence([".env.local"]),
    fence(["src/db_secret.py"]),
    fence(["certs/server.pem"]),
    fence(["keys/deploy.key"]),
    fence(["home/id_rsa.pub"]),
    fence(["aws_credentials.json"]),
  ]) {
    const out = await runOne(planWith(o), AUTO);
    autoFail(out, "scope");
  }
  // 3.1.0: a CI workflow is hook surface: Max's rule stops the plan earlier, before the audit
  for (const o of [fence([".github/workflows/ci.yml"]), fence([".github/CODEOWNERS"]), { criteria: [{ id: "AC1", text: "a", test_files: [".github/tests/test_a.py"] }] }]) {
    const wf = await runOne(planWith(o), AUTO);
    assert.equal(wf.result.status, "needs_human");
    assert.equal(wf.result.stop_gate, "hooks");
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

test("2.1.0 contract (fleet-v4 since 4.0.0): preflight loads ten roles; fleet-v2 pages halt", async () => {
  let out = await run(happy(), ARGS);
  const pf = inputsOf(call(out, "preflight").prompt);
  assert.deepEqual(pf.roles.slice().sort(), ROLE_NAMES.slice().sort());
  const s = happy();
  s.preflight.contract["pr-review"] = "CONTRACT: fleet-v2";
  out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /pr-review contract fleet-v2 != fleet-v4/);
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

test("2.1.0 scope fence on the REAL changes: a coder that writes CI or a secret file stops (every mode; IaC is fleet work since ADR-1172)", async () => {
  for (const p of [".github/workflows/ci.yml", ".env.local", "certs/a.pem"]) {
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
  // 3.1.0: .github/ is hook surface, and a plan's test files are in its scope: Max's rule stops the plan first
  assert.equal(w.result.stop_gate, "hooks");
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
  // the PATH re-checks (3.1.1) are counted in agents but not against the cap
  const work = out.calls.filter((c) => !/^infra:path-check:/.test(c.label));
  assert.ok(out.calls.length > work.length, "the re-checks ran");
  assert.ok(work.length > 60, "dispatched " + work.length);
  assert.ok(work.length <= 100);
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
  assert.ok(hp.includes("python3 -I '" + SCRIPTS_DIR + "/hasher.py'"));
  const hpy = readFileSync(join(SCRIPTS_SRC, "hasher.py"), "utf8");
  assert.match(hpy, /core\.fsmonitor=false/);
  assert.match(hpy, /GIT_CONFIG_NOSYSTEM/);
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

test("2.1.1 venv entry points and egg-links are frozen: a pytest11 plugin a coder installs is a violation", { skip: !HAVE_PY }, () => {
  const wt = scratchRepo("fleet-ign-ep-");
  try {
    writeFileSync(join(wt, ".gitignore"), ".venv/\n.tox/\n");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const sp = ".venv/lib/python3.12/site-packages";
    sh(wt, "mkdir", "-p", sp + "/ok-1.0.dist-info", sp + "/old.egg-info", ".tox/py/lib/site-packages/t-2.0.dist-info");
    writeFileSync(join(wt, sp, "ok-1.0.dist-info", "entry_points.txt"), "[console_scripts]\nok = ok:main\n");
    writeFileSync(join(wt, sp, "ok-1.0.dist-info", "RECORD"), "ok.py,,\n");
    const a = runHasherRaw(wt, "hashes", []).hashes;
    assert.ok(sp + "/ok-1.0.dist-info/entry_points.txt" in a.ignored, Object.keys(a.ignored).join(", "));
    assert.ok(!(sp + "/ok-1.0.dist-info/RECORD" in a.ignored), "other dist-info files are not frozen");
    // the coder installs a package that registers a pytest plugin
    sh(wt, "mkdir", "-p", sp + "/evil-1.0.dist-info");
    writeFileSync(join(wt, sp, "evil-1.0.dist-info", "entry_points.txt"), "[pytest11]\nevil = evil_plugin\n");
    writeFileSync(join(wt, sp, "old.egg-info", "entry_points.txt"), "[pytest11]\nold = old\n");
    writeFileSync(join(wt, sp, "evil.egg-link"), "/tmp/evil\n.\n");
    writeFileSync(join(wt, ".tox/py/lib/site-packages/t-2.0.dist-info", "entry_points.txt"), "[pytest11]\nt = t\n");
    const b = runHasherRaw(wt, "hashes", []).hashes;
    for (const p of [
      sp + "/evil-1.0.dist-info/entry_points.txt",
      sp + "/old.egg-info/entry_points.txt",
      sp + "/evil.egg-link",
      ".tox/py/lib/site-packages/t-2.0.dist-info/entry_points.txt",
    ])
      assert.ok(p in b.ignored, p + " in " + Object.keys(b.ignored).join(", "));
    // a changed entry_points.txt changes its hash
    writeFileSync(join(wt, sp, "ok-1.0.dist-info", "entry_points.txt"), "[pytest11]\nok = ok\n");
    const c = runHasherRaw(wt, "hashes", []).hashes;
    assert.notEqual(c.ignored[sp + "/ok-1.0.dist-info/entry_points.txt"], a.ignored[sp + "/ok-1.0.dist-info/entry_points.txt"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.1 a coder that installs a venv entry_points.txt is stopped as an ignored path written", async () => {
  const p = ".venv/lib/python3.12/site-packages/evil-1.0.dist-info/entry_points.txt";
  const out = await run(hashViolation(Object.assign(H(HASHES_FLAT), { ignored: { [p]: "h" } })), ARGS);
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /ignored path written: \.venv\/lib\/python3\.12\/site-packages\/evil-1\.0\.dist-info\/entry_points\.txt/);
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
  // 3.1.0 (ledger 1959): the program lists plan_commit..HEAD
  assert.ok(call(out, "infra:verify-plan").prompt.includes("python3 -I '" + SCRIPTS_DIR + "/verify_since.py'"));
  assert.match(extractPy("VERIFY_SINCE_PY_BEGIN", "VERIFY_SINCE_PY_END", "VERIFY_SINCE_PY"), /run\('diff', '--name-only', '-z', '--no-renames', pc \+ '\.\.' \+ head, '--'\)/);
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
  // 4.0.0: the shipped writer program moves the ref, hooks off, no system config
  assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/state_write.py' '/r/.claude/worktrees/fleet-l42-add-thing/main' 'refs/fleet/l42/state'"));
  const sw = readFileSync(join(SCRIPTS_SRC, "state_write.py"), "utf8");
  assert.match(sw, /os\.environ\['GIT_CONFIG_NOSYSTEM'\] = '1'/);
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
  // 4.0.0: the worktree sits next to the run's scratch dir, where the chunks go
  const home = mkdtempSync(join(tmpdir(), "fleet-state-"));
  const wt = join(home, "main");
  try {
    sh(home, "git", "init", "-q", wt);
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, "a.py"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const st = { plan_commit: "abc", last_gate: "committed", note: "it's \"quoted\"" };
    const cmd = stateWriteCmd(wt, "refs/fleet/l42/state", JSON.stringify(st));
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    assert.equal(sh(wt, "git", "cat-file", "-t", "refs/fleet/l42/state").trim(), "tag");
    assert.equal(sh(wt, "git", "tag", "-l").trim(), "", "no tag name left");
    // 4.0.1: the program lives in scripts/read_state.py only
    const body = extractPy("READ_STATE_PY_BEGIN", "READ_STATE_PY_END", "READ_STATE_PY");
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
    rmSync(home, { recursive: true, force: true });
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
  const page = "DISPATCH: model=opus (fallback=sonnet) — review depth scales with blast radius\n" + CONTRACT_LINE;
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

// ---------------------------------------------------------------- 2.1.2 worktrees

test("2.1.2 worktree add runs with hooks off (no post-checkout hook)", async () => {
  const out = await run(happy(), ARGS);
  const ws = call(out, "workspace").prompt;
  const adds = ws.match(/git -C <repo>[^`]*worktree add/g) || [];
  assert.ok(adds.length >= 3, ws);
  for (const a of adds) assert.match(a, /-c core\.hooksPath=\/dev\/null worktree add/);
  assert.doesNotMatch(ws, /git -C <repo> worktree add/);
});

const HAVE_TOML = spawnSync("python3", ["-c", "import tomllib"]).status === 0;

// ---------------------------------------------------------------- 2.1.5

// The schema each agent label was dispatched with, from a full happy run.
async function schemasByKind() {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  // confirm auto adds the intent judge; its result is not needed, only the call
  const auto = await runOne(autoHappy(), AUTO);
  const by = {};
  for (const c of out.calls.concat(auto.calls)) {
    const l = c.label;
    const kind = l.startsWith("role:") ? "role:" + l.split(":")[1] : l.startsWith("hasher:") ? "hasher" : l.startsWith("infra:") || l === "workspace" ? "infra" : l;
    if (c.opts && c.opts.schema && !(kind in by)) by[kind] = c.opts.schema;
  }
  return by;
}

// "infra:commits[].files" -> the property schema at that path, or null.
function schemaAt(by, spec) {
  const i = spec.lastIndexOf(":");
  let s = by[spec.slice(0, i)];
  for (const seg of spec.slice(i + 1).split(".")) {
    if (!s) return null;
    const arr = seg.endsWith("[]");
    s = s.properties && s.properties[arr ? seg.slice(0, -2) : seg];
    if (arr) s = s && s.items;
  }
  return s || null;
}

// Every Array.isArray(<v>.<field>) site in the workflow, keyed by
// "<expr> @ <enclosing function>", maps to the schema of the agent result the
// object came from ("<label kind>:<path>"), or to "parsed: <why>" when the
// object is no agent result. A new site with no entry fails; a field the
// mapped schema does not type as array fails (2.1.4 trial bug #2: an
// undeclared field came back as the string "[]").
const ARRAY_SITES = {
  "o.files @ planFactsProblem": "role:scope-and-plan:repo_obligations[].files",
  "tc.tools @ testCmdProblem": "role:scope-and-plan:test_cmd.tools",
  "r.yadgar_findings @ collect": "role:scope-and-plan:yadgar_findings",
  "h.suspicious @ hasher": "hasher:hashes.suspicious",
  "r.changed @ hasher": "hasher:changed",
  "b.sources @ briefProblem": "intake:brief.sources",
  "it.tried @ intakeHaltReason": "intake:tried",
  "plan.criteria @ planAndAudit": "role:scope-and-plan:criteria",
  "plan.plan_diff @ planAndAudit": "role:scope-and-plan:plan_diff",
  "plan.changed_symbols @ planAndAudit": "role:scope-and-plan:changed_symbols",
  "e.occurrences @ changedSymbolFindings": "role:scope-and-plan:changed_symbols[].occurrences",
  "r.capped @ callerCheck": "infra:capped",
  "r.doctest_md @ callerCheck": "infra:doctest_md",
  "r.auto_dont_care @ callerCheck": "parsed: a program map; Array.isArray only refuses an array there",
  // 4.0.0 (1986): a parked findings.json (digest-checked relay, JSON.parse)
  "f.rounds @ loadParked": "parsed: a parked findings.json",
  "x.findings @ loadParked": "parsed: a parked findings.json",
  "f.symbols @ loadParked": "parsed: a parked findings.json",
  // 4.0.0 (1981): the sweep program's digest-checked output (a gate line only)
  "sw.removed @ testDbStep": "parsed: a db_sweep program output",
  "sw.errors @ testDbStep": "parsed: a db_sweep program output",
  // 4.0.0 (1983): the script's own round record, or a parked findings.json (digest-checked)
  "plan.criteria @ roundSnapshot": "role:scope-and-plan:criteria",
  "r0.criteria @ relaxedReasons": "parsed: the round-0 snapshot (the script's own, or a parked findings.json)",
  "prior.findings @ relaxedReasons": "parsed: the script's round record (or a parked findings.json)",
  "prior.symbols @ replanWithFindings": "parsed: the script's round record (or a parked findings.json)",
  "prior.findings @ replanWithFindings": "parsed: the script's round record (or a parked findings.json)",
  "prior.criteria_by_round @ replanWithFindings": "parsed: the script's round record (or a parked findings.json)",
  "r.defs @ buildCallerCheck": "infra:defs",
  "p.enum @ roleSchema": "parsed: a role schema property (the 1984 STRICT loop), not an agent result",
  "pf.changed_symbols @ buildFromRef": "parsed: plan_facts of the sealed plan ref",
  "o.files @ planScopeFiles": "parsed: repo_obligations of the sealed plan facts",
  "r.files @ formatFiles": "infra:files",
  "r.changed @ formatFiles": "infra:changed",
  "r.refused @ formatFiles": "infra:refused",
  "rd.results @ writeBack": "infra:results",
  "fmt.changed_paths @ planAndAudit": "infra:changed_paths",
  "pf.files @ verifyPlanCommit": "infra:plan_files.files",
  "pf.dsn_paths @ verifyPlanCommit": "infra:plan_files.dsn_paths",
  "pr.refs @ verifyPlanCommit": "infra:plan_ref.refs",
  "r.program @ programProblem": "parsed: a program self-hash; Array.isArray only refuses an array there",
  "c.files @ isPlanCommit": "infra:commits[].files",
  "aa.files @ scopeProblems": "role:scope-and-plan:allowed_additions.files",
  "cfg.ids @ hookIdProblems": "infra:ids",
  "r.deviations @ autoGates": "role:fleet-intent-judge:deviations",
  "scan.commits @ planMode": "infra:commits",
  "scan.refs @ planMode": "infra:refs",
  "r.criteria @ planRefProblem": "parsed: the sealed plan ref (JSON.parse of a verified tag message)",
  "r.refs @ buildFromRef": "infra:refs",
  "r.chunks @ buildFromRef": "infra:chunks",
  "pf.commands @ buildFromRef": "parsed: plan_facts of the sealed plan ref",
  "ref.plan_diff @ buildFromRef": "parsed: the sealed plan ref",
  "r.diff @ fleetScan": "infra:diff",
  "r.commits @ fleetScan": "infra:commits",
  "c.files @ fleetScan": "infra:commits[].files",
  "rp.changed_paths @ reviewStep": "infra:changed_paths",
  "r.results @ writeBack": "infra:results",
  "l.results @ writeBack": "infra:results",
  "p.results @ writeBack": "infra:results",
  // 3.1.0
  "v.commits_since @ buildFromRef": "infra:commits_since",
  "v.plan_touched @ buildFromRef": "infra:plan_touched",
  "v.changed_since @ buildFromRef": "infra:changed_since",
  "r.results @ writeBodies": "infra:results",
  "pre.results @ writeBack": "infra:results",
  "o.files @ obligationFailures": "parsed: repo_obligations of the sealed plan facts",
  "r.surface @ hookSurface": "infra:surface",
  "pc.tools @ pathRelayProblem": "parsed: preflight path_check (digest-checked, keys and shapes checked)",
  "pc.path_problems @ pathRelayProblem": "parsed: preflight path_check (digest-checked)",
  "pf.changed_symbols @ planScopePaths": "parsed: plan facts (checked by planFactsProblem)",
  "e.occurrences @ planScopePaths": "parsed: plan facts (checked by planFactsProblem)",
  "c.test_files @ planScopePaths": "parsed: normalised criteria",
  "h.page_tags @ writeBodies": "infra:results[].page_tags",
  // 4.0.0 (1985)
  "r.args @ pushProbe": "parsed: the push probe relay (PUSH_PROBE_SCHEMA args; digest-checked)",
};

function arraySites() {
  const sites = [];
  let fn = "<top>";
  for (const line of SOURCE.split("\n")) {
    const f = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
    if (f) fn = f[1];
    for (const m of line.matchAll(/Array\.isArray\(([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\)/g))
      sites.push(m[1] + "." + m[2] + " @ " + fn);
  }
  return sites;
}

test("2.1.5 every Array.isArray(<result>.<field>) reads a field its schema declares as an array", async () => {
  const by = await schemasByKind();
  const sites = arraySites();
  assert.ok(sites.length >= 20, "found the sites: " + sites.length);
  const problems = [];
  for (const s of new Set(sites)) {
    const spec = ARRAY_SITES[s];
    if (!spec) {
      problems.push(s + ": no entry in ARRAY_SITES (map it to its schema or mark it parsed)");
      continue;
    }
    if (spec.startsWith("parsed:")) continue;
    const p = schemaAt(by, spec);
    if (!p) problems.push(s + ": " + spec + " is not declared");
    else if (![].concat(p.type).includes("array")) problems.push(s + ": " + spec + " is typed " + JSON.stringify(p.type));
  }
  for (const k of Object.keys(ARRAY_SITES)) if (!sites.includes(k)) problems.push(k + ": stale ARRAY_SITES entry");
  assert.deepEqual(problems, []);
});

test("2.1.5 the hasher schema declares and requires every hash map the script reads", async () => {
  const by = await schemasByKind();
  const h = by.hasher.properties.hashes;
  for (const m of ["files", "sections", "git", "symlinks", "ignored", "suspicious"]) {
    assert.ok(h.properties[m], "hashes." + m + " declared");
    assert.ok(h.required.includes(m), "hashes." + m + " required");
  }
});

test("2.1.5 a hasher result with no ignored map fails; it never reads as empty", async () => {
  const s = happy();
  s["hasher:pre-writers:r1"] = { __raw: true, status: "ok", fingerprint: FP_PRE, hashes: { files: {}, sections: {}, git: {}, symlinks: {}, suspicious: [] } };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /hasher hasher:pre-writers:r1 failed/);
});

// 2.1.4 trial bugs #5/#9: resumeFromRunId replays cached agent calls whose
// prompts did not change, so a stateful check (workspace, hasher, branch-scan,
// ...) returned the verdict of a worktree that no longer existed. Every infra
// prompt carries the caller's run_nonce, so a new invocation never replays one.
test("2.1.5 run_nonce is required in both modes; no agent runs without it", async () => {
  for (const args of [
    { ...ARGS, run_nonce: null },
    { ...ARGS, run_nonce: "" },
    { ...ARGS, run_nonce: "bad nonce!" },
    { mode: "build", plan_ref: { branch: "fleet/l42-x" }, date: ARGS.date, run_nonce: null },
  ]) {
    const a = args;
    const out = await runOne(happy(), a);
    assert.equal(out.result.status, "needs_human", JSON.stringify(a));
    assert.match(out.result.reason, /run_nonce/);
    assert.equal(out.calls.length, 0);
  }
});

test("2.1.5 every infra and hasher prompt carries run_nonce; role prompts do not", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok");
  for (const c of out.calls) {
    const has = c.prompt.includes("Run nonce: " + NONCE);
    if (c.label.startsWith("role:")) assert.ok(!has, c.label);
    else assert.ok(has, c.label + " carries the run nonce");
  }
  // a second invocation with a new nonce changes every infra prompt
  const out2 = await run(happy(), { ...ARGS, run_nonce: "n2-0000002" });
  const p1 = Object.fromEntries(out.plan.calls.map((c) => [c.label, c.prompt]));
  for (const c of out2.plan.calls) if (!c.label.startsWith("role:")) assert.notEqual(c.prompt, p1[c.label], c.label);
});

// 2.1.4 trial bug #9: the intent judge was reported as writing the
// workflow's own .claude/settings.local.json. The journal shows the
// pre-judge hasher result came back WITHOUT its ignored map (undeclared in
// the schema, dropped in the relay) and the script read it as empty. That map
// is now required, so the file is in both states and nothing is exempt: any
// change to it during a judge run, a hooks key included, still discards the
// verdict, exactly as in 2.1.4.
function judgeIgnored(key, value) {
  const h = H({ ...HASHES_FLAT });
  h.ignored = { [key]: value || "s1" };
  return { status: "ok", fingerprint: FP_TESTS, hashes: h };
}

// The settings file exists from the workspace step on: every state holds it.
function withSettings(s, value) {
  const h = judgeIgnored(".claude/settings.local.json", value).hashes;
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: FP_PRE, hashes: h };
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_TESTS, hashes: h };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: h };
  return s;
}

test("2.1.5 judge fingerprint: an unchanged .claude/settings.local.json passes", async () => {
  const out = await run(withSettings(happy(), "allowlist"), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("2.1.5 judge fingerprint: a judge that changes .claude/settings.local.json (a hooks key) is stopped", async () => {
  const s = withSettings(happy(), "allowlist");
  // the judge adds a hooks key: the file's hash changes
  s["hasher:fp-post:test-judge:r1"] = judgeIgnored(".claude/settings.local.json", "allowlist+hooks");
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree: fleet-test-judge .*ignored path written: \.claude\/settings\.local\.json/);
  assert.equal(out.result.stop_gate, "fingerprint");
});

test("2.1.5 judge fingerprint: settings.local.json appearing or vanishing during a judge run is stopped", async () => {
  const s1 = happy();
  s1["hasher:fp-post:test-judge:r1"] = judgeIgnored(".claude/settings.local.json");
  const o1 = await run(s1, ARGS);
  assert.equal(o1.result.stop_gate, "fingerprint");
  const s2 = withSettings(happy(), "allowlist");
  s2["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: FP_TESTS, hashes: H({ ...HASHES_FLAT }) };
  const o2 = await run(s2, ARGS);
  assert.equal(o2.result.stop_gate, "fingerprint");
});

test("2.1.5 judge fingerprint: any other ignored path a judge writes discards the verdict", async () => {
  for (const key of ["sub/.claude/settings.local.json", ".claude/settings.json", ".claude/settings.local.json.bak"]) {
    const s = happy();
    s["hasher:fp-post:test-judge:r1"] = judgeIgnored(key);
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", key);
    assert.match(out.result.reason, /judge mutated worktree/, key);
    assert.equal(out.result.stop_gate, "fingerprint", key);
  }
});

test("2.1.5 writer round: .claude/settings.local.json written by a writer is still an ownership stop", async () => {
  const s = happy();
  const post = s["hasher:post-writers:r1"];
  s["hasher:post-writers:r1"] = (p) => {
    const r = post(p);
    r.hashes = H({ ...HASHES_FLAT });
    r.hashes.ignored = { ".claude/settings.local.json": "s1" };
    return r;
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /ignored path written: \.claude\/settings\.local\.json/);
});

// 2.1.4 trial bug #8: a pre-commit fixer (prettier) rewrote the plan in the
// commit, so the committed plan no longer hashed as the staged one. The plan
// now runs through the repo's pre-commit hooks BEFORE the audit: the audit
// approves, and the commit holds, the formatted bytes.
test("2.1.5 format-plan runs the repo's hooks on the plan after the planner and before the audit", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  const l = out.plan.labels;
  assert.ok(l.indexOf("infra:format-plan") > l.indexOf("role:scope-and-plan"));
  assert.ok(l.indexOf("infra:format-plan") < l.indexOf("role:plan-audit"));
  const p = call(out, "infra:format-plan").prompt;
  assert.deepEqual(inputsOf(p), { worktree: "/r/.claude/worktrees/fleet-l42-add-thing/main", plan_path: "docs/plans/x.md" });
  assert.match(p, /pre-commit run --files/);
  // a new plans dir must list the file, not the dir
  assert.ok(!/status --porcelain`/.test(p) && /status --porcelain --untracked-files=all/.test(p), "files in new untracked dirs are listed");
  assert.match(p, /--no-verify|never bypass|Never bypass/i);
  // the commit step no longer re-adds a rewritten plan and commits again
  const cp = call(out, "infra:commit-plan").prompt;
  assert.ok(!/re-add <plan_path> and commit once more/.test(cp), "no re-add after a hook rewrite");
  assert.match(cp, /rewrites the plan/);
});

test("2.1.5 format-plan: a hook that touches any other path stops the run", async () => {
  const s = happy();
  s["infra:format-plan"] = { status: "ok", reason: "formatted", changed_paths: ["docs/plans/x.md", "README.md"] };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /format-plan.*README\.md/);
  assert.ok(!out.labels.includes("role:plan-audit"));
});

test("2.1.5 format-plan: a hook failure stops before the audit", async () => {
  const s = happy();
  s["infra:format-plan"] = { status: "needs_human", reason: "hook check-yaml failed: ..." };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /format-plan/);
  assert.ok(!out.labels.includes("role:plan-audit"));
});

test("2.1.5 format-plan: no changed_paths list fails closed", async () => {
  const s = happy();
  s["infra:format-plan"] = { status: "ok", reason: "formatted" };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /format-plan/);
});

// 2.1.4 trial bug #4: a plan run that stopped after the planner left the
// draft plan untracked in the fleet worktree, and the next plan run's
// workspace step refused the dirty tree. Plan mode now moves its OWN draft
// (plan_path only) out of the worktree before it returns the stop.
test("2.1.5 a plan stop after the planner parks the run's own draft plan and keeps the stop reason", async () => {
  const s = happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding: "bad" }] } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan-audit verdict plan_defect/);
  const pk = call(out, "infra:park-plan");
  const inp = inputsOf(pk.prompt);
  assert.equal(inp.worktree, "/r/.claude/worktrees/fleet-l42-add-thing/main");
  assert.equal(inp.plan_path, "docs/plans/x.md");
  assert.equal(inp.dest, "/r/.claude/worktrees/fleet-l42-add-thing/scratch/parked/" + NONCE + "/docs/plans/x.md");
  assert.match(pk.prompt, /other than <plan_path>.*needs_human|any path other than <plan_path>/);
  assert.ok(!/status --porcelain`/.test(pk.prompt) && /status --porcelain --untracked-files=all/.test(pk.prompt));
  assert.match(out.result.reason, /draft plan moved to .*scratch\/parked/);
  assert.equal(out.result.stop_gate, "role");
});

test("2.1.5 a failed park never replaces the stop reason", async () => {
  const s = happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect" }, "infra:park-plan": { status: "needs_human", reason: "README.md is dirty too" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan-audit verdict plan_defect/);
  assert.match(out.result.reason, /draft plan left in the worktree.*README\.md is dirty too/);
});

test("2.1.5 a stop before the planner returns parks nothing; an ok plan run parks nothing", async () => {
  const s = happy({ script: { "role:scope-and-plan": { status: "needs_human", reason: "ambiguous" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(!out.labels.includes("infra:park-plan"));
  const ok = await run(happy(), ARGS);
  assert.ok(!ok.labels.includes("infra:park-plan"));
});

// 2.1.4 trial bug #10: load-ref relayed the whole sealed plan JSON through
// a model, which shortened it to "[truncated: ...]". The commit-plan step and
// the auto path no longer relay ref content at all (the script hashes the
// bytes it wrote); a standalone build reads the content in short chunks,
// checks them against ref_sha256 and asks once more on a mismatch.

test("2.1.5 commit-plan relays no ref content: the script hashes the bytes it sealed", async () => {
  const s = happy({ brief: { ...BRIEF, title: "Add Thing — ünï 🚀", description: "nbsp here" } });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  // 4.0.0: the verify step reads the refs in meta mode; no step relays the content
  const vp = call(out, "infra:verify-plan-commit").prompt;
  assert.match(vp, / 'meta'\n/, "the reader runs in meta mode");
  assert.equal(chunkedContentOf(call(out, "infra:commit-plan").prompt), s.__store[PC], "the chunks are the sealed bytes");
  assert.equal(out.result.plan_ref.ref_sha256, sha256(s.__store[PC]));
});

test("2.1.5 commit-plan: a ref whose sha256 is not the sealed bytes' stops", async () => {
  const s = happy();
  s["infra:verify-plan-commit"] = ((inner) => (p) => {
    const r = inner(p);
    r.plan_ref.refs[0].sha256 = "e".repeat(64);
    return r;
  })(verifyStub(s.__store));
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /differs from the sealed ref/);
});

test("2.1.5 load-ref reads the content in chunks and checks them against ref_sha256", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const p = call(out, "infra:load-ref").prompt;
  assert.equal(inputsOf(p).mode, "chunks");
  assert.match(p, / 'chunks:refs\/fleet\/l42\/plan'\n/);
  assert.match(p, /never shorten|NEVER shorten/i);
});

test("2.1.5 load-ref: a truncated chunk is asked for once more; a second bad copy stops", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  const bad = (p) => {
    const r = good(p);
    r.chunks = r.chunks.slice();
    r.chunks[0] = "[truncated: full plan JSON ...]";
    return r;
  };
  s["infra:load-ref"] = bad;
  s["infra:load-ref:retry"] = good;
  let out = await runOne(s, buildArgs(tiny));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:load-ref:retry"));
  s["infra:load-ref:retry"] = bad;
  out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan.*chunks do not match/);
});

test("2.1.5 confirm auto builds from the in-memory sealed ref: load-ref reads metadata only", async () => {
  const out = await runOne(autoHappy(), AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const p = call(out, "infra:load-ref").prompt;
  assert.equal(inputsOf(p).mode, "meta");
  assert.match(p, / 'meta'\n/);
});

test("2.1.5 plan-ref reader program: meta mode has no content, chunks mode rebuilds the exact bytes", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-chunks-"));
  const wt = join(home, "repo");
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    spawnSync("git", ["init", "-q", wt], { env });
    writeFileSync(join(wt, "a.py"), "a\n");
    spawnSync("git", ["-C", wt, "add", "-A"], { env });
    spawnSync("git", ["-C", wt, "commit", "-qm", "i"], { env });
    const writeCmd = planRefWriteCmd;
    const reader = extractPy("PLAN_REF_PY_BEGIN", "PLAN_REF_PY_END", "PLAN_REF_PY");
    const big = { task_id: "l42", body: "x y — ü 🚀 ".repeat(400) };
    const w = spawnSync("bash", ["-c", writeCmd(wt, "l42", JSON.stringify(big))], { encoding: "utf8", env });
    assert.equal(w.status, 0, w.stderr);
    const read = (mode) => {
      const r = spawnSync("python3", ["-I", "-", wt, "l42"].concat(mode ? [mode] : []), { input: reader, encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    // 3.0.0 (ledger 1952): the full-content mode is gone
    const none = spawnSync("python3", ["-I", "-", wt, "l42", ""], { input: reader, encoding: "utf8", env });
    assert.notEqual(none.status, 0, "an empty mode is refused");
    const noArg = spawnSync("python3", ["-I", "-", wt, "l42"], { input: reader, encoding: "utf8", env });
    assert.notEqual(noArg.status, 0, "a missing mode is refused");
    const meta = read("meta");
    const full = { sha256: sha256(JSON.stringify(big) + "\n"), content: JSON.stringify(big) + "\n" };
    assert.ok(!("content" in meta.refs[0]));
    assert.equal(meta.refs[0].sha256, full.sha256);
    assert.equal(meta.chunks, undefined);
    const ch = read("chunks:refs/fleet/l42/plan");
    assert.ok(!("content" in ch.refs[0]));
    assert.ok(ch.chunks.length >= 5, "several chunks: " + ch.chunks.length);
    assert.ok(ch.chunks.every((c) => [...c].length <= CHUNK), "at most 1000 code points per chunk");
    assert.equal(ch.chunks.join(""), full.content);
    assert.equal(sha256(ch.chunks.join("")), full.sha256);
    const bad = spawnSync("python3", ["-I", "-", wt, "l42", "chunks:refs/heads/master"], { input: reader, encoding: "utf8", env });
    assert.notEqual(bad.status, 0, "chunks of a non-plan ref are refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The hasher's maps are relayed by a model too (2.1.4: the pre-intent result
// lost its whole ignored map). The program prints a digest of what it found;
// the script recomputes it over the relayed values, so a dropped or changed
// key fails the hasher step instead of reading as "nothing there".
function hasherDigest(r, withChanged) {
  const o = { fingerprint: r.fingerprint, hashes: r.hashes };
  // 4.0.0: the digest covers the program's self-hash and the scripts map
  if (r.program !== undefined) o.program = r.program;
  if (r.scripts !== undefined) o.scripts = r.scripts;
  if (withChanged) o.changed = r.changed;
  return sha256(canon(o));
}

test("2.1.5 hasher program: digest is the sha256 of the canonical fingerprint, hashes and changed", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-digest-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = '-q'\n");
    writeFileSync(join(wt, "test_ünï x.py"), "def test_a():\n    pass\n");
    writeFileSync(join(wt, ".gitignore"), "local.txt\n");
    writeFileSync(join(wt, "local.txt"), "x\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const out = runHasherRaw(wt, "hash", ["test_ünï x.py"]);
    assert.match(out.digest, /^[0-9a-f]{64}$/);
    assert.equal(out.digest, hasherDigest(out, false));
    assert.ok("local.txt" in out.hashes.ignored);
    const base = out.fingerprint.tree;
    writeFileSync(join(wt, "test_ünï x.py"), "def test_a():\n    assert 1\n");
    const out2 = runHasherRaw(wt, "hash", ["test_ünï x.py"], base);
    assert.deepEqual(out2.changed, ["test_ünï x.py"]);
    assert.equal(out2.digest, hasherDigest(out2, true));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.5 a hasher result whose relayed maps do not match the digest fails", async () => {
  const s = happy();
  const h = H({ ...HASHES_FLAT });
  h.ignored = { ".claude/settings.local.json": "s1" };
  const good = { status: "ok", fingerprint: FP_PRE, hashes: h, program: programOf("hasher"), scripts: allScripts() };
  const digest = hasherDigest(good, false);
  // the relay dropped the ignored key
  s["hasher:pre-writers:r1"] = { __raw: true, status: "ok", fingerprint: FP_PRE, hashes: { ...h, ignored: {} }, program: programOf("hasher"), file_sha256: programSha("hasher"), scripts: allScripts(), digest };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /hasher hasher:pre-writers:r1 failed: .*digest/);
});

// 2.1.4 trial bug #11: on a yadgarhq/* project intake turned "yaadgaar #622"
// into the frozen legacy ledger task L622. Projects whose id starts with
// yadgarhq/ keep their tasks in yaadgaar (ADR-0994): the script tells intake
// which ledger to use, a "#N" there is a yaadgaar task, and the sealed source
// names the ledger.
const YQ = { ...ARGS, input: "yaadgaar #622", project: "yadgarhq/docs" };
const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };

test("2.1.5 yaadgaar: intake is told the ledger by project; the task id and the sealed source name yaadgaar", async () => {
  const s = happy({ brief: YBRIEF });
  const out = await runOne(s, YQ);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const it = call(out, "intake");
  assert.equal(inputsOf(it.prompt).ledger, "yaadgaar");
  assert.match(it.prompt, /mcp__yaadgaar__read_task/);
  assert.match(it.prompt, /never.*L<N>|never map/i);
  assert.equal(out.result.branch, "fleet/y622-mark-plain-scalars");
  assert.equal(out.result.plan_ref.plan_ref, "refs/fleet/y622/plan");
  const ref = JSON.parse(s.__store[out.result.plan_ref.plan_commit]);
  assert.deepEqual(ref.brief.sources.map((x) => x.kind + ":" + x.ref), ["yaadgaar:622"]);
  // another project keeps the yadgar ledger
  const o = await runOne(happy(), ARGS);
  assert.equal(inputsOf(call(o, "intake").prompt).ledger, "yadgar");
});

test("2.1.5 yaadgaar: a legacy ledger source on a yadgarhq/ project stops before the workspace", async () => {
  for (const input of ["#622", "622", "yaadgaar #622", "L622"]) {
    const s = happy({ brief: { ...YBRIEF, sources: [{ kind: "ledger", ref: "622", url: null, body: "TLS_ROTATION knob, done" }] } });
    const out = await runOne(s, { ...YQ, input });
    assert.equal(out.result.status, "needs_human", input);
    assert.match(out.result.reason, /yaadgaar/, input);
    assert.ok(!out.labels.includes("workspace"), input);
  }
});

test("2.1.5 yaadgaar: a yaadgaar source on another project stops", async () => {
  const out = await runOne(happy({ brief: YBRIEF }), { ...ARGS, input: "yaadgaar #622" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /yaadgaar/);
  assert.ok(!out.labels.includes("workspace"));
});

test("2.1.5 yaadgaar: build re-reads the yaadgaar task, never L<N>", async () => {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, { ...YQ, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["intake:rulings"] = { status: "ok", reason: "re-read", brief: YBRIEF };
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
  s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["infra:yaadgaar-read"] = yaadgaarRead();
  s["infra:yaadgaar-writeback"] = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
  const build = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs", confirm: "auto" });
  noUnscripted(build);
  assert.equal(build.result.status, "ok", build.result.reason);
  const rr = inputsOf(call(build, "intake:rulings").prompt);
  assert.equal(rr.input, "yaadgaar #622");
  assert.equal(rr.ledger, "yaadgaar");
  assert.equal(inputsOf(call(build, "role:fleet-intent-judge:rerun").prompt).ledger_task.ref, "622");
  // 3.0.0 (ledger 1928): the yaadgaar step writes; never the yadgar ledger
  assert.ok(!build.labels.includes("infra:ledger-writeback"));
  assert.ok(build.labels.includes("infra:yaadgaar-writeback"));
});

test("2.1.5 yaadgaar: a sealed legacy ledger source on a yadgarhq/ project stops the build", async () => {
  const s = happy();
  // 4.0.0 (1992): planned without project, so the build's project is not a mismatch
  const plan = await runOne(s, { ...ARGS, project: undefined });
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /yaadgaar.*re-run plan/);
  assert.ok(!out.labels.some((l) => ROLE_LABEL.test(l)));
});

// 2.1.4 trial bug #1: a session started before a plugin update keeps the old
// workflow; the contract stop now says how to load the new one.
test("2.1.5 a contract mismatch tells the user to reload the plugins", async () => {
  const s = happy();
  s.preflight = { ...s.preflight, contract: { ...s.preflight.contract, "scope-and-plan": "CONTRACT: fleet-v3" } };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract fleet-v3 != fleet-v4/);
  assert.match(out.result.reason, /\/reload-plugins or start a new session/);
  const r = happy({ script: { "role:scope-and-plan": { status: "ok", role_contract: "CONTRACT: fleet-v3" } } });
  const o2 = await runOne(r, ARGS);
  assert.match(o2.result.reason, /\/reload-plugins or start a new session/);
});

// 2.1.4 trial bug #7: a criterion about NBSP was written with a raw or
// escaped NBSP, which the JSON path turned into a plain space. Examples and
// properties must not hold invisible, whitespace-confusable or control
// characters; a special character is named (NBSP = chr(0xA0)). Visible
// non-ASCII (an em dash, a smart quote, an arrow) and the text, dont_care and
// spec_quote fields are not checked.
test("2.1.5 criteria: an invisible or confusable character in examples or property stops before the audit", async () => {
  const bads = ["a b", "zero​width", "en space", "line sep", "nnbsp ", "mm sp", "ideo　sp", "bom﻿", "bell\u0007", "cr\rlf", "c1\u0085", "bidi‮", "iso⁦x", "alm؜"];
  for (const bad of bads) {
    for (const field of ["examples", "property"]) {
      const crit = criteria(2);
      crit[1][field] = field === "examples" ? ["ok", bad] : { holds: bad };
      const out = await runOne(happy({ criteria: crit }), ARGS);
      assert.equal(out.result.status, "needs_human", field + " " + JSON.stringify(bad));
      assert.match(out.result.reason, /AC2.*invisible or confusable character U\+/, JSON.stringify(bad));
      assert.match(out.result.reason, /named constant/);
      assert.ok(!out.labels.includes("role:plan-audit"));
    }
  }
});

// 2.1.6 (ledger 1954): text and dont_care are now checked too (test writers get
// the whole criterion); only spec_quote, a verbatim copy, stays unchecked.
test("2.1.6 criteria: visible non-ASCII, tabs, newlines and a confusable spec_quote pass", async () => {
  const crit = criteria(2);
  crit[0].text = "Keep a b — NBSP = chr(0xA0); “quoted” ≥ 2 → ok";
  crit[0].dont_care = ["log wording — “any”"];
  crit[0].spec_quote = "“Smart” quote — copied verbatim";
  crit[0].examples = ["tab\there", "line\nbreak", "ünï — “x” → ≥", "'a' + NBSP + 'b'"];
  crit[0].property = { input: "αβγ", note: "em — dash" };
  const ok = await runOne(happy({ criteria: crit }), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("2.1.5 confirm auto: a confusable character in the criteria goes to the one :audit-fix round", async () => {
  const crit = criteria(2);
  crit[1].examples = ["a b"];
  const s = autoHappy({ criteria: crit });
  s["role:scope-and-plan:audit-fix"] = { ...s["role:scope-and-plan"], criteria: criteria(2) };
  s["role:plan-audit:audit-fix"] = s["role:plan-audit"];
  const out = await runOne(s, AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const l = out.labels;
  assert.ok(!l.includes("infra:format-plan") && !l.includes("role:plan-audit"), "no format or audit for the refused plan");
  const b = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).brief;
  assert.ok(b.sources.some((x) => x.kind === "text" && /AC2: .*U\+00A0/.test(x.body)));
  // still bad after the rounds: 4.0.0 (1983) stops after round 2, never a third
  const t = autoHappy({ criteria: crit });
  t["role:scope-and-plan:audit-fix"] = t["role:scope-and-plan"];
  const o2 = await runOne(t, AUTO);
  assert.equal(o2.result.status, "needs_human");
  assert.match(o2.result.reason, /invisible or confusable.*\(after 2 re-plan rounds\)/);
  assert.ok(o2.labels.includes("role:scope-and-plan:audit-fix-2"));
  assert.ok(!o2.labels.some((x) => /audit-fix-3|audit-fix:audit-fix/.test(x)));
  // 4.0.0 (1983): confirm ask gets the same rounds
  const o3 = await runOne(happy({ criteria: crit }), ARGS);
  assert.equal(o3.result.status, "needs_human");
  assert.ok(o3.labels.includes("role:scope-and-plan:audit-fix-2"));
});

// 2.1.4 trial bug #3: under confirm auto a plan-audit refusal stopped the run
// and the findings never reached the planner. One automatic re-plan round
// now gets them; a second refusal stops as before.
test("2.1.5 confirm auto: a plan-audit refusal gets one re-plan round with the findings", async () => {
  const s = autoHappy();
  s["role:plan-audit"] = { status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding: "NBSP example lost" }] };
  s["role:scope-and-plan:audit-fix"] = s["role:scope-and-plan"];
  s["role:plan-audit:audit-fix"] = { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] };
  const out = await runOne(s, AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const l = out.labels;
  assert.ok(l.indexOf("role:scope-and-plan:audit-fix") > l.indexOf("role:plan-audit"));
  assert.ok(l.indexOf("role:plan-audit:audit-fix") > l.indexOf("infra:format-plan:audit-fix"));
  const b = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).brief;
  assert.equal(b.plan_path, "docs/plans/x.md", "the draft is updated in place");
  assert.ok(b.sources.some((x) => x.kind === "text" && /AC1: NBSP example lost/.test(x.body)));
  // the sealed brief is the task's, without the audit findings
  assert.ok(!JSON.stringify(inputsOf(call(out, "role:fleet-intent-judge").prompt).brief).includes("NBSP example lost"));
});

test("2.1.5 confirm auto: a third plan-audit refusal stops (4.0.0: 2 rounds); confirm ask re-plans too", async () => {
  const s = autoHappy();
  s["role:plan-audit"] = { status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [] };
  s["role:plan-audit:audit-fix"] = { status: "ok", reason: "still", verdict: "untestable_criteria", routed_findings: [] };
  s["role:plan-audit:audit-fix-2"] = s["role:plan-audit:audit-fix"];
  s["role:scope-and-plan:audit-fix"] = s["role:scope-and-plan"];
  const out = await runOne(s, AUTO);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan-audit verdict untestable_criteria.*\(after 2 re-plan rounds\)/);
  assert.ok(out.labels.includes("role:plan-audit:audit-fix-2"));
  assert.ok(!out.labels.some((x) => /audit-fix-3|audit-fix:audit-fix/.test(x)));
  const a = happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect" } } });
  const o2 = await runOne(a, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.ok(o2.labels.includes("role:scope-and-plan:audit-fix"));
  assert.ok(o2.labels.includes("role:scope-and-plan:audit-fix-2"));
});

// 2.1.4 trial bug #6: a free-text task took its slug from the model-written
// title, so every re-plan made a new branch and worktree, and every free-text
// task shared the task id "task" (one plan ref for all of them). The id and
// slug now derive from the text itself.
test("2.1.5 free text: task id and slug derive from the text, not the model's title", async () => {
  const body = "Make the Foo parser keep NBSP inside quoted scalars";
  const brief = (title, b) => ({ ...BRIEF, title, sources: [{ kind: "text", ref: "text", url: null, body: b }] });
  const a = await runOne(happy({ brief: brief("Keep NBSP in quoted scalars", body) }), { ...ARGS, input: body });
  const b = await runOne(happy({ brief: brief("Foo parser: preserve NBSP", body) }), { ...ARGS, input: body });
  assert.equal(a.result.status, "awaiting_confirmation", a.result.reason);
  const id = "t" + sha256(body).slice(0, 8);
  assert.equal(a.result.branch, "fleet/" + id + "-make-the-foo-parser-keep-nbsp-inside-quo");
  assert.equal(b.result.branch, a.result.branch, "same text, same branch, whatever the title");
  assert.equal(a.result.plan_ref.plan_ref, "refs/fleet/" + id + "/plan");
  const c = await runOne(happy({ brief: brief("x", "another change") }), { ...ARGS, input: "another change" });
  assert.notEqual(c.result.plan_ref.plan_ref, a.result.plan_ref.plan_ref, "another text, another plan ref");
});

// Review of #33 (minor findings).
test("2.1.5 free text: the task id hashes the raw input, not the relayed body", async () => {
  const raw = "Make the Foo parser keep NBSP";
  const brief = { ...BRIEF, title: "t", sources: [{ kind: "text", ref: "text", url: null, body: raw + " (relayed, changed)" }] };
  const out = await runOne(happy({ brief }), { ...ARGS, input: raw });
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(out.result.branch, "fleet/t" + sha256(raw).slice(0, 8) + "-make-the-foo-parser-keep-nbsp");
});

test("2.1.5 an ingested plan gets its own task id from the plan path", async () => {
  const brief = (p) => ({ ...BRIEF, title: "Foo Bar", sources: [{ kind: "plan", ref: p, url: null, body: "# plan" }], plan_path: p });
  const run1 = async (p) => {
    const s = happy({ brief: brief(p) });
    s["role:scope-and-plan"].plan_path = p;
    return runOne(s, { ...ARGS, input: p });
  };
  const a = await run1("docs/plans/a.md");
  const b = await run1("docs/plans/b.md");
  assert.equal(a.result.status, "awaiting_confirmation", a.result.reason);
  assert.equal(a.result.plan_ref.plan_ref, "refs/fleet/p" + sha256("docs/plans/a.md").slice(0, 8) + "/plan");
  assert.notEqual(a.result.plan_ref.plan_ref, b.result.plan_ref.plan_ref);
});

test("2.1.5 a plan_path that is absolute, climbs out or is not .md stops before any park or audit", async () => {
  for (const p of ["/etc/x.md", "docs/../../x.md", "../x.md", "docs/plans/x.txt", "docs/plans/x"]) {
    const s = happy();
    s["role:scope-and-plan"].plan_path = p;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", p);
    assert.match(out.result.reason, /plan_path/, p);
    assert.ok(!out.labels.includes("infra:park-plan"), p);
    assert.ok(!out.labels.includes("role:plan-audit"), p);
  }
});

test("2.1.5 a crash after the planner still parks the draft and rethrows the original error", async () => {
  const s = happy();
  s["infra:format-plan"] = () => {
    throw new Error("transport died");
  };
  let parked = null;
  s["infra:park-plan"] = (p) => {
    parked = inputsOf(p).plan_path;
    return { status: "ok", reason: "parked", target: inputsOf(p).dest, clean: true };
  };
  await assert.rejects(() => runOne(s, ARGS), /transport died/);
  assert.equal(parked, "docs/plans/x.md");
});

test("2.1.5 canonical JSON sorts keys by code point, as Python sort_keys does", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-sort-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    const files = ["test_\u{1F600}.py", "test_！.py"];
    for (const f of files) writeFileSync(join(wt, f), "def test_a():\n    pass\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const out = runHasherRaw(wt, "hash", files);
    // the workflow accepts the program's digest for these keys
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    const o = { fingerprint: out.fingerprint, hashes: out.hashes, program: out.program, scripts: out.scripts };
    assert.equal(sha256(fn(o)), out.digest);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("2.1.5 a hasher result with a matching digest but no ignored map still fails as incomplete", async () => {
  const s = happy();
  const h = { files: {}, sections: {}, git: {}, symlinks: {}, suspicious: [] };
  const digest = sha256(canon({ fingerprint: FP_PRE, hashes: h }));
  s["hasher:pre-writers:r1"] = { __raw: true, status: "ok", fingerprint: FP_PRE, hashes: h, digest };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /hasher hasher:pre-writers:r1 failed: incomplete output/);
});

// The workflow's canonical() and its code-point comparator, as source.
function extractCanonical() {
  const grab = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  return grab("codePointCompare") + grab("canonical");
}

// ---------------------------------------------------------------- 2.1.6

// Ledger 1955: a build from a fleet-audited plan shipped a guard weakening
// (yadgarhq/actions#211 B1): the plan changed guard_verdict but modelled one
// of its two call sites; prestop_sleep, the other, was never looked at. The
// planner now returns changed_symbols: every occurrence of each changed
// symbol, mapped to a criterion or to dont_care with a reason. The script
// checks the map and diffs it against a word-boundary git grep.

// The caller-grep program's output for {symbol: ["<path>:<line>", ...]}, with its digest.
function callersOut(occ, capped) {
  const o = { occurrences: occ, capped: capped || [], auto_dont_care: {}, doctest_md: [] };
  return { status: "ok", reason: "grepped", ...o, digest: sha256(canon(o)) };
}

const GV_DEF = { at: "chart/guards.py:10", criterion: "AC1", dont_care: null };
const GV_RENDER = { at: "chart/render.py:42", criterion: "AC2", dont_care: null };
const GV_PRESTOP = { at: "chart/render.py:77", criterion: "AC2", dont_care: null };
const GV_HITS = { guard_verdict: ["chart/guards.py:10", "chart/render.py:42", "chart/render.py:77"] };

// A plan that changes guard_verdict and maps `occ`; the grep finds `hits`.
function callerPlan(occ, hits, mk) {
  const s = (mk || happy)();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "guard_verdict", occurrences: occ }];
  s["infra:callers"] = callersOut(hits || GV_HITS);
  return s;
}

test("2.1.6 incident: one function, two call sites, the plan maps one -> refused before format and audit; grep names the other", async () => {
  const out = await runOne(callerPlan([GV_DEF, GV_RENDER]), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /guard_verdict/);
  assert.match(out.result.reason, /chart\/render\.py:77/);
  assert.match(out.result.reason, /not mapped/);
  assert.ok(out.labels.includes("infra:callers"));
  assert.ok(!out.labels.includes("infra:format-plan"));
  assert.ok(!out.labels.includes("role:plan-audit"));
});

test("2.1.6 incident under confirm auto: one :audit-fix re-plan with the grep finding; a second miss stops", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER], null, autoHappy);
  s["role:scope-and-plan:audit-fix"] = { ...s["role:scope-and-plan"], changed_symbols: [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }] };
  s["infra:callers:audit-fix"] = callersOut(GV_HITS);
  s["role:plan-audit:audit-fix"] = s["role:plan-audit"];
  const out = await runOne(s, AUTO);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:plan-audit"), "the refused plan is never audited");
  const b = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).brief;
  assert.ok(b.sources.some((x) => x.kind === "text" && /guard_verdict: chart\/render\.py:77/.test(x.body)));
  // still unmapped after the round: stop, no second round
  const t = callerPlan([GV_DEF, GV_RENDER], null, autoHappy);
  t["role:scope-and-plan:audit-fix"] = t["role:scope-and-plan"];
  t["infra:callers:audit-fix"] = callersOut(GV_HITS);
  const o2 = await runOne(t, AUTO);
  assert.equal(o2.result.status, "needs_human");
  assert.match(o2.result.reason, /chart\/render\.py:77/);
  assert.ok(!o2.labels.includes("role:scope-and-plan:audit-fix:audit-fix"));
  assert.ok(!o2.labels.includes("infra:callers:audit-fix:audit-fix"));
});

test("2.1.6 a full caller map passes; the audit gets the map and the grep result; the grep runs read-only with the symbols and the plan excluded", async () => {
  const out = await runOne(callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const g = call(out, "infra:callers");
  assert.equal(g.opts.agentType, "fleet:judge");
  const gi = inputsOf(g.prompt);
  assert.deepEqual(gi.symbols, ["guard_verdict"]);
  assert.equal(gi.plan_path, "docs/plans/x.md");
  assert.ok(g.prompt.includes("python3 -I '" + SCRIPTS_DIR + "/callers.py'"));
  assert.match(g.prompt, /'\["guard_verdict"\]'/);
  assert.match(g.prompt, /Run nonce: /);
  const l = out.labels;
  assert.ok(l.indexOf("infra:callers") < l.indexOf("infra:format-plan"));
  const a = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(a.changed_symbols, [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }]);
  assert.deepEqual(a.caller_check.occurrences, GV_HITS);
  assert.match(a.caller_check.method, /git grep/);
  assert.ok(Array.isArray(a.caller_check.limits) && a.caller_check.limits.length);
});

test("2.1.6 no changed symbols: no grep step, and the audit is told the map is empty", async () => {
  const out = await runOne(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(!out.labels.some((x) => x.startsWith("infra:callers")));
  const a = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(a.changed_symbols, []);
  assert.equal(a.caller_check.occurrences, null);
});

test("2.1.6 a planner ok output without changed_symbols is contract drift", async () => {
  const s = happy();
  const p = Object.assign({}, REQUIRED_DEFAULTS["scope-and-plan"], s["role:scope-and-plan"], { __raw: true, role_version: FROZEN_VERSIONS["scope-and-plan"], role_contract: CONTRACT_LINE });
  delete p.changed_symbols;
  s["role:scope-and-plan"] = p;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /role scope-and-plan contract drift: missing changed_symbols/);
  const q = happy();
  q["role:scope-and-plan"].changed_symbols = "[]";
  const o2 = await runOne(q, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.match(o2.result.reason, /contract drift: scope-and-plan changed_symbols type/);
});

test("2.1.6 caller map structure: every malformed entry is refused before any grep", async () => {
  const sym = (symbol, occurrences) => [{ symbol, occurrences }];
  const occ = (o) => sym("guard_verdict", [Object.assign({}, GV_DEF, o)]);
  const cases = [
    [sym("guard_verdict; rm -rf /", [GV_DEF]), /symbol/],
    [sym("$(id)", [GV_DEF]), /symbol/],
    [sym("a b", [GV_DEF]), /symbol/],
    [sym("1abc", [GV_DEF]), /symbol/],
    [sym("", [GV_DEF]), /symbol/],
    [sym("x".repeat(129), [GV_DEF]), /symbol/],
    [[{ symbol: "guard_verdict" }], /no occurrences list/],
    [sym("guard_verdict", "chart/guards.py:10"), /no occurrences list/],
    [sym("guard_verdict", []), /no occurrences list/],
    [occ({ at: "chart/guards.py" }), /path:line/],
    [occ({ at: "chart/guards.py:0" }), /path:line/],
    [occ({ at: "chart/guards.py:3a" }), /path:line/],
    [occ({ at: "/abs/guards.py:3" }), /path:line/],
    [occ({ at: "../guards.py:3" }), /path:line/],
    [occ({ at: 10 }), /path:line/],
    [occ({ criterion: null, dont_care: null }), /neither a criterion nor dont_care/],
    [occ({ criterion: null, dont_care: "   " }), /neither a criterion nor dont_care/],
    [occ({ criterion: "AC1", dont_care: "unrelated" }), /both a criterion and dont_care/],
    [occ({ criterion: "AC9" }), /criterion AC9 does not exist/],
    [[{ symbol: "guard_verdict", occurrences: [GV_DEF] }, { symbol: "guard_verdict", occurrences: [GV_RENDER] }], /listed twice/],
    [sym("guard_verdict", [GV_DEF, { ...GV_DEF, criterion: "AC2" }]), /chart\/guards\.py:10 listed twice/],
    [["guard_verdict"], /not an object/],
  ];
  for (const [cs, re] of cases) {
    const s = happy();
    s["role:scope-and-plan"].changed_symbols = cs;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(cs));
    assert.match(out.result.reason, /changed_symbols/, JSON.stringify(cs));
    assert.match(out.result.reason, re, JSON.stringify(cs));
    assert.ok(!out.labels.some((x) => x.startsWith("infra:callers")), "no grep: " + JSON.stringify(cs));
    assert.ok(!out.labels.includes("role:plan-audit"), JSON.stringify(cs));
  }
  // a manual criterion is a real criterion id; a dont_care alone is fine
  const crit = criteria(2);
  crit[1].test_files = [];
  const s = happy({ criteria: crit });
  s["role:scope-and-plan"].changed_symbols = sym("guard_verdict", [GV_DEF, { at: "chart/render.py:42", criterion: null, dont_care: "logging only" }, GV_PRESTOP]);
  s["infra:callers"] = callersOut(GV_HITS);
  const ok = await runOne(s, ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("2.1.6 too many changed symbols is refused before any grep", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = Array.from({ length: 31 }, (_, i) => ({ symbol: "f" + i, occurrences: [{ at: "a.py:" + (i + 1), criterion: "AC1", dont_care: null }] }));
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /changed_symbols.*31 symbols/);
  assert.ok(!out.labels.some((x) => x.startsWith("infra:callers")));
});

test("2.1.6 a mapped line the grep does not find is refused (stale or invented)", async () => {
  const out = await runOne(callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP, { at: "chart/render.py:90", criterion: "AC2", dont_care: null }]), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /guard_verdict: chart\/render\.py:90 .*no occurrence/);
  assert.ok(!out.labels.includes("role:plan-audit"));
});

test("2.1.6 a mapped path is compared after normalisation", async () => {
  const out = await runOne(callerPlan([{ ...GV_DEF, at: "./chart//guards.py:10" }, GV_RENDER, GV_PRESTOP]), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("2.1.6 a symbol over the grep cap is refused, never silently cut", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  s["infra:callers"] = callersOut({ guard_verdict: [] }, ["guard_verdict"]);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /guard_verdict: more than 100 occurrences/);
});

test("2.1.6 a grep result whose relayed lists do not match the program's digest fails", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER]);
  // the relay dropped the prestop line: the digest is still the program's
  const full = callersOut(GV_HITS);
  s["infra:callers"] = { ...full, occurrences: { guard_verdict: ["chart/guards.py:10", "chart/render.py:42"] } };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /infra:callers.*digest/);
  // a list missing for a symbol fails too
  const t = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  t["infra:callers"] = callersOut({});
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "failed");
  assert.match(o2.result.reason, /infra:callers.*guard_verdict/);
});

test("2.1.6 the caller map is sealed in plan_facts and reaches the coder and the code judge", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const want = [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }];
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r1").prompt).changed_symbols, want);
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).changed_symbols, want);
  const ref = JSON.parse(s.__store[out.planResult.plan_ref.plan_commit]);
  assert.deepEqual(ref.plan_facts.changed_symbols, want);
});

test("2.1.6 caller grep program: word-boundary hits in tracked text files, the plan doc excluded, cap and digest", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-callers-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    spawnSync("mkdir", ["-p", join(wt, "chart"), join(wt, "docs", "plans")]);
    writeFileSync(join(wt, "chart", "guards.py"), "def guard_verdict(x):\n    return x\n");
    writeFileSync(
      join(wt, "chart", "render.py"),
      "from chart.guards import guard_verdict\n" +
        "a = guard_verdict(1)\n" +
        "b = guard_verdict_extra(2)\n" +
        "c = my_guard_verdict(3)\n" +
        "d = guard_verdict(4)  # prestop_sleep\n",
    );
    writeFileSync(join(wt, "docs", "plans", "x.md"), "changes guard_verdict\n");
    writeFileSync(join(wt, "blob.bin"), Buffer.from("guard_verdict\0\x01\x02"));
    writeFileSync(join(wt, "x y.py"), "guard_verdict()\n");
    writeFileSync(join(wt, "many.py"), "z = 1\n".repeat(6));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    writeFileSync(join(wt, "untracked.py"), "guard_verdict()\n");
    const prog = extractPy("CALLERS_PY_BEGIN", "CALLERS_PY_END", "CALLERS_PY");
    const r = spawnSync("python3", ["-I", "-", wt, "docs/plans/x.md", JSON.stringify(["guard_verdict", "nohit", "z"]), "5"], { input: prog, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.occurrences.guard_verdict, ["chart/guards.py:1", "chart/render.py:1", "chart/render.py:2", "chart/render.py:5", "x y.py:1"].sort());
    assert.deepEqual(o.occurrences.nohit, []);
    // "z" is a word on more than 5 lines: capped, its list left empty; guard_verdict (5) is not
    assert.deepEqual(o.capped, ["z"]);
    assert.deepEqual(o.occurrences.z, []);
    // 4.0.0 (1989): the digest covers the auto dont_care map and the doctest list too
    const dig = { occurrences: o.occurrences, capped: o.capped, auto_dont_care: o.auto_dont_care, doctest_md: o.doctest_md, program: o.program };
    assert.equal(o.digest, sha256(canon(dig)));
    // the workflow accepts this digest
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    assert.equal(sha256(fn(dig)), o.digest);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 2.1.6 minors (ledger 1954)

// M12: the load-ref retry must check the re-read ref's metadata as well.
test("2.1.6 load-ref retry: correct chunks but a ref that now targets another commit stops", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const good = loadStub(s.__store);
  s["infra:load-ref"] = (p) => {
    const r = good(p);
    r.chunks = r.chunks.slice();
    r.chunks[0] = "[truncated]";
    return r;
  };
  s["infra:load-ref:retry"] = (p) => {
    const r = good(p);
    r.refs = r.refs.map((e) => (e.name === tiny.plan_ref ? { ...e, target: "deadbee" } : e));
    return r;
  };
  const out = await runOne(s, buildArgs(tiny));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan ref missing or changed; re-run plan.*targets deadbee, not /);
  assert.ok(!out.labels.some((x) => x.startsWith("role:")));
});

test("2.1.6 criteria: a confusable character in text or dont_care stops too (writers get the whole criterion)", async () => {
  for (const [field, v] of [["text", "[unit] keep a b"], ["dont_care", ["zero​width"]]]) {
    const crit = criteria(2);
    crit[1][field] = v;
    const out = await runOne(happy({ criteria: crit }), ARGS);
    assert.equal(out.result.status, "needs_human", field);
    assert.match(out.result.reason, new RegExp("AC2: invisible or confusable character U\\+[0-9A-F]+ at " + field), field);
    assert.ok(!out.labels.includes("role:plan-audit"), field);
  }
});

test("2.1.6 criteria: each added confusable class is refused; CR still is; visible typography passes", async () => {
  const cases = {
    "Cf U+2060 word joiner": "a⁠b",
    "Cf U+00AD soft hyphen": "soft­hyphen",
    "Cf U+180E Mongolian vowel separator": "a᠎b",
    "Cf U+E0041 tag": "a\u{E0041}b",
    "Cf U+E0001 language tag": "a\u{E0001}b",
    "U+E0000 (tag block, unassigned)": "a\u{E0000}b",
    "U+E007F cancel tag": "a\u{E007F}b",
    "Zs U+1680 ogham space": "a b",
    "Zl U+2028": "a b",
    "Zp U+2029": "a b",
    "Cc U+0001": "a\u0001b",
    "Cc CR": "a\rb",
    "FE00 variation selector 1": "a︀b",
    "FE0F variation selector 16": "a️b",
    "U+115F Hangul choseong filler": "aᅟb",
    "U+1160 Hangul jungseong filler": "aᅠb",
    "U+3164 Hangul filler": "aㅤb",
    "U+FFA0 halfwidth Hangul filler": "aﾠb",
    "U+034F combining grapheme joiner": "a͏b",
  };
  for (const [name, bad] of Object.entries(cases)) {
    const crit = criteria(2);
    crit[1].examples = ["ok", bad];
    const out = await runOne(happy({ criteria: crit }), ARGS);
    assert.equal(out.result.status, "needs_human", name);
    assert.match(out.result.reason, /AC2: invisible or confusable character U\+/, name);
  }
  const crit = criteria(2);
  crit[0].examples = ["em — dash", "“smart” ‘quotes’", "arrow → ⇒", "ellipsis …", "tab\tand\nnewline", "plain space"];
  crit[0].text = "[unit] « guillemets » — ok";
  const ok = await runOne(happy({ criteria: crit }), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("2.1.6 a crash after the planner logs the park outcome before it rethrows", async () => {
  const s = happy();
  s["infra:format-plan"] = () => {
    throw new Error("transport died");
  };
  let logs = null;
  s["infra:park-plan"] = (p) => ({ status: "ok", reason: "parked", target: inputsOf(p).dest, clean: true });
  await assert.rejects(async () => {
    try {
      await runOne(s, ARGS);
    } catch (e) {
      logs = e.__logs || null;
      throw e;
    }
  }, /transport died/);
  assert.ok(logs, "the harness exposes the logs of a crashed run");
  assert.ok(logs.some((m) => /park-plan; draft plan moved to .*scratch\/parked\//.test(m)), logs.join("\n"));
  // a failed park is logged too
  const t = happy();
  t["infra:format-plan"] = () => {
    throw new Error("transport died");
  };
  t["infra:park-plan"] = { status: "needs_human", reason: "README.md is dirty" };
  let l2 = null;
  await assert.rejects(async () => {
    try {
      await runOne(t, ARGS);
    } catch (e) {
      l2 = e.__logs || null;
      throw e;
    }
  }, /transport died/);
  assert.ok(l2.some((m) => /park-plan; draft plan left in the worktree \(park failed: README\.md is dirty\)/.test(m)), l2.join("\n"));
});

test("2.1.6 a plan_path with a character outside [A-Za-z0-9._/-] stops before any park or audit", async () => {
  for (const p of ["docs/plans/a b.md", "docs/plans/$x.md", "docs/plans/`x`.md", "docs/plans/a;b.md", "docs/plans/ünï.md", "docs/plans/a b.md", "docs/plans/a'b.md"]) {
    const s = happy();
    s["role:scope-and-plan"].plan_path = p;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", p);
    assert.match(out.result.reason, /plan_path .* holds a character outside \[A-Za-z0-9\._\/-\]/, p);
    assert.ok(!out.labels.includes("infra:park-plan"), p);
    assert.ok(!out.labels.includes("role:plan-audit"), p);
  }
  const s = happy();
  s["role:scope-and-plan"].plan_path = "docs/plans/Foo_Bar-2026.11.07.md";
  const ok = await runOne(s, ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("2.1.6 plan_wrong re-plan greps the detached re-plan worktree at the old plan commit, not the fleet worktree", async () => {
  const s = planWrong([{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: y" }]);
  s["role:scope-and-plan:replan"].changed_symbols = [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }];
  s["infra:callers:replan"] = callersOut(GV_HITS);
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const g = inputsOf(call(out, "infra:callers:replan").prompt);
  assert.equal(g.worktree, inputsOf(call(out, "infra:replan-worktree").prompt).worktree);
  assert.match(g.worktree, /\/replan-1$/);
  const l = out.labels;
  assert.ok(l.indexOf("role:scope-and-plan:replan") < l.indexOf("infra:callers:replan"));
  assert.ok(l.indexOf("infra:callers:replan") < l.indexOf("role:plan-audit:replan"));
});

// Gate non-weakening: every code point the 2.1.5 predicate refused is still refused.
test("2.1.6 confusableCp refuses every code point 2.1.5 refused", () => {
  const old = (c) =>
    (c < 0x20 && c !== 9 && c !== 10) ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xa0 ||
    c === 0x61c ||
    (c >= 0x2000 && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202f) ||
    c === 0x205f ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0x3000 ||
    c === 0xfeff;
  const grab = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const consts = SOURCE.split("\n").filter((l) => /^const (CONFUSABLE_CAT_RE|CONFUSABLE_EXTRA) = /.test(l)).join("\n");
  const now = new Function(consts + "\n" + grab("confusableCp") + "\nreturn confusableCp;")();
  const lost = [];
  for (let c = 0; c <= 0x10ffff; c++) if (old(c) && !now(c)) lost.push(c.toString(16));
  assert.deepEqual(lost, []);
  for (const c of [0x20, 9, 10, 0x2014, 0x201c, 0x2192, 0x41]) assert.equal(now(c), false, c.toString(16));
});

// ---------------------------------------------------------------- 2.1.6 review of #35

// HIGH: the :audit-fix round must not let a flagged symbol drop out of the map.
function droppedRound(round2) {
  const s = callerPlan([GV_DEF, GV_RENDER], null, autoHappy);
  s["role:scope-and-plan:audit-fix"] = { ...s["role:scope-and-plan"], changed_symbols: round2 };
  s["infra:callers:audit-fix"] = (p) => callersOut(Object.fromEntries(inputsOf(p).symbols.map((x) => [x, x === "guard_verdict" ? GV_HITS.guard_verdict : ["chart/other.py:3"]])));
  s["role:plan-audit:audit-fix"] = s["role:plan-audit"];
  return s;
}

test("2.1.6 review PoC: the :audit-fix round returns an empty map -> stops, the flagged symbol may not drop out", async () => {
  const out = await runOne(droppedRound([]), AUTO);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /guard_verdict/);
  assert.match(out.result.reason, /dropped/);
  assert.ok(!out.labels.includes("role:plan-audit:audit-fix"));
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix:audit-fix"));
});

test("2.1.6 review PoC: the :audit-fix round swaps the flagged symbol for another -> stops", async () => {
  const out = await runOne(droppedRound([{ symbol: "verdict_core", occurrences: [{ at: "chart/other.py:3", criterion: "AC1", dont_care: null }] }]), AUTO);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /dropped.*guard_verdict/);
  assert.ok(!out.labels.includes("role:plan-audit:audit-fix"));
});

test("2.1.6 review: the :audit-fix round keeps the flagged symbol and adds a narrower one -> passes; the audit gets prior_round", async () => {
  const out = await runOne(
    droppedRound([
      { symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] },
      { symbol: "verdict_core", occurrences: [{ at: "chart/other.py:3", criterion: "AC1", dont_care: null }] },
    ]),
    AUTO,
  );
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const a = inputsOf(call(out, "role:plan-audit:audit-fix").prompt);
  assert.deepEqual(a.prior_round.changed_symbols, [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER] }]);
  assert.ok(a.prior_round.findings.some((f) => /chart\/render\.py:77/.test(f.finding) && f.symbol === "guard_verdict"));
  assert.match(a.prior_round.reason, /changed_symbols/);
  // the first-round audit had no prior round
  const plain = await runOne(callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]), ARGS);
  assert.equal(inputsOf(call(plain, "role:plan-audit").prompt).prior_round, null);
});

test("2.1.6 review: after a plan-audit refusal the round-1 map symbols are carried too", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP], null, autoHappy);
  s["role:plan-audit"] = { status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC2", finding: "prestop path untested" }] };
  s["role:scope-and-plan:audit-fix"] = { ...s["role:scope-and-plan"], changed_symbols: [] };
  const out = await runOne(s, AUTO);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /dropped.*guard_verdict/);
});

test("2.1.6 review: a symbol over the cap stays flagged; narrower symbols only in addition", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  s["infra:callers"] = callersOut({ guard_verdict: [] }, ["guard_verdict"]);
  const out = await runOne(s, ARGS);
  assert.match(out.result.reason, /in addition/);
  assert.doesNotMatch(out.result.reason, /name the narrower symbols the change touches/);
});

test("2.1.6 review: a role page below its pin names the page, the project and the deploy order", async () => {
  const s = happy();
  s.preflight.versions["scope-and-plan"] = 25;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /agent_prompt_get\(scope-and-plan, project m-agahi\/yadgar\) wiki version 25 must be >= 29; update that page in place; see CHANGELOG 4\.0\.0 deploy order/);
});

test("2.1.6 review: a ref sealed before 2.1.6 still builds, and the run says it has no caller coverage", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[tiny.plan_commit]);
  delete ref.plan_facts.changed_symbols;
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  const out = await runOne(s, buildArgs({ ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.some((m) => /without caller coverage/.test(m)), "gate line");
  assert.equal(inputsOf(call(out, "role:fleet-coder:r1").prompt).changed_symbols, null);
});

test("2.1.6 review: the intent judge gets changed_symbols under confirm auto", async () => {
  const out = await runOne(callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP], null, autoHappy), AUTO);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-intent-judge").prompt).changed_symbols, [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }]);
});

test("2.1.6 review: a confusable character in an occurrence's criterion or dont_care is refused", async () => {
  for (const o of [{ ...GV_RENDER, criterion: "AC2​" }, { at: "chart/render.py:42", criterion: null, dont_care: "logging only" }]) {
    const out = await runOne(callerPlan([GV_DEF, o, GV_PRESTOP]), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(o));
    assert.match(out.result.reason, /changed_symbols.*invisible or confusable character U\+/, JSON.stringify(o));
    assert.ok(!out.labels.some((x) => x.startsWith("infra:callers")), JSON.stringify(o));
  }
});

test("2.1.6 review: the grep limits say what is really missed", () => {
  const src = SOURCE.slice(SOURCE.indexOf("const CALLER_METHOD"), SOURCE.indexOf("const PLAN_PATH_CHARS_RE"));
  assert.match(src, /submodule/);
  assert.match(src, /gitattributes/);
  assert.match(src, /built at runtime/);
  assert.match(src, /working tree/);
  assert.doesNotMatch(src, /HEAD state/);
  assert.doesNotMatch(src, /getattr/);
});

// ---------------------------------------------------------------- 3.0.0 (ledger 1957)

// H6: a round refused only for a confusable character still carries its caller map.
test("3.0.0 H6: a round refused only for a confusable character carries its map; the :audit-fix round may not drop a symbol", async () => {
  const mk = (round2) => {
    const crit = criteria(2);
    crit[1].examples = ["a b"];
    const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP], null, () => autoHappy({ criteria: crit }));
    s["role:scope-and-plan:audit-fix"] = { ...s["role:scope-and-plan"], criteria: criteria(2), changed_symbols: round2 };
    s["infra:callers:audit-fix"] = callersOut(GV_HITS);
    s["role:plan-audit:audit-fix"] = s["role:plan-audit"];
    return s;
  };
  const out = await runOne(mk([]), AUTO);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /dropped guard_verdict/);
  assert.ok(!out.labels.includes("infra:callers"), "the refused round never reached the grep");
  const kept = await runOne(mk([{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }]), AUTO);
  noUnscripted(kept);
  assert.equal(kept.result.status, "ok", kept.result.reason);
  const a = inputsOf(call(kept, "role:plan-audit:audit-fix").prompt);
  assert.deepEqual(a.prior_round.changed_symbols, [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }]);
});

// H8: a malformed entry refuses the map, but its valid entries are still carried.
test("3.0.0 H8: a map with a malformed entry carries its valid entries into the :audit-fix round", async () => {
  const mk = (round2) => {
    const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP], null, autoHappy);
    s["role:scope-and-plan"].changed_symbols.push("not an entry");
    s["role:scope-and-plan:audit-fix"] = { ...s["role:scope-and-plan"], changed_symbols: round2 };
    s["infra:callers:audit-fix"] = callersOut(GV_HITS);
    s["role:plan-audit:audit-fix"] = s["role:plan-audit"];
    return s;
  };
  const out = await runOne(mk([]), AUTO);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /dropped guard_verdict/);
  const kept = await runOne(mk([{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }]), AUTO);
  noUnscripted(kept);
  assert.equal(kept.result.status, "ok", kept.result.reason);
  const a = inputsOf(call(kept, "role:plan-audit:audit-fix").prompt);
  assert.deepEqual(a.prior_round.changed_symbols, [{ symbol: "guard_verdict", occurrences: [GV_DEF, GV_RENDER, GV_PRESTOP] }]);
  assert.ok(a.prior_round.findings.some((f) => /entry 1 is not an object/.test(f.finding)));
});

test("3.0.0 plan-audit routed_findings declare an optional symbol; a symbol an audit finding names is carried", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP], null, autoHappy);
  s["role:plan-audit"] = {
    status: "ok",
    reason: "defect",
    verdict: "plan_defect",
    routed_findings: [{ target: "plan", criterion: null, symbol: "prestop_sleep", finding: "prestop_sleep at chart/render.py:70 is unmodelled" }],
  };
  s["role:scope-and-plan:audit-fix"] = s["role:scope-and-plan"];
  s["infra:callers:audit-fix"] = callersOut(GV_HITS);
  const out = await runOne(s, AUTO);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /dropped prestop_sleep/);
  const items = call(out, "role:plan-audit").opts.schema.properties.routed_findings.items;
  assert.deepEqual(items.properties.symbol, { type: "string" });
  assert.ok(items.required.indexOf("symbol") < 0, "symbol stays optional");
});

test("3.0.0 preflight: a page below its pin names the agent_prompt_get wiki version, not a page in that project", async () => {
  const s = happy();
  s.preflight.versions["plan-audit"] = 14;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /agent_prompt_get\(plan-audit, project m-agahi\/yadgar\) wiki version 14/);
  assert.match(out.result.reason, /see CHANGELOG 4\.0\.0 deploy order/);
  assert.doesNotMatch(out.result.reason, /update agent-prompt-plan-audit \(project/);
});

// ---------------------------------------------------------------- 3.0.0 build-time caller check (ledger 1956)

// The PoC of the actions#211 B1 class at build time: the plan maps
// guard_verdict, and the coder also changes prestop_sleep, an existing
// function the plan never modelled. The program lists both; the script
// refuses prestop_sleep.
function defsRepo() {
  const wt = mkdtempSync(join(tmpdir(), "fleet-defs-"));
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  spawnSync("mkdir", ["-p", join(wt, "chart"), join(wt, "tests"), join(wt, "docs", "plans"), join(wt, "web")]);
  const files = {
    "chart/guards.py": "LIMIT = 5\n\n\ndef guard_verdict(x):\n    return x > LIMIT\n\n\ndef untouched(y):\n    return y\n",
    "chart/render.py":
      "from chart.guards import guard_verdict\n\n\ndef render(v):\n    if guard_verdict(v):\n        return 1\n    return 0\n\n\n" +
      "def prestop_sleep(v):\n    if guard_verdict(v):\n        return 10\n    return 0\n\n\n" +
      "class Pod:\n    kind = 'pod'\n\n    def run(self, v):\n        return render(v)\n\n    def stop(self):\n        return 0\n",
    "chart/old.py": "def legacy():\n    return 1\n",
    "tests/test_guards.py": "def test_old():\n    assert True\n",
    "docs/plans/x.md": "plan\n",
    "README.md": "readme\n",
    "web/app.js": "export function boot(a) {\n  return a;\n}\n\nclass App {\n  start(x) {\n    return x;\n  }\n}\n",
    "data.bin": "\0\x01",
  };
  for (const [k, v] of Object.entries(files)) writeFileSync(join(wt, k), v);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  return wt;
}

function runDefs(wt, base, tree, excl) {
  const prog = extractPy("CHANGED_DEFS_PY_BEGIN", "CHANGED_DEFS_PY_END", "CHANGED_DEFS_PY");
  const r = spawnSync("python3", ["-I", "-", wt, base, tree, JSON.stringify(excl || [])], { input: prog, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("3.0.0 changed-defs program: the B1 PoC, an indented method, a constant, a deleted file; new definitions and excluded paths are not listed", { skip: !HAVE_PY }, () => {
  const wt = defsRepo();
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    const w = (k, v) => writeFileSync(join(wt, k), v);
    // in the map: guard_verdict; the constant it reads changes too
    w("chart/guards.py", "LIMIT = 7\n\n\ndef guard_verdict(x):\n    return x >= LIMIT\n\n\ndef untouched(y):\n    return y\n\n\ndef helper(z):\n    return z\n");
    // B1: prestop_sleep's own guard changes; Pod.run (indented) changes; a new method is added to Pod
    w(
      "chart/render.py",
      "from chart.guards import guard_verdict\n\n\ndef render(v):\n    if guard_verdict(v):\n        return 1\n    return 0\n\n\n" +
        "def prestop_sleep(v):\n    if guard_verdict(v) and v:\n        return 10\n    return 0\n\n\n" +
        "class Pod:\n    kind = 'pod'\n\n    def run(self, v):\n        return render(v) + 1\n\n    def stop(self):\n        return 0\n\n    def fresh(self):\n        return 2\n",
    );
    spawnSync("rm", [join(wt, "chart/old.py")]);
    w("chart/new.py", "def brand_new():\n    return 1\n");
    w("tests/test_guards.py", "def test_old():\n    assert 1\n");
    w("docs/plans/x.md", "plan v2\n");
    w("README.md", "readme v2\n");
    w("web/app.js", "export function boot(a) {\n  return a + 1;\n}\n\nclass App {\n  start(x) {\n    return x * 2;\n  }\n}\n");
    w("data.bin", "\0\x02");
    sh(wt, "git", "add", "-A");
    const tree = sh(wt, "git", "write-tree").trim();
    const o = runDefs(wt, base, tree, ["tests/test_guards.py", "docs/plans/x.md"]);
    assert.deepEqual(o.defs, [
      { name: "LIMIT", at: "chart/guards.py:1", end: 1 },
      { name: "guard_verdict", at: "chart/guards.py:4", end: 5 },
      { name: "legacy", at: "chart/old.py:1", end: 2 },
      { name: "prestop_sleep", at: "chart/render.py:10", end: 13 },
      { name: "run", at: "chart/render.py:19", end: 20 },
      { name: "boot", at: "web/app.js:1", end: 2 },
      { name: "start", at: "web/app.js:6", end: 7 },
    ]);
    assert.deepEqual(o.excluded, ["docs/plans/x.md", "tests/test_guards.py"]);
    assert.deepEqual(o.unclassified, ["README.md", "data.bin"]);
    assert.deepEqual(o.unattributed, []);
    const keep = { defs: o.defs, excluded: o.excluded, unclassified: o.unclassified, unattributed: o.unattributed, program: o.program };
    assert.equal(o.digest, sha256(canon(keep)));
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    assert.equal(sha256(fn(keep)), o.digest);
    // no change at all: nothing listed
    const same = runDefs(wt, base, sh(wt, "git", "rev-parse", "HEAD^{tree}").trim(), []);
    assert.deepEqual(same.defs, []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});


test("3.0.0 build caller check: runs read-only after the code judge and before the commit, on the plan commit and the approved tree", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = call(out, "infra:changed-defs:r1");
  assert.equal(c.opts.agentType, "fleet:judge");
  const i = inputsOf(c.prompt);
  assert.equal(i.base, PC);
  assert.equal(i.tree, call(out, "infra:commit:r1") && inputsOf(call(out, "infra:commit:r1").prompt).code_tree);
  assert.deepEqual(i.exclude, ["tests/test_a.py", "tests/test_b.py", "docs/plans/x.md"]);
  assert.ok(c.prompt.includes("python3 -I '" + SCRIPTS_DIR + "/changed_defs.py'"));
  const l = out.labels;
  assert.ok(l.indexOf("role:fleet-code-judge:r1") < l.indexOf("infra:changed-defs:r1"));
  assert.ok(l.indexOf("infra:changed-defs:r1") < l.indexOf("infra:commit:r1"));
  assert.ok(out.result.gate_log.some((m) => /build caller check r1: no existing definition outside changed_symbols/.test(m)));
});

test("3.0.0 build caller check PoC (actions#211 B1): the coder changes an existing function the plan never mapped -> stops before the commit", async () => {
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  s["infra:changed-defs:r1"] = defsOut([
    { name: "guard_verdict", at: "chart/guards.py:10", end: 12 },
    { name: "prestop_sleep", at: "chart/render.py:70", end: 74 },
  ]);
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.match(out.result.reason, /prestop_sleep \(chart\/render\.py:70\)/);
  assert.doesNotMatch(out.result.reason, /guard_verdict \(/);
  assert.ok(!out.labels.includes("infra:commit:r1"), "nothing committed");
  // the mapped symbol alone passes
  const t = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  t["infra:changed-defs:r1"] = defsOut([{ name: "guard_verdict", at: "chart/guards.py:10", end: 12 }]);
  const ok = await run(t, ARGS);
  noUnscripted(ok);
  assert.equal(ok.result.status, "ok", ok.result.reason);
});

test("3.0.0 build caller check: a relay that drops a definition fails the step", async () => {
  const s = happy();
  const good = defsOut([{ name: "prestop_sleep", at: "chart/render.py:10", end: 13 }]);
  s["infra:changed-defs:r1"] = { ...good, defs: [] };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /infra:changed-defs:r1: the relayed lists do not match the program's digest/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
  const t = happy();
  t["infra:changed-defs:r1"] = { status: "ok", reason: "x", defs: "[]", excluded: [], unclassified: [], unattributed: [], digest: "0".repeat(64) };
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "failed");
  assert.match(o2.result.reason, /no defs, excluded, unclassified or unattributed list/);
});

test("3.0.0 build caller check: a ref sealed before 2.1.6 (changed_symbols null) skips the check with a gate line", async () => {
  const s = happy();
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[tiny.plan_commit]);
  delete ref.plan_facts.changed_symbols;
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  const out = await runOne(s, buildArgs({ ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((x) => x.startsWith("infra:changed-defs")));
  assert.ok(out.result.gate_log.some((m) => /build caller check skipped: plan ref sealed before 2\.1\.6/.test(m)));
});

// ---------------------------------------------------------------- 3.0.0 no blob relays (ledger 1952)

// The workflow's planRefProblem and everything it calls, as a function.
function jsPlanRefProblem() {
  const grab = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const k = SOURCE.indexOf("\nconst K256 = [");
  const consts =
    SOURCE.slice(k, SOURCE.indexOf("];", k) + 2) +
    "\nconst SHA256_RE = /^[0-9a-f]{64}$/;\nconst SOURCE_KINDS = " +
    JSON.stringify(["ledger", "yaadgaar", "jira", "github", "codeberg", "plan", "text"]) +
    ";\n";
  assert.match(SOURCE, /const SOURCE_KINDS = \["ledger", "yaadgaar", "jira", "github", "codeberg", "plan", "text"\];/);
  const fns = ["codePointCompare", "canonical", "utf8Bytes", "rotr", "sha256Hex", "sealOf", "normPath", "cleanRepo", "briefProblem", "preflightRecordProblem", "planRefProblem"].map(grab).join("\n");
  return new Function(consts + fns + "\nreturn planRefProblem;")();
}

function scanRepo(home, env) {
  const wt = join(home, "repo");
  const g = (...a) => {
    const r = spawnSync("git", ["-C", wt].concat(a), { encoding: "utf8", env });
    if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr);
    return r.stdout;
  };
  spawnSync("git", ["init", "-q", wt], { env });
  writeFileSync(join(wt, "a.py"), "a\n");
  g("add", "-A");
  g("commit", "-qm", "i");
  g("update-ref", "refs/remotes/origin/master", "HEAD");
  g("checkout", "-qb", "fleet/l42-add-thing");
  spawnSync("mkdir", ["-p", join(wt, "docs", "plans")]);
  writeFileSync(join(wt, "docs", "plans", "x.md"), "# plan\n");
  g("add", "-A");
  g("commit", "-qm", "plan(l42): add-thing");
  return { wt, g };
}

test("3.0.0 branch-scan program: commits and plan-ref checks, no message text; Python and JS agree on the ref checks", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-bscan-"));
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    const { wt, g } = scanRepo(home, env);
    const head = g("rev-parse", "HEAD").trim();
    const writeCmd = planRefWriteCmd;
    const prog = extractPy("BRANCH_SCAN_PY_BEGIN", "BRANCH_SCAN_PY_END", "BRANCH_SCAN_PY");
    const kinds = JSON.stringify(["ledger", "yaadgaar", "jira", "github", "codeberg", "plan", "text"]);
    const scan = () => {
      const r = spawnSync("python3", ["-I", "-", wt, "master", "l42", kinds], { input: prog, encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const problem = jsPlanRefProblem();
    const sealed = (o) => {
      const x = Object.assign({}, o);
      delete x.seal;
      x.seal = sha256(canon(x));
      return x;
    };
    const base = JSON.parse(priorRef("docs/plans/x.md", { tldr: "ünï — 🚀 \"q\" \\ \t", plan_facts: { est_diff_lines: 12, ratio: 0.5, big: 123456789012 } }));
    const cases = [
      ["sealed, non-ASCII and numbers", base],
      ["seal broken", Object.assign({}, base, { tldr: "changed" })],
      ["no slug", sealed(Object.assign({}, base, { slug: "" }))],
      ["branch mismatch", sealed(Object.assign({}, base, { branch: "fleet/l42-other" }))],
      ["bad plan_sha256", sealed(Object.assign({}, base, { plan_sha256: "x" }))],
      ["criteria not a list", sealed(Object.assign({}, base, { criteria: {} }))],
      ["brief source kind", sealed(Object.assign({}, base, { brief: { ...BRIEF, sources: [{ kind: "nope", ref: "1" }] } }))],
      ["brief repo relative", sealed(Object.assign({}, base, { brief: { ...BRIEF, repo: "r" } }))],
      ["brief plan_path ..", sealed(Object.assign({}, base, { brief: { ...BRIEF, plan_path: "../x.md" } }))],
      ["history null", sealed(Object.assign({}, base, { history: null }))],
      // 4.0.0 (1992, history.preflight): the same checks on both sides
      ["project null", sealed(Object.assign({}, base, { project: null }))],
      ["project o/r", sealed(Object.assign({}, base, { project: "o/r" }))],
      ["project 42", sealed(Object.assign({}, base, { project: 42 }))],
      ["project empty", sealed(Object.assign({}, base, { project: "" }))],
      ["preflight ok", sealed(Object.assign({}, base, { history: { runs: 1, preflight: { fleet_version: "4.0.0", versions: {}, dispatch: {}, contract: {} } } }))],
      ["preflight null", sealed(Object.assign({}, base, { history: { runs: 1, preflight: null } }))],
      ["preflight string", sealed(Object.assign({}, base, { history: { runs: 1, preflight: "4.0.0" } }))],
      ["preflight no contract", sealed(Object.assign({}, base, { history: { runs: 1, preflight: { fleet_version: "4.0.0", versions: {}, dispatch: {} } } }))],
      ["preflight list map", sealed(Object.assign({}, base, { history: { runs: 1, preflight: { fleet_version: "4.0.0", versions: [], dispatch: {}, contract: {} } } }))],
      ["preflight empty version", sealed(Object.assign({}, base, { history: { runs: 1, preflight: { fleet_version: "", versions: {}, dispatch: {}, contract: {} } } }))],
    ];
    for (const [what, ref] of cases) {
      const msg = JSON.stringify(ref);
      const w = spawnSync("bash", ["-c", writeCmd(wt, "l42", msg)], { encoding: "utf8", env });
      assert.equal(w.status, 0, w.stderr);
      const o = scan();
      const e = o.refs.find((x) => x.name === "refs/fleet/l42/plan");
      assert.ok(!("content" in e), "no message text");
      assert.ok(!JSON.stringify(o).includes("ünï"), "no message text anywhere");
      assert.equal(e.target, head);
      assert.equal(e.sha256, sha256(msg + "\n"));
      assert.equal(e.ref_ok, problem(JSON.parse(msg)) === null, what + ": python " + e.ref_ok + ", js " + problem(JSON.parse(msg)));
      // names only from an ok ref (review 3)
      assert.equal(e.task_id, e.ref_ok ? "l42" : null);
      assert.equal(e.plan_path, e.ref_ok ? "docs/plans/x.md" : null);
      assert.deepEqual(o.commits, [{ sha: head, subject: "plan(l42): add-thing", files: ["docs/plans/x.md"] }]);
      // 4.0.0 (1986): HEAD's committer time, inside the digest
      assert.ok(Number.isInteger(o.plan_tip_time) && o.plan_tip_time > 0, String(o.plan_tip_time));
      assert.equal(o.digest, sha256(canon({ commits: o.commits, refs: o.refs, plan_tip_time: o.plan_tip_time, program: o.program })));
    }
    assert.equal(scan().refs.filter((x) => x.ref_ok).length >= 0, true);
    // the first case is the real shape: ok in both
    assert.equal(problem(base), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.0.0 branch-scan: the prompt carries the program, not a copy-the-text step; a broken relay fails; ref_ok false is a build commit", async () => {
  const out = await runOne(happy(), ARGS);
  const p = call(out, "infra:branch-scan").prompt;
  assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/branch_scan.py'"));
  assert.doesNotMatch(p, /byte for byte/);
  assert.doesNotMatch(p, /git -C <main_worktree> log/);
  // a dropped entry
  const s = happy({ script: scanOut([planCommit("1111111", [PLAN_MD])], [refEntry("refs/fleet/l42/plan", "1111111", priorRef(PLAN_MD))]) });
  const good = withRelayDigest("infra:branch-scan", JSON.parse(JSON.stringify(s["infra:branch-scan"])));
  s["infra:branch-scan"] = { ...good, refs: [] };
  const o2 = await runOne(s, ARGS);
  assert.equal(o2.result.status, "failed");
  assert.match(o2.result.reason, /infra:branch-scan: the relayed lists do not match the program's digest/);
  // the program says the ref is not ok: the plan commit is a build commit
  const t = happy();
  const meta = { name: "refs/fleet/l42/plan", tag_sha: "7".repeat(40), type: "tag", target: "1111111", target_type: "commit", sha256: "a".repeat(64), task_id: "l42", plan_path: PLAN_MD, ref_ok: false };
  t["infra:branch-scan"] = { status: "ok", reason: "scanned", commits: [planCommit("1111111", [PLAN_MD])], refs: [meta] };
  const o3 = await runOne(t, ARGS);
  assert.equal(o3.result.status, "needs_human");
  assert.match(o3.result.reason, /branch has build commits/);
  t["infra:branch-scan"] = { status: "ok", reason: "scanned", commits: [planCommit("1111111", [PLAN_MD])], refs: [{ ...meta, ref_ok: true }] };
  const o4 = await runOne(t, ARGS);
  assert.equal(o4.result.status, "awaiting_confirmation", o4.result.reason);
});

test("3.0.0 relays carry program digests: fleet-scan, read-state, review-paths, check-scripts", async () => {
  // fleet-scan: a dropped .fleet/ path
  {
    const s = happy();
    const good = withRelayDigest("infra:fleet-scan:push", { status: "ok", reason: "x", diff: [".fleet/l42/x"], commits: [] });
    s["infra:fleet-scan:push"] = { ...good, diff: [] };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "scope");
    assert.match(out.result.reason, /fleet-scan:push: the relayed lists do not match the program's digest/);
  }
  // read-state: a changed message
  {
    const s = happy();
    const tiny = await planRefFor(s);
    const good = withRelayDigest("infra:read-state", { status: "ok", reason: "x", exists: false, target: "", message: "", head: PC, head_tree: "T0", clean: true });
    s["infra:read-state"] = { ...good, exists: true, message: "{}" };
    const out = await runOne(s, buildArgs(tiny));
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "resume");
    assert.match(out.result.reason, /run-state read did not complete/);
    assert.match(call(out, "infra:read-state").prompt, /digest/);
  }
  // review-paths: a dropped gate path, and the prompt runs the program
  {
    const s = happy();
    const good = withRelayDigest("infra:review-paths:v1", { status: "ok", reason: "x", changed_paths: ["src/x.py", ".github/workflows/ci.yaml"] });
    s["infra:review-paths:v1"] = { ...good, changed_paths: ["src/x.py"] };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed");
    assert.match(out.result.reason, /infra:review-paths:v1: the relayed paths do not match the program's digest/);
    const p = call(out, "infra:review-paths:v1").prompt;
    assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/review_paths.py'"));
    assert.doesNotMatch(p, /changed_paths = the lines of `git -C/);
  }
});

test("3.0.0 check-scripts: a relay that flips a verdict makes every script judge-only", async () => {
  const s = withObligations([OB_BUMP]);
  const good = withRelayDigest("infra:check-scripts", { status: "ok", reason: "x", checks: { "scripts/check_version_bump.py": { ok: false, reason: "not tracked" } } });
  s["infra:check-scripts"] = { ...good, checks: { "scripts/check_version_bump.py": { ok: true, reason: "ok" } } };
  const out = await runOne(s, ARGS);
  assert.ok(!("check_cmd" in JSON.parse(s.__store[PC]).plan_facts.repo_obligations[0]), "demoted to judge-only");
  assert.ok(out.result.gate_log.some((m) => /infra:check-scripts: the relayed checks do not match the program's digest; every check_cmd script is judge-only/.test(m)), out.result.gate_log.join("\n"));
  assert.match(call(out, "infra:check-scripts").prompt, /\{checks: \{<path>: \{ok, reason\}\}, program, digest\}/);
});

test("3.0.0 relay programs print digests the workflow accepts (read-state, review-paths, fleet-scan)", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-relays-"));
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    const { wt, g } = scanRepo(home, env);
    const head = g("rev-parse", "HEAD").trim();
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    const runP = (b, e, c, args) => {
      const r = spawnSync("python3", ["-I", "-", wt].concat(args), { input: extractPy(b, e, c), encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const check = (o, keys) => {
      const x = { program: o.program };
      for (const k of keys) x[k] = o[k] === undefined ? null : o[k];
      assert.equal(sha256(fn(x)), o.digest, keys.join(","));
    };
    const st = runP("READ_STATE_PY_BEGIN", "READ_STATE_PY_END", "READ_STATE_PY", ["refs/fleet/l42/state"]);
    assert.deepEqual([st.exists, st.target, st.message], [false, "", ""]);
    check(st, ["exists", "target", "message", "head", "head_tree", "clean"]);
    const rp = runP("REVIEW_PATHS_PY_BEGIN", "REVIEW_PATHS_PY_END", "REVIEW_PATHS_PY", ["refs/remotes/origin/master", head]);
    assert.deepEqual(rp.changed_paths, ["docs/plans/x.md"]);
    check(rp, ["changed_paths"]);
    const fs = runP("FLEET_SCAN_PY_BEGIN", "FLEET_SCAN_PY_END", "FLEET_SCAN_PY", ["master", head]);
    check(fs, ["diff", "commits"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.0.0 review of the build caller check

test("3.0.0 review: a same-named function in another file is not covered by the mapped one -> stops", async () => {
  // validate() in chart/a.py is mapped; validate() in chart/b.py changes too
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "validate", occurrences: [{ at: "chart/a.py:3", criterion: "AC1", dont_care: null }] }];
  s["infra:callers"] = callersOut({ validate: ["chart/a.py:3"] });
  s["infra:changed-defs:r1"] = defsOut([
    { name: "validate", at: "chart/a.py:3", end: 6 },
    { name: "validate", at: "chart/b.py:8", end: 11 },
  ]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.match(out.result.reason, /validate \(chart\/b\.py:8, mapped only elsewhere\)/);
  assert.doesNotMatch(out.result.reason, /chart\/a\.py:3/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
  // the same file, an occurrence outside the definition's lines: not covered either
  const t = happy();
  t["role:scope-and-plan"].changed_symbols = [{ symbol: "validate", occurrences: [{ at: "chart/a.py:30", criterion: "AC1", dont_care: null }] }];
  t["infra:callers"] = callersOut({ validate: ["chart/a.py:30"] });
  t["infra:changed-defs:r1"] = defsOut([{ name: "validate", at: "chart/a.py:3", end: 6 }]);
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.stop_gate, "callers", o2.result.reason);
});

test("3.0.0 review: the program records every definition of a name, path-aware", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-defs2-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    spawnSync("mkdir", ["-p", join(wt, "chart")]);
    writeFileSync(join(wt, "chart/a.py"), "import os\n\n\ndef validate(x):\n    return x\n");
    writeFileSync(join(wt, "chart/b.py"), "class A:\n    def validate(self):\n        return 1\n\n\nclass B:\n    def validate(self):\n        return 2\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "chart/a.py"), "import os\n\n\ndef validate(x):\n    return not x\n");
    writeFileSync(join(wt, "chart/b.py"), "class A:\n    def validate(self):\n        return 1\n\n\nclass B:\n    def validate(self):\n        return 3\n");
    sh(wt, "git", "add", "-A");
    const o = runDefs(wt, base, sh(wt, "git", "write-tree").trim(), []);
    assert.deepEqual(o.defs, [
      { name: "validate", at: "chart/a.py:4", end: 5 },
      { name: "validate", at: "chart/b.py:7", end: 8 },
    ]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review: path names with non-printable characters are printed escaped, so they match no plan path", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-defs3-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    const odd = "we\u0007ird\u200b.py";
    writeFileSync(join(wt, odd), "def f():\n    return 1\n");
    writeFileSync(join(wt, "notes\u0001.txt"), "a\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, odd), "def f():\n    return 2\n");
    writeFileSync(join(wt, "notes\u0001.txt"), "b\n");
    sh(wt, "git", "add", "-A");
    const o = runDefs(wt, base, sh(wt, "git", "write-tree").trim(), []);
    assert.deepEqual(o.defs, [{ name: "f", at: "we\\u0007ird\\u200b.py:1", end: 2 }]);
    assert.deepEqual(o.unclassified, ["notes\\u0001.txt"]);
    for (const x of [JSON.stringify(o.defs), JSON.stringify(o.unclassified)]) assert.ok(!/[\u0000-\u001f\u200b]/.test(JSON.parse(x).map((y) => (typeof y === "string" ? y : y.at)).join("")));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review: Makefile targets, shell functions and shebang scripts are classified; module-level changes are unattributed", { skip: !HAVE_PY }, () => {
  const wt = mkdtempSync(join(tmpdir(), "fleet-defs4-"));
  try {
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    spawnSync("mkdir", ["-p", join(wt, "bin"), join(wt, "chart")]);
    const files = {
      Makefile: "VERSION = 1\n\ntest:\n\tpytest -q\n\nlint:\n\truff .\n",
      "ci.sh": "#!/bin/sh\nset -e\n\nrun_gate() {\n  echo ok\n}\n",
      "bin/tool": "#!/usr/bin/env python3\nimport sys\n\n\ndef main():\n    return 0\n",
      "chart/c.py": "import os\n\n\ndef f():\n    return 1\n",
    };
    for (const [k, v] of Object.entries(files)) writeFileSync(join(wt, k), v);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "Makefile"), "VERSION = 1\n\ntest:\n\tpytest -q -x\n\nlint:\n\truff .\n");
    writeFileSync(join(wt, "ci.sh"), "#!/bin/sh\nset -e\n\nrun_gate() {\n  echo skipped\n}\n");
    writeFileSync(join(wt, "bin/tool"), "#!/usr/bin/env python3\nimport sys\n\n\ndef main():\n    return 1\n");
    writeFileSync(join(wt, "chart/c.py"), "import os\nimport re\n\n\ndef f():\n    return 1\n");
    sh(wt, "git", "add", "-A");
    const o = runDefs(wt, base, sh(wt, "git", "write-tree").trim(), []);
    assert.deepEqual(o.defs, [
      { name: "test", at: "Makefile:3", end: 4 },
      { name: "main", at: "bin/tool:5", end: 6 },
      { name: "run_gate", at: "ci.sh:4", end: 5 },
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
    assert.deepEqual(o.unclassified, []);
    assert.deepEqual(o.unattributed, ["chart/c.py:1"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review: an unclassified file or a module-level change stops unless the plan names the file; every skipped path gets a gate line", async () => {
  const mk = (more, obligations) => {
    const s = obligations ? withObligations(obligations) : happy();
    s["infra:changed-defs:r1"] = defsOut([], more);
    return s;
  };
  const out = await run(mk({ unclassified: ["README.md"], excluded: ["tests/test_a.py"] }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers");
  assert.match(out.result.reason, /unclassified file README\.md/);
  assert.ok(out.result.gate_log.some((m) => /infra:changed-defs:r1: unclassified README\.md/.test(m)));
  assert.ok(out.result.gate_log.some((m) => /infra:changed-defs:r1: skipped tests\/test_a\.py \(frozen test or plan doc\)/.test(m)));
  const o2 = await run(mk({ unattributed: ["chart/c.py:1"] }), ARGS);
  assert.equal(o2.result.stop_gate, "callers", o2.result.reason);
  assert.match(o2.result.reason, /module-level change at chart\/c\.py:1/);
  // a docs file the plan names in a repo obligation passes
  const ok = await run(mk({ unclassified: ["CHANGELOG.md"] }, [Object.assign({}, OB_LOG, { files: ["CHANGELOG.md"] })]), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.ok(ok.result.gate_log.some((m) => /infra:changed-defs:r1: unclassified CHANGELOG\.md/.test(m)));
  // second review: a module-level change in a file whose symbol the plan maps is NOT waived
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  s["infra:changed-defs:r1"] = defsOut([], { unattributed: ["chart/render.py:1"] });
  const o3 = await run(s, ARGS);
  assert.equal(o3.result.stop_gate, "callers", o3.result.reason);
});

// ---------------------------------------------------------------- 3.0.0 fixer hooks on build files (ledger 1951)

function formatOut(over) {
  const o = Object.assign({ ran: true, reason: "ran pre-commit run --files", runs: 1, stable: true, files: [], changed: [], refused: [] }, over || {});
  const keys = ["ran", "reason", "runs", "stable", "files", "changed", "refused"];
  const d = {};
  for (const k of keys) d[k] = o[k];
  return Object.assign({ status: "ok" }, o, { digest: sha256(canon(d)) });
}

test("3.0.0 fixers: writers' test files are formatted before the ownership hash and the test judge; the coder's paths before the purge and the post-coder hash", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const l = out.labels;
  const ft = call(out, "infra:format-tests:r1");
  assert.equal(ft.opts.agentType, undefined, "the fixers write: default agent, not fleet:judge");
  assert.deepEqual(inputsOf(ft.prompt).select, { paths: ["tests/test_a.py", "tests/test_b.py"] });
  assert.deepEqual(inputsOf(ft.prompt).frozen, []);
  assert.ok(l.indexOf("role:fleet-test-writer:AC2:r1") < l.indexOf("infra:format-tests:r1"));
  assert.ok(l.indexOf("infra:format-tests:r1") < l.indexOf("hasher:post-writers:r1"));
  assert.ok(l.indexOf("infra:format-tests:r1") < l.indexOf("role:fleet-test-judge:r1"));
  const fc = call(out, "infra:format-code:r1");
  assert.deepEqual(inputsOf(fc.prompt).select, { dirty: true });
  assert.ok(inputsOf(fc.prompt).frozen.includes("tests/test_a.py"));
  assert.ok(l.indexOf("role:fleet-coder:r1") < l.indexOf("infra:format-code:r1"));
  assert.ok(l.indexOf("infra:format-code:r1") < l.indexOf("infra:purge-bytecode:code-r1"));
  assert.ok(l.indexOf("infra:format-code:r1") < l.indexOf("hasher:post-coder:r1"));
  assert.ok(fc.prompt.includes("python3 -I '" + SCRIPTS_DIR + "/format_files.py'"));
});

test("3.0.0 fixers: a hook that changes a frozen test after freeze, or a path outside its files, stops the run; unsettled hooks stop too", async () => {
  const s = happy();
  s["infra:format-code:r1"] = formatOut({ files: ["src/x.py"], changed: ["src/x.py", "tests/test_a.py"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "hash");
  assert.match(out.result.reason, /changed frozen path\(s\) tests\/test_a\.py after freeze/);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
  const t = happy();
  t["infra:format-code:r1"] = formatOut({ files: ["src/x.py"], changed: ["README.md"] });
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.stop_gate, "scope");
  assert.match(o2.result.reason, /outside the files they were given \(src\/x\.py\): README\.md/);
  const u = happy();
  u["infra:format-tests:r1"] = formatOut({ files: ["tests/test_a.py", "tests/test_b.py"], changed: ["tests/conftest.py"] });
  const o3 = await run(u, ARGS);
  assert.equal(o3.result.stop_gate, "scope");
  const w = happy();
  w["infra:format-code:r1"] = formatOut({ files: ["src/x.py"], changed: ["src/x.py"], runs: 3, stable: false });
  const o4 = await run(w, ARGS);
  assert.equal(o4.result.stop_gate, "commit");
  assert.match(o4.result.reason, /still rewrite files after 3 runs/);
  // a reformat of the coder's own file is accepted and logged
  const v = happy();
  v["infra:format-code:r1"] = formatOut({ files: ["src/x.py"], changed: ["src/x.py"], runs: 2 });
  const o5 = await run(v, ARGS);
  assert.equal(o5.result.status, "ok", o5.result.reason);
  assert.ok(o5.result.gate_log.some((m) => /infra:format-code:r1: fixer hooks ran 2x on 1 file\(s\); reformatted src\/x\.py/.test(m)));
});

test("3.0.0 fixers: no pre-commit is a gate line; a relay that drops a changed path fails", async () => {
  const s = happy();
  s["infra:format-code:r1"] = formatOut({ ran: false, reason: "pre-commit is not installed", runs: 0, files: ["src/x.py"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.some((m) => /infra:format-code:r1: fixer hooks not run \(pre-commit is not installed\)/.test(m)));
  const t = happy();
  t["infra:format-code:r1"] = { ...formatOut({ files: ["src/x.py"], changed: ["tests/test_a.py"] }), changed: [] };
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "failed");
  assert.match(o2.result.reason, /infra:format-code:r1: the relayed result does not match the program's digest/);
});

test("3.0.0 fixer program: runs pre-commit until stable, reports every changed path, leaves frozen files out of --files", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-fmt-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  try {
    spawnSync("mkdir", ["-p", wt, bin]);
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos: []\n");
    writeFileSync(join(wt, "a.py"), "x=1\n");
    writeFileSync(join(wt, "test_a.py"), "y=1\n");
    writeFileSync(join(wt, "other.txt"), "o\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    // the coder's change, and a frozen test
    writeFileSync(join(wt, "a.py"), "x=2\n");
    writeFileSync(join(wt, "test_a.py"), "y=2\n");
    // a fake pre-commit: logs its args, rewrites each file once (a fixer), and
    // touches other.txt when TOUCH_OTHER is set (a pass_filenames: false hook);
    // it runs in a scratch checkout of HEAD (review 4)
    writeFileSync(
      join(bin, "pre-commit"),
      "#!/bin/sh\nshift 2\necho \"$@\" >> \"$LOG\"\nfor f in \"$@\"; do grep -q fmt \"$f\" || echo '# fmt' >> \"$f\"; done\n[ -n \"$TOUCH_OTHER\" ] && echo x >> other.txt\nexit 1\n",
      { mode: 0o755 },
    );
    const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
    const env = (extra) => Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH, LOG: join(home, "log") }, extra || {});
    const runF = (sel, frozen, extra) => {
      const r = spawnSync("python3", ["-I", "-", wt, JSON.stringify(sel), JSON.stringify(frozen), join(home, "scratch"), "180"], { input: prog, encoding: "utf8", env: env(extra) });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const o = runF({ dirty: true }, ["test_a.py"]);
    assert.equal(o.ran, true);
    assert.equal(o.stable, true);
    assert.equal(o.runs, 2, "a second run changed nothing");
    assert.deepEqual(o.files, ["a.py"]);
    assert.deepEqual(o.changed, ["a.py"]);
    assert.equal(readFileSync(join(home, "log"), "utf8").trim().split("\n")[0], "a.py", "the frozen test is never passed");
    const d = { program: o.program };
    for (const k of ["ran", "reason", "runs", "stable", "files", "changed", "refused"]) d[k] = o[k];
    assert.equal(o.digest, sha256(canon(d)));
    // a hook that touches another path: reported, never settles, and never copied back
    const o2 = runF({ paths: ["a.py"] }, [], { TOUCH_OTHER: "1" });
    assert.ok(o2.changed.includes("other.txt"));
    assert.equal(o2.stable, false);
    assert.equal(o2.runs, 3);
    assert.equal(readFileSync(join(wt, "other.txt"), "utf8"), "o\n", "only the selected files come back");
    // a deleted config differs from HEAD: refused, nothing runs (review 4)
    rmSync(join(wt, ".pre-commit-config.yaml"));
    const o3 = runF({ dirty: true }, []);
    assert.equal(o3.ran, false);
    assert.deepEqual(o3.refused, [".pre-commit-config.yaml"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.0.0 second review of the build caller check

function gitRepo(prefix, files) {
  const wt = mkdtempSync(join(tmpdir(), prefix));
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  for (const [k, v] of Object.entries(files)) {
    spawnSync("mkdir", ["-p", dirname(join(wt, k))]);
    writeFileSync(join(wt, k), v);
  }
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  return wt;
}
function treeAfter(wt, files) {
  for (const [k, v] of Object.entries(files)) writeFileSync(join(wt, k), v);
  sh(wt, "git", "add", "-A");
  return sh(wt, "git", "write-tree").trim();
}

test("3.0.0 review 2: an insertion that starts with a new helper and continues inside an existing function names that function", { skip: !HAVE_PY }, () => {
  const wt = gitRepo("fleet-defs5-", { "m.py": "def outer(x):\n    a = 1\n    return a\n", "n.py": "import os\n\n\ndef f():\n    return 1\n" });
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    const tree = treeAfter(wt, {
      "m.py": "def outer(x):\n    a = 1\n    def helper():\n        return 2\n    a = helper()\n    return a\n",
      // a new helper at module level, then a module-level statement
      "n.py": "import os\n\n\ndef helper():\n    return 2\nprint(helper())\n\n\ndef f():\n    return 1\n",
    });
    const o = runDefs(wt, base, tree, []);
    assert.deepEqual(o.defs, [{ name: "outer", at: "m.py:1", end: 3 }]);
    assert.deepEqual(o.unattributed, ["n.py:3"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 2: a decorator line belongs to the definition that follows it", { skip: !HAVE_PY }, () => {
  const wt = gitRepo("fleet-defs6-", { "d.py": "import functools\n\n\n@functools.cache\ndef f():\n    return 1\n" });
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    const tree = treeAfter(wt, { "d.py": "import functools\n\n\n@functools.lru_cache(1)\ndef f():\n    return 1\n\n\n@functools.cache\ndef g():\n    return 2\n" });
    const o = runDefs(wt, base, tree, []);
    assert.deepEqual(o.defs, [{ name: "f", at: "d.py:5", end: 6 }]);
    assert.deepEqual(o.unattributed, []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 2: a definition whose name is no identifier is listed as a definition", { skip: !HAVE_PY }, () => {
  const wt = gitRepo("fleet-defs7-", { Makefile: "build-x:\n\tcc a.c\n\ntest:\n\tpytest\n" });
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    const o = runDefs(wt, base, treeAfter(wt, { Makefile: "build-x:\n\tcc -O2 a.c\n\ntest:\n\tpytest\n" }), []);
    assert.deepEqual(o.defs, [{ name: "build-x", at: "Makefile:1", end: 2 }]);
    assert.deepEqual(o.unattributed, []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 2: a caller occurrence does not waive module-level changes; only a file the plan lists does", async () => {
  // guard_verdict's caller sits in chart/render.py; a module-level edit there is not waived by it
  const s = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  s["infra:changed-defs:r1"] = defsOut([], { unattributed: ["chart/render.py:1"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "callers", out.result.reason);
  assert.match(out.result.reason, /module-level change at chart\/render\.py:1/);
  // the plan lists the file in allowed_additions.files: waived
  const t = callerPlan([GV_DEF, GV_RENDER, GV_PRESTOP]);
  t["role:scope-and-plan"].allowed_additions = { files: ["chart/render.py"], symbols: [], deps: [], settings: [] };
  t["infra:changed-defs:r1"] = defsOut([], { unattributed: ["chart/render.py:1"] });
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
});

test("3.0.0 review 2: a definition changed_symbols cannot name (no identifier) passes only in a file the plan lists", async () => {
  const s = happy();
  s["infra:changed-defs:r1"] = defsOut([{ name: "build-x", at: "Makefile:1", end: 2 }]);
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "callers", out.result.reason);
  assert.match(out.result.reason, /build-x \(Makefile:1; not an identifier: changed_symbols cannot map it, and the plan does not list Makefile\)/);
  const t = withObligations([Object.assign({}, OB_LOG, { files: ["Makefile"] })]);
  t["infra:changed-defs:r1"] = defsOut([{ name: "build-x", at: "Makefile:1", end: 2 }]);
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
});

// ---------------------------------------------------------------- 3.0.0 yaadgaar write-back (ledger 1928)

// The read-only step's answer: each task's id, number and version, read by
// the sealed id (3.1.3: no project resolution from the repo).
function yaadgaarRead(over) {
  return (p) => ({
    status: "ok",
    reason: "read",
    results: inputsOf(p).tasks.map((t) => Object.assign({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false }, over || {})),
  });
}

async function yaadgaarBuild(writeback, buildOver, read) {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, { ...YQ, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:yaadgaar-read"] = read || yaadgaarRead();
  if (writeback !== undefined) s["infra:yaadgaar-writeback"] = writeback;
  return runOne(s, Object.assign({ mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" }, buildOver || {}));
}

test("3.0.0 yaadgaar write-back: an agent step edits the task through mcp__yaadgaar__ tools, never the yadgar ledger", async () => {
  const out = await yaadgaarBuild((p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("infra:ledger-writeback"));
  const c = call(out, "infra:yaadgaar-writeback");
  assert.equal(c.opts.agentType, undefined, "default agent: fleet:judge must never write to a ledger");
  const i = inputsOf(c.prompt);
  assert.deepEqual(i.tasks, [{ key: "s0", id: YURN, number: 622, version: 3 }]);
  assert.equal(i.marker, "fleet:y622");
  assert.equal(i.section_heading, "Fleet build");
  assert.match(i.section_text, /<!-- fleet:y622 -->/);
  assert.equal(i.section_body, "## Fleet build\n\n" + i.section_text);
  assert.equal(i.section_sha256, sha256(i.section_body));
  const r = call(out, "infra:yaadgaar-read");
  assert.equal(r.opts.agentType, "fleet:judge", "the read step is read-only");
  const ri = inputsOf(r.prompt);
  // 3.1.3: args.project is passed through; the read goes by id and never resolves a project from the repo
  assert.equal(ri.project, "yadgarhq/docs");
  assert.equal(i.project, "yadgarhq/docs");
  assert.deepEqual(ri.tasks, [{ key: "s0", number: 622, id: YURN }]);
  // 3.1.3 (ledger 1979): the read goes by the sealed id; the repo never names the project
  assert.equal(ri.repo, undefined);
  assert.doesNotMatch(r.prompt, /\.yadgar\/project-id|remote get-url|walking up/);
  assert.match(r.prompt, /read_task\(id=<id>\)/);
  assert.ok(out.labels.indexOf("infra:yaadgaar-read") < out.labels.indexOf("infra:yaadgaar-writeback"));
  for (const re of [/mcp__yaadgaar__read_task/, /mcp__yaadgaar__edit_task/, /expect_version/, /VERSION_MISMATCH/, /patch/, /expect_count/, /expect_body_sha256/, /never mcp__yadgar__task_/i, /id=<id>/])
    assert.match(c.prompt, re);
  assert.equal(out.result.ledger_status, "ok");
  assert.deepEqual(out.result.write_back.ledger.map((e) => [e.ref, e.status]), [["yaadgaar #622", "written"]]);
});

test("3.0.0 yaadgaar write-back: a failed or missing result hands the section back; no project writes nothing", async () => {
  const out = await yaadgaarBuild({ status: "ok", reason: "x", results: [{ key: "s0", status: "failed", reason: "VERSION_MISMATCH twice" }] });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.ledger_status, "failed");
  assert.match(out.result.write_back.ledger[0].reason, /VERSION_MISMATCH twice/);
  assert.match(out.result.write_back.ledger[0].section_text, /fleet:y622/);
  const dead = await yaadgaarBuild(null);
  assert.equal(dead.result.ledger_status, "failed");
  assert.match(dead.result.write_back.ledger[0].section_text, /fleet:y622/);
  const skipped = await yaadgaarBuild({ status: "ok", reason: "x", results: [{ key: "s0", status: "skipped", reason: "marker present" }] });
  assert.equal(skipped.result.ledger_status, "ok");
});

test("3.0.0 write-back: a Codeberg origin gets a Codeberg plan link", async () => {
  const s = happy();
  s.workspace = { ...s.workspace, remote_host: "codeberg.org" };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const i = inputsOf(call(out, "infra:ledger-writeback").prompt);
  assert.match(i.section_text, /\(https:\/\/codeberg\.org\/o\/r\/src\/branch\/fleet\/l42-add-thing\/docs\/plans\/x\.md\)/);
  const g = await run(happy(), ARGS);
  assert.match(inputsOf(call(g, "infra:ledger-writeback").prompt).section_text, /\(https:\/\/github\.com\/o\/r\/blob\/fleet\/l42-add-thing\/docs\/plans\/x\.md\)/);
  assert.match(call(g, "workspace").prompt, /remote_host/);
});

// ---------------------------------------------------------------- 3.0.0 review 3 (PR #36 FIX-FIRST)

// One base -> new change of one file through the changed-defs program.
function defsOf(path, before, after, excl) {
  const wt = gitRepo("fleet-r3-", { [path]: before });
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    return runDefs(wt, base, treeAfter(wt, { [path]: after }), excl || []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}
const PY_BASE = "from x import check\n\n\ndef validate(v):\n    return check(v)\n";
const PY_VALIDATE = [{ name: "validate", at: "m.py:4", end: 5 }];

test("3.0.0 review 3 HIGH: a definition nested in an existing unmapped function names that function (Python PoCs)", { skip: !HAVE_PY }, () => {
  for (const [what, after] of [
    ["nested def check shadowing the import", "from x import check\n\n\ndef validate(v):\n    def check(v):\n        return True\n    return check(v)\n"],
    ["@sabotage on a nested def", "from x import check\n\n\ndef validate(v):\n    @sabotage\n    def inner():\n        return 1\n    return check(v)\n"],
    ["class _K: z = sabotage()", "from x import check\n\n\ndef validate(v):\n    class _K: z = sabotage()\n    return check(v)\n"],
    ["def _h(a=sabotage())", "from x import check\n\n\ndef validate(v):\n    def _h(a=sabotage()): pass\n    return check(v)\n"],
  ]) {
    const o = defsOf("m.py", PY_BASE, after);
    assert.deepEqual(o.defs, PY_VALIDATE, what);
  }
});

test("3.0.0 review 3 HIGH: JS and Rust one-line definitions inside an existing function name that function", { skip: !HAVE_PY }, () => {
  const JS = "export function run(x) {\n  return x;\n}\n";
  const RUN = [{ name: "run", at: "a.js:1", end: 2 }];
  assert.deepEqual(defsOf("a.js", JS, "export function run(x) {\n  const noop = () => 0, z = sabotage();\n  return x;\n}\n").defs, RUN);
  assert.deepEqual(defsOf("a.js", JS, "export function run(x) {\n  const noop = () => 0;\n      sabotage();\n  return x;\n}\n").defs, RUN);
  const RS = "fn run() -> i32 {\n    1\n}\n";
  assert.deepEqual(defsOf("a.rs", RS, "fn run() -> i32 {\n    fn _h() {} sabotage();\n    1\n}\n").defs, [{ name: "run", at: "a.rs:1", end: 2 }]);
});

test("3.0.0 review 3 HIGH: a new method in an existing class does not record the class", { skip: !HAVE_PY }, () => {
  // (a decorated new member names the class since review 4; see that test)
  const o = defsOf("k.py", "class A:\n    def x(self):\n        return 1\n", "class A:\n    def x(self):\n        return 1\n\n    def y(self):\n        return 2\n");
  assert.deepEqual(o.defs, []);
  assert.deepEqual(o.unattributed, []);
  const t = defsOf("k.ts", "export class C {\n  a() {\n    return 1;\n  }\n}\n", "export class C {\n  a() {\n    return 1;\n  }\n\n  b() {\n    return 2;\n  }\n}\n");
  assert.deepEqual(t.defs, []);
  assert.deepEqual(t.unattributed, []);
});

test("3.0.0 review 3 MED-HIGH: multi-line signatures (black-style Python, Go, TS method) attribute a body change to the definition", { skip: !HAVE_PY }, () => {
  const o = defsOf("v.py", "import os\n\n\ndef validate(\n    x,\n) -> bool:\n    return check(x)\n", "import os\nimport sys\n\n\ndef validate(\n    x,\n) -> bool:\n    return True\n");
  assert.deepEqual(o.defs, [{ name: "validate", at: "v.py:4", end: 7 }]);
  assert.deepEqual(o.unattributed, ["v.py:1"]);
  const g = defsOf("f.go", "package m\n\nfunc F(\n\ta int,\n) int {\n\treturn a\n}\n", "package m\n\nfunc F(\n\ta int,\n) int {\n\treturn a + 1\n}\n");
  assert.deepEqual(g.defs, [{ name: "F", at: "f.go:3", end: 6 }]);
  assert.deepEqual(g.unattributed, []);
  const t = defsOf("c.ts", "export class C {\n  run(\n    a: number,\n  ): number {\n    return a;\n  }\n}\n", "export class C {\n  run(\n    a: number,\n  ): number {\n    return a + 1;\n  }\n}\n");
  assert.deepEqual(t.defs, [{ name: "run", at: "c.ts:2", end: 5 }]);
});

test("3.0.0 review 3 MED-HIGH: a black-style body change in a listed file is still refused", async () => {
  const s = happy();
  s["role:scope-and-plan"].allowed_additions = { files: ["v.py"], symbols: [], deps: [], settings: [] };
  s["infra:changed-defs:r1"] = defsOut([{ name: "validate", at: "v.py:4", end: 7 }], { unattributed: ["v.py:1"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "callers", out.result.reason);
  assert.match(out.result.reason, /validate \(v\.py:4\)/);
});

test("3.0.0 review 3 MED: appended brace-language functions, X.y = function, and renames give no needless stop", { skip: !HAVE_PY }, () => {
  const a = defsOf("a.js", "export function a() {\n  return 1;\n}\n", "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n");
  assert.deepEqual([a.defs, a.unattributed], [[], []]);
  const g = defsOf("a.go", "package m\n\nfunc A() int {\n\treturn 1\n}\n", "package m\n\nfunc A() int {\n\treturn 1\n}\n\nfunc B() int {\n\treturn 2\n}\n");
  assert.deepEqual([g.defs, g.unattributed], [[], []]);
  const x = defsOf("x.js", "var X = {};\nX.y = function (a) {\n  return a;\n};\nX.z = (a) => {\n  return a;\n};\n", "var X = {};\nX.y = function (a) {\n  return a + 1;\n};\nX.z = (a) => {\n  return a + 2;\n};\n");
  assert.deepEqual(x.defs, [{ name: "y", at: "x.js:2", end: 3 }, { name: "z", at: "x.js:5", end: 6 }]);
  assert.deepEqual(x.unattributed, []);
  // a renamed file: only the real change counts, at the base path
  const wt = gitRepo("fleet-r3-mv-", { "chart/a.py": "import os\n\n\ndef f():\n    return 1\n\n\ndef g():\n    return 2\n" });
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    sh(wt, "git", "mv", "chart/a.py", "chart/b.py");
    const o = runDefs(wt, base, treeAfter(wt, { "chart/b.py": "import os\n\n\ndef f():\n    return 1\n\n\ndef g():\n    return 3\n" }), []);
    assert.deepEqual(o.defs, [{ name: "g", at: "chart/a.py:8", end: 9 }]);
    assert.deepEqual(o.unattributed, []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 3 mutants: a removed guard line, a decorator-only change, a same-name redefinition, a NUL byte", { skip: !HAVE_PY }, () => {
  // py_cd_removed_attr: a pure deletion inside an unmapped function
  const r = defsOf("g.py", "def guard(v):\n    if v is None:\n        return False\n    return True\n", "def guard(v):\n    return True\n");
  assert.deepEqual(r.defs, [{ name: "guard", at: "g.py:1", end: 4 }]);
  // py_cd_pending_tail: only a decorator added to an existing function
  const d = defsOf("d.py", "import functools\n\n\ndef f():\n    return 1\n", "import functools\n\n\n@functools.cache\ndef f():\n    return 1\n");
  assert.deepEqual(d.defs, [{ name: "f", at: "d.py:4", end: 5 }]);
  // py_cd_readded: a same-name redefinition later in the file shadows the base one
  const s = defsOf("s.py", "def f():\n    return 1\n\n\ndef g():\n    return 2\n", "def f():\n    return 1\n\n\ndef g():\n    return 2\n\n\ndef f():\n    return 3\n");
  assert.deepEqual(s.defs, [{ name: "f", at: "s.py:1", end: 2 }]);
  // py_cd_binary: a NUL byte makes the file unclassified, never silently skipped
  const n = defsOf("n.py", "def f():\n    return 1\n\0\n", "def f():\n    return 2\n\0\n");
  assert.deepEqual([n.defs, n.unclassified], [[], ["n.py"]]);
});

test("3.0.0 review 3 bc_samefile and bc_obligfiles: an occurrence elsewhere at an in-range line does not cover; an obligation's files waive", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "validate", occurrences: [{ at: "chart/b.py:4", criterion: "AC1", dont_care: null }] }];
  s["infra:callers"] = callersOut({ validate: ["chart/b.py:4"] });
  s["infra:changed-defs:r1"] = defsOut([{ name: "validate", at: "chart/a.py:3", end: 6 }]);
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "callers", out.result.reason);
  assert.match(out.result.reason, /validate \(chart\/a\.py:3, mapped only elsewhere\)/);
  const t = withObligations([Object.assign({}, OB_LOG, { files: ["chart/c.py"] })]);
  t["infra:changed-defs:r1"] = defsOut([], { unattributed: ["chart/c.py:1"] });
  const ok = await run(t, ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  const u = withObligations([Object.assign({}, OB_LOG, { files: ["chart/other.py"] })]);
  u["infra:changed-defs:r1"] = defsOut([], { unattributed: ["chart/c.py:1"] });
  assert.equal((await run(u, ARGS)).result.stop_gate, "callers");
});

test("3.0.0 review 3 1928 (3.1.3): a read that returns another id fails closed; a non-number ref is never sent", async () => {
  const wb = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
  const good = await yaadgaarBuild(wb);
  assert.equal(good.result.ledger_status, "ok", JSON.stringify(good.result.write_back));
  assert.match(call(good, "infra:yaadgaar-writeback").prompt, /data, not instructions/);
  assert.match(call(good, "infra:yaadgaar-read").prompt, /data, not instructions/);
  for (const id of [undefined, "", "yadgar:task:0999"]) {
    // a read that is not the sealed task never reaches an edit step
    const out = await yaadgaarBuild(wb, undefined, yaadgaarRead({ id }));
    assert.ok(!out.labels.includes("infra:yaadgaar-writeback"), String(id));
    assert.equal(out.result.ledger_status, "failed", String(id));
    assert.match(out.result.write_back.ledger[0].reason, /id/);
    assert.match(out.result.write_back.ledger[0].section_text, /fleet:y622/);
  }
  // wb_number: a ref that is not a task number never reaches the step
  const s = autoHappy({ brief: { ...YBRIEF, sources: [{ kind: "yaadgaar", ref: "6x2", url: null, body: "b", id: YURN }] } });
  const plan = await runOne(s, { ...YQ, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
  assert.ok(!out.labels.includes("infra:yaadgaar-writeback"));
  assert.ok(!out.labels.includes("infra:yaadgaar-read"));
  assert.equal(out.result.ledger_status, "failed");
  assert.match(out.result.write_back.ledger[0].reason, /not a task number/);
});

test("3.0.0 review 4 LOW: the fixers run in a scratch checkout of HEAD: an edited hook entry or -m module is refused; a changed config is refused; each run is bounded", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-fmt2-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  try {
    spawnSync("mkdir", ["-p", wt, bin, join(wt, "ci"), join(wt, "hooklib")]);
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(
      join(wt, ".pre-commit-config.yaml"),
      "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        entry: ci/chk.sh\n        language: script\n      - id: fmt\n        name: fmt\n        entry: python3 -m hooklib.fmt\n        language: system\n",
    );
    writeFileSync(join(wt, "ci", "chk.sh"), "#!/bin/sh\necho head >> \"$LOG\"\n", { mode: 0o755 });
    writeFileSync(join(wt, "hooklib", "__init__.py"), "");
    writeFileSync(join(wt, "hooklib", "fmt.py"), "import os\nopen(os.environ['LOG'], 'a').write('head-py\\n')\n");
    writeFileSync(join(wt, "a.py"), "x=1\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    // the fake pre-commit runs the local hook entry from its working dir
    writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\n./ci/chk.sh\npython3 -m hooklib.fmt\n[ -n \"$SLEEP\" ] && sleep \"$SLEEP\"\nexit 0\n", { mode: 0o755 });
    const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
    const env = (extra) => Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH, LOG: join(home, "log") }, extra || {});
    const runF = (timeout, extra) => {
      const r = spawnSync("python3", ["-I", "-", wt, JSON.stringify({ dirty: true }), "[]", join(home, "scratch"), String(timeout)], { input: prog, encoding: "utf8", env: env(extra) });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    // the coder edits a hook entry and the module a `-m` hook runs (real pre-commit 4.6.2 ran both)
    writeFileSync(join(wt, "a.py"), "x=2\n");
    writeFileSync(join(wt, "hooklib", "fmt.py"), "import os\nopen(os.environ['LOG'], 'a').write('edited-py\\n')\n");
    writeFileSync(join(wt, "ci", "chk.sh"), "#!/bin/sh\necho edited-entry >> \"$LOG\"\n", { mode: 0o755 });
    // review 5: an edited hook entry or -m module is refused before any hook runs
    const o = runF(180);
    assert.equal(o.ran, false, o.reason);
    assert.deepEqual(o.refused, ["ci/chk.sh", "hooklib/fmt.py"]);
    assert.ok(!existsSync(join(home, "log")), "no hook ran");
    assert.equal(readFileSync(join(wt, "ci", "chk.sh"), "utf8"), "#!/bin/sh\necho edited-entry >> \"$LOG\"\n", "the coder's files stay as they were");
    // with the hook surface at HEAD, HEAD's hook code runs in the scratch checkout
    sh(wt, "git", "checkout", "--", "ci/chk.sh", "hooklib/fmt.py");
    const h = runF(180);
    assert.equal(h.ran, true, h.reason);
    assert.deepEqual(readFileSync(join(home, "log"), "utf8").trim().split("\n"), ["head", "head-py"]);
    assert.deepEqual(h.files, ["a.py"]);
    assert.equal(spawnSync("ls", [join(home, "scratch")]).stdout.toString().trim(), "", "the scratch checkout is removed");
    assert.equal(sh(wt, "git", "worktree", "list").trim().split("\n").length, 1, "no scratch worktree left registered");
    // n_ff_timeout: a run over its time budget ends the loop, unsettled
    const t = runF(1, { SLEEP: "3" });
    assert.equal(t.ran, true);
    assert.equal(t.runs, 1);
    assert.equal(t.stable, false);
    assert.match(prog, /timeout=tmo/);
    // a changed hook config is refused; nothing runs
    writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos: []\n");
    rmSync(join(home, "log"), { force: true });
    const c = runF(180);
    assert.deepEqual(c.refused, [".pre-commit-config.yaml"]);
    assert.equal(c.ran, false);
    assert.ok(!existsSync(join(home, "log")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.0.0 review 3 LOW: a refused fixer run stops the build (hook surface changed)", async () => {
  const s = happy();
  s["infra:format-code:r1"] = formatOut({ ran: false, reason: "refused", runs: 0, files: ["src/x.py"], refused: [".pre-commit-config.yaml"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "hash");
  assert.match(out.result.reason, /hook config, a hook entry or a symlinked path differs from HEAD: \.pre-commit-config\.yaml/);
});

test("3.0.0 review 3 LOW: branch-scan prints task_id and plan_path only for an ok ref", { skip: !HAVE_PY }, () => {
  const prog = extractPy("BRANCH_SCAN_PY_BEGIN", "BRANCH_SCAN_PY_END", "BRANCH_SCAN_PY");
  assert.match(prog, /if e\['ref_ok'\]/);
  const home = mkdtempSync(join(tmpdir(), "fleet-bscan2-"));
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    const { wt } = scanRepo(home, env);
    const writeCmd = planRefWriteCmd;
    const bad = JSON.parse(priorRef("docs/plans/x.md"));
    bad.tldr = "changed after the seal";
    const w = spawnSync("bash", ["-c", writeCmd(wt, "l42", JSON.stringify(bad))], { encoding: "utf8", env });
    assert.equal(w.status, 0, w.stderr);
    const kinds = JSON.stringify(["ledger", "yaadgaar", "jira", "github", "codeberg", "plan", "text"]);
    const r = spawnSync("python3", ["-I", "-", wt, "master", "l42", kinds], { input: prog, encoding: "utf8", env });
    const e = JSON.parse(r.stdout).refs[0];
    assert.equal(e.ref_ok, false);
    assert.equal(e.task_id, null);
    assert.equal(e.plan_path, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.0.0 review 3 LOW: no dead checks left (isPlanCommit self-compare, PLAN_REF_PY leftovers)", () => {
  assert.doesNotMatch(SOURCE, /planRefMetaProblem\(e, c\.sha, e\.sha256\)/);
  // 4.0.1: the program lives in scripts/plan_ref.py only
  assert.doesNotMatch(extractPy("PLAN_REF_PY_BEGIN", "PLAN_REF_PY_END", "PLAN_REF_PY"), /if True:/);
});

// ---------------------------------------------------------------- 3.0.0 review 4 (PR #36 delta)

test("3.0.0 review 4 MED: an Allman-style C or Java guard edit names its function, and a listed file does not waive it", { skip: !HAVE_PY }, () => {
  const c = defsOf("guard.c", "int check(int x)\n{\n    if (x < 0)\n        return 0;\n    return 1;\n}\n", "int check(int x)\n{\n    if (x < -1)\n        return 0;\n    return 1;\n}\n");
  assert.deepEqual(c.defs, [{ name: "check", at: "guard.c:1", end: 1 }]);
  assert.deepEqual(c.unattributed, []);
  const j = defsOf(
    "G.java",
    "public class G\n{\n    public boolean allow(int x)\n    {\n        if (x < 0)\n            return false;\n        return true;\n    }\n}\n",
    "public class G\n{\n    public boolean allow(int x)\n    {\n        return true;\n    }\n}\n",
  );
  assert.deepEqual(j.defs, [{ name: "allow", at: "G.java:3", end: 3 }]);
  assert.deepEqual(j.unattributed, []);
});

test("3.0.0 review 4 MED: an Allman guard edit in a listed file still stops the run", async () => {
  const s = happy();
  s["role:scope-and-plan"].allowed_additions = { files: ["guard.c"], symbols: [], deps: [], settings: [] };
  s["infra:changed-defs:r1"] = defsOut([{ name: "check", at: "guard.c:1", end: 1 }]);
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "callers", out.result.reason);
});

test("3.0.0 review 4 LOW: a rename onto an excluded path still checks the old file as a deletion", { skip: !HAVE_PY }, () => {
  const wt = gitRepo("fleet-r4-mv-", { "chart/guard.py": "def guard(v):\n    return v\n" });
  try {
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    spawnSync("mkdir", ["-p", join(wt, "tests")]);
    sh(wt, "git", "mv", "chart/guard.py", "tests/test_a.py");
    const o = runDefs(wt, base, treeAfter(wt, { "tests/test_a.py": "def guard(v):\n    return v\n" }), ["tests/test_a.py"]);
    assert.deepEqual(o.defs, [{ name: "guard", at: "chart/guard.py:1", end: 2 }]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 4 LOW: a decorator on a new member, and a new nested class with side effects, name the enclosing class", { skip: !HAVE_PY }, () => {
  const BASE = "class A:\n    def x(self):\n        return 1\n";
  const d = defsOf("k.py", BASE, "class A:\n    def x(self):\n        return 1\n\n    @sabotage\n    def y(self):\n        return 2\n");
  assert.deepEqual(d.defs, [{ name: "A", at: "k.py:1", end: 3 }]);
  const n = defsOf("k.py", BASE, "class A:\n    def x(self):\n        return 1\n\n    class _K: z = sabotage()\n");
  assert.deepEqual(n.defs, [{ name: "A", at: "k.py:1", end: 3 }]);
  // a plain new method still records nothing
  const p = defsOf("k.py", BASE, "class A:\n    def x(self):\n        return 1\n\n    def y(self):\n        return 2\n");
  assert.deepEqual(p.defs, []);
});

test("3.0.0 review 4 n_opens_block: a one-line column-0 definition has no body; an over-indented statement after it is module level", { skip: !HAVE_PY }, () => {
  const o = defsOf("a.js", "export function a() {\n  return 1;\n}\n", "export function a() {\n  return 1;\n}\nconst noop = () => 0;\n    sabotage();\n");
  assert.deepEqual(o.defs, []);
  assert.deepEqual(o.unattributed, ["a.js:3"]);
  // a block-opening column-0 definition's body is its own
  const b = defsOf("a.js", "export function a() {\n  return 1;\n}\n", "export function a() {\n  return 1;\n}\nfunction b() {\n    sabotage();\n}\n");
  assert.deepEqual([b.defs, b.unattributed], [[], []]);
});

test("3.0.0 review 4 n_bs_refok_regex: a sealed ref whose task_id or plan_path fails the shape check is not ok", { skip: !HAVE_PY }, () => {
  const prog = extractPy("BRANCH_SCAN_PY_BEGIN", "BRANCH_SCAN_PY_END", "BRANCH_SCAN_PY");
  const kinds = JSON.stringify(["ledger", "yaadgaar", "jira", "github", "codeberg", "plan", "text"]);
  const writeCmd = planRefWriteCmd;
  for (const over of [{ plan_path: "docs/plans/x y.md" }, { plan_path: "docs/plans/x;.md" }]) {
    const home = mkdtempSync(join(tmpdir(), "fleet-bscan3-"));
    try {
      const cfg = join(home, "gitconfig");
      writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
      const env = gitEnv(home, cfg);
      const { wt } = scanRepo(home, env);
      const msg = priorRef("docs/plans/x.md", over).trimEnd();
      assert.equal(jsPlanRefProblem()(JSON.parse(msg)), null, "sealed and well formed for planRefProblem");
      const w = spawnSync("bash", ["-c", writeCmd(wt, "l42", msg)], { encoding: "utf8", env });
      assert.equal(w.status, 0, w.stderr);
      const r = spawnSync("python3", ["-I", "-", wt, "master", "l42", kinds], { input: prog, encoding: "utf8", env });
      const e = JSON.parse(r.stdout).refs[0];
      assert.equal(e.ref_ok, false, JSON.stringify(over));
      assert.equal(e.plan_path, null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("3.0.0 review 4 n_planref_argc: the plan-ref reader refuses an extra argument", { skip: !HAVE_PY }, () => {
  const reader = extractPy("PLAN_REF_PY_BEGIN", "PLAN_REF_PY_END", "PLAN_REF_PY");
  const wt = gitRepo("fleet-r4-argc-", { "a.py": "a\n" });
  try {
    for (const args of [[wt, "l42", "meta", "extra"], [wt, "l42"]]) {
      const r = spawnSync("python3", ["-I", "-"].concat(args), { input: reader, encoding: "utf8" });
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, /usage/);
    }
    const ok = spawnSync("python3", ["-I", "-", wt, "l42", "meta"], { input: reader, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 4 1928: a task that already carries the marker is skipped without an edit step", async () => {
  const out = await yaadgaarBuild(() => ({ status: "ok", reason: "x", results: [] }), undefined, yaadgaarRead({ has_marker: true }));
  assert.ok(!out.labels.includes("infra:yaadgaar-writeback"));
  assert.equal(out.result.ledger_status, "ok");
  assert.equal(out.result.write_back.ledger[0].status, "skipped");
  const bad = await yaadgaarBuild(() => ({ status: "ok", reason: "x", results: [] }), undefined, yaadgaarRead({ status: "failed", reason: "not found" }));
  assert.ok(!bad.labels.includes("infra:yaadgaar-writeback"));
  assert.equal(bad.result.ledger_status, "failed");
  assert.match(bad.result.write_back.ledger[0].reason, /not found/);
});

// ---------------------------------------------------------------- 3.0.0 review 5 (PR #36 final batch)

// A repo with a pre-commit config and a fake pre-commit that appends "# fmt"
// to every file it is given (once), logging its args. Returns helpers.
function fixerRepo(prefix, cfg, files) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  spawnSync("mkdir", ["-p", wt, bin]);
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg);
  for (const [k, v] of Object.entries(files)) {
    spawnSync("mkdir", ["-p", dirname(join(wt, k))]);
    writeFileSync(join(wt, k), v);
  }
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  writeFileSync(
    join(bin, "pre-commit"),
    "#!/bin/sh\nshift 2\necho \"$@\" >> \"$LOG\"\nfor f in \"$@\"; do grep -q fmt \"$f\" || echo '# fmt' >> \"$f\"; done\n[ -n \"$SLEEP\" ] && sleep \"$SLEEP\"\nexit 0\n",
    { mode: 0o755 },
  );
  const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
  const runF = (extra, timeout, noYaml) => {
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH, LOG: join(home, "log") }, extra || {});
    const argv = ["-I", "-", wt, JSON.stringify({ dirty: true }), "[]", join(home, "scratch"), String(timeout || 180)].concat(noYaml ? ["no-yaml"] : []);
    const r = spawnSync("python3", argv, { input: prog, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { home, wt, runF, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("3.0.0 review 5 HIGH: a files: regex naming a non-hook file does not take it out of formatting; an edited -m module is refused", { skip: !HAVE_PY }, () => {
  const cfg =
    "repos:\n  - repo: local\n    hooks:\n      - id: fmt\n        name: fmt\n        entry: python3 -m tools.fmt\n        language: system\n        files: ^common/util.py$\n        exclude: ^docs/\n";
  const r = fixerRepo("fleet-r5-surface-", cfg, { "common/util.py": "x=1\n", "common/other.py": "y=1\n", "tools/__init__.py": "", "tools/fmt.py": "print(1)\n", "docs/a.md": "a\n" });
  try {
    writeFileSync(join(r.wt, "common/util.py"), "x=2\n");
    writeFileSync(join(r.wt, "common/other.py"), "y=2\n");
    const o = r.runF();
    assert.equal(o.ran, true, o.reason);
    assert.deepEqual(o.refused, []);
    assert.deepEqual(o.files, ["common/other.py", "common/util.py"], "a path named only in files: is formatted");
    assert.deepEqual(o.changed, ["common/other.py", "common/util.py"]);
    assert.equal(readFileSync(join(r.wt, "common/util.py"), "utf8"), "x=2\n# fmt\n", "the fixed bytes come back");
    // the -m module (and its package files) are the hook surface: an edit is refused
    writeFileSync(join(r.wt, "tools/fmt.py"), "import os\nos.system('evil')\n");
    const m = r.runF();
    assert.equal(m.ran, false);
    assert.deepEqual(m.refused, ["tools/fmt.py"]);
    sh(r.wt, "git", "checkout", "--", "tools/fmt.py");
    writeFileSync(join(r.wt, "tools/__init__.py"), "import os\n");
    assert.deepEqual(r.runF().refused, ["tools/__init__.py"]);
  } finally {
    r.done();
  }
});

test("3.0.0 review 5 MED: a selected path under a symlinked directory is refused and nothing is written outside", { skip: !HAVE_PY }, () => {
  const r = fixerRepo("fleet-r5-link-", "repos: []\n", { "a.py": "x=1\n" });
  const outside = mkdtempSync(join(tmpdir(), "fleet-r5-out-"));
  try {
    writeFileSync(join(outside, "t.py"), "o=1\n");
    // HEAD has a symlinked dir pointing outside, with a file under it the coder changes
    spawnSync("ln", ["-s", outside, join(r.wt, "linked")]);
    sh(r.wt, "git", "add", "-A");
    sh(r.wt, "git", "commit", "-qm", "link");
    writeFileSync(join(outside, "t.py"), "o=2\n");
    writeFileSync(join(r.wt, "a.py"), "x=2\n");
    // a symlinked file at HEAD too
    spawnSync("ln", ["-s", "a.py", join(r.wt, "b.py")]);
    sh(r.wt, "git", "add", "b.py");
    sh(r.wt, "git", "commit", "-qm", "b");
    // the dirty selection never reaches through a symlink
    const sel = r.runF();
    assert.deepEqual(sel.files, ["a.py"], JSON.stringify(sel));
    assert.equal(readFileSync(join(outside, "t.py"), "utf8"), "o=2\n", "nothing written outside");
    // the explicit refusal: a selected path whose parent is a symlinked dir
    const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
    const env = Object.assign({}, process.env, { LOG: join(r.home, "log") });
    const x = spawnSync("python3", ["-I", "-", r.wt, JSON.stringify({ paths: ["linked/t.py", "a.py"] }), "[]", join(r.home, "scratch"), "180"], { input: prog, encoding: "utf8", env });
    assert.equal(x.status, 0, x.stderr);
    const ox = JSON.parse(x.stdout);
    assert.ok(ox.refused.includes("linked/t.py"), JSON.stringify(ox));
    assert.equal(ox.ran, false);
    assert.equal(readFileSync(join(outside, "t.py"), "utf8"), "o=2\n");
    const y = spawnSync("python3", ["-I", "-", r.wt, JSON.stringify({ paths: ["b.py"] }), "[]", join(r.home, "scratch"), "180"], { input: prog, encoding: "utf8", env });
    assert.ok(JSON.parse(y.stdout).refused.includes("b.py"));
  } finally {
    r.done();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("3.0.0 review 5 LOW: a leftover scratch worktree is cleaned; the scratch add runs no hook; a timed-out run still reports its change", { skip: !HAVE_PY }, () => {
  const r = fixerRepo("fleet-r5-left-", "repos: []\n", { "a.py": "x=1\n" });
  try {
    // a leftover from a killed run, still registered
    spawnSync("mkdir", ["-p", join(r.home, "scratch")]);
    sh(r.wt, "git", "worktree", "add", "--detach", join(r.home, "scratch", "fmt-old"), "HEAD");
    assert.equal(sh(r.wt, "git", "worktree", "list").trim().split("\n").length, 2);
    // f_hooks_off: a post-checkout hook must not run for the scratch checkout
    const hook = join(r.wt, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\ntouch " + JSON.stringify(join(r.home, "HOOK_RAN")) + "\n", { mode: 0o755 });
    writeFileSync(join(r.wt, "a.py"), "x=2\n");
    const o = r.runF();
    assert.equal(o.ran, true, o.reason);
    assert.ok(!existsSync(join(r.home, "HOOK_RAN")), "no hook ran on the scratch worktree add");
    assert.equal(sh(r.wt, "git", "worktree", "list").trim().split("\n").length, 1, "the leftover is gone");
    assert.ok(!existsSync(join(r.home, "scratch", "fmt-old")));
    // f_timeout_prev: the hook rewrote the file, then ran over budget
    sh(r.wt, "git", "checkout", "--", "a.py");
    writeFileSync(join(r.wt, "a.py"), "x=3\n");
    const t = r.runF({ SLEEP: "3" }, 1);
    assert.equal(t.stable, false);
    assert.deepEqual(t.changed, ["a.py"], "the change made before the timeout is reported");
  } finally {
    r.done();
  }
});

test("3.0.0 review 5 MED (3.1.3): the yaadgaar id must be the sealed task's id and number; version is an integer", async () => {
  for (const [what, over, re] of [
    ["another number", { number: 623 }, /number 623, not 622/],
    ["another id", { id: "yadgar:task:0999" }, /yadgar:task:0999.*not the sealed yadgar:task:0192/],
    ["another project", { project: "yadgarhq/other" }, /project "yadgarhq\/other", not args\.project yadgarhq\/docs/],
    ["no number", { number: undefined }, /number/],
    ["version not an integer", { version: "3" }, /no id\/version/],
    ["version a float", { version: 3.5 }, /no id\/version/],
  ]) {
    const out = await yaadgaarBuild(() => ({ status: "ok", reason: "x", results: [] }), undefined, yaadgaarRead(over));
    assert.ok(!out.labels.includes("infra:yaadgaar-writeback"), what);
    assert.equal(out.result.ledger_status, "failed", what);
    assert.match(out.result.write_back.ledger[0].reason, re, what);
  }
  const ok = await yaadgaarBuild((p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) }));
  const w = call(ok, "infra:yaadgaar-writeback").prompt;
  assert.match(w, /id.*number.*fail/i);
  assert.match(w, /read_task\(id=<id>\)/);
});

test("3.0.0 review 5 LOW: fleet:judge cannot call the yaadgaar write tools", () => {
  const judge = readFileSync(join(HERE, "..", "agents", "judge.md"), "utf8");
  const m = /^disallowedTools: (.*)$/m.exec(judge);
  assert.ok(m, "disallowedTools line");
  for (const tool of ["Write", "Edit", "NotebookEdit", "mcp__yaadgaar__edit_task", "mcp__yaadgaar__create_task", "mcp__yaadgaar__transition_task"])
    assert.ok(m[1].split(/,\s*/).includes(tool), tool);
});

// ---------------------------------------------------------------- 3.0.0 review 6: block and folded scalars in the hook config

const HAVE_YAML = spawnSync("python3", ["-I", "-c", "import yaml"]).status === 0;
const FOLDED_CFG =
  "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        entry: >-\n          ci/chk.sh\n        language: script\n      - id: lit\n        name: lit\n        entry: python3\n        args:\n          - |\n            tools/gen.py\n        language: system\n";
// (3.1.0: args must be a list of strings, as pre-commit's own schema says; a
// literal block is one item of that list)

test("3.0.0 review 6: a folded entry or literal args naming an edited hook file is refused (PyYAML parses the config)", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const r = fixerRepo("fleet-r6-yaml-", FOLDED_CFG, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "tools/gen.py": "print(1)\n", "a.py": "x=1\n" });
  try {
    writeFileSync(join(r.wt, "a.py"), "x=2\n");
    writeFileSync(join(r.wt, "ci/chk.sh"), "#!/bin/sh\nrm -rf /\n");
    const o = r.runF();
    assert.equal(o.ran, false);
    assert.deepEqual(o.refused, ["ci/chk.sh"]);
    sh(r.wt, "git", "checkout", "--", "ci/chk.sh");
    writeFileSync(join(r.wt, "tools/gen.py"), "print(2)\n");
    assert.deepEqual(r.runF().refused, ["tools/gen.py"]);
    sh(r.wt, "git", "checkout", "--", "tools/gen.py");
    const ok = r.runF();
    assert.equal(ok.ran, true, ok.reason);
    assert.deepEqual(ok.files, ["a.py"]);
  } finally {
    r.done();
  }
});

test("3.0.0 review 7: with no Python that has PyYAML the step is refused, plain or folded; no line parser", { skip: !HAVE_PY }, () => {
  const plain = "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        entry: ci/chk.sh\n        language: script\n";
  for (const [what, cfg] of [["folded", FOLDED_CFG], ["plain", plain]]) {
    const r = fixerRepo("fleet-r7-noyaml-", cfg, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "tools/gen.py": "print(1)\n", "a.py": "x=1\n" });
    try {
      writeFileSync(join(r.wt, "a.py"), "x=2\n");
      const o = r.runF(null, 180, true);
      assert.equal(o.ran, false, what);
      assert.deepEqual(o.refused, [".pre-commit-config.yaml"], what);
      assert.match(o.reason, /no Python with PyYAML found/, what);
      assert.ok(!existsSync(join(r.home, "log")), what + ": no hook ran");
    } finally {
      r.done();
    }
  }
  const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
  assert.doesNotMatch(prog, /entry\|args\)\\s\*:/, "the line parser is gone");
});

test("3.0.0 review 7: the config is read by pre-commit's own interpreter, through a wrapper's exec target", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const r = fixerRepo("fleet-r7-interp-", FOLDED_CFG, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "tools/gen.py": "print(1)\n", "a.py": "x=1\n" });
  try {
    // a nix-style wrapper: bin/pre-commit execs libexec/.pre-commit-wrapped, whose
    // shebang names pre-commit's python (a logging shim around python3)
    const libexec = join(r.home, "libexec");
    spawnSync("mkdir", ["-p", libexec]);
    const shim = join(libexec, "pc-python");
    const py = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(shim, "#!/bin/sh\necho used >> " + JSON.stringify(join(r.home, "pylog")) + "\nexec " + JSON.stringify(py) + " \"$@\"\n", { mode: 0o755 });
    const wrapped = join(libexec, ".pre-commit-wrapped");
    writeFileSync(wrapped, "#!" + shim + "\nimport os, sys\nfiles = sys.argv[3:]\nopen(os.environ['LOG'], 'a').write(' '.join(files) + '\\n')\nfor f in files:\n    t = open(f).read()\n    if 'fmt' not in t:\n        open(f, 'a').write('# fmt\\n')\n", { mode: 0o755 });
    // bash, as nix wrappers are: dash (the CI /bin/sh) has no exec -a
    writeFileSync(join(r.home, "bin", "pre-commit"), "#!/usr/bin/env bash\nexec -a \"$0\" " + JSON.stringify(wrapped) + " \"$@\"\n", { mode: 0o755 });
    writeFileSync(join(r.wt, "a.py"), "x=2\n");
    writeFileSync(join(r.wt, "ci/chk.sh"), "#!/bin/sh\nrm -rf /\n");
    const o = r.runF();
    assert.deepEqual(o.refused, ["ci/chk.sh"], o.reason);
    assert.ok(existsSync(join(r.home, "pylog")), "pre-commit's interpreter parsed the config");
    sh(r.wt, "git", "checkout", "--", "ci/chk.sh");
    const ok = r.runF();
    assert.equal(ok.ran, true, ok.reason);
    assert.deepEqual(ok.files, ["a.py"]);
    assert.equal(readFileSync(join(r.wt, "a.py"), "utf8"), "x=2\n# fmt\n");
  } finally {
    r.done();
  }
});

test("3.0.0 review 7: a flow-map hook {id: x, entry: ci/chk.sh} is in the surface; an edited entry is refused", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const cfg = "repos:\n  - {repo: local, hooks: [{id: x, name: x, entry: ci/chk.sh, language: script}]}\n";
  const r = fixerRepo("fleet-r7-flow-", cfg, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "a.py": "x=1\n" });
  try {
    writeFileSync(join(r.wt, "a.py"), "x=2\n");
    writeFileSync(join(r.wt, "ci/chk.sh"), "#!/bin/sh\nrm -rf /\n");
    const o = r.runF();
    assert.equal(o.ran, false);
    assert.deepEqual(o.refused, ["ci/chk.sh"]);
  } finally {
    r.done();
  }
});

test("3.0.0 review 6: a plain config behaves as before with PyYAML; without it, it is refused", { skip: !HAVE_PY }, () => {
  const cfg = "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        entry: ci/chk.sh\n        language: script\n        args: [--fix, tools/gen.py]\n        files: ^common/\n";
  for (const noYaml of HAVE_YAML ? [false, true] : [true]) {
    const r = fixerRepo("fleet-r6-plain-", cfg, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "tools/gen.py": "print(1)\n", "common/a.py": "x=1\n" });
    try {
      writeFileSync(join(r.wt, "common/a.py"), "x=2\n");
      const o = r.runF(null, 180, noYaml);
      if (noYaml) {
        assert.deepEqual([o.ran, o.refused], [false, [".pre-commit-config.yaml"]]);
        continue;
      }
      assert.equal(o.ran, true, o.reason);
      assert.deepEqual(o.files, ["common/a.py"]);
      assert.deepEqual(o.refused, []);
      writeFileSync(join(r.wt, "tools/gen.py"), "print(2)\n");
      assert.deepEqual(r.runF().refused, ["tools/gen.py"]);
    } finally {
      r.done();
    }
  }
});

// ---------------------------------------------------------------- 3.0.0 review 8: no program imports from the worktree

test("3.0.0 review 8: a yaml.py in the cwd neither runs nor changes the hook surface", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const cfg = "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        entry: ci/chk.sh\n        language: script\n";
  const r = fixerRepo("fleet-r8-yaml-", cfg, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "a.py": "x=1\n" });
  try {
    const marker = join(r.home, "SHADOW_RAN");
    writeFileSync(join(r.wt, "yaml.py"), "open(" + JSON.stringify(marker) + ", 'w').write('x')\ndef safe_load(b):\n    return {'repos': []}\n");
    writeFileSync(join(r.wt, "ci/chk.sh"), "#!/bin/sh\nrm -rf /\n");
    const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
    const env = Object.assign({}, process.env, { PATH: join(r.home, "bin") + ":" + process.env.PATH, LOG: join(r.home, "log") });
    // the agent's shell sits in the worktree
    const x = spawnSync("python3", ["-I", "-", r.wt, JSON.stringify({ dirty: true }), "[]", join(r.home, "scratch"), "180"], { input: prog, encoding: "utf8", env, cwd: r.wt });
    assert.equal(x.status, 0, x.stderr);
    const o = JSON.parse(x.stdout);
    assert.ok(!existsSync(marker), "the coder's yaml.py never ran");
    assert.deepEqual(o.refused, ["ci/chk.sh"], o.reason);
    assert.ok(!existsSync(join(r.home, "log")), "no hook ran");
  } finally {
    r.done();
  }
});

test("3.0.0 review 8: every embedded program runs isolated (-I), the YAML loader with cwd /", () => {
  // 4.0.0: programs run as `sha256sum -- <file> && python3 -I <file>`
  // 4.0.1: the workflow and the shipped programs (scripts/*.py)
  const all = SOURCE + "\n" + PROGRAMS_TEXT;
  const calls = (all.match(/["'`][^"'`\n]*python3 [^"'`]*/g) || []).filter((c) => !/python3 as /.test(c)).map((c) => c.slice(c.indexOf("python3") - 1));
  assert.ok(calls.length >= 4, "found the invocations: " + calls.length);
  for (const c of calls) assert.match(c, /^.python3 -I /, c);
  // 4.0.0: one runner for every shipped program, by path from scripts_dir
  assert.match(SOURCE, /const f = shQuote\(state\.scriptsDir \+ "\/" \+ name \+ "\.py"\);\n  return emitProg\(name, "sha256sum -- " \+ f \+ " && python3 -I " \+ f \+/);
  assert.match(PROGRAMS_TEXT, /subprocess\.run\(\[c, '-I', '-c', LOADER\] \+ sites,/);
  assert.match(PROGRAMS_TEXT, /cwd='\/'/);
  // no program uses a third-party import (the YAML loader runs under pre-commit's interpreter)
  const progs = PROGRAM_BODIES;
  assert.ok(progs.length >= 10);
  const stdlib = new Set(["fnmatch", "glob", "hashlib", "json", "os", "re", "shlex", "shutil", "subprocess", "sys", "tempfile", "stat", "collections", "functools", "itertools", "pathlib", "configparser", "tomllib", "io", "errno", "codecs", "sqlite3", "atexit", "time", "resource", "ast", "base64", "secrets"]);
  for (const [name, p] of progs) {
    for (const m of p.matchAll(/^\s*import ([A-Za-z0-9_, .]+)$/gm))
      for (const mod of m[1].split(",").map((x) => x.trim().split(" ")[0].split(".")[0]))
        // PRECOMMIT_IDS_PY: PyYAML, failing closed when absent; HASHER_PY: tomli only
        // as the guarded fallback for python < 3.11 (tomllib), failing closed too
        // (the hasher's optional PyYAML read of local hooks predates 3.0.0); with -I
        // each comes from site-packages, never from the cwd
        if (!(name === "PRECOMMIT_IDS_PY" && mod === "yaml") && !(name === "HASHER_PY" && (mod === "tomli" || mod === "yaml")))
          assert.ok(stdlib.has(mod), name + " imports " + mod);
  }
});

test("3.0.0 review 8: a json.py in the cwd does not reach an isolated program run", { skip: !HAVE_PY }, () => {
  const wt = gitRepo("fleet-r8-json-", { "a.py": "def f():\n    return 1\n" });
  try {
    const marker = join(wt, "..", "JSON_RAN_" + Date.now.name);
    writeFileSync(join(wt, "json.py"), "open(" + JSON.stringify(marker) + ", 'w').write('x')\ndef dumps(*a, **k):\n    return '{}'\n");
    const prog = extractPy("REVIEW_PATHS_PY_BEGIN", "REVIEW_PATHS_PY_END", "REVIEW_PATHS_PY");
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    const r = spawnSync("python3", ["-I", "-c", prog, wt, head, head], { encoding: "utf8", cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(marker), "json.py never ran");
    assert.deepEqual(JSON.parse(r.stdout).changed_paths, []);
    rmSync(marker, { force: true });
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("3.0.0 review 8 s_link_head: a path that is a symlink at HEAD but a regular file in the worktree is refused", { skip: !HAVE_PY }, () => {
  const r = fixerRepo("fleet-r8-link-", "repos: []\n", { "a.py": "x=1\n" });
  try {
    spawnSync("ln", ["-s", "a.py", join(r.wt, "b.py")]);
    sh(r.wt, "git", "add", "b.py");
    sh(r.wt, "git", "commit", "-qm", "b");
    rmSync(join(r.wt, "b.py"));
    writeFileSync(join(r.wt, "b.py"), "y=1\n");
    const o = r.runF();
    assert.ok(o.refused.includes("b.py"), JSON.stringify(o));
    assert.equal(o.ran, false);
  } finally {
    r.done();
  }
});

test("3.0.0 review 8 s_realpath_in: a selected path whose realpath leaves the checkout is refused; nothing is written outside", { skip: !HAVE_PY }, () => {
  const r = fixerRepo("fleet-r8-real-", "repos: []\n", { "sub/a.py": "x=1\n" });
  try {
    const escape = join(r.home, "escape.py");
    writeFileSync(escape, "e=1\n");
    const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
    const env = Object.assign({}, process.env, { PATH: join(r.home, "bin") + ":" + process.env.PATH, LOG: join(r.home, "log") });
    const x = spawnSync("python3", ["-I", "-", r.wt, JSON.stringify({ paths: ["sub/../../escape.py"] }), "[]", join(r.home, "scratch"), "180"], { input: prog, encoding: "utf8", env });
    assert.equal(x.status, 0, x.stderr);
    const o = JSON.parse(x.stdout);
    assert.deepEqual(o.refused, ["sub/../../escape.py"], JSON.stringify(o));
    assert.equal(o.ran, false);
    assert.equal(readFileSync(escape, "utf8"), "e=1\n");
    assert.ok(!existsSync(join(r.home, "log")), "no hook ran");
  } finally {
    r.done();
  }
});

test("3.0.0 review 8: the nix pre-commit's own interpreter reads the config through its wrapped sys.path", { skip: !HAVE_PY || !/^\/nix\/store\//.test(spawnSync("sh", ["-c", "readlink -f \"$(command -v pre-commit)\""], { encoding: "utf8" }).stdout || "") }, () => {
  const cfg = "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n        entry: ci/chk.sh\n        language: script\n";
  const r = fixerRepo("fleet-r8-nix-", cfg, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "a.py": "x=1\n" });
  try {
    writeFileSync(join(r.wt, "ci/chk.sh"), "#!/bin/sh\nrm -rf /\n");
    const prog = extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY");
    // the real nix pre-commit on PATH; this python3's own PyYAML is switched off
    const x = spawnSync("python3", ["-I", "-", r.wt, JSON.stringify({ dirty: true }), "[]", join(r.home, "scratch"), "180", "no-local-yaml"], { input: prog, encoding: "utf8" });
    assert.equal(x.status, 0, x.stderr);
    assert.deepEqual(JSON.parse(x.stdout).refused, ["ci/chk.sh"], x.stdout);
  } finally {
    r.done();
  }
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1941a): prose-only pages pinned at their live versions

test("4.0.0 pins: every role page at its fleet-v4 version", () => {
  const m = /const EXPECTED_VERSIONS = (\{[\s\S]*?\});/.exec(SOURCE);
  assert.ok(m, "EXPECTED_VERSIONS");
  const got = Function("return " + m[1])();
  assert.deepEqual(got, {
    "scope-and-plan": 29,
    "plan-audit": 17,
    "fleet-test-writer": 11,
    "fleet-test-judge": 11,
    "fleet-coder": 18,
    "fleet-code-judge": 16,
    "fleet-pr-opener": 11,
    "fleet-intent-judge": 3,
    "pr-review": 19,
    "gate-change-nonweakening-sweep": 6,
  });
  assert.deepEqual(got, FROZEN_VERSIONS, "the harness pins follow the script");
});

test("4.0.0 pins: a page below its pin names the 4.0.0 deploy order", async () => {
  const s = happy();
  s.preflight.versions["fleet-code-judge"] = 15;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /agent_prompt_get\(fleet-code-judge, project m-agahi\/yadgar\) wiki version 15 must be >= 16; update that page in place; see CHANGELOG 4\.0\.0 deploy order/);
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1959): verify-plan and commit-plan relay program output, not raw git

const VERIFY_KEYS = ["head", "is_ancestor", "commits_since", "plan_touched", "changed_since", "args"];

test("3.1.0 1959: the verify and plan-files programs print what git says, with a digest the workflow recomputes", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-1959-"));
  try {
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, "[user]\n\temail = t@example.com\n\tname = t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
    const env = gitEnv(home, cfg);
    const { wt, g } = scanRepo(home, env);
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    const check = (o, keys) => {
      const x = { program: o.program };
      for (const k of keys) x[k] = o[k] === undefined ? null : o[k];
      assert.equal(sha256(fn(x)), o.digest, keys.join(","));
    };
    // the agent's shell sits in the worktree; the programs run from / anyway
    const runP = (b, e, c, args) => {
      const r = spawnSync("python3", ["-I", "-c", extractPy(b, e, c), wt].concat(args), { encoding: "utf8", env, cwd: wt });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const pc = g("rev-parse", "HEAD").trim();
    // the plan commit holds the plan doc only
    const pf = runP("PLAN_FILES_PY_BEGIN", "PLAN_FILES_PY_END", "PLAN_FILES_PY", []);
    assert.deepEqual([pf.head, pf.files], [pc, ["docs/plans/x.md"]]);
    assert.deepEqual(pf.args, [wt]);
    // 4.0.0 review: no test DSN in the plan doc
    assert.deepEqual(pf.dsn_paths, []);
    check(pf, ["head", "files", "args", "dsn_paths"]);
    // head = plan commit: nothing since
    let v = runP("VERIFY_SINCE_PY_BEGIN", "VERIFY_SINCE_PY_END", "VERIFY_SINCE_PY", [pc, "docs/plans/x.md"]);
    assert.deepEqual(v, Object.assign({ head: pc, is_ancestor: true, commits_since: [], plan_touched: [], changed_since: [], args: [wt, pc, "docs/plans/x.md"] }, { program: { name: null, sha256: null }, digest: v.digest }));
    check(v, VERIFY_KEYS);
    // two commits after it: a non-ASCII subject with a tab and a control character, and one that touches the plan
    writeFileSync(join(wt, "a.py"), "b\n");
    writeFileSync(join(wt, "ü é.py"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "feat(l42): ü\tthing \u0001 done");
    const c1 = g("rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "docs", "plans", "x.md"), "# plan 2\n");
    g("commit", "-qam", "edit plan");
    const c2 = g("rev-parse", "HEAD").trim();
    v = runP("VERIFY_SINCE_PY_BEGIN", "VERIFY_SINCE_PY_END", "VERIFY_SINCE_PY", [pc, "docs/plans/x.md"]);
    assert.equal(v.head, c2);
    assert.equal(v.is_ancestor, true);
    assert.deepEqual(v.commits_since, [
      { sha: c2, subject: "edit plan" },
      { sha: c1, subject: "feat(l42): ü\tthing \u0001 done" },
    ]);
    assert.deepEqual(v.plan_touched, [c2]);
    assert.deepEqual(v.changed_since, ["a.py", "docs/plans/x.md", "ü é.py"]);
    check(v, VERIFY_KEYS);
    // a plan commit HEAD does not descend from: no lists, is_ancestor false
    g("checkout", "-q", "--orphan", "other");
    g("commit", "-qm", "orphan");
    v = runP("VERIFY_SINCE_PY_BEGIN", "VERIFY_SINCE_PY_END", "VERIFY_SINCE_PY", [pc, "docs/plans/x.md"]);
    assert.deepEqual([v.is_ancestor, v.commits_since, v.plan_touched, v.changed_since], [false, [], [], []]);
    check(v, VERIFY_KEYS);
    // a bad revision fails the step
    const bad = spawnSync("python3", ["-I", "-c", extractPy("VERIFY_SINCE_PY_BEGIN", "VERIFY_SINCE_PY_END", "VERIFY_SINCE_PY"), wt, "0".repeat(40), "docs/plans/x.md"], { encoding: "utf8", env });
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.1.0 1959: the verify and commit-plan prompts run the programs, not raw git listings", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  const build = await runOne(s, buildArgs(plan.result.plan_ref));
  const vp = call(build, "infra:verify-plan").prompt;
  // 4.0.0: the plan files are listed by the read-only verify step after the commit
  const cp = call(plan, "infra:verify-plan-commit").prompt;
  const q = (n) => "python3 -I '" + SCRIPTS_DIR + "/" + n + ".py'";
  assert.ok(vp.includes(q("verify_since")));
  assert.ok(cp.includes(q("plan_files")));
  assert.doesNotMatch(vp, /log --format=%H%x09%s/);
  assert.doesNotMatch(vp, /diff --name-only <plan_commit>\.\.HEAD/);
  assert.doesNotMatch(cp, /show --name-only --format= HEAD/);
  assert.doesNotMatch(call(plan, "infra:commit-plan").prompt, /show --name-only --format= HEAD/);
  // the plan hash program stays the first one in the verify prompt
  assert.ok(vp.indexOf(q("verify_since")) > vp.indexOf(q("plan_hash")));
});

test("3.1.0 1959: a verify relay that drops or changes an entry stops the run", async () => {
  const cases = [
    (r) => ({ ...r, commits_since: [] }),
    (r) => ({ ...r, changed_since: ["src/x.py"] }),
    (r) => ({ ...r, plan_touched: [] }),
    (r) => ({ ...r, is_ancestor: true, head: "fedcba9877" }),
    (r) => {
      const o = { ...r };
      delete o.changed_since;
      return o;
    },
  ];
  for (const mut of cases) {
    const s = happy();
    const ref = await planRefFor(s);
    const good = withRelayDigest("infra:verify-plan", {
      ...s["infra:verify-plan"],
      head: "fedcba9876",
      commits_since: [{ sha: "fedcba9876", subject: "feat(l42): add thing" }],
      plan_touched: ["fedcba9876"],
      changed_since: ["src/x.py", ".github/x.yml"],
    });
    s["infra:verify-plan"] = mut(good);
    const out = await runOne(s, buildArgs(ref));
    assert.equal(out.result.status, "failed", JSON.stringify(out.result.reason));
    assert.match(out.result.reason, /infra:verify-plan: the relayed (lists do not match the program's digest|result has no)/);
    assert.ok(!out.labels.some((l) => /^role:/.test(l)), "stops before any role");
  }
  // the untampered relay reaches the fence (and stops on .github/)
  const s = happy();
  const ref = await planRefFor(s);
  s["infra:verify-plan"] = { ...s["infra:verify-plan"], head: "fedcba9876", commits_since: [{ sha: "fedcba9876", subject: "feat(l42): add thing" }], changed_since: [".github/x.yml"] };
  const ok = await runOne(s, buildArgs(ref));
  assert.equal(ok.result.stop_gate, "scope");
});

test("3.1.0 1959: a commit-plan relay whose files or head differ from the program's digest stops the run", async () => {
  // 4.0.0: the plan files are relayed by the read-only verify step; a relay
  // changed after the program printed it is asked once more, then stops
  for (const mut of [(r) => (r.files = []), (r) => (r.files = r.files.concat(["x.py"])), (r) => (r.head = "abc1234def1"), (r) => delete r.digest]) {
    const s = happy();
    s.__mutate = { label: "infra:verify-plan-commit", fn: (r) => (mut(r.plan_files), r) };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.equal(out.result.stop_gate, "commit");
    assert.match(out.result.reason, /infra:verify-plan-commit: the relayed head and files do not match the program's digest/);
    assert.equal(out.labels.filter((l) => l === "infra:verify-plan-commit").length, 2);
  }
  // the commit step's own relay (head and tag object) is digest-checked too
  const s = happy();
  s.__mutate = { label: "infra:commit-plan", fn: (r) => ((r.head = "abc1234def1"), r) };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /infra:commit-plan: the relayed head and tag object do not match the program's digest/);
});

test("3.1.0 1959: every embedded program takes the worktree as an argument and runs git from /", () => {
  for (const [b, e, c] of [
    ["VERIFY_SINCE_PY_BEGIN", "VERIFY_SINCE_PY_END", "VERIFY_SINCE_PY"],
    ["PLAN_FILES_PY_BEGIN", "PLAN_FILES_PY_END", "PLAN_FILES_PY"],
    ["PUSH_CLASSIFY_PY_BEGIN", "PUSH_CLASSIFY_PY_END", "PUSH_CLASSIFY_PY"],
  ]) {
    const p = extractPy(b, e, c);
    assert.match(p, /^os\.chdir\('\/'\)$/m, c + " leaves the worktree before it does anything");
    if (c !== "PUSH_CLASSIFY_PY") assert.match(p, /'-C', wt\]/, c + " names the worktree with git -C");
  }
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1935c): the push classifier is a program, tested on real git output

// Captured with git 2.55.0 (scratch repos and a local smart-HTTP server; LANG=C).
// remote_rejected: a bare remote whose pre-receive hook exits 1. hook_rejected:
// a local pre-push hook that prints an `error:` line and exits 1. http_5xx_post:
// GET info/refs served by git http-backend, POST answered 500/502. http_5xx_get:
// info/refs answered 500/503.
const PUSH_FIXTURES = {
  ok: [0, "branch 'main' set up to track 'origin/main'.\nTo /tmp/pushcap/ok.git\n * [new branch]      main -> main\n", "ok"],
  remote_rejected: [1, "remote: policy: branch protected        \nTo /tmp/pushcap/rr.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to '/tmp/pushcap/rr.git'\n", "remote_rejected"],
  hook_rejected: [1, "run make bump\nerror: version not bumped\nerror: failed to push some refs to '/tmp/pushcap/ok.git'\n", "hook_rejected"],
  non_ff: [1, "To /tmp/pushcap/ok.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/tmp/pushcap/ok.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.\n", "non_ff"],
  http_500_post: [1, "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly\nEverything up-to-date\n", "network"],
  http_502_post: [1, "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly\nEverything up-to-date\n", "network"],
  http_500_get: [128, "fatal: unable to access 'http://127.0.0.1:60457/x.git/': The requested URL returned error: 500\n", "network"],
  http_503_get: [128, "fatal: unable to access 'http://127.0.0.1:60457/x.git/': The requested URL returned error: 503\n", "network"],
  // DERIVED, not observed: an RPC failure whose `fatal:` line is missing (the
  // shape the 3.0.0 prose rule routed to hook_rejected). A hook may print the
  // same line, so git's output cannot be told from the hook's: ambiguous, a
  // stop for a human; never a network retry that re-runs the hook (3.1.0 review).
  rpc_no_fatal: [1, "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500\nerror: failed to push some refs to 'https://github.com/o/r.git'\n", "ambiguous"],
  // DERIVED: a pre-push hook that prints a line-start `fatal:` (3.0.0: network, so the retries re-ran the hook)
  hook_fatal: [1, "fatal: version not bumped\nerror: failed to push some refs to 'github.com:o/r.git'\n", "ambiguous"],
  // DERIVED from git-lfs's pre-push output shape: a network failure inside the lfs hook is the hook's verdict
  lfs_network: [1, "batch response: Post \"https://github.com/o/r.git/info/lfs/objects/batch\": dial tcp: lookup github.com: no such host\nerror: failed to push some refs to 'github.com:o/r.git'\n", "ambiguous"],
};

function classifyPush(code, output) {
  const home = mkdtempSync(join(tmpdir(), "fleet-push-"));
  try {
    const f = join(home, "out.txt");
    writeFileSync(f, output);
    const r = spawnSync("python3", ["-I", "-c", extractPy("PUSH_CLASSIFY_PY_BEGIN", "PUSH_CLASSIFY_PY_END", "PUSH_CLASSIFY_PY"), f, String(code)], { encoding: "utf8", cwd: home });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("3.1.0 1935c: the push classifier routes real git push output", { skip: !HAVE_PY }, () => {
  const fn = new Function(extractCanonical() + "\nreturn canonical;")();
  for (const [name, [code, output, want]] of Object.entries(PUSH_FIXTURES)) {
    const o = classifyPush(code, output);
    assert.equal(o.push_result, want, name);
    assert.equal(o.exit_code, code, name);
    assert.equal(o.hook_tail, want === "hook_rejected" ? output.replace(/\n$/, "") : "", name);
    // the program echoes its arguments (3.1.0 review)
    assert.equal(o.args.length, 2, name);
    assert.ok(o.args[0].endsWith("/out.txt"), name);
    assert.equal(o.args[1], String(code), name);
    assert.equal(o.digest, sha256(fn({ push_result: o.push_result, exit_code: o.exit_code, hook_tail: o.hook_tail, args: o.args, program: o.program })), name);
  }
  // only line-start prefixes count: a hook that prints rejected-looking text mid-line stays a hook
  const o = classifyPush(1, "hook: ! [rejected] is what you get\nsee fatal: nothing\nerror: failed to push some refs to 'x'\n");
  assert.equal(o.push_result, "hook_rejected");
  // the tail is the last 60 lines
  const long = Array.from({ length: 80 }, (_, i) => "line " + i).join("\n") + "\nerror: failed to push some refs to 'x'\n";
  const t = classifyPush(1, long).hook_tail.split("\n");
  assert.equal(t.length, 60);
  assert.equal(t[59], "error: failed to push some refs to 'x'");
});

test("3.1.0 1935c: the push step runs the classifier program; a hook_rejected the program did not print stops the run", async () => {
  const s = happy();
  const out = await run(s, ARGS);
  const p = call(out, "infra:push").prompt;
  assert.ok(p.includes("python3 -I '" + SCRIPTS_DIR + "/push_classify.py' <file> <exit>"));
  assert.match(p, /\{push_result, exit_code, hook_tail, args, program, digest\}/);
  // an ambiguous result stops for a human, never a network retry
  assert.match(p, /`ambiguous`[^\n]*needs_human[^\n]*no retry/);
  // a relayed hook_rejected whose tail or result was changed in the copy, or
  // whose arguments are not a temp file outside the worktree and its exit code
  for (const bad of [
    (r) => ({ ...r, hook_tail: "a different tail" }),
    (r) => ({ ...r, push_result: "hook_rejected", exit_code: 1, hook_tail: "x", digest: undefined }),
    (r) => ({ ...r, exit_code: 128 }),
    (r) => {
      const o = { ...r, args: ["/r/.claude/worktrees/fleet-l42-add-thing/main/out.txt", "1"] };
      o.digest = relayDigestOf(o, ["push_result", "exit_code", "hook_tail", "args"]);
      return o;
    },
    (r) => {
      const o = { ...r, args: ["/tmp/x/out.txt", "0"] };
      o.digest = relayDigestOf(o, ["push_result", "exit_code", "hook_tail", "args"]);
      return o;
    },
  ]) {
    const t = happy();
    const good = { status: "ok", reason: "hook", push_result: "hook_rejected", exit_code: 1, hook_tail: "check_version_bump: core version not bumped\nerror: failed to push some refs", args: ["/tmp/x/out.txt", "1"] };
    good.digest = relayDigestOf(good, ["push_result", "exit_code", "hook_tail", "args"]);
    const r = bad(good);
    if (r.digest === undefined) delete r.digest;
    t["infra:push"] = Object.assign(r, { __raw: true });
    const o = await run(t, ARGS);
    assert.equal(o.result.status, "failed", JSON.stringify(o.result.reason));
    assert.match(o.result.reason, /infra:push: the relayed hook_rejected result does not match the classifier program's digest/);
    assert.ok(!o.labels.includes("role:fleet-coder:r2"), "no coder round on an unverified hook rejection");
  }
});

test("3.1.0 1935c: a gh error string in remote_head never passes as the pushed sha", async () => {
  // DERIVED from gh's error format, not observed: a 5xx from the GitHub API
  const s = happy();
  s["infra:push"] = { status: "ok", reason: "pushed", push_result: "ok", remote_head: "gh: HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/branches/fleet/l42-add-thing)" };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /push: origin\/fleet\/l42-add-thing is at gh: HTTP 502/);
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1935a): writers and the test judge get the plan's env

test("3.1.0 1935a: the writers and the test judge get test_cmd with its env, and test_env on top", async () => {
  // already true at ae273d6 (3.0.0): a regression test, no code change
  const tc = { command: "uv run --extra test pytest <paths> -n0", paths_placeholder: "<paths>", env: { TZ: "UTC", DJANGO_SETTINGS_MODULE: "app.settings", CI: "1" }, tools: [] };
  const s = happy();
  s["role:scope-and-plan"].test_cmd = tc;
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:fleet-test-writer:AC1:r1", "role:fleet-test-writer:AC2:r1", "role:fleet-test-judge:r1", "role:fleet-coder:r1", "role:fleet-code-judge:r1"]) {
    const i = inputsOf(call(out, l).prompt);
    assert.deepEqual(i.test_cmd.env, tc.env, l);
    assert.deepEqual(i.test_env, { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" }, l);
  }
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1935b): an allowlisted check_cmd is run by the code judge before the push

const OB_PRE = {
  id: "OB3",
  kind: "other",
  rule_source: ".github/workflows/validate.yaml:lint",
  files: ["src/x.py"],
  instruction: "keep the CI lint green",
  check_cmd: "pre-commit run ruff --all-files",
};

test("3.1.0 1935b: approve needs check_exit 0 for every allowlisted check_cmd, or the gate listed as not run", async () => {
  const cases = [
    // [check entry for OB3, gates_not_run, converted?, finding]
    [{ id: "OB3", met: true, evidence: "diff", check_exit: 0 }, [], false, null],
    [{ id: "OB3", met: true, evidence: "diff", check_exit: 1 }, [], true, /OB3: check_cmd "pre-commit run ruff --all-files" exited 1/],
    [{ id: "OB3", met: true, evidence: "diff", check_exit: 2 }, [], true, /exited 2/],
    [{ id: "OB3", met: true, evidence: "diff" }, [], true, /OB3: code-judge neither ran check_cmd "pre-commit run ruff --all-files" \(no check_exit\) nor listed gates_not_run check_cmd:OB3/],
    [{ id: "OB3", met: true, evidence: "diff", check_exit: "0" }, [], true, /neither ran/],
    [{ id: "OB3", met: true, evidence: "diff", check_exit: null }, [{ gate: "check_cmd:OB3", reason: "pre-commit is not installed" }], false, null],
    [{ id: "OB3", met: true, evidence: "diff" }, [{ gate: "check_cmd:OB9", reason: "x" }], true, /neither ran/],
  ];
  for (const [entry, notRun, converted, finding] of cases) {
    const s = withObligations([OB_PRE]);
    s["role:fleet-code-judge:r1"].obligations_check = [entry];
    s["role:fleet-code-judge:r1"].gates_not_run = notRun;
    if (notRun.length) s["role:fleet-code-judge:r1"].reason = "approved with gates not run: " + notRun.map((g) => g.gate).join(", ");
    secondRoundPasses(s, [{ id: "OB3", met: true, evidence: "ok", check_exit: 0 }]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", JSON.stringify(entry) + " " + out.result.reason);
    assert.equal(out.result.rounds.code, converted ? 2 : 1, JSON.stringify(entry));
    if (converted) {
      assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding).join("\n"), finding);
      assert.ok(out.logs.some((l) => /obligations gate/.test(l)));
    } else if (notRun.length) assert.ok(out.result.gates_not_run.some((g) => g.gate === "check_cmd:OB3"), "the PR states the check_cmd that did not run");
  }
});

test("3.1.0 1935b: a met:false obligation and a check_cmd failure each count once; a demoted check_cmd needs no exit", async () => {
  // met false: the 3.0.0 finding only
  let s = withObligations([OB_PRE]);
  s["role:fleet-code-judge:r1"].obligations_check = [{ id: "OB3", met: false, evidence: "lint fails", check_exit: 1 }];
  secondRoundPasses(s, [{ id: "OB3", met: true, evidence: "ok", check_exit: 0 }]);
  let out = await run(s, ARGS);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding);
  assert.equal(f.length, 1, f.join("\n"));
  assert.match(f[0], /OB3: code-judge did not confirm the obligation met/);
  // a check_cmd the script check demoted this round: judged from the diff, no exit needed
  s = withObligations([OB_BUMP]);
  s["infra:check-scripts:r1"] = checkScriptsAll({ "scripts/check_version_bump.py": "not a tracked regular file" });
  s["role:fleet-code-judge:r1"].obligations_check = [{ id: "OB1", met: true, evidence: "diff" }];
  out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 1);
  // a plan-time refused check_cmd (check_cmd_rejected) needs no exit either
  s = withObligations([Object.assign({}, OB_PRE, { check_cmd: "pre-commit install" })]);
  s["role:fleet-code-judge:r1"].obligations_check = [{ id: "OB3", met: true, evidence: "diff" }];
  out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.rounds.code, 1);
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1958): write-back to a yadgar ledger task without a body page

const T42 = "fleet: a ledger task title, verbatim — with ü and \"quotes\"";

// A happy run whose ledger task L42 has no body_slug. over: label -> stub.
function noBody(over) {
  const s = happy();
  s["infra:ledger-read:pre"] = (prompt) => ({
    status: "ok",
    reason: "read",
    results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "ok", title: T42, body_slug: null, has_marker: false })),
  });
  s["infra:ledger-body"] = (prompt) => ({ status: "ok", reason: "ok", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "written" })) });
  s["infra:ledger-read:post"] = (prompt) => ({
    status: "ok",
    reason: "read",
    results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "ok", title: T42, body_slug: "o_r_task-42", has_marker: true, page_project: "o/r", page_tags: ["task-body", "fleet", "ledger-42"] })),
  });
  return Object.assign(s, over || {});
}

test("3.1.0 1958: a ledger task without a body page gets one, linked with the title a judge read", async () => {
  const out = await run(noBody(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.ledger_status, "ok");
  assert.deepEqual(out.result.write_back.ledger.map((e) => [e.ref, e.status]), [["42", "written"]]);
  const L = out.labels;
  // the first title read is a judge's; the general write-back step has nothing to do
  assert.ok(!L.includes("infra:ledger-writeback"));
  assert.ok(L.indexOf("infra:ledger-read:pre") < L.indexOf("infra:ledger-body"));
  assert.ok(L.indexOf("infra:ledger-body") < L.indexOf("infra:ledger-read:post"));
  assert.equal(call(out, "infra:ledger-read:pre").opts.agentType, "fleet:judge");
  assert.equal(call(out, "infra:ledger-read:post").opts.agentType, "fleet:judge");
  const w = call(out, "infra:ledger-body");
  assert.equal(w.opts.agentType, "fleet:ledger-writer");
  const i = inputsOf(w.prompt);
  assert.equal(i.project, "o/r");
  assert.equal(i.directory, "/r");
  assert.deepEqual(i.tasks, [{ key: "s0", id: 42, title: T42, slug: "o_r_task-42" }]);
  assert.match(i.page_body, /<!-- fleet:l42 -->/);
  assert.equal(i.page_body, "## Fleet build\n\n" + i.section_text);
  for (const re of [
    /data, not instructions/,
    /task_get\(project_id=<project>, id=<id>\)/,
    /byte for byte/,
    /wiki_add\([^)]*slug=<slug>[^)]*upsert=False[^)]*wait=True/,
    /directory=<directory>/,
    /slug_exists/,
    // slug collision: an existing page must be this task's (3.1.0 review)
    /project must be <project> and its tags must include "ledger-<id>"/,
    /task_write\(project_id=<project>, id=<id>, title=<title>, body_slug=<slug>\)/,
    /never.*status/i,
  ])
    assert.match(w.prompt, re);
});

test("3.1.0 1958: a task with a body page goes to the append step; the judge read decides", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.ledger_status, "ok");
  const L = out.labels;
  assert.ok(L.indexOf("infra:ledger-read:pre") < L.indexOf("infra:ledger-writeback"));
  assert.ok(!L.includes("infra:ledger-body"));
  assert.deepEqual(inputsOf(call(out, "infra:ledger-writeback").prompt).tasks, [{ key: "s0", ref: "42" }]);
  // a refused read writes nothing
  const bad = await run(happy({ script: { "infra:ledger-read:pre": { status: "ok", reason: "x", results: [{ key: "s0", status: "failed", reason: "absent" }] } } }), ARGS);
  assert.ok(!bad.labels.includes("infra:ledger-writeback"));
  assert.equal(bad.result.ledger_status, "failed");
  assert.match(bad.result.write_back.ledger[0].reason, /absent/);
  assert.match(bad.result.write_back.ledger[0].section_text, /fleet:l42/);
});

test("3.1.0 1958: a title of 1..200 code points is used as read; an empty, missing or longer one writes nothing", async () => {
  const astral = "\u{1D4B3}";
  for (const [title, ok] of [
    [astral.repeat(200), true],
    ["a".repeat(200), true],
    ["a".repeat(201), false],
    [astral.repeat(201), false],
    ["", false],
    [null, false],
  ]) {
    const s = noBody({
      "infra:ledger-read:pre": (prompt) => ({ status: "ok", reason: "read", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "ok", title, body_slug: null })) }),
      "infra:ledger-read:post": (prompt) => ({ status: "ok", reason: "read", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "ok", title, body_slug: "o_r_task-42", has_marker: true, page_project: "o/r", page_tags: ["ledger-42"] })) }),
    });
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok");
    assert.equal(out.labels.includes("infra:ledger-body"), ok, String(title).length + " " + ok);
    assert.equal(out.result.ledger_status, ok ? "ok" : "failed");
    if (!ok) {
      assert.match(out.result.write_back.ledger[0].reason, /title/);
      assert.match(out.result.write_back.ledger[0].section_text, /fleet:l42/);
    } else assert.equal(inputsOf(call(out, "infra:ledger-body").prompt).tasks[0].title, title);
  }
});

test("3.1.0 1958: a changed or truncated title after the write, a wrong body_slug or no marker fails closed", async () => {
  const post = (r) => ({
    "infra:ledger-read:post": (prompt) => ({ status: "ok", reason: "read", results: inputsOf(prompt).tasks.map((t) => Object.assign({ key: t.key, status: "ok", title: T42, body_slug: "o_r_task-42", has_marker: true, page_project: "o/r", page_tags: ["ledger-42"] }, r)) }),
  });
  for (const [over, re] of [
    [post({ title: T42.slice(0, 30) }), /title changed by the write-back/],
    [post({ title: T42.toUpperCase() }), /title changed by the write-back/],
    [post({ title: undefined }), /title changed by the write-back/],
    [post({ body_slug: "o_r_task-43" }), /body_slug/],
    [post({ body_slug: null }), /body_slug/],
    [post({ has_marker: false }), /marker/],
    [post({ status: "failed", reason: "refused" }), /refused/],
    [{ "infra:ledger-read:post": null }, /no result/],
    [{ "infra:ledger-body": (prompt) => ({ status: "ok", reason: "x", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "failed", reason: "title differs" })) }) }, /title differs/],
    [{ "infra:ledger-body": (prompt) => ({ status: "ok", reason: "x", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status: "failed", reason: "slug collision" })) }) }, /slug collision/],
  ]) {
    const out = await run(noBody(over), ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok");
    assert.equal(out.result.ledger_status, "failed", JSON.stringify(Object.keys(over)));
    assert.equal(out.result.write_back.ledger[0].status, "failed");
    assert.match(out.result.write_back.ledger[0].reason, re);
    assert.match(out.result.write_back.ledger[0].section_text, /fleet:l42/);
  }
});

test("3.1.0 1958: a project that is not owner/repo writes nothing", async () => {
  // 4.0.0 (1992): planned without project, so o/r/x is not a sealed-project mismatch
  const out = await run(noBody(), { ...ARGS, project: undefined }, { project: "o/r/x" });
  assert.ok(!out.build.labels.includes("infra:ledger-body"));
  assert.equal(out.result.ledger_status, "failed");
});

// frontmatter: name -> value (single-line values only)
function frontmatter(name) {
  const t = readFileSync(join(HERE, "..", "agents", name), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  assert.ok(m, name + " frontmatter");
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

test("3.1.0 review F1: fleet:ledger-writer has an exact tools allowlist; fleet:judge denies every yadgar writer", () => {
  const w = frontmatter("ledger-writer.md");
  assert.equal(w.name, "ledger-writer");
  assert.deepEqual(w.tools.split(/,\s*/).sort(), [
    "StructuredOutput",
    "ToolSearch",
    "mcp__yadgar__task_get",
    "mcp__yadgar__task_write",
    "mcp__yadgar__wiki_add",
    "mcp__yadgar__wiki_append_section",
    "mcp__yadgar__wiki_read",
  ]);
  assert.ok(!("disallowedTools" in w), "an allowlist, not a denylist");
  const deny = frontmatter("judge.md").disallowedTools.split(/,\s*/);
  for (const t of [
    "Write", "Edit", "NotebookEdit",
    "mcp__yaadgaar__edit_task", "mcp__yaadgaar__create_task", "mcp__yaadgaar__transition_task",
    "mcp__yadgar__task_write", "mcp__yadgar__wiki_add", "mcp__yadgar__wiki_append_section", "mcp__yadgar__wiki_update",
    "mcp__yadgar__wiki_replace_at", "mcp__yadgar__wiki_replace_text", "mcp__yadgar__wiki_replace_markdown_block",
    "mcp__yadgar__wiki_insert_at", "mcp__yadgar__wiki_insert_after", "mcp__yadgar__wiki_insert_before",
    "mcp__yadgar__wiki_delete", "mcp__yadgar__wiki_delete_at", "mcp__yadgar__wiki_delete_text",
    "mcp__yadgar__wiki_restore", "mcp__yadgar__wiki_set_metadata", "mcp__yadgar__wiki_set_mutability",
    "mcp__yadgar__memorize", "mcp__yadgar__forget", "mcp__yadgar__memory_update", "mcp__yadgar__anchor",
    "mcp__yadgar__block_append", "mcp__yadgar__block_create", "mcp__yadgar__block_delete", "mcp__yadgar__block_replace", "mcp__yadgar__block_update",
    "mcp__yadgar__adr_add", "mcp__yadgar__agent_prompt_save", "mcp__yadgar__config_set",
  ])
    assert.ok(deny.includes(t), t);
});

// ---------------------------------------------------------------- 3.1.0 (ledger 1941b): IaC scan of remote hook manifests and untracked hook scripts

// A pre-commit cache as pre-commit keeps it: db.db maps (repo, ref) to a clone dir.
// ---------------------------------------------------------------- 3.1.0 review: a cache miss is fetched shallowly at the pinned rev

function repoWith(prefix, files) {
  const wt = scratchRepo(prefix);
  for (const [p, c] of Object.entries(files)) {
    spawnSync("mkdir", ["-p", dirname(join(wt, p))]);
    writeFileSync(join(wt, p), c);
  }
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "i");
  return wt;
}

// ---------------------------------------------------------------- 3.1.0 (ledger 1960): the IaC scan follows only names that can run

// ---------------------------------------------------------------- 3.1.0 review F2: the coder may not edit what a check_cmd runs

test("3.1.0 review F2: a change to a check_cmd's script, Makefile or hook config converts approve to fix_code unless the obligation lists it", async () => {
  const ob = (cmd, files) => ({ id: "OB4", kind: "other", rule_source: "ci", files: files || ["src/x.py"], instruction: "keep CI green", check_cmd: cmd });
  const cases = [
    // [check_cmd, obligation files, changed paths, converted]
    ["python3 scripts/check_version_bump.py", null, ["src/x.py", "scripts/check_version_bump.py"], /OB4: the change edits scripts\/check_version_bump\.py, which check_cmd "python3 scripts\/check_version_bump\.py" runs/],
    ["uv run python scripts/c.py", null, ["scripts/c.py"], /edits scripts\/c\.py/],
    ["scripts/check.sh --strict", null, ["scripts/check.sh"], /edits scripts\/check\.sh/],
    ["make check", null, ["Makefile"], /OB4: the change edits Makefile, which check_cmd "make check" runs/],
    ["make check", null, ["mk/rules.mk"], /edits mk\/rules\.mk/],
    ["make check", null, ["sub/GNUmakefile"], /edits sub\/GNUmakefile/],
    // listed by the plan: allowed
    ["python3 scripts/check_version_bump.py", ["src/x.py", "scripts/check_version_bump.py"], ["scripts/check_version_bump.py"], null],
    ["make check", ["Makefile"], ["Makefile"], null],
    // an unrelated change: allowed
    ["make check", null, ["src/x.py", "scripts/other.py"], null],
  ];
  for (const [cmd, files, changed, want] of cases) {
    const s = withObligations([ob(cmd, files)]);
    s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed });
    secondRoundPasses(s, [{ id: "OB4", met: true, evidence: "ok", check_exit: 0 }]);
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", cmd + " " + out.result.reason);
    assert.equal(out.result.rounds.code, want ? 2 : 1, cmd + " " + JSON.stringify(changed));
    if (want) assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding).join("\n"), want);
  }
});

test("3.1.0 review: check_exit must be the integer 0; a negative exit fails", async () => {
  for (const e of [-1, 0.5, true]) {
    const s = withObligations([OB_PRE]);
    s["role:fleet-code-judge:r1"].obligations_check = [{ id: "OB3", met: true, evidence: "diff", check_exit: e }];
    secondRoundPasses(s, [{ id: "OB3", met: true, evidence: "ok", check_exit: 0 }]);
    const out = await run(s, ARGS);
    assert.equal(out.result.rounds.code, 2, String(e));
  }
});

test("3.1.0 review: the verify and commit-plan relays must echo the arguments the script passed", async () => {
  const s = happy();
  const ref = await planRefFor(s);
  const r = { ...s["infra:verify-plan"], changed_since: [], args: ["/elsewhere", PC, "docs/plans/x.md"] };
  r.digest = relayDigestOf(r, ["head", "is_ancestor", "commits_since", "plan_touched", "changed_since", "args"]);
  s["infra:verify-plan"] = r;
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /infra:verify-plan: the program ran on other arguments/);
  const t = happy();
  const inner = verifyStub(t.__store);
  t["infra:verify-plan-commit"] = (prompt) => {
    const x = inner(prompt);
    x.plan_files.args = ["/other/worktree"];
    return x;
  };
  const o = await runOne(t, ARGS);
  assert.equal(o.result.status, "failed");
  assert.match(o.result.reason, /infra:verify-plan-commit: the program ran on other arguments/);
});

// ---------------------------------------------------------------- 3.1.0 security review: the YAML loaders resist alias amplification

// 9 levels of 10 aliases: 10^9 strings once expanded
const LAUGHS = 'l0: &l0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n' +
  Array.from({ length: 8 }, (_, i) => "l" + (i + 1) + ": &l" + (i + 1) + " [" + Array(10).fill("*l" + i).join(",") + "]\n").join("");
// one 200 KB string, aliased 40 times: the input is small, the values are 8 MB
const BIG = 's: &s "' + "A".repeat(200 * 1024) + '"\n';

test("3.1.0 security review: the fixer loader refuses a billion laughs in args, a non-string entry, and oversized input or output", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const hook = (fields) => "repos:\n  - repo: local\n    hooks:\n      - id: chk\n        name: chk\n" + fields + "        language: system\n";
  const cases = [
    [LAUGHS + hook("        entry: ci/chk.sh\n        args: *l8\n"), /args is not a list of strings/],
    [hook("        entry: ci/chk.sh\n        args: [1, 2]\n"), /args is not a list of strings/],
    [hook("        entry: ci/chk.sh\n        args: --fix\n"), /args is not a list of strings/],
    [hook("        entry: {a: 1}\n"), /not a string/],
    [hook("        entry: ci/chk.sh\n        language: [system]\n").replace("        language: system\n", ""), /not a string/],
    [BIG + "repos:\n  - repo: local\n    hooks:\n" + Array.from({ length: 40 }, (_, i) => "      - {id: h" + i + ", name: h, entry: *s, language: system}\n").join(""), /output over 1 MiB/],
    [hook("        entry: ci/chk.sh\n") + "# " + "x".repeat(300 * 1024) + "\n", /over 256 KiB/],
  ];
  for (const [cfg, re] of cases) {
    const r = fixerRepo("fleet-laughs-fix-", cfg, { "ci/chk.sh": "#!/bin/sh\nexit 0\n", "a.py": "x=1\n" });
    try {
      writeFileSync(join(r.wt, "a.py"), "x=2\n");
      const t0 = process.hrtime.bigint();
      const o = r.runF();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(o.ran, false, cfg.slice(0, 80));
      assert.deepEqual(o.refused, [".pre-commit-config.yaml"]);
      assert.match(o.reason, re, cfg.slice(0, 80));
      assert.ok(ms < 20000, "refused quickly: " + ms + " ms");
      assert.ok(!existsSync(join(r.home, "log")), "no hook ran");
    } finally {
      r.done();
    }
  }
  // the source: no default=str in either loader
  assert.doesNotMatch(SOURCE, /default=str\)\\n"/);
});

// ---------------------------------------------------------------- 3.1.0: every embedded program caps its own memory and CPU

test("3.1.0 caps: every embedded Python program and both YAML loaders set RLIMIT_AS and RLIMIT_CPU first", () => {
  // 4.0.1: the programs are scripts/*.py
  const progs = PROGRAM_BODIES;
  assert.ok(progs.length >= 15, "found " + progs.length);
  for (const [name, body] of progs) {
    // the caps come before anything else runs
    assert.match(body, /^# resource caps \(3\.1\.0\)[^\n]*\n[^\n]*\nimport os as _o, resource as _r\nfor _k, _v in \(\(_r\.RLIMIT_AS, 1 << 30\), \(_r\.RLIMIT_CPU, 300\)\):\n/, name);
  }
  const ph = extractPy("PLAN_HASH_PY_BEGIN", "PLAN_HASH_PY_END", "PLAN_HASH_PY");
  assert.match(ph, /RLIMIT_AS, 1 << 30/);
  assert.ok(ph.indexOf("RLIMIT_AS") < ph.indexOf("import hashlib"), "PLAN_HASH_PY caps first");
  // (3.1.0: CFG_LOADER went with the IaC scan; the other loaders are covered by the LOW caps test)
  for (const n of ["LOADER"]) {
    const m = new RegExp("\\n" + n + " = \\(\\n([\\s\\S]*?)\\n\\)\\n").exec(PROGRAMS_TEXT);
    assert.ok(m, n);
    assert.match(m[1], /resource\.RLIMIT_AS, 1 << 30\), \(resource\.RLIMIT_CPU, 60\)/, n);
    assert.match(m[1], /sys\.stdin\.buffer\.read\(262145\)/, n);
    assert.doesNotMatch(m[1], /default=str/, n);
  }
  // the repo's own hooks are not bound by the fixer's caps
  assert.match(PROGRAMS_TEXT, /\['pre-commit', 'run', '--files'\] \+ files, cwd=scratch, capture_output=True, timeout=tmo, env=dict\(env, PATH=clean_path\(\[wt, scratch_root\]\)\), preexec_fn=lift\)/);
});

test("3.1.0 caps: a program that allocates past its cap dies quickly instead of growing", { skip: !HAVE_PY }, () => {
  const prog = extractPy("PUSH_CLASSIFY_PY_BEGIN", "PUSH_CLASSIFY_PY_END", "PUSH_CLASSIFY_PY");
  const prelude = prog.slice(0, prog.indexOf("import hashlib"));
  const r = spawnSync("python3", ["-I", "-c", prelude + "x = bytearray(3 << 30)\nprint('grew')\n"], { encoding: "utf8", timeout: 60000, maxBuffer: 1 << 20 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MemoryError/);
  assert.doesNotMatch(r.stdout, /grew/);
});

// ---------------------------------------------------------------- 3.1.0 (Max's rule): hook changes are their own PR and need Max

const SEPARATE = /hook changes must be a separate PR \(Max's rule\)/;
const CONFIRM = /hook change needs Max's confirmation/;

test("3.1.0 hooks: a plan scope with the hook config, a workflow or a hook entry file stops at plan time", async () => {
  const cases = [
    // (3.1.0 delta review: the criteria's test files are in the scope, so a hook path makes it mixed)
    [{ files: [".pre-commit-config.yaml"] }, [], [], SEPARATE],
    [{ files: [".pre-commit-config.yaml", "src/a.py"] }, [], [], SEPARATE],
    [{ files: ["src/a.py"] }, [".github/workflows/ci.yml"], [], SEPARATE],
    [{ files: [".gitlab-ci.yml"] }, [], [], SEPARATE],
    [{ files: [".forgejo/workflows/x.yml", "README.md"] }, [], [], SEPARATE],
    // a file a hook entry names (the program's surface)
    [{ files: ["ci/chk.sh"] }, [], ["ci/chk.sh"], SEPARATE],
    // a changed symbol whose caller is in a hook entry file
    [{ files: [] }, [], ["ci/chk.sh"], SEPARATE, [{ symbol: "f", occurrences: [{ at: "ci/chk.sh:3", criterion: "AC1", dont_care: null }] }]],
  ];
  for (const [aa, obFiles, surface, re, symbols] of cases) {
    const s = happy();
    s["role:scope-and-plan"].allowed_additions = Object.assign({ files: [], symbols: [], deps: [], settings: [] }, aa);
    if (obFiles.length) s["role:scope-and-plan"].repo_obligations = [{ id: "OB1", kind: "other", rule_source: "x", files: obFiles, instruction: "x" }];
    if (symbols) {
      s["role:scope-and-plan"].changed_symbols = symbols;
      s["infra:callers"] = callersOut({ f: ["ci/chk.sh:3"] });
    }
    s["infra:hook-surface:plan"] = { status: "ok", reason: "read", surface, error: null };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(aa) + " " + out.result.reason);
    assert.match(out.result.reason, re);
    assert.equal(out.result.stop_gate, "hooks");
    assert.ok(!out.labels.includes("role:plan-audit"), "stops before the audit");
  }
  // code only: the plan goes on
  const ok = await runOne(happy(), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation");
  assert.equal(call(ok, "infra:hook-surface:plan").opts.agentType, "fleet:judge");
});

test("3.1.0 hooks: the approved tree's diff is checked right before the commit; a mixed or hook-only diff stops, even under confirm auto", async () => {
  for (const [changed, re, auto] of [
    [["src/x.py", "ci/chk.sh"], SEPARATE, false],
    [["ci/chk.sh"], CONFIRM, false],
    [["ci/chk.sh"], CONFIRM, true],
    [["src/x.py", "tools/__init__.py"], SEPARATE, false],
  ]) {
    const s = auto ? autoHappy() : happy();
    s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed });
    s["infra:hook-surface:r1"] = { status: "ok", reason: "read", surface: ["ci/chk.sh", "tools/__init__.py", "tools/fmt.py"], error: null };
    const out = auto ? await runOne(s, AUTO) : await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(changed) + " " + out.result.reason);
    assert.match(out.result.reason, re);
    assert.equal(out.result.stop_gate, "hooks");
    assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)), "nothing committed");
  }
  // a code-only diff is committed
  const s = happy();
  s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed: ["src/x.py"] });
  s["infra:hook-surface:r1"] = { status: "ok", reason: "read", surface: ["ci/chk.sh"], error: null };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.labels;
  assert.ok(L.indexOf("infra:hook-surface:r1") > L.indexOf("role:fleet-code-judge:r1") && L.indexOf("infra:hook-surface:r1") < L.indexOf("infra:commit:r1"));
});

test("3.1.0 hooks: a surface that cannot be computed, or a relay that differs from the program, refuses", async () => {
  const s = happy();
  s["infra:hook-surface:plan"] = { status: "ok", reason: "read", surface: [], error: "no Python with PyYAML found" };
  let out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /hook surface cannot be computed \(no Python with PyYAML found\)/);
  assert.equal(out.result.stop_gate, "hooks");
  const t = happy();
  t["infra:hook-surface:plan"] = (prompt) => {
    const r = { status: "ok", reason: "read", surface: ["ci/chk.sh"], make_paths: {}, error: null, args: [inputsOf(prompt).worktree, inputsOf(prompt).rev, JSON.stringify(inputsOf(prompt).targets)] };
    r.digest = relayDigestOf(r, ["surface", "make_paths", "error", "args"]);
    r.surface = [];
    return r;
  };
  out = await runOne(t, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /infra:hook-surface:plan: the relayed surface does not match the program's digest/);
});

test("3.1.0 hooks: the surface program lists hook entries, args and -m modules; no PyYAML or a bomb refuses", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const cfg = "repos:\n- repo: local\n  hooks:\n  - id: a\n    name: a\n    entry: ci/chk.sh\n    args: [tools/gen.py, --fast]\n    language: script\n  - id: b\n    name: b\n    entry: python3 -m pkg.fmt\n    language: system\n";
  const wt = repoWith("fleet-hooksurf-", { ".pre-commit-config.yaml": cfg });
  try {
    const prog = extractPy("HOOK_SURFACE_PY_BEGIN", "HOOK_SURFACE_PY_END", "HOOK_SURFACE_PY");
    const runP = (extra) => {
      const r = spawnSync("python3", ["-I", "-c", prog, wt, "HEAD", "[]"].concat(extra || []), { encoding: "utf8", cwd: wt });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const o = runP();
    assert.equal(o.error, null);
    for (const p of ["ci/chk.sh", "tools/gen.py", "pkg/__init__.py", "pkg/fmt.py"]) assert.ok(o.surface.includes(p), p);
    assert.deepEqual(o.args, [wt, "HEAD", "[]"]);
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    assert.equal(o.digest, sha256(fn({ surface: o.surface, make_paths: o.make_paths, error: o.error, args: o.args, program: o.program })));
    assert.match(runP(["no-yaml"]).error, /no Python with PyYAML/);
    writeFileSync(join(wt, ".pre-commit-config.yaml"), LAUGHS + "repos:\n- repo: local\n  hooks:\n  - id: a\n    entry: x\n    args: *l8\n");
    assert.match(runP().error, /args is not a list of strings/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.1.0 delta review: the 3.0.0 IaC refusals are back

// ---------------------------------------------------------------- 3.1.0 delta review: the hook surface is complete

test("3.1.0 delta review: every CI and hook-manager path, any case, the hooksPath dir and test files are hook surface at plan time", async () => {
  for (const [files, surface, tests] of [
    [[".github/actions/x/action.yml"], [], null],
    [[".gitea/workflows/a.yml"], [], null],
    [[".woodpecker.yml"], [], null],
    [[".woodpecker/build.yml"], [], null],
    [[".circleci/config.yml"], [], null],
    [[".gitlab/ci/x.yml"], [], null],
    [["Jenkinsfile"], [], null],
    [[".buildkite/pipeline.yml"], [], null],
    [["azure-pipelines.yml"], [], null],
    [["bitbucket-pipelines.yml"], [], null],
    [[".husky/pre-commit"], [], null],
    [[".githooks/pre-push"], [], null],
    [["lefthook.yml"], [], null],
    [["atlan" + "tis.yaml"], [], null],
    [["sub/ATLAN" + "TIS.yml"], [], null],
    [[".pre-commit-hooks.yaml"], [], null],
    [[".PRE-COMMIT-CONFIG.YAML"], [], null],
    [[".GitHub/workflows/x.yml"], [], null],
    [["myhooks/pre-commit"], ["myhooks/"], null],
    // a criterion's test file is in the plan scope too
    [[], ["ci/test_hook.sh"], ["ci/test_hook.sh"]],
  ]) {
    const s = happy();
    s["role:scope-and-plan"].allowed_additions = { files, symbols: [], deps: [], settings: [] };
    if (tests) s["role:scope-and-plan"].criteria = [Object.assign({}, s["role:scope-and-plan"].criteria[0], { test_files: tests })];
    s["infra:hook-surface:plan"] = { status: "ok", reason: "read", surface, make_paths: {}, error: null };
    // the only criterion's test files are the hook path itself: hook-only; else mixed with the test files
    if (!tests) s["role:scope-and-plan"].criteria = [Object.assign({}, s["role:scope-and-plan"].criteria[0], { text: "[manual] checked by Max", test_files: [] })];
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(files) + " " + out.result.reason);
    assert.match(out.result.reason, /hook change needs Max's confirmation/, JSON.stringify(files));
    assert.equal(out.result.stop_gate, "hooks");
  }
});

test("3.1.0 delta review: the scope fence refuses a coder's change to a hook manager path", async () => {
  for (const p of [".husky/pre-commit", "lefthook.yml", ".gitlab-ci.yml", "Jenkinsfile", ".circleci/config.yml"]) {
    const s = happy();
    s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed: ["src/x.py", p] });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", p + " " + out.result.reason);
    assert.match(out.result.reason, /hook surface|separate PR/, p);
    assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)), p);
  }
});

test("3.1.0 delta review: F2 also covers the scripts a make check_cmd's recipe runs", async () => {
  const ob = (files) => ({ id: "OB5", kind: "other", rule_source: "Makefile", files: files || ["src/x.py"], instruction: "lint", check_cmd: "make check" });
  for (const [files, changed, converted] of [
    [null, ["scripts/c.py"], true],
    [null, ["bin/v.sh"], true],
    [["src/x.py", "scripts/c.py"], ["scripts/c.py"], false],
    [null, ["scripts/other.py"], false],
  ]) {
    const s = withObligations([ob(files)]);
    s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed });
    s["infra:hook-surface:r1"] = (prompt) => {
      assert.deepEqual(inputsOf(prompt).targets, ["check"]);
      return { status: "ok", reason: "read", surface: [], make_paths: { check: ["bin/v.sh", "scripts/c.py"] }, error: null };
    };
    secondRoundPasses(s, [{ id: "OB5", met: true, evidence: "ok", check_exit: 0 }]);
    s["infra:hook-surface:r2"] = { status: "ok", reason: "read", surface: [], make_paths: { check: ["bin/v.sh", "scripts/c.py"] }, error: null };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", JSON.stringify(changed) + " " + out.result.reason);
    assert.equal(out.result.rounds.code, converted ? 2 : 1, JSON.stringify(changed));
    if (converted) assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((x) => x.finding).join("\n"), new RegExp("OB5: the change edits " + changed[0].replace(/\./g, "\\.") + ", which check_cmd \"make check\" runs"));
  }
});

test("3.1.0 delta review: the surface program follows make, -m forms, symlinks, imports, sourced scripts, CI files and the hooksPath dir", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const cfg =
    "repos:\n- repo: local\n  hooks:\n" +
    "  - {id: a, name: a, entry: make lint, language: system}\n" +
    "  - {id: b, name: b, entry: python3 -Im pkg.tool, language: system}\n" +
    "  - {id: c, name: c, entry: python3 -mpkg2.run, language: system}\n" +
    "  - {id: d, name: d, entry: ci/chk.sh, language: script, args: ['--config=pyproject.toml', '--hook=scripts/h.sh']}\n" +
    "  - {id: e, name: e, entry: python3 tools/gen.py, language: system}\n" +
    "  - {id: f, name: f, entry: python3 broken/bad.py, language: system}\n";
  const files = {
    ".pre-commit-config.yaml": cfg,
    Makefile: "lint:\n\truff .\ncheck:\n\tpython3 scripts/c.py\n\t./bin/v.sh --x\nother:\n\tscripts/no.sh\n",
    "mk/rules.mk": "x:\n\ttrue\n",
    "pkg/__init__.py": "", "pkg/tool.py": "", "pkg2/run.py": "",
    "scripts/real.sh": "#!/bin/sh\n. ci/lib.sh\nsource scripts/env.sh\n",
    "ci/lib.sh": "x=1\n", "scripts/env.sh": "y=1\n", "scripts/h.sh": "#!/bin/sh\n", "pyproject.toml": "[x]\n",
    "tools/gen.py": "from tools import helper\nimport lib.util\nfrom . import sib\n", "tools/helper.py": "", "tools/sib.py": "", "lib/util.py": "",
    "broken/bad.py": "def (:\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n    - run: bash scripts/ci.sh\n    - run: python3 tools/x.py docs/a.md\n",
    "scripts/ci.sh": "#!/bin/sh\n", "tools/x.py": "", "docs/a.md": "x\n",
    "scripts/c.py": "", "bin/v.sh": "#!/bin/sh\n", "scripts/no.sh": "#!/bin/sh\n",
  };
  const wt = repoWith("fleet-hooksurf2-", files);
  try {
    spawnSync("ln", ["-s", "../scripts/real.sh", join(wt, "ci", "chk.sh")]);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "link");
    sh(wt, "git", "config", "core.hooksPath", "myhooks");
    const prog = extractPy("HOOK_SURFACE_PY_BEGIN", "HOOK_SURFACE_PY_END", "HOOK_SURFACE_PY");
    const r = spawnSync("python3", ["-I", "-c", prog, wt, "HEAD", JSON.stringify(["check"])], { encoding: "utf8", cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    for (const p of [
      "Makefile", "mk/rules.mk",
      "pkg/__init__.py", "pkg/tool.py", "pkg/tool/__main__.py", "pkg2/__init__.py", "pkg2/run.py", "pkg2/run/__main__.py",
      "ci/chk.sh", "scripts/real.sh", "ci/lib.sh", "scripts/env.sh", "scripts/h.sh",
      "tools/gen.py", "tools/helper.py", "tools/sib.py", "lib/util.py",
      "broken/",
      "scripts/ci.sh", "tools/x.py",
      "myhooks/",
    ])
      assert.ok(o.surface.includes(p), p + " in " + JSON.stringify(o.surface));
    for (const p of ["pyproject.toml", "docs/a.md", "scripts/no.sh"]) assert.ok(!o.surface.includes(p), p + " not in the surface");
    assert.deepEqual(o.make_paths, { check: ["bin/v.sh", "scripts/c.py"] });
    assert.deepEqual(o.args, [wt, "HEAD", JSON.stringify(["check"])]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.1.0 delta review: LOW items

test("3.1.0 delta review LOW: the caps test covers every embedded YAML loader", () => {
  // 4.0.1: the loaders live in scripts/format_files.py and scripts/hook_surface.py
  const loaders = PROGRAMS_TEXT.match(/\n(?:CFG_)?LOADER = \(\n[\s\S]*?\n\)\n/g) || [];
  assert.equal(loaders.length, 2, "FORMAT_FILES_PY and HOOK_SURFACE_PY each embed one");
  for (const l of loaders) {
    assert.match(l, /resource\.RLIMIT_AS, 1 << 30\), \(resource\.RLIMIT_CPU, 60\)/);
    assert.match(l, /sys\.stdin\.buffer\.read\(262145\)/);
    assert.doesNotMatch(l, /default=str/);
  }
});

test("3.1.0 delta review LOW: a git-lfs batch line next to a declined push is ambiguous, not a hook verdict", { skip: !HAVE_PY }, () => {
  for (const line of ["batch response: Post \"https://github.com/o/r.git/info/lfs/objects/batch\": dial tcp: lookup github.com: no such host", "batch request: missing protocol: \"\"", "LFS: Client error: 500"])
    assert.equal(classifyPush(1, line + "\nerror: failed to push some refs to 'github.com:o/r.git'\n").push_result, "ambiguous", line);
  // a plain hook rejection stays a hook verdict
  assert.equal(classifyPush(1, "version not bumped\nerror: failed to push some refs to 'x'\n").push_result, "hook_rejected");
});

test("3.1.0 delta review LOW: the slug-collision check runs in code on the page's project and tags", async () => {
  for (const [page, ok] of [
    [{ page_project: "o/r", page_tags: ["task-body", "fleet", "ledger-42"] }, true],
    [{ page_project: "o/other", page_tags: ["task-body", "fleet", "ledger-42"] }, false],
    [{ page_project: "o/r", page_tags: ["task-body", "fleet", "ledger-43"] }, false],
    [{ page_project: "o/r" }, false],
    [{}, false],
  ]) {
    const s = noBody({
      "infra:ledger-read:post": (prompt) => ({
        status: "ok",
        reason: "read",
        results: inputsOf(prompt).tasks.map((t) => Object.assign({ key: t.key, status: "ok", title: T42, body_slug: "o_r_task-42", has_marker: true }, page)),
      }),
    });
    const out = await run(s, ARGS);
    assert.equal(out.result.ledger_status, ok ? "ok" : "failed", JSON.stringify(page));
    if (!ok) assert.match(out.result.write_back.ledger[0].reason, /slug collision/);
  }
  assert.match(call(await run(noBody(), ARGS), "infra:ledger-read:post").prompt, /page_project.*page_tags/);
});

test("3.1.0 delta review LOW: fleet:judge denies every remaining yadgar writer", () => {
  const deny = frontmatter("judge.md").disallowedTools.split(/,\s*/);
  for (const t of [
    "add_rule", "anchor_renew", "archive_purge", "backup_restore", "bookmark_add", "bookmark_remove", "bookmark_reorder", "bootstrap_project",
    "checkpoint", "config_delete", "consolidate_now", "de_anchor", "discipline_save", "dlq_dismiss", "dlq_requeue", "install_hooks",
    "project_register", "project_seed", "reembed_all", "seed_agent_prompts", "seed_project", "sync_instructions", "update_active_work",
    "vacuum_checkpoints", "vacuum_now", "wiki_autolink", "wiki_write_task_list", "task_write",
  ])
    assert.ok(deny.includes("mcp__yadgar__" + t), t);
});

// ---------------------------------------------------------------- 3.1.0 security review: the last two findings

test("3.1.0 security review: the hook surface traces hook-manager files and scripts a hook script runs directly", { skip: !HAVE_PY || !HAVE_YAML }, () => {
  const files = {
    ".pre-commit-config.yaml": "repos:\n- repo: local\n  hooks:\n  - {id: a, name: a, entry: scripts/hook.sh, language: script}\n",
    "scripts/hook.sh": "#!/bin/sh\nbash scripts/run2.sh\n./scripts/run3.sh\npython3 tools/p.py\n",
    "scripts/run2.sh": "#!/bin/sh\n", "scripts/run3.sh": "#!/bin/sh\n", "tools/p.py": "",
    ".husky/pre-commit": "npx lint-staged\nbash scripts/hk.sh\n", "scripts/hk.sh": "#!/bin/sh\n",
    ".github/actions/a/action.yml": "runs:\n  using: composite\n  steps:\n  - run: ./scripts/act.sh\n    shell: bash\n", "scripts/act.sh": "#!/bin/sh\n",
    "package.json": JSON.stringify({ scripts: { pre: "node tools/pre.js" } }), "tools/pre.js": "",
    "lefthook.yml": "pre-commit:\n  commands:\n    x:\n      run: python3 tools/lh.py\n", "tools/lh.py": "",
    "myhooks/pre-push": "#!/bin/sh\nsh scripts/pp.sh\n", "scripts/pp.sh": "#!/bin/sh\n",
    "scripts/unrelated.sh": "#!/bin/sh\n",
  };
  const wt = repoWith("fleet-hooksurf3-", files);
  const prog = extractPy("HOOK_SURFACE_PY_BEGIN", "HOOK_SURFACE_PY_END", "HOOK_SURFACE_PY");
  const runP = () => {
    const r = spawnSync("python3", ["-I", "-c", prog, wt, "HEAD", "[]"], { encoding: "utf8", cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  try {
    sh(wt, "git", "config", "core.hooksPath", "myhooks");
    const o = runP();
    assert.equal(o.error, null);
    for (const p of ["scripts/run2.sh", "scripts/run3.sh", "tools/p.py", "scripts/hk.sh", "scripts/act.sh", "tools/pre.js", "tools/lh.py", "scripts/pp.sh"])
      assert.ok(o.surface.includes(p), p + " in " + JSON.stringify(o.surface));
    assert.ok(!o.surface.includes("scripts/unrelated.sh"));
    // a hook-manager file that does not parse fails closed
    writeFileSync(join(wt, "package.json"), "{ not json");
    sh(wt, "git", "commit", "-qam", "broken");
    assert.match(String(runP().error), /package\.json does not parse/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.1.0 security review: everything on a command line is followed; only inert data is a leaf

// ---------------------------------------------------------------- 3.1.0 (Max, 2026-11-09): a PATH check replaces the IaC scan

const TF_TOOLS = ["terra" + "form", "to" + "fu", "t" + "fp", "terra" + "grunt", "dig" + "ger", "atlan" + "tis"];
const NOT_SHIMMED = /terraform tooling on PATH is not shimmed; install the agent PATH shims \(nix\) before using the fleet/;

// a preflight result whose path_check is the program's output for `tools`
function preflightWith(tools, args) {
  const pc = { tools: Object.assign(Object.fromEntries(TF_TOOLS.map((t) => [t, null])), tools || {}), args: args || ["/r"], path_problems: [] };
  pc.digest = sha256(canon(pc));
  return pc;
}

test("3.1.0 PATH check: a real tool on PATH stops preflight in plan and build mode; a shim or no tool passes", async () => {
  const real = { path: "/usr/local/bin/x", real: "/usr/local/bin/x", shim: false };
  const shim = { path: "/home/u/.nix-profile/bin/x", real: "/nix/store/abc-shim/bin/x", shim: true };
  // plan mode
  for (const [tools, stops] of [
    [{}, false],
    [{ [TF_TOOLS[0]]: shim, [TF_TOOLS[2]]: shim }, false],
    [{ [TF_TOOLS[0]]: real }, true],
    [{ [TF_TOOLS[0]]: shim, [TF_TOOLS[4]]: real }, true],
  ]) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { path_check: preflightWith(tools) });
    const out = await runOne(s, ARGS);
    if (stops) {
      assert.equal(out.result.status, "needs_human", JSON.stringify(tools));
      assert.match(out.result.reason, NOT_SHIMMED);
      assert.equal(out.result.stop_gate, "iac");
      assert.deepEqual(out.labels, ["preflight"], "stops before any other step");
    } else assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(tools) + " " + out.result.reason);
  }
  // build mode runs the same check
  const s = happy();
  const ref = await planRefFor(s);
  s.preflight = Object.assign({}, s.preflight, { path_check: preflightWith({ [TF_TOOLS[3]]: real }) });
  const out = await runOne(s, buildArgs(ref));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, NOT_SHIMMED);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("3.1.0 PATH check: a missing, tampered or test-overridden result refuses", async () => {
  for (const [pc, re] of [
    [undefined, /PATH check could not complete/],
    [Object.assign(preflightWith({}), { tools: {} }), /PATH check could not complete/],
    [preflightWith({}, ["/r", "--store-prefix=/tmp/x"]), /PATH check could not complete/],
  ]) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { path_check: pc, __raw_path_check: true });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(pc));
    assert.match(out.result.reason, re);
  }
  const p = call(await runOne(happy(), ARGS), "preflight").prompt;
  // 4.0.0: run from the scripts_dir the same agent found
  assert.ok(p.includes("python3 -I <scripts_dir>/path_check.py '/r'"));
  // the agent's Bash guard blocks the tool names: the prompt never spells them
  assert.doesNotMatch(p, /terraform|tofu|tflint|terragrunt|\btfp\b|digger|atlantis/i);
});

// an absolute python3: the PATH check test runs it with PATH set to a scratch bin dir
const PY3 = rawSpawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();

function shQuoteTest(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

test("3.1.0 PATH check program: resolves each tool on PATH; a shim is a /nix/store file with the marker", { skip: !HAVE_PY }, () => {
  const prog = extractPy("PATH_CHECK_PY_BEGIN", "PATH_CHECK_PY_END", "PATH_CHECK_PY");
  assert.doesNotMatch(prog, /terraform|tofu|tflint|terragrunt|\btfp\b|digger|atlantis/i, "the Bash guard blocks these words");
  const marker = /const FLEET_SHIM_MARKER = "([^"]+)";/.exec(SOURCE);
  assert.ok(marker, "FLEET_SHIM_MARKER");
  assert.equal(marker[1], "fleet-agent-shim: hard-rules");
  assert.ok(prog.includes("MARKER = b'" + marker[1] + "'"), "the program uses the same marker");
  const home = mkdtempSync(join(tmpdir(), "fleet-pathcheck-"));
  try {
    const bin = join(home, "bin");
    const store = join(home, "store") + "/";
    spawnSync("mkdir", ["-p", bin, join(store, "abc-shim", "bin"), join(store, "def-real", "bin")]);
    const mk = (p, text) => writeFileSync(p, text, { mode: 0o755 });
    const run = (extra) => {
      const r = spawnSync(PY3, ["-I", "-c", prog, join(home, "repo")].concat(extra || []), { encoding: "utf8", env: { PATH: bin }, cwd: home, timeout: 60000, maxBuffer: 1 << 20 });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    // nothing on PATH
    let o = run();
    assert.deepEqual(o.tools, Object.fromEntries(TF_TOOLS.map((t) => [t, null])));
    assert.deepEqual(o.args, [join(home, "repo")]);
    assert.deepEqual(o.path_problems, []);
    assert.equal(o.digest, sha256(fn({ tools: o.tools, args: o.args, path_problems: o.path_problems, program: o.program })));
    // a real tool outside the store
    mk(join(bin, TF_TOOLS[0]), "#!/bin/sh\necho real\n");
    o = run(["--store-prefix=" + store]);
    assert.equal(o.tools[TF_TOOLS[0]].shim, false);
    // a store file with the marker, reached through a symlink: a shim
    mk(join(store, "abc-shim", "bin", TF_TOOLS[0]), "#!/bin/sh\n# fleet-agent-shim: hard-rules\nexit 1\n");
    rmSync(join(bin, TF_TOOLS[0]));
    spawnSync("ln", ["-s", join(store, "abc-shim", "bin", TF_TOOLS[0]), join(bin, TF_TOOLS[0])]);
    o = run(["--store-prefix=" + store]);
    assert.equal(o.tools[TF_TOOLS[0]].shim, true);
    assert.equal(o.tools[TF_TOOLS[0]].real, join(store, "abc-shim", "bin", TF_TOOLS[0]));
    // the same file outside the store, or a store file without the marker: not a shim
    o = run();
    assert.equal(o.tools[TF_TOOLS[0]].shim, false, "/nix/store/ is the default prefix");
    mk(join(store, "def-real", "bin", TF_TOOLS[2]), "\x7fELF" + "x".repeat(1000));
    spawnSync("ln", ["-s", join(store, "def-real", "bin", TF_TOOLS[2]), join(bin, TF_TOOLS[2])]);
    o = run(["--store-prefix=" + store]);
    assert.equal(o.tools[TF_TOOLS[2]].shim, false);
    // the caps prelude runs first
    assert.match(prog, /^# resource caps \(3\.1\.0\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.1.0 PATH check: the IaC refusal scan is gone; the fleet may change IaC code", async () => {
  assert.ok(!/IAC_SCAN_PY|iacRefuse|iac-scan/.test(SOURCE), "no IaC scan in the workflow");
  const out = await run(happy(), ARGS);
  assert.ok(!out.labels.some((l) => /iac/.test(l)), out.labels.join(", "));
});

// ---------------------------------------------------------------- 3.1.0 survivor tests (M11c, M20, N7)

test("3.1.0 survivor M11c: a declined-push line with an exit code other than 1 is never hook_rejected", { skip: !HAVE_PY }, () => {
  for (const code of [128, 2, 255]) {
    const o = classifyPush(code, "error: failed to push some refs to 'github.com:o/r.git'\n");
    assert.notEqual(o.push_result, "hook_rejected", String(code));
    assert.equal(o.push_result, "ambiguous", String(code));
  }
});

test("3.1.0 survivor M20: a ledger-writer status other than written fails before the read after the write", async () => {
  for (const status of ["skipped", "error", "ok", "WRITTEN"]) {
    const out = await run(noBody({ "infra:ledger-body": (prompt) => ({ status: "ok", reason: "x", results: inputsOf(prompt).tasks.map((t) => ({ key: t.key, status })) }) }), ARGS);
    assert.equal(out.result.ledger_status, "failed", status);
    assert.equal(out.result.write_back.ledger[0].status, "failed", status);
    assert.match(out.result.write_back.ledger[0].reason, new RegExp("^write: " + status), status);
    assert.ok(!out.labels.includes("infra:ledger-read:post"), status + ": no read after a write that did not happen");
  }
});

test("3.1.0 survivor N7: a script a hook's args name is hook surface; editing it is refused", { skip: !HAVE_PY || !HAVE_YAML }, async () => {
  const wt = repoWith("fleet-n7-", {
    ".pre-commit-config.yaml": "repos:\n- repo: local\n  hooks:\n  - id: a\n    name: a\n    entry: bash\n    args: [scripts/x.sh, --fast]\n    language: system\n",
    "scripts/x.sh": "#!/bin/sh\nexit 0\n",
    "src/a.py": "x = 1\n",
  });
  let surface;
  try {
    const prog = extractPy("HOOK_SURFACE_PY_BEGIN", "HOOK_SURFACE_PY_END", "HOOK_SURFACE_PY");
    const r = spawnSync("python3", ["-I", "-c", prog, wt, "HEAD", "[]"], { encoding: "utf8", cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null);
    surface = o.surface;
    assert.ok(surface.includes("scripts/x.sh"), JSON.stringify(surface));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
  for (const [changed, re] of [
    [["scripts/x.sh"], /hook change needs Max's confirmation: .* touches scripts\/x\.sh/],
    [["src/a.py", "scripts/x.sh"], /hook changes must be a separate PR \(Max's rule\)/],
  ]) {
    const s = happy();
    s["hasher:post-coder:r1"] = Object.assign({}, s["hasher:post-coder:r1"], { changed });
    s["infra:hook-surface:r1"] = { status: "ok", reason: "read", surface, make_paths: {}, error: null };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(changed));
    assert.match(out.result.reason, re);
    assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)));
  }
});

// ---------------------------------------------------------------- 3.1.0 security review: the PATH check matches the agent's shell

test("3.1.0 PATH review: the program refuses an empty, relative or in-repo PATH entry; it gets the repo as its argument", { skip: !HAVE_PY }, () => {
  const prog = extractPy("PATH_CHECK_PY_BEGIN", "PATH_CHECK_PY_END", "PATH_CHECK_PY");
  const home = mkdtempSync(join(tmpdir(), "fleet-pathcheck2-"));
  try {
    const repo = join(home, "repo");
    const bin = join(home, "bin");
    spawnSync("mkdir", ["-p", join(repo, "bin"), join(repo, ".claude", "worktrees", "fleet-x", "scratch"), bin]);
    const run = (path) => {
      const r = spawnSync(PY3, ["-I", "-c", prog, repo], { encoding: "utf8", env: { PATH: path }, cwd: home, timeout: 60000, maxBuffer: 1 << 20 });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(run(bin).path_problems, []);
    assert.deepEqual(run(bin).args, [repo]);
    for (const [path, re] of [
      [bin + "::/usr/bin", /empty PATH entry/],
      [".:" + bin, /relative PATH entry "\."/],
      ["bin:" + bin, /relative PATH entry "bin"/],
      [bin + ":", /empty PATH entry/],
      [join(repo, "bin") + ":" + bin, /PATH entry .* is inside the repo/],
      [join(repo, ".claude", "worktrees", "fleet-x", "scratch") + ":" + bin, /inside the repo/],
    ])
      assert.match(run(path).path_problems.join("; "), re, path);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.1.0 PATH review: the workflow refuses PATH problems, a wrong repo argument, wrong tool keys or a malformed entry", async () => {
  const base = (over) => {
    const pc = Object.assign({ tools: Object.fromEntries(TF_TOOLS.map((t) => [t, null])), args: ["/r"], path_problems: [] }, over);
    if (!("digest" in pc)) pc.digest = sha256(canon(pc));
    return pc;
  };
  const shim = { path: "/home/u/.nix-profile/bin/x", real: "/nix/store/abc/bin/x", shim: true };
  for (const [pc, re] of [
    [base({ path_problems: ['relative PATH entry "."'] }), /PATH has entries the agent shell resolves differently: relative PATH entry "\."/],
    [base({ args: ["/other"] }), /could not complete/],
    [base({ args: [] }), /could not complete/],
    // the exact key set, not just the count
    [base({ tools: Object.assign(Object.fromEntries(TF_TOOLS.slice(1).map((t) => [t, null])), { other: null }) }), /could not complete/],
    // entry shapes
    [base({ tools: Object.assign(Object.fromEntries(TF_TOOLS.map((t) => [t, null])), { [TF_TOOLS[0]]: { path: "/x", real: "/x", shim: "true" } }) }), /not shimmed/],
    [base({ tools: Object.assign(Object.fromEntries(TF_TOOLS.map((t) => [t, null])), { [TF_TOOLS[0]]: { path: "bin/x", real: "/nix/store/a/x", shim: true } }) }), /could not complete/],
    [base({ tools: Object.assign(Object.fromEntries(TF_TOOLS.map((t) => [t, null])), { [TF_TOOLS[0]]: { real: "/nix/store/a/x", shim: true } }) }), /could not complete/],
    [base({ tools: Object.assign(Object.fromEntries(TF_TOOLS.map((t) => [t, null])), { [TF_TOOLS[0]]: "x" }) }), /could not complete/],
  ]) {
    const s = happy();
    s.preflight = Object.assign({}, s.preflight, { path_check: pc });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(pc));
    assert.match(out.result.reason, re, JSON.stringify(pc));
    assert.deepEqual(out.labels, ["preflight"]);
  }
  // a well-formed shim passes; the preflight prompt passes the repo to the program
  const s = happy();
  s.preflight = Object.assign({}, s.preflight, { path_check: base({ tools: Object.assign(Object.fromEntries(TF_TOOLS.map((t) => [t, null])), { [TF_TOOLS[0]]: shim }) }) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.match(call(out, "preflight").prompt, /path_check\.py '\/r'\n/);
});

test("3.1.0 PATH review: every embedded program drops empty, relative and in-worktree PATH entries for its children", { skip: !HAVE_PY }, () => {
  const prog = extractPy("PUSH_CLASSIFY_PY_BEGIN", "PUSH_CLASSIFY_PY_END", "PUSH_CLASSIFY_PY");
  const prelude = prog.slice(0, prog.indexOf("import hashlib"));
  const r = spawnSync(PY3, ["-I", "-c", prelude + "import os\nprint(os.environ['PATH'])\nprint(_RAW_PATH)\n"], { encoding: "utf8", env: { PATH: ".::bin:/usr/bin:" }, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["/usr/bin", ".::bin:/usr/bin:"]);
  // the fixer hands pre-commit a PATH without the worktree's own dirs
  assert.match(extractPy("FORMAT_FILES_PY_BEGIN", "FORMAT_FILES_PY_END", "FORMAT_FILES_PY"), /PATH=clean_path\(\[wt, scratch_root\]\)/);
});

test("3.1.0 PATH check: the tool set is the six shimmed names; a shim is matched by the marker substring, comment prefix optional", { skip: !HAVE_PY }, () => {
  assert.deepEqual(TF_TOOLS.length, 6);
  const prog = extractPy("PATH_CHECK_PY_BEGIN", "PATH_CHECK_PY_END", "PATH_CHECK_PY");
  assert.ok(prog.includes("'atlan' + 'tis'"), "atlantis is checked");
  const home = mkdtempSync(join(tmpdir(), "fleet-pathcheck3-"));
  try {
    const bin = join(home, "bin");
    const store = join(home, "store") + "/";
    spawnSync("mkdir", ["-p", bin, join(store, "s", "bin")]);
    const at = TF_TOOLS[5];
    for (const [text, shim] of [["#!/bin/sh\n# fleet-agent-shim: hard-rules\nexit 1\n", true], ["#!/bin/sh\necho 'fleet-agent-shim: hard-rules'\n", true], ["#!/bin/sh\n# fleet-agent-shim: soft\n", false]]) {
      writeFileSync(join(store, "s", "bin", at), text, { mode: 0o755 });
      rmSync(join(bin, at), { force: true });
      spawnSync("ln", ["-s", join(store, "s", "bin", at), join(bin, at)]);
      const r = spawnSync(PY3, ["-I", "-c", prog, join(home, "repo"), "--store-prefix=" + store], { encoding: "utf8", env: { PATH: bin }, cwd: home, timeout: 60000 });
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(o.tools).sort(), TF_TOOLS.slice().sort());
      assert.equal(o.tools[at].shim, shim, text);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.1.0 (ADR-1172): IaC paths are fleet work; IaC diffs never push automatically (ADR-1175)

// file names spelled in pieces: the agent's Bash guard blocks the tool words
const TFW = "terra" + "form";
const LOCK = "." + TFW + ".lock.hcl";
const TG = "terra" + "grunt.hcl";
const DG = "dig" + "ger.yml";

// The sealed URL the tests pass, and a global git config (the user's own,
// outside the threat model) that maps it to the test origin.
const TEST_URL = "https://example.invalid/o/r.git";
function testGitEnv(home) {
  const cfg = join(home, "global.gitconfig");
  writeFileSync(cfg, "[url \"" + join(home, "origin.git") + "\"]\n\tinsteadOf = " + TEST_URL + "\n[protocol \"file\"]\n\tallow = always\n");
  return Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: cfg });
}
function markerScript(home, name) {
  const marker = join(home, name + ".ran");
  const script = join(home, name + ".sh");
  writeFileSync(script, "#!/bin/sh\ntouch " + JSON.stringify(marker) + "\nexit 1\n");
  spawnSync("chmod", ["+x", script]);
  return { script, marker };
}

function tfGateRun(base, change, del, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "fleet-tfgate-"));
  const wt = join(home, "repo");
  try {
    spawnSync("git", ["init", "-q", "-b", "master", wt]);
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
    const put = (files) => {
      for (const [p, c] of Object.entries(files)) {
        spawnSync("mkdir", ["-p", dirname(join(wt, p))]);
        if (c && typeof c === "object") symlinkSync(c.link, join(wt, p));
        else writeFileSync(join(wt, p), c);
      }
    };
    put(Object.assign({ "README.md": "x\n" }, base));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    if (!opts.noRemote) {
      // the program reads origin's default head itself (git ls-remote), never the local ref
      const bare = join(home, "origin.git");
      spawnSync("git", ["init", "-q", "--bare", bare]);
      sh(wt, "git", "remote", "add", "origin", bare);
      sh(wt, "git", "push", "-q", "origin", "HEAD:refs/heads/master");
    }
    sh(wt, "git", "update-ref", "refs/remotes/origin/master", "HEAD");
    put(change);
    for (const p of del || []) rmSync(join(wt, p));
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "change");
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    // a role's shell moves the local origin ref onto the branch head
    if (opts.moveLocal) sh(wt, "git", "update-ref", "refs/remotes/origin/master", head);
    if (opts.advance) {
      // origin's default moves on with a commit the local repo does not have
      const c = join(home, "other");
      spawnSync("git", ["clone", "-q", join(home, "origin.git"), c]);
      for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(c, "git", "config", k, v);
      writeFileSync(join(c, "later.txt"), "x\n");
      sh(c, "git", "add", "-A");
      sh(c, "git", "commit", "-qm", "later");
      sh(c, "git", "push", "-q", "origin", "HEAD:refs/heads/master");
    }
    // a role edits the repo config: none of it may reach the program's git
    for (const [k, v] of opts.repoConfig || []) sh(wt, "git", "config", k, v);
    if (opts.evil) {
      // a decoy origin whose default is the branch head (an empty diff if used)
      const evil = join(home, "evil.git");
      spawnSync("git", ["init", "-q", "--bare", evil]);
      sh(wt, "git", "push", "-q", evil, "HEAD:refs/heads/master");
      sh(wt, "git", "config", "url." + evil + ".insteadOf", "https://example.invalid/");
    }
    const prog = extractPy("TF_GATE_PY_BEGIN", "TF_GATE_PY_END", "TF_GATE_PY");
    const r = spawnSync("python3", ["-I", "-c", prog, wt, "master", head, opts.url || TEST_URL], { encoding: "utf8", cwd: home, env: testGitEnv(home) });
    if (opts.raw) return r;
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const MAIN = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n';
const PROV = TFW + ' {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n';

test("3.1.0 IaC push gate: a plain resource or variable change gives no hint and lists its IaC files; no IaC file is not touched", { skip: !HAVE_PY }, () => {
  let o = tfGateRun({ "infra/main.tf": MAIN, "infra/versions.tf": PROV }, { "infra/main.tf": MAIN.replace('"x"', '"y"'), "infra/vars.tf": 'variable "n" {\n  type = string\n}\n', "env/prod.tfvars": 'n = "a"\n' });
  assert.equal(o.touched, true);
  assert.deepEqual(o.iac_files, ["env/prod.tfvars", "infra/main.tf", "infra/vars.tf"]);
  assert.deepEqual([o.hints, o.hints], [[], []]);
  o = tfGateRun({}, { "src/a.py": "x = 1\n" });
  assert.deepEqual([o.touched, o.iac_files, o.hints, o.hints], [false, [], [], []]);
  // fmt only (a realigned and reindented provider block) passes
  o = tfGateRun({ "infra/versions.tf": PROV }, { "infra/versions.tf": PROV.replace('source  = "hashicorp/aws"', 'source = "hashicorp/aws"').replace("    aws = {", "  aws = {") });
  assert.deepEqual(o.hints, []);
  const prog = extractPy("TF_GATE_PY_BEGIN", "TF_GATE_PY_END", "TF_GATE_PY");
  assert.doesNotMatch(prog, /terraform|tofu|tflint|terragrunt|\btfp\b|digger|atlantis/i, "the Bash guard blocks these words");
  assert.match(prog, /^# resource caps \(3\.1\.0\)/);
});

test("3.1.0 IaC pre-push gate hint 1: external data, provisioners, local/remote exec, dev overrides and CLI config are hinted", { skip: !HAVE_PY }, () => {
  for (const [change, re] of [
    [{ "infra/x.tf": 'data "external" "e" {\n  program = ["sh"]\n}\n' }, /data "external"/],
    [{ "infra/x.tf": MAIN.replace("}\n", '  provisioner "local-exec" {\n    command = "id"\n  }\n}\n') }, /provisioner|local-exec/],
    [{ "infra/x.tf": 'resource "null_x" "r" {\n  connection {}\n  # remote-exec\n}\n' }, /remote-exec|null_/],
    [{ "infra/x.tf.json": '{"provisioner": {"local-exec": {}}}\n' }, /provisioner|local-exec/],
    [{ "cli.tfrc": "provider_installation {\n  dev_overrides {}\n}\n" }, /dev_overrides|provider_installation|CLI config/],
    [{ ["." + TFW + "rc"]: "plugin_cache_dir = \"/x\"\n" }, /CLI config/],
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, change);
    assert.equal(o.touched, true, JSON.stringify(change));
    assert.match(o.hints.join("; "), re, JSON.stringify(change));
  }
});

test("3.1.0 IaC pre-push gate hint 2: a provider source or version change, or a lock file change, is hinted", { skip: !HAVE_PY }, () => {
  for (const [base, change, del] of [
    [{ "infra/versions.tf": PROV }, { "infra/versions.tf": PROV.replace("~> 5.0", "~> 6.0") }],
    [{ "infra/versions.tf": PROV }, { "infra/versions.tf": PROV.replace('"hashicorp/aws"', '"evil/aws"') }],
    [{ "infra/main.tf": MAIN }, { "infra/versions.tf": PROV }],
    [{ "infra/main.tf": MAIN, ["infra/" + LOCK]: "provider x {}\n" }, { ["infra/" + LOCK]: "provider y {}\n" }],
    [{ "infra/main.tf": MAIN, ["infra/" + LOCK]: "provider x {}\n" }, {}, ["infra/" + LOCK]],
  ]) {
    const o = tfGateRun(base, change, del);
    assert.match(o.hints.join("; "), /provider|lock/, JSON.stringify([change, del]));
  }
});

test("3.1.0 IaC pre-push gate hint 3: the external, local and null providers or local_/null_ resources are hinted", { skip: !HAVE_PY }, () => {
  for (const change of [
    { "infra/p.tf": 'provider "local" {}\n' },
    { "infra/p.tf": 'x = "hashicorp/null"\n' },
    { "infra/r.tf": 'resource "local_file" "f" {\n  filename = "a"\n}\n' },
    { "infra/r.tf": 'resource "null_resource" "n" {}\n' },
    { "infra/r.tf": 'data "local_file" "f" {\n  filename = "a"\n}\n' },
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, change);
    assert.match(o.hints.join("; "), /external, local or null|local_|null_/, JSON.stringify(change));
  }
  // removing one is hinted too
  const o = tfGateRun({ "infra/main.tf": MAIN, "infra/r.tf": 'resource "null_resource" "n" {}\n' }, {}, ["infra/r.tf"]);
  assert.match(o.hints.join("; "), /null_/);
});

test("3.1.0 IaC pre-push gate hint 4 and 5: any digger config change, or a CI file next to IaC, is hinted", { skip: !HAVE_PY }, () => {
  let o = tfGateRun({ "infra/main.tf": MAIN, [DG]: "projects: []\n" }, { [DG]: "projects:\n- name: a\n  dir: infra\n" });
  assert.match(o.hints.join("; "), /config change/);
  o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/main.tf": MAIN.replace('"x"', '"y"'), ".github/workflows/plan.yml": "on: push\n" });
  assert.match(o.hints.join("; "), /CI/);
  o = tfGateRun({ "live/main.tf": MAIN }, { ["live/" + TG]: "inputs = {}\n" });
  assert.equal(o.touched, true);
  assert.deepEqual(o.hints, []);
});

// ADR-1175: every IaC diff stops before the push; content checks are hints only
const gateFor = (over) => (prompt) => {
  const i = inputsOf(prompt);
  return tfGateRelay(Object.assign({ args: [i.main_worktree, i.default_branch, i.approved_sha, i.remote_url] }, over));
};

test("3.1.0 IaC push gate: a plain .tf change stops at iac-push before the push, under confirm ask and auto; the stop names branch, sha, files and the push command", async () => {
  for (const [mk, args, go] of [[() => happy(), ARGS, run], [() => autoHappy(), AUTO, runOne]]) {
    const s = mk();
    let seen = null;
    s["infra:tf-gate:push"] = (prompt) => {
      seen = inputsOf(prompt);
      return gateFor({ touched: true, iac_files: ["infra/main.tf"] })(prompt);
    };
    const out = await go(s, args);
    assert.equal(out.result.status, "needs_human", args.confirm + " " + out.result.reason);
    assert.equal(out.result.stop_gate, "iac-push");
    assert.ok(!out.labels.includes("infra:push"), "nothing pushed");
    const r = out.result.reason;
    assert.match(r, /never push(es)? automatically/);
    assert.ok(r.includes(seen.approved_sha), r);
    assert.match(r, /fleet\/l42-[a-z0-9-]+/);
    assert.match(r, /infra\/main\.tf/);
    assert.match(r, /git -C \S+ push -u origin fleet\/l42-[a-z0-9-]+/);
    assert.match(r, /hints \(not a security check\): none/);
  }
});

test("3.1.0 IaC push gate: a non-IaC diff pushes", async () => {
  const s = happy();
  s["infra:tf-gate:push"] = gateFor({});
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.indexOf("infra:tf-gate:push") < out.labels.indexOf("infra:push"));
});

test("3.1.0 IaC push gate: the hints appear in the stop message", async () => {
  const s = happy();
  s["infra:tf-gate:push"] = gateFor({ touched: true, iac_files: ["infra/x.tf"], hints: ["added provisioner in infra/x.tf", "provider source or version change in infra/v.tf"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push");
  assert.match(out.result.reason, /hints \(not a security check\): added provisioner in infra\/x\.tf; provider source or version change in infra\/v\.tf/);
});

test("3.1.0 IaC push gate: the content checks never let an IaC diff through", { skip: !HAVE_PY }, async () => {
  // the program: any IaC file is touched and listed, whatever the hints say
  for (const change of [
    { "infra/main.tf": MAIN.replace('"x"', '"y"') },
    { "env/prod.tfvars": 'n = "a"\n' },
    { ["infra/" + LOCK]: "provider y {}\n" },
    { "infra/x.tf.json": '{"resource": {"aws_s3_bucket": {"b": {}}}}\n' },
    { "infra/x.tf.json": "{ not json" },
    { ["live/" + TG]: "inputs = {}\n" },
    { [DG]: "projects: []\n" },
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, change);
    assert.equal(o.touched, true, JSON.stringify(change));
    assert.deepEqual(o.iac_files, Object.keys(change).sort(), JSON.stringify(change));
  }
  // the workflow: a touched diff with no hint and no problem still stops
  let s = happy();
  s["infra:tf-gate:push"] = gateFor({ touched: true, iac_files: ["infra/main.tf"] });
  let out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push");
  // a relay that says untouched while the fleet scan's diff carries an IaC file stops
  s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: ["src/x.py", "infra/main.tf"], commits: [] } } });
  s["infra:tf-gate:push"] = gateFor({});
  out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /could not complete/);
  // touched without files, or files without touched, stops
  for (const over of [{ touched: true }, { iac_files: ["infra/main.tf"] }]) {
    s = happy();
    s["infra:tf-gate:push"] = gateFor(over);
    out = await run(s, ARGS);
    assert.equal(out.result.stop_gate, "iac", JSON.stringify(over));
  }
  // a tampered relay stops
  s = happy();
  s["infra:tf-gate:push"] = (prompt) => Object.assign(gateFor({ touched: true, iac_files: ["infra/main.tf"] })(prompt), { touched: false, iac_files: [] });
  out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /could not complete/);
  // no code path reports an IaC diff as passing
  assert.doesNotMatch(SOURCE, /meets the CI auto-plan/);
});

// ADR-1175: after Max pushes an IaC diff himself, a build run of the same plan
// continues to the PR without pushing, only when the remote head is exactly the approved sha
function iacScript(mk, head) {
  const s = mk();
  let sha = null;
  s["infra:tf-gate:push"] = (prompt) => {
    sha = inputsOf(prompt).approved_sha;
    return gateFor({ touched: true, iac_files: ["infra/main.tf"] })(prompt);
  };
  s["infra:remote-head:push"] = (prompt) => {
    const i = inputsOf(prompt);
    const r = { status: "ok", reason: "read", head: head === "approved" ? sha : head, args: [i.main_worktree, i.branch, i.remote_url] };
    r.digest = sha256(canon({ head: r.head, args: r.args }));
    return r;
  };
  return s;
}
const MODES = [[() => happy(), ARGS, run], [() => autoHappy(), AUTO, runOne]];
const pushed = (out) => out.labels.some((l) => /^infra:push(:p\d+)?$/.test(l));

test("3.1.0 ADR-1175: remote head == approved sha: the run continues to the PR, the review and the write-back without a push", async () => {
  for (const [mk, args, go] of MODES) {
    const out = await go(iacScript(mk, "approved"), args);
    assert.equal(out.result.status, "ok", args.confirm + " " + out.result.reason);
    assert.ok(!pushed(out), "push never dispatched");
    assert.ok(out.labels.includes("infra:remote-head:push"));
    assert.ok(out.labels.indexOf("infra:remote-head:push") < out.labels.indexOf("role:fleet-pr-opener"));
    assert.ok(out.labels.some((l) => /^infra:state:pushed/.test(l)));
  }
});

test("3.1.0 ADR-1175: remote head missing, different or unreadable stops at iac-push", async () => {
  for (const head of [null, "f".repeat(40), "approved-but-short"]) {
    const out = await run(iacScript(() => happy(), head === "approved-but-short" ? "abc" : head), ARGS);
    assert.equal(out.result.status, "needs_human", String(head));
    assert.equal(out.result.stop_gate, "iac-push", String(head));
    assert.match(out.result.reason, /re-run the build/);
    assert.ok(!pushed(out));
    assert.ok(!out.labels.includes("role:fleet-pr-opener"));
  }
  // a tampered remote-head relay stops too
  const s = iacScript(() => happy(), "approved");
  const inner = s["infra:remote-head:push"];
  s["infra:remote-head:push"] = (prompt) => Object.assign(inner(prompt), { args: ["/elsewhere", "x"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push");
  assert.ok(!pushed(out));
});

test("3.1.0 ADR-1175: the remote head program reads origin's branch head, null when absent, and refuses a bad branch name", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-rh-"));
  try {
    const bare = join(home, "origin.git");
    const wt = join(home, "repo");
    spawnSync("git", ["init", "-q", "--bare", bare]);
    spawnSync("git", ["init", "-q", "-b", "master", wt]);
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
    writeFileSync(join(wt, "a.txt"), "x\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "a");
    sh(wt, "git", "remote", "add", "origin", bare);
    sh(wt, "git", "push", "-q", "origin", "HEAD:refs/heads/fleet/l42-x");
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    // a role's repo config edits: a marker sshCommand and uploadpack, and an insteadOf decoy
    const m1 = markerScript(home, "ssh");
    const m2 = markerScript(home, "upload");
    const evil = join(home, "evil.git");
    spawnSync("git", ["init", "-q", "--bare", evil]);
    sh(wt, "git", "config", "core.sshCommand", m1.script);
    sh(wt, "git", "config", "remote.origin.uploadpack", m2.script);
    sh(wt, "git", "config", "url." + evil + ".insteadOf", "https://example.invalid/");
    const prog = extractPy("REMOTE_HEAD_PY_BEGIN", "REMOTE_HEAD_PY_END", "REMOTE_HEAD_PY");
    const env = testGitEnv(home);
    const go = (branch, url) => spawnSync("python3", ["-I", "-c", prog, wt, branch, url || TEST_URL], { encoding: "utf8", cwd: home, env });
    let r = go("fleet/l42-x");
    assert.equal(r.status, 0, r.stderr);
    let o = JSON.parse(r.stdout);
    assert.equal(o.head, head, "the decoy origin was not used");
    assert.deepEqual(o.args, [wt, "fleet/l42-x", TEST_URL]);
    assert.ok(!existsSync(m1.marker) && !existsSync(m2.marker), "no repo-config command ran");
    for (const bad of [bare, "file://" + bare, "ext::sh -c x", "-u", "ssh://h/x"]) assert.notEqual(go("fleet/l42-x", bad).status, 0, bad);
    assert.equal(o.digest, sha256(canon({ head: o.head, args: o.args, program: o.program })));
    o = JSON.parse(go("fleet/l42-gone").stdout);
    assert.equal(o.head, null);
    assert.notEqual(go("--upload-pack=x").status, 0);
    assert.doesNotMatch(prog, /terraform|tofu|digger|atlantis/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.1.0 ADR-1175: the fleet never dispatches a push for an IaC diff, in any mode or remote state", async () => {
  for (const [mk, args, go] of MODES)
    for (const head of [null, "f".repeat(40), "approved"]) {
      const out = await go(iacScript(mk, head), args);
      assert.ok(!pushed(out), args.confirm + " " + String(head));
      assert.ok(!out.calls.some((c) => /push -u origin/.test(c.prompt) && !/To push it yourself/.test(c.prompt) && /^infra:push/.test(c.label || "")));
    }
});

// ---------------------------------------------------------------- 3.1.0 final review of PR #38
const AT = "atlan" + "tis";
const TOFU = "to" + "fu";
// every IaC name the final review added, in Python (iac) and JS (isIacPath), any case
const IAC_ADDED = [
  ["root.hcl", 'locals {\n  x = run_cmd("id")\n}\n'],
  ["live/ROOT.HCL", "locals {}\n"],
  [AT + ".yaml", "version: 3\n"],
  [AT + ".yml", "version: 3\n"],
  ["Ops/" + AT.toUpperCase() + ".YAML", "version: 3\n"],
  ["backend/prod.tfbackend", 'bucket = "b"\n'],
  ["." + TFW + "-version", "1.9.0\n"],
  [".open" + TOFU + "-version", "1.8.0\n"],
  ["." + TOFU + "-version", "1.8.0\n"],
  [".spacelift/config.yml", "version: 1\n"],
  ["stacks/.SPACELIFT/hooks.yml", "x: 1\n"],
  ["terra" + "grunt.hcl.json", "{}\n"],
  ["live/env.hcl.json", "{}\n"],
  ["infra/MAIN.TF", "locals {}\n"],
];
for (const [p, body] of IAC_ADDED) {
  test("3.1.0 final review HIGH (python): " + p + " is an IaC file", { skip: !HAVE_PY }, () => {
    const o = tfGateRun({}, { [p]: body });
    assert.equal(o.touched, true, p);
    assert.deepEqual(o.iac_files, [p]);
  });
  test("3.1.0 final review HIGH (js): " + p + " in the fleet scan's diff must be in the relay's IaC files", async () => {
    const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: ["src/x.py", p], commits: [] } } });
    s["infra:tf-gate:push"] = gateFor({});
    const out = await run(s, ARGS);
    assert.equal(out.result.stop_gate, "iac", p);
    assert.match(out.result.reason, /could not complete/);
    assert.ok(!pushed(out));
  });
}

test("3.1.0 final review HIGH PoC: root.hcl with run_cmd plus the orchestrator yaml is touched and never pushes", { skip: !HAVE_PY }, async () => {
  const change = { "root.hcl": 'locals {\n  x = run_cmd("id")\n}\n', [AT + ".yaml"]: "version: 3\n" };
  const o = tfGateRun({}, change);
  assert.equal(o.touched, true);
  assert.deepEqual(o.iac_files, [AT + ".yaml", "root.hcl"]);
  const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: Object.keys(change), commits: [] } } });
  s["infra:tf-gate:push"] = gateFor({ touched: true, iac_files: o.iac_files });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push");
  assert.ok(!pushed(out));
});

test("3.1.0 final review MED: a moved local origin ref does not empty the diff; the base comes from origin itself", { skip: !HAVE_PY }, () => {
  const o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/main.tf": MAIN.replace('"x"', '"y"') }, [], { moveLocal: true });
  assert.equal(o.touched, true);
  assert.deepEqual(o.iac_files, ["infra/main.tf"]);
});

test("3.1.0 final review MED: origin's default ahead with a commit the repo lacks is fetched; the diff stays the branch's own", { skip: !HAVE_PY }, () => {
  const o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/main.tf": MAIN.replace('"x"', '"y"') }, [], { advance: true });
  assert.deepEqual(o.iac_files, ["infra/main.tf"]);
  const p = tfGateRun({}, { "src/a.py": "x = 1\n" }, [], { advance: true });
  assert.deepEqual([p.touched, p.iac_files], [false, []]);
});

test("3.1.0 final review MED: no readable origin refuses (fail closed)", { skip: !HAVE_PY }, () => {
  const r = tfGateRun({ "infra/main.tf": MAIN }, { "src/a.py": "x = 1\n" }, [], { noRemote: true, raw: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
});

test("3.1.0 URL review: the gate's network git ignores a repo config sshCommand, uploadpack and insteadOf", { skip: !HAVE_PY }, () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-urlrev-"));
  try {
    const m1 = markerScript(home, "ssh");
    const m2 = markerScript(home, "upload");
    const o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/main.tf": MAIN.replace('"x"', '"y"') }, [], {
      moveLocal: true,
      advance: true,
      evil: true,
      repoConfig: [["core.sshCommand", m1.script], ["remote.origin.uploadpack", m2.script], ["credential.helper", "!" + m1.script]],
    });
    assert.deepEqual(o.iac_files, ["infra/main.tf"], "the decoy origin was not used");
    assert.deepEqual(o.args.slice(3), [TEST_URL]);
    assert.ok(!existsSync(m1.marker), "sshCommand or helper never ran");
    assert.ok(!existsSync(m2.marker), "uploadpack never ran");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("3.1.0 URL review: the gate refuses a URL that is not https or git@host:", { skip: !HAVE_PY }, () => {
  for (const url of ["/srv/o.git", "file:///srv/o.git", "ext::sh -c id", "--upload-pack=x", "ssh://h/o.git", "https://h/o.git x"]) {
    const r = tfGateRun({ "infra/main.tf": MAIN }, { "src/a.py": "x = 1\n" }, [], { url, raw: true });
    assert.notEqual(r.status, 0, url);
  }
});

test("3.1.0 URL review: the plan seals origin's URL; no sealed URL, or a URL changed since the plan, stops the push gate", async () => {
  // sealed and used
  let s = happy();
  let seen = null;
  s["infra:tf-gate:push"] = (prompt) => {
    seen = inputsOf(prompt);
    return gateFor({})(prompt);
  };
  let out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(seen.remote_url, "git@github.com:o/r.git");
  assert.ok(call(out, "infra:tf-gate:push").prompt.includes("'" + "git@github.com:o/r.git" + "'"));
  // a URL that is not https or git@host: is never sealed
  for (const bad of ["/srv/o.git", "github-personal:o/r.git", "ext::sh -c id"]) {
    s = happy();
    s.workspace = Object.assign({}, s.workspace, { remote_url: bad });
    out = await run(s, ARGS);
    assert.equal(out.result.stop_gate, "iac", bad);
    assert.match(out.result.reason, /no sealed origin URL/, bad);
    assert.ok(!pushed(out));
  }
  // the URL changed between the plan and the build
  s = happy();
  let n = 0;
  const ws = s.workspace;
  s.workspace = () => Object.assign({}, ws, { remote_url: n++ === 0 ? "git@github.com:o/r.git" : "git@evil.example:o/r.git" });
  out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /URL changed since the plan/);
  assert.ok(!pushed(out));
});

test("3.1.0 final review P7: a remote-head relay with other args (digest recomputed) stops at iac-push", async () => {
  const s = iacScript(() => happy(), "approved");
  const inner = s["infra:remote-head:push"];
  s["infra:remote-head:push"] = (prompt) => {
    const r = inner(prompt);
    r.args = [r.args[0], "fleet/other", r.args[2]];
    r.digest = sha256(canon({ head: r.head, args: r.args }));
    return r;
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push");
  assert.match(out.result.reason, /could not be read/);
  assert.ok(!pushed(out));
});

test("3.1.0 final review P8: a remote-head relay with a wrong digest (args right) stops at iac-push", async () => {
  const s = iacScript(() => happy(), "approved");
  const inner = s["infra:remote-head:push"];
  s["infra:remote-head:push"] = (prompt) => Object.assign(inner(prompt), { digest: "0".repeat(64) });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac-push");
  assert.match(out.result.reason, /could not be read/);
  assert.ok(!pushed(out));
});

test("3.1.0 final review P10: a scan diff with only the provider lock file needs the relay to list it", async () => {
  for (const p of ["." + TFW + ".lock.hcl", "infra/." + TFW + ".lock.hcl"]) {
    const s = happy({ script: { "infra:fleet-scan:push": { status: "ok", reason: "scanned", diff: [p], commits: [] } } });
    s["infra:tf-gate:push"] = gateFor({});
    const out = await run(s, ARGS);
    assert.equal(out.result.stop_gate, "iac", p);
  }
});

test("3.1.0 final review: the orchestrator yaml is hook surface for the scope fence", async () => {
  for (const p of [AT + ".yaml", "sub/" + AT + ".yml"]) {
    const s = happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py", p] } } });
    const out = await run(s, ARGS);
    assert.equal(out.result.stop_gate, "scope", p);
    assert.match(out.result.reason, /hook surface/, p);
  }
});

test("3.1.0 IaC push gate: a problem (exec stack, plugin dir, symlink) stops at iac with the problem named", async () => {
  const s = happy();
  s["infra:tf-gate:push"] = gateFor({ problems: ["changes code that existing IaC runs at plan time: tools/run.sh"] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, /changes code that existing IaC runs at plan time: tools\/run\.sh/);
  assert.ok(!out.labels.includes("infra:push"));
});

test("3.1.0 IaC push gate: a final-segment plugin dir is refused by the gate and the fence", { skip: !HAVE_PY }, async () => {
  for (const p of ["infra/." + TFW, TFW + ".d", "infra/." + TFW + ".d"]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, { [p]: "bin\n" });
    assert.equal(o.touched, true, p);
    assert.match(o.problems.join("; "), /provider plugin directory/, p);
    const s = happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py", p] } } });
    const out = await run(s, ARGS);
    assert.equal(out.result.stop_gate, "scope", p);
  }
});

test("3.1.0 IaC push gate: a symlink to a plugin dir, or a symlink at an IaC path, is refused; a plain symlink is not", { skip: !HAVE_PY }, () => {
  for (const change of [
    { "infra/cache": { link: "." + TFW + "/providers" } },
    { "src/p": { link: "../infra/." + TFW } },
    { "infra/plugins": { link: "/home/u/." + TFW + ".d/plugins" } },
    { "infra/extra.tf": { link: "../src/gen.tf" } },
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN, "src/gen.tf": MAIN }, change);
    assert.match(o.problems.join("; "), /symlink/, JSON.stringify(change));
  }
  const o = tfGateRun({ "src/a.py": "x = 1\n" }, { "src/l.py": { link: "a.py" } });
  assert.deepEqual(o.problems, []);
});

test("3.1.0 ADR-1172: IaC and k8s/Helm paths are fleet work: the scope fence no longer refuses them", async () => {
  for (const p of ["infra/main.tf", "envs/prod.tfvars", TFW + "/x.py", "k8s/deploy.yaml", "charts/app/templates/svc.yaml", "deploy/kustomization.yml"]) {
    const s = happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py", p] } } });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", p + " " + out.result.reason);
  }
});

// ---------------------------------------------------------------- 3.1.0 security review of the pre-push IaC gate

test("3.1.0 IaC gate review 1: unquoted HCL labels and multi-line provisioner blocks are hinted", { skip: !HAVE_PY }, () => {
  for (const change of [
    { "infra/x.tf": "data external e {\n  program = [\"sh\"]\n}\n" },
    { "infra/x.tf": "resource null_resource n {}\n" },
    { "infra/x.tf": "data local_file f {\n  filename = \"a\"\n}\n" },
    { "infra/x.tf": "provider local {}\n" },
    { "infra/x.tf": 'resource "aws_instance" "i" {\n  provisioner\n  "file" {\n    source = "a"\n  }\n}\n' },
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, change);
    assert.ok(o.hints.length, JSON.stringify(change));
  }
});

test("3.1.0 IaC gate review 1: a changed .tf.json is parsed as JSON; each banned shape is hinted, unparseable JSON is hinted, a plain resource gives no hint", { skip: !HAVE_PY }, () => {
  const J = (o) => JSON.stringify(o) + "\n";
  for (const [doc, ok] of [
    [{ resource: { aws_s3_bucket: { b: { bucket: "x" } } } }, true],
    [{ data: { external: { e: { program: ["sh"] } } } }, false],
    [{ resource: { aws_instance: { i: { provisioner: [{ file: { source: "a" } }] } } } }, false],
    [{ resource: { local_file: { f: { filename: "a" } } } }, false],
    [{ data: { null_data_source: { n: {} } } }, false],
    [{ provider: { null: {} } }, false],
    [{ terraform: { required_providers: { aws: { source: "hashicorp/aws", version: "6.0" } } } }, false],
    [{ resource: { aws_instance: { i: { "local-exec": {} } } } }, false],
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/x.tf.json": J(doc) });
    assert.equal(o.hints.length === 0, ok, JSON.stringify(doc) + " " + o.hints.join("; "));
  }
  const bad = tfGateRun({ "infra/main.tf": MAIN }, { "infra/x.tf.json": "{ not json" });
  assert.match(bad.hints.join("; "), /does not parse/);
  // a required_providers block already there and unchanged passes
  const base = J({ terraform: { required_providers: { aws: { source: "hashicorp/aws", version: "5.0" } } }, resource: { aws_s3_bucket: { b: { bucket: "x" } } } });
  const o = tfGateRun({ "infra/v.tf.json": base }, { "infra/v.tf.json": base.replace('"bucket":"x"', '"bucket":"y"') });
  assert.deepEqual(o.hints, []);
});

test("3.1.0 IaC gate review 2: every IaC extension and provider dir is checked; the fence refuses provider plugin dirs", { skip: !HAVE_PY }, async () => {
  const EXT = 'data "external" "e" {\n  program = ["sh"]\n}\n';
  for (const name of ["infra/main.tofu", "infra/a.tofuvars", "infra/a.tfvars.json", "infra/a.tofuvars.json"]) {
    const o = tfGateRun({ "infra/main.tf": MAIN }, { [name]: name.endsWith(".json") ? '{"a": 1}\n' : 'a = "b"\n' });
    assert.equal(o.touched, true, name);
  }
  let o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/main.tofu": EXT });
  assert.match(o.hints.join("; "), /external/);
  o = tfGateRun({ "infra/main.tf": MAIN }, { "infra/x.tofu.json": '{"data": {"external": {"e": {}}}}\n' });
  assert.match(o.hints.join("; "), /external/);
  for (const p of ["infra/." + TFW + "/providers/x", TFW + ".d/plugins/x"]) {
    o = tfGateRun({ "infra/main.tf": MAIN }, { [p]: "bin\n" });
    assert.equal(o.touched, true, p);
    assert.match(o.problems.join("; "), /provider plugin directory/, p);
    const s = happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py", p] } } });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", p);
    assert.equal(out.result.stop_gate, "scope", p);
  }
});

test("3.1.0 IaC gate review 3: a change to code an existing exec stack runs at plan time stops; a plain stack's code passes", { skip: !HAVE_PY }, () => {
  const EXEC = 'data "external" "e" {\n  program = ["python3", "${path.module}/scripts/get.py"]\n}\n';
  const base = {
    "infra/main.tf": EXEC,
    "infra/scripts/get.py": "print('{}')\n",
    "infra/other.py": "x = 1\n",
    "ops/main.tf": 'resource "null_resource" "n" {\n  provisioner "local-exec" {\n    command = "bash tools/run.sh"\n  }\n}\n',
    "tools/run.sh": "echo hi\n",
    "web/main.tf": 'locals {\n  t = file("${path.module}/../shared/t.json")\n}\nresource "aws_s3_bucket" "b" {}\n',
    "shared/t.json": "{}\n",
    "plain/main.tf": MAIN,
    "plain/helper.py": "x = 1\n",
    "src/app.py": "x = 1\n",
  };
  for (const [change, stops] of [
    [{ "infra/scripts/get.py": "print('{\"a\": 1}')\n" }, true],
    [{ "infra/other.py": "x = 2\n" }, true],
    [{ "tools/run.sh": "echo bye\n" }, true],
    [{ "plain/helper.py": "x = 2\n" }, false],
    [{ "src/app.py": "x = 2\n" }, false],
    // web/ uses no external, provisioner or local/null: its file() target is not code that runs
    [{ "shared/t.json": '{"a": 1}\n' }, false],
  ]) {
    const o = tfGateRun(base, change);
    const hit = o.problems.some((p) => /changes code that existing IaC runs at plan time/.test(p));
    assert.equal(hit, stops, JSON.stringify(change) + " " + o.problems.join("; "));
  }
});

// ---------------------------------------------------------------- 3.1.1 (ledger 1969): the PATH check runs again before every step that runs repo code

// each re-check site and the step it guards: plan mode, then build mode
const RECHECK_SITES = [
  ["format-plan", "infra:format-plan"],
  // 3.1.2 (ledger 1974): the plan-audit runs the planner's test_cmd
  ["plan-audit", "role:plan-audit"],
  ["commit-plan", "infra:commit-plan"],
  ["writers:r1", "role:fleet-test-writer:AC1:r1"],
  ["format-tests:r1", "infra:format-tests:r1"],
  ["test-judge:r1", "role:fleet-test-judge:r1"],
  ["coder:r1", "role:fleet-coder:r1"],
  ["format-code:r1", "infra:format-code:r1"],
  ["code-judge:r1", "role:fleet-code-judge:r1"],
  ["commit:r1", "infra:commit:r1"],
  ["push", "infra:push"],
  // 3.1.2 (ledger 1974): the review runs repo tests after the push
  ["pr-review:v1", "role:pr-review:v1"],
];
const REAL_TOOL = { path: "/home/u/.local/bin/x", real: "/home/u/.local/bin/x", shim: false };
const recheckPlanted = (prompt) => {
  const i = inputsOf(prompt);
  return pathRecheckOut({ [TF_TOOLS[0]]: REAL_TOOL }, [i.repo, i.token]);
};

test("3.1.1 PATH re-check: every guarded step is preceded by its own re-check (hashers aside)", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const [site, step] of RECHECK_SITES) {
    const at = out.labels.indexOf(step);
    assert.ok(at > 0, step);
    const before = out.labels.slice(0, at).filter((l) => !/^hasher:/.test(l));
    assert.equal(before[before.length - 1], "infra:path-check:" + site, step + " is guarded");
  }
});

test("3.1.1 PATH re-check: a tool planted after preflight is caught at the next check; the guarded step never runs", async () => {
  for (const [site, step] of RECHECK_SITES) {
    const s = happy();
    s["infra:path-check:" + site] = recheckPlanted;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", site);
    assert.equal(out.result.stop_gate, "iac", site);
    assert.match(out.result.reason, NOT_SHIMMED, site);
    assert.ok(out.result.reason.includes("infra:path-check:" + site), site);
    assert.ok(!out.labels.includes(step), site + ": " + step + " never runs");
  }
  // the coder case in words: preflight and every earlier re-check pass, the coder's re-check finds the tool
  const s = happy();
  s["infra:path-check:coder:r1"] = recheckPlanted;
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("role:fleet-test-judge:r1"));
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-coder")));
});

test("3.1.1 PATH re-check: a failed, tampered, path-problem or other-step result stops at iac", async () => {
  const site = "code-judge:r1";
  const cases = [
    () => null,
    () => ({ status: "failed", reason: "python3 exited 1" }),
    () => ({ status: "needs_human", reason: "x" }),
    (p) => Object.assign(recheckPlanted(p), { tools: {} }),
    (p) => {
      const i = inputsOf(p);
      return Object.assign(pathRecheckOut({}, [i.repo, i.token]), { digest: "0".repeat(64) });
    },
    (p) => {
      const i = inputsOf(p);
      const r = pathRecheckOut({}, [i.repo, i.token]);
      r.path_problems = ['relative PATH entry "bin"'];
      r.digest = sha256(canon({ tools: r.tools, args: r.args, path_problems: r.path_problems }));
      return r;
    },
    // the preflight's own result (args [repo]): never a re-check's pass
    (p) => pathRecheckOut({}, [inputsOf(p).repo]),
    // another step's re-check result (its token)
    (p) => {
      const i = inputsOf(p);
      return pathRecheckOut({}, [i.repo, i.token.replace(site, "coder:r1")]);
    },
    // a test-overridden store prefix
    (p) => {
      const i = inputsOf(p);
      return pathRecheckOut({}, [i.repo, i.token, "--store-prefix=/tmp/x"]);
    },
  ];
  for (const [k, f] of cases.entries()) {
    const s = happy();
    s["infra:path-check:" + site] = (p) => (f(p) === null ? null : Object.assign(f(p), { __raw: true }));
    // 4.0.0 (1990): a broken relay is checked once more on sonnet; it is broken there too
    s["infra:path-check:" + site + ":relay-retry"] = s["infra:path-check:" + site];
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", String(k));
    assert.equal(out.result.stop_gate, "iac", String(k) + " " + out.result.reason);
    assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), String(k));
  }
});

test("3.1.1 PATH re-check: each check runs the same program with a fresh token; a resumed run never replays a cached pass", async () => {
  const out = await run(happy(), ARGS);
  const prog = extractPy("PATH_CHECK_PY_BEGIN", "PATH_CHECK_PY_END", "PATH_CHECK_PY");
  const checks = out.calls.filter((c) => /^infra:path-check:/.test(c.label));
  assert.ok(checks.length >= RECHECK_SITES.length);
  const tokens = checks.map((c) => inputsOf(c.prompt).token);
  assert.equal(new Set(tokens).size, tokens.length, "no two checks share a token");
  for (const c of checks) {
    const i = inputsOf(c.prompt);
    assert.equal(i.repo, "/r");
    assert.ok(i.token.includes(NONCE), "the token carries the run nonce");
    assert.ok(!i.token.startsWith("-"), "the token is never an option");
    assert.ok(c.prompt.includes("python3 -I " + shQuoteTest(SCRIPTS_DIR + "/path_check.py") + " " + shQuoteTest(i.repo) + " " + shQuoteTest(i.token)), c.label);
    assert.doesNotMatch(c.prompt, /terraform|tofu|tflint|terragrunt|\btfp\b|digger|atlantis/i);
  }
  // run 1 stops at the coder (no result); its recorded re-check passes are
  // returned to the resumed run (a new nonce): none is accepted
  const s1 = happy();
  s1["role:fleet-coder:r1"] = null;
  const first = await run(s1, ARGS);
  assert.equal(first.result.status, "failed", first.result.reason);
  const recorded = {};
  for (const c of first.calls.filter((x) => /^infra:path-check:/.test(x.label))) {
    const i = inputsOf(c.prompt);
    recorded[c.label] = pathRecheckOut({}, [i.repo, i.token]);
  }
  assert.ok(recorded["infra:path-check:coder:r1"], "run 1 checked before the coder");
  const s2 = happy();
  for (const [label, r] of Object.entries(recorded)) {
    s2[label] = Object.assign({}, r, { __raw: true });
    // 4.0.0 (1990): and at the sonnet relay retry of each check
    s2[label + ":relay-retry"] = s2[label];
  }
  const second = await run(s2, Object.assign({}, ARGS, { run_nonce: "n2-0000002" }));
  assert.equal(second.result.status, "needs_human");
  assert.equal(second.result.stop_gate, "iac");
  // 4.0.0 (1985): the plan run's first re-check is the push probe's
  assert.match(second.result.reason, /PATH re-check infra:path-check:push-probe:relay-retry could not complete/);
});

test("3.1.1 PATH re-check program: a token argument is echoed in args and the digest; a planted tool is seen", { skip: !HAVE_PY }, () => {
  const prog = extractPy("PATH_CHECK_PY_BEGIN", "PATH_CHECK_PY_END", "PATH_CHECK_PY");
  const home = mkdtempSync(join(tmpdir(), "fleet-recheck-"));
  try {
    const bin = join(home, "bin");
    spawnSync("mkdir", ["-p", bin]);
    const tok = "recheck-3:" + NONCE + ":coder:r1";
    const go = () => spawnSync(PY3, ["-I", "-c", prog, join(home, "repo"), tok], { encoding: "utf8", env: { PATH: bin }, cwd: home, timeout: 60000, maxBuffer: 1 << 20 });
    let r = go();
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.args, [join(home, "repo"), tok]);
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    assert.equal(o.digest, sha256(fn({ tools: o.tools, args: o.args, path_problems: o.path_problems, program: o.program })));
    // a tool planted in a writable PATH dir after the first check is seen by the next one
    writeFileSync(join(bin, TF_TOOLS[1]), "#!/bin/sh\necho real\n", { mode: 0o755 });
    r = go();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).tools[TF_TOOLS[1]].shim, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.1.2 (ledger 1974): more re-check sites; mutants R6 and R7

// the guarded steps outside the happy run: the intent judge (confirm auto)
// and the gate sweep (the review flags a gate)
const sweepOn = () => ({
  "role:pr-review:v1": { status: "ok", reason: "x", verdict: "approve", findings: [], touches_gate: true, checked: [] },
  "role:gate-change-nonweakening-sweep:v1": { status: "ok", reason: "s", verdict: "non_weakening", units: [], findings: [] },
  "hasher:fp-post:sweep:v1": { status: "ok", fingerprint: { head: CSHA(1), tree: "K1" } },
});
const EXTRA_SITES = [
  ["intent", "role:fleet-intent-judge", () => autoHappy(), AUTO],
  ["sweep:v1", "role:gate-change-nonweakening-sweep:v1", () => happy({ script: sweepOn() }), ARGS],
];

test("3.1.2 PATH re-check: the intent judge and the gate sweep are each preceded by their own re-check (hashers aside)", async () => {
  for (const [site, step, mk, args] of EXTRA_SITES) {
    const out = await run(mk(), args);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", site + ": " + out.result.reason);
    const at = out.labels.indexOf(step);
    assert.ok(at > 0, step);
    const before = out.labels.slice(0, at).filter((l) => !/^hasher:/.test(l));
    assert.equal(before[before.length - 1], "infra:path-check:" + site, step + " is guarded");
  }
});

test("3.1.2 PATH re-check: a tool planted right before the intent judge or the sweep stops the run; the step never runs", async () => {
  for (const [site, step, mk, args] of EXTRA_SITES) {
    const s = mk();
    s["infra:path-check:" + site] = recheckPlanted;
    const out = await run(s, args);
    assert.equal(out.result.status, "needs_human", site);
    assert.equal(out.result.stop_gate, "iac", site);
    assert.match(out.result.reason, NOT_SHIMMED, site);
    assert.ok(out.result.reason.includes("infra:path-check:" + site), site);
    assert.ok(!out.labels.includes(step), site + ": " + step + " never runs");
  }
  // build mode with confirm auto re-runs the intent judge: intent:rerun guards it
  const s = autoHappy();
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation");
  Object.assign(s, {
    "intake:rulings": { status: "ok", reason: "re-read", brief: BRIEF },
    "hasher:pre-intent:rerun": { status: "ok", fingerprint: FP_PLAN },
    "role:fleet-intent-judge:rerun": { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
    "hasher:fp-post:intent:rerun": { status: "ok", fingerprint: FP_PLAN },
  });
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r", confirm: "auto" };
  const ok = await runOne(s, bargs);
  noUnscripted(ok);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  const at = ok.labels.indexOf("role:fleet-intent-judge:rerun");
  assert.equal(ok.labels.slice(0, at).filter((l) => !/^hasher:/.test(l)).pop(), "infra:path-check:intent:rerun");
  s["infra:path-check:intent:rerun"] = recheckPlanted;
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "iac", out.result.reason);
  assert.ok(out.result.reason.includes("infra:path-check:intent:rerun"));
  assert.ok(!out.labels.includes("role:fleet-intent-judge:rerun"));
});

// mutant R6: the status check dropped. A re-check that returns failed or
// needs_human next to a clean, digest-valid program output still stops.
test("3.1.2 PATH re-check (mutant R6): a not-ok status with a valid digest and shape stops at iac", async () => {
  for (const site of ["plan-audit", "code-judge:r1", "pr-review:v1"]) {
    for (const status of ["failed", "needs_human"]) {
      const s = happy();
      s["infra:path-check:" + site] = (p) => {
        const i = inputsOf(p);
        return Object.assign(pathRecheckOut({}, [i.repo, i.token]), { status, reason: "x", __raw: true });
      };
      // 4.0.0 (1990): the sonnet relay retry says the same
      s["infra:path-check:" + site + ":relay-retry"] = s["infra:path-check:" + site];
      const out = await run(s, ARGS);
      assert.equal(out.result.status, "needs_human", site + " " + status);
      assert.equal(out.result.stop_gate, "iac", site + " " + status + ": " + out.result.reason);
      assert.ok(out.result.reason.includes("infra:path-check:" + site + ":relay-retry could not complete: it returned " + status), out.result.reason);
    }
  }
});

// The workflow's pathRecheck and everything it calls, with a stubbed agent.
function jsPathRecheck(agentStub) {
  const grab = (name, kw) => {
    const i = SOURCE.indexOf("\n" + (kw || "function ") + name + "(");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const constBlock = (name, end) => {
    const i = SOURCE.indexOf("\nconst " + name + " = ");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf(end, i) + end.length);
  };
  const consts =
    'const STR = { type: "string" };\nconst STR_OR_NULL = { type: ["string", "null"] };' +
    constBlock("PROGRAM_PROP", ";\n") +
    constBlock("K256", "];") +
    constBlock("PROGRAM_SHA256", "\n};") +
    constBlock("PATH_TOOLS", "];") +
    constBlock("NOT_SHIMMED", '";') +
    constBlock("PATH_RECHECK_SCHEMA", "\n};") +
    '\nconst SHA256_RE = /^[0-9a-f]{64}$/;\nconst JUDGE_AGENT = "fleet:judge";\n' +
    // 4.0.0 (1990): the PATH check's tier and its relay retry
    constBlock("INFRA_TIER", "];") +
    constBlock("RELAY_RETRY_MODEL", '";') +
    // 4.0.2 (1997): the PATH re-check goes through infraCall (schema and file_sha256 rule)
    constBlock("PROGRAM_SLOTS", "\n];") +
    constBlock("FILE_SHA_HEX", ";\n") +
    constBlock("EMITTED_CMDS", ";\n") +
    'const state = { repo: "/r", nonce: "' + NONCE + '", pathChecks: 0, agents: 0, scriptsDir: "' + SCRIPTS_DIR + '" };\n' +
    // 4.0.0: the one program this runtime runs
    // 4.0.1: its sha256 from the workflow's PROGRAM_SHA256 table
    "function programTable() { return { path_check: PROGRAM_SHA256.path_check }; }\n" +
    "function gate() {}\nfunction halt(status, msg, stopGate) { const e = new Error(msg); e.halt = { status, stopGate }; throw e; }\n" +
    'function nonced(p) { return p + "\\nRun nonce: " + state.nonce; }\n';
  const fns = ["codePointCompare", "canonical", "utf8Bytes", "rotr", "sha256Hex", "relayDigestOk", "programSha", "programProblem", "progCmd", "shQuote", "pathRelayProblem", "pathCheck", "pathRecheckPrompt", "infraModel", "programSlots", "programSchema", "fileShaRule", "infraCall", "emitProg"].map((n) => grab(n)).join("\n") + grab("pathRecheck", "async function ");
  return new Function("agent", consts + fns + "\nreturn pathRecheck;")(agentStub);
}

// mutant R7: a token without the counter. Two re-checks at the SAME site in
// one run must get different tokens, and the first one's result replayed at
// the second must be refused.
test("3.1.2 PATH re-check (mutant R7): two re-checks at the same site get different tokens; a replay of the first is refused", async () => {
  const seen = [];
  let replay = null;
  const recheck = jsPathRecheck(async (prompt, opts) => {
    const i = inputsOf(prompt);
    seen.push({ label: opts.label, token: i.token });
    return replay || pathRecheckOut({}, [i.repo, i.token]);
  });
  await recheck("same", "Code");
  assert.equal(seen.length, 1);
  replay = pathRecheckOut({}, ["/r", seen[0].token]);
  await assert.rejects(recheck("same", "Code"), (e) => {
    assert.equal(e.halt.status, "needs_human");
    assert.equal(e.halt.stopGate, "iac");
    assert.match(e.message, /infra:path-check:same:relay-retry could not complete/);
    return true;
  });
  // 4.0.0 (1990): the refused replay is checked once more on sonnet (refused again)
  assert.equal(seen.length, 3);
  assert.equal(seen[0].label, seen[1].label, "the same site");
  assert.equal(seen[2].label, "infra:path-check:same:relay-retry");
  assert.notEqual(seen[0].token, seen[1].token, "a token per check, not per site");
  assert.notEqual(seen[1].token, seen[2].token, "the relay retry has a token of its own");
  // a fresh result at a third check at the same site passes
  replay = null;
  await recheck("same", "Code");
  assert.equal(new Set(seen.map((x) => x.token)).size, 4);
});

// ---------------------------------------------------------------- 3.1.1 (ledger 1970a): non-HCL IaC files get their own hint

test("3.1.1 IaC hint text: orchestrator, spacelift and version files get their own hint, never a provider hint; the gate result is unchanged", { skip: !HAVE_PY }, () => {
  for (const [p, before, after, re] of [
    [AT + ".yaml", "version: 3\nprojects: []\n", "version: 3\nprojects:\n- dir: infra\n", /^orchestrator config change in /],
    ["sub/" + AT + ".yml", "version: 3\n", "version: 4\n", /^orchestrator config change in /],
    [".spacelift/config.yml", "version: 1\n", "version: 2\n", /^orchestrator config change in /],
    ["." + TFW + "-version", "1.5.0\n", "1.6.0\n", /^IaC tool version file change in /],
    [".open" + "to" + "fu-version", "1.6.0\n", "1.7.0\n", /^IaC tool version file change in /],
  ]) {
    const o = tfGateRun({ "infra/main.tf": MAIN, [p]: before }, { [p]: after });
    assert.equal(o.touched, true, p);
    assert.deepEqual(o.iac_files, [p], p);
    assert.deepEqual(o.problems, [], p);
    assert.ok(!o.hints.some((h) => /provider source or version change/.test(h)), p + ": " + o.hints.join("; "));
    assert.ok(o.hints.some((h) => re.test(h) && h.endsWith(" " + p)), p + ": " + o.hints.join("; "));
  }
  // a .tf provider change keeps its hint
  const o = tfGateRun({ "infra/versions.tf": PROV }, { "infra/versions.tf": PROV.replace("~> 5.0", "~> 6.0") });
  assert.ok(o.hints.some((h) => /provider source or version change in infra\/versions\.tf/.test(h)), o.hints.join("; "));
});

// ---------------------------------------------------------------- 3.1.1 (ledger 1970b): the origin URL comes from a program, digest-checked

test("3.1.1 origin URL: the workspace step relays a program's output; the script recomputes its digest and checks its args", async () => {
  const prog = extractPy("REMOTE_URL_PY_BEGIN", "REMOTE_URL_PY_END", "REMOTE_URL_PY");
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const wp = call(out, "workspace").prompt;
  assert.ok(wp.includes("python3 -I " + shQuoteTest(SCRIPTS_DIR + "/remote_url.py") + " " + shQuoteTest("/r")), "the workspace prompt runs the program");
  assert.match(prog, /'config', '--get', 'remote\.origin\.url'/);
  // the plan seals the program's URL, never a free-text remote_url
  const s = iacScript(() => happy(), "approved");
  s.workspace = Object.assign({}, s.workspace, { remote_url: "git@evil.example:o/r.git", remote_url_check: remoteUrlOut("git@github.com:o/r.git", "/r") });
  const ok = await run(s, ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.equal(inputsOf(call(ok, "infra:remote-head:push").prompt).remote_url, "git@github.com:o/r.git");
  // an unusable relay (bad digest, other args, a changed url, missing) seals no URL: an IaC diff stops at iac
  for (const bad of [
    Object.assign(remoteUrlOut("git@github.com:o/r.git", "/r"), { digest: "0".repeat(64) }),
    remoteUrlOut("git@github.com:o/r.git", "/other"),
    Object.assign(remoteUrlOut("git@github.com:o/r.git", "/r"), { url: "git@evil.example:o/r.git" }),
    null,
  ]) {
    const t = iacScript(() => happy(), "approved");
    t.workspace = Object.assign({}, t.workspace, { remote_url_check: bad });
    const o = await run(t, ARGS);
    assert.equal(o.result.stop_gate, "iac", JSON.stringify(bad));
    assert.match(o.result.reason, /no sealed origin URL/, JSON.stringify(bad));
    assert.ok(!pushed(o));
  }
  // at build time the program's URL is compared with the sealed one
  const u = iacScript(() => happy(), "approved");
  let n = 0;
  const w0 = u.workspace;
  u.workspace = () => Object.assign({}, w0, { remote_url: "git@github.com:o/r.git", remote_url_check: remoteUrlOut(n++ === 0 ? "git@github.com:o/r.git" : "git@evil.example:o/r.git", "/r") });
  const o = await run(u, ARGS);
  assert.equal(o.result.stop_gate, "iac");
  assert.match(o.result.reason, /URL changed since the plan/);
});

test("3.1.1 origin URL program: prints the configured URL (before insteadOf) with a digest; caps first", { skip: !HAVE_PY }, () => {
  const prog = extractPy("REMOTE_URL_PY_BEGIN", "REMOTE_URL_PY_END", "REMOTE_URL_PY");
  assert.match(prog, /^# resource caps \(3\.1\.0\)/);
  const home = mkdtempSync(join(tmpdir(), "fleet-remoteurl-"));
  try {
    const repo = join(home, "repo");
    const cfg = join(home, "gitconfig");
    writeFileSync(cfg, '[url "git@evil.example:"]\n\tinsteadOf = git@github.com:\n');
    const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" };
    assert.equal(rawSpawnSync("git", ["init", "-q", repo], { env }).status, 0);
    const go = () => spawnSync(PY3, ["-I", "-c", prog, repo], { encoding: "utf8", env, cwd: home, timeout: 60000, maxBuffer: 1 << 20 });
    const fn = new Function(extractCanonical() + "\nreturn canonical;")();
    // no origin: url null
    let r = go();
    assert.equal(r.status, 0, r.stderr);
    let o = JSON.parse(r.stdout);
    assert.equal(o.url, null);
    assert.deepEqual(o.args, [repo]);
    assert.equal(o.digest, sha256(fn({ url: o.url, args: o.args, program: o.program })));
    assert.equal(rawSpawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:o/r.git"], { env }).status, 0);
    r = go();
    assert.equal(r.status, 0, r.stderr);
    o = JSON.parse(r.stdout);
    assert.equal(o.url, "git@github.com:o/r.git", "the configured URL, before insteadOf");
    assert.equal(o.digest, sha256(fn({ url: o.url, args: o.args, program: o.program })));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3.1.3 intake ledger resolution (ledger 1979)
// A docs session ran "yaadgaar #671" against repo iam-db with project
// yadgarhq/docs. Intake walked up iam-db for .yadgar/project-id, read its
// origin, never called read_task, and advised writing yadgarhq/docs into
// iam-db. The ledger scope is args.project; the repo never decides it, and
// the ledger tool's answer is the truth.

// The task-id rules of the intake prompt (rule 1, up to the Jira rule).
function intakeIdRules(prompt) {
  const m = /\n1\. Task id[\s\S]*?\n2\. Jira key/.exec(prompt);
  assert.ok(m, "intake prompt has a task-id rule:\n" + prompt);
  return m[0];
}

test("3.1.3 intake: a task id resolves only through the ledger tool; the repo's project-id or origin never decides the ledger", async () => {
  const s = happy({ brief: YBRIEF });
  const out = await runOne(s, { ...YQ, input: "yaadgaar #671", repo: "/home/max/git/yadgarhq/iam-db" });
  const c = call(out, "intake");
  const inp = inputsOf(c.prompt);
  // project is the ledger scope, passed as given and independent of repo
  assert.equal(inp.project, "yadgarhq/docs");
  assert.equal(inp.repo, "/home/max/git/yadgarhq/iam-db");
  assert.equal(inp.ledger, "yaadgaar");
  const rules = intakeIdRules(c.prompt);
  assert.doesNotMatch(rules, /walking up|remote get-url|first `\.yadgar\/project-id` found/);
  assert.match(rules, /mcp__yaadgaar__read_task/);
  assert.match(rules, /number=<the number>/);
  assert.match(rules, /only by calling the ledger tool/i);
  assert.match(rules, /independent of <repo>/);
  assert.match(rules, /never advise/i);
  assert.match(rules, /`tried`/);
});

test("3.1.3 intake: the URN from the read_task answer is sealed with the yaadgaar source", async () => {
  const s = happy({ brief: YBRIEF });
  const out = await runOne(s, YQ);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const ref = JSON.parse(s.__store[out.result.plan_ref.plan_commit]);
  assert.equal(ref.brief.sources[0].id, YURN);
});

test("3.1.3 intake: a yaadgaar source without the task id from the read_task answer stops before the workspace", async () => {
  for (const id of [undefined, null, "", 42]) {
    const out = await runOne(happy({ brief: { ...YBRIEF, sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "b", id }] } }), YQ);
    assert.equal(out.result.status, "needs_human", String(id));
    assert.match(out.result.reason, /read_task/, String(id));
    assert.ok(!out.labels.includes("workspace"), String(id));
  }
});

test("3.1.3 intake: ledger routing by project prefix; no project tries both", async () => {
  for (const [project, ledger] of [
    ["yadgarhq/docs", "yaadgaar"],
    ["yadgarhq/iam-db", "yaadgaar"],
    ["m-agahi/ccpm", "yadgar"],
    ["o/yadgarhq", "yadgar"],
    ["xyadgarhq/docs", "yadgar"],
    [undefined, "either"],
    ["", "either"],
  ]) {
    const a = { ...ARGS };
    if (project === undefined) delete a.project;
    else a.project = project;
    const out = await runOne(happy(), a);
    assert.equal(inputsOf(call(out, "intake").prompt).ledger, ledger, String(project));
  }
  const rules = intakeIdRules(call(await runOne(happy(), ARGS), "intake").prompt);
  assert.match(rules, /ledger `either`[\s\S]*mcp__yaadgaar__read_task[\s\S]*mcp__yadgar__task_get/);
  // no project: the yaadgaar task the session's client returned is used
  const a = { ...YQ };
  delete a.project;
  const out = await runOne(happy({ brief: YBRIEF }), a);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

test("3.1.3 intake: needs_human on a task id names the ledgers tried and the tool error text", async () => {
  const tried = [
    { ledger: "yaadgaar", project: "yadgarhq/docs", call: "read_task(number=671)", error: "NOT_FOUND: no task 671" },
    { ledger: "yadgar", project: "yadgarhq/docs", call: "task_get(project_id=yadgarhq/docs, id=671)", error: "external_task_ledger" },
  ];
  const out = await runOne(happy({ script: { intake: { status: "needs_human", reason: "task not found", tried } } }), { ...YQ, input: "#671" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /task not found/);
  assert.match(out.result.reason, /yaadgaar \(project yadgarhq\/docs\) read_task\(number=671\): error \(as reported by intake agent\): NOT_FOUND: no task 671/);
  assert.match(out.result.reason, /yadgar \(project yadgarhq\/docs\) task_get\(project_id=yadgarhq\/docs, id=671\): error \(as reported by intake agent\): external_task_ledger/);
  assert.deepEqual(out.labels, ["preflight", "intake"]);
  // a task-id input that made no ledger call says so
  for (const input of ["#671", "671", "L42", "yaadgaar #671"]) {
    const o = await runOne(happy({ script: { intake: { status: "needs_human", reason: "unsure" } } }), { ...YQ, input });
    assert.match(o.result.reason, /ledgers tried: none \(intake made no ledger tool call\)/, input);
  }
  // other inputs carry no ledger list
  const j = await runOne(happy({ script: { intake: { status: "needs_human", reason: "ABC-1 names two repos" } } }), { ...ARGS, input: "ABC-1" });
  assert.doesNotMatch(j.result.reason, /ledgers tried/);
});

test("3.1.3 intake: a reason that advises a repo project-id file is never relayed", async () => {
  const advice = "Yaadgaar does not resolve to project yadgarhq/docs. iam-db needs a .yadgar/project-id file with yadgarhq/docs.";
  const out = await runOne(
    happy({ script: { intake: { status: "needs_human", reason: advice, tried: [{ ledger: "yaadgaar", project: "yadgarhq/docs", call: "read_task(number=671)", error: "NOT_FOUND" }] } } }),
    { ...YQ, input: "yaadgaar #671" },
  );
  assert.equal(out.result.status, "needs_human");
  assert.doesNotMatch(out.result.reason, /project-id/);
  assert.match(out.result.reason, /dropped/);
  assert.match(out.result.reason, /NOT_FOUND/);
});

test("3.1.3 build: args.project, never the origin slug, decides the ledger check; the yaadgaar write-back reads by the sealed id", async () => {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, { ...YQ, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:yaadgaar-read"] = yaadgaarRead();
  s["infra:yaadgaar-writeback"] = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
  // 4.0.0 (1992, AC-1992): no project at build: the project sealed at plan
  // time (yadgarhq/docs) is the ledger scope, never the origin slug o/r
  const none = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date });
  assert.equal(none.result.status, "ok", none.result.reason);
  assert.ok(none.labels.includes("infra:yaadgaar-read"));
  assert.deepEqual(none.result.write_back.ledger.map((e) => [e.ref, e.status]), [["yaadgaar #622", "written"]]);
  // a ref sealed with no project and no project at build: the write-back refuses (fail closed)
  const s0 = autoHappy({ brief: YBRIEF });
  const plan0 = await runOne(s0, { ...YQ, confirm: "ask", project: undefined });
  assert.equal(plan0.result.status, "awaiting_confirmation", plan0.result.reason);
  s0["infra:yaadgaar-read"] = yaadgaarRead();
  const none0 = await runOne(s0, { mode: "build", plan_ref: plan0.result.plan_ref, date: ARGS.date });
  assert.equal(none0.result.status, "ok", none0.result.reason);
  assert.ok(!none0.labels.includes("infra:yaadgaar-read"));
  assert.ok(!none0.labels.includes("infra:yaadgaar-writeback"));
  assert.equal(none0.result.ledger_status, "failed");
  assert.match(none0.result.write_back.ledger[0].reason, /no yadgarhq\/ project/);
  assert.match(none0.result.write_back.ledger[0].section_text, /fleet:y622/);
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "infra:yaadgaar-read").prompt).tasks, [{ key: "s0", number: 622, id: YURN }]);
  assert.deepEqual(out.result.write_back.ledger.map((e) => [e.ref, e.status]), [["yaadgaar #622", "written"]]);
  // another ledger's project at build still stops (4.0.0: as a sealed-project mismatch)
  const o = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "m-agahi/ccpm" });
  assert.equal(o.result.status, "needs_human");
  assert.match(o.result.reason, /project mismatch.*re-run plan/);
});

test("3.1.3 intake: project reaches intake independent of the repo", async () => {
  const out = await runOne(happy(), { ...ARGS, project: "m-agahi/yadgar" });
  assert.equal(inputsOf(call(out, "intake").prompt).project, "m-agahi/yadgar");
  assert.equal(inputsOf(call(out, "intake").prompt).repo, "/r");
});

test("3.1.3 build: a plan ref sealed without the yaadgaar task id (before 3.1.3) edits nothing and says re-run plan", async () => {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, { ...YQ, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  // a 3.1.2 ref: the same seal over a source with no id
  const tiny = plan.result.plan_ref;
  const canonical = new Function(extractCanonical() + "\nreturn canonical;")();
  const raw = s.__store[tiny.plan_commit];
  const ref = JSON.parse(raw);
  delete ref.brief.sources[0].id;
  delete ref.seal;
  ref.seal = sha256(canonical(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + (raw.endsWith("\n") ? "\n" : "");
  s["infra:yaadgaar-read"] = yaadgaarRead();
  s["infra:yaadgaar-writeback"] = () => ({ status: "ok", reason: "x", results: [] });
  const out = await runOne(s, { mode: "build", plan_ref: { ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) }, date: ARGS.date, project: "yadgarhq/docs" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("infra:yaadgaar-read"));
  assert.ok(!out.labels.includes("infra:yaadgaar-writeback"));
  assert.equal(out.result.ledger_status, "failed");
  assert.match(out.result.write_back.ledger[0].reason, /no task id.*re-run plan/);
  assert.match(out.result.write_back.ledger[0].section_text, /fleet:y622/);
});

test("3.1.3 intake: a yaadgaar answer that names another project than args.project stops before the seal", async () => {
  const brief = { ...YBRIEF, sources: [{ ...YBRIEF.sources[0], project: "yadgarhq/other" }] };
  const out = await runOne(happy({ brief }), YQ);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /project yadgarhq\/other, not args\.project yadgarhq\/docs/);
  assert.ok(!out.labels.includes("workspace"));
  // the same project, or none named, passes; the project is never sealed
  const s = happy({ brief: { ...YBRIEF, sources: [{ ...YBRIEF.sources[0], project: "yadgarhq/docs" }] } });
  const ok = await runOne(s, YQ);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.equal(JSON.parse(s.__store[ok.result.plan_ref.plan_commit]).brief.sources[0].project, undefined);
  // the intent re-read checks it too
  const a = autoHappy({ brief: YBRIEF });
  const plan = await runOne(a, { ...YQ, confirm: "ask" });
  a["intake:rulings"] = { status: "ok", reason: "re-read", brief };
  const b = await runOne(a, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs", confirm: "auto" });
  assert.equal(b.result.status, "needs_human");
  assert.match(b.result.reason, /re-read of yaadgaar:622: .*yadgarhq\/other, not args\.project yadgarhq\/docs/);
});

test("3.1.3 intake: the intent re-read must return the sealed yaadgaar id", async () => {
  const a = autoHappy({ brief: YBRIEF });
  const plan = await runOne(a, { ...YQ, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  a["intake:rulings"] = { status: "ok", reason: "re-read", brief: { ...YBRIEF, sources: [{ ...YBRIEF.sources[0], id: "yadgar:task:0999" }] } };
  const b = await runOne(a, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs", confirm: "auto" });
  assert.equal(b.result.status, "needs_human");
  assert.match(b.result.reason, /not the sealed task/);
  assert.ok(!b.labels.some((l) => /fleet-intent-judge/.test(l)));
});

test("3.1.3 intake: a yadgar reason that echoes task_get(project_id=...) is relayed intact", async () => {
  const reason = "task_get(project_id=o/r, id=42): external_task_ledger";
  const out = await runOne(happy({ script: { intake: { status: "needs_human", reason, tried: [{ ledger: "yadgar", project: "o/r", call: "task_get(project_id=o/r, id=42)", error: "external_task_ledger" }] } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(out.result.reason.startsWith("intake needs_human: " + reason + "; ledgers tried: "), out.result.reason);
  assert.doesNotMatch(out.result.reason, /dropped/);
});

test("3.1.3 build: the yadgar ledger write-back takes args.project, independent of the origin slug", async () => {
  const out = await run(happy(), { ...ARGS, project: "m-agahi/yadgar" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(inputsOf(call(out, "intake").prompt).project, "m-agahi/yadgar");
  assert.equal(inputsOf(call(out, "infra:ledger-read:pre").prompt).project, "m-agahi/yadgar");
  assert.equal(inputsOf(call(out, "infra:ledger-writeback").prompt).project, "m-agahi/yadgar");
});

// ---------------------------------------------------------------- 3.1.3 review of PR #41

test("3.1.3 review 1: confirm auto with no project and a task-id input stops before intake", async () => {
  for (const input of ["#42", "42", "L42", "yaadgaar #42"]) {
    const a = { ...ARGS, input, confirm: "auto" };
    delete a.project;
    const out = await runOne(autoHappy(), a);
    assert.equal(out.result.status, "needs_human", input);
    assert.match(out.result.reason, /args\.project/, input);
    assert.match(out.result.reason, /confirm "ask"/, input);
    assert.ok(!out.labels.includes("intake"), input);
  }
  // a project, or a non-task input, passes this gate
  const j = { ...ARGS, input: "ABC-1", confirm: "auto" };
  delete j.project;
  assert.ok((await runOne(autoHappy(), j)).labels.includes("intake"));
  assert.ok((await runOne(autoHappy(), { ...ARGS, confirm: "auto" })).labels.includes("intake"));
});

test("3.1.3 review 1: the confirmation names the resolved ledger and project", async () => {
  const out = await runOne(happy({ brief: YBRIEF }), YQ);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(out.result.ledger_source, { ledger: "yaadgaar", ref: "622", id: YURN, project: "yadgarhq/docs" });
  assert.match(out.result.reason, /yaadgaar #622 \(yadgar:task:0192\) of project yadgarhq\/docs/);
  const a = { ...YQ };
  delete a.project;
  const n = await runOne(happy({ brief: YBRIEF }), a);
  assert.equal(n.result.status, "awaiting_confirmation", n.result.reason);
  assert.equal(n.result.ledger_source.project, null);
  assert.match(n.result.reason, /yaadgaar #622 .* of the session's yaadgaar project \(no args\.project\)/);
  const l = await runOne(happy(), ARGS);
  assert.deepEqual(l.result.ledger_source, { ledger: "yadgar", ref: "42", id: null, project: "o/r" });
  assert.match(l.result.reason, /yadgar L42 of project o\/r/);
  const t = await runOne(happy({ brief: { ...BRIEF, sources: [{ kind: "text", ref: "text", url: null, body: "x" }] } }), { ...ARGS, input: "do x" });
  assert.equal(t.result.ledger_source, null);
});

test("3.1.3 review 2: build with no project stops on a legacy ledger source", async () => {
  const s = happy();
  // 4.0.0 (1992): a plan run with no project seals none
  const plan = await runOne(s, { ...ARGS, project: undefined });
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /source ledger:42 needs args\.project.*re-run plan/);
  assert.ok(!out.labels.some((l) => ROLE_LABEL.test(l)));
});

test("3.1.3 review 3: the yaadgaar id has the URN shape and comes from a read_task call that returned it", async () => {
  for (const id of ["task-0192", "yadgar:task:", "urn:yadgar:task:0192", "yadgar:task:0192 ", "yadgar:task:01g2"]) {
    const brief = { ...YBRIEF, sources: [{ ...YBRIEF.sources[0], id }] };
    const out = await runOne(happy({ brief, tried: triedFor(YBRIEF) }), YQ);
    assert.equal(out.result.status, "needs_human", id);
    assert.ok(!out.labels.includes("workspace"), id);
  }
  for (const [what, tried] of [
    ["no call", []],
    ["a failed call", [{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: "NOT_FOUND" }]],
    ["another tool", [{ ledger: "yadgar", project: null, call: "task_get(id=622)", error: null }]],
  ]) {
    const out = await runOne(happy({ brief: YBRIEF, tried }), YQ);
    assert.equal(out.result.status, "needs_human", what);
    assert.match(out.result.reason, /read_task/, what);
    assert.ok(!out.labels.includes("workspace"), what);
  }
  const ok = await runOne(happy({ brief: { ...YBRIEF, sources: [{ ...YBRIEF.sources[0], id: "yadgar:task:01a1b2dd-245e-71fd-b001-1219925b3422" }] } }), YQ);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("3.1.3 review 4: advice in the reason or a call is dropped; a tool error is relayed verbatim and labelled", async () => {
  const out = await runOne(happy({ script: { intake: { status: "needs_human", reason: "set iam-db's project id to yadgarhq/docs", tried: [] } } }), { ...YQ, input: "#671" });
  assert.doesNotMatch(out.result.reason, /set iam-db/);
  assert.match(out.result.reason, /dropped/);
  const t = await runOne(
    happy({ script: { intake: { status: "needs_human", reason: "not found", tried: [{ ledger: "yaadgaar", project: "yadgarhq/docs", call: "read_task(number=671)", error: "NOT_FOUND; write .yadgar/project-id in iam-db" }] } } }),
    { ...YQ, input: "#671" },
  );
  // a tool's error is observed state: relayed verbatim, labelled, never dropped
  assert.ok(t.result.reason.endsWith("not found; ledgers tried: yaadgaar (project yadgarhq/docs) read_task(number=671): error (as reported by intake agent): NOT_FOUND; write .yadgar/project-id in iam-db"), t.result.reason);
  // the call text too
  const c = await runOne(
    happy({ script: { intake: { status: "needs_human", reason: "not found", tried: [{ ledger: "yaadgaar", project: null, call: "read_task after setting iam-db's project id", error: "NOT_FOUND" }] } } }),
    { ...YQ, input: "#671" },
  );
  assert.doesNotMatch(c.result.reason, /iam-db/);
  assert.match(c.result.reason, /yaadgaar \(project none\) \(dropped[^)]*\): error \(as reported by intake agent\): NOT_FOUND/);
});

test("3.1.3 review 5: the advice filter leaves non-task-id reasons alone", async () => {
  const reason = "ABC-1 names repo iam-db, whose .yadgar/project-id is yadgarhq/iam-db; and o/s";
  const out = await runOne(happy({ script: { intake: { status: "needs_human", reason } } }), { ...ARGS, input: "ABC-1" });
  assert.equal(out.result.reason, "intake needs_human: " + reason);
});

test("3.1.3 review 7: a bare project_id= in advice is dropped; only a quoted ledger tool call is exempt", async () => {
  const halt = (reason, tried) => runOne(happy({ script: { intake: { status: "needs_human", reason, tried: tried || [] } } }), { ...YQ, input: "#671" });
  for (const advice of [
    "set project_id=yadgarhq/docs in iam-db's config",
    "task_get(project_id=o/r, id=42) failed; set project_id=yadgarhq/docs in iam-db",
    "read_task(path=.yadgar/project-id) shows the wrong project",
  ]) {
    const out = await halt(advice);
    assert.doesNotMatch(out.result.reason, /iam-db|set project_id|\.yadgar/, advice);
    assert.match(out.result.reason, /dropped/, advice);
  }
  // the call text gets the same test; the tool's error text is relayed verbatim, labelled
  const e = await halt("not found", [{ ledger: "yadgar", project: "o/r", call: "task_get(project_id=o/r, id=671)", error: "unknown project_id: 'yadgarhq/foo'" }]);
  assert.ok(e.result.reason.endsWith("task_get(project_id=o/r, id=671): error (as reported by intake agent): unknown project_id: 'yadgarhq/foo'"), e.result.reason);
  const cut = await halt("not found", [{ ledger: "yadgar", project: "o/r", call: "task_get(project_id=o/r, id=671)", error: "z".repeat(5000) }]);
  assert.ok(cut.result.reason.endsWith("error (as reported by intake agent): " + "z".repeat(4096) + " (cut)"), cut.result.reason.slice(-80));
  const c = await halt("not found", [{ ledger: "yadgar", project: "o/r", call: "edit(project_id=yadgarhq/docs)", error: "x" }]);
  assert.doesNotMatch(c.result.reason, /edit\(project_id/);
  // a quoted ledger call still passes, in the reason, the call and the error
  const q = "task_get(project_id=o/r, id=42): external_task_ledger";
  const ok = await halt(q, [{ ledger: "yadgar", project: "o/r", call: "mcp__yadgar__task_get(project_id=o/r, id=42)", error: "refused for task_get(project_id=o/r, id=42)" }]);
  assert.equal(ok.result.reason, "intake needs_human: " + q + "; ledgers tried: yadgar (project o/r) mcp__yadgar__task_get(project_id=o/r, id=42): error (as reported by intake agent): refused for task_get(project_id=o/r, id=42)");
});

// The advice filter, extracted from the script (its constants and noAdvice).
function extractNoAdvice() {
  const line = (name) => {
    const i = SOURCE.indexOf("\nconst " + name + " = ");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n", i + 1) + 1);
  };
  const fnOf = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const fn = fnOf("cutText") + fnOf("noAdvice");
  return new Function(["PROJECT_ADVICE_RE", "ADVICE_DROPPED", "LEDGER_CALL_RE", "ADVICE_MAX"].map(line).join("") + fn + "\nreturn noAdvice;")();
}

test("3.1.3 review 8: the advice filter runs in linear time on hostile text and caps its input", () => {
  const noAdvice = extractNoAdvice();
  for (const bad of ["read_task(" + "a=".repeat(5000), "task_get(" + "a=a,".repeat(3000), "find_tasks(" + "a= ".repeat(5000) + "x"]) {
    const t0 = performance.now();
    noAdvice(bad);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, bad.slice(0, 12) + " took " + ms.toFixed(1) + " ms");
  }
  // over 4 KiB: cut, then tested; advice past the cut is never relayed
  const long = "x".repeat(5000) + " set project_id=yadgarhq/docs in iam-db";
  const out = noAdvice(long);
  assert.ok(out.length <= 4096 + 40, String(out.length));
  assert.doesNotMatch(out, /iam-db/);
  const plain = noAdvice("y".repeat(5000));
  assert.equal(plain, "y".repeat(4096) + " (cut)");
  // the quoted call still passes; an unambiguous grammar keeps it exempt
  assert.equal(noAdvice("task_get(project_id=o/r, id=42): external_task_ledger"), "task_get(project_id=o/r, id=42): external_task_ledger");
  assert.equal(noAdvice("read_task(number=671)"), "read_task(number=671)");
  assert.match(noAdvice("task_get(project_id=o/r id=42)"), /dropped/);
});
