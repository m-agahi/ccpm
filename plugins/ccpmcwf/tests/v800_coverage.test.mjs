// fleet 8.0.0 car G2: the coverage gate (#6 half, gate 5; ADR-1316).
// cover_diff.py <worktree> <base> <tree> <test_cmd> <env json> <exclude json> builds a throwaway
// detached worktree under <dirname(worktree)>/scratch at the plan base, reads the judged tree in,
// runs the sealed pytest test_cmd once plain (a red baseline: not_run) and once under the coverage
// module (its own rcfile), all within 540 s (hit: partial), and prints the added production .py
// lines no test ran. One read-only agent (infra:gates:r<m>, JUDGE_AGENT, sonnet) runs it each code
// round after its own build-dir reset (with the PATH check), before the code judge's; the code judge gets the result in
// script_findings.coverage and may exempt a line with a reason (exemptions [{gate, path, lines,
// reason}]). An approve that leaves an unexempted uncovered line becomes fix_code, routed like the
// obligations gate. The judge rules; there is no numeric stop.
//
// ACs (plan-8.0.0-gates.md, G2):
// - G2-1: a python fixture with an uncovered added line gives a finding with path and line.
// - G2-2: an approve that does not exempt it becomes fix_code.
// - G2-3: a reasoned exemption passes, and coverage leaves gates_not_run.
// - G2-4: no tool gives not_run, and coverage stays listed.
// - G2-5: a red baseline in the copy gives not_run.
// - G2-6 (non-weakening): the frozen-hash, fingerprint and obligations tests are unchanged (the
//   suite), and the main worktree fingerprint is unchanged by the program.
// - G2-7: an exemption with an empty reason is refused.
//
// Every program test runs python3 by absolute path with PATH set to a stub-only dir (git linked in;
// pytest and coverage are stub scripts). No real coverage module runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, SOURCE, ARGS, happy, run, inputsOf, call, sha256, canon, spawnSync, programSha, FP_K1, FP_K2, HASHES, mutOut, passBwrap, bwrapOk } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "cover_diff.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
// the stubs run with a stub-only PATH: the tools they use, by absolute path
const [CP, WC, TR] = ["cp", "wc", "tr"].map(which);
const PROG_KEYS = ["status", "reason", "findings", "args"];

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const BASE_MOD = "def f(x):\n    return x\n";
const NEW_MOD = "def f(x):\n    return x\n\n\ndef g(x):\n    if x:\n        return 1\n    # a comment\n    return 2\n";

