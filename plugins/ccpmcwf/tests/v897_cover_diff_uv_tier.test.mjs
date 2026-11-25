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
//
// Review of #123 (F1, Max: "prefill cache from the base lock"): the gate's UV_CACHE_DIR is fresh per run and the
// sandbox has no network, so before the sandboxed runs cover_diff.py fills the cache and the gate venv
// (UV_PROJECT_ENVIRONMENT) from the plan BASE's pyproject.toml and uv.lock, outside the sandbox:
// `uv sync --frozen --no-install-project --no-build --project <a copy of the base files>`, UV_NO_CONFIG=1 (wheels
// only; no tree code runs). Inside, coverage runs in that venv as `uv run --frozen --offline --no-sync coverage`.
// The last test runs real uv in the real sandbox (it skips with no uv, no bwrap or no PyPI).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { HERE, HAVE_PY, ARGS, happy, run, call, spawnSync, passBwrap, bwrapOk, relayDigestOf, K } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "cover_diff.py");
const CENSUS = join(HERE, "..", "scripts", "gate_tools.py");
const IMG = "ghcr.io/x/audit@sha256:" + "0".repeat(64);
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
const CP = which("cp");
const LS = which("ls");
const GREP = which("grep");
const UV_TIER = "uv run --frozen coverage";
const UVH = "uv run --frozen --offline --no-sync coverage";
const SYNC_RE = /^uv sync --frozen --no-install-project --no-build --all-extras --all-groups --verbose --project \S+$/;

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
// tier (override the census tier), uvVersion (the exit of the uv coverage `--version` probe), runExit (the exit of
// the uv coverage run), syncExit (the exit of `uv sync`), noUvEnv (no UV_CACHE_DIR / UV_PROJECT_ENVIRONMENT),
// baseFiles ({path: text} in the base commit), judged ({path: text | null} in the judged tree only; null deletes),
// env (more env_in vars), plant (a uv that logs "PLANTED": true or "wt" puts it in <wt>/.plant, first on the env_in
// PATH; "scratch" puts it in <scratch>/.plant, first on the env_in PATH and on this program's own PATH),
// wsRoot (review of 9e23242, M1: TMPDIR is <d>/t, and <d>/t holds a planted workspace-root pyproject.toml and a
// uv.lock of its own), syncLog (false: the uv stub's sync logs no workspace line)}
const PLANTED_LOCK = LOCK.replace('version = "7.6.1"', 'version = "6.6.6"');
function fixture(opts = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-uvt-"));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  if (opts.lock !== false) writeFileSync(join(wt, "uv.lock"), LOCK);
  for (const [p, t] of Object.entries(opts.baseFiles || {})) writeFileSync(join(wt, p), t);
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  g(wt, "init", "-q", "-b", "master");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "pkg", "mod.py"), NEW_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n\n\ndef test_g():\n    pass\n");
  for (const [p, t] of Object.entries(opts.judged || {})) {
    if (t === null) rmSync(join(wt, p));
    else {
      mkdirSync(dirname(join(wt, p)), { recursive: true });
      writeFileSync(join(wt, p), t);
    }
  }
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  const log = join(d, "calls.log");
  const plantEnv = {};
  let agentPlant = null;
  if (opts.plant) {
    // after the tree is written: a uv the coder planted in a worktree or scratch dir on the env PATH
    const pd = opts.plant === "scratch" ? join(d, "scratch", ".plant") : join(wt, ".plant");
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, "uv"), "#!/bin/sh\necho \"PLANTED $*\" >> '" + log + "'\nexit 1\n");
    chmodSync(join(pd, "uv"), 0o755);
    plantEnv.PATH = pd;
    if (opts.plant === "scratch") agentPlant = pd;
  }
  const tmpd = join(d, "t");
  if (opts.wsRoot) {
    // M1: an ancestor of the prefill's work dir (TMPDIR) is a workspace root with a lock the base did not choose
    mkdirSync(tmpd);
    writeFileSync(join(tmpd, "pyproject.toml"), '[tool.uv.workspace]\nmembers = ["*/base-project"]\n');
    writeFileSync(join(tmpd, "uv.lock"), PLANTED_LOCK);
  }
  const envlog = join(d, "env.log");
  const synced = join(d, "synced.lock");
  const syncenv = join(d, "sync.env");
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
        'echo "UV_NO_CONFIG=$UV_NO_CONFIG" >> \'' + envlog + "'\n" +
        // the prefill: keeps the lock it was given (the base's), then exits syncExit
        // (and records the env it got and the project dir's entries)
        'if [ "$1" = sync ]; then echo "UV_INDEX_URL=$UV_INDEX_URL VIRTUAL_ENV=$VIRTUAL_ENV PYTHONPATH=$PYTHONPATH UV_PYTHON=$UV_PYTHON UV_PYTHON_DOWNLOADS=$UV_PYTHON_DOWNLOADS UV_NO_CONFIG=$UV_NO_CONFIG" > \'' + syncenv + "'; " +
        // M1: it models uv's walk-up: the nearest dir from the project up with a [tool.uv.workspace] pyproject.toml
        // is the root, and the lock it keeps is that root's; with --verbose it logs uv's workspace line on stderr
        'v=; case " $* " in *" --verbose "*) v=1 ;; esac; ' +
        'while [ "$1" != "--project" ]; do shift; done; echo "proj:" $(' + LS + ' -A "$2") >> \'' + syncenv + "'; " +
        'p=$(cd "$2" && pwd -P); r=$p; while :; do ' + GREP + ' -q "^\\[tool\\.uv\\.workspace\\]" "$r/pyproject.toml" 2>/dev/null && break; ' +
        'if [ "$r" = / ]; then r=; break; fi; r=${r%/*}; [ -z "$r" ] && r=/; done; ' +
        (opts.syncLog === false ? "v=; " : "") +
        'if [ -n "$r" ]; then [ -n "$v" ] && echo "DEBUG Found workspace root: $r" >&2; else r=$p; [ -n "$v" ] && echo "DEBUG No workspace root found, using project root" >&2; fi; ' +
        CP + ' "$r/uv.lock" \'' + synced + "'; exit " + (opts.syncExit || 0) + "; fi\n" +
        // a `uv run ... pytest` baseline passes; any coverage call other than the two served prefixes fails
        'case "$*" in "run --frozen --offline --no-sync coverage "*) shift 5 ;; "run --frozen coverage "*) shift 3 ;; *coverage*) exit 1 ;; "run "*pytest*) exit 0 ;; *) exit 1 ;; esac\n' +
        'case "$1" in\n' +
        "  --version) exit " + (opts.uvVersion || 0) + " ;;\n" +
        "  run) exit " + (opts.runExit || 0) + " ;;\n" +
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
  if (existsSync(envlog)) rmSync(envlog);
  const uvEnv = opts.noUvEnv ? {} : { UV_CACHE_DIR: join(d, "scratch", "uv-cache", "n1", "gate"), UV_PROJECT_ENVIRONMENT: join(d, "scratch", "build", "n1", "gates-r1", "uv-venv") };
  const args = [wt, base, tree, opts.cmd || "pytest -q <paths>", JSON.stringify(Object.assign({ TZ: "UTC" }, uvEnv, plantEnv, opts.env || {})), JSON.stringify(["tests/test_mod.py"]), tier];
  const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: Object.assign({ PATH: agentPlant ? agentPlant + ":" + bin : bin }, opts.wsRoot ? { TMPDIR: tmpd } : {}, bwrapOk(bin)) });
  const res = {
    r,
    census,
    tier,
    out: r.status === 0 ? JSON.parse(r.stdout) : null,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    envs: existsSync(envlog) ? readFileSync(envlog, "utf8").trim().split("\n") : [],
    synced: existsSync(synced) ? readFileSync(synced, "utf8") : null,
    syncenv: existsSync(syncenv) ? readFileSync(syncenv, "utf8").trim().split("\n") : null,
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
  // F1: the prefill from the base lock first (outside the sandbox), then the offline coverage probe
  assert.match(x.calls[0], SYNC_RE);
  assert.equal(x.synced, LOCK, "the prefill got the base's uv.lock");
  assert.equal(x.calls[1], UVH + " --version");
  assert.equal(x.calls[2], "pytest -q", "the plain baseline is the test_cmd as given");
  const rc = runCall(x.calls, UVH);
  assert.ok(rc, x.calls.join("\n"));
  assert.ok(rc.startsWith(UVH + " run --rcfile="), rc);
  assert.match(rc, / --data-file=\S+ -m pytest -q$/);
  assert.ok(x.calls.some((c) => c.startsWith(UVH + " json --rcfile=")), x.calls.join("\n"));
});

