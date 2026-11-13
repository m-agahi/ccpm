// fleet 5.0.4 (ledger 2013): a hook entry that names a directory no longer
// stops every format step; Python caches under a hook path are purged first.
//
// Run wf_839d4753-594 (yadgarhq/iam-db, fleet 5.0.3) stopped at
// infra:format-tests:r1 with stop_gate hash: "hook config, a hook entry or a
// symlinked path differs from HEAD: scripts/tests; no hook was run". The repo's
// local hook runs `pytest scripts/tests/ -q`. format_files.py built its tracked
// set from blob paths only, so the directory `scripts/tests` was never in it,
// and differs() returned lexists(): True for every existing directory a hook
// names, cache or no cache. Fixing that alone exposes the second cause: the
// plan-mode format-plan run (pre-commit in the real worktree) writes
// scripts/tests/__pycache__, an ignored path under the hook directory.
//
// The fix (orchestrator's ruling, ledger 2013): format_files.py deletes, under
// the directory hook paths only, the untracked or ignored __pycache__ dirs,
// *.pyc / *.pyo files and .pytest_cache dirs (never a tracked file, never
// through a symlink), and reports them; then the comparison runs. A directory
// hook path differs when a path under it differs between HEAD and a snapshot
// of the worktree in a temporary index (no assume-unchanged or skip-worktree
// bits), when an untracked or ignored path is under it, or when a gitlink is
// under it; selected paths count too. Any other ignored or untracked file
// there still stops the run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { HERE, SCRIPTS_SRC, ARGS, happy, runOne, call, spawnSync, sh, K, sha256, canon, planRefFor, buildArgs, buildAssignsRe } from "./harness.mjs";

const FORMAT = join(SCRIPTS_SRC, "format_files.py");
const WORKFLOW = join(HERE, "..", "workflows", "build-task-run.js");
const CFG = "repos:\n  - repo: local\n    hooks:\n      - id: tests\n        name: tests\n        entry: pytest scripts/tests/ -q\n        language: system\n        pass_filenames: false\n";