// a repo <d>/wt with a base commit and an uncommitted judged tree (pkg/mod.py: lines 3-9 added;
// tests/test_mod.py changed, the excluded frozen test). Stubs in <d>/bin, the only PATH dir.
// opts: {cov: coverage json files map | null (no coverage stub), version, base: baseline exit,
// runExit: coverage run exit, cmd, files (more judged files), env, attrs (a base .gitattributes),
// textconv (a diff driver "hide" whose textconv prints nothing), link (base pkg/link.py is a
// symlink; the judged tree makes it a regular file: a type change)}
function fixture(opts = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-g2-"));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  if (opts.attrs) writeFileSync(join(wt, ".gitattributes"), opts.attrs);
  if (opts.link) symlinkSync("mod.py", join(wt, "pkg", "link.py"));
  g(wt, "init", "-q", "-b", "master");
  if (opts.textconv) g(wt, "config", "diff.hide.textconv", which("true"));
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "pkg", "mod.py"), NEW_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n\n\ndef test_g():\n    pass\n");
  if (opts.link) {
    rmSync(join(wt, "pkg", "link.py"));
    writeFileSync(join(wt, "pkg", "link.py"), "x = 1\n\ny = 2\n");
  }
  for (const m of opts.mk || []) mkdirSync(join(wt, m), { recursive: true });
  for (const [p, t] of Object.entries(opts.files || {})) writeFileSync(join(wt, p), t);
  // the judged tree object, written through a throwaway index (the worktree index stays as it is)
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  const log = join(d, "calls.log");
  const envlog = join(d, "env.log");
  symlinkSync(GIT, join(bin, "git"));
  // 8.1.0 (#75): the gate logic runs behind a pass-through bwrap (v810 runs the real one)
  passBwrap(bin);
  // 8.0.0 car F (A-M3): the real python3, for the python -m pytest shape
  if (opts.py) symlinkSync(PY, join(bin, "python3"));
  const put = (n, body) => {
    writeFileSync(join(bin, n), "#!/bin/sh\n" + body);
    chmodSync(join(bin, n), 0o755);
  };
  // pytest: logs its argv and the judged file's line count in the copy
  put("pytest", 'echo "pytest $* lines=$(' + WC + ' -l < pkg/mod.py | ' + TR + ' -d \' \')" >> \'' + log + "'\nexit " + (opts.base || 0) + "\n");
  if (opts.cov !== null) {
    writeFileSync(join(d, "cov.json"), JSON.stringify({ meta: {}, files: opts.cov || { "pkg/mod.py": { executed_lines: [1, 2, 5, 6, 7], missing_lines: [9], excluded_lines: [] } } }));
    put(
      "coverage",
      'echo "coverage $*" >> \'' + log + "'\n" +
        // what code under test would see: the coverage env vars (a planted conftest reads or rewrites them)
        'echo "COVERAGE_FILE=$COVERAGE_FILE COVERAGE_RCFILE=$COVERAGE_RCFILE" >> \'' + envlog + "'\n" +
        'case "$1" in\n' +
        "  --version) exit " + (opts.version || 0) + " ;;\n" +
        '  run) for a in "$@"; do case "$a" in --rcfile=*) ' + CP + ' "${a#--rcfile=}" \'' + join(d, "rc.seen") + "';; esac; done; exit " + (opts.runExit || 0) + " ;;\n" +
        // a forged report: whatever file COVERAGE_FILE names (a conftest's rewrite), else the canned one
        '  json) while [ "$1" != "-o" ]; do shift; done; if [ -n "$COVERAGE_FILE" ] && [ -f "$COVERAGE_FILE" ]; then ' + CP + ' "$COVERAGE_FILE" "$2"; else ' + CP + " '" + join(d, "cov.json") + "' \"$2\"; fi ;;\n" +
        "esac\n",
    );
  }
  const fp = () => [g(wt, "rev-parse", "HEAD"), g(wt, "status", "--porcelain"), g(wt, "worktree", "list", "--porcelain")].join("\n");
  const before = fp();
  const args = [wt, base, tree, opts.cmd || "pytest -q <paths>", JSON.stringify(opts.env || { TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])];
  const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: Object.assign({ PATH: bin }, bwrapOk(bin)) });
  const res = {
    r,
    out: r.status === 0 ? JSON.parse(r.stdout) : null,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    envs: existsSync(envlog) ? readFileSync(envlog, "utf8").trim().split("\n") : [],
    d,
    rc: existsSync(join(d, "rc.seen")) ? readFileSync(join(d, "rc.seen"), "utf8") : null,
    args,
    base,
    tree,
    same: fp() === before,
    leftovers: existsSync(join(d, "scratch")) ? readdirSync(join(d, "scratch")) : [],
  };
  rmSync(d, { recursive: true, force: true });
  return res;
}
function digestOk(o) {
  const x = { program: o.program };
  for (const k of PROG_KEYS) x[k] = o[k] === undefined ? null : o[k];
  return sha256(canon(x)) === o.digest;
}

// ---------------------------------------------------------------- cover_diff.py