test("8.9.7 #110: uv tier + `python -m pytest` runs coverage through `uv run --frozen coverage` too", { skip: !HAVE_PY }, () => {
  for (const py of ["python", "python3"]) {
    const x = fixture({ cmd: py + " -m pytest -q <paths>" });
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.equal(x.out.status, "ran", x.out.reason);
    assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }]);
    assert.match(x.calls[0], SYNC_RE);
    assert.equal(x.calls[1], UVH + " --version");
    assert.equal(x.calls[2], py + " -m pytest -q");
    const rc = runCall(x.calls, UVH);
    assert.ok(rc, x.calls.join("\n"));
    assert.match(rc, / --data-file=\S+ -m pytest -q$/);
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
  assert.ok(!b.calls.some((c) => c.startsWith("uv sync")), "no prefill for a uv run test_cmd");
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
  // F1: the offline probe fails in the prefilled venv
  const b = fixture({ uvVersion: 2 });
  assert.equal(b.out.status, "not_run");
  assert.equal(b.out.reason, "no coverage tool in the venv prefilled from the base lock (" + UVH + " --version exit 2): ");
  assert.equal(b.calls.length, 2);
  assert.match(b.calls[0], SYNC_RE);
  assert.equal(b.calls[1], UVH + " --version");
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