// iam-db's shape: a hook that runs pytest on scripts/tests, caches ignored, and
// a fake pre-commit (exit 0, changes nothing) on PATH
function iamDb() {
  const home = mkdtempSync(join(tmpdir(), "fleet-504-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  mkdirSync(join(wt, "scripts", "tests"), { recursive: true });
  mkdirSync(join(wt, "src"), { recursive: true });
  mkdirSync(bin);
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, ".pre-commit-config.yaml"), CFG);
  writeFileSync(join(wt, ".gitignore"), "__pycache__/\n*.pyc\n*.pyo\n.pytest_cache/\nignored_*\n");
  writeFileSync(join(wt, "scripts", "tests", "test_a.py"), "def test_a():\n    pass\n");
  writeFileSync(join(wt, "src", "x.py"), "x = 1\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const put = (rel, text) => {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    writeFileSync(join(wt, rel), text);
  };
  const runF = (sel, frozen) => {
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
    const r = spawnSync("python3", ["-I", FORMAT, wt, JSON.stringify(sel || { paths: ["src/x.py"] }), JSON.stringify(frozen || []), join(home, "scratch"), "60"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    // a canary: the hook surface was read (PyYAML found), so no case below passes vacuously
    assert.doesNotMatch(o.note, /hook surface unknown/, o.note);
    return o;
  };
  return { home, wt, put, runF, done: () => rmSync(home, { recursive: true, force: true }) };
}

const gone = (p) => {
  try {
    lstatSync(p);
    return false;
  } catch {
    return true;
  }
};

test("5.0.4 2013: a clean directory a hook entry names is not refused (5.0.3 refused it with no cache at all)", () => {
  const r = iamDb();
  try {
    r.put("src/x.py", "x = 2\n");
    const o = r.runF();
    assert.deepEqual(o.refused, [], o.note);
    assert.equal(o.ran, true, o.note);
    assert.equal(o.purged, 0);
    assert.deepEqual(o.purged_paths, []);
  } finally {
    r.done();
  }
});

test("5.0.4 2013: wf_839d4753-594: ignored caches under scripts/tests are purged and the hooks run", () => {
  const r = iamDb();
  try {
    r.put("scripts/tests/__pycache__/x.cpython-312.pyc", "pyc");
    r.put("scripts/tests/__pycache__/test_a.cpython-312-pytest-8.3.4.pyc", "pyc");
    r.put("scripts/tests/.pytest_cache/v/cache/nodeids", "[]");
    r.put("scripts/tests/sub/y.pyo", "pyo");
    // outside every hook path: kept (scope)
    r.put(".pytest_cache/v/cache/nodeids", "[]");
    r.put("src/__pycache__/x.cpython-312.pyc", "pyc");
    r.put("src/x.py", "x = 2\n");
    const o = r.runF();
    assert.deepEqual(o.refused, [], o.note);
    assert.equal(o.ran, true, o.note);
    assert.deepEqual(o.files, ["src/x.py"]);
    assert.equal(o.purged, 4);
    assert.deepEqual(o.purged_paths, [
      "scripts/tests/.pytest_cache/v/cache/nodeids",
      "scripts/tests/__pycache__/test_a.cpython-312-pytest-8.3.4.pyc",
      "scripts/tests/__pycache__/x.cpython-312.pyc",
      "scripts/tests/sub/y.pyo",
    ]);
    assert.ok(gone(join(r.wt, "scripts/tests/__pycache__")), "the emptied __pycache__ dir is removed");
    assert.ok(gone(join(r.wt, "scripts/tests/.pytest_cache")), "the emptied .pytest_cache dir is removed");
    assert.ok(existsSync(join(r.wt, ".pytest_cache/v/cache/nodeids")), "a cache outside the hook paths stays");
    assert.ok(existsSync(join(r.wt, "src/__pycache__/x.cpython-312.pyc")), "a pyc outside the hook paths stays");
  } finally {
    r.done();
  }
});

test("5.0.4 2013 non-weakening: a selected file under a hook dir is hook code: it stops the run and is never purged", () => {
  const r = iamDb();
  try {
    r.put("scripts/tests/test_new.py", "def test_new():\n    pass\n");
    r.put("scripts/tests/__pycache__/x.cpython-312.pyc", "pyc");
    const o = r.runF({ paths: ["scripts/tests/test_new.py"] });
    assert.deepEqual(o.refused, ["scripts/tests"]);
    assert.equal(o.ran, false);
    assert.ok(existsSync(join(r.wt, "scripts/tests/test_new.py")));
    assert.equal(o.purged, 1);
  } finally {
    r.done();
  }
});

test("5.0.4 2013 non-weakening: an ignored or untracked conftest.py under a hook dir still stops the run, and is never deleted", () => {
  for (const [name, why] of [["scripts/tests/ignored_conftest.py", "ignored"], ["scripts/tests/conftest.py", "untracked"]]) {
    const r = iamDb();
    try {
      r.put(name, "import os\n");
      r.put("scripts/tests/__pycache__/x.cpython-312.pyc", "pyc");
      r.put("src/x.py", "x = 2\n");
      const o = r.runF();
      assert.deepEqual(o.refused, ["scripts/tests"], why);
      assert.equal(o.ran, false, why);
      assert.match(o.note, new RegExp(name.replace(/\./g, "\\.")), why + ": the note names the path");
      assert.ok(existsSync(join(r.wt, name)), why + ": never deleted");
      assert.ok(gone(join(r.wt, "scripts/tests/__pycache__/x.cpython-312.pyc")), why + ": the pyc is purged all the same");
    } finally {
      r.done();
    }
  }
});

test("5.0.4 2013 non-weakening: a tracked edit under a hook dir, and a hook dir that is now a file, still stop the run", () => {
  const r = iamDb();
  try {
    r.put("scripts/tests/test_a.py", "def test_a():\n    assert False\n");
    r.put("src/x.py", "x = 2\n");
    assert.deepEqual(r.runF().refused, ["scripts/tests"]);
  } finally {
    r.done();
  }
  const t = iamDb();
  try {
    rmSync(join(t.wt, "scripts/tests"), { recursive: true });
    writeFileSync(join(t.wt, "scripts/tests"), "not a dir\n");
    assert.deepEqual(t.runF().refused, ["scripts/tests"]);
  } finally {
    t.done();
  }
});

test("5.0.4 2013: a symlinked __pycache__ (or .pyc) pointing outside the worktree is never followed: the target stays and the run stops at the check", () => {
  const outside = mkdtempSync(join(tmpdir(), "fleet-504-out-"));
  try {
    writeFileSync(join(outside, "x.cpython-312.pyc"), "keep");
    for (const [link, target] of [["scripts/tests/__pycache__", outside], ["scripts/tests/z.pyc", join(outside, "x.cpython-312.pyc")]]) {
      const r = iamDb();
      try {
        symlinkSync(target, join(r.wt, link));
        r.put("src/x.py", "x = 2\n");
        const o = r.runF();
        assert.deepEqual(o.refused, ["scripts/tests"], link);
        assert.equal(o.ran, false);
        assert.equal(o.purged, 0, link);
        assert.ok(lstatSync(join(r.wt, link)).isSymbolicLink(), link + ": the link itself stays");
        assert.equal(readFileSync(join(outside, "x.cpython-312.pyc"), "utf8"), "keep", link + ": the target is untouched");
      } finally {
        r.done();
      }
    }
    // a link that points inside the worktree: the realpath guard alone would pass it; the lstat guard keeps it
    const inn = iamDb();
    try {
      inn.put("src/__pycache__/x.cpython-312.pyc", "keep");
      symlinkSync("../../src/__pycache__/x.cpython-312.pyc", join(inn.wt, "scripts/tests/z.pyc"));
      inn.put("src/x.py", "x = 2\n");
      const o = inn.runF();
      assert.deepEqual(o.refused, ["scripts/tests"]);
      assert.equal(o.purged, 0);
      assert.ok(lstatSync(join(inn.wt, "scripts/tests/z.pyc")).isSymbolicLink(), "an in-tree link is not deleted either");
    } finally {
      inn.done();
    }
    // a symlinked directory between the hook dir and the cache: not descended into
    const r = iamDb();
    try {
      mkdirSync(join(outside, "__pycache__"));
      writeFileSync(join(outside, "__pycache__", "y.pyc"), "keep");
      symlinkSync(outside, join(r.wt, "scripts/tests/sub"));
      r.put("src/x.py", "x = 2\n");
      const o = r.runF();
      assert.deepEqual(o.refused, ["scripts/tests"]);
      assert.equal(o.purged, 0);
      assert.ok(existsSync(join(outside, "__pycache__", "y.pyc")), "nothing under the link is deleted");
    } finally {
      r.done();
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("5.0.4 2013: a tracked .pyc under a hook dir is never deleted, and counts as before (unchanged: no stop; changed: stop)", () => {
  const r = iamDb();
  try {
    r.put("scripts/tests/__pycache__/keep.cpython-312.pyc", "tracked");
    sh(r.wt, "git", "add", "-f", "scripts/tests/__pycache__/keep.cpython-312.pyc");
    sh(r.wt, "git", "commit", "-qm", "a tracked pyc");
    r.put("scripts/tests/__pycache__/x.cpython-312.pyc", "pyc");
    r.put("src/x.py", "x = 2\n");
    const o = r.runF();
    assert.deepEqual(o.refused, [], o.note);
    assert.deepEqual(o.purged_paths, ["scripts/tests/__pycache__/x.cpython-312.pyc"]);
    assert.equal(readFileSync(join(r.wt, "scripts/tests/__pycache__/keep.cpython-312.pyc"), "utf8"), "tracked");
    r.put("scripts/tests/__pycache__/keep.cpython-312.pyc", "planted");
    const c = r.runF();
    assert.deepEqual(c.refused, ["scripts/tests"]);
    assert.equal(readFileSync(join(r.wt, "scripts/tests/__pycache__/keep.cpython-312.pyc"), "utf8"), "planted", "a changed tracked pyc is reported, not deleted");
  } finally {
    r.done();
  }
});

test("5.0.4 2013 non-weakening, dirty mode (format-code): an untracked or a modified conftest.py, or a frozen untracked test, under a hook dir stops the run", () => {
  for (const [why, setup, frozen] of [
    ["untracked conftest.py", (r) => r.put("scripts/tests/conftest.py", "import os\n"), []],
    [
      "modified conftest.py",
      (r) => {
        r.put("scripts/tests/conftest.py", "\n");
        sh(r.wt, "git", "add", "scripts/tests/conftest.py");
        sh(r.wt, "git", "commit", "-qm", "conftest");
        r.put("scripts/tests/conftest.py", "import os\n");
      },
      [],
    ],
    ["frozen untracked test", (r) => r.put("scripts/tests/test_frozen.py", "def test_f():\n    pass\n"), ["scripts/tests/test_frozen.py"]],
  ]) {
    const r = iamDb();
    try {
      setup(r);
      r.put("scripts/tests/__pycache__/x.cpython-312.pyc", "pyc");
      r.put("src/x.py", "x = 2\n");
      const o = r.runF({ dirty: true }, frozen);
      assert.deepEqual(o.refused, ["scripts/tests"], why);
      assert.equal(o.ran, false, why);
      assert.equal(o.purged, 1, why);
    } finally {
      r.done();
    }
  }
});

test("5.0.4 2013 review S1: an edit hidden by assume-unchanged or skip-worktree under a hook dir stops the run (dirty mode)", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const r = iamDb();
    try {
      sh(r.wt, "git", "update-index", flag, "scripts/tests/test_a.py");
      r.put("scripts/tests/test_a.py", "import os\n");
      r.put("src/x.py", "x = 2\n");
      const o = r.runF({ dirty: true });
      assert.deepEqual(o.refused, ["scripts/tests"], flag);
      assert.equal(o.ran, false, flag);
      assert.match(o.note, /scripts\/tests\/test_a\.py/, flag);
    } finally {
      r.done();
    }
  }
});

test("5.0.4 2013 review S2: a gitlink under a hook dir stops the run (its untracked content is invisible to git)", () => {
  const r = iamDb();
  try {
    const sm = join(r.wt, "scripts/tests/sm");
    mkdirSync(sm);
    sh(sm, "git", "init", "-q");
    sh(sm, "git", "config", "user.email", "t@example.com");
    sh(sm, "git", "config", "user.name", "t");
    sh(sm, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(sm, "a.txt"), "a\n");
    sh(sm, "git", "add", "a.txt");
    sh(sm, "git", "commit", "-qm", "sm");
    sh(r.wt, "git", "add", "scripts/tests/sm");
    sh(r.wt, "git", "commit", "-qm", "gitlink");
    writeFileSync(join(sm, "conftest.py"), "import os\n");
    r.put("src/x.py", "x = 2\n");
    for (const sel of [undefined, { dirty: true }]) {
      const o = r.runF(sel);
      assert.deepEqual(o.refused, ["scripts/tests"], JSON.stringify(sel));
      assert.equal(o.ran, false);
    }
  } finally {
    r.done();
  }
});

test("5.0.4 2013: format_files purges before it compares the hook surface, and both lists are in its digest", () => {
  const src = readFileSync(FORMAT, "utf8");
  const purge = src.indexOf("\npurge_caches()\n");
  const cmp = src.indexOf("\nrefused = sorted(");
  assert.ok(purge > 0 && cmp > purge, "the purge runs before the comparison");
  // 5.0.7 (ledger 2020): frozen_changed after them
  // 6.2.2 (2107): then the listed pre-freeze hooks' result
  assert.deepEqual(K("format_files").slice(-10), ["purged", "purged_paths", "frozen_changed", "frozen_map", "hook_failed", "hook_failures", "hook_head", "hook_sha256", "hook_timeout", "unknown_hooks"]);
});

// the relay the agent returns: the program output with a forged or missing purge result
function fmtRelay(over, drop) {
  const o = Object.assign({ ran: true, note: "ran pre-commit run --files", runs: 1, stable: true, files: [], changed: [], refused: [], purged: 0, purged_paths: [] }, over || {});
  const d = {};
  for (const k of K("format_files")) d[k] = o[k];
  const r = Object.assign({ status: "ok", reason: "ran" }, o, { digest: sha256(canon(d)) });
  for (const k of drop || []) delete r[k];
  return r;
}

// a build run whose format-code:r1 relay is `relay`
async function buildWith(relay) {
  const s = happy();
  const ref = await planRefFor(s);
  if (relay) s["infra:format-code:r1"] = relay;
  return runOne(s, buildArgs(ref));
}

test("5.0.4 2013: the workflow relays the purge result and fails closed on a missing or forged one", async () => {
  const good = await buildWith(fmtRelay({ purged: 2, purged_paths: ["scripts/tests/__pycache__/a.pyc", "scripts/tests/__pycache__/b.pyc"] }));
  assert.equal(good.result.status, "ok", good.result.reason);
  assert.ok(good.logs.some((l) => /infra:format-code:r1: purged 2 cache path\(s\) under hook paths: scripts\/tests\/__pycache__\/a\.pyc/.test(l)), good.logs.join("\n"));
  for (const [what, r] of [
    ["missing purged", fmtRelay({}, ["purged"])],
    ["missing purged_paths", fmtRelay({}, ["purged_paths"])],
    ["a string count", fmtRelay({ purged: "0" })],
    ["more paths than the count", fmtRelay({ purged: 0, purged_paths: ["a.pyc"] })],
  ]) {
    const out = await buildWith(r);
    assert.equal(out.result.status, "failed", what + ": " + out.result.reason);
    assert.match(out.result.reason, /infra:format-code:r1/, what);
  }
  // a count the digest does not hold
  const forged = await buildWith(Object.assign(fmtRelay({ purged: 1, purged_paths: ["a.pyc"] }), { purged: 0, purged_paths: [] }));
  assert.equal(forged.result.status, "failed");
  assert.match(forged.result.reason, /does not match the program's digest/);
});

test("5.0.4 2013: the hooks that run in the real worktree write no bytecode (format-plan and the commit step)", async () => {
  const out = await buildWith(null);
  const p = call(out, "infra:commit:r1").prompt;
  // 5.0.6 (ledger 2019): the build vars of the commit's own dir follow
  assert.match(p, new RegExp("`env GIT_CONFIG_NOSYSTEM=1 PYTHONDONTWRITEBYTECODE=1 " + buildAssignsRe("commit-r1") + " git "));
  assert.ok(!/PYTEST_ADDOPTS/.test(p), "the repo's own PYTEST_ADDOPTS is left alone");
  const plan = await runOne(happy(), ARGS);
  assert.match(call(plan, "infra:format-plan").prompt, /`cd <worktree> && PYTHONDONTWRITEBYTECODE=1 pre-commit run --files <plan_path>`/);
});

test("5.0.4 2013: the workflow stays at most 480000 bytes", () => {
  assert.ok(statSync(WORKFLOW).size <= 480000, String(statSync(WORKFLOW).size));
});