test("8.0.0 G2-1: an uncovered added line gives a finding with its path and line; the copy holds the judged tree", { skip: !HAVE_PY }, () => {
  const x = fixture();
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "ran");
  assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }]);
  assert.equal(x.out.reason, "1 uncovered added line(s) in 1 file(s)");
  assert.deepEqual(x.out.args, x.args);
  assert.equal(x.out.program.name, "cover_diff");
  assert.equal(x.out.program.sha256, programSha("cover_diff"));
  assert.ok(digestOk(x.out), "the workflow's digest");
  const m = /^coverage run --rcfile=(\S+) --data-file=(\S+) -m pytest -q$/.exec(x.calls[2]);
  assert.ok(m, x.calls[2]);
  assert.deepEqual(x.calls, ["coverage --version", "pytest -q lines=9", x.calls[2], "coverage json --rcfile=" + m[1] + " --data-file=" + m[2] + " -o " + x.calls[3].split(" -o ")[1]]);
  // the data file and the report sit outside the fixture dir (the worktree, its scratch dir and the copy)
  for (const f of [m[1], m[2], x.calls[3].split(" -o ")[1]]) assert.ok(!f.startsWith(x.d + "/"), f);
  // no coverage env var reaches the child (only argv carries the rcfile and the data file)
  assert.deepEqual([...new Set(x.envs)], ["COVERAGE_FILE= COVERAGE_RCFILE="]);
  // the program's own rcfile: no repo omit list, no pragma exclusion
  assert.match(x.rc, /^\[run\]\nsource = \.\nrelative_files = True\n/);
  assert.match(x.rc, /\[report\]\nexclude_lines =\n {4}\(\?!x\)x\n$/);
  assert.ok(!/omit/.test(x.rc));
});

test("8.0.0 G2-6 (non-weakening): the main worktree is untouched and no copy is left behind", { skip: !HAVE_PY }, () => {
  for (const o of [{}, { base: 1 }, { runExit: 1 }, { version: 1 }]) {
    const x = fixture(o);
    assert.ok(x.same, JSON.stringify(o) + ": HEAD, status and the worktree list are unchanged");
    assert.deepEqual(x.leftovers, [], JSON.stringify(o) + ": the scratch dir is empty");
  }
});

test("8.0.0 G2-1: a changed file the report lacks counts every added line that is not blank or a comment; excluded lines count", { skip: !HAVE_PY }, () => {
  const x = fixture({ cov: {} });
  assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [5, 6, 7, 9] }]);
  const y = fixture({ cov: { "pkg/mod.py": { executed_lines: [1, 2, 5, 6, 9], missing_lines: [], excluded_lines: [7] } } });
  assert.deepEqual(y.out.findings, [{ path: "pkg/mod.py", lines: [7] }], "a pragma-excluded line is uncovered");
  const z = fixture({ cov: { "pkg/mod.py": { executed_lines: [1, 2, 5, 6, 7, 9], missing_lines: [], excluded_lines: [] } } });
  assert.equal(z.out.status, "ran");
  assert.deepEqual(z.out.findings, []);
  assert.equal(z.out.reason, null);
});

test("8.0.0 G2-4: no coverage tool gives not_run with the reason; no test runs", { skip: !HAVE_PY }, () => {
  const x = fixture({ cov: null });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "no coverage tool: coverage is not on PATH");
  assert.deepEqual(x.calls, []);
  const y = fixture({ version: 1 });
  assert.equal(y.out.status, "not_run");
  assert.equal(y.out.reason, "no coverage tool: coverage --version exit 1");
  assert.deepEqual(y.calls, ["coverage --version"]);
  // the runner prefix: python -m coverage, uv run coverage
  const z = fixture({ cov: null, cmd: "python3 -m pytest -q" });
  assert.equal(z.out.status, "not_run");
  assert.match(z.out.reason, /^no coverage tool: python3 -m coverage --version exit \d+$/);
  for (const cmd of ["npm test", "go test ./...", "cargo test", "npx jest"]) {
    const u = fixture({ cmd });
    assert.equal(u.out.status, "not_run", cmd);
    assert.match(u.out.reason, /^unsupported: the coverage gate runs a pytest test_cmd only/, cmd);
    assert.deepEqual(u.calls, [], cmd);
  }
});

