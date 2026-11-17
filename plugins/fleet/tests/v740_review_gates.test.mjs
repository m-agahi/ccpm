// fleet 7.4.0 review (A-M2, A-M3, A-M4, A-m1): the workflow side of the security findings.
// - A-M2: the open PR's head is the script's expected head (the approved sha the push checked on
//   the remote), never the replan-reset agent's superseded_head; a superseded_head that differs
//   stops the run. The push after the rebuilt commit passes [parent, tree] to push.py; every other
//   push passes "-" "-".
// - A-M3: a writer may change the [tool.pytest] table of a pyproject.toml it owns only when that
//   file is new in the round (MISSING in the pre-writer map). The hasher flags a new (not in HEAD)
//   pyproject.toml whose pytest table loads a plugin (-p), deselects or filters tests (--deselect,
//   -k, -m, --ignore), sets python_files/python_classes/python_functions/norecursedirs, or has
//   testpaths that leave out a frozen test file; a suspicious path stops the freeze.
// - A-M4: the coder's test_conflict is capped (test, why and each finding at 2000 characters, at
//   most 20 findings) and logged through logPath; under unattended, a plan_wrong that a coder test
//   conflict started asks (the re-plan is ready), never an automatic re-plan build.
// - A-m1: the push tail and the IaC list of an unattended re-plan go through logPath.
//
// dont_care: the gate-log wording beyond the pinned phrases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ARGS, PB, PC, PSHA, FP_K1, FP_PRE, FP_TESTS, H, happy, run, runOne, call, inputsOf, commitStub, pushArgsOf,
  scratchRepo, sh, runHasher, HAVE_PY,
} from "./harness.mjs";

const U = { ...ARGS, unattended: true };
const PC2 = "0123456789ab";
const CONFLICT = { test: "tests/test_a.py", findings: ["S1"], why: "the test expects 3 but AC1's example says 4" };
const coderConflict = (tc) => ({ status: "needs_human", reason: "frozen test contradicts AC1", changed_paths: null, suite_result: null, added_symbols: null, frozen_tests_red_at_start: null, obligations_done: null, test_conflict: tc || CONFLICT });
const PLAN_WRONG = { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC1", finding: "AC1 example conflicts — Proposed plan change: fix AC1's example" }], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 1 }, gates_not_run: [], obligations_check: [] };
function replanStubs(s) {
  return Object.assign(s, {
    "infra:replan-worktree": [{ status: "ok", reason: "ok", head: PC }, { status: "ok", reason: "ok", head: PC2 }],
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: PSHA },
    "infra:commit-plan:replan": [commitStub(s.__store, PC2, PSHA), commitStub(s.__store, "0123456789cd", PSHA)],
    "infra:replan-reset": (p) => ({ status: "ok", reason: "reset", head: PB, superseded_head: inputsOf(p).expected_head }),
    "hasher:pre-intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "hasher:fp-post:intent:replan": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  });
}
function gated() {
  const s = happy();
  return Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
}
const decisions = (out) => (out.result.auto_decisions || []).map((d) => d.gate + ": " + d.decision + " (" + d.reason + ")");

// ---------------------------------------------------------------- A-M2

test("7.4.0 review A-M2: a replan-reset superseded_head other than the script's expected head stops the run", async () => {
  const s = replanStubs(happy());
  s["role:fleet-coder:r1"] = coderConflict();
  s["role:fleet-code-judge:r1"] = PLAN_WRONG;
  s["infra:replan-reset"] = { status: "ok", reason: "reset", head: PB, superseded_head: "5555555" };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /infra:replan-reset: superseded_head 5555555 is not [0-9a-f]+/);
});

test("7.4.0 review A-M2: a plain push passes no parent and no tree, and the sealed URL", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const a = pushArgsOf(call(out.build, "infra:push").prompt);
  assert.equal(a.length, 12, JSON.stringify(a));
  assert.deepEqual(a.slice(9), ["git@github.com:o/r.git", "-", "-"]);
});

// ---------------------------------------------------------------- A-M3

const T = ["tests/test_a.py", "pyproject.toml"];
const crit = [
  { id: "AC1", text: "behaviour 1", test_files: T },
  { id: "AC2", text: "behaviour 2", test_files: ["tests/test_b.py"] },
];
const POST = { "tests/test_a.py": "ha", "tests/test_b.py": "hb", "pyproject.toml": "pp1", "pyproject.toml#tool.pytest": "hp1" };
function route(pre) {
  const s = happy({ criteria: crit });
  s["role:fleet-test-writer:AC1:r1"] = Object.assign({}, s["role:fleet-test-writer:AC1:r1"], { files: T.slice() });
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: FP_PRE, hashes: H(pre) };
  s["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py", "pyproject.toml"], hashes: H(POST) };
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_TESTS, hashes: H(POST) };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: H(POST) };
  return s;
}

