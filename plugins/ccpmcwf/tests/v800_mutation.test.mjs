// fleet 8.0.0 car G5: the mutation gate (#7, gate 2; ADR-1316), plus step 0 (security review of
// G4, finding 1: the held-out result must not fail open across rounds).
//
// mutants.py <worktree> <base> <tree> <test_cmd> <env json> <exclude json> (the args of cover_diff)
// makes a throwaway detached worktree under <dirname(worktree)>/scratch at the plan base, reads the
// judged tree in, and mutates the added lines of the changed production .py files (the built-in
// mutator: comparison flip, boolean swap, boundary +-1, dropped negation), at most 200 mutants spread
// evenly over the changed lines. It runs the sealed pytest test_cmd once plain (red: not_run) and once
// per mutant, all within one 540 s deadline (hit: partial, "N of M not run"); after each run the file
// is restored from its backup and checked byte for byte. It runs as the 2nd slot (mutation) of the
// existing infra:gates:r<m> agent, one Bash call per slot, so no new agent and no new reset. The
// code judge gets script_findings.mutation and rules every survivor in mutant_rulings [{id, target:
// tests|code|equivalent, reason}]; an approve with an unruled survivor, or a survivor ruled code,
// becomes fix_code (a survivor ruled tests: the G6 augmentation round, v800_augment). There is no
// kill-rate stop.
//
// ACs (plan-8.0.0-gates.md, G5):
// - G5-1: a weak-test fixture gives a survivor with path, line and op.
// - G5-2: an unruled survivor plus an approve gives fix_code.
// - G5-3: target: code routes to the coder.
// - G5-4: a budget hit gives partial, and mutation stays listed with "N of M not run".
// - G5-5: a mutant never remains after a killed runner (backup plus diff).
// - G5-6: a red baseline gives not_run.
// - G5-7 (non-weakening): the main fingerprint and the frozen maps are unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { HERE, HAVE_PY, SOURCE, ARGS, happy, run, inputsOf, call, sha256, canon, spawnSync, programSha, FP_K1, FP_K2, HASHES, stateJsonOf } from "./harness.mjs";
import { PROGRAM_COUNT } from "../scripts/gen.mjs";