// 8.0.0 car F (G2 ruling): a red baseline reruns the suite at the plan base: base red too is the environment
test("8.0.0 G2-5: a red baseline in the copy gives not_run; coverage never runs", { skip: !HAVE_PY }, () => {
  const x = fixture({ base: 1 });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "baseline red in scratch copy at the tree and at the base (exit 1, 1): the environment");
  assert.deepEqual(x.calls, ["coverage --version", "pytest -q lines=9", "pytest -q lines=2"]);
});

test("8.0.0 car F G2 ruling: the judged tree red and the plan base green gives not_run 'tree red, base green' (the workflow stops)", { skip: !HAVE_PY }, () => {
  const x = fixture({ base: '$(case "$(' + which("cat") + ' pkg/mod.py)" in *"def g"*) echo 1;; *) echo 0;; esac)' });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "tree red, base green: the judged tree fails test_cmd in the scratch copy (exit 1)");
  assert.deepEqual(x.calls, ["coverage --version", "pytest -q lines=9", "pytest -q lines=2"]);
  assert.deepEqual(x.leftovers.filter((n) => n.startsWith("copy-")), []);
});

test("8.0.0 car F (security review): a file the tree's run leaves in the copy cannot make the base red: the base runs from a clean copy", { skip: !HAVE_PY }, () => {
  const C = which("cat");
  const x = fixture({ base: '$(case "$(' + C + ' pkg/mod.py)" in *"def g"*) : > .planted; echo 1;; *) if [ -e .planted ]; then echo 1; else echo 0; fi;; esac)' });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.reason, "tree red, base green: the judged tree fails test_cmd in the scratch copy (exit 1)");
});

test("8.0.0 G2: a coverage tool that errors after a green baseline exits non-zero (the workflow retries, then stops)", { skip: !HAVE_PY }, () => {
  const x = fixture({ runExit: 2 });
  assert.notEqual(x.r.status, 0);
  assert.equal(x.out, null);
  assert.match(x.r.stderr, /coverage run exit 2 with a green baseline/);
  const y = fixture({ cov: { "pkg/mod.py": "not a map" } });
  assert.equal(y.out.status, "ran", "a malformed file entry counts the file as not measured");
  assert.deepEqual(y.out.findings, [{ path: "pkg/mod.py", lines: [5, 6, 7, 9] }]);
});

