// fleet 8.0.0 car G7b: security review of G7 (and the same pattern in G2 and G5).
//
// Fix 1, the pathspec and decode differential: sec_scan.py, cover_diff.py and mutants.py list the
// changed files with `git diff --name-only -z` and then diff each one with `-- <name>`. Git reads
// that name as a pathspec (`:(glob)*.py` is magic, `a[1].py` is a glob that also matches a1.py), and
// a name that is not UTF-8 was decoded with 'replace', so the re-encoded name matched no file. Now:
// GIT_LITERAL_PATHSPECS=1 on every git call (never in the test child's env), names decoded with
// surrogateescape (os.fsdecode) so they round-trip, shown in the output with backslashreplace, and a
// listed name that yields no diff section is a non-zero exit (never skipped).
//
// Fix 2 (sec_scan): more than CAP (200) non-secret findings is a non-zero exit (the workflow retries
// once, then stops at gates: needs_human), never partial. Covered in v800_security.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, AUDIT_IMAGE, sha256, canon, spawnSync } from "./harness.mjs";

const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");
const CP = which("cp");
const prog = (n) => join(HERE, "..", "scripts", n + ".py");

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const SH = "subprocess.run(x, shell=True)\n";
// the non-UTF-8 name: "caf" + byte 0xe9 + ".py" (latin-1), shown as caf\xe9.py
const RAW = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(".py")]);
const SHOWN = "caf\\xe9.py";
// the judged tree adds these files (other.py is modified: lines 2-4 added); each name's own added
// lines, and its shell=True line
const ADDED = {
  ":(glob)*.py": { text: "X = 1\n" + SH, lines: [1, 2], shell: [2] },
  "a[1].py": { text: SH, lines: [1], shell: [1] },
  "a1.py": { text: "Q = 1\nR = 2\n" + SH, lines: [1, 2, 3], shell: [3] },
  [SHOWN]: { text: "Y = 1\n" + SH, lines: [1, 2], shell: [2] },
  "other.py": { text: "A = 0\nB = 2\nC = 3\n" + SH, lines: [2, 3, 4], shell: [4] },
};