// ---------------------------------------------------------------- review of #123 (Max: option B, honest-coder gate)
// The gate does not resist a hostile coder (in-process tampering, ADR-1152, ADR-1325, ADR-1365): the judged tree's
// lock and pyproject decide which coverage runs. Kept: UV_NO_CONFIG=1, and one accident guard (the judged uv.lock
// still pins coverage from PyPI).

const REFUSED_NR = (x, why) => {
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run", JSON.stringify(x.out));
  assert.equal(x.out.reason, "uv tier refused: " + why);
  assert.deepEqual(x.calls, [], "no uv call and no test run");
};
const PYPROJECT = '[project]\nname = "demo"\nversion = "0.1.0"\n';

test("8.9.7 #110 review: the uv tier runs uv with UV_NO_CONFIG=1 (no uv.toml or user config is read)", { skip: !HAVE_PY }, () => {
  const x = fixture();
  assert.equal(x.out.status, "ran", x.out.reason);
  assert.ok(x.envs.length >= 3, x.envs.join("\n"));
  assert.ok(x.envs.every((e) => e === "UV_NO_CONFIG=1"), x.envs.join("\n"));
});

test("8.9.7 #110 review F2: a `uv run` test_cmd on the uv tier gets UV_NO_CONFIG=1 too (no lock guard, no prefill)", { skip: !HAVE_PY }, () => {
  const x = fixture({ cmd: "uv run --frozen pytest -q", judged: { "uv.toml": "x = 1\n" }, tier: UV_TIER });
  assert.equal(x.out.status, "ran", x.out.reason);
  assert.ok(x.envs.length >= 3, x.envs.join("\n"));
  assert.ok(x.envs.every((e) => e === "UV_NO_CONFIG=1"), x.envs.join("\n"));
  // off the uv tier, a uv run test_cmd is as before
  const y = fixture({ cmd: "uv run --frozen pytest -q", tier: "coverage" });
  assert.equal(y.out.status, "ran", y.out.reason);
  assert.ok(y.envs.every((e) => e === "UV_NO_CONFIG="), y.envs.join("\n"));
});