test("8.0.0 G2: no added production .py line: ran with no finding, no test runs; the frozen tests are excluded", { skip: !HAVE_PY }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-g2b-"));
  try {
    const wt = join(d, "wt");
    mkdirSync(join(wt, "tests"), { recursive: true });
    writeFileSync(join(wt, "tests", "test_a.py"), "x = 1\n");
    writeFileSync(join(wt, "README"), "a\n");
    g(wt, "init", "-q", "-b", "master");
    g(wt, "add", "-A");
    g(wt, "commit", "-qm", "base");
    const base = g(wt, "rev-parse", "HEAD");
    writeFileSync(join(wt, "tests", "test_a.py"), "x = 1\ny = 2\n");
    writeFileSync(join(wt, "README"), "a\nb\n");
    g(wt, "add", "-A");
    const tree = g(wt, "write-tree");
    const bin = join(d, "bin");
    mkdirSync(bin);
    symlinkSync(GIT, join(bin, "git"));
    passBwrap(bin);
    writeFileSync(join(bin, "coverage"), "#!/bin/sh\nexit 9\n");
    chmodSync(join(bin, "coverage"), 0o755);
    const r = spawnSync(PY, ["-I", PROG, wt, base, tree, "pytest", "{}", JSON.stringify(["tests/test_a.py"])], { encoding: "utf8", env: Object.assign({ PATH: bin }, bwrapOk(bin)) });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.status, "ran");
    assert.equal(o.reason, "no added line in a production .py file");
    assert.deepEqual(o.findings, []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G2 (non-weakening): the PATH guard of scratch_copy run: no terraform-family name runs or shadows the agent PATH", { skip: !HAVE_PY }, () => {
  const bad = (cmd, env) => {
    const x = fixture({ cmd, env });
    assert.notEqual(x.r.status, 0, cmd + " " + JSON.stringify(env));
    assert.deepEqual(x.calls, [], "nothing ran");
    return x.r.stderr;
  };
  assert.match(bad("uv run pytest", { PATH: "rel/bin" }), /relative entry/);
  const d = mkdtempSync(join(tmpdir(), "fleet-g2c-"));
  try {
    writeFileSync(join(d, "tofu"), "#!/bin/sh\n");
    chmodSync(join(d, "tofu"), 0o755);
    assert.match(bad("pytest", { PATH: d }), /terraform-family name/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /REFUSED = \{'terraform', 'tofu', 'tfp', 'terragrunt', 'digger', 'atlantis'\}/);
  assert.match(src, /preexec_fn=lift, start_new_session=True/);
  assert.match(src, /os\.killpg\(p\.pid, signal\.SIGKILL\)/);
  assert.match(src, /DEADLINE, CAP = 540, 400/);
  assert.match(src, /'core\.hooksPath=\/dev\/null'/);
});

// ---------------------------------------------------------------- the workflow

const GATES = /^infra:gates:r\d+$/;
// a gates stub: the coverage slot with the prompt's own args (the harness fills program and digest)
// 8.0.0 (G5): and the mutation slot's harness default (not_run)
function gatesStub(over) {
  return (prompt) => ({ status: "ok", reason: "ran", coverage: Object.assign({ status: "ran", reason: null, findings: [], args: argsOf(prompt) }, over), mutation: mutOut(prompt) });
}
function argsOf(prompt) {
  const m = /cover_diff\.py'((?: '(?:[^']|'\\'')*')+)/.exec(prompt);
  return m ? [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")) : [];
}
const UNCOVERED = { reason: "2 uncovered added line(s) in 1 file(s)", findings: [{ path: "src/x.py", lines: [3, 4] }] };
const approve = (ex) => Object.assign({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } }, ex === undefined ? {} : { exemptions: ex });
// round 2 after a fix_code: the coder, its hasher and the judge's post-hasher
const R2 = {
  "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
  "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
  "role:fleet-code-judge:r2": approve(),
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
  // 8.0.0 car F (A-H1): round 2 reports the gate again (a not_run after round 1's findings stops at gates)
  "infra:gates:r2": gatesStub({}),
};

test("8.0.0 G2: each code round runs infra:gates:r<m> (cover_diff, read-only, sonnet) after its own reset, before the judge", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const i = out.labels.indexOf("infra:gates:r1");
  assert.ok(i > 0, out.labels.join(", "));
  assert.equal(out.labels[i - 1], "infra:build-reset:gates:r1", "its own reset and PATH check");
  // 8.0.0 (G4): the held-out runner, behind its own reset, sits between the gate and the judge's reset
  assert.deepEqual(out.labels.slice(i + 1, i + 5), ["infra:build-reset:held-out:r1", "role:fleet-held-out-runner:r1", "infra:build-reset:code-judge:r1", "role:fleet-code-judge:r1"]);
  const c = call(out, "infra:gates:r1");
  assert.equal(c.opts.model, "sonnet");
  assert.equal(c.opts.agentType, "ccpmcwf:judge");
  assert.match(c.prompt, /timeout 600000 ms/);
  const a = argsOf(c.prompt);
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.equal(a.length, 6);
  assert.equal(a[0], cj.main_worktree || a[0]);
  assert.equal(a[2], FP_K1.tree, "the judged tree");
  assert.equal(a[3], "pytest <paths>", "the sealed test_cmd");
  const env = JSON.parse(a[4]);
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.match(env.COVERAGE_FILE, /\/gates-r1\/coverage$/, "the gate's own build dir");
  assert.ok(JSON.parse(a[5]).length >= 1, "the frozen test files are excluded");
  // the reset empties the gate's build dir too
  assert.match(call(out, "infra:build-reset:gates:r1").prompt, /gates-r1/);
  // the default stub: no coverage tool -> not_run, and the judge sees it
  assert.deepEqual(cj.script_findings.coverage, { status: "not_run", reason: "no coverage tool: coverage is not on PATH", findings: [] });
  assert.equal(cj.script_findings.status, "not_run", "mutation and security_scan: the fail-closed default");
  assert.ok(out.logs.includes("gate coverage: not_run (no coverage tool: coverage is not on PATH)"), out.logs.join("\n"));
});

test("8.0.0 G2-4: no coverage tool: not_run, and coverage stays in gates_not_run with the program's reason", async () => {
  const out = await run(happy(), ARGS);
  assert.deepEqual(out.result.gates_not_run.map((x) => x.gate), ["mutation", "coverage", "security_scan", "held_out"]);
  assert.equal(out.result.gates_not_run.find((x) => x.gate === "coverage").reason, "no coverage tool: coverage is not on PATH");
});

test("8.0.0 G2-2: an approve that leaves an uncovered line unexempted becomes fix_code; the coder gets path and lines", async () => {
  const s = happy({ script: Object.assign({ "infra:gates:r1": gatesStub(UNCOVERED), "role:fleet-code-judge:r1": approve() }, R2) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.includes("code round 1: coverage gate: code-judge approve converted to fix_code (2 line(s): src/x.py:3, src/x.py:4)"), out.logs.join("\n"));
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.equal(c2.routed_findings.length, 1);
  assert.equal(c2.routed_findings[0].target, "code");
  assert.match(c2.routed_findings[0].finding, /src\/x\.py:3, src\/x\.py:4/);
  assert.ok(!out.labels.includes("infra:commit:r1"), "nothing committed in round 1");
  assert.ok(out.labels.includes("infra:gates:r2"), "the gate runs again in round 2");
  // the judge got the findings
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).script_findings.coverage.findings, UNCOVERED.findings);
});

