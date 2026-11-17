// fleet 7.4.0 (#15, L2017, Max ruling L2017 "Allow, hooks run at commit"): a format step no longer
// refuses a SELECTED file under a directory hook path (a writer's new scripts/tests/test_x.py under
// `pytest scripts/tests/`). The hooks run on it at the commit step.
//
// The exemption, in format_files.py dir_offenders():
// - paths mode (format-tests, format-plan): the selected paths;
// - dirty mode (format-code, every dirty path is "selected"): only the selected paths that are
//   also in the frozen map. A frozen path is guarded by the post-coder hash check (F3), so a coder
//   edit there still stops the run, at stop_gate hash. The plan exempted every dirty path; that
//   would let a coder add an unfrozen file under a hook dir that the hasher does not freeze (a dir
//   only a remote hook's args or a lenient hook names), which no later gate sees. So an unfrozen
//   dirty path under a hook dir is still refused by the format step.
// Still refused: a symlinked or replaced hook dir, a gitlink under it, a non-selected untracked or
// ignored file (a planted conftest.py), a non-selected tracked edit.
//
// dont_care: the note text after "hook surface differs from HEAD".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, sh, spawnSync, H, FP_K1 } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const FORMAT = join(SCRIPTS_SRC, "format_files.py");
const HASHER = join(SCRIPTS_SRC, "hasher.py");
const DIFF = join(SCRIPTS_SRC, "hash_diff.py");
const LOCAL = "repos:\n  - repo: local\n    hooks:\n      - id: tests\n        name: tests\n        entry: pytest scripts/tests/ -q\n        language: system\n        pass_filenames: false\n";
// a dir only a remote hook's args name: format_files treats it as hook surface; hasher's
// hook_refs reads local hooks only, so it is never frozen as a hook dir
const REMOTE = "repos:\n  - repo: https://example.invalid/hooks\n    rev: v1\n    hooks:\n      - id: remote-tests\n        args: [scripts/tests]\n";