test("8.9.7 #110 accident guard: the judged uv.lock must still pin coverage from PyPI, else not_run", { skip: !HAVE_PY }, () => {
  // a path source
  const a = fixture({ tier: UV_TIER, judged: { "uv.lock": LOCK.replace('source = { registry = "https://pypi.org/simple" }', 'source = { path = "vendor/coverage" }') } });
  REFUSED_NR(a, "the judged uv.lock does not pin coverage from PyPI");
  // coverage dropped from the lock
  const b = fixture({ tier: UV_TIER, judged: { "uv.lock": LOCK.replace('name = "coverage"', 'name = "other"') } });
  REFUSED_NR(b, "the judged uv.lock does not pin coverage from PyPI");
  // no lock in the judged tree
  const c = fixture({ tier: UV_TIER, judged: { "uv.lock": null } });
  REFUSED_NR(c, "the judged tree has no uv.lock");
  // a lock that is not TOML
  const d = fixture({ tier: UV_TIER, judged: { "uv.lock": "[[package\n" } });
  REFUSED_NR(d, "the judged uv.lock is not TOML");
});

test("8.9.7 #110 honest-coder gate: a lock, pyproject or uv config change that keeps coverage on PyPI still runs (no base comparison)", { skip: !HAVE_PY }, () => {
  const a = fixture({ tier: UV_TIER, judged: { "uv.lock": LOCK.replace('version = "7.6.1"', 'version = "7.6.2"') } });
  assert.equal(a.out.status, "ran", a.out.reason);
  assert.equal(a.synced, LOCK, "the prefill reads the base's lock, never the judged one");
  const b = fixture({ tier: UV_TIER, judged: { "pyproject.toml": PYPROJECT + '\n[tool.uv]\nindex-url = "https://example.org/simple"\n', "uv.toml": "native-tls = true\n" } });
  assert.equal(b.out.status, "ran", b.out.reason);
  assert.ok(b.envs.every((e) => e === "UV_NO_CONFIG=1"), b.envs.join("\n"));
});

test("8.9.7 #110 review F1: a failed or impossible prefill gives not_run before any test run (no error loop)", { skip: !HAVE_PY }, () => {
  const a = fixture({ syncExit: 1 });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.out.status, "not_run");
  assert.match(a.out.reason, /^uv cache prefill failed: uv sync --frozen --no-install-project --no-build --all-extras --all-groups --verbose exit 1/);
  assert.equal(a.calls.length, 1);
  assert.match(a.calls[0], SYNC_RE);
  // no gate uv env to fill
  const b = fixture({ noUvEnv: true });
  assert.equal(b.r.status, 0, b.r.stderr);
  assert.equal(b.out.status, "not_run");
  assert.equal(b.out.reason, "uv cache prefill not run: the gate env has no absolute UV_CACHE_DIR and UV_PROJECT_ENVIRONMENT");
  assert.deepEqual(b.calls, []);
  // no base lock to fill from (the judged tree adds one)
  const c = fixture({ tier: UV_TIER, lock: false, judged: { "uv.lock": LOCK } });
  assert.equal(c.out.status, "not_run");
  assert.equal(c.out.reason, "uv cache prefill not run: the plan base has no uv.lock");
  assert.deepEqual(c.calls, []);
});

test("8.9.7 #110 review F3: a red uv coverage run after a green plain baseline gives not_run, not an error", { skip: !HAVE_PY }, () => {
  const x = fixture({ runExit: 1 });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run", JSON.stringify(x.out));
  assert.match(x.out.reason, /^uv coverage run exit 1 with a green plain baseline: the judged uv\.lock needs packages the base lock does not provide, or the uv venv does not match/);
});

// ---------------------------------------------------------------- F1 with real uv in the real sandbox

const UV = which("uv");
const BWRAP = which("bwrap");
const NO_REAL = (() => {
  if (!HAVE_PY) return "no python3";
  if (!UV) return "uv is not on PATH: the real-uv prefill test skips";
  if (!BWRAP) return "bwrap is not on PATH (CI has none): the real-uv prefill test skips";
  // the plain baseline runs the host's pytest (a stub dir under /tmp does not come back in the sandbox)
  if (!which("pytest")) return "no host pytest for the plain baseline: the real-uv prefill test skips";
  const d = mkdtempSync(join(tmpdir(), "fleet-uvr-chk-"));
  const r = spawnSync(BWRAP, ["--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--overlay-src", d, "--tmp-overlay", d, "--", PY, "-I", "-S", "-c", ""], { encoding: "utf8" });
  rmSync(d, { recursive: true, force: true });
  return r.status === 0 ? false : "bwrap cannot make the sandbox here: " + (r.stderr || "").trim();
})();