test("8.0.0 G2-3: a reasoned exemption passes, and coverage leaves gates_not_run", async () => {
  const ex = [{ gate: "coverage", path: "src/x.py", lines: [3, 4], reason: "defensive branch: unreachable from the API" }];
  const out = await run(happy({ script: { "infra:gates:r1": gatesStub(UNCOVERED), "role:fleet-code-judge:r1": approve(ex) } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.deepEqual(out.result.gates_not_run.map((x) => x.gate), ["mutation", "security_scan", "held_out"]);
  // a clean ran result leaves the list too
  const clean = await run(happy({ script: { "infra:gates:r1": gatesStub({}) } }), ARGS);
  assert.deepEqual(clean.result.gates_not_run.map((x) => x.gate), ["mutation", "security_scan", "held_out"]);
});

test("8.0.0 G2-7: an exemption with an empty or blank reason is refused (schema and script)", async () => {
  for (const reason of ["", "   "]) {
    const ex = [{ gate: "coverage", path: "src/x.py", lines: [3, 4], reason }];
    const out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(UNCOVERED), "role:fleet-code-judge:r1": approve(ex) }, R2) }), ARGS);
    assert.ok(out.labels.includes("role:fleet-coder:r2"), JSON.stringify(reason) + ": fix_code");
  }
  const sch = call(await run(happy(), ARGS), "role:fleet-code-judge:r1").opts.schema;
  const item = sch.properties.exemptions.items;
  assert.deepEqual(item.required, ["gate", "path", "lines", "reason"]);
  // no JSON-schema pattern keyword (no other role schema uses one): the script refuses a blank reason
  assert.deepEqual(item.properties.reason, { type: "string" });
});