function repo(config) {
  const home = mkdtempSync(join(tmpdir(), "fleet-740-hd-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  const scratch = join(home, "scratch");
  mkdirSync(join(wt, "scripts", "tests"), { recursive: true });
  mkdirSync(join(wt, "src"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(scratch);
  sh(wt, "git", "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
  writeFileSync(join(wt, ".pre-commit-config.yaml"), config || LOCAL);
  writeFileSync(join(wt, ".gitignore"), "__pycache__/\n*.pyc\nignored_*\n");
  writeFileSync(join(wt, "scripts", "tests", "test_a.py"), "def test_a():\n    pass\n");
  writeFileSync(join(wt, "scripts", "tests", "conftest.py"), "\n");
  writeFileSync(join(wt, "scripts", "tests", "helpers.py"), "H = 1\n");
  writeFileSync(join(wt, "src", "x.py"), "x = 1\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "pytest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const put = (rel, text) => {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    writeFileSync(join(wt, rel), text);
  };
  const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
  const fmt = (sel, frozen) => {
    const r = spawnSync(PY, ["-I", FORMAT, wt, JSON.stringify(sel), typeof frozen === "string" ? frozen : JSON.stringify(frozen || []), scratch, "60"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.doesNotMatch(o.note, /hook surface unknown/, o.note);
    return o;
  };
  const hash = () => {
    const r = spawnSync(PY, ["-I", HASHER, wt, "[]", "", scratch], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { home, wt, scratch, put, fmt, hash, done: () => rmSync(home, { recursive: true, force: true }) };
}
const h12 = (summary) => summary.file.match(/-([0-9a-f]{64})\.json$/)[1].slice(0, 12);

// ---------------------------------------------------------------- F1: the ruling's case

test("7.4.0 #15 F1 (Max ruling L2017): a selected new scripts/tests/test_x.py under dir hook path scripts/tests: format-tests refuses nothing", () => {
  for (const config of [LOCAL, REMOTE]) {
    const r = repo(config);
    try {
      r.put("scripts/tests/test_x.py", "def test_x():\n    pass\n");
      const o = r.fmt({ paths: ["scripts/tests/test_x.py"] });
      assert.deepEqual(o.refused, [], o.note);
      assert.deepEqual(o.files, ["scripts/tests/test_x.py"]);
    } finally {
      r.done();
    }
  }
});

test("7.4.0 #15 F1 (Max ruling L2017): a selected tracked test file edit under the hook dir passes too", () => {
  const r = repo();
  try {
    r.put("scripts/tests/test_a.py", "def test_a():\n    assert True\n");
    assert.deepEqual(r.fmt({ paths: ["scripts/tests/test_a.py"] }).refused, []);
  } finally {
    r.done();
  }
});

// ---------------------------------------------------------------- F2: non-weakening

test("7.4.0 #15 F2 non-weakening: a non-selected untracked or ignored conftest-like file under the hook dir is refused", () => {
  for (const [name, why] of [["scripts/tests/conftest_x.py", "untracked"], ["scripts/tests/ignored_conftest.py", "ignored"]]) {
    const r = repo();
    try {
      r.put("scripts/tests/test_x.py", "def test_x():\n    pass\n");
      r.put(name, "import os\n");
      const o = r.fmt({ paths: ["scripts/tests/test_x.py"] });
      assert.deepEqual(o.refused, ["scripts/tests"], why);
      assert.equal(o.ran, false);
      assert.match(o.note, new RegExp(name.replace(/\./g, "\\.")), why);
      assert.doesNotMatch(o.note, /scripts\/tests\/test_x\.py/, why + ": the selected file is no offender");
    } finally {
      r.done();
    }
  }
});

test("7.4.0 #15 F2 non-weakening: a non-selected tracked edit under the hook dir is refused", () => {
  const r = repo();
  try {
    r.put("scripts/tests/test_x.py", "def test_x():\n    pass\n");
    r.put("scripts/tests/conftest.py", "import os\n");
    assert.deepEqual(r.fmt({ paths: ["scripts/tests/test_x.py"] }).refused, ["scripts/tests"]);
  } finally {
    r.done();
  }
});

test("7.4.0 #15 F2 non-weakening: scripts/tests as a symlink, or replaced by a file, is refused even when the selected file is under it", () => {
  const r = repo();
  try {
    const real = join(r.home, "elsewhere");
    mkdirSync(real);
    writeFileSync(join(real, "test_x.py"), "def test_x():\n    pass\n");
    rmSync(join(r.wt, "scripts", "tests"), { recursive: true });
    symlinkSync(real, join(r.wt, "scripts", "tests"));
    assert.deepEqual(r.fmt({ paths: ["scripts/tests/test_x.py"] }).refused.sort(), ["scripts/tests", "scripts/tests/test_x.py"]);
  } finally {
    r.done();
  }
  const t = repo();
  try {
    rmSync(join(t.wt, "scripts", "tests"), { recursive: true });
    writeFileSync(join(t.wt, "scripts", "tests"), "not a dir\n");
    assert.deepEqual(t.fmt({ paths: ["scripts/tests/test_x.py"] }).refused, ["scripts/tests"]);
  } finally {
    t.done();
  }
});

test("7.4.0 #15 F2 non-weakening: a gitlink under the hook dir is refused even with a selected file there", () => {
  const r = repo();
  try {
    const sm = join(r.wt, "scripts", "tests", "sm");
    mkdirSync(sm);
    sh(sm, "git", "init", "-q");
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(sm, "git", "config", k, v);
    writeFileSync(join(sm, "a.txt"), "a\n");
    sh(sm, "git", "add", "a.txt");
    sh(sm, "git", "commit", "-qm", "sm");
    sh(r.wt, "git", "add", "scripts/tests/sm");
    sh(r.wt, "git", "commit", "-qm", "gitlink");
    r.put("scripts/tests/test_x.py", "def test_x():\n    pass\n");
    assert.deepEqual(r.fmt({ paths: ["scripts/tests/test_x.py", "scripts/tests/sm"] }).refused, ["scripts/tests"]);
  } finally {
    r.done();
  }
});

test("7.4.0 #15 F2 non-weakening, dirty mode: an unfrozen dirty file under the hook dir is still refused (local and remote-hook dirs)", () => {
  for (const config of [LOCAL, REMOTE])
    for (const [why, setup] of [
      ["new untracked conftest_x.py", (r) => r.put("scripts/tests/conftest_x.py", "import os\n")],
      ["edited tracked conftest.py", (r) => r.put("scripts/tests/conftest.py", "import os\n")],
      [
        "edit hidden by skip-worktree",
        (r) => {
          sh(r.wt, "git", "update-index", "--skip-worktree", "scripts/tests/test_a.py");
          r.put("scripts/tests/test_a.py", "import os\n");
        },
      ],
    ]) {
      const r = repo(config);
      try {
        setup(r);
        r.put("src/x.py", "x = 2\n");
        const o = r.fmt({ dirty: true }, []);
        assert.deepEqual(o.refused, ["scripts/tests"], why + " " + config.slice(0, 40));
        assert.equal(o.ran, false);
      } finally {
        r.done();
      }
    }
});

test("7.4.0 #15 dirty mode: a frozen dirty file under the hook dir (a writer's test file) is no format offender", () => {
  const r = repo();
  try {
    r.put("scripts/tests/test_x.py", "def test_x():\n    pass\n");
    r.put("src/x.py", "x = 2\n");
    const o = r.fmt({ dirty: true }, ["scripts/tests/test_x.py"]);
    assert.deepEqual(o.refused, [], o.note);
    // the same file unfrozen: refused (the 5.0.4 rule)
    assert.deepEqual(r.fmt({ dirty: true }, []).refused, ["scripts/tests"]);
  } finally {
    r.done();
  }
});

// ---------------------------------------------------------------- F3: the hash backstop

test("7.4.0 #15 F3: a coder edit to frozen scripts/tests/helpers.py passes format-code and the hash check lists it (real programs)", () => {
  const r = repo();
  try {
    const before = r.hash();
    const frozenFiles = JSON.parse(readFileSync(before.hashes.files.file, "utf8"));
    assert.ok("scripts/tests/helpers.py" in frozenFiles, "hook_refs freezes the hook dir: " + Object.keys(frozenFiles).join(", "));
    // the coder edits the frozen helpers.py (and its own file)
    r.put("scripts/tests/helpers.py", "H = 2\n");
    r.put("src/x.py", "x = 2\n");
    const o = r.fmt({ dirty: true }, "@" + h12(before.hashes.files));
    assert.deepEqual(o.refused, [], o.note);
    const after = r.hash();
    const d = spawnSync(PY, ["-I", DIFF, r.scratch, "files", h12(before.hashes.files), h12(after.hashes.files)], { encoding: "utf8" });
    assert.equal(d.status, 0, d.stderr);
    assert.deepEqual(JSON.parse(d.stdout).changed, [["files", "scripts/tests/helpers.py", "changed"]]);
    // security review: a frozen conftest.py edit is still a format offender (it loads on import)
    r.put("scripts/tests/conftest.py", "import os\n");
    assert.deepEqual(r.fmt({ dirty: true }, "@" + h12(before.hashes.files)).refused, ["scripts/tests"]);
  } finally {
    r.done();
  }
});

// The AC says "stops at stop_gate hash". The shipped routing (unchanged) refuses the coder's
// output at the hash check in every round and routes it back as a finding; when the code rounds
// run out, the run stops with stop_gate cap and "last round rejected by the hash gate".
test("7.4.0 #15 F3: the hash check refuses that edit in every code round after format-code passes; the run stops (cap, by the hash gate)", async () => {
  const freeze = H({ "tests/test_a.py": "ha", "tests/test_b.py": "hb", "pyproject.toml#tool.pytest": "hp", "scripts/tests/helpers.py": "c1" });
  const post = H({ "tests/test_a.py": "ha", "tests/test_b.py": "hb", "pyproject.toml#tool.pytest": "hp", "scripts/tests/helpers.py": "c2" });
  const s = happy();
  s["hasher:freeze:f1"] = Object.assign({}, s["hasher:freeze:f1"], { hashes: freeze });
  // the coder keeps its edit in every round (MAX_CODE_ROUNDS 3)
  for (const m of [1, 2, 3]) {
    s["hasher:post-coder:r" + m] = { status: "ok", fingerprint: FP_K1, hashes: post };
    s["role:fleet-coder:r" + m] = Object.assign({}, s["role:fleet-coder:r1"], { changed_paths: ["src/x.py", "scripts/tests/helpers.py"] });
  }
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("infra:format-code:r1"), out.labels.join(", "));
  assert.ok(out.logs.includes("code round 1: hash violation on scripts/tests/helpers.py -> coder output rejected"), out.logs.join("\n"));
  assert.ok(!out.labels.includes("infra:commit:r1"));
  for (const m of [1, 2, 3]) assert.ok(out.logs.includes("code round " + m + ": hash violation on scripts/tests/helpers.py -> coder output rejected"), "round " + m);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "cap", out.result.reason);
  assert.match(out.result.reason, /last round rejected by the hash gate/);
});

// security review of car 2: the ruling covers plain selected files only. A selected file that
// loads on import or configures a tool stays an offender, in both modes.
const CONFIG_LIKE = ["scripts/tests/conftest.py", "scripts/tests/__init__.py", "scripts/tests/sub/__init__.py", "scripts/tests/x.pth", "scripts/tests/pytest.ini", "scripts/tests/setup.cfg", "scripts/tests/tox.ini", "scripts/tests/pyproject.toml", "scripts/tests/setup.py", "scripts/tests/sitecustomize.py", "scripts/tests/jest.config.js", "scripts/tests/vitest.config.ts", "scripts/tests/package.json", "scripts/tests/.mocharc.yml", "scripts/tests/babel.config.js"];
test("7.4.0 #15 (security review): a selected import-time or tool-config file under the hook dir is still refused (paths and dirty mode)", () => {
  for (const name of CONFIG_LIKE) {
    const r = repo();
    try {
      r.put(name, "x = 1\n");
      const o = r.fmt({ paths: [name] });
      assert.deepEqual(o.refused, ["scripts/tests"], name + ": " + o.note);
      assert.match(o.note, new RegExp(name.replace(/[.]/g, "\\.")), name);
      // dirty mode, even when frozen
      r.put("src/x.py", "x = 2\n");
      assert.deepEqual(r.fmt({ dirty: true }, [name]).refused, ["scripts/tests"], name + " dirty");
    } finally {
      r.done();
    }
  }
});