const PROG = join(HERE, "..", "scripts", "mutants.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
const [CAT, SLEEP, MKDIR, RM, LN] = ["cat", "sleep", "mkdir", "rm", "ln"].map(which);
const HAVE_PYTEST = HAVE_PY && spawnSync(PY, ["-c", "import pytest"], { encoding: "utf8" }).status === 0;
const PROG_KEYS = ["status", "reason", "killed", "survived", "not_run", "budget_hit", "args"];

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const BASE_MOD = "def f(x):\n    return x\n";

// a repo <d>/wt with a base commit and an uncommitted judged tree (pkg/mod.py: base + opts.add;
// tests/test_mod.py: the excluded frozen test). <d>/bin is the only PATH dir: git linked in, and
// either a stub pytest (opts.pytest: its sh body) or the real python3 (opts.real).
function repo(opts) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-g5-")));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pkg", "__init__.py"), "");
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  if (opts.attrs) writeFileSync(join(wt, ".gitattributes"), opts.attrs);
  g(wt, "init", "-q", "-b", "master");
  if (opts.textconv) g(wt, "config", "diff.hide.textconv", which("true"));
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD + (opts.add || ""));
  writeFileSync(join(wt, "tests", "test_mod.py"), opts.test || "def test_f():\n    pass\n\n\ndef test_g():\n    pass\n");
  for (const [p, t] of Object.entries(opts.files || {})) writeFileSync(join(wt, p), t);
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  symlinkSync(GIT, join(bin, "git"));
  if (opts.real) symlinkSync(PY, join(bin, "python3"));
  const log = join(d, "calls.log");
  if (opts.pytest !== undefined) {
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\nLOG='" + log + "'\n" + opts.pytest);
    chmodSync(join(bin, "pytest"), 0o755);
  }
  const fp = () => [g(wt, "rev-parse", "HEAD"), g(wt, "status", "--porcelain"), g(wt, "worktree", "list", "--porcelain"), readFileSync(join(wt, "pkg", "mod.py"), "utf8")].join("\n");
  return { d, wt, bin, base, tree, log, fp, before: fp() };
}
// run the program on a repo; opts.env (the env json), opts.cmd, opts.deadline, opts.killAfter (ms)
function prog(x, opts = {}) {
  const args = [x.wt, x.base, x.tree, opts.cmd || "pytest -q <paths>", JSON.stringify(opts.env || { TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])];
  const env = Object.assign({ PATH: x.bin }, opts.deadline ? { FLEET_MUTANTS_DEADLINE: String(opts.deadline) } : {}, opts.penv || {});
  const t0 = Date.now();
  const r = spawnSync(PY, ["-I", PROG].concat(args), Object.assign({ encoding: "utf8", env }, opts.killAfter ? { timeout: opts.killAfter, killSignal: opts.signal || "SIGTERM" } : {}));
  return {
    r,
    ms: Date.now() - t0,
    out: r.status === 0 ? JSON.parse(r.stdout) : null,
    args,
    calls: existsSync(x.log) ? readFileSync(x.log, "utf8").trim().split("\n").filter(Boolean) : [],
    same: x.fp() === x.before,
    leftovers: existsSync(join(x.d, "scratch")) ? readdirSync(join(x.d, "scratch")) : [],
  };
}
function once(opts, popts) {
  const x = repo(opts);
  try {
    return Object.assign(prog(x, popts), { x });
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
}
function digestOk(o) {
  const x = { program: o.program };
  for (const k of PROG_KEYS) x[k] = o[k] === undefined ? null : o[k];
  return sha256(canon(x)) === o.digest;
}

// the G5-1 fixture: clamp's weak test never hits the boundary; same() has a same-length mutant (== -> !=)
const WEAK = "\n\ndef clamp(x, lo):\n    if x < lo:\n        return lo\n    return x\n\n\ndef same(a, b):\n    return a == b\n";
const WEAK_TEST = "from pkg.mod import clamp, same\n\n\ndef test_clamp():\n    assert clamp(-5, 0) == 0\n\n\ndef test_same():\n    assert same(1, 1)\n";

// ---------------------------------------------------------------- mutants.py

test("8.0.0 G5-1: a weak-test fixture (real pytest) gives a survivor with path, line and op; the same-length mutant is killed (no stale bytecode)", { skip: !HAVE_PYTEST }, () => {
  const y = once({ add: WEAK, test: WEAK_TEST, real: true }, { cmd: "python3 -m pytest -q" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  // line 6: if x < lo: flip (< -> >=) is killed, boundary (< -> <=) survives; line 12: == -> != is killed
  assert.deepEqual(y.out.survived, [{ id: "m2", path: "pkg/mod.py", line: 6, op: "boundary: < -> <=" }]);
  assert.equal(y.out.killed, 2);
  assert.equal(y.out.not_run, 0);
  assert.equal(y.out.budget_hit, false);
  assert.equal(y.out.reason, "2 killed, 1 survived of 3 mutant(s)");
  assert.deepEqual(y.out.args, y.args);
  assert.equal(y.out.program.name, "mutants");
  assert.equal(y.out.program.sha256, programSha("mutants"));
  assert.ok(digestOk(y.out), "the workflow's digest");
  assert.ok(y.same, "G5-7: the main worktree is untouched");
  assert.deepEqual(y.leftovers, [], "no copy is left behind");
  console.log("# G5-1 mutator run time on the fixture: " + y.ms + " ms (baseline + 3 mutants, real pytest)");
});

test("8.0.0 G5: the operators: comparison flip, boolean swap, boundary +-1, dropped negation; strings and comments are never mutated", { skip: !HAVE_PY }, () => {
  const add = "\n\ndef h(a, b):\n    if not a and b == 2:\n        return True\n    s = 'a == b'  # x < y\n    return a >= b or False\n";
  const y = once({ add, pytest: 'echo run >> "$LOG"\nexit 0\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran");
  assert.deepEqual(
    y.out.survived.map((s) => [s.id, s.line, s.op]),
    [
      ["m1", 6, "negation: drop not"],
      ["m2", 6, "bool: and -> or"],
      ["m3", 6, "flip: == -> !="],
      ["m4", 6, "boundary: 2 -> 3"],
      ["m5", 6, "boundary: 2 -> 1"],
      ["m6", 7, "bool: True -> False"],
      ["m7", 9, "flip: >= -> <"],
      ["m8", 9, "boundary: >= -> >"],
      ["m9", 9, "bool: or -> and"],
      ["m10", 9, "bool: False -> True"],
    ],
  );
  assert.equal(y.calls.length, 11, "the baseline and one run per mutant");
});

test("8.0.0 G5: at most 200 mutants, spread evenly over the changed lines (every line gets one before any gets a second)", { skip: !HAVE_PY }, () => {
  const add = "\n" + Array.from({ length: 150 }, (_, i) => "v" + i + " = a < b == c\n").join("");
  const y = once({ add, pytest: "exit 0\n" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.survived.length, 200);
  const lines = new Set(y.out.survived.map((s) => s.line));
  assert.equal(lines.size, 150, "each of the 150 lines");
  assert.match(y.out.reason, /^0 killed, 200 survived of 200 mutant\(s\); 200 of 450 candidates sampled$/);
  assert.equal(y.out.status, "ran");
  // more lines than the cap: 200 lines, evenly spaced
  const many = "\n" + Array.from({ length: 300 }, (_, i) => "w" + i + " = a == b\n").join("");
  const z = once({ add: many, pytest: "exit 0\n" });
  assert.equal(z.out.survived.length, 200);
  const ls = z.out.survived.map((s) => s.line);
  assert.equal(ls[0], 4);
  assert.ok(ls[199] >= 300, "the last lines too: " + ls[199]);
});

test("8.0.0 G5-6: a red baseline gives not_run; no mutant runs", { skip: !HAVE_PY }, () => {
  const y = once({ add: WEAK, pytest: 'echo run >> "$LOG"\nexit 1\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "not_run");
  // 8.0.0 car F (G2 ruling): the suite runs once more at the plan base; red there too is the environment
  assert.equal(y.out.reason, "baseline red in scratch copy at the tree and at the base (exit 1, 1): the environment");
  assert.deepEqual(y.out.survived, []);
  assert.equal(y.calls.length, 2);
  assert.deepEqual(y.leftovers, []);
  // tree red, base green: not_run "tree red, base green" (the workflow stops at gates)
  const z = once({ add: WEAK, pytest: 'echo run >> "$LOG"\ncase "$(' + CAT + ' pkg/mod.py)" in *clamp*) exit 1;; esac\nexit 0\n' });
  assert.equal(z.r.status, 0, z.r.stderr);
  assert.equal(z.out.reason, "tree red, base green: the judged tree fails test_cmd in the scratch copy (exit 1)");
  assert.equal(z.calls.length, 2);
  assert.deepEqual(z.leftovers, []);
});

test("8.0.0 car F (security review): an ignored file the tree's run leaves in the copy cannot make the base red", { skip: !HAVE_PY }, () => {
  const x = repo({ add: WEAK, pytest: 'echo run >> "$LOG"\ncase "$(' + CAT + ' pkg/mod.py)" in *clamp*) : > .planted; exit 1;; esac\n[ -e .planted ] && exit 1\nexit 0\n' });
  try {
    writeFileSync(join(x.wt, ".git", "info", "exclude"), "/.planted\n");
    const y = prog(x);
    assert.equal(y.r.status, 0, y.r.stderr);
    assert.equal(y.out.reason, "tree red, base green: the judged tree fails test_cmd in the scratch copy (exit 1)");
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
});

test("8.0.0 G5: unsupported: a non-pytest test_cmd or no python source gives not_run; python plus other source gives partial", { skip: !HAVE_PY }, () => {
  for (const cmd of ["npm test", "go test ./...", "cargo test"]) {
    const y = once({ add: WEAK, pytest: 'echo run >> "$LOG"\n' }, { cmd });
    assert.equal(y.out.status, "not_run", cmd);
    assert.match(y.out.reason, /^unsupported: the mutation gate runs a pytest test_cmd only/);
    assert.deepEqual(y.calls, []);
  }
  const js = once({ files: { "pkg/x.js": "module.exports = 1 < 2;\n" }, pytest: 'echo run >> "$LOG"\n' });
  assert.equal(js.out.status, "not_run");
  assert.equal(js.out.reason, "unsupported: no added line in a production .py file; not mutated (not python): pkg/x.js");
  const mix = once({ add: WEAK, files: { "pkg/x.js": "module.exports = 1 < 2;\n" }, pytest: "exit 0\n" });
  assert.equal(mix.out.status, "partial");
  assert.match(mix.out.reason, /; not mutated \(not python\): pkg\/x\.js$/);
  // nothing added: ran, nothing to rule
  const none = once({ add: "", pytest: 'echo run >> "$LOG"\n' });
  assert.equal(none.out.status, "ran");
  assert.equal(none.out.reason, "no added line in a production .py file");
});

test("8.0.0 G5-4: a budget hit gives partial with 'N of M not run'; budget_hit; the copy is restored and removed", { skip: !HAVE_PY }, () => {
  // the baseline is quick; each mutant run sleeps past the 3 s deadline
  const y = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + SLEEP + " 30; fi\necho run >> \"$LOG\"\nexit 0\n" }, { deadline: 3 });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "partial");
  assert.equal(y.out.budget_hit, true);
  assert.equal(y.out.not_run, 3);
  assert.match(y.out.reason, /^3 of 3 not run: the 3 s deadline was hit/);
  assert.ok(y.ms < 15000, "the run is killed at the deadline: " + y.ms);
  assert.ok(y.same);
  assert.deepEqual(y.leftovers, []);
  // the deadline only goes down: a larger value is the 540 s default
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /DEADLINE = min\(540, /);
});

test("8.0.0 G5-5: a mutant never remains after a killed runner: each run sees exactly one mutated line; a planted symlink or a directory never takes the restore", { skip: !HAVE_PY }, () => {
  // the runner kills itself (SIGKILL) on every mutant run: each is killed, and each run sees the tree plus one mutant
  const y = once({ add: WEAK, pytest: "echo ---- >> \"$LOG\"\n" + CAT + ' pkg/mod.py >> "$LOG"\nif [ -f "$LOG.base" ]; then kill -9 $$; fi\n: > "$LOG.base"\nexit 0\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.killed, 3);
  assert.deepEqual(y.out.survived, []);
  const runs = y.calls.join("\n").split("----\n").filter(Boolean).map((t) => t.trimEnd().split("\n"));
  assert.equal(runs.length, 4);
  const orig = (BASE_MOD + WEAK).split("\n").filter(Boolean);
  assert.deepEqual(runs[0], orig, "the baseline sees the judged tree");
  for (const r of runs.slice(1)) assert.equal(r.filter((l, i) => l !== orig[i]).length, 1, "one mutated line: " + r.join("|"));
  // a test run that swaps the module for a symlink to a file outside the copy: the restore replaces the link
  const victim = join(tmpdir(), "fleet-g5-victim-" + process.pid);
  writeFileSync(victim, "keep\n");
  try {
    const z = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + RM + " pkg/mod.py; " + LN + " -s '" + victim + "' pkg/mod.py; fi\necho run >> \"$LOG\"\nexit 0\n" });
    assert.equal(z.r.status, 0, z.r.stderr);
    assert.equal(readFileSync(victim, "utf8"), "keep\n", "nothing written through the link");
    assert.ok(z.same);
    assert.deepEqual(z.leftovers, []);
  } finally {
    rmSync(victim, { force: true });
  }
  // a test run that makes the module a directory: the restore cannot hold; fail closed (non-zero exit)
  const w = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + RM + " pkg/mod.py; " + MKDIR + " pkg/mod.py; fi\necho run >> \"$LOG\"\nexit 0\n" });
  assert.notEqual(w.r.status, 0);
  assert.equal(w.out, null);
  assert.match(w.r.stderr, /restore/);
  assert.ok(w.same);
  assert.deepEqual(w.leftovers, []);
});

test("8.0.0 G5-5: a runner killed mid-mutant (SIGTERM) restores and removes its copy; a SIGKILLed one's copy is swept by the next run", { skip: !HAVE_PY }, () => {
  const x = repo({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + SLEEP + " 30; fi\necho run >> \"$LOG\"\nexit 0\n" });
  try {
    const t = prog(x, { killAfter: 2500 });
    assert.notEqual(t.r.status, 0);
    assert.ok(t.same, "TERM: the main worktree is untouched");
    assert.deepEqual(t.leftovers, [], "TERM: the copy is gone");
    const k = prog(x, { killAfter: 2500, signal: "SIGKILL" });
    assert.ok(k.leftovers.length >= 1, "KILL: the copy stays behind");
    rmSync(x.log, { force: true });
    const n = prog(x, { deadline: 2 });
    assert.equal(n.r.status, 0, n.r.stderr);
    assert.deepEqual(n.leftovers, [], "the next run sweeps the stale copy");
    assert.ok(n.same, "the worktree list is back to the start");
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
});

// security review (HIGH): code under test runs as the same uid and can write the scratch dir, so a
// cache there could forge a clean result for the run or its retry. There is no cache: a digest
// retry runs the gate again, and a planted mutants-cache.json is deleted unread.
test("8.0.0 G5 security: no result cache: a forged cache entry with the right key and survived [] is never read; a second run runs again", { skip: !HAVE_PY }, () => {
  const x = repo({ add: WEAK, pytest: 'echo run >> "$LOG"\nexit 0\n' });
  try {
    const args = [x.wt, x.base, x.tree, "pytest -q <paths>", JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])];
    // the key the removed cache used: sha256(json.dumps([program sha, args])) (python's default separators)
    const key = spawnSync(PY, ["-I", "-c", "import hashlib,json,sys; print(hashlib.sha256(json.dumps([sys.argv[1], sys.argv[2:]]).encode()).hexdigest())", programSha("mutants")].concat(args), { encoding: "utf8" }).stdout.trim();
    const forged = { status: "ran", reason: "0 killed, 0 survived of 0 mutant(s)", killed: 0, survived: [], not_run: 0, budget_hit: false };
    mkdirSync(join(x.d, "scratch"), { recursive: true });
    writeFileSync(join(x.d, "scratch", "mutants-cache.json"), JSON.stringify({ key, out: forged }));
    const a = prog(x);
    assert.equal(a.r.status, 0, a.r.stderr);
    assert.equal(a.calls.length, 4, "the baseline and the three mutants ran");
    assert.equal(a.out.survived.length, 3, "the real survivors");
    assert.ok(!existsSync(join(x.d, "scratch", "mutants-cache.json")), "the leftover file is deleted");
    const b = prog(x);
    assert.equal(b.calls.length, 8, "a retry runs the gate again");
    assert.deepEqual(b.out, a.out);
    assert.ok(!existsSync(join(x.d, "scratch", "mutants-cache.json")), "nothing is written");
    assert.doesNotMatch(readFileSync(PROG, "utf8"), /mutants-cache\.json'\)\s*\n.*open\(/);
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
});

test("8.0.0 G5: a mutant run that never starts (the runner is gone) or a runner usage error is an error, never a kill", { skip: !HAVE_PY }, () => {
  // the stub deletes itself after the baseline: every mutant run fails to start
  const y = once({ add: WEAK, pytest: RM + ' "$0"\nexit 0\n' });
  assert.notEqual(y.r.status, 0);
  assert.equal(y.out, null);
  assert.match(y.r.stderr, /mutant run could not run the test_cmd/);
  assert.ok(y.same);
  assert.deepEqual(y.leftovers, []);
  for (const code of [4, 5]) {
    const z = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then exit ' + code + '; fi\necho run >> "$LOG"\nexit 0\n' });
    assert.notEqual(z.r.status, 0, "exit " + code);
    assert.match(z.r.stderr, new RegExp("exit " + code));
  }
});

test("8.0.0 G5 security: the child gets no COVERAGE_* or FLEET_* var and no gate-data path; no bytecode is written; the PATH guard holds", { skip: !HAVE_PY }, () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-g5e-")));
  try {
    const envlog = join(d, "env.log");
    const y = once(
      { add: WEAK, pytest: 'echo "C=$COVERAGE_FILE R=$COVERAGE_RCFILE F=$FLEET_MUTANTS_DEADLINE B=$PYTHONDONTWRITEBYTECODE P=$PYTHONPYCACHEPREFIX" >> \'' + envlog + "'\nexit 0\n" },
      { env: { TZ: "UTC", COVERAGE_FILE: join(d, "f"), COVERAGE_RCFILE: join(d, "r"), PYTHONPYCACHEPREFIX: join(d, "pyc") }, deadline: 500, penv: { COVERAGE_PROCESS_START: "x" } },
    );
    assert.equal(y.r.status, 0, y.r.stderr);
    const lines = [...new Set(readFileSync(envlog, "utf8").trim().split("\n"))];
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /^C= R= F= B=1 P=\/\S+$/);
    assert.ok(!lines[0].includes(join(d, "pyc")) && !lines[0].includes("scratch"), "a fresh pycache prefix outside the scratch dir");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  const t = mkdtempSync(join(tmpdir(), "fleet-g5t-"));
  try {
    writeFileSync(join(t, "terraform"), "#!/bin/sh\n");
    chmodSync(join(t, "terraform"), 0o755);
    const z = once({ add: WEAK, pytest: 'echo run >> "$LOG"\n' }, { env: { PATH: t } });
    assert.notEqual(z.r.status, 0);
    assert.match(z.r.stderr, /terraform-family name/);
    assert.deepEqual(z.calls, []);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /REFUSED = \{'terraform', 'tofu', 'tfp', 'terragrunt', 'digger', 'atlantis'\}/);
  assert.match(src, /preexec_fn=lift, start_new_session=True/);
  assert.match(src, /os\.killpg\(p\.pid, signal\.SIGKILL\)/);
});

test("8.0.0 G5 security: git attributes cannot hide added lines (binary, -diff, textconv); the diff flags of G2", { skip: !HAVE_PY }, () => {
  for (const o of [{ attrs: "*.py binary\n" }, { attrs: "*.py -diff\n" }, { attrs: "*.py diff=hide\n", textconv: true }]) {
    const y = once(Object.assign({ add: WEAK, pytest: "exit 0\n" }, o));
    assert.equal(y.r.status, 0, y.r.stderr);
    assert.equal(y.out.survived.length, 3, JSON.stringify(o));
  }
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /'--text', '--no-textconv', '--no-ext-diff'/);
  assert.match(src, /'core\.attributesFile=\/dev\/null'/);
  assert.match(src, /GIT_ATTR_NOSYSTEM/);
  assert.match(src, /--diff-filter=AMT/);
});

// ---------------------------------------------------------------- the workflow

function argsOf(prompt, n) {
  const m = new RegExp(n + "\\.py'((?: '(?:[^']|'\\\\'')*')+)").exec(prompt);
  return m ? [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")) : [];
}
const COV_NR = { status: "not_run", reason: "no coverage tool: coverage is not on PATH", findings: [] };
function gatesStub(over) {
  return (prompt) => ({
    status: "ok",
    reason: "ran",
    coverage: Object.assign({}, COV_NR, { args: argsOf(prompt, "cover_diff") }),
    mutation: Object.assign({ status: "ran", reason: "0 killed, 0 survived of 0 mutant(s)", killed: 0, survived: [], not_run: 0, budget_hit: false, args: argsOf(prompt, "mutants") }, over),
  });
}
const SURV = { reason: "1 killed, 2 survived of 3 mutant(s)", killed: 1, survived: [{ id: "m1", path: "src/x.py", line: 3, op: "boundary: < -> <=" }, { id: "m3", path: "src/x.py", line: 9, op: "flip: == -> !=" }] };
const approve = (rul) => Object.assign({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } }, rul === undefined ? {} : { mutant_rulings: rul });
const R2 = {
  "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
  "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
  "role:fleet-code-judge:r2": approve(),
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
  // 8.0.0 car F (A-H1): round 2 reports the gate again (a not_run after round 1's findings stops at gates)
  "infra:gates:r2": gatesStub({}),
};
const EQ = [{ id: "m1", target: "equivalent", reason: "x < lo and x <= lo agree at the only call site" }, { id: "m3", target: "equivalent", reason: "a and b are never equal here" }];

test("8.0.0 G5: mutants runs as the 2nd slot of infra:gates:r<m> (no new agent, no new reset), one Bash call per slot, one after the other; same args as cover_diff", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /mutants/.test(l)), out.labels.join(", "));
  const i = out.labels.indexOf("infra:gates:r1");
  assert.equal(out.labels[i - 1], "infra:build-reset:gates:r1");
  const p = call(out, "infra:gates:r1").prompt;
  assert.ok(p.indexOf("cover_diff.py") < p.indexOf("mutants.py"), "coverage first, then mutation");
  assert.match(p, /one after the other, never in the background or in parallel/);
  assert.deepEqual(argsOf(p, "mutants"), argsOf(p, "cover_diff"));
  // 8.0.0 (G7): the security gate is a slot too (v800_security); car F (A-M5): it runs first
  assert.deepEqual(inputsOf(p).gates, ["security_scan", "coverage", "mutation"]);
  // the default stub: no mutation run (not_run); the judge sees it; mutation stays listed with its reason
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cj.script_findings.mutation, { status: "not_run", reason: "tool absent: no mutation run", survived: [] });
  assert.deepEqual(out.result.gates_not_run.find((x) => x.gate === "mutation"), { gate: "mutation", reason: "tool absent: no mutation run" });
  assert.ok(out.logs.includes("gate mutation: not_run (tool absent: no mutation run)"), out.logs.join("\n"));
  // the cap: unchanged (no new capped agent)
  assert.match(SOURCE, /reserve\(10 \+ \(planFacts\.changed_symbols/);
});

test("8.0.0 G5-2: an approve with an unruled survivor becomes fix_code; a bad target or a blank reason rules nothing", async () => {
  for (const rul of [undefined, [], [EQ[0]], [EQ[0], Object.assign({}, EQ[1], { reason: "  " })], [EQ[0], Object.assign({}, EQ[1], { target: "skip" })], [EQ[0], Object.assign({}, EQ[1], { id: "m9" })]]) {
    const out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(SURV), "role:fleet-code-judge:r1": approve(rul) }, R2) }), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(out.labels.includes("role:fleet-coder:r2"), JSON.stringify(rul));
    assert.ok(!out.labels.includes("infra:commit:r1"));
    const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
    assert.equal(f.length, 1);
    assert.equal(f[0].target, "code");
    assert.match(f[0].finding, /^mutation gate: surviving mutants no ruling covers: .*m3 \(src\/x\.py:9 flip: == -> !=\)/);
    assert.ok(out.logs.some((l) => /^code round 1: mutation gate: code-judge approve converted to fix_code/.test(l)), out.logs.join("\n"));
  }
  // the judge got the survivors
  const out = await run(happy({ script: { "infra:gates:r1": gatesStub(SURV), "role:fleet-code-judge:r1": approve(EQ) } }), ARGS);
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cj.script_findings.mutation, { status: "ran", reason: SURV.reason, survived: SURV.survived });
  // every survivor ruled equivalent with a reason: approve holds, mutation leaves gates_not_run
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.deepEqual(out.result.gates_not_run.map((x) => x.gate), ["coverage", "security_scan", "held_out"]);
});