test("8.0.0 G2: an exemption covers only its own gate, path and lines", async () => {
  for (const ex of [
    [{ gate: "coverage", path: "src/x.py", lines: [3], reason: "r" }],
    [{ gate: "mutation", path: "src/x.py", lines: [3, 4], reason: "r" }],
    [{ gate: "coverage", path: "src/y.py", lines: [3, 4], reason: "r" }],
  ]) {
    const out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(UNCOVERED), "role:fleet-code-judge:r1": approve(ex) }, R2) }), ARGS);
    assert.ok(out.labels.includes("role:fleet-coder:r2"), JSON.stringify(ex));
  }
  const part = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(UNCOVERED), "role:fleet-code-judge:r1": approve([{ gate: "coverage", path: "src/x.py", lines: [3], reason: "r" }]) }, R2) }), ARGS);
  assert.match(inputsOf(call(part, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /: src\/x\.py:4 /);
  // a partial result's findings route the same way; a not_run result routes nothing
  const p = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub(Object.assign({}, UNCOVERED, { status: "partial", reason: "more than 400" })), "role:fleet-code-judge:r1": approve() }, R2) }), ARGS);
  assert.ok(p.labels.includes("role:fleet-coder:r2"));
  assert.ok(p.logs.includes("gate coverage: partial (more than 400)"), p.logs.join("\n"));
});

test("8.0.0 G2: a gate relay that errs twice stops at gate gates (one retry, ADR-1316)", async () => {
  const out = await run(happy({ script: { "infra:gates:r1": { status: "ok", reason: "exit 1", coverage: null } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "gates");
  assert.ok(out.labels.includes("infra:gates:r1:digest-retry"));
  assert.ok(!out.labels.includes("role:fleet-code-judge:r1"));
});

// 8.0.0 (G4): 10, the held-out runner is capped too
test("8.0.0 G2: a code round reserves 9 agents (the gate is capped; G4: 10, with the held-out runner)", () => {
  assert.match(SOURCE, /reserve\(11 \+ \(planFacts\.changed_symbols \? 1 : 0\)/);
  assert.match(SOURCE, /\["infra:gates:", "sonnet"\]/);
});

test("8.0.0 G2: the roles: the code judge rules on coverage findings with exemptions; the pr-opener no longer names a fixed list", () => {
  const cj = readFileSync(join(HERE, "..", "roles", "fleet-code-judge.md"), "utf8");
  assert.match(cj, /exemptions/);
  assert.match(cj, /script_findings\.coverage/);
  const po = readFileSync(join(HERE, "..", "roles", "fleet-pr-opener.md"), "utf8");
  assert.ok(!/always lists at least/.test(po));
});

// ---------------------------------------------------------------- security review (G2)

test("8.0.0 G2 security: a COVERAGE_FILE the env or a planted conftest names cannot forge the report; the child gets no coverage env", { skip: !HAVE_PY }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-g2f-"));
  try {
    const forged = join(d, "forged.json");
    writeFileSync(forged, JSON.stringify({ files: { "pkg/mod.py": { executed_lines: [1, 2, 3, 4, 5, 6, 7, 8, 9], missing_lines: [], excluded_lines: [] } } }));
    // the workflow's own env carries COVERAGE_FILE (a build var) and more build vars
    const x = fixture({ env: { TZ: "UTC", COVERAGE_FILE: forged, COVERAGE_RCFILE: forged, PYTHONPYCACHEPREFIX: join(d, "pyc"), UV_PROJECT_ENVIRONMENT: join(d, "venv") } });
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.equal(x.out.status, "ran");
    assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }], "the forged all-covered report is never read");
    assert.deepEqual([...new Set(x.envs)], ["COVERAGE_FILE= COVERAGE_RCFILE="]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G2 security: a changed file with zero records is never clean", { skip: !HAVE_PY }, () => {
  const x = fixture({ cov: { "pkg/mod.py": { executed_lines: [], missing_lines: [], excluded_lines: [] } } });
  assert.equal(x.out.status, "ran");
  assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [5, 6, 7, 9] }]);
});

test("8.0.0 G2 security: git attributes cannot hide added lines (binary, textconv); a type change is included", { skip: !HAVE_PY }, () => {
  for (const o of [{ attrs: "*.py binary\n" }, { attrs: "*.py -diff\n" }, { attrs: "*.py diff=hide\n", textconv: true }]) {
    const x = fixture(o);
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }], JSON.stringify(o));
  }
  const t = fixture({ link: true });
  assert.deepEqual(t.out.findings, [{ path: "pkg/link.py", lines: [1, 3] }, { path: "pkg/mod.py", lines: [9] }], "the T entry, not measured: its code lines");
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /'--text', '--no-textconv', '--no-ext-diff'/);
  assert.match(src, /'core\.attributesFile=\/dev\/null'/);
  assert.match(src, /GIT_ATTR_NOSYSTEM/);
  assert.match(src, /--diff-filter=AMT/);
});