test("7.4.0 review A-M3: an owned pyproject.toml that already exists: a writer change to its [tool.pytest] table stops at ownership", async () => {
  const out = await run(route({ "tests/test_b.py": "hb0", "pyproject.toml": "pp0", "pyproject.toml#tool.pytest": "hp0" }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /pyproject\.toml#tool\.pytest/);
});

test("7.4.0 review A-M3: an owned pyproject.toml new in the round (MISSING before the writers) is accepted", async () => {
  const out = await run(route({ "tests/test_b.py": "hb0", "pyproject.toml": "MISSING" }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
});

function pp(wt, body, commit) {
  writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "x"\nversion = "0"\n\n' + body);
  if (commit) {
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-q", "-m", "pp");
  }
}
function hashed(body, commit) {
  const wt = scratchRepo("fleet-740r-pp-");
  try {
    mkdirSync(join(wt, "tests"));
    writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    assert True\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-q", "-m", "base");
    pp(wt, body, commit);
    return runHasher(wt, "hash", ["tests/test_a.py", "pyproject.toml"]).suspicious;
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

test("7.4.0 review A-M3: the hasher flags a new pyproject.toml whose pytest table loads a plugin, deselects, filters or narrows", { skip: !HAVE_PY && "no tomllib" }, () => {
  const bad = [
    '[tool.pytest.ini_options]\naddopts = "-q -p no:randomly"\n',
    '[tool.pytest.ini_options]\naddopts = "-pmyplugin"\n',
    '[tool.pytest.ini_options]\naddopts = "--deselect tests/test_a.py::test_a"\n',
    '[tool.pytest.ini_options]\naddopts = ["--deselect=tests/test_a.py::test_a"]\n',
    '[tool.pytest.ini_options]\naddopts = "-k not_a"\n',
    '[tool.pytest.ini_options]\naddopts = "-m slow"\n',
    '[tool.pytest.ini_options]\naddopts = "--ignore=tests"\n',
    '[tool.pytest]\naddopts = ["-p", "x"]\n',
    '[tool.pytest.ini_options]\npython_functions = ["check_*"]\n',
    '[tool.pytest.ini_options]\npython_files = ["x_*.py"]\n',
    '[tool.pytest.ini_options]\ntestpaths = ["other"]\n',
    '[tool.pytest.ini_options]\naddopts = "-q \'unclosed"\n',
  ];
  for (const b of bad) {
    const sus = hashed(b, false);
    assert.ok(sus.some((x) => /^runner config narrows the tests in a new pyproject\.toml: /.test(x)), b + " -> " + JSON.stringify(sus));
  }
  // what stays allowed: a plain table, covering testpaths, and any existing (committed) file
  for (const b of ['[tool.pytest.ini_options]\naddopts = "-q"\n', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\naddopts = ["-ra", "--strict-markers"]\n', "[tool.ruff]\nline-length = 100\n"])
    assert.deepEqual(hashed(b, false), [], b);
  assert.deepEqual(hashed('[tool.pytest.ini_options]\naddopts = "-p no:cacheprovider"\n', true), [], "an existing pyproject.toml is not flagged");
});

// ---------------------------------------------------------------- A-M4, A-m1

test("7.4.0 review A-M4: the coder's test_conflict is capped and its gate line goes through logPath", async () => {
  const s = replanStubs(happy());
  const long = "w".repeat(5000);
  const many = Array.from({ length: 30 }, (_, i) => "S" + i + String.fromCharCode(27) + "[2Kforged gate line");
  s["role:fleet-coder:r1"] = coderConflict({ test: "tests/test_a.py", findings: many, why: long });
  s["role:fleet-code-judge:r1"] = PLAN_WRONG;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const tc = inputsOf(call(out, "role:fleet-code-judge:r1").prompt).test_conflict;
  assert.equal(tc.why.length, 2000);
  assert.equal(tc.findings.length, 20);
  const line = out.logs.find((l) => /the coder names a test conflict/.test(l));
  assert.ok(line, out.logs.join("\n"));
  assert.ok(line.indexOf(String.fromCharCode(27)) < 0, JSON.stringify(line));
});

test("7.4.0 review A-m1: the push tail in a stop reason goes through logPath (CR, LF, U+2028)", async () => {
  const s = happy();
  const sep = String.fromCharCode(0x2028);
  s["infra:push"] = (prompt) => ({ status: "ok", reason: "pushed", push_result: "network", exit_code: 128, hook_tail: "", tail: "a\rforged" + sep + "line\nfatal: unable to access", attempts: 1, remote_head: null });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.match(out.result.reason, /push_result "network"/);
  assert.ok(![13, 0x2028].some((c) => out.result.reason.indexOf(String.fromCharCode(c)) >= 0), JSON.stringify(out.result.reason));
});

test("7.4.0 review A-M4: unattended, a coder test conflict's plan_wrong asks with the re-plan ready; no automatic re-plan build", async () => {
  const s = replanStubs(gated());
  s["role:fleet-intent-judge:replan"] = s["role:fleet-intent-judge"];
  s["role:fleet-coder:r1"] = coderConflict();
  s["role:fleet-code-judge:r1"] = PLAN_WRONG;
  const out = await runOne(s, U);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(decisions(out).some((d) => /^plan_wrong: ask \(code-judge re-plan 1: the plan_wrong started from a coder test conflict\)$/.test(d)), decisions(out).join("\n"));
  assert.ok(!out.labels.includes("role:fleet-intent-judge:replan"), out.labels.join(", "));
  assert.ok(out.result.plan_ref, "the re-plan is ready");
  // the same plan_wrong without a test conflict still builds unattended (the 6.3.0 rule)
  const t = replanStubs(gated());
  t["role:fleet-intent-judge:replan"] = t["role:fleet-intent-judge"];
  t["role:fleet-code-judge:r1"] = [PLAN_WRONG, happy()["role:fleet-code-judge:r1"]];
  const b = await runOne(t, U);
  assert.ok(decisions(b).some((d) => /^plan_wrong: build \(code-judge re-plan 1: /.test(d)), decisions(b).join("\n"));
});