test("8.0.0 G5-3: target code routes the survivor to the coder; target tests goes to the augmentation round (G6, v800_augment)", async () => {
  const code = [EQ[0], { id: "m3", target: "code", reason: "same() must compare by identity" }];
  let out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(SURV), "role:fleet-code-judge:r1": approve(code) }, R2) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  let f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.deepEqual(f, [{ target: "code", criterion: null, finding: "mutation gate: mutant m3 (src/x.py:9 flip: == -> !=) survives the frozen tests; the code judge ruled code: same() must compare by identity" }]);
  const tests = [EQ[0], { id: "m3", target: "tests", reason: "no test covers equal inputs" }];
  out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(SURV), "role:fleet-code-judge:r1": approve(tests) }, R2) }), ARGS);
  assert.ok(out.logs.includes("code round 1: mutation gate: augmentation round for m3 -> tests/test_a_mut1.py"), out.logs.join("\n"));
  assert.match(inputsOf(call(out, "role:fleet-test-writer:AC1:r2").prompt).routed_findings[0].finding, /ruled tests: no test covers equal inputs$/);
});

test("8.0.0 G5-4: a partial result keeps mutation in gates_not_run with 'N of M not run'; its survivors still need rulings", async () => {
  const part = { status: "partial", reason: "150 of 200 not run: the 540 s deadline was hit", killed: 48, survived: [SURV.survived[0]], not_run: 150, budget_hit: true };
  let out = await run(happy({ script: { "infra:gates:r1": gatesStub(part), "role:fleet-code-judge:r1": approve([EQ[0]]) } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.gates_not_run.find((x) => x.gate === "mutation"), { gate: "mutation", reason: part.reason });
  out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(part), "role:fleet-code-judge:r1": approve() }, R2) }), ARGS);
  assert.ok(out.labels.includes("role:fleet-coder:r2"), "an unruled survivor of a partial run");
});

