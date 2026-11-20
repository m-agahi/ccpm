// ccpmcwf 8.3.4 (yaadgaar #79, Max ruled 2026-11-20: flag-only): the placebo mutant of the mutation gate.
//
// A source that fails whenever its bytes change (it hashes its own file) makes every mutant count as
// killed. After the green baseline, mutants.py appends a comment line with a random token to every
// file it will mutate and runs the suite once (within the deadline and the mutant bound). The suite
// must stay green: a red placebo run (or one past the bound) gives not_run "placebo mutant killed:
// ..." and no mutant runs. The files are restored in a finally block, before any result is printed.
// A deadline hit in the placebo run is the existing deadline path (partial, "N of M not run").

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, spawnSync, passBwrap, bwrapOk } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "mutants.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
const [CAT, SLEEP] = ["cat", "sleep"].map(which);
const HAVE_PYTEST = HAVE_PY && spawnSync(PY, ["-c", "import pytest"], { encoding: "utf8" }).status === 0;

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const BASE_MOD = "def f(x):\n    return x\n";

// the fixture of v800_mutation: <d>/wt with a base commit and an uncommitted judged tree
// (pkg/mod.py: base + opts.add; tests/test_mod.py excluded); <d>/bin is the only PATH dir
function repo(opts) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-834-")));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pkg", "__init__.py"), "");
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  g(wt, "init", "-q", "-b", "master");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD + (opts.add || ""));
  writeFileSync(join(wt, "tests", "test_mod.py"), opts.test || "def test_f():\n    pass\n");
  for (const [p, t] of Object.entries(opts.files || {})) writeFileSync(join(wt, p), t);
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  symlinkSync(GIT, join(bin, "git"));
  passBwrap(bin);
  if (opts.real) symlinkSync(PY, join(bin, "python3"));
  const log = join(d, "calls.log");
  if (opts.pytest !== undefined) {
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\nLOG='" + log + "'\n" + opts.pytest);
    chmodSync(join(bin, "pytest"), 0o755);
  }
  return { d, wt, bin, base, tree, log };
}
function once(opts, popts = {}) {
  const x = repo(opts);
  try {
    const args = [x.wt, x.base, x.tree, popts.cmd || "pytest -q <paths>", JSON.stringify(Object.assign({ TZ: "UTC" }, popts.env || {}, { RUNLOG: x.log })), JSON.stringify(["tests/test_mod.py", "tests/conftest.py"])];
    const env = Object.assign({ PATH: x.bin }, bwrapOk(x.bin), popts.deadline ? { FLEET_MUTANTS_DEADLINE: String(popts.deadline) } : {});
    const t0 = Date.now();
    const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env });
    return {
      r,
      ms: Date.now() - t0,
      out: r.status === 0 ? JSON.parse(r.stdout) : null,
      calls: existsSync(x.log) ? readFileSync(x.log, "utf8").trim().split("\n").filter(Boolean) : [],
      leftovers: existsSync(join(x.d, "scratch")) ? readdirSync(join(x.d, "scratch")) : [],
    };
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
}

// the weak-test fixture of v800_mutation G5-1 (3 mutants: 2 killed, the boundary one on line 6 survives)
const WEAK = "\n\ndef clamp(x, lo):\n    if x < lo:\n        return lo\n    return x\n\n\ndef same(a, b):\n    return a == b\n";
const WEAK_TEST = "from pkg.mod import clamp, same\n\n\ndef test_clamp():\n    assert clamp(-5, 0) == 0\n\n\ndef test_same():\n    assert same(1, 1)\n";
// a real-pytest run counter: tests/conftest.py (excluded, and with no token to mutate) appends one line per run
const CONFTEST = "import os\n\nopen(os.environ['RUNLOG'], 'a').write('run\\n')\n";
// a source that fails whenever its own bytes change: it hashes its own file against pkg/_h.txt
const SELF = "\n\nimport hashlib, os\n\n_H = open(os.path.join(os.path.dirname(__file__), '_h.txt')).read().strip()\nif hashlib.sha256(open(__file__, 'rb').read()).hexdigest() != _H:\n    raise RuntimeError('tampered')\n" + WEAK;

