// fleet 4.0.0 stream S4 (plan loop): ledger 1980 (cargo/go test_args), 1989
// (caller-grep noise), 1983 (re-plan rounds), 1986 (parked draft and findings
// as planner inputs) and 1991 (confirm "default").
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnSync,
  SOURCE,
  ARGS,
  BRIEF,
  PC,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  sha256,
  canon,
  criteria,
  HAVE_PY,
  sh,
  gitEnv,
  SCRIPTS_SRC,
  FROZEN_VERSIONS,
  CONTRACT_LINE,
  chunkedContentOf,
  redigest,
  PROGRAMS_TEXT,
} from "./harness.mjs";

// A sealed ref message (the shape priorRef in build_task_run.test.mjs makes).
function sealedRef(over) {
  const o = Object.assign(
    {
      branch: "fleet/l42-add-thing",
      plan_path: "docs/plans/x.md",
      plan_sha256: "a".repeat(64),
      criteria: criteria(1),
      brief: BRIEF,
      task_id: "l42",
      slug: "add-thing",
      tldr: "t",
      plan_facts: { allowed_additions: null, est_diff_lines: 10, test_cmd: { command: "pytest <paths>" }, repo_obligations: [], commands: [] },
      history: { runs: 1, replans: 0, agents: 8 },
    },
    over || {},
  );
  o.seal = sha256(canon(o));
  return JSON.stringify(o) + "\n";
}

async function buildFrom(content, over) {
  const s = happy();
  s.__store[PC] = content;
  return runOne(s, Object.assign({
    mode: "build",
    plan_ref: { branch: "fleet/l42-add-thing", plan_commit: PC, plan_ref: "refs/fleet/l42/plan", ref_sha256: sha256(content), repo: "/r" },
    date: "2026-11-04",
    project: "o/r",
  }, over || {}));
}

// A plan whose test_cmd is `command` and whose criteria carry `args` (by index).
function withTestArgs(command, args) {
  const crit = criteria(args.length).map((c, i) => (args[i] === undefined ? c : Object.assign({}, c, { test_args: args[i] })));
  const s = happy({ criteria: crit });
  s["role:scope-and-plan"].test_cmd = { command };
  return s;
}

// ---------------------------------------------------------------- 1980: cargo/go targeting with test_args

test("4.0.0 1980: cargo --test, -p/--package and --exact are accepted; each criterion's command is shown", async () => {
  for (const [command, args] of [
    ["cargo test --all-features", ["--test token_store -- rotate::expired --exact", "-p iam-db --test migrations"]],
    ["cargo test --all-features", ["--package iam-db --test migrations", undefined]],
    ["go test", ["-run TestX ./pkg/...", "-run TestY ./..."]],
  ]) {
    const s = withTestArgs(command, args);
    const out = await runOne(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "awaiting_confirmation", command + " " + out.result.reason);
    const cmds = out.result.commands.filter((c) => c.kind === "test_cmd");
    const want = [{ id: null, command }].concat(args.map((a, i) => (a === undefined ? null : { id: "AC" + (i + 1), command: command + " " + a })).filter(Boolean));
    assert.deepEqual(cmds.map((c) => ({ id: c.id, command: c.command })), want, command);
    for (const c of cmds) assert.equal(c.run_by, "roles");
    // the criterion keeps its test_args in the sealed ref
    const ref = JSON.parse(s.__store[PC]);
    assert.deepEqual(ref.criteria.map((c) => c.test_args), args.map((a) => a));
    assert.deepEqual(ref.plan_facts.commands.filter((c) => c.kind === "test_cmd").length, want.length);
  }
});

