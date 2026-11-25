// 8.9.7 (yaadgaar #110, Max's ruling: option a): when the gate census credits the uv tier for python coverage
// (gate_tools.py reports 'uv run --frozen coverage': uv.lock pins coverage from PyPI and uv is on PATH), the
// coverage gate runs coverage through `uv run --frozen coverage` for a bare `pytest` or a `python -m pytest`
// test_cmd too. cover_diff.py learns the tier from a 7th arg the workflow builds from the digest-checked
// census (never from agent text); a `uv run` test_cmd keeps its own flags, any other runner keeps today's
// behaviour, and a non-uv tier with no host coverage still gives not_run.
//
// Fixture: a git repo with pyproject.toml and a uv.lock that pins coverage from PyPI, a base commit and a
// judged tree (as v800_coverage.test.mjs), a pass-through bwrap and a stub-only PATH. gate_tools.py runs on
// the repo first and gives the tier; cover_diff.py gets that tier. The uv stub logs 'uv ' + argv and acts as
// coverage behind `uv run --frozen coverage`; no real uv or coverage runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, ARGS, happy, run, call, spawnSync, passBwrap, bwrapOk, relayDigestOf, K } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "cover_diff.py");
const CENSUS = join(HERE, "..", "scripts", "gate_tools.py");
const IMG = "ghcr.io/x/audit@sha256:" + "0".repeat(64);
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
const CP = which("cp");
const UV_TIER = "uv run --frozen coverage";

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const BASE_MOD = "def f(x):\n    return x\n";
const NEW_MOD = "def f(x):\n    return x\n\n\ndef g(x):\n    if x:\n        return 1\n    # a comment\n    return 2\n";
const LOCK =
  'version = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "coverage"\nversion = "7.6.1"\nsource = { registry = "https://pypi.org/simple" }\n\n' +
  '[[package]]\nname = "demo"\nversion = "0.1.0"\nsource = { editable = "." }\n';
const REPORT = { meta: {}, files: { "pkg/mod.py": { executed_lines: [1, 2, 5, 6, 7], missing_lines: [9], excluded_lines: [] } } };

// opts: {cmd, lock (default true: the PyPI-pinned uv.lock), uv (default true: a uv stub on PATH),
// tier (override the census tier), uvVersion (the exit of `uv run --frozen coverage --version`)}
function fixture(opts = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-uvt-"));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  if (opts.lock !== false) writeFileSync(join(wt, "uv.lock"), LOCK);
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  g(wt, "init", "-q", "-b", "master");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "pkg", "mod.py"), NEW_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n\n\ndef test_g():\n    pass\n");
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  const log = join(d, "calls.log");
  symlinkSync(GIT, join(bin, "git"));
  passBwrap(bin);
  writeFileSync(join(d, "cov.json"), JSON.stringify(REPORT));
  const put = (n, body) => {
    writeFileSync(join(bin, n), "#!/bin/sh\n" + body);
    chmodSync(join(bin, n), 0o755);
  };
  // the plain baseline runs: pytest and python3 -m pytest log their argv and pass
  put("pytest", 'echo "pytest $*" >> \'' + log + "'\nexit 0\n");
  for (const n of ["python", "python3"]) put(n, 'echo "' + n + ' $*" >> \'' + log + "'\nexit 0\n");
  if (opts.uv !== false)
    put(
      "uv",
      'echo "uv $*" >> \'' + log + "'\n" +
        // a `uv run ... pytest` baseline passes; any coverage call other than `run --frozen coverage` fails
        'case "$*" in "run --frozen coverage "*) shift 3 ;; *coverage*) exit 1 ;; "run "*pytest*) exit 0 ;; *) exit 1 ;; esac\n' +
        'case "$1" in\n' +
        "  --version) exit " + (opts.uvVersion || 0) + " ;;\n" +
        "  run) exit 0 ;;\n" +
        '  json) while [ "$1" != "-o" ]; do shift; done; ' + CP + " '" + join(d, "cov.json") + "' \"$2\" ;;\n" +
        "  *) exit 1 ;;\n" +
        "esac\n",
    );
  // the census on this repo (its PATH: the stub dir), as the preflight runs it
  const c = spawnSync(PY, ["-I", CENSUS, wt, IMG], { encoding: "utf8", env: { PATH: bin } });
  assert.equal(c.status, 0, c.stderr);
  const census = JSON.parse(c.stdout);
  const tier = "tier" in opts ? opts.tier : census.matrix.python.coverage;
  // the census never ran uv; only the gate does
  if (existsSync(log)) rmSync(log);
  const args = [wt, base, tree, opts.cmd || "pytest -q <paths>", JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"]), tier];
  const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: Object.assign({ PATH: bin }, bwrapOk(bin)) });
  const res = {
    r,
    census,
    tier,
    out: r.status === 0 ? JSON.parse(r.stdout) : null,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
  rmSync(d, { recursive: true, force: true });
  return res;
}
const runCall = (calls, head) => calls.find((c) => c.startsWith(head + " run "));

test("8.9.7 #110: the census credits the uv tier for the PyPI-pinned uv.lock fixture", { skip: !HAVE_PY }, () => {
  const x = fixture();
  assert.equal(x.census.matrix.python.coverage, UV_TIER);
});

test("8.9.7 #110: uv tier + a bare `pytest` test_cmd runs coverage through `uv run --frozen coverage` (no not_run)", { skip: !HAVE_PY }, () => {
  const x = fixture({ cmd: "pytest -q <paths>" });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "ran", x.out.reason);
  assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }]);
  assert.equal(x.out.args[6], UV_TIER);
  assert.equal(x.calls[0], "uv run --frozen coverage --version");
  assert.equal(x.calls[1], "pytest -q", "the plain baseline is the test_cmd as given");
  const rc = runCall(x.calls, "uv run --frozen coverage");
  assert.ok(rc, x.calls.join("\n"));
  assert.match(rc, /^uv run --frozen coverage run --rcfile=\S+ --data-file=\S+ -m pytest -q$/);
  assert.ok(x.calls.some((c) => /^uv run --frozen coverage json --rcfile=\S+ --data-file=\S+ -o \S+$/.test(c)), x.calls.join("\n"));
});

