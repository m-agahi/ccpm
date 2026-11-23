// 8.4.1 (#106) AC4 [unit] guard: the coverage gate (cover_diff.py) builds its coverage command from a
// uv test_cmd with the same flags, so `--frozen` stays: its first tool probe is
// `uv run <flags> coverage --version`. The fixture is the one of v800_coverage.test.mjs:54 (a git repo
// with a base commit and a judged tree, pass-through bwrap, stub-only PATH), with no coverage stub and
// a `uv` stub that logs 'uv ' + its argv and exits 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, spawnSync, passBwrap, bwrapOk } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "cover_diff.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const which = (n) => spawnSync("sh", ["-c", "command -v " + n], { encoding: "utf8" }).stdout.trim();
const GIT = which("git");

function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const BASE_MOD = "def f(x):\n    return x\n";
const NEW_MOD = "def f(x):\n    return x\n\n\ndef g(x):\n    if x:\n        return 1\n    # a comment\n    return 2\n";

// no coverage stub; a uv stub on the stub-only PATH logs 'uv ' + argv and exits 1
function fixture(cmd) {
  const d = mkdtempSync(join(tmpdir(), "fleet-uvp-"));
  const wt = join(d, "wt");
  const bin = join(d, "bin");
  mkdirSync(join(wt, "pkg"), { recursive: true });
  mkdirSync(join(wt, "tests"));
  mkdirSync(bin);
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
  writeFileSync(join(bin, "uv"), "#!/bin/sh\necho \"uv $*\" >> '" + log + "'\nexit 1\n");
  chmodSync(join(bin, "uv"), 0o755);
  const args = [wt, base, tree, cmd, JSON.stringify({ TZ: "UTC" }), JSON.stringify(["tests/test_mod.py"])];
  const r = spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: Object.assign({ PATH: bin }, bwrapOk(bin)) });
  const res = {
    r,
    out: r.status === 0 ? JSON.parse(r.stdout) : null,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
  rmSync(d, { recursive: true, force: true });
  return res;
}

test("8.4.1 AC4: a uv test_cmd with --frozen probes `uv run --frozen coverage --version` (main)", { skip: !HAVE_PY }, () => {
  const x = fixture("uv run --frozen pytest -q <paths>");
  // AC4: main example: exit 0, not_run, the reason names the --frozen probe
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "no coverage tool: uv run --frozen coverage --version exit 1");
  assert.deepEqual(x.calls, ["uv run --frozen coverage --version"]);
});

test("8.4.1 AC4: flags after --frozen are kept in the probe (boundary)", { skip: !HAVE_PY }, () => {
  const x = fixture("uv run --frozen --extra test pytest -q");
  // AC4: boundary example: --frozen --extra test
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "no coverage tool: uv run --frozen --extra test coverage --version exit 1");
  assert.deepEqual(x.calls, ["uv run --frozen --extra test coverage --version"]);
});

test("8.4.1 AC4: triangulation: another flag set is kept as given, so a hardcoded --frozen fails", { skip: !HAVE_PY }, () => {
  const x = fixture("uv run --no-sync pytest -q");
  // AC4: the gate keeps the test_cmd's own flags (no --frozen added or fixed)
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.out.status, "not_run");
  assert.equal(x.out.reason, "no coverage tool: uv run --no-sync coverage --version exit 1");
  assert.deepEqual(x.calls, ["uv run --no-sync coverage --version"]);
});