test("4.0.0 1980: the cargo allowlist accepts the targeting forms and nothing wider", async () => {
  for (const command of [
    "cargo test --all-features --test token_store -- rotate::expired --exact",
    "cargo test -p iam-db --test migrations",
    "cargo test --package iam_db -q",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", command + " " + out.result.reason);
  }
  for (const command of [
    "cargo test --manifest-path ../x",
    "cargo test --test ../x",
    "cargo test --test",
    "cargo test -p",
    "cargo test -p ../x",
    "cargo test -p 9x",
    "cargo test --package -q",
    "cargo test -Z x",
    "cargo test <paths>",
    "cargo test -- <paths>",
    "cargo test --exact",
    "cargo test --config x",
    "cargo test --target-dir x",
    "go test <paths>",
  ]) {
    const s = happy();
    s["role:scope-and-plan"].test_cmd = { command };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", command);
    assert.equal(out.result.stop_gate, "commands", command);
    assert.ok(!out.labels.includes("role:plan-audit"), command);
  }
});

test("4.0.0 1980: test_args is refused on make, with <paths>, with a disallowed flag, or when not a plain string", async () => {
  for (const [command, arg, why] of [
    ["cargo test --all-features", "--config x", /test_args/],
    ["cargo test --all-features", "--manifest-path ../x", /test_args/],
    ["cargo test --all-features", "--test ../x", /test_args/],
    ["cargo test --all-features", "-Z x", /test_args/],
    ["cargo test --all-features", "<paths>", /test_args/],
    ["cargo test --all-features", "; id", /test_args/],
    ["cargo test --all-features", "", /test_args/],
    ["cargo test --all-features", 7, /test_args/],
    ["go test", "-exec x ./...", /test_args/],
    ["make test", "x", /test_args.*make/],
    ["pytest <paths>", "-k x", /test_args.*<paths>/],
    ["npm test -- <paths>", "x", /test_args/],
  ]) {
    const s = withTestArgs(command, [arg]);
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", command + " + " + JSON.stringify(arg));
    assert.equal(out.result.stop_gate, "commands", command + " + " + JSON.stringify(arg));
    assert.match(out.result.reason, why, command + " + " + JSON.stringify(arg));
    assert.ok(!out.labels.includes("role:plan-audit"), command);
  }
  // null means no test_args
  const ok = await runOne(withTestArgs("cargo test --all-features", [null]), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

test("4.0.0 1980: build mode re-checks every sealed criterion's test_args at load", async () => {
  const facts = { allowed_additions: null, est_diff_lines: 10, test_cmd: { command: "cargo test --all-features" }, repo_obligations: [], commands: [] };
  const bad = await buildFrom(sealedRef({ plan_facts: facts, criteria: [Object.assign(criteria(1)[0], { test_args: "--config x" })] }));
  assert.equal(bad.result.status, "needs_human");
  assert.equal(bad.result.stop_gate, "commands");
  assert.match(bad.result.reason, /AC1 test_args/);
  assert.ok(!bad.labels.includes("infra:verify-plan"));
  const paths = await buildFrom(sealedRef({ plan_facts: Object.assign({}, facts, { test_cmd: { command: "pytest <paths>" } }), criteria: [Object.assign(criteria(1)[0], { test_args: "-k x" })] }));
  assert.equal(paths.result.stop_gate, "commands");
  // a valid sealed test_args passes the load check
  const ok = await buildFrom(sealedRef({ plan_facts: facts, criteria: [Object.assign(criteria(1)[0], { test_args: "--test token_store -- a::b --exact" })] }));
  assert.ok(ok.labels.includes("infra:verify-plan"), ok.result.reason);
});

// ---------------------------------------------------------------- FENCED_FILES (S4 creates it, S5 fills it)

// The top-level definitions `names` of the workflow (a function to its closing
// "\n}\n", a const to its ";\n"), evaluated together, with `over` replacing a
// const's value. Returns the named values.
function defsOf(names, over) {
  const parts = names.map((n) => {
    const fm = new RegExp("\\nfunction " + n + "\\([\\s\\S]*?\\n\\}\\n").exec(SOURCE);
    if (fm) return fm[0];
    const cm = new RegExp("\\nconst " + n + " = [\\s\\S]*?;\\n").exec(SOURCE);
    assert.ok(cm, "definition of " + n);
    return over && n in over ? "\nconst " + n + " = " + over[n] + ";\n" : cm[0];
  });
  return Function(parts.join("") + "\nreturn {" + names.join(", ") + "};")();
}

test("4.0.0 S4: FENCED_FILES is fenced by exact path, case-insensitively (S5 fills it)", () => {
  assert.match(SOURCE, /\nconst FENCED_FILES = \[".fleet-test-db.json"\];\n/);
  const names = ["normPath", "HOOK_PATH_RE", "FENCED_FILES", "fencePathProblem"];
  const empty = defsOf(names);
  assert.equal(empty.fencePathProblem("x.json"), null);
  const d = defsOf(names, { FENCED_FILES: '[".fleet-test-db.json"]' });
  assert.match(d.fencePathProblem(".fleet-test-db.json"), /fleet-fenced file/);
  assert.match(d.fencePathProblem("./.Fleet-Test-DB.json"), /fleet-fenced file/);
  assert.equal(d.fencePathProblem("sub/.fleet-test-db.json"), null);
  assert.equal(d.fencePathProblem(".fleet-test-db.json.bak"), null);
});

// ---------------------------------------------------------------- 1989: caller-grep noise (ADR-1185)

const FOO_DEF = { at: "src/x.rs:10", criterion: "AC1", dont_care: null };
// A plan changing foo, mapped as `occ`; the program finds `hits`, lists `auto`
// as auto dont_care and `doctest` as doctest-collected docs.
function fooPlan(occ, hits, auto, doctest, mk) {
  const s = (mk || happy)();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "foo", occurrences: occ }];
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { foo: hits }, capped: [], auto_dont_care: { foo: auto }, doctest_md: doctest };
  return s;
}

test("4.0.0 1989 AC-1: doc and lock hits the program lists are auto dont_care; the sealed map and the audit show them", async () => {
  const s = fooPlan([FOO_DEF], ["Cargo.lock:88", "README.md:4", "src/x.rs:10"], ["Cargo.lock:88", "README.md:4"], []);
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const ref = JSON.parse(s.__store[PC]);
  assert.deepEqual(ref.plan_facts.changed_symbols, [
    { symbol: "foo", occurrences: [FOO_DEF, { at: "Cargo.lock:88", criterion: null, dont_care: "auto: non-code file" }, { at: "README.md:4", criterion: null, dont_care: "auto: non-code file" }] },
  ]);
  const a = inputsOf(call(out, "role:plan-audit").prompt);
  assert.deepEqual(a.caller_check.auto_dont_care, { foo: ["Cargo.lock:88", "README.md:4"] });
  assert.ok(out.logs.some((l) => /2 doc or lock hit\(s\) mapped/.test(l)));
});

test("4.0.0 1989 AC-2/3: a .txt hit, a doctest-collected doc, or an unlisted doc hit stays a finding", async () => {
  for (const [hits, auto, doctest, miss] of [
    [["notes.txt:3", "src/x.rs:10"], [], [], "notes.txt:3"],
    [["README.md:4", "src/x.rs:10"], [], ["README.md"], "README.md:4"],
    [["Cargo.toml:3", "src/x.rs:10"], [], [], "Cargo.toml:3"],
    [["docs/a.svg:3", "src/x.rs:10"], [], [], "docs/a.svg:3"],
  ]) {
    const out = await runOne(fooPlan([FOO_DEF], hits, auto, doctest), ARGS);
    assert.equal(out.result.status, "needs_human", miss);
    assert.ok(out.logs.concat([out.result.reason]).some((l) => l.includes("foo: " + miss + " is an occurrence")), miss);
  }
});

test("4.0.0 1989: a program auto list the script's own file list refuses halts (no doc, doctest, not a hit)", async () => {
  for (const [hits, auto, doctest] of [
    [["notes.txt:3", "src/x.rs:10"], ["notes.txt:3"], []],
    [["Cargo.toml:3", "src/x.rs:10"], ["Cargo.toml:3"], []],
    [["changelog_gen.py:1", "src/x.rs:10"], ["changelog_gen.py:1"], []],
    [["README.md:4", "src/x.rs:10"], ["README.md:4"], ["README.md"]],
    [["src/x.rs:10"], ["README.md:4"], []],
  ]) {
    const out = await runOne(fooPlan([FOO_DEF], hits, auto, doctest), ARGS);
    assert.equal(out.result.status, "failed", JSON.stringify(auto));
    assert.match(out.result.reason, /auto dont_care for foo, which the script's doc and lock file list refuses/);
    assert.ok(!out.labels.includes("role:plan-audit"));
  }
  // no doctest list: nothing is auto-mapped (fail-safe), the hit is a finding
  const s = fooPlan([FOO_DEF], ["README.md:4", "src/x.rs:10"], ["README.md:4"], []);
  s["infra:callers"].doctest_md = null;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(out.logs.concat([out.result.reason]).some((l) => l.includes("foo: README.md:4 is an occurrence")));
  // a relayed auto list that is not the program's digest halts
  const t = fooPlan([FOO_DEF], ["README.md:4", "src/x.rs:10"], ["README.md:4"], []);
  t.__mutate = { label: "infra:callers", fn: (r) => Object.assign(r, { auto_dont_care: { foo: [] } }) };
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "failed");
  assert.match(o2.result.reason, /infra:callers.*digest/);
});

test("4.0.0 1989: the JS and Python doc/lock classifiers agree", () => {
  const js = defsOf(["DOC_FILE_RE", "NOTE_FILE_RE", "LOCK_FILES", "docOrLockFile"]).docOrLockFile;
  const names = [
    "README.md", "docs/a/b.RST", "x.adoc", "CHANGELOG", "CHANGELOG.md", "changelog.txt", "LICENSE", "LICENSE-MIT", "LICENSE-APACHE-2.0",
    "LICENSE.txt", "Cargo.lock", "sub/uv.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Gemfile.lock", "go.sum",
    "notes.txt", "a.csv", "b.svg", "Cargo.toml", "package.json", "pyproject.toml", "x.yaml", "changelog_gen.py", "LICENSE.py", "CHANGELOG-x.py",
    "README.md.bak", "cargo.LOCK", "x.md/y.py", "go.sum.txt", "license-check.sh",
  ];
  const want = names.map((n) => js(n));
  assert.deepEqual(want.slice(0, 18), Array(18).fill(true));
  assert.deepEqual(want.slice(18), Array(names.length - 18).fill(false));
  // 4.0.1: the Python side lives in scripts/callers.py
  const py = PROGRAMS_TEXT.match(/\nDOC_RE =[\s\S]*?\ndef doc_or_lock\(p\):\n(?: {4}.*\n)+/)[0];
  const r = spawnSync("python3", ["-I", "-c", "import re, json, sys\n" + py + "\nprint(json.dumps([doc_or_lock(p) for p in json.loads(sys.argv[1])]))", JSON.stringify(names)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), want);
});

// Real git: the shipped callers.py over a scratch repo.
function callersRepo(files) {
  const d = mkdtempSync(join(tmpdir(), "fleet-callers-"));
  const env = gitEnv(d, join(d, "gitconfig"));
  writeFileSync(join(d, "gitconfig"), "[user]\n\temail = a@b\n\tname = n\n");
  const wt = join(d, "wt");
  mkdirSync(wt);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(wt, p, ".."), { recursive: true });
    writeFileSync(join(wt, p), body);
  }
  const git = (...a) => {
    const r = spawnSync("git", ["-C", wt].concat(a), { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q", ".");
  git("add", "-A");
  git("commit", "-qm", "x");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "callers.py"), wt, "docs/plans/p.md", JSON.stringify(["foo"]), "100"], { env, encoding: "utf8" });
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("4.0.0 1989 AC-1/3/4 (real git): callers.py classifies doc, lock and doctest-collected hits", () => {
  const base = { "README.md": "a\nb\nc\nfoo\n", "Cargo.lock": "x\nfoo\n", "notes.txt": "foo\n", "src/x.rs": "fn foo() {}\n", "docs/g.rst": "foo\n", "Cargo.toml": "foo = 1\n", "docs/plans/p.md": "foo\n" };
  const o = callersRepo(base);
  assert.deepEqual(o.occurrences.foo, ["Cargo.lock:2", "Cargo.toml:1", "README.md:4", "docs/g.rst:1", "notes.txt:1", "src/x.rs:1"]);
  assert.deepEqual(o.auto_dont_care.foo, ["Cargo.lock:2", "README.md:4", "docs/g.rst:1"]);
  assert.deepEqual(o.doctest_md, []);
  assert.equal(o.program.name, "callers");
  const d = Object.assign({}, o);
  delete d.digest;
  assert.equal(o.digest, sha256(canon(d)));
  // (b) include_str! of the README's basename keeps it mapped; the .rst stays auto
  const rs = callersRepo(Object.assign({}, base, { "src/lib.rs": '#![doc = include_str!("../README.md")]\n' }));
  assert.deepEqual(rs.auto_dont_care.foo, ["Cargo.lock:2", "docs/g.rst:1"]);
  assert.deepEqual(rs.doctest_md, ["README.md"]);
  // (a) a pytest doctest glob keeps every doc mapped
  for (const [f, body] of [
    ["pyproject.toml", '[tool.pytest.ini_options]\naddopts = "--doctest-glob=*.md"\n'],
    ["pytest.ini", "[pytest]\ndoctest_optionflags = ELLIPSIS\n"],
    ["tests/conftest.py", "pytest_plugins = []\n# --doctest-glob\n"],
  ]) {
    const py = callersRepo(Object.assign({}, base, { [f]: body }));
    assert.deepEqual(py.auto_dont_care.foo, ["Cargo.lock:2"], f);
    assert.deepEqual(py.doctest_md, ["README.md", "docs/g.rst"], f);
  }
});