test("8.9.7 #110: uv tier + `python -m pytest` runs coverage through `uv run --frozen coverage` too", { skip: !HAVE_PY }, () => {
  for (const py of ["python", "python3"]) {
    const x = fixture({ cmd: py + " -m pytest -q <paths>" });
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.equal(x.out.status, "ran", x.out.reason);
    assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }]);
    assert.equal(x.calls[0], "uv run --frozen coverage --version");
    assert.equal(x.calls[1], py + " -m pytest -q");
    const rc = runCall(x.calls, "uv run --frozen coverage");
    assert.ok(rc, x.calls.join("\n"));
    assert.match(rc, /^uv run --frozen coverage run --rcfile=\S+ --data-file=\S+ -m pytest -q$/);
    assert.ok(!x.calls.some((c) => / -I -c /.test(c)), "no in-process coverage launcher on the uv tier");
  }
});

test("8.9.7 #110: uv tier + a `uv run` test_cmd behaves as before (its own flags win)", { skip: !HAVE_PY }, () => {
  // 8.4.1 AC4: the probe keeps the test_cmd's flags; the uv stub serves only `run --frozen coverage`, so --no-sync fails the probe
  const a = fixture({ cmd: "uv run --no-sync pytest -q" });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.out.status, "not_run");
  assert.equal(a.out.reason, "no coverage tool: uv run --no-sync coverage --version exit 1");
  assert.deepEqual(a.calls, ["uv run --no-sync coverage --version"]);
  const b = fixture({ cmd: "uv run --frozen pytest -q <paths>" });
  assert.equal(b.out.status, "ran", b.out.reason);
  assert.equal(b.calls[1], "uv run --frozen pytest -q");
  assert.match(runCall(b.calls, "uv run --frozen coverage"), /^uv run --frozen coverage run --rcfile=\S+ --data-file=\S+ -m pytest -q$/);
});

test("8.9.7 #110: a non-uv tier with no host coverage still gives not_run", { skip: !HAVE_PY }, () => {
  // no uv.lock: the census gives 'unsupported' (no coverage on PATH)
  const x = fixture({ lock: false });
  assert.equal(x.tier, "unsupported");
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "no coverage tool: coverage is not on PATH");
  assert.deepEqual(x.calls, []);
  // the 6-arg form (no tier) is today's behaviour
  for (const tier of ["coverage", "", "uv run coverage", "uv run --frozen coverage --x"]) {
    const y = fixture({ tier });
    assert.equal(y.out.status, "not_run", tier);
    assert.equal(y.out.reason, "no coverage tool: coverage is not on PATH", tier);
    assert.deepEqual(y.calls, [], tier);
  }
});

test("8.9.7 #110: uv tier with uv missing, or a lock that does not install coverage, stays not_run", { skip: !HAVE_PY }, () => {
  const a = fixture({ uv: false, tier: UV_TIER });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.out.status, "not_run");
  assert.equal(a.out.reason, "no coverage tool: uv is not on PATH");
  assert.deepEqual(a.calls, []);
  const b = fixture({ uvVersion: 2 });
  assert.equal(b.out.status, "not_run");
  assert.equal(b.out.reason, "no coverage tool: uv run --frozen coverage --version exit 2");
  assert.deepEqual(b.calls, ["uv run --frozen coverage --version"]);
});

test("8.9.7 #110: an other runner keeps today's unsupported not_run on the uv tier", { skip: !HAVE_PY }, () => {
  const x = fixture({ cmd: "make test" });
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "unsupported: the coverage gate runs a pytest test_cmd only (got make test)");
  assert.deepEqual(x.calls, []);
});

// ---------------------------------------------------------------- the workflow

function argsOf(prompt, n) {
  const m = new RegExp(n + "\\.py'((?: '(?:[^']|'\\\\'')*')+)").exec(prompt);
  return m ? [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")) : [];
}

test("8.9.7 #110: the workflow passes the digest-checked census python coverage tier to cover_diff as its 7th arg (mutants keeps 6)", async () => {
  const s = happy();
  s.__mutate = {
    label: "preflight",
    fn: (r) => {
      const gt = r.gate_tools;
      gt.matrix.python.coverage = UV_TIER;
      gt.digest = relayDigestOf(gt, K("gate_tools"));
      return r;
    },
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const p = call(out, "infra:gates:r1").prompt;
  const cd = argsOf(p, "cover_diff");
  assert.equal(cd.length, 7);
  assert.equal(cd[6], UV_TIER);
  assert.deepEqual(argsOf(p, "mutants"), cd.slice(0, 6));
  // the default census (no uv tier): the census's own value
  const o2 = await run(happy(), ARGS);
  assert.equal(argsOf(call(o2, "infra:gates:r1").prompt, "cover_diff")[6], "unsupported");
});

test("8.9.7 #110: a census that fails its digest gives cover_diff no tier", async () => {
  const s = happy();
  s.__mutate = { label: "preflight", fn: (r) => Object.assign(r, { gate_tools: Object.assign(r.gate_tools, { matrix: Object.assign(r.gate_tools.matrix, { python: { coverage: UV_TIER, mutation: "builtin", security: "unsupported" } }) }) }) };
  const out = await run(s, ARGS);
  assert.equal(argsOf(call(out, "infra:gates:r1").prompt, "cover_diff")[6], "");
});
