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

test("4.0.0 S4: FENCED_FILES is fenced by exact path, case-insensitively, and starts empty", () => {
  assert.match(SOURCE, /\nconst FENCED_FILES = \[\];\n/);
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
  const py = SOURCE.match(/\nDOC_RE = [\s\S]*?\ndef doc_or_lock\(p\):\n(?: {4}.*\n)+/)[0];
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