// ---------------------------------------------------------------- 1983: re-plan rounds in every mode, at most 2

const AUTO = { ...ARGS, confirm: "auto" };
const DEFAULT = { ...ARGS, confirm: "default" };
const REFUSE = (finding, criterion) => ({ status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: criterion || "AC1", finding }] });
const APPROVE = { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] };

// happy plus the auto-confirm stubs (intent judge, its hashers, the hook ids)
function gated(over = {}) {
  const s = happy(over);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [],
      coverage: { covered: true, missing: [] },
      classification: { change_kind: "approve", new_behaviour: "approve", quote: "the parser drops NBSP (a regression)" },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
  });
  return Object.assign(s, over.script || {});
}

// a planner round's output: the round-0 stub with `over`
function planRound(s, over) {
  return Object.assign({}, s["role:scope-and-plan"], over);
}

test("4.0.0 1983 AC-1: confirm ask re-plans an untestable_criteria refusal and asks after round 1 approves", async () => {
  const s = happy();
  s["role:plan-audit"] = { status: "ok", reason: "no", verdict: "untestable_criteria", routed_findings: [{ target: "plan", criterion: "AC2", finding: "not observable" }] };
  s["role:plan-audit:audit-fix"] = APPROVE;
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.labels.includes("role:scope-and-plan:audit-fix"));
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix-2"));
  assert.ok(out.logs.some((l) => /plan-audit verdict untestable_criteria: re-plan round 1 of 2/.test(l)));
});

test("4.0.0 1983 AC-2: three audit refusals stop after :audit-fix-2", async () => {
  for (const args of [ARGS, AUTO, DEFAULT]) {
    const s = gated();
    s["role:plan-audit"] = REFUSE("r0");
    s["role:plan-audit:audit-fix"] = REFUSE("r1");
    s["role:plan-audit:audit-fix-2"] = REFUSE("r2");
    const out = await runOne(s, args);
    assert.equal(out.result.status, "needs_human", args.confirm);
    assert.equal(out.result.stop_gate, "role");
    assert.match(out.result.reason, /^plan-audit verdict plan_defect: AC1: r2 \(after 2 re-plan rounds\)/);
    assert.deepEqual(out.labels.filter((l) => l.startsWith("role:scope-and-plan")), ["role:scope-and-plan", "role:scope-and-plan:audit-fix", "role:scope-and-plan:audit-fix-2"]);
    assert.ok(!out.labels.includes("infra:commit-plan"));
  }
});

test("4.0.0 1983 AC-3: script-side re-plans count toward the 2 rounds", async () => {
  const crit = criteria(2);
  crit[1].examples = ["a b"];
  const s = happy({ criteria: crit });
  s["role:scope-and-plan:audit-fix"] = planRound(s, { criteria: criteria(2) });
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { criteria: criteria(2) });
  s["role:plan-audit:audit-fix"] = REFUSE("r1");
  s["role:plan-audit:audit-fix-2"] = REFUSE("r2");
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan-audit verdict plan_defect: AC1: r2 \(after 2 re-plan rounds\)/);
  assert.ok(!out.labels.includes("role:plan-audit"), "round 0 never reached the audit");
  assert.ok(out.logs.some((l) => /confusable character: re-plan round 1 of 2/.test(l)));
  assert.ok(!out.labels.some((l) => /audit-fix-3/.test(l)));
  assert.deepEqual(out.labels.filter((l) => l.startsWith("role:scope-and-plan")), ["role:scope-and-plan", "role:scope-and-plan:audit-fix", "role:scope-and-plan:audit-fix-2"]);
});