test("8.9.7 #110 review F1 (real uv): an empty cache, the base lock prefilled outside, the offline sandboxed coverage run reaches ran", { skip: NO_REAL, timeout: 600000 }, (t) => {
  const d = spawnSync("realpath", [mkdtempSync(join(tmpdir(), "fleet-uvr-"))], { encoding: "utf8" }).stdout.trim();
  try {
    const wt = join(d, "main");
    mkdirSync(join(wt, "pkg"), { recursive: true });
    mkdirSync(join(wt, "tests"));
    const ver = spawnSync(PY, ["-I", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=' + ver + '"\ndependencies = ["coverage", "pytest"]\n');
    writeFileSync(join(wt, "pkg", "__init__.py"), "");
    // a root conftest puts the repo root on sys.path for the host pytest baseline
    writeFileSync(join(wt, "conftest.py"), "");
    writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
    writeFileSync(join(wt, "tests", "test_mod.py"), "from pkg import mod\n\n\ndef test_f():\n    assert mod.f(1) == 1\n");
    const lk = spawnSync(UV, ["lock", "--python", PY], { cwd: wt, encoding: "utf8", env: { PATH: process.env.PATH, HOME: d, UV_CACHE_DIR: join(d, "lock-cache"), UV_NO_CONFIG: "1", UV_PYTHON_DOWNLOADS: "never" } });
    if (lk.status !== 0) {
      t.skip("uv lock failed (no PyPI access?): " + (lk.stderr || "").trim().slice(-200));
      return;
    }
    rmSync(join(d, "lock-cache"), { recursive: true, force: true });
    g(wt, "init", "-q", "-b", "master");
    g(wt, "add", "-A");
    g(wt, "commit", "-qm", "base");
    const base = g(wt, "rev-parse", "HEAD");
    writeFileSync(join(wt, "pkg", "mod.py"), NEW_MOD);
    writeFileSync(join(wt, "tests", "test_mod.py"), "from pkg import mod\n\n\ndef test_f():\n    assert mod.f(1) == 1\n\n\ndef test_g():\n    pass\n");
    const idx = join(d, "idx");
    const ie = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
    spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env: ie });
    spawnSync(GIT, ["add", "-A"], { cwd: wt, env: ie });
    const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env: ie, encoding: "utf8" }).stdout.trim();
    rmSync(idx, { force: true });
    const cache = join(d, "scratch", "uv-cache", "n1", "gate");
    const venv = join(d, "scratch", "build", "n1", "gates-r1", "uv-venv");
    const env = { TZ: "UTC", UV_CACHE_DIR: cache, UV_PROJECT_ENVIRONMENT: venv, UV_PYTHON: PY, UV_PYTHON_DOWNLOADS: "never" };
    const home = join(d, "home");
    const tmpd = join(d, "tmp");
    mkdirSync(home);
    mkdirSync(tmpd);
    assert.ok(!existsSync(cache), "the gate cache starts empty");
    const args = [wt, base, tree, "pytest -q <paths>", JSON.stringify(env), JSON.stringify(["tests/test_mod.py"]), UV_TIER];
    const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpd } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    console.log("REAL-UV RESULT " + JSON.stringify({ status: out.status, reason: out.reason, findings: out.findings }));
    assert.equal(out.status, "ran", out.reason);
    assert.deepEqual(out.findings, [{ path: "pkg/mod.py", lines: [6, 7, 9] }]);
    assert.ok(existsSync(join(venv, "bin", "coverage")), "the prefill made the gate venv outside the sandbox");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- security review of 2ea5feb: the host prefill runs only trusted inputs