// a repo <d>/wt (base: other.py, pkg/__init__.py, tests/test_mod.py) and the judged tree object;
// <d>/bin is the only PATH dir (git linked in, or a wrapper when opts.noSection)
function repo(opts = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-g7b-")));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
  writeFileSync(join(wt, "pkg", "__init__.py"), "");
  writeFileSync(join(wt, "other.py"), "A = 0\n");
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  g(wt, "init", "-q", "-b", "master");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  for (const [p, v] of Object.entries(ADDED)) {
    if (p === SHOWN) writeFileSync(Buffer.concat([Buffer.from(wt + "/"), RAW]), v.text);
    else writeFileSync(join(wt, p), v.text);
  }
  writeFileSync(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n\n\ndef test_g():\n    pass\n");
  const idx = join(d, "idx");
  const env = { PATH: process.env.PATH, GIT_INDEX_FILE: idx };
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  if (opts.noSection) {
    // a git whose per-file -U0 diff prints nothing: every listed name yields no diff section
    writeFileSync(join(bin, "git"), '#!/bin/sh\ncase " $* " in *" -U0 "*) exit 0 ;; esac\nexec ' + GIT + ' "$@"\n');
    chmodSync(join(bin, "git"), 0o755);
  } else symlinkSync(GIT, join(bin, "git"));
  return { d, wt, bin, base, tree };
}
function runProg(name, x, args, env) {
  const r = spawnSync(PY, ["-I", prog(name)].concat(args), { encoding: "utf8", env: Object.assign({ PATH: x.bin, HOME: x.d }, env || {}) });
  return { r, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}
function digestOk(o, keys) {
  const x = { program: o.program };
  for (const k of keys) x[k] = o[k] === undefined ? null : o[k];
  return sha256(canon(x)) === o.digest;
}
const byPath = (fs, key) => Object.fromEntries(fs.map((f) => [f.path, f[key]]));
const want = (key) => Object.fromEntries(Object.entries(ADDED).map(([p, v]) => [p, v[key]]));

// ---------------------------------------------------------------- sec_scan.py

// the podman stub: `image exists` 0; `run` lists the /src mount (paths.scanned) and prints no result
const STUB =
  "import json, os, sys\na = sys.argv[1:]\nif a[:1] != ['run']:\n    sys.exit(0)\n" +
  "src = [x.split(':')[0] for i, x in enumerate(a) if i and a[i - 1] == '-v' and x.split(':')[1] == '/src'][0]\n" +
  "fs = ['/src/' + os.path.relpath(os.path.join(r, n), src) for r, ds, ns in os.walk(src) for n in ns]\n" +
  "open(os.environ['MOUNTS'], 'a').write(json.dumps(fs) + '\\n')\n" +
  "if a[a.index('--entrypoint') + 1] == 'semgrep':\n    print(json.dumps({'results': [], 'errors': [], 'paths': {'scanned': fs}}))\nelse:\n    print('[]')\n";

for (const rt of [false, true]) {
  test("8.0.0 G7b fix 1: sec_scan.py finds the added lines of `:(glob)*.py`, `a[1].py` (next to a1.py) and a non-UTF-8 name, each under its own path" + (rt ? " (stub podman: the scan dir holds each file, paths.scanned maps back)" : " (no runtime: the always-on grep)"), { skip: !HAVE_PY }, () => {
    const x = repo();
    try {
      const env = {};
      if (rt) {
        writeFileSync(join(x.bin, "podman"), "#!" + PY + " -I\n" + STUB);
        chmodSync(join(x.bin, "podman"), 0o755);
        env.MOUNTS = join(x.d, "mounts.log");
      }
      const { r, out } = runProg("sec_scan", x, [x.wt, x.base, x.tree, JSON.stringify(["tests/test_mod.py"]), "null", AUDIT_IMAGE], env);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(digestOk(out, ["status", "reason", "findings", "args"]), "the digest holds with a non-UTF-8 path in the output");
      const sh = out.findings.filter((f) => f.rule === "grep: shell=True");
      assert.deepEqual(byPath(sh, "lines"), want("shell"));
      if (rt) {
        assert.equal(out.status, "partial", out.reason);
        assert.equal(out.reason, "no est_diff_lines: size not checked");
        const m = JSON.parse(readFileSync(env.MOUNTS, "utf8").trim().split("\n")[0]);
        assert.equal(m.filter((p) => p !== "/src/.semgrepignore").length, 5, JSON.stringify(m));
      } else assert.equal(out.status, "partial");
    } finally {
      rmSync(x.d, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------- cover_diff.py

function coverStubs(x) {
  const put = (n, body) => {
    writeFileSync(join(x.bin, n), "#!/bin/sh\n" + body);
    chmodSync(join(x.bin, n), 0o755);
  };
  writeFileSync(join(x.d, "cov.json"), JSON.stringify({ meta: {}, files: {} }));
  put("pytest", "exit 0\n");
  put("coverage", 'case "$1" in\n  json) while [ "$1" != "-o" ]; do shift; done; ' + CP + " '" + join(x.d, "cov.json") + "' \"$2\" ;;\nesac\nexit 0\n");
}

test("8.0.0 G7b fix 1: cover_diff.py finds the added lines of `:(glob)*.py`, `a[1].py` and a non-UTF-8 name (none measured: every added line uncovered)", { skip: !HAVE_PY }, () => {
  const x = repo();
  try {
    coverStubs(x);
    const { r, out } = runProg("cover_diff", x, [x.wt, x.base, x.tree, "pytest -q <paths>", JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(digestOk(out, ["status", "reason", "findings", "args"]));
    assert.equal(out.status, "ran", out.reason);
    assert.deepEqual(byPath(out.findings, "lines"), want("lines"));
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- mutants.py

test("8.0.0 G7b fix 1: mutants.py mutates the added lines of `:(glob)*.py`, `a[1].py` and a non-UTF-8 name (a green stub suite: every mutant survives); the literal restore check holds", { skip: !HAVE_PY }, () => {
  const x = repo();
  try {
    writeFileSync(join(x.bin, "pytest"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(x.bin, "pytest"), 0o755);
    const { r, out } = runProg("mutants", x, [x.wt, x.base, x.tree, "pytest -q <paths>", JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(digestOk(out, ["status", "reason", "killed", "survived", "not_run", "budget_hit", "args"]));
    assert.equal(out.status, "ran", out.reason);
    const got = {};
    for (const s of out.survived) (got[s.path] = got[s.path] || new Set()).add(s.line);
    assert.deepEqual(Object.fromEntries(Object.entries(got).map(([p, s]) => [p, [...s].sort((a, b) => a - b)])), want("lines"));
    assert.equal(out.killed, 0);
  } finally {
    rmSync(x.d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- fail closed

test("8.0.0 G7b fix 1: a name --name-only lists that yields no diff section is a non-zero exit in all three programs (never skipped)", { skip: !HAVE_PY }, () => {
  for (const name of ["sec_scan", "cover_diff", "mutants"]) {
    const x = repo({ noSection: true });
    try {
      if (name === "cover_diff") coverStubs(x);
      if (name === "mutants") {
        writeFileSync(join(x.bin, "pytest"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(x.bin, "pytest"), 0o755);
      }
      const args = name === "sec_scan" ? [x.wt, x.base, x.tree, JSON.stringify(["tests/test_mod.py"]), "null", AUDIT_IMAGE] : [x.wt, x.base, x.tree, "pytest -q <paths>", JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])];
      const { r } = runProg(name, x, args);
      assert.notEqual(r.status, 0, name + ": " + r.stdout);
      assert.match(r.stderr, /no diff section/, name);
    } finally {
      rmSync(x.d, { recursive: true, force: true });
    }
  }
});

test("8.0.0 G7b fix 1: GIT_LITERAL_PATHSPECS is set for git and never reaches the test child (cover_diff, mutants)", { skip: !HAVE_PY }, () => {
  for (const name of ["cover_diff", "mutants"]) {
    const x = repo();
    try {
      const log = join(x.d, "env.log");
      if (name === "cover_diff") coverStubs(x);
      writeFileSync(join(x.bin, "pytest"), "#!/bin/sh\necho \"lit=${GIT_LITERAL_PATHSPECS-unset}\" >> '" + log + "'\nexit 0\n");
      chmodSync(join(x.bin, "pytest"), 0o755);
      const { r } = runProg(name, x, [x.wt, x.base, x.tree, "pytest -q <paths>", JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])]);
      assert.equal(r.status, 0, r.stderr);
      const seen = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(seen.length > 0 && seen.every((l) => l === "lit=unset"), name + ": " + seen.join(","));
      assert.match(readFileSync(prog(name), "utf8"), /GIT_LITERAL_PATHSPECS/);
    } finally {
      rmSync(x.d, { recursive: true, force: true });
    }
  }
  assert.match(readFileSync(prog("sec_scan"), "utf8"), /os\.environ\['GIT_LITERAL_PATHSPECS'\] = '1'/);
});
