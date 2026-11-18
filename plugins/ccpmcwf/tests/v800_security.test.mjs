// fleet 8.0.0 car G7: the security gate (gate 10; ADR-1315, ADR-1316), plus step 0 (security review
// of G6: the resumed aug_files list is checked against the generated name).
//
// sec_scan.py <worktree> <base> <tree> <exclude json> <est_diff_lines> <image> is the 3rd slot
// (security_scan) of the existing infra:gates:r<m> agent, one Bash call per slot. It runs only git
// and the container runtime (podman, else docker); semgrep and gitleaks run only inside the
// digest-pinned audit-lab image, network off, read-only, as the host uid, with read-only mounts of
// a scan dir that holds only the judged blobs of the changed production files, and of a rules dir:
// the plugin's pinned rule file (its sha256 is in sec_scan.py) plus the repo's rules read from the
// base, never from the judged tree. Always on (no container): a risky-API grep on the added lines,
// a size check against 1.5 x est_diff_lines and frozen-test literals in added production lines.
// Findings: [{path, lines, rule, kind: code|secret}] on added lines only. The code judge exempts
// each code finding (exemptions, gate security_scan); a secret is never exempted.
//
// ACs (plan-8.0.0-gates.md, G7 as revised by Max's rulings of 2026-11-17):
// - G7-1: an added shell=True line with no exemption turns an approve into fix_code.
// - G7-2: a fixture secret always gives fix_code.
// - G7-3: no runtime or no image gives the container part not_run; security_scan stays listed
//   (partial: only the always-on part ran).
// - G7-4: the program runs only allowlisted executables (stub-only PATH test).
// - G7-5: the source holds no IaC binary name.
// - G7-6 (non-weakening): the tf-gate and fence tests are unchanged (the full suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync, statSync, lstatSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { HERE, HAVE_PY, SOURCE, ARGS, FP_K2, HASHES, AUDIT_IMAGE, happy, run, runOne, inputsOf, call, sha256, canon, spawnSync, programSha, stateJsonOf, K, cacheHome, underTemp } from "./harness.mjs";
import { PROGRAM_COUNT } from "../scripts/gen.mjs";

const PROG = join(HERE, "..", "scripts", "sec_scan.py");
const GT = join(HERE, "..", "scripts", "gate_tools.py");
const RULES = join(HERE, "..", "skills", "build-task", "sec-rules.yml");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
const SEMGREP = which("semgrep");
const DIGEST = "sha256:cc0d88ecfa9c70ab81be01331f05ca822db0f197d212de63c571add7aaceb66b";
const PROG_KEYS = ["status", "reason", "findings", "args"];
const UID = process.getuid() + ":" + process.getgid();

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const BASE_MOD = "import subprocess\n\n\ndef f(x):\n    return x\n";
// line 9 of pkg/mod.py in the judged tree
const SHELL = "\n\ndef g(cmd):\n    return subprocess.run(cmd, shell=True)\n";

// the stub runtime: a python script that logs its argv (calls.log, one JSON array per line), and
// for `run` the files and modes of each -v source dir (mounts.log); it prints $STUB_<TOOL> (a file)
// and exits $STUB_<TOOL>_RC; `image exists` / `image inspect` exit $STUB_EXISTS (default 0); a run
// sleeps $STUB_SLEEP seconds after it logs its mounts (G8: the deadline and TERM cleanup tests)
const STUB = (log) =>
  "#!" + PY + " -I\nimport json, os, sys\na = sys.argv[1:]\n" +
  "open(" + JSON.stringify(log) + ", 'a').write(json.dumps([os.path.basename(sys.argv[0])] + a) + '\\n')\n" +
  "if a[:1] == ['image']:\n    sys.exit(int(os.environ.get('STUB_EXISTS', '0')))\n" +
  "if a[:1] == ['pull']:\n    sys.exit(int(os.environ.get('STUB_PULL', '0')))\n" +
  "if a[:1] == ['rm']:\n    sys.exit(0)\n" +
  "m = {}\nfor i, x in enumerate(a):\n    if a[i - 1] == '-v' and i:\n        s, d = x.split(':')[0], x.split(':')[1]\n" +
  "        fs = {}\n        for r, ds, ns in os.walk(s):\n            for n in ns:\n                p = os.path.join(r, n)\n" +
  "                fs[os.path.relpath(p, s)] = [oct(os.stat(p).st_mode & 0o777), open(p).read()]\n        m[d] = fs\n" +
  "open(" + JSON.stringify(log + ".mounts") + ", 'a').write(json.dumps(m) + '\\n')\n" +
  "if os.environ.get('STUB_SLEEP'):\n    import time\n    time.sleep(float(os.environ['STUB_SLEEP']))\n" +
  "t = a[a.index('--entrypoint') + 1].upper()\n" +
  "if os.environ.get('STUB_' + t):\n    o = open(os.environ['STUB_' + t]).read()\n" +
  "    if '\"ALL\"' in o:\n        d = json.loads(o)\n        d['paths']['scanned'] = ['/src/' + k for k in m['/src']]\n        o = json.dumps(d)\n" +
  "    sys.stdout.write(o)\n" +
  "sys.exit(int(os.environ.get('STUB_' + t + '_RC', '0')))\n";
// traps: executables that must never run (each logs its name)
const TRAPS = ["semgrep", "gitleaks", "trivy", "checkov", "python3", "sh", "bash", "curl", "pytest", "ruff", "bandit"];