test("8.0.0 G5: the code-judge schema has mutant_rulings [{id, target: tests|code|equivalent, reason}]; the role rules every survivor; no kill-rate stop", async () => {
  const sch = call(await run(happy(), ARGS), "role:fleet-code-judge:r1").opts.schema;
  const it = sch.properties.mutant_rulings.items;
  assert.deepEqual(sch.properties.mutant_rulings.type, ["array", "null"]);
  assert.deepEqual(it.required, ["id", "target", "reason"]);
  assert.deepEqual(it.properties.target, { type: "string", enum: ["tests", "code", "equivalent"] });
  assert.deepEqual(it.properties.reason, { type: "string" });
  const role = readFileSync(join(HERE, "..", "roles", "fleet-code-judge.md"), "utf8");
  assert.match(role, /script_findings\.mutation/);
  assert.match(role, /mutant_rulings/);
  assert.match(role, /every survivor/);
  assert.ok(!/kill rate/i.test(SOURCE.replace(/\/\/.*$/gm, "")), "no kill-rate stop in the script");
});

test("8.0.0 G5: the program checklist: PROGRAM_COUNT 48 (49 since G7), the slot, the keys, the output types", () => {
  assert.equal(PROGRAM_COUNT, 49);
  assert.match(SOURCE, /\[\/\^infra:gates:\/, \[\["coverage", "cover_diff"\], \["mutation", "mutants"\], /);
  assert.match(SOURCE, /"mutants": \["status", "reason", "killed", "survived", "not_run", "budget_hit", "args"\]/);
  assert.match(SOURCE, /\n  mutants: \{ status: STR, reason: STR_OR_NULL, killed: INT, survived: /);
});

// ---------------------------------------------------------------- step 0: held_out never fails open across rounds

const SENT = "ZQX-G5-STEP0";
const HO = [{ criterion_id: "AC1", given: "g", when: "f(9) " + SENT, then: "10" }];
const CRIT = [{ id: "AC1", text: "[unit] behaviour 1", test_files: ["tests/test_1.py"], examples: [{ given: "g", when: "f(1)", then: "2", kind: "main" }], dont_care: [], property: null, guards_existing: false, spec_quote: null }];
function withHO(script) {
  const s = happy({ criteria: CRIT, script });
  s["role:scope-and-plan"].held_out_examples = HO;
  return s;
}
const runner = (pass) => (prompt) => {
  const ho = inputsOf(prompt).held_out;
  return { status: "ok", reason: "ran", store: "ok", store_digest: ho.sha256, results: [{ criterion: "AC1", index: 0, pass }] };
};
const missing = { status: "ok", reason: "m", store: "missing", store_digest: null, results: null };
const fixCode = { status: "ok", reason: "x", verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "tidy" }], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };

test("8.0.0 G5 step 0: round 1 read the store ok, round 2 reports it missing -> needs_human at gate gates", async () => {
  const out = await run(withHO(Object.assign({ "role:fleet-held-out-runner:r1": runner(true), "role:fleet-code-judge:r1": fixCode, "role:fleet-held-out-runner:r2": missing }, R2)), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.match(out.result.reason, /role:fleet-held-out-runner:r2: store file missing after an earlier round of this build read it/);
  assert.ok(!out.labels.includes("role:fleet-code-judge:r2"));
  assert.ok(!out.logs.some((l) => /gate held_out: not_run/.test(l)), out.logs.join("\n"));
});

test("8.0.0 G5 step 0: round 1 fails a hidden example, round 2 reports the store missing -> the fail is never cleared (stop at gates)", async () => {
  const out = await run(withHO(Object.assign({ "role:fleet-held-out-runner:r1": runner(false), "role:fleet-code-judge:r1": approve(), "role:fleet-held-out-runner:r2": missing }, R2)), ARGS);
  assert.ok(out.logs.includes("code round 1: held_out gate: approve -> fix_code (AC1)"), out.logs.join("\n"));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.ok(!out.labels.includes("infra:commit:r1") && !out.labels.includes("infra:commit:r2"), "nothing committed");
  // held_out shows failed, then never ran, cleared or not_run
  const ho = out.logs.filter((l) => /^gate held_out: /.test(l));
  assert.deepEqual(ho, ["gate held_out: failed (0 of 1 pass)"]);
  assert.ok(!JSON.stringify(out.result).includes(SENT));
});

test("8.0.0 G5 step 0: a later not_run keeps an earlier fail (failed stays until a later round passes every example)", () => {
  // the rule in heldOutRun: a not_run after a failed result keeps the failed one
  assert.match(SOURCE, /const nr = \(reason\) => \(prev\.status === "failed" \? set\("failed", prev\.reason, prev\.findings\) : set\("not_run", reason, \[\]\), \{ status: "not_run", reason \}\);/);
});

test("8.0.0 G5 step 0: the 'store read ok' mark survives a resume (saved in the run state)", async () => {
  const out = await run(withHO({ "role:fleet-held-out-runner:r1": runner(true) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const st = stateJsonOf(call(out, "infra:state:committed:r1").prompt);
  assert.equal(st.held_out_seen, true);
  const st2 = stateJsonOf(call(await run(withHO({ "role:fleet-held-out-runner:r1": missing }), ARGS), "infra:state:committed:r1").prompt);
  assert.equal(st2.held_out_seen, false);
  assert.match(SOURCE, /if \(resume\.held_out_seen === true\) state\.gates\.held_out = /);
});

// 8.0.0 car F (A-M4): the mutation copy has no .git, so code under test cannot see the mutant with git diff
test("8.0.0 car F A-M4: the mutation copy holds the judged tree with no .git (git diff cannot force a kill); the restore check still holds", { skip: !HAVE_PY }, () => {
  const y = once({ add: WEAK, pytest: 'if [ -e .git ]; then echo git >> "$LOG"; git diff --quiet || exit 1; fi\necho run >> "$LOG"\nexit 0\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  assert.ok(!y.calls.includes("git"), "no .git in the copy: " + y.calls.join(","));
  assert.ok(y.out.survived.length > 0 && y.out.killed === 0, "every mutant survives a suite that checks nothing");
  assert.ok(y.same);
  assert.deepEqual(y.leftovers, []);
});