test("4.0.0 1983: script-side refusals in every round stop after round 2, never a third", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "foo", occurrences: [{ at: "src/x.py:1", criterion: "AC1", dont_care: null }] }];
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { foo: ["src/x.py:1", "src/y.py:2"] }, capped: [], auto_dont_care: { foo: [] }, doctest_md: [] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /src\/y\.py:2 is an occurrence.*\(after 2 re-plan rounds\)/);
  assert.deepEqual(out.labels.filter((l) => l.startsWith("role:scope-and-plan")), ["role:scope-and-plan", "role:scope-and-plan:audit-fix", "role:scope-and-plan:audit-fix-2"]);
  assert.ok(!out.labels.some((l) => l.startsWith("role:plan-audit")));
});

test("4.0.0 1983: a relaxed round stays relaxed when a later round restores round 0", async () => {
  const s = gated();
  s["role:scope-and-plan"] = planRound(s, { change_kind: "bug_fix", new_behaviour: false });
  s["role:plan-audit"] = REFUSE("r0", "AC1");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { change_kind: "bug_fix", new_behaviour: false, criteria: criteria(1) });
  s["role:plan-audit:audit-fix"] = REFUSE("r1", "AC1");
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { change_kind: "bug_fix", new_behaviour: false });
  s["role:plan-audit:audit-fix-2"] = APPROVE;
  const out = await runOne(s, DEFAULT);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.match(out.result.confirm_reason, /re-plan relaxed: criterion AC2 dropped/);
});

test("4.0.0 1983 AC-4: a symbol named in round 1 and dropped in round 2 stops", async () => {
  const s = happy();
  const occ = (sym) => [{ at: "src/" + sym + ".py:1", criterion: "AC1", dont_care: null }];
  const map = (...syms) => syms.map((x) => ({ symbol: x, occurrences: occ(x) }));
  const grep = (p) => ({ status: "ok", reason: "grepped", occurrences: Object.fromEntries(inputsOf(p).symbols.map((x) => [x, ["src/" + x + ".py:1"]])), capped: [], auto_dont_care: {}, doctest_md: [] });
  s["role:scope-and-plan"].changed_symbols = map("foo");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { changed_symbols: map("foo", "bar") });
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { changed_symbols: map("foo") });
  for (const sfx of ["", ":audit-fix", ":audit-fix-2"]) s["infra:callers" + sfx] = grep;
  s["role:plan-audit"] = REFUSE("r0");
  s["role:plan-audit:audit-fix"] = REFUSE("r1");
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /changed_symbols dropped bar/);
  assert.ok(!out.labels.includes("role:plan-audit:audit-fix-2"));
});

test("4.0.0 1983 AC-6: the round-2 audit and planner see every earlier round's findings and criteria", async () => {
  const s = happy();
  s["role:plan-audit"] = REFUSE("r0 finding", "AC1");
  s["role:plan-audit:audit-fix"] = REFUSE("r1 finding", "AC2");
  s["role:plan-audit:audit-fix-2"] = APPROVE;
  s["role:scope-and-plan:audit-fix"] = planRound(s, { criteria: criteria(3) });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const a = inputsOf(call(out, "role:plan-audit:audit-fix-2").prompt).prior_round;
  assert.deepEqual(a.findings.map((f) => [f.round, f.criterion, f.finding]), [[0, "AC1", "r0 finding"], [1, "AC2", "r1 finding"]]);
  assert.equal(a.criteria_by_round.length, 2);
  assert.deepEqual(a.criteria_by_round[0].map((c) => c.id), ["AC1", "AC2"]);
  assert.deepEqual(a.criteria_by_round[1].map((c) => c.id), ["AC1", "AC2", "AC3"]);
  assert.deepEqual(a.round0, { change_kind: "feature", new_behaviour: true, criteria: criteria(2).map((c) => ({ id: c.id, text: c.text })) });
  // the planner gets the same accumulated prior_round; round 0 gets none
  assert.deepEqual(inputsOf(call(out, "role:scope-and-plan:audit-fix-2").prompt).prior_round, a);
  assert.ok(!("prior_round" in inputsOf(call(out, "role:scope-and-plan").prompt)));
  assert.equal(inputsOf(call(out, "role:plan-audit").prompt).prior_round, null);
  // never sealed
  assert.ok(!s.__store[PC].includes("r1 finding"));
});

test("4.0.0 1983 AC-5: a round that relaxes round 0 is never auto-eligible", async () => {
  const mk = (round1) => {
    const s = gated();
    s["role:scope-and-plan"] = planRound(s, { change_kind: "feature", new_behaviour: true });
    s["role:plan-audit"] = REFUSE("r0", "AC2");
    s["role:scope-and-plan:audit-fix"] = planRound(s, Object.assign({ change_kind: "bug_fix", new_behaviour: false }, round1));
    s["role:plan-audit:audit-fix"] = APPROVE;
    return s;
  };
  const d = await runOne(mk({}), DEFAULT);
  noUnscripted(d);
  assert.equal(d.result.status, "awaiting_confirmation", d.result.reason);
  assert.match(d.result.confirm_reason, /re-plan relaxed: change_kind feature→bug_fix; new_behaviour true→false/);
  assert.ok(!d.labels.includes("role:fleet-intent-judge"));
  // explicit auto: stops for Max with the plan committed
  const a = await runOne(mk({}), AUTO);
  assert.equal(a.result.status, "needs_human");
  assert.equal(a.result.failed_check, "intent");
  assert.equal(a.result.stop_gate, "intent");
  assert.match(a.result.reason, /re-plan relaxed: change_kind feature→bug_fix/);
  assert.equal(a.result.plan_ref.plan_commit, PC);
  assert.match(a.result.needs_max_section, /re-plan relaxed/);
  assert.ok(!a.labels.includes("role:fleet-intent-judge"));
  // no gate agents are counted into the seal when the gates never run
  const sa = mk({});
  await runOne(sa, AUTO);
  const sd = mk({});
  await runOne(sd, DEFAULT);
  assert.equal(JSON.parse(sa.__store[PC]).history.agents, JSON.parse(sd.__store[PC]).history.agents);
  // each condition alone (round 0 is a bug fix without new behaviour, so only the named one fires)
  const base = (round1, r0) => {
    const s = gated();
    s["role:scope-and-plan"] = planRound(s, Object.assign({ change_kind: "bug_fix", new_behaviour: false }, r0 || {}));
    s["role:plan-audit"] = REFUSE("r0", "AC1");
    s["role:scope-and-plan:audit-fix"] = planRound(s, Object.assign({ change_kind: "bug_fix", new_behaviour: false }, round1));
    s["role:plan-audit:audit-fix"] = APPROVE;
    return s;
  };
  const shorter = criteria(2).map((c) => (c.id === "AC2" ? Object.assign({}, c, { text: "b" }) : c));
  for (const [r1, r0, want] of [
    [{ new_behaviour: false }, { new_behaviour: true }, /new_behaviour true→false/],
    [{ criteria: criteria(1) }, {}, /criterion AC2 dropped/],
    [{ criteria: shorter }, {}, /criterion AC2 text shortened with no finding naming it/],
    [{}, { change_kind: "refactor" }, /change_kind refactor→bug_fix/],
  ]) {
    const o = await runOne(base(r1, r0), DEFAULT);
    assert.equal(o.result.status, "awaiting_confirmation", String(want));
    assert.match(o.result.confirm_reason, want);
  }
  // a shorter text the findings asked for, a longer text and an added criterion are not relaxed
  for (const r1 of [
    { criteria: criteria(2).map((c) => (c.id === "AC1" ? Object.assign({}, c, { text: "b" }) : c)) },
    { criteria: criteria(2).map((c) => Object.assign({}, c, { text: c.text + " exactly" })) },
    { criteria: criteria(3) },
  ]) {
    const o = await runOne(base(r1), DEFAULT);
    // eligible: the auto gates ran (the build after them is not this test's business)
    assert.ok(o.labels.includes("role:fleet-intent-judge"), JSON.stringify(r1) + " " + o.result.reason);
    assert.ok(!o.logs.some((l) => /re-plan relaxed/.test(l)), JSON.stringify(r1));
  }
});