test("8.0.0 G2: a changed source file coverage.py cannot measure (not python) gives partial, never a clean ran", { skip: !HAVE_PY }, () => {
  const x = fixture({ files: { "pkg/x.js": "module.exports = 1;\n" } });
  assert.equal(x.out.status, "partial");
  assert.match(x.out.reason, /not measured \(not python\): pkg\/x\.js/);
  assert.deepEqual(x.out.findings, [{ path: "pkg/mod.py", lines: [9] }]);
});

// 8.0.0 car F (A-M3): python -m coverage put the copy (the judged tree) first on sys.path, so a tree-local
// coverage package replaced the tool and wrote a clean report. The program now loads coverage through a
// launcher in its private work dir; coverage run still gives the test run the cwd (as python -m pytest does).
test("8.0.0 car F A-M3: a tree-local coverage package cannot fake the report (python -m pytest shape)", { skip: !HAVE_PY || spawnSync("python3", ["-c", "import pytest"]).status !== 0 }, () => {
  const g0 = mkdtempSync(join(tmpdir(), "fleet-cov-real-"));
  const main = (rep) => "import sys\na = sys.argv[1:]\nif a[:1] == ['json']:\n    open(a[a.index('-o') + 1], 'w').write(" + JSON.stringify(JSON.stringify(rep)) + ")\nsys.exit(0)\n";
  try {
    // the "real" coverage tool (on PYTHONPATH): run exits 0, json reports line 9 missing
    mkdirSync(join(g0, "coverage"));
    writeFileSync(join(g0, "coverage", "__init__.py"), "");
    writeFileSync(join(g0, "coverage", "__main__.py"), main({ files: { "pkg/mod.py": { executed_lines: [1, 2, 5, 6, 7], missing_lines: [9], excluded_lines: [] } } }));
    // the judged tree's own coverage package: a clean report
    const files = { "coverage/__init__.py": "", "coverage/__main__.py": main({ files: { "pkg/mod.py": { executed_lines: [1, 2, 5, 6, 7, 9], missing_lines: [], excluded_lines: [] } } }) };
    const x = fixture({ py: true, cmd: "python3 -m pytest -q <paths>", env: { PYTHONPATH: g0, PYTHONDONTWRITEBYTECODE: "1" }, files, mk: ["coverage"] });
    assert.equal(x.r.status, 0, x.r.stderr);
    assert.equal(x.out.status, "ran", x.out.reason);
    // the real tool's report, not the tree's (the tree's own coverage/ files are changed lines it never ran)
    assert.deepEqual(x.out.findings.find((f) => f.path === "pkg/mod.py"), { path: "pkg/mod.py", lines: [9] });
  } finally {
    rmSync(g0, { recursive: true, force: true });
  }
});

test("8.0.0 car F A-L12: a coder-written path reaches the gate line and the coder's finding with control characters replaced and cut at 200 characters", async () => {
  const p = "src/a\nb\u2028" + "y".repeat(300) + ".py";
  const s = happy({ script: Object.assign({ "infra:gates:r1": gatesStub({ reason: "1 uncovered", findings: [{ path: p, lines: [3] }] }), "role:fleet-code-judge:r1": approve() }, R2) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const shown = ("src/a?b?" + "y".repeat(300)).slice(0, 200);
  const line = out.logs.find((l) => /coverage gate: code-judge approve converted/.test(l));
  assert.ok(line.includes(shown + ":3") && !/[\n\u2028]/.test(line) && !line.includes("y".repeat(201)), line);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding;
  assert.ok(f.includes(shown + ":3") && !f.includes("y".repeat(201)), f);
});