// a repo <d>/wt with a base commit and an uncommitted judged tree; <d>/bin is the only PATH dir
// (git linked in, the stub runtime opts.rt, the traps); <cache> is a temp XDG_CACHE_HOME outside the
// temp dirs (G8: sec_scan.py refuses a scan dir under /tmp, /var/tmp or /dev/shm)
function repo(opts = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-g7-")));
  const cache = cacheHome();
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(join(wt, ".semgrep"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pkg", "__init__.py"), "");
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD);
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  writeFileSync(join(wt, ".semgrep", "base.yml"), "rules: [] # the base's own rules\n");
  for (const [p, t] of Object.entries(opts.baseFiles || {})) writeFileSync(join(wt, p), t);
  g(wt, "init", "-q", "-b", "master");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "pkg", "mod.py"), BASE_MOD + (opts.add === undefined ? SHELL : opts.add));
  writeFileSync(join(wt, "tests", "test_mod.py"), opts.test || "def test_f():\n    pass\n");
  for (const [p, t] of Object.entries(opts.files || {})) writeFileSync(join(wt, p), t);
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  symlinkSync(GIT, join(bin, "git"));
  const log = join(d, "calls.log");
  for (const n of opts.rt || []) {
    writeFileSync(join(bin, n), STUB(log));
    chmodSync(join(bin, n), 0o755);
  }
  for (const n of TRAPS.filter((n) => !(opts.rt || []).includes(n))) {
    writeFileSync(join(bin, n), "#!/bin/false\n");
    chmodSync(join(bin, n), 0o755);
  }
  const fp = () => [g(wt, "rev-parse", "HEAD"), g(wt, "status", "--porcelain"), g(wt, "worktree", "list", "--porcelain"), readFileSync(join(wt, "pkg", "mod.py"), "utf8")].join("\n");
  return { d, wt, bin, base, tree, log, cache, fp, before: fp() };
}
// run the program; opts.out: {semgrep, gitleaks} stdout texts; opts.rc: {semgrep, gitleaks, exists};
// opts.env: more env (XDG_CACHE_HOME: null unsets it); opts.spawn: more spawnSync options
function prog(x, opts = {}) {
  const args = [x.wt, x.base, x.tree, JSON.stringify(opts.exclude || ["tests/test_mod.py"]), opts.est === undefined ? "40" : opts.est, opts.image || AUDIT_IMAGE];
  const env = { PATH: x.bin, HOME: x.d, XDG_CACHE_HOME: x.cache };
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  for (const [t, v] of Object.entries(opts.out || {})) {
    writeFileSync(join(x.d, t + ".out"), v);
    env["STUB_" + t.toUpperCase()] = join(x.d, t + ".out");
  }
  for (const [t, v] of Object.entries(opts.rc || {})) env["STUB_" + t.toUpperCase() + (t === "exists" || t === "pull" ? "" : "_RC")] = String(v);
  const r = spawnSync(PY, ["-I", PROG].concat(args), Object.assign({ encoding: "utf8", env }, opts.spawn || {}));
  const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    r,
    out: r.status === 0 ? JSON.parse(r.stdout) : null,
    args,
    calls: lines(x.log),
    mounts: lines(x.log + ".mounts"),
    same: x.fp() === x.before,
    leftovers: existsSync(join(x.cache, "fleet", "sec-scan")) ? readdirSync(join(x.cache, "fleet", "sec-scan")) : [],
    scratch: existsSync(join(x.d, "scratch")),
  };
}
function once(opts, popts) {
  const x = repo(opts);
  try {
    return Object.assign(prog(x, popts), { x });
  } finally {
    rmSync(x.d, { recursive: true, force: true });
    rmSync(x.cache, { recursive: true, force: true });
  }
}
function digestOk(o) {
  const x = { program: o.program };
  for (const k of PROG_KEYS) x[k] = o[k] === undefined ? null : o[k];
  return sha256(canon(x)) === o.digest;
}
// paths.scanned "ALL": the stub lists every file it mounted at /src (review fix 2)
const SG = (results, errors, scanned) => JSON.stringify({ results, errors: errors || [], paths: { scanned: scanned || "ALL" }, version: "1.175.0" });
const sgHit = (path, line, id) => ({ check_id: id, path: "/src/" + path, start: { line, col: 1 }, end: { line, col: 9 }, extra: { message: "m", severity: "ERROR", lines: "x" } });
const GL = (hits) => JSON.stringify(hits.map(([p, l]) => ({ RuleID: "generic-api-key", Description: "d", StartLine: l, EndLine: l, File: "/src/" + p, Secret: "REDACTED", Match: "REDACTED", Fingerprint: p + ":generic-api-key:" + l })));
const CLEAN = { semgrep: SG([]), gitleaks: "[]" };
const runs = (y) => y.calls.filter((c) => c[1] === "run");

// ---------------------------------------------------------------- the image

test("8.0.0 G7: AUDIT_IMAGE is the audit-lab image pinned by its index digest (resolved read-only, never a tag)", () => {
  assert.equal(AUDIT_IMAGE, "docker.io/openfantasy/audit-lab@" + DIGEST);
  assert.match(AUDIT_IMAGE, /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/);
  assert.ok(!/latest/.test(AUDIT_IMAGE));
});

// ---------------------------------------------------------------- sec_scan.py: always on

test("8.0.0 G7-3: no runtime: the container part is not run (partial with the reason); the always-on grep still finds shell=True on its added line", { skip: !HAVE_PY }, () => {
  const y = once({}, {});
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "partial");
  assert.equal(y.out.reason, "container scan not run: no container runtime (podman or docker); always-on checks only");
  assert.deepEqual(y.out.findings, [{ path: "pkg/mod.py", lines: [9], rule: "grep: shell=True", kind: "code" }]);
  assert.deepEqual(y.out.args, y.args);
  assert.equal(y.out.program.name, "sec_scan");
  assert.equal(y.out.program.sha256, programSha("sec_scan"));
  assert.ok(digestOk(y.out), "the workflow's digest");
  assert.deepEqual(y.calls, [], "no runtime call");
  assert.ok(y.same, "the main worktree is untouched");
  assert.deepEqual(y.leftovers, []);
});

test("8.0.0 G7: the risky-API grep: eval/exec, yaml.load without SafeLoader, pickle, SQL from strings, TLS off, os.system; markers; added lines only", { skip: !HAVE_PY }, () => {
  const add = [
    "",
    "def h(s, c, r):",
    "    eval(s)",
    "    exec(s)",
    "    yaml.load(s)",
    "    yaml.load(s, Loader=yaml.SafeLoader)",
    "    pickle.loads(s)",
    "    c.execute(\"SELECT * FROM t WHERE id = %s\" % s)",
    "    c.execute(f\"SELECT {s}\")",
    "    c.execute(\"SELECT 1 WHERE a = ?\", (s,))",
    "    r.get(s, verify=False)",
    "    os.system(s)",
    "    x = 'eval(s) in a string is still a line'  # nosemgrep",
    "    y = 1  # gitleaks:allow",
    "    model.evaluate(s)",
    "",
  ].join("\n");
  const y = once({ add }, {});
  assert.equal(y.r.status, 0, y.r.stderr);
  const by = Object.fromEntries(y.out.findings.map((f) => [f.rule, f]));
  assert.deepEqual(by["grep: eval/exec"].lines, [8, 9, 18]);
  assert.deepEqual(by["grep: yaml.load without SafeLoader"].lines, [10]);
  assert.deepEqual(by["grep: pickle/marshal load"].lines, [12]);
  assert.deepEqual(by["grep: SQL built from strings"].lines, [13, 14]);
  assert.deepEqual(by["grep: TLS verification off"].lines, [16]);
  assert.deepEqual(by["grep: os.system/popen"].lines, [17]);
  assert.deepEqual(by["grep: nosemgrep marker"].lines, [18]);
  assert.deepEqual(by["grep: gitleaks:allow marker"], { path: "pkg/mod.py", lines: [19], rule: "grep: gitleaks:allow marker", kind: "secret" }, "an allow marker is a secret finding");
  assert.ok(!y.out.findings.some((f) => f.lines.some((l) => l <= 5)), "base lines are never findings");
});

test("8.0.0 G7: git attributes cannot hide added lines (binary, -diff); the attribute-safe diff flags of G2", { skip: !HAVE_PY }, () => {
  const y = once({ files: { ".gitattributes": "*.py binary\n*.py -diff\n" } }, {});
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.ok(y.out.findings.some((f) => f.path === "pkg/mod.py" && f.lines.includes(9)), JSON.stringify(y.out.findings));
  const src = readFileSync(PROG, "utf8");
  for (const f of ["'--text'", "'--no-textconv'", "'--no-ext-diff'", "'core.attributesFile=/dev/null'", "GIT_ATTR_NOSYSTEM", "--diff-filter=AMT"]) assert.ok(src.includes(f), f);
});

test("8.0.0 G7: the size check: more added production lines than 1.5 x est_diff_lines is one exemptable finding; est null skips it with a note", { skip: !HAVE_PY }, () => {
  let y = once({}, { est: "2" });
  assert.deepEqual(y.out.findings.find((f) => f.path === "<diff>"), { path: "<diff>", lines: [0], rule: "size: 4 added production lines > 1.5 x est_diff_lines 2", kind: "code" });
  y = once({}, { est: "40" });
  assert.ok(!y.out.findings.some((f) => f.path === "<diff>"));
  y = once({}, { est: "null" });
  assert.ok(!y.out.findings.some((f) => f.path === "<diff>"));
  assert.match(y.out.reason, /; no est_diff_lines: size not checked$/);
});

