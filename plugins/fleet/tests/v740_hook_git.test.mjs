// fleet 7.4.0 (#13, L2015): hook-surface git hardening.
// - G1: the tree diffs pass --ignore-submodules=none, so a repo's diff.ignoreSubmodules=all no
//   longer hides a gitlink change (hasher.py, review_paths.py, fleet_scan.py, verify_since.py,
//   format_files.py differs()). Measured before the fix: every one of these porcelain diffs hid it.
// - G2: hook_surface.py runs git with GIT_CONFIG_NOSYSTEM=1 and -c core.fsmonitor=false. The AC's
//   "alias" form cannot be observed (git never lets an alias shadow show, ls-files or config), so
//   the test uses the real hole: a system or repo-local core.fsmonitor program runs on ls-files.
//   Non-weakening: the core.hooksPath reads still see the system config, so a system hooksPath
//   inside the repo stays hook surface.
// - G3: the hook gate's log and stop text map control characters in a path to "?", so a path
//   with a newline cannot forge a second log line.
//
// dont_care: git's own warnings on stderr.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, sh, spawnSync, criteria, SOURCE } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const sp = (n) => join(SCRIPTS_SRC, n + ".py");

function cfg(wt) {
  sh(wt, "git", "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
}
// a repo with a gitlink at sm (an embedded repo, no .gitmodules), committed; bump() moves the
// embedded repo's HEAD (the worktree's gitlink changes; commit=true commits the bump too)
function subRepo() {
  const home = mkdtempSync(join(tmpdir(), "fleet-740-sm-"));
  const wt = join(home, "repo");
  mkdirSync(join(wt, "sm"), { recursive: true });
  cfg(wt);
  const sm = join(wt, "sm");
  cfg(sm);
  writeFileSync(join(sm, "a.txt"), "a\n");
  sh(sm, "git", "add", "a.txt");
  sh(sm, "git", "commit", "-qm", "a");
  writeFileSync(join(wt, "x.txt"), "x\n");
  sh(wt, "git", "add", "x.txt", "sm");
  sh(wt, "git", "commit", "-qm", "base");
  const base = sh(wt, "git", "rev-parse", "HEAD").trim();
  const baseTree = sh(wt, "git", "rev-parse", "HEAD^{tree}").trim();
  const bump = (commit) => {
    writeFileSync(join(sm, "b.txt"), "b\n");
    sh(sm, "git", "add", "b.txt");
    sh(sm, "git", "commit", "-qm", "b");
    if (commit) {
      sh(wt, "git", "add", "sm");
      sh(wt, "git", "commit", "-qm", "bump");
    }
  };
  sh(wt, "git", "config", "diff.ignoreSubmodules", "all");
  return { home, wt, base, baseTree, bump, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("7.4.0 #13 G1: hasher lists a changed gitlink although the repo sets diff.ignoreSubmodules=all", () => {
  const r = subRepo();
  try {
    r.bump(false);
    const scratch = join(r.home, "scratch");
    mkdirSync(scratch);
    const o = spawnSync(PY, ["-I", sp("hasher"), r.wt, "[]", r.baseTree, scratch], { encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
    assert.ok(JSON.parse(o.stdout).changed.includes("sm"), o.stdout.slice(0, 400));
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G1: review_paths lists a committed gitlink bump under diff.ignoreSubmodules=all", () => {
  const r = subRepo();
  try {
    r.bump(true);
    const o = spawnSync(PY, ["-I", sp("review_paths"), r.wt, r.base, "HEAD"], { encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(JSON.parse(o.stdout).changed_paths, ["sm"]);
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G1: verify_since lists a committed gitlink bump under diff.ignoreSubmodules=all", () => {
  const r = subRepo();
  try {
    writeFileSync(join(r.wt, "plan.md"), "p\n");
    sh(r.wt, "git", "add", "plan.md");
    sh(r.wt, "git", "commit", "-qm", "plan");
    const pc = sh(r.wt, "git", "rev-parse", "HEAD").trim();
    r.bump(true);
    const o = spawnSync(PY, ["-I", sp("verify_since"), r.wt, pc, "plan.md"], { encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(JSON.parse(o.stdout).changed_since, ["sm"]);
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G1: fleet_scan lists a gitlink bump in the branch diff under diff.ignoreSubmodules=all", () => {
  const r = subRepo();
  try {
    r.bump(true);
    const head = sh(r.wt, "git", "rev-parse", "HEAD").trim();
    const o = spawnSync(PY, ["-I", sp("fleet_scan"), r.wt, "master", head, r.base], { encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(JSON.parse(o.stdout).diff, ["sm"]);
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G1: format_files refuses a changed gitlink a hook names, under diff.ignoreSubmodules=all", () => {
  const r = subRepo();
  try {
    const bin = join(r.home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(r.wt, ".pre-commit-config.yaml"), "repos:\n  - repo: local\n    hooks:\n      - id: t\n        name: t\n        entry: pytest sm -q\n        language: system\n        pass_filenames: false\n");
    writeFileSync(join(r.wt, "y.py"), "y = 1\n");
    sh(r.wt, "git", "add", ".pre-commit-config.yaml", "y.py");
    sh(r.wt, "git", "commit", "-qm", "cfg");
    r.bump(false);
    writeFileSync(join(r.wt, "y.py"), "y = 2\n");
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
    const o = spawnSync(PY, ["-I", sp("format_files"), r.wt, JSON.stringify({ paths: ["y.py"] }), "[]", join(r.home, "scratch"), "60"], { encoding: "utf8", env });
    assert.equal(o.status, 0, o.stderr);
    const out = JSON.parse(o.stdout);
    assert.doesNotMatch(out.note, /hook surface unknown/, out.note);
    assert.deepEqual(out.refused, ["sm"], out.note);
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G1: every porcelain tree diff of the five programs passes --ignore-submodules=none", () => {
  for (const [p, re] of [
    ["hasher", /git\('diff', '--ignore-submodules=none', '--name-only', '-z', '--no-renames', base_tree, tree\)/],
    ["review_paths", /'diff', '--ignore-submodules=none', '--name-only'/],
    ["fleet_scan", /run\('diff', '--ignore-submodules=none', '--name-only'/],
    ["verify_since", /run\('diff', '--ignore-submodules=none', '--name-only'/],
    ["format_files", /git\(wt, 'diff', '--ignore-submodules=none', '--quiet', 'HEAD', '--', p/],
  ])
    assert.match(readFileSync(sp(p), "utf8"), re, p);
});

// ---------------------------------------------------------------- G2: hook_surface.py git config

function hsRepo() {
  const home = mkdtempSync(join(tmpdir(), "fleet-740-hs-"));
  const wt = join(home, "repo");
  mkdirSync(wt);
  cfg(wt);
  writeFileSync(join(wt, "x.txt"), "x\n");
  sh(wt, "git", "add", "x.txt");
  sh(wt, "git", "commit", "-qm", "base");
  const marker = join(home, "marker");
  const mon = join(home, "mon.sh");
  writeFileSync(mon, "#!/bin/sh\necho ran >> '" + marker + "'\nexit 1\n", { mode: 0o755 });
  const runHs = (env) => {
    const o = spawnSync(PY, ["-I", sp("hook_surface"), wt, "HEAD", "[]"], { encoding: "utf8", env: Object.assign({}, process.env, env || {}) });
    assert.equal(o.status, 0, o.stderr);
    return JSON.parse(o.stdout);
  };
  return { home, wt, marker, mon, runHs, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("7.4.0 #13 G2: a system-config core.fsmonitor program never runs in hook_surface (GIT_CONFIG_NOSYSTEM)", () => {
  const r = hsRepo();
  try {
    const sys = join(r.home, "system.cfg");
    writeFileSync(sys, "[core]\n\tfsmonitor = " + r.mon + "\n");
    // the probe is live: plain git runs it on ls-files
    spawnSync("git", ["-C", r.wt, "ls-files"], { env: Object.assign({}, process.env, { GIT_CONFIG_SYSTEM: sys }) });
    assert.ok(existsSync(r.marker), "the fsmonitor probe does not fire on this git; the test would be vacuous");
    rmSync(r.marker);
    r.runHs({ GIT_CONFIG_SYSTEM: sys });
    assert.ok(!existsSync(r.marker), "hook_surface ran the system config's fsmonitor program");
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G2: a repo-local core.fsmonitor program never runs in hook_surface (-c core.fsmonitor=false)", () => {
  const r = hsRepo();
  try {
    sh(r.wt, "git", "config", "core.fsmonitor", r.mon);
    r.runHs();
    assert.ok(!existsSync(r.marker), "hook_surface ran the repo config's fsmonitor program");
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G2 non-weakening: a system-config core.hooksPath inside the repo stays hook surface", () => {
  const r = hsRepo();
  try {
    const sys = join(r.home, "system.cfg");
    writeFileSync(sys, "[core]\n\thooksPath = myhooks\n");
    const o = r.runHs({ GIT_CONFIG_SYSTEM: sys });
    assert.equal(o.error, null);
    assert.ok(o.surface.includes("myhooks/"), JSON.stringify(o.surface));
    // and a local one, as before
    sh(r.wt, "git", "config", "core.hooksPath", "lochooks");
    assert.ok(r.runHs().surface.includes("lochooks/"));
  } finally {
    r.done();
  }
});

test("7.4.0 #13 G2: every git argv of hook_surface carries -c core.fsmonitor=false; the program sets GIT_CONFIG_NOSYSTEM", () => {
  const src = readFileSync(sp("hook_surface"), "utf8");
  assert.match(src, /os\.environ\['GIT_CONFIG_NOSYSTEM'\] = '1'/);
  assert.doesNotMatch(src, /\['git', '-C'/, "a git call without the -c flags");
});

// ---------------------------------------------------------------- G3: the hook gate's log line

test("7.4.0 #13 G3: a hook-gate path with a newline is logged on one line as a?GATE fake", async () => {
  const bad = "a\nGATE fake";
  const crit = criteria(2);
  crit[0].test_files = ["tests/test_a.py", bad];
  const s = happy({ criteria: crit });
  s["infra:hook-surface:plan"] = () => ({ status: "ok", reason: "read", surface: [bad], make_paths: {}, error: null });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
  const hits = out.logs.filter((l) => String(l).includes("GATE fake"));
  assert.ok(hits.length > 0, out.logs.join("\n"));
  for (const l of hits) {
    assert.ok(!String(l).includes("\n"), "a log entry spans two lines: " + JSON.stringify(l));
    assert.ok(String(l).includes("a?GATE fake"), l);
  }
  assert.ok(!out.result.reason.includes("\n"), JSON.stringify(out.result.reason));
});

test("7.4.0 #13 G3 (security review): logPath maps C0, DEL, C1 and the Unicode line and paragraph separators to ?", () => {
  const i = SOURCE.indexOf("function logPath(p) {");
  assert.ok(i >= 0);
  const logPath = new Function("return " + SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 2))();
  for (let c = 0; c < 0x20; c++) assert.equal(logPath("a" + String.fromCharCode(c) + "b"), "a?b", c.toString(16));
  for (let c = 0x7f; c <= 0x9f; c++) assert.equal(logPath("a" + String.fromCharCode(c) + "b"), "a?b", c.toString(16));
  assert.equal(logPath("a\u2028b\u2029c"), "a?b?c");
  assert.equal(logPath("src/ünï ~x.py"), "src/ünï ~x.py");
  assert.equal(logPath(5), "5");
});

test("7.4.0 #13 G3: a hook-gate path with a line separator is logged on one line", async () => {
  const bad = "a\u2028GATE fake";
  const crit = criteria(2);
  crit[0].test_files = ["tests/test_a.py", bad];
  const s = happy({ criteria: crit });
  s["infra:hook-surface:plan"] = () => ({ status: "ok", reason: "read", surface: [bad], make_paths: {}, error: null });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
  assert.ok(out.result.reason.includes("a?GATE fake"), JSON.stringify(out.result.reason));
  assert.ok(!/[\u2028\u2029]/.test(out.result.reason));
});