// ---------------------------------------------------------------- 1991: confirm "default" (ADR-1186)

function defaultHappy(over = {}) {
  const s = gated(over);
  s["role:scope-and-plan"] = planRound(s, { change_kind: "bug_fix", new_behaviour: false, est_diff_lines: 80 });
  return Object.assign(s, over.script || {});
}

test("4.0.0 1991: CONFIRMS has ask, auto and default; anything else stops before any agent", async () => {
  assert.match(SOURCE, /\nconst CONFIRMS = \["ask", "auto", "default"\];\n/);
  for (const c of ["yes", "Default", ""]) {
    const out = await runOne(happy(), { ...ARGS, confirm: c });
    assert.equal(out.result.status, "needs_human", c);
    assert.match(out.result.reason, /"ask", "auto" or "default"/);
    assert.equal(out.calls.length, 0);
  }
});

test("4.0.0 1991 AC-1: default + bug_fix + new_behaviour false + no IaC builds through the auto gates", async () => {
  const s = defaultHappy();
  const out = await runOne(s, DEFAULT);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.auto_confirmed, true);
  const ij = inputsOf(call(out, "role:fleet-intent-judge").prompt);
  assert.equal(ij.change_kind, "bug_fix");
  assert.equal(ij.new_behaviour, false);
  assert.ok(out.logs.some((l) => /confirm default: eligible/.test(l)));
  const ref = JSON.parse(s.__store[PC]);
  assert.equal(ref.plan_facts.change_kind, "bug_fix");
  assert.equal(ref.plan_facts.new_behaviour, false);
});

test("4.0.0 1991 AC-1: a classification that is missing, refused or has no quote fails G1 in default and auto", async () => {
  const cl = (o) => Object.assign({ change_kind: "approve", new_behaviour: "approve", quote: "the parser drops NBSP" }, o);
  for (const [c, want] of [
    [undefined, /no classification/],
    [null, /no classification/],
    [[], /no classification/],
    [cl({ change_kind: "refuse" }), /classification change_kind "refuse"/],
    [cl({ new_behaviour: "refuse" }), /classification new_behaviour "refuse"/],
    [cl({ change_kind: undefined }), /classification change_kind null/],
    [cl({ new_behaviour: "approved" }), /classification new_behaviour "approved"/],
    [cl({ quote: "" }), /classification quote is empty/],
    [cl({ quote: "   " }), /classification quote is empty/],
    [cl({ quote: undefined }), /classification quote is empty/],
  ]) {
    for (const args of [DEFAULT, AUTO]) {
      const s = defaultHappy();
      const j = Object.assign({}, s["role:fleet-intent-judge"], { __raw: true, role_version: FROZEN_VERSIONS["fleet-intent-judge"], role_contract: CONTRACT_LINE });
      if (c === undefined) delete j.classification;
      else j.classification = c;
      s["role:fleet-intent-judge"] = j;
      const out = await runOne(s, args);
      assert.equal(out.result.status, "needs_human", JSON.stringify(c));
      if (/no classification/.test(String(want))) {
        // REQUIRED_ON_OK (S2): a missing or mistyped classification is contract drift
        assert.equal(out.result.stop_gate, "contract", JSON.stringify(c) + " " + out.result.reason);
        assert.ok(!out.result.failed_check, JSON.stringify(c));
      } else {
        assert.equal(out.result.failed_check, "intent", JSON.stringify(c) + " " + out.result.reason);
        assert.match(out.result.reason, want, JSON.stringify(c));
      }
      assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-test-writer")), JSON.stringify(c));
    }
  }
});

test("4.0.0 1991 AC-2/3/4: default asks for IaC paths, other change kinds, new behaviour, and a task id with no project", async () => {
  const cases = [
    [(s) => (s["role:scope-and-plan"].allowed_additions = { files: ["src/main.tf"], symbols: [], deps: [], settings: [] }), {}, /plan touches IaC path src\/main\.tf/],
    [(s) => (s["role:scope-and-plan"].change_kind = "feature"), {}, /change_kind feature \(only bug_fix skips the confirmation\)/],
    [(s) => (s["role:scope-and-plan"].change_kind = "refactor"), {}, /change_kind refactor/],
    [(s) => (s["role:scope-and-plan"].new_behaviour = true), {}, /new_behaviour true \(only false skips the confirmation\)/],
    [() => {}, { input: "#622", project: undefined }, /task id "#622" with no args\.project/],
    [() => {}, { input: "L42", project: undefined }, /task id "L42" with no args\.project/],
  ];
  for (const [mut, argOver, want] of cases) {
    const s = defaultHappy();
    mut(s);
    const args = Object.assign({}, DEFAULT, argOver);
    if (argOver.project === undefined && "project" in argOver) delete args.project;
    const out = await runOne(s, args);
    assert.equal(out.result.status, "awaiting_confirmation", String(want) + " " + out.result.reason);
    assert.match(out.result.confirm_reason, want);
    assert.ok("ledger_source" in out.result);
    assert.ok(!out.labels.includes("role:fleet-intent-judge"), String(want));
    assert.ok(out.logs.some((l) => /confirm default: asking Max/.test(l)));
  }
  // a test file under an IaC-looking dir in a mapped occurrence counts too
  const s = defaultHappy();
  s["role:scope-and-plan"].changed_symbols = [{ symbol: "foo", occurrences: [{ at: "infra/vars.tfvars:3", criterion: "AC1", dont_care: null }] }];
  s["infra:callers"] = { status: "ok", reason: "grepped", occurrences: { foo: ["infra/vars.tfvars:3"] }, capped: [], auto_dont_care: { foo: [] }, doctest_md: [] };
  const o = await runOne(s, DEFAULT);
  assert.equal(o.result.status, "awaiting_confirmation", o.result.reason);
  assert.match(o.result.confirm_reason, /plan touches IaC path infra\/vars\.tfvars/);
});

test("4.0.0 1991: ask never runs the gates for an eligible plan; build mode default re-runs no gates", async () => {
  const out = await run(defaultHappy(), ARGS, { confirm: "default" });
  assert.equal(out.planResult.status, "awaiting_confirmation");
  assert.ok(!("confirm_reason" in out.planResult));
  assert.ok(!out.labels.includes("role:fleet-intent-judge"));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.build.labels.some((l) => /intent/.test(l)));
});