test("8.0.0 G7: frozen-test literals in added production lines are findings (the test files themselves are never scanned)", { skip: !HAVE_PY }, () => {
  const test0 = "def test_f():\n    assert f('the-magic-answer-42') == 'expected-output-x'\n";
  const y = once({ test: test0, add: "\n\ndef k(x):\n    if x == 'the-magic-answer-42':\n        return 'expected-output-x'\n    return 'short'\n" }, {});
  assert.equal(y.r.status, 0, y.r.stderr);
  const lit = y.out.findings.filter((f) => /^frozen-test literal/.test(f.rule));
  assert.deepEqual(lit, [
    { path: "pkg/mod.py", lines: [10], rule: "frozen-test literal: expected-output-x", kind: "code" },
    { path: "pkg/mod.py", lines: [9], rule: "frozen-test literal: the-magic-answer-42", kind: "code" },
  ]);
  assert.ok(!y.out.findings.some((f) => f.path === "tests/test_mod.py"));
});

// ---------------------------------------------------------------- sec_scan.py: the container

test("8.0.0 G7: the scan argv: podman, network none, read-only, tmpfs, the host uid, no new privileges, no caps, never pull, the pinned image; read-only mounts", { skip: !HAVE_PY }, () => {
  const y = once({ rt: ["podman", "docker"] }, { out: CLEAN });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  assert.deepEqual(y.calls[0], ["podman", "image", "exists", AUDIT_IMAGE]);
  const rs = runs(y);
  assert.equal(rs.length, 2, "semgrep, then gitleaks");
  assert.ok(y.calls.every((c) => c[0] === "podman"), "podman first; docker only when podman is absent");
  for (const a of rs) {
    const s = a.join(" ");
    const pre = ["podman", "run", "--rm", "--pull=never", "--network", "none", "--read-only", "--tmpfs", "/tmp", "--user", UID, "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "-e", "HOME=/tmp", "-w", "/tmp"];
    assert.deepEqual(a.slice(0, pre.length), pre, s);
    const vs = a.map((x, i) => (a[i - 1] === "-v" ? x : null)).filter(Boolean);
    assert.equal(vs.length, 2, s);
    // G8: the per-run dir is under $XDG_CACHE_HOME/fleet/sec-scan, never under the repo's scratch dir
    assert.equal(vs[0], y.x.cache + "/fleet/sec-scan/" + vs[0].split("/").slice(-3)[0] + "/src:/src:ro");
    assert.match(vs[0], /\/fleet\/sec-scan\/run-[0-9a-f]{16}\/src:\/src:ro$/);
    assert.equal(vs[1], vs[0].replace(/\/src:\/src:ro$/, "/rules:/rules:ro"));
    assert.ok(a.includes(AUDIT_IMAGE), s);
    assert.ok(!/latest|\.sock|--privileged|--env-host|--env-file|--network=host|--network host|--volumes-from|--userns=host/.test(s), s);
    assert.equal(a.filter((x) => x === "-e").length, 1, "one explicit env value, never the host env");
  }
  const tail = (a) => a.slice(a.indexOf("--entrypoint"));
  assert.deepEqual(tail(rs[0]), ["--entrypoint", "semgrep", AUDIT_IMAGE, "scan", "--metrics=off", "--disable-version-check", "--disable-nosem", "--max-target-bytes=0", "--config", "/rules", "--json", "/src"]);
  // 8.0.0 car F (A-H2): the plugin's gitleaks config (the default rules, no global path allowlist)
  assert.deepEqual(tail(rs[1]), ["--entrypoint", "gitleaks", AUDIT_IMAGE, "dir", "--no-banner", "--redact=100", "--exit-code", "99", "-f", "json", "-r", "-", "--config", "/rules/gitleaks.toml", "/src"]);
  assert.ok(y.same);
  assert.deepEqual(y.leftovers, [], "the scan dir is removed");
  assert.equal(y.scratch, false, "no scan dir under the repo's scratch dir");
  const d = once({ rt: ["docker"] }, { out: CLEAN });
  assert.deepEqual(d.calls[0], ["docker", "image", "inspect", AUDIT_IMAGE]);
  assert.equal(runs(d)[0][0], "docker");
});

test("8.0.0 G7: the scan dir holds only the judged blobs of the changed production files (world-readable; review fix 1: a scanner config or ignore file under a renamed path; fix 2: an empty .semgrepignore at its root); the rules: the plugin's pinned file plus the base's repo rules; a planted .semgrep.yml or ignore file in the judged tree is ignored", { skip: !HAVE_PY }, () => {
  const files = {
    ".semgrep.yml": "rules: [] # planted in the judged tree\n",
    ".semgrep/base.yml": "rules: [] # rewritten in the judged tree\n",
    ".semgrepignore": "pkg/\n",
    ".gitleaksignore": "x\n",
    ".gitleaks.toml": "title = 'x'\n",
    "pkg/.gitignore": "*.log\n",
    "pkg/new.py": "A = 1\n",
  };
  const y = once({ rt: ["podman"], files }, { out: CLEAN });
  assert.equal(y.r.status, 0, y.r.stderr);
  const m = y.mounts[0];
  assert.deepEqual(Object.keys(m["/src"]).sort(), [".semgrepignore", "_fleet_.gitleaks.toml", "_fleet_.gitleaksignore", "_fleet_.semgrep.yml", "_fleet_.semgrep/base.yml", "_fleet_.semgrepignore", "pkg/_fleet_.gitignore", "pkg/mod.py", "pkg/new.py"]);
  assert.equal(m["/src"][".semgrepignore"][1], "", "an empty ignore file: semgrep's default ignore list is off");
  assert.equal(y.out.status, "ran", y.out.reason);
  assert.equal(m["/src"]["pkg/mod.py"][1], BASE_MOD + SHELL, "the judged blob");
  for (const [, [mode]] of Object.entries(m["/src"]).concat(Object.entries(m["/rules"]))) assert.ok((parseInt(mode.slice(2), 8) & 0o444) === 0o444, "readable by the container uid: " + mode);
  assert.deepEqual(Object.keys(m["/rules"]).sort(), ["fleet.yml", "gitleaks.toml", "repo-0.yml"]);
  assert.equal(m["/rules"]["gitleaks.toml"][1], readFileSync(join(HERE, "..", "skills", "build-task", "gitleaks.toml"), "utf8"));
  assert.equal(m["/rules"]["fleet.yml"][1], readFileSync(RULES, "utf8"));
  assert.equal(m["/rules"]["repo-0.yml"][1], "rules: [] # the base's own rules\n", "repo rules come from the base");
  assert.ok(!JSON.stringify(m["/rules"]).includes("planted in the judged tree"));
  assert.ok(!JSON.stringify(m["/rules"]).includes("rewritten in the judged tree"));
  // a .semgrep.yml at the base is read too
  const z = once({ rt: ["podman"], baseFiles: { ".semgrep.yml": "rules: [] # base top\n" } }, { out: CLEAN });
  assert.deepEqual(Object.values(z.mounts[0]["/rules"]).map((v) => v[1]).sort(), [readFileSync(RULES, "utf8"), readFileSync(join(HERE, "..", "skills", "build-task", "gitleaks.toml"), "utf8"), "rules: [] # base top\n", "rules: [] # the base's own rules\n"].sort());
});

test("8.0.0 G7-2: tool results: semgrep and gitleaks hits on added lines only; a gitleaks hit is a secret, redacted (no secret text in the output)", { skip: !HAVE_PY }, () => {
  const out = { semgrep: SG([sgHit("pkg/mod.py", 9, "fleet.python.shell-true"), sgHit("pkg/mod.py", 5, "fleet.python.eval-exec")]), gitleaks: GL([["pkg/mod.py", 9], ["pkg/mod.py", 1]]) };
  const y = once({ rt: ["podman"] }, { out, rc: { gitleaks: 99 } });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran");
  assert.deepEqual(y.out.findings, [
    { path: "pkg/mod.py", lines: [9], rule: "gitleaks: generic-api-key", kind: "secret" },
    { path: "pkg/mod.py", lines: [9], rule: "grep: shell=True", kind: "code" },
    { path: "pkg/mod.py", lines: [9], rule: "semgrep: fleet.python.shell-true", kind: "code" },
  ]);
  assert.ok(!/REDACTED|Secret|Match/.test(y.r.stdout));
});

test("8.0.0 G7: exit codes map exactly: semgrep 0 parses, any other exit is an error; gitleaks 0 clean, 99 findings, anything else (1 error, 126 bad flag) an error; unparseable output is never clean", { skip: !HAVE_PY }, () => {
  for (const [out, rc, why] of [
    [CLEAN, { semgrep: 1 }, "semgrep exit 1"],
    [CLEAN, { semgrep: 2 }, "semgrep exit 2"],
    [{ semgrep: "", gitleaks: "[]" }, {}, "semgrep empty output"],
    [{ semgrep: "{\"errors\": []}", gitleaks: "[]" }, {}, "semgrep no results list"],
    [CLEAN, { gitleaks: 1 }, "gitleaks exit 1"],
    [CLEAN, { gitleaks: 126 }, "gitleaks exit 126"],
    [{ semgrep: SG([]), gitleaks: "" }, {}, "gitleaks empty output"],
    [{ semgrep: SG([]), gitleaks: "{}" }, { gitleaks: 99 }, "gitleaks not a list"],
  ]) {
    const y = once({ rt: ["podman"] }, { out, rc });
    assert.notEqual(y.r.status, 0, why + ": " + y.r.stdout);
    assert.equal(y.out, null, why);
    assert.deepEqual(y.leftovers, [], why + ": the scan dir is removed");
  }
  // semgrep reports errors (a file it cannot parse): partial, never a clean ran
  const y = once({ rt: ["podman"] }, { out: { semgrep: SG([], [{ type: "Syntax error", message: "x" }]), gitleaks: "[]" } });
  assert.equal(y.out.status, "partial");
  assert.match(y.out.reason, /semgrep reported 1 error/);
});

test("8.0.0 G7-3: a missing image: no pull at scan time, no run; an unpinned image is never checked; the always-on part still runs", { skip: !HAVE_PY }, () => {
  let y = once({ rt: ["podman"] }, { rc: { exists: 1 } });
  assert.equal(y.out.status, "partial");
  assert.equal(y.out.reason, "container scan not run: image not present locally (exit 1); always-on checks only");
  assert.deepEqual(y.calls, [["podman", "image", "exists", AUDIT_IMAGE]]);
  assert.ok(y.out.findings.length >= 1);
  for (const image of ["openfantasy/audit-lab:latest", "openfantasy/audit-lab@sha256:PENDING", "x@sha256:abc"]) {
    y = once({ rt: ["podman"] }, { image });
    assert.equal(y.out.reason, "container scan not run: image digest not pinned; always-on checks only", image);
    assert.deepEqual(y.calls, [], image);
  }
});

test("8.0.0 G7-4: sec_scan.py runs only allowlisted executables (podman, docker, git): a stub-only PATH with traps for every scanner", { skip: !HAVE_PY }, () => {
  const y = once({ rt: ["podman"] }, { out: CLEAN });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.ok(y.calls.every((c) => c[0] === "podman"), JSON.stringify(y.calls));
  const src = readFileSync(PROG, "utf8");
  assert.match(src, /\nEXE = \('podman', 'docker', 'git'\)\n/);
  assert.equal(src.match(/subprocess\.\w+\(/g).length, 1, "one subprocess call site, behind the allowlist");
  assert.ok(!/os\.(system|popen|exec\w*|spawn\w*)\(|shell=True/.test(src.replace(/r?'[^'\n]*'/g, "")), "no other way to start a program");
  // host scanners are never named as an executable (the container's entrypoints only)
  assert.deepEqual([...src.matchAll(/'--entrypoint', '([a-z]+)'/g)].map((x) => x[1]), ["semgrep", "gitleaks"]);
});

test("8.0.0 G7-5: sec_scan.py holds no IaC binary name, not even in a comment", () => {
  const src = readFileSync(PROG, "utf8");
  const i = SOURCE.indexOf("\nconst PATH_TOOLS = ");
  const pathTools = new Function(SOURCE.slice(i + 1, SOURCE.indexOf(";\n", i) + 2) + "\nreturn PATH_TOOLS;")();
  assert.equal(pathTools.length, 6);
  for (const n of pathTools.concat(["checkov", "tfsec", "trivy", "terrascan", "kics", "tflint", "hadolint", "bandit", "trufflehog"]))
    assert.ok(!new RegExp(n, "i").test(src), "sec_scan.py names " + n);
});

test("8.0.0 G7: the plugin rule file is pinned by its sha256 inside sec_scan.py and covers the six risks; a changed rule file is an error", { skip: !HAVE_PY }, () => {
  const src = readFileSync(PROG, "utf8");
  const pin = /\nRULES_SHA256 = '([0-9a-f]{64})'\n/.exec(src);
  assert.ok(pin, "RULES_SHA256");
  assert.equal(pin[1], createHash("sha256").update(readFileSync(RULES)).digest("hex"));
  const rules = readFileSync(RULES, "utf8");
  for (const id of ["shell-true", "eval-exec", "yaml-load", "pickle-load", "sql-string", "tls-off"]) assert.match(rules, new RegExp("id: fleet\\.python\\." + id + "\\n"), id);
  assert.match(src, /'skills', 'build-task', 'sec-rules\.yml'/);
});

test("8.0.0 G7: the shipped rules match their fixtures (host semgrep, offline; development check only, the gate never uses it)", { skip: !SEMGREP }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-g7-rules-"));
  try {
    writeFileSync(
      join(d, "bad.py"),
      [
        "import subprocess, yaml, pickle, requests, ssl",
        "subprocess.run(c, shell=True)",
        "eval(s)",
        "yaml.load(s)",
        "pickle.loads(s)",
        "cur.execute(\"SELECT * FROM t WHERE id = %s\" % s)",
        "requests.get(u, verify=False)",
        "ssl._create_unverified_context()",
        "yaml.load(s, Loader=yaml.SafeLoader)",
        "cur.execute(\"SELECT 1 WHERE a = ?\", (s,))",
        "subprocess.run([c])",
        "",
      ].join("\n"),
    );
    // review fix 2: with the scan dir's empty .semgrepignore, a file under tests/ or vendor/ is scanned too
    mkdirSync(join(d, "vendor"));
    writeFileSync(join(d, "vendor", "v.py"), "eval(s)\n");
    writeFileSync(join(d, ".semgrepignore"), "");
    const r = spawnSync(SEMGREP, ["scan", "--metrics=off", "--disable-version-check", "--disable-nosem", "--max-target-bytes=0", "--config", RULES, "--json", d], { encoding: "utf8", env: Object.assign({}, process.env, { HOME: d }) });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const res = JSON.parse(r.stdout).results;
    assert.ok(res.some((x) => x.path.endsWith("vendor/v.py")), "vendor/ is not ignored");
    const hits = res.filter((x) => x.path.endsWith("bad.py")).map((x) => [x.check_id.replace(/^.*fleet\.python\./, ""), x.start.line]).sort((a, b) => a[1] - b[1]);
    assert.deepEqual(hits, [["shell-true", 2], ["eval-exec", 3], ["yaml-load", 4], ["pickle-load", 5], ["sql-string", 6], ["tls-off", 7], ["tls-off", 8]]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- gate_tools.py: the preflight pull

function census({ stubs = {}, image = AUDIT_IMAGE, env = {} } = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-g7-gt-"));
  try {
    const repo = join(d, "repo");
    const bin = join(d, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(join(repo, "pyproject.toml"), "\n");
    const log = join(d, "calls.log");
    for (const n of stubs.rt || []) {
      writeFileSync(join(bin, n), STUB(log));
      chmodSync(join(bin, n), 0o755);
    }
    const r = spawnSync(PY, ["-I", GT, repo, image], { encoding: "utf8", env: Object.assign({ PATH: bin }, env) });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout), calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("8.0.0 G7: preflight pulls the pinned digest once when it is missing (podman, else docker); a failed pull is not fatal: not available with the reason", { skip: !HAVE_PY }, () => {
  // the stub's image check exits STUB_EXISTS every time: a pull that leaves no image is not available
  let c = census({ stubs: { rt: ["podman"] }, env: { STUB_EXISTS: "1" } });
  assert.deepEqual(c.calls, [["podman", "image", "exists", AUDIT_IMAGE], ["podman", "pull", AUDIT_IMAGE], ["podman", "image", "exists", AUDIT_IMAGE]]);
  assert.equal(c.out.container.present, false);
  assert.equal(c.out.container.reason, "image not present locally (exit 1); pull exit 0, still missing");
  c = census({ stubs: { rt: ["docker"] }, env: { STUB_EXISTS: "1", STUB_PULL: "125" } });
  assert.deepEqual(c.calls, [["docker", "image", "inspect", AUDIT_IMAGE], ["docker", "pull", AUDIT_IMAGE]]);
  assert.equal(c.out.container.reason, "image not present locally (exit 1); pull failed (exit 125)");
  assert.equal(c.out.matrix.python.security, "unsupported");
  // present: no pull
  c = census({ stubs: { rt: ["podman"] } });
  assert.deepEqual(c.calls, [["podman", "image", "exists", AUDIT_IMAGE]]);
  assert.deepEqual(c.out.container, { runtime: "podman", image: AUDIT_IMAGE, present: true, reason: null });
  // never a tag, never an unpinned image
  for (const image of ["openfantasy/audit-lab:latest", "openfantasy/audit-lab@sha256:PENDING"]) assert.deepEqual(census({ stubs: { rt: ["podman"] }, image, env: { STUB_EXISTS: "1" } }).calls, [], image);
  const src = readFileSync(GT, "utf8");
  assert.match(src, /\[rt, 'pull', image\], 480\)/);
  assert.match(src, /preexec_fn=lift/);
});

test("8.0.0 G7: the census: mutation is builtin for python (pytest) only", { skip: !HAVE_PY }, () => {
  const c = census();
  assert.equal(c.out.matrix.python.mutation, "builtin");
  for (const l of ["node", "go", "rust", "other"]) assert.equal(c.out.matrix[l].mutation, "unsupported", l);
});

test("8.0.0 G7: the preflight runs gate_tools.py as one Bash call with timeout 600000 ms (the pull's 480 s and the census's 560 s fit)", async () => {
  const out = await runOne(happy(), ARGS);
  const pre = out.calls.find((c) => c.label === "preflight").prompt;
  assert.match(pre, /run this one command as one Bash call with timeout 600000 ms, with <scripts_dir> replaced and nothing else changed: sha256sum -- <scripts_dir>\/gate_tools\.py/);
});

// ---------------------------------------------------------------- the workflow

function argsOf(prompt, n) {
  const m = new RegExp(n + "\\.py'((?: '(?:[^']|'\\\\'')*')+)").exec(prompt);
  return m ? [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")) : [];
}
const COV_NR = { status: "not_run", reason: "no coverage tool: coverage is not on PATH", findings: [] };
const MUT_NR = { status: "not_run", reason: "tool absent: no mutation run", killed: 0, survived: [], not_run: 0, budget_hit: false };
function gatesStub(sec) {
  return (prompt) => ({
    status: "ok",
    reason: "ran",
    coverage: Object.assign({}, COV_NR, { args: argsOf(prompt, "cover_diff") }),
    mutation: Object.assign({}, MUT_NR, { args: argsOf(prompt, "mutants") }),
    security_scan: sec === null ? null : Object.assign({ status: "ran", reason: null, findings: [] }, sec, { args: argsOf(prompt, "sec_scan") }),
  });
}
const SHELL_F = { path: "src/x.py", lines: [4], rule: "grep: shell=True", kind: "code" };
const SECRET_F = { path: "src/x.py", lines: [7], rule: "gitleaks: generic-api-key", kind: "secret" };
const approve = (ex) => Object.assign({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } }, ex === undefined ? {} : { exemptions: ex });
const R2 = {
  "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
  "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
  "role:fleet-code-judge:r2": approve(),
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
  // 8.0.0 car F (A-H1): round 2 reports the gate again (a partial after round 1's findings stops at gates)
  "infra:gates:r2": gatesStub({}),
};

test("8.0.0 G7: sec_scan runs as the 3rd slot of infra:gates:r<m> (no new agent), after coverage and mutation; its args", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /sec[_-]scan|security/.test(l)), out.labels.join(", "));
  const p = call(out, "infra:gates:r1").prompt;
  // 8.0.0 car F (A-M5): security first, before any code under test runs (coverage, mutation)
  assert.ok(p.indexOf("sec_scan.py") < p.indexOf("cover_diff.py") && p.indexOf("cover_diff.py") < p.indexOf("mutants.py"), "security, coverage, mutation");
  assert.deepEqual(inputsOf(p).gates, ["security_scan", "coverage", "mutation"]);
  const a = argsOf(p, "sec_scan");
  const c = argsOf(p, "cover_diff");
  assert.deepEqual(a, [c[0], c[1], c[2], c[5], "80", AUDIT_IMAGE]);
  // the default stub: no runtime -> partial; the judge sees it; security_scan stays listed with the reason
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cj.script_findings.security, { status: "partial", reason: "container scan not run: no container runtime (podman or docker); always-on checks only", findings: [] });
  assert.deepEqual(out.result.gates_not_run.find((x) => x.gate === "security_scan"), { gate: "security_scan", reason: "container scan not run: no container runtime (podman or docker); always-on checks only" });
  assert.match(SOURCE, /reserve\(11 \+ \(planFacts\.changed_symbols/);
});

test("8.0.0 G7-1: an added shell=True line with no exemption turns an approve into fix_code; a reasoned exemption passes and security_scan leaves gates_not_run", async () => {
  for (const ex of [undefined, [], [{ gate: "security_scan", path: "src/x.py", lines: [4], reason: " " }], [{ gate: "coverage", path: "src/x.py", lines: [4], reason: "r" }], [{ gate: "security_scan", path: "src/x.py", lines: [5], reason: "r" }]]) {
    const out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub({ findings: [SHELL_F] }), "role:fleet-code-judge:r1": approve(ex) }, R2) }), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(out.labels.includes("role:fleet-coder:r2"), JSON.stringify(ex));
    const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
    assert.deepEqual(f, [{ target: "code", criterion: null, finding: "security gate: findings no exemption covers (a secret is never exempted): src/x.py:4 grep: shell=True -- fix the code or remove the secret" }]);
    assert.ok(out.logs.some((l) => /^code round 1: security gate: code-judge approve converted to fix_code \(1 line\(s\)\)$/.test(l)), out.logs.join("\n"));
  }
  const out = await run(happy({ script: { "infra:gates:r1": gatesStub({ findings: [SHELL_F] }), "role:fleet-code-judge:r1": approve([{ gate: "security_scan", path: "src/x.py", lines: [4], reason: "a fixed argv list, no user input" }]) } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
  assert.ok(!out.result.gates_not_run.some((x) => x.gate === "security_scan"), "ran leaves the list");
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).script_findings.security.findings, [SHELL_F]);
});

test("8.0.0 car F security review: an unexempted finding on a long or escaped path is never dropped by the display cap", async () => {
  for (const path of ["src/" + "a".repeat(250) + ".py", "src/x\ty.py"]) {
    const F = Object.assign({}, SHELL_F, { path });
    const out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub({ findings: [F] }), "role:fleet-code-judge:r1": approve() }, R2, { "role:fleet-coder:r2": { status: "ok", changed_paths: [path] } }) }), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(out.labels.includes("role:fleet-coder:r2"), "fix_code for " + JSON.stringify(path));
    assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /^security gate: findings no exemption covers/);
  }
});