test("8.3.4 #79: a source that hashes its own file: not_run 'placebo mutant killed', no mutant runs (real pytest)", { skip: !HAVE_PYTEST }, () => {
  const h = createHash("sha256").update(BASE_MOD + SELF).digest("hex");
  const y = once({ add: SELF, test: WEAK_TEST, real: true, files: { "pkg/_h.txt": h + "\n", "tests/conftest.py": CONFTEST } }, { cmd: "python3 -m pytest -q" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "not_run", y.out.reason);
  assert.match(y.out.reason, /^placebo mutant killed: the suite fails on a comment-only change/);
  assert.equal(y.out.killed, 0);
  assert.deepEqual(y.out.survived, []);
  assert.equal(y.out.budget_hit, false);
  assert.equal(y.calls.length, 2, "the baseline and the placebo run, no mutant run");
  assert.deepEqual(y.leftovers, []);
});

test("8.3.4 #79: a normal weak-test fixture: the same killed and survived as 8.3.3, with exactly one extra run (real pytest)", { skip: !HAVE_PYTEST }, () => {
  const y = once({ add: WEAK, test: WEAK_TEST, real: true, files: { "tests/conftest.py": CONFTEST } }, { cmd: "python3 -m pytest -q" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  assert.deepEqual(y.out.survived, [{ id: "m2", path: "pkg/mod.py", line: 6, op: "boundary: < -> <=" }]);
  assert.equal(y.out.killed, 2);
  assert.equal(y.out.reason, "2 killed, 1 survived of 3 mutant(s)");
  assert.equal(y.calls.length, 5, "the baseline, the placebo and 3 mutants");
});

test("8.3.4 #79: the placebo run sees one appended comment line; every mutant run after it sees no placebo text; the restore check passes", { skip: !HAVE_PY }, () => {
  const y = once({ add: WEAK, pytest: "echo ---- >> \"$LOG\"\n" + CAT + ' pkg/mod.py >> "$LOG"\nexit 0\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  const runs = y.calls.join("\n").split("----\n").filter(Boolean).map((t) => t.trimEnd().split("\n"));
  assert.equal(runs.length, 5);
  const orig = (BASE_MOD + WEAK).split("\n").filter(Boolean);
  assert.deepEqual(runs[0], orig, "the baseline sees the judged tree");
  assert.deepEqual(runs[1].slice(0, -1), orig, "the placebo keeps every line");
  assert.match(runs[1][runs[1].length - 1], /^# fleet placebo [0-9a-f]{32}$/, "and appends one comment line with a random token");
  const token = runs[1][runs[1].length - 1];
  for (const r of runs.slice(2)) {
    assert.ok(!r.includes(token), "no placebo text in a mutant run");
    assert.equal(r.length, orig.length);
  }
  assert.ok(!JSON.stringify(y.out).includes(token.slice(-32)), "the token is never in the output");
  assert.deepEqual(y.leftovers, []);
});

test("8.3.4 #79: a red placebo run with the stub: not_run, no mutant run", { skip: !HAVE_PY }, () => {
  // red on the placebo text only
  const y = once({ add: WEAK, pytest: 'echo run >> "$LOG"\ncase "$(' + CAT + ' pkg/mod.py)" in *"# "*) exit 1;; esac\nexit 0\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "not_run");
  assert.match(y.out.reason, /^placebo mutant killed: the suite fails on a comment-only change \(exit 1\)/);
  assert.equal(y.calls.length, 2);
  assert.deepEqual(y.leftovers, []);
});

test("8.3.4 #79: a placebo run past the mutant bound (10 s for a quick baseline) is a kill: not_run (exit -9), no mutant run", { skip: !HAVE_PY }, () => {
  const y = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + SLEEP + ' 12; fi\necho run >> "$LOG"\nexit 0\n' });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "not_run");
  assert.match(y.out.reason, /^placebo mutant killed: the suite fails on a comment-only change \(exit -9\)/);
  assert.equal(y.calls.length, 1, "only the baseline finished");
  assert.deepEqual(y.leftovers, []);
});

test("8.3.4 #79: a placebo run that makes the module a directory: the placebo restore cannot hold; fail closed (non-zero exit, no result)", { skip: !HAVE_PY }, () => {
  const [RM, MKDIR] = ["rm", "mkdir"].map(which);
  const y = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + RM + " pkg/mod.py; " + MKDIR + ' pkg/mod.py; fi\necho run >> "$LOG"\nexit 0\n' });
  assert.notEqual(y.r.status, 0);
  assert.equal(y.out, null);
  assert.match(y.r.stderr, /restore/);
  assert.equal(y.calls.length, 2, "the baseline and the placebo, no mutant run");
  assert.deepEqual(y.leftovers, []);
});

test("8.3.4 #79: a deadline hit during the placebo run gives partial 'N of M not run' (the deadline path)", { skip: !HAVE_PY }, () => {
  // the baseline is quick; the placebo run sleeps past the 3 s deadline
  const y = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then ' + SLEEP + ' 30; fi\necho run >> "$LOG"\nexit 0\n' }, { deadline: 3 });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "partial");
  assert.equal(y.out.budget_hit, true);
  assert.equal(y.out.not_run, 3);
  assert.match(y.out.reason, /^3 of 3 not run: the 3 s deadline was hit/);
  assert.equal(y.calls.length, 1, "only the baseline finished");
  assert.ok(y.ms < 15000, "killed at the deadline: " + y.ms);
  assert.deepEqual(y.leftovers, []);
});

test("8.3.4 #79: a placebo run that cannot start the test_cmd is an error, never a flag (as a mutant run)", { skip: !HAVE_PY }, () => {
  for (const code of [4, 5]) {
    const z = once({ add: WEAK, pytest: 'if [ -f "$LOG" ]; then exit ' + code + '; fi\necho run >> "$LOG"\nexit 0\n' });
    assert.notEqual(z.r.status, 0, "exit " + code);
    assert.match(z.r.stderr, new RegExp("placebo mutant run could not run the test_cmd: exit " + code));
  }
});

test("8.3.4 #79: the header comment names the placebo; the token is random", () => {
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /placebo/);
  assert.match(src, /os\.urandom\(/);
});