test("4.0.0 1991: the agent count sealed in the ref covers the gate agents only when they run", async () => {
  const yes = defaultHappy();
  await runOne(yes, DEFAULT);
  const no = defaultHappy();
  no["role:scope-and-plan"].change_kind = "chore";
  await runOne(no, DEFAULT);
  const ask = defaultHappy();
  await runOne(ask, ARGS);
  const n = (s) => JSON.parse(s.__store[PC]).history.agents;
  assert.equal(n(no), n(ask));
  assert.equal(n(yes) - n(no), 4);
});

test("4.0.0 1991: isShortPath reads the sealed plan facts (S5 switches the build to it)", () => {
  const { isShortPath, MAX_SHORT_TEST_ROUNDS } = defsOf(["SHORT_PATH_MAX_DIFF", "MAX_SHORT_TEST_ROUNDS", "isShortPath"]);
  assert.equal(MAX_SHORT_TEST_ROUNDS, 2);
  assert.equal(isShortPath({ est_diff_lines: 19, new_behaviour: false }), true);
  assert.equal(isShortPath({ est_diff_lines: 20, new_behaviour: false }), false);
  assert.equal(isShortPath({ est_diff_lines: 5, new_behaviour: true }), false);
  assert.equal(isShortPath({ est_diff_lines: 5, new_behaviour: null }), false);
  assert.equal(isShortPath({ est_diff_lines: null, new_behaviour: false }), false);
  assert.equal(isShortPath(null), false);
});


test("4.0.0 1991: intentProblems (G1) refuses every classification defect on its own", () => {
  const { intentProblems } = defsOf(["intentProblems"]);
  const ok = { status: "ok", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "q" } };
  assert.deepEqual(intentProblems(ok), []);
  const w = (c) => intentProblems(Object.assign({}, ok, { classification: c }));
  for (const c of [undefined, null, [], "approve"]) assert.deepEqual(w(c), ["no classification of change_kind and new_behaviour"], JSON.stringify(c));
  assert.deepEqual(w({ change_kind: "refuse", new_behaviour: "approve", quote: "q" }), ['classification change_kind "refuse" (needs approve)']);
  assert.deepEqual(w({ new_behaviour: "approve", quote: "q" }), ["classification change_kind null (needs approve)"]);
  assert.deepEqual(w({ change_kind: "approve", new_behaviour: "refuse", quote: "q" }), ['classification new_behaviour "refuse" (needs approve)']);
  assert.deepEqual(w({ change_kind: "approve", new_behaviour: "approve" }), ["classification quote is empty (needs a verbatim quote from the task)"]);
  assert.deepEqual(w({ change_kind: "approve", new_behaviour: "approve", quote: " " }), ["classification quote is empty (needs a verbatim quote from the task)"]);
  assert.deepEqual(w({ change_kind: "approve", new_behaviour: "approve", quote: 7 }), ["classification quote is empty (needs a verbatim quote from the task)"]);
});


// ---------------------------------------------------------------- 1986: parked draft and findings as planner inputs

const PRUN = "n0-1234567";
// a load-parked stub: the draft and findings of run PRUN
function parkedOut(findings, over) {
  const p = Object.assign({ run: PRUN, plan_path: "docs/plans/x.md", draft_chunks: ["# draft plan\n", "more"], findings_chunks: findings === null ? [] : chunksOf(JSON.stringify(findings)) }, over || {});
  return (prompt) => {
    const i = inputsOf(prompt);
    return { status: "ok", reason: "read", parked: p, args: [i.scratch, i.plan_tip_time === null ? "null" : String(i.plan_tip_time)] };
  };
}
function chunksOf(t) {
  const out = [];
  for (let i = 0; i < t.length; i += 1000) out.push(t.slice(i, i + 1000));
  return out;
}
const R0 = { round: 0, findings: [{ criterion: "AC1", finding: "parked f0" }], criteria: criteria(2).map((c) => ({ id: c.id, text: c.text })), change_kind: "feature", new_behaviour: true };

test("4.0.0 1986 AC-1: a parked draft and findings reach the planner as inputs only; never sources, never sealed", async () => {
  const s = happy();
  s["infra:load-parked"] = parkedOut({ reason: "plan-audit verdict plan_defect", rounds: [R0], symbols: [], plan_path: "docs/plans/x.md" });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const l = out.labels;
  assert.ok(l.indexOf("infra:branch-scan") < l.indexOf("infra:load-parked") && l.indexOf("infra:load-parked") < l.indexOf("role:scope-and-plan"));
  const pin = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.deepEqual(pin.prior_draft, { run: PRUN, plan_path: "docs/plans/x.md", text: "# draft plan\nmore" });
  assert.deepEqual(pin.brief.sources, BRIEF.sources, "brief.sources unchanged");
  assert.deepEqual(pin.prior_round.findings, [{ criterion: "AC1", finding: "parked f0", round: 0 }]);
  assert.deepEqual(pin.prior_round.round0, { change_kind: "feature", new_behaviour: true, criteria: R0.criteria });
  assert.deepEqual(pin.prior_round.criteria_by_round, [R0.criteria]);
  assert.match(pin.prior_round.reason, /parked run n0-1234567: plan-audit verdict plan_defect/);
  // the audit gets prior_round; neither reaches the seal
  assert.deepEqual(inputsOf(call(out, "role:plan-audit").prompt).prior_round.findings, pin.prior_round.findings);
  assert.ok(!("prior_draft" in inputsOf(call(out, "role:plan-audit").prompt)));
  const sealed = s.__store[PC];
  for (const x of ["prior_draft", "prior_round", "parked", "draft plan", "parked f0"]) assert.ok(!sealed.includes(x), x);
  // the used folder moves to parked/used/ after the commit (in the commit step)
  const cp = call(out, "infra:commit-plan").prompt;
  assert.match(cp, /mkdir -p '\/r\/\.claude\/worktrees\/fleet-l42-add-thing\/scratch\/parked\/used' && mv -n -- '\/r\/\.claude\/worktrees\/fleet-l42-add-thing\/scratch\/parked\/n0-1234567'/);
  assert.ok(out.logs.some((l) => /parked draft of run n0-1234567 loaded \(docs\/plans\/x\.md\), 1 finding\(s\): planner inputs only/.test(l)));
});

test("4.0.0 1986 AC-2: no judge gets prior_draft or prior_round", async () => {
  const s = defaultHappy();
  s["infra:load-parked"] = parkedOut({ reason: "x", rounds: [Object.assign({}, R0, { change_kind: "bug_fix", new_behaviour: false })], symbols: [] });
  const out = await runOne(s, DEFAULT);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const c of out.calls.filter((x) => /^role:(fleet-intent-judge|fleet-test-judge|fleet-code-judge|pr-review|fleet-test-writer|fleet-coder|fleet-pr-opener)/.test(x.label))) {
    const i = inputsOf(c.prompt);
    assert.ok(!("prior_draft" in i) && !("prior_round" in i), c.label);
    assert.ok(!c.prompt.includes("parked f0") && !c.prompt.includes("# draft plan"), c.label);
  }
  assert.ok(out.labels.includes("role:fleet-intent-judge"));
});