test("8.0.0 G7-2: a fixture secret always gives fix_code, even with a reasoned exemption", async () => {
  const ex = [{ gate: "security_scan", path: "src/x.py", lines: [7], reason: "a test fixture key" }];
  const out = await run(happy({ script: Object.assign({ "infra:gates:r1": gatesStub({ findings: [SECRET_F] }), "role:fleet-code-judge:r1": approve(ex) }, R2) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-coder:r2"));
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /: src\/x\.py:7 gitleaks: generic-api-key -- /);
});

test("8.0.0 G7: a security tool that errors gets one retry, then needs_human at gate gates", async () => {
  const out = await run(happy({ script: { "infra:gates:r1": gatesStub(null) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "gates");
  assert.match(out.result.reason, /gate security_scan erred or relayed no digest-checked result twice/);
  assert.ok(out.labels.includes("infra:gates:r1:digest-retry"));
});

test("8.0.0 G7: the program checklist: PROGRAM_COUNT 49, the slot, the keys, the output types, the judge's role", () => {
  assert.equal(PROGRAM_COUNT, 49);
  assert.match(SOURCE, /\[\/\^infra:gates:\/, \[\["coverage", "cover_diff"\], \["mutation", "mutants"\], \["security_scan", "sec_scan"\]\]\]/);
  assert.deepEqual(K("sec_scan"), PROG_KEYS);
  assert.match(SOURCE, /\n  sec_scan: \{ status: STR, reason: STR_OR_NULL, findings: /);
  const role = readFileSync(join(HERE, "..", "roles", "fleet-code-judge.md"), "utf8");
  assert.match(role, /script_findings\.security/);
  assert.match(role, /never exempt/i);
});

// ---------------------------------------------------------------- step 0: aug_files on a resume

test("8.0.0 G7 step 0: resume: aug_files must be exactly one generated name (normPath-equal, relative, no ..); else the resume is refused", () => {
  const i = SOURCE.indexOf("const af = st.aug_files;");
  assert.ok(i > 0);
  const chk = SOURCE.slice(i, SOURCE.indexOf("mis(\"aug_files\")", i));
  assert.match(chk, /af\.length !== 1/);
  assert.match(chk, /normPath\(f\) !== f/);
  assert.match(chk, /augName\(/);
  assert.match(SOURCE, /\nfunction augName\(/);
  // the generator itself uses the helper
  assert.match(SOURCE, /const files = \[augName\(testable, m\)\];/);
});

// ---------------------------------------------------------------- review fixes (the security review of G7)

test("8.0.0 G7 review fix 1: changed scanner config and .semgrep/ files get the secret scan (renamed, mapped back) and the always-on checks; never ran with nothing scanned", { skip: !HAVE_PY }, () => {
  const files = { ".gitleaks.toml": "token = 'x'  # gitleaks:allow\n", ".semgrep/base.yml": "rules: []\nkey: verify=False\n" };
  const gl = JSON.stringify([{ RuleID: "generic-api-key", StartLine: 1, EndLine: 1, File: "/src/_fleet_.gitleaks.toml", Secret: "REDACTED" }, { RuleID: "aws-key", StartLine: 2, EndLine: 2, File: "/src/_fleet_.semgrep/base.yml", Secret: "REDACTED" }]);
  const y = once({ rt: ["podman"], add: "", files }, { out: { semgrep: SG([]), gitleaks: gl }, rc: { gitleaks: 99 } });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  assert.deepEqual(y.out.findings, [
    { path: ".gitleaks.toml", lines: [1], rule: "gitleaks: generic-api-key", kind: "secret" },
    { path: ".gitleaks.toml", lines: [1], rule: "grep: gitleaks:allow marker", kind: "secret" },
    { path: ".semgrep/base.yml", lines: [2], rule: "gitleaks: aws-key", kind: "secret" },
    { path: ".semgrep/base.yml", lines: [2], rule: "grep: TLS verification off", kind: "code" },
  ]);
  assert.equal(runs(y).length, 2, "the container runs for config files too");
  assert.ok(!/no added line in a scanned file/.test(readFileSync(PROG, "utf8")));
});

test("8.0.0 G7 review fix 2: a file semgrep did not scan (paths.scanned) gives partial with the file named; no paths.scanned is an error", { skip: !HAVE_PY }, () => {
  const files = { "pkg/new.py": "A = 1\n", "pkg/a.ts": "let a = 1;\n" };
  let y = once({ rt: ["podman"], files }, { out: { semgrep: SG([], [], ["/src/pkg/mod.py"]), gitleaks: "[]" } });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "partial");
  assert.equal(y.out.reason, "not scanned by semgrep: pkg/a.ts, pkg/new.py");
  y = once({ rt: ["podman"], files }, { out: CLEAN });
  assert.equal(y.out.status, "ran", y.out.reason);
  y = once({ rt: ["podman"] }, { out: { semgrep: JSON.stringify({ results: [], errors: [] }), gitleaks: "[]" } });
  assert.notEqual(y.r.status, 0, "no paths.scanned: " + y.r.stdout);
});

test("8.0.0 G7 review fix 3 (G7b fix 2): every secret finding sorts first; more than 200 non-secret findings is a non-zero exit (retry, then gates: needs_human), never partial; 200 are all listed", { skip: !HAVE_PY }, () => {
  const lit = (n) => Array.from({ length: n }, (_, i) => "literal-number-" + String(i).padStart(3, "0"));
  const fx = (n) => ({ test: "def test_f():\n" + lit(n).map((l) => "    assert f() != '" + l + "'\n").join(""), add: "\n" + lit(n).map((l) => "X = '" + l + "'\n").join("") + "Z = 1  # gitleaks:allow\n" });
  let y = once(fx(201), { est: "null" });
  assert.notEqual(y.r.status, 0, "201 non-secret findings: " + y.r.stdout);
  assert.match(y.r.stderr, /more than 200 non-secret findings \(201\)/);
  assert.equal(y.r.stdout, "", "no partial result is printed");
  y = once(fx(200), { est: "null" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "partial");
  assert.equal(y.out.reason, "container scan not run: no container runtime (podman or docker); always-on checks only; no est_diff_lines: size not checked");
  assert.deepEqual(y.out.findings[0], { path: "pkg/mod.py", lines: [207], rule: "grep: gitleaks:allow marker", kind: "secret" });
  assert.equal(y.out.findings.filter((f) => f.kind === "code").length, 200);
  assert.equal(y.out.findings.length, 201);
  assert.ok(!/the first %d are listed/.test(readFileSync(PROG, "utf8")), "no truncation path is left");
});

test("8.0.0 G7 review fix 4: a semgrep or gitleaks result counts when any line of its span is added; it records the added lines it covers", { skip: !HAVE_PY }, () => {
  const sg = Object.assign(sgHit("pkg/mod.py", 4, "fleet.python.eval-exec"), { end: { line: 7, col: 1 } });
  const base = Object.assign(sgHit("pkg/mod.py", 1, "fleet.python.pickle-load"), { end: { line: 5, col: 1 } });
  const gl = JSON.stringify([{ RuleID: "generic-api-key", StartLine: 3, EndLine: 6, File: "/src/pkg/mod.py", Secret: "REDACTED" }, { RuleID: "base-key", StartLine: 1, EndLine: 5, File: "/src/pkg/mod.py", Secret: "REDACTED" }]);
  const y = once({ rt: ["podman"] }, { out: { semgrep: SG([sg, base]), gitleaks: gl }, rc: { gitleaks: 99 } });
  assert.equal(y.r.status, 0, y.r.stderr);
  const by = Object.fromEntries(y.out.findings.map((f) => [f.rule, f.lines]));
  assert.deepEqual(by["semgrep: fleet.python.eval-exec"], [6, 7]);
  assert.deepEqual(by["gitleaks: generic-api-key"], [6]);
  assert.ok(!("semgrep: fleet.python.pickle-load" in by) && !("gitleaks: base-key" in by), "a span on base lines only");
});

// ---------------------------------------------------------------- G8: the scan dir (Max ruling 2026-11-18)
// The agent podman shim refuses a mount source under /tmp, /var/tmp or /dev/shm, so a repo cloned
// under /tmp (its scratch dir there) errored twice and stopped at gates. sec_scan.py now builds its
// scan dir in a per-run dir $XDG_CACHE_HOME/fleet/sec-scan/run-<16 hex> (~/.cache when unset; a
// relative value is refused, as policy_init does); the parents are the user's, mode 0700; the
// per-run dir is 755/644 (the rootless mapped uid reads it); it is removed on every exit; stale
// per-run dirs (over 1 day) are swept first; a mount source that resolves under a temp dir is
// refused with a non-zero exit before any runtime call.

const RUN_RE = /^run-[0-9a-f]{16}$/;
const modeOf = (p) => statSync(p).mode & 0o777;

test("8.0.0 G8: the scan dir is a per-run dir under $XDG_CACHE_HOME/fleet/sec-scan; the parents are the user's with mode 0700 (an existing looser one is tightened); the per-run dir is 755/644", { skip: !HAVE_PY }, () => {
  const x = repo({ rt: ["podman"] });
  try {
    mkdirSync(join(x.cache, "fleet"), { mode: 0o755 });
    chmodSync(join(x.cache, "fleet"), 0o755);
    const y = prog(x, { out: CLEAN });
    assert.equal(y.r.status, 0, y.r.stderr);
    assert.equal(y.out.status, "ran", y.out.reason);
    const vs = runs(y)[0].map((v, i, a) => (a[i - 1] === "-v" ? v : null)).filter(Boolean);
    const run = vs[0].split("/").slice(-3)[0];
    assert.match(run, RUN_RE);
    assert.equal(vs[0], join(x.cache, "fleet", "sec-scan", run, "src") + ":/src:ro");
    for (const p of [join(x.cache, "fleet"), join(x.cache, "fleet", "sec-scan")]) {
      assert.equal(modeOf(p), 0o700, p);
      assert.equal(statSync(p).uid, process.getuid(), p);
    }
    for (const [, [mode]] of Object.entries(y.mounts[0]["/src"]).concat(Object.entries(y.mounts[0]["/rules"]))) assert.equal(mode, "0o644");
    assert.deepEqual(y.leftovers, [], "removed on success");
    // XDG_CACHE_HOME unset: ~/.cache (HOME outside the temp dirs)
    const z = prog(x, { out: CLEAN, env: { XDG_CACHE_HOME: null, HOME: x.cache } });
    assert.equal(z.r.status, 0, z.r.stderr);
    assert.match(runs(z).slice(-2)[0].join(" "), new RegExp(" " + x.cache + "/\\.cache/fleet/sec-scan/run-[0-9a-f]{16}/src:/src:ro "));
    assert.equal(modeOf(join(x.cache, ".cache", "fleet", "sec-scan")), 0o700);
  } finally {
    rmSync(x.d, { recursive: true, force: true });
    rmSync(x.cache, { recursive: true, force: true });
  }
});

test("8.0.0 G8: a scan dir that resolves under /tmp, /var/tmp or /dev/shm, or a relative XDG_CACHE_HOME, is a non-zero exit before any runtime call; no runtime or no pinned image stays partial", { skip: !HAVE_PY }, () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "fleet-g8-xdg-")));
  const link = join(cacheHome(), "to-tmp");
  try {
    assert.ok(underTemp(t), "tmpdir() is a temp dir here: " + t);
    symlinkSync(t, link);
    const cases = [
      [{ XDG_CACHE_HOME: "rel/cache" }, /XDG_CACHE_HOME is relative; set it to an absolute path or unset it/],
      [{ XDG_CACHE_HOME: t }, /the scan dir resolves under a temp dir/],
      [{ XDG_CACHE_HOME: link }, /the scan dir resolves under a temp dir/],
      // unset: ~/.cache, and the test HOME is under the temp dir
      [{ XDG_CACHE_HOME: null }, /the scan dir resolves under a temp dir/],
    ];
    for (const [env, re] of cases) {
      const y = once({ rt: ["podman"] }, { out: CLEAN, env });
      assert.notEqual(y.r.status, 0, JSON.stringify(env) + ": " + y.r.stdout);
      assert.match(y.r.stderr, re, JSON.stringify(env));
      assert.equal(y.r.stdout, "", "no result is printed");
      assert.deepEqual(y.calls, [], "the runtime is never called: " + JSON.stringify(env));
      assert.deepEqual(readdirSync(t), [], "nothing is made under the temp dir");
    }
    // the skips come first: no runtime, or an unpinned image, is partial whatever the cache dir
    for (const [rt, image] of [[[], AUDIT_IMAGE], [["podman"], "openfantasy/audit-lab:latest"]]) {
      const y = once({ rt }, { image, env: { XDG_CACHE_HOME: "rel" } });
      assert.equal(y.r.status, 0, y.r.stderr);
      assert.equal(y.out.status, "partial");
      assert.deepEqual(y.calls, []);
    }
    const src = readFileSync(PROG, "utf8");
    assert.match(src, /\nTEMP = \('\/tmp', '\/var\/tmp', '\/dev\/shm'\)\n/);
    assert.ok(!/mkdtemp\([^)]*scratch/.test(src) && !/makedirs\(scratch/.test(src), "no scan dir under the scratch dir");
  } finally {
    rmSync(t, { recursive: true, force: true });
    rmSync(dirname(link), { recursive: true, force: true });
  }
});

test("8.0.0 G8: a symlink or a non-dir at a parent of the scan dir is refused before any runtime call", { skip: !HAVE_PY }, () => {
  for (const make of [(c, o) => symlinkSync(o, join(c, "fleet")), (c) => writeFileSync(join(c, "fleet"), "x")]) {
    const x = repo({ rt: ["podman"] });
    const other = cacheHome();
    try {
      make(x.cache, other);
      const y = prog(x, { out: CLEAN });
      assert.notEqual(y.r.status, 0, y.r.stdout);
      assert.match(y.r.stderr, /not a directory owned by this user/);
      assert.deepEqual(y.calls.filter((c) => c[1] === "run"), []);
      assert.deepEqual(readdirSync(other), [], "nothing is made through the link");
    } finally {
      for (const p of [x.d, x.cache, other]) rmSync(p, { recursive: true, force: true });
    }
  }
});

test("8.0.0 G8: the per-run dir is removed on success, on a tool error, at the deadline (FLEET_SEC_SCAN_DEADLINE lowers it only) and on TERM", { skip: !HAVE_PY }, () => {
  const x = repo({ rt: ["podman"] });
  try {
    const made = (y) => y.mounts.length > 0 && y.mounts[0]["/src"]["pkg/mod.py"] !== undefined;
    let y = prog(x, { out: CLEAN });
    assert.equal(y.r.status, 0, y.r.stderr);
    assert.ok(made(y));
    assert.deepEqual(y.leftovers, [], "success");
    rmSync(x.log, { force: true });
    rmSync(x.log + ".mounts", { force: true });
    y = prog(x, { out: CLEAN, rc: { semgrep: 2 } });
    assert.notEqual(y.r.status, 0);
    assert.match(y.r.stderr, /semgrep exit 2/);
    assert.ok(made(y));
    assert.deepEqual(y.leftovers, [], "a tool error");
    rmSync(x.log, { force: true });
    rmSync(x.log + ".mounts", { force: true });
    y = prog(x, { out: CLEAN, env: { FLEET_SEC_SCAN_DEADLINE: "2", STUB_SLEEP: "30" } });
    assert.notEqual(y.r.status, 0);
    assert.match(y.r.stderr, /semgrep: the 2 s deadline was hit/);
    assert.ok(made(y));
    assert.ok(y.calls.some((c) => c[1] === "rm" && c[2] === "-f" && /^fleet-sec-[0-9a-f]{12}$/.test(c[3])), "the container is removed: " + JSON.stringify(y.calls));
    assert.deepEqual(y.leftovers, [], "the deadline");
    rmSync(x.log, { force: true });
    rmSync(x.log + ".mounts", { force: true });
    y = prog(x, { out: CLEAN, env: { STUB_SLEEP: "30" }, spawn: { timeout: 4000, killSignal: "SIGTERM" } });
    assert.ok(made(y), "the scan dir was made before the TERM");
    assert.notEqual(y.r.status, 0);
    assert.deepEqual(y.leftovers, [], "TERM");
    // car F (A-L13): TERM removes the container too
    assert.ok(y.calls.some((c) => c[1] === "rm" && c[2] === "-f" && /^fleet-sec-[0-9a-f]{12}$/.test(c[3])), "TERM removes the container: " + JSON.stringify(y.calls));
    const src = readFileSync(PROG, "utf8");
    // car F (B-L4): 520 s, so the cleanup fits in the 600 s call
    assert.match(src, /\nDEADLINE = min\(520, int\(_dl\)\) if re\.match\(r'\^\[1-9\]\[0-9\]\{0,3\}\$', _dl\) else 520\n/, "a test may lower the deadline, never raise it");
  } finally {
    rmSync(x.d, { recursive: true, force: true });
    rmSync(x.cache, { recursive: true, force: true });
  }
});

test("8.0.0 G8: before each run, per-run dirs older than 1 day are swept; a young one, another name and a symlink (its target too) are kept", { skip: !HAVE_PY }, () => {
  const x = repo({ rt: ["podman"] });
  const outside = cacheHome();
  try {
    const root = join(x.cache, "fleet", "sec-scan");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const old = Date.now() / 1000 - 2 * 86400;
    const mk = (n, age) => {
      mkdirSync(join(root, n, "src"), { recursive: true });
      writeFileSync(join(root, n, "src", "f.py"), "x\n");
      if (age) utimesSync(join(root, n), age, age);
    };
    mk("run-00000000000000aa", old);
    mk("run-00000000000000bb", null);
    mk("keep-me", old);
    writeFileSync(join(outside, "target.txt"), "t\n");
    symlinkSync(outside, join(root, "run-00000000000000cc"));
    const y = prog(x, { out: CLEAN });
    assert.equal(y.r.status, 0, y.r.stderr);
    assert.deepEqual(y.leftovers.sort(), ["keep-me", "run-00000000000000bb", "run-00000000000000cc"]);
    assert.ok(lstatSync(join(root, "run-00000000000000cc")).isSymbolicLink());
    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "t\n", "the link target is untouched");
  } finally {
    for (const p of [x.d, x.cache, outside]) rmSync(p, { recursive: true, force: true });
  }
});

test("8.0.0 car F A-L13: sec_scan's cheap cases: a non-rule YAML under the base .semgrep is skipped; est negative or with an exponent parses; an XDG_CACHE_HOME with ':' is partial with the reason", { skip: !HAVE_PY }, () => {
  let y = once({ rt: ["podman"], baseFiles: { ".semgrep/other.yaml": "foo: 1\n" } }, { out: CLEAN });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.equal(y.out.status, "ran", y.out.reason);
  const rules = Object.values(y.mounts[0]["/rules"]).map((v) => v[1]);
  assert.ok(rules.some((t) => t.startsWith("rules: []")) && !rules.some((t) => t.startsWith("foo:")), JSON.stringify(Object.keys(y.mounts[0]["/rules"])));
  y = once({}, { est: "1e0" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.ok(y.out.findings.some((f) => f.path === "<diff>" && /est_diff_lines 1$/.test(f.rule)), JSON.stringify(y.out.findings));
  y = once({}, { est: "-5" });
  assert.equal(y.r.status, 0, y.r.stderr);
  assert.ok(!y.out.findings.some((f) => f.path === "<diff>"));
  assert.match(y.out.reason, /est_diff_lines not positive: size not checked/);
  const x = repo({ rt: ["podman"] });
  try {
    const odd = join(x.cache, "a:b");
    y = prog(x, { out: CLEAN, env: { XDG_CACHE_HOME: odd } });
    assert.equal(y.r.status, 0, y.r.stderr);
    assert.equal(y.out.status, "partial");
    assert.match(y.out.reason, /XDG_CACHE_HOME holds ':'/);
    assert.ok(!y.calls.some((c) => c[1] === "run"));
  } finally {
    rmSync(x.d, { recursive: true, force: true });
    rmSync(x.cache, { recursive: true, force: true });
  }
});