test("8.9.7 #110 review (host prefill): a uv planted in a worktree PATH entry never runs on the host", { skip: !HAVE_PY }, () => {
  // a clean uv exists: the prefill runs it; the planted one is never the prefill
  const a = fixture({ plant: true });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.match(a.calls[0], SYNC_RE, a.calls.join("\n"));
  assert.ok(!a.calls.some((c) => c.startsWith("PLANTED sync")), a.calls.join("\n"));
  // no clean uv: not_run, and the planted one did not run at all
  const b = fixture({ plant: true, uv: false, tier: UV_TIER });
  assert.equal(b.r.status, 0, b.r.stderr);
  assert.equal(b.out.status, "not_run");
  assert.equal(b.out.reason, "no coverage tool: uv is not on PATH");
  assert.deepEqual(b.calls, []);
});

test("8.9.7 #110 review (host prefill): stray UV_*, VIRTUAL_ENV and PYTHON* vars never reach it; it gets the trusted interpreter, no downloads, no config, the base pyproject and lock only", { skip: !HAVE_PY }, () => {
  const x = fixture({ env: { UV_INDEX_URL: "https://evil.example/simple", VIRTUAL_ENV: "/evil/venv", PYTHONPATH: "/evil", UV_PYTHON: "/evil/python" }, baseFiles: { ".python-version": "3.12\n", "uv.toml": "x = 1\n" } });
  assert.equal(x.out.status, "ran", x.out.reason);
  assert.deepEqual(x.syncenv, ["UV_INDEX_URL= VIRTUAL_ENV= PYTHONPATH= UV_PYTHON=" + PY + " UV_PYTHON_DOWNLOADS=never UV_NO_CONFIG=1", "proj: pyproject.toml uv.lock"]);
});

test("8.9.7 #110 review (host prefill, L4): a uv planted in a scratch-dir PATH entry never runs on the host", { skip: !HAVE_PY }, () => {
  // on the env_in PATH and first on this program's own PATH: clean_path drops it from the prefill's PATH
  const a = fixture({ plant: "scratch" });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.match(a.calls[0], SYNC_RE, a.calls.join("\n"));
  assert.ok(!a.calls.some((c) => c.startsWith("PLANTED sync")), a.calls.join("\n"));
  // no clean uv: not_run, and the planted one did not run at all
  const b = fixture({ plant: "scratch", uv: false, tier: UV_TIER });
  assert.equal(b.r.status, 0, b.r.stderr);
  assert.equal(b.out.status, "not_run");
  assert.equal(b.out.reason, "no coverage tool: uv is not on PATH");
  assert.deepEqual(b.calls, []);
});

// ---------------------------------------------------------------- review of 9e23242 (M1): uv's workspace walk-up

const HIJACK_RE = /^uv cache prefill refused: uv used the workspace root (\S+), not the plan base project \(an ancestor pyproject\.toml\)$/;

test("8.9.7 #110 review M1: an ancestor workspace root above the prefill's work dir gives not_run, never a venv from its lock", { skip: !HAVE_PY }, () => {
  const x = fixture({ wsRoot: true });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.synced, PLANTED_LOCK, "the stub models uv: the ancestor root's lock was the one read");
  assert.equal(x.out.status, "not_run", JSON.stringify(x.out));
  const m = HIJACK_RE.exec(x.out.reason);
  assert.ok(m, x.out.reason);
  assert.ok(m[1].endsWith("/t"), m[1]);
  assert.equal(x.calls.length, 1, "no test run after the refused prefill: " + x.calls.join("\n"));
  assert.match(x.calls[0], SYNC_RE);
});

test("8.9.7 #110 review M1: a base that is its own workspace root still runs; a sync that logs no workspace line is not_run", { skip: !HAVE_PY }, () => {
  const a = fixture({ baseFiles: { "pyproject.toml": PYPROJECT + "\n[tool.uv.workspace]\nmembers = []\n" } });
  assert.equal(a.out.status, "ran", a.out.reason);
  assert.equal(a.synced, LOCK);
  const b = fixture({ syncLog: false });
  assert.equal(b.out.status, "not_run");
  assert.equal(b.out.reason, "uv cache prefill refused: uv --verbose did not log that it used the plan base project as its root");
  assert.equal(b.calls.length, 1);
});