test("4.0.0 1986 AC-3: no parked folder -> no extra planner input; the reader gets the scan's plan tip time", async () => {
  const s = happy();
  s["infra:branch-scan"] = { status: "ok", reason: "scanned", commits: [], refs: [], plan_tip_time: 1700000123 };
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const pin = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.ok(!("prior_draft" in pin) && !("prior_round" in pin));
  const lp = call(out, "infra:load-parked");
  assert.equal(inputsOf(lp.prompt).plan_tip_time, 1700000123);
  assert.match(lp.prompt, /parked\.py' 'read' '\/r\/\.claude\/worktrees\/fleet-l42-add-thing\/scratch' '1700000123'/);
  assert.equal(lp.opts.agentType, "fleet:judge");
  // a relayed tip time that is not the program's stops at the scan
  const t = happy();
  t["infra:branch-scan"] = { status: "ok", reason: "scanned", commits: [], refs: [], plan_tip_time: 5 };
  t.__mutate = { label: "infra:branch-scan", fn: (r) => Object.assign(r, { plan_tip_time: 9999999999 }) };
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "failed");
  assert.match(o2.result.reason, /infra:branch-scan: the relayed lists do not match the program's digest/);
  assert.ok(!o2.labels.includes("infra:load-parked"));
  // no plan commit: null
  const n = await runOne(happy(), ARGS);
  assert.equal(inputsOf(call(n, "infra:load-parked").prompt).plan_tip_time, null);
  assert.match(call(n, "infra:load-parked").prompt, /scratch' 'null'/);
});

test("4.0.0 1986 AC-4: a parked read that is unusable is ignored with a gate line; the run goes on", async () => {
  const good = parkedOut({ reason: "x", rounds: [R0], symbols: [] });
  const cases = [
    ["digest", (r) => Object.assign(r, { parked: Object.assign({}, r.parked, { draft_chunks: ["# other"] }) }), /the relay does not match the program's digest/],
    ["program", (r) => Object.assign(r, { program: { name: "parked", sha256: "0".repeat(64) } }), /did not run the shipped program parked/],
    ["args", (r, p) => redigest("infra:load-parked", Object.assign(r, { args: ["/elsewhere", "null"] }), p), /ran on other arguments/],
    ["failed", () => ({ status: "failed", reason: "boom" }), /returned failed/],
    ["dead", () => null, /returned nothing/],
    ["run", (r, p) => redigest("infra:load-parked", Object.assign(r, { parked: Object.assign({}, r.parked, { run: "../x" }) }), p), /unusable shape/],
    ["chunk", (r, p) => redigest("infra:load-parked", Object.assign(r, { parked: Object.assign({}, r.parked, { draft_chunks: ["x".repeat(1001)] }) }), p), /unusable shape/],
    ["path", (r, p) => redigest("infra:load-parked", Object.assign(r, { parked: Object.assign({}, r.parked, { plan_path: "/etc/x.md" }) }), p), /plan_path/],
  ];
  for (const [what, fn, want] of cases) {
    const s = happy();
    s["infra:load-parked"] = good;
    s.__mutate = { label: "infra:load-parked", fn };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", what + " " + out.result.reason);
    assert.ok(out.logs.some((l) => /^parked draft ignored \(/.test(l) && want.test(l)), what + ": " + out.logs.filter((l) => /parked/.test(l)).join(" | "));
    const pin = inputsOf(call(out, "role:scope-and-plan").prompt);
    assert.ok(!("prior_draft" in pin) && !("prior_round" in pin), what);
    assert.ok(!call(out, "infra:commit-plan").prompt.includes("parked/used"), what);
  }
  // unparseable findings: the draft alone is used
  const s = happy();
  s["infra:load-parked"] = parkedOut(null, { findings_chunks: ["{not json"] });
  const out = await runOne(s, ARGS);
  const pin = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.equal(pin.prior_draft.run, PRUN);
  assert.ok(!("prior_round" in pin));
});

test("4.0.0 1983 AC-7: a parked prior_round with no round 0 is relaxed (fail closed) under default", async () => {
  const s = defaultHappy();
  s["infra:load-parked"] = parkedOut({ reason: "x", rounds: [Object.assign({}, R0, { round: 1, change_kind: "bug_fix", new_behaviour: false })], symbols: [] });
  const out = await runOne(s, DEFAULT);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(out.result.confirm_reason, "re-plan relaxed: no round0 (fail closed)");
  assert.ok(!out.labels.includes("role:fleet-intent-judge"));
  // a parked round 0 that was a feature: the new run's bug_fix is relaxed across runs
  const t = defaultHappy();
  t["infra:load-parked"] = parkedOut({ reason: "x", rounds: [R0], symbols: [] });
  const o2 = await runOne(t, DEFAULT);
  assert.match(o2.result.confirm_reason, /re-plan relaxed: change_kind feature→bug_fix; new_behaviour true→false/);
  // a parked round 0 that matches: eligible
  const u = defaultHappy();
  u["infra:load-parked"] = parkedOut({ reason: "x", rounds: [Object.assign({}, R0, { change_kind: "bug_fix", new_behaviour: false })], symbols: [] });
  const o3 = await runOne(u, DEFAULT);
  assert.equal(o3.result.status, "ok", o3.result.reason);
  // the parked symbols are carried: dropping one stops
  const v = happy();
  v["infra:load-parked"] = parkedOut({ reason: "x", rounds: [R0], symbols: ["guard_verdict"] });
  const o4 = await runOne(v, ARGS);
  assert.equal(o4.result.status, "needs_human");
  assert.match(o4.result.reason, /changed_symbols dropped guard_verdict after the parked run n0-1234567/);
});

test("4.0.0 1986: a plan stop parks the draft with findings.json of every refused round", async () => {
  const s = happy();
  s["role:plan-audit"] = REFUSE("r0");
  s["role:plan-audit:audit-fix"] = REFUSE("r1", "AC2");
  s["role:plan-audit:audit-fix-2"] = REFUSE("r2");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { change_kind: "bug_fix" });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  const pk = call(out, "infra:park-plan").prompt;
  assert.match(pk, /parked\.py' 'write' '\/r\/\.claude\/worktrees\/fleet-l42-add-thing\/scratch' 'n1-0000001' '\/r\/\.claude\/worktrees\/fleet-l42-add-thing\/scratch\/park-chunks-n1-0000001'/);
  const f = JSON.parse(chunkedContentOf(pk));
  assert.equal(f.plan_path, "docs/plans/x.md");
  assert.match(f.reason, /^plan-audit verdict plan_defect: AC1: r2 \(after 2 re-plan rounds\)/);
  assert.deepEqual(f.rounds.map((r) => [r.round, r.change_kind, r.findings.map((x) => x.finding)]), [[0, "feature", ["r0"]], [1, "bug_fix", ["r1"]], [2, "feature", ["r2"]]]);
  assert.deepEqual(f.rounds[0].criteria, criteria(2).map((c) => ({ id: c.id, text: c.text })));
  assert.ok(!("findings" in inputsOf(pk)), "the chunks are not repeated in the inputs");
  // a stop before any refused round still parks the draft, with no rounds
  const t = happy();
  t["role:scope-and-plan"].plan_diff = [];
  const o2 = await runOne(t, ARGS);
  const f2 = JSON.parse(chunkedContentOf(call(o2, "infra:park-plan").prompt));
  assert.deepEqual(f2.rounds, []);
});

// Real python: parked.py write then read.
test("4.0.0 1986 (real python): parked.py writes findings from checked chunks and reads the newest folder past the tip", () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-parked-"));
  const prog = join(SCRIPTS_SRC, "parked.py");
  const py = (...a) => spawnSync("python3", ["-I", prog].concat(a), { encoding: "utf8" });
  try {
    const scratch = join(d, "scratch");
    mkdirSync(join(scratch, "parked", "r-000001", "docs", "plans"), { recursive: true });
    writeFileSync(join(scratch, "parked", "r-000001", "docs", "plans", "x.md"), "# old draft\n");
    const msg = JSON.stringify({ reason: "why", rounds: [R0], symbols: [], plan_path: "docs/plans/x.md" });
    const b64 = Buffer.from(msg, "utf8").toString("base64");
    const cdir = join(scratch, "pc");
    mkdirSync(cdir);
    const parts = [b64.slice(0, 40), b64.slice(40)];
    parts.forEach((x, i) => writeFileSync(join(cdir, i + ".b64"), i === 1 ? x.replace(/^./, (c) => (c === "A" ? "B" : "A")) : x));
    const shas = JSON.stringify(parts.map((x, i) => ({ i, sha256: sha256(x) })));
    let w = py("write", scratch, "r-000001", cdir, "2", sha256(msg), shas);
    assert.equal(w.status, 3, w.stderr);
    assert.deepEqual(JSON.parse(w.stdout), { bad_chunks: [1] });
    assert.ok(!existsSync(join(scratch, "parked", "r-000001", "findings.json")));
    writeFileSync(join(cdir, "1.b64"), parts[1]);
    w = py("write", scratch, "r-000001", cdir, "2", sha256(msg), shas);
    assert.equal(w.status, 0, w.stderr);
    assert.equal(readFileSync(join(scratch, "parked", "r-000001", "findings.json"), "utf8"), msg);
    assert.ok(!existsSync(cdir), "the chunk dir is removed");
    // a chunk dir outside the scratch dir and a bad run name are refused
    assert.notEqual(py("write", scratch, "r-000001", d, "2", sha256(msg), shas).status, 0);
    assert.notEqual(py("write", scratch, "../x", join(scratch, "q"), "2", sha256(msg), shas).status, 0);
    assert.notEqual(py("write", scratch, "used", join(scratch, "q"), "2", sha256(msg), shas).status, 0);
    // read: the folder and its files are newer than tip 1000
    const now = Math.floor(Date.now() / 1000);
    let r = py("read", scratch, "1000");
    assert.equal(r.status, 0, r.stderr);
    let o = JSON.parse(r.stdout);
    assert.deepEqual(o.args, [scratch, "1000"]);
    assert.equal(o.parked.run, "r-000001");
    assert.equal(o.parked.plan_path, "docs/plans/x.md");
    assert.equal(o.parked.draft_chunks.join(""), "# old draft\n");
    assert.equal(o.parked.findings_chunks.join(""), msg);
    assert.ok(o.parked.findings_chunks.every((x) => x.length <= 1000));
    assert.equal(o.program.name, "parked");
    const dg = Object.assign({}, o);
    delete dg.digest;
    assert.equal(o.digest, sha256(canon(dg)));
    // older than the plan tip: ignored
    o = JSON.parse(py("read", scratch, String(now + 100)).stdout);
    assert.equal(o.parked, null);
    // the newest folder wins; used/ and a symlinked folder are skipped
    mkdirSync(join(scratch, "parked", "r-000002"));
    writeFileSync(join(scratch, "parked", "r-000002", "p.md"), "# newer\n");
    utimesSync(join(scratch, "parked", "r-000002", "p.md"), now + 50, now + 50);
    mkdirSync(join(scratch, "parked", "used", "r-000009"), { recursive: true });
    writeFileSync(join(scratch, "parked", "used", "r-000009", "z.md"), "# used\n");
    utimesSync(join(scratch, "parked", "used", "r-000009", "z.md"), now + 90, now + 90);
    o = JSON.parse(py("read", scratch, "null").stdout);
    assert.equal(o.parked.run, "r-000002");
    assert.equal(o.parked.plan_path, "p.md");
    assert.deepEqual(o.parked.findings_chunks, []);
    assert.deepEqual(o.args, [scratch, "null"]);
    // bad tip
    assert.notEqual(py("read", scratch, "-1").status, 0);
    // no parked dir
    o = JSON.parse(py("read", join(d, "none"), "null").stdout);
    assert.equal(o.parked, null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("4.0.0 1991: SKILL.md passes confirm default and documents confirm_reason and ledger_source", () => {
  const skill = readFileSync(join(SCRIPTS_SRC, "..", "skills", "build-task", "SKILL.md"), "utf8");
  assert.match(skill, /Pass `confirm: "default"` unless the user named a mode \(ADR-1186\)/);
  assert.match(skill, /confirm: "<default \| ask \| auto>"/);
  assert.match(skill, /`confirm: "default"`: the result is one of three/);
  assert.match(skill, /show\s+`confirm_reason`/);
  assert.match(skill, /`ledger_source`, when it is not null: the ledger \(`ledger` or `yaadgaar`\)/);
  assert.match(skill, /not a security boundary/);
});

test("4.0.0 1983: a contract-drift retry is not a re-plan round", async () => {
  const drift = (s) => Object.assign({}, s["role:scope-and-plan"], { __raw: true, role_version: FROZEN_VERSIONS["scope-and-plan"], role_contract: CONTRACT_LINE });
  const s = happy();
  const good = s["role:scope-and-plan"];
  s["role:scope-and-plan"] = drift(s);
  s["role:scope-and-plan:retry"] = good;
  s["role:scope-and-plan:audit-fix"] = good;
  s["role:scope-and-plan:audit-fix-2"] = good;
  s["role:plan-audit"] = REFUSE("r0");
  s["role:plan-audit:audit-fix"] = REFUSE("r1");
  s["role:plan-audit:audit-fix-2"] = APPROVE;
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.ok(out.labels.includes("role:scope-and-plan:retry"), out.labels.join(", "));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.labels.includes("role:plan-audit:audit-fix-2"));
  // a drift inside a round retries that round's step; the round count is unchanged
  const t = happy();
  t["role:scope-and-plan:audit-fix"] = drift(t);
  t["role:scope-and-plan:audit-fix:retry"] = t["role:scope-and-plan"];
  t["role:plan-audit"] = REFUSE("r0");
  t["role:plan-audit:audit-fix"] = REFUSE("r1");
  t["role:plan-audit:audit-fix-2"] = APPROVE;
  const o2 = await runOne(t, ARGS);
  noUnscripted(o2);
  assert.ok(o2.labels.includes("role:scope-and-plan:audit-fix:retry"), o2.labels.join(", "));
  assert.equal(o2.result.status, "awaiting_confirmation", o2.result.reason);
  assert.ok(o2.labels.includes("role:plan-audit:audit-fix-2"));
});