const NO_UV = !HAVE_PY ? "no python3" : !UV ? "uv is not on PATH: the real-uv workspace test skips" : false;

test("8.9.7 #110 review M1 (real uv): a planted virtual workspace root above TMPDIR is refused; the clean run passes the prefill", { skip: NO_UV, timeout: 300000 }, () => {
  // no PyPI, bwrap or pytest needed: the base project has no dependencies, so the sync installs nothing
  const d = spawnSync("realpath", [mkdtempSync(join(tmpdir(), "fleet-uvw-"))], { encoding: "utf8" }).stdout.trim();
  try {
    const ver = spawnSync(PY, ["-I", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).stdout.trim();
    const proj = '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=' + ver + '"\ndependencies = []\n';
    const uvEnv = { PATH: process.env.PATH, HOME: d, UV_CACHE_DIR: join(d, "lock-cache"), UV_NO_CONFIG: "1", UV_PYTHON_DOWNLOADS: "never", UV_PYTHON: PY };
    const wt = join(d, "main");
    mkdirSync(join(wt, "pkg"), { recursive: true });
    writeFileSync(join(wt, "pyproject.toml"), proj);
    writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
    const lk = spawnSync(UV, ["lock", "--offline"], { cwd: wt, encoding: "utf8", env: uvEnv });
    assert.equal(lk.status, 0, lk.stderr);
    g(wt, "init", "-q", "-b", "master");
    g(wt, "add", "-A");
    g(wt, "commit", "-qm", "base");
    const base = g(wt, "rev-parse", "HEAD");
    // the judged tree: the PyPI-pinned lock the accident guard wants (the prefill never reads it)
    writeFileSync(join(wt, "pkg", "mod.py"), NEW_MOD);
    writeFileSync(join(wt, "uv.lock"), LOCK);
    const idx = join(d, "idx");
    const ie = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
    spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env: ie });
    spawnSync(GIT, ["add", "-A"], { cwd: wt, env: ie });
    const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env: ie, encoding: "utf8" }).stdout.trim();
    rmSync(idx, { force: true });
    // a virtual workspace root whose members glob matches <TMPDIR>/tmp*/base-project, locked by real uv
    const root = join(d, "t");
    mkdirSync(join(root, "seed", "base-project"), { recursive: true });
    writeFileSync(join(root, "pyproject.toml"), '[tool.uv.workspace]\nmembers = ["*/base-project"]\n');
    writeFileSync(join(root, "seed", "base-project", "pyproject.toml"), proj);
    const rl = spawnSync(UV, ["lock", "--offline"], { cwd: root, encoding: "utf8", env: uvEnv });
    assert.equal(rl.status, 0, rl.stderr);
    rmSync(join(root, "seed"), { recursive: true, force: true });
    const home = join(d, "home");
    mkdirSync(home);
    const go = (tmpd, tag) => {
      const env = { TZ: "UTC", UV_CACHE_DIR: join(d, "scratch", "uv-cache-" + tag), UV_PROJECT_ENVIRONMENT: join(d, "scratch", "venv-" + tag) };
      const args = [wt, base, tree, "pytest -q <paths>", JSON.stringify(env), JSON.stringify([]), UV_TIER];
      const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpd } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const bad = go(root, "bad");
    console.log("REAL-UV M1 HIJACK " + JSON.stringify({ status: bad.status, reason: bad.reason }));
    assert.equal(bad.status, "not_run");
    assert.equal(bad.reason, "uv cache prefill refused: uv used the workspace root " + root + ", not the plan base project (an ancestor pyproject.toml)");
    const clean = join(d, "clean");
    mkdirSync(clean);
    const ok = go(clean, "ok");
    console.log("REAL-UV M1 CLEAN " + JSON.stringify({ status: ok.status, reason: ok.reason }));
    // past the prefill: whatever the sandbox step gives here (no bwrap, no coverage in an empty venv), never a prefill reason
    assert.ok(!/^uv cache prefill/.test(ok.reason || ""), ok.reason);
    assert.ok(existsSync(join(d, "scratch", "venv-ok", "pyvenv.cfg")), "the clean prefill made the venv");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
