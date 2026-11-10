// fleet 5.0.6 (ledger 2019): build output and caches outside the worktree.
//
// Fleet 5.0.5 compares every ignored file of the worktree at each hasher
// point. A Rust role that runs `cargo test` rebuilds target/ in the worktree,
// so every Rust run stopped at the next hasher ("ignored path written:
// target/...", stop_gate ownership). Max's ruling: the check stays exactly as
// strict; the build output moves out. Each role that builds, tests or runs
// hooks in the worktree gets env vars (the workflow's BUILD_ENV_ROWS) that
// point build output and caches at <scratch>/build/<nonce>/<key>/, its own
// dir, emptied by build_dir.py right before it runs. A command run without
// them still stops the run, and the stop text names the likely cause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOURCE,
  SCRIPTS_SRC,
  ROLES_SRC,
  ARGS,
  NONCE,
  FP_PRE,
  happy,
  run,
  call,
  inputsOf,
  sh,
  spawnSync,
  registerIgnored,
  criteria,
  BUILD_ROWS,
  BUILD_SCRATCH,
  buildEnvOf,
  roleTestEnv,
} from "./harness.mjs";

const PROG = join(SCRIPTS_SRC, "build_dir.py");
const HASHER = join(SCRIPTS_SRC, "hasher.py");
const HINT = "likely cause: a build or test command ran without the fleet build env, test_env_prefix";

function prog(args) {
  const r = spawnSync("python3", ["-I", PROG].concat(args), { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}
function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------- build_dir.py

test("5.0.6 2019: build_dir reset empties each role dir and leaves only tmp/; clean deletes the build root", () => {
  const home = tmp("fleet-506-bd-");
  try {
    const sc = join(home, "scratch");
    let r = prog(["reset", sc, NONCE, "w-AC1-r1", "w-AC2-r1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.dirs, [sc + "/build/" + NONCE + "/w-AC1-r1", sc + "/build/" + NONCE + "/w-AC2-r1"]);
    assert.deepEqual(r.out.args, ["reset", sc, NONCE, "w-AC1-r1", "w-AC2-r1"]);
    assert.equal(r.out.program.name, "build_dir");
    // a planted bytecode file and a leftover target dir are gone after the next reset
    const d1 = join(sc, "build", NONCE, "w-AC1-r1");
    mkdirSync(join(d1, "pycache", "x"), { recursive: true });
    writeFileSync(join(d1, "pycache", "x", "m.cpython-313.pyc"), "planted");
    mkdirSync(join(d1, "cargo-target", "debug"), { recursive: true });
    writeFileSync(join(d1, "cargo-target", "debug", "t"), "12345");
    r = prog(["reset", sc, NONCE, "w-AC1-r1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(d1), ["tmp"]);
    assert.deepEqual(readdirSync(join(d1, "tmp")), []);
    // the other writer's dir is not touched by a reset that does not name it
    assert.ok(existsSync(join(sc, "build", NONCE, "w-AC2-r1", "tmp")));
    writeFileSync(join(sc, "build", NONCE, "w-AC2-r1", "tmp", "f"), "abc");
    r = prog(["clean", sc]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.removed, true);
    assert.equal(r.out.bytes, 3);
    assert.ok(!existsSync(join(sc, "build")));
    r = prog(["clean", sc]);
    assert.deepEqual([r.out.removed, r.out.bytes], [false, 0]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("5.0.6 2019: build_dir fails closed: bad args, a repeated key, a symlinked component; nothing deleted through a link", () => {
  const home = tmp("fleet-506-bd-");
  try {
    const sc = join(home, "scratch");
    for (const args of [
      ["reset", "rel/scratch", NONCE, "k"],
      ["reset", sc + "/../x", NONCE, "k"],
      ["reset", sc, NONCE],
      ["reset", sc, NONCE, "../k"],
      ["reset", sc, NONCE, "k", "k"],
      ["reset", sc, "a/b", "k"],
      ["clean", sc, "extra"],
      ["wipe", sc],
    ]) {
      const r = prog(args);
      assert.notEqual(r.status, 0, JSON.stringify(args));
    }
    // a symlinked build dir, or a link at a role dir's place, is refused, never followed
    const outside = join(home, "outside");
    mkdirSync(join(outside, "keep"), { recursive: true });
    writeFileSync(join(outside, "keep", "f"), "x");
    mkdirSync(sc, { recursive: true });
    symlinkSync(outside, join(sc, "build"));
    assert.notEqual(prog(["reset", sc, NONCE, "k"]).status, 0);
    assert.notEqual(prog(["clean", sc]).status, 0);
    assert.ok(existsSync(join(outside, "keep", "f")), "nothing deleted through the link");
    rmSync(join(sc, "build"));
    mkdirSync(join(sc, "build", NONCE), { recursive: true });
    symlinkSync(join(outside, "keep"), join(sc, "build", NONCE, "k"));
    const r = prog(["reset", sc, NONCE, "k"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /symlinked path component/);
    assert.ok(existsSync(join(outside, "keep", "f")), "the link's target is kept");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the table

test("5.0.6 2019: BUILD_ENV_ROWS is one data table; every role env is built from it", () => {
  const m = /\nconst BUILD_ENV_ROWS = Object\.freeze\((\[[\s\S]*?\])\);\n/.exec(SOURCE);
  assert.ok(m, "BUILD_ENV_ROWS table");
  const rows = new Function("return " + m[1].replace(/\/\/[^\n]*/g, ""))();
  assert.deepEqual(rows, BUILD_ROWS);
  // no var the 5.0.4 ruling keeps away from the repo's hooks, and no clash with TEST_ENV
  for (const [k] of rows) assert.ok(!["PYTEST_ADDOPTS", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"].includes(k), k);
  // every value lives under the role's own dir
  for (const [k, v] of Object.entries(buildEnvOf("coder-r1"))) assert.ok(v.startsWith(BUILD_SCRATCH + "/build/" + NONCE + "/coder-r1/"), k);
});

// ---------------------------------------------------------------- every emit site

// The steps that run commands in the worktree without the build vars, and why.
const EXEMPT = {
  // plan mode: probes run in a scratch worktree, never in the worktree itself, before the build's first hasher
  "role:scope-and-plan": "plan mode",
  "role:plan-audit": "plan mode",
  // plan mode, before the build's first hasher: its output is part of the baseline
  "infra:format-plan": "plan mode",
};
const HOOKS_IN_WORKTREE = /^infra:(commit:r\d+|push(:p\d+)?)$/;
const FORMAT_IN_SCRATCH = /^infra:format-(tests|code):/;

function prefixOf(env) {
  return "env " + Object.entries(env).map(([k, v]) => k + "='" + String(v).replace(/'/g, "'\\''") + "'").join(" ") + " ";
}

// Every prompt that carries a test command, a test_env or runs the repo's
// hooks in the worktree carries the exact prefix of a dir that a reset
// emptied after the previous role and before it. A new site without it fails.
function checkSites(out) {
  const keysSeen = new Map();
  let lastReset = null;
  let checked = 0;
  for (const c of out.calls) {
    if (/^infra:build-reset:/.test(c.label)) {
      lastReset = inputsOf(c.prompt).args.slice(3);
      continue;
    }
    if (FORMAT_IN_SCRATCH.test(c.label)) {
      // the fixer program runs pre-commit in a scratch checkout under scratch_dir
      assert.match(c.prompt, /format_files\.py/, c.label);
      continue;
    }
    if (!/^(role:|infra:)/.test(c.label) || /:fallback$|:retry$/.test(c.label)) continue;
    const base = c.label.replace(/:replan$/, "");
    let i = null;
    try {
      i = inputsOf(c.prompt);
    } catch (e) {
      continue;
    }
    const runsTests = i && ("test_cmd" in i || "test_env" in i);
    const runsHooks = HOOKS_IN_WORKTREE.test(c.label);
    if (!runsTests && !runsHooks) continue;
    if (base in EXEMPT || /^infra:format-plan/.test(base)) {
      assert.ok(!("test_env_prefix" in i), c.label + " is exempt and gets no prefix");
      continue;
    }
    if (c.label.startsWith("role:fleet-pr-opener")) continue;
    const env = runsHooks ? i.hook_env : i.test_env;
    assert.ok(env && typeof env === "object", c.label + " has its env");
    const m = /\/build\/[^/]+\/([^/]+)\/cargo-target$/.exec(env.CARGO_TARGET_DIR || "");
    assert.ok(m, c.label + ": no build dir in " + JSON.stringify(env));
    const key = m[1];
    assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([k]) => BUILD_ROWS.some((r) => r[0] === k))), buildEnvOf(key, i.scratch_dir || BUILD_SCRATCH), c.label);
    if (runsHooks) assert.ok(c.prompt.includes(prefixOf(env).slice(4)), c.label + " runs its hooks with the prefix");
    else {
      assert.equal(i.test_env_prefix, prefixOf(env), c.label);
      assert.match(i.test_env_note, /test_env_prefix/, c.label);
    }
    assert.ok(lastReset && lastReset.includes(key), c.label + ": no reset of " + key + " right before it");
    if (!runsHooks || !keysSeen.has(key)) {
      assert.ok(!keysSeen.has(key) || keysSeen.get(key) === base, c.label + " shares " + key + " with " + keysSeen.get(key));
      keysSeen.set(key, base);
    }
    checked++;
  }
  return checked;
}

test("5.0.6 2019: every emitted build, test or hook step carries the exact prefix of its own, freshly reset dir", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  // writers AC1, AC2, test judge, coder, code judge, commit, push, pr-review
  assert.equal(checkSites(out), 8);
  // the sweep too, when it runs
  const s = happy();
  s["role:pr-review:v1"] = Object.assign({}, s["role:pr-review:v1"], { touches_gate: true });
  s["role:gate-change-nonweakening-sweep:v1"] = { status: "ok", reason: "fine", verdict: "non_weakening", units: [], findings: [] };
  s["hasher:fp-post:sweep:v1"] = s["hasher:fp-post:pr-review:v1"];
  const o2 = await run(s, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
  assert.equal(checkSites(o2), 9);
  assert.equal(inputsOf(call(o2, "role:gate-change-nonweakening-sweep:v1").prompt).test_env.CARGO_TARGET_DIR, buildEnvOf("sweep-v1").CARGO_TARGET_DIR);
});

test("5.0.6 2019: the workflow builds test_env and the hook env only through roleEnv and hookEnv(key)", () => {
  // a new site that writes test_env or hook_env by hand fails here
  const lines = SOURCE.split("\n");
  const te = lines.filter((l) => /\btest_env: /.test(l) && !/^\s*(\/\/|")/.test(l));
  assert.deepEqual(te.map((l) => l.trim()).sort(), ["return state.db ? { test_env: testEnvFor(consumer), test_env_note: testEnvNote() } : {};", "return { test_env: e, test_env_prefix: envPrefix(e), test_env_note: testEnvNote() + \" \" + BUILD_ENV_NOTE };"].sort());
  const he = lines.filter((l) => /hook_env: /.test(l) && !/^\s*\/\//.test(l) && !/"/.test(l.split("hook_env: ")[0]));
  assert.ok(he.length >= 2 && he.every((l) => /hook_env: hookEnv\("[a-z]+(-r" \+ m|")?|hook_env: hookEnv\(pushKey\)/.test(l)), he.join("\n"));
  // dbInputs (the planner and the audit, plan mode) is the only build-free env
  const calls = [...SOURCE.matchAll(/dbInputs\("([a-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(calls.sort(), ["audit", "plan"]);
});

test("5.0.6 2019: parallel writers get different build dirs; the round's one reset names both", async () => {
  const out = await run(happy({ criteria: criteria(3) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const dirs = ["AC1", "AC2", "AC3"].map((id) => inputsOf(call(out, "role:fleet-test-writer:" + id + ":r1").prompt).test_env.CARGO_TARGET_DIR);
  assert.equal(new Set(dirs).size, 3, dirs.join(" "));
  const reset = inputsOf(call(out, "infra:build-reset:writers:r1").prompt).args;
  assert.deepEqual(reset, ["reset", BUILD_SCRATCH, NONCE, "w-AC1-r1", "w-AC2-r1", "w-AC3-r1"]);
  assert.match(call(out, "infra:build-reset:writers:r1").prompt, /sha256sum -- '[^']+\/build_dir\.py' && python3 -I '[^']+\/build_dir\.py' 'reset' /);
  // each later role its own dir too
  assert.deepEqual(inputsOf(call(out, "role:fleet-test-judge:r1").prompt).test_env, roleTestEnv("tjudge-r1"));
});

test("5.0.6 2019: a reset that fails or relays other dirs stops the run; the build dirs go at the end of every build run", async () => {
  for (const bad of [
    { status: "failed", reason: "build_dir: symlinked path component: /x" },
    (p) => ({ status: "ok", reason: "reset", args: inputsOf(p).args, dirs: ["/elsewhere"] }),
  ]) {
    const s = happy();
    s["infra:build-reset:coder:r1"] = bad;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.match(out.result.reason, /infra:build-reset:coder:r1/);
    assert.ok(!out.labels.includes("role:fleet-coder:r1"), "the coder never runs");
    assert.equal(out.build.labels[out.build.labels.length - 1], "infra:build-clean");
  }
  const ok = await run(happy(), ARGS);
  assert.ok(!ok.plan.labels.some((l) => /^infra:build-/.test(l)), "plan mode has no build dir");
  assert.equal(ok.build.labels[ok.build.labels.length - 1], "infra:build-clean");
  assert.deepEqual(inputsOf(call(ok.build, "infra:build-clean").prompt).args, ["clean", BUILD_SCRATCH]);
  assert.ok(ok.result.gate_log.some((l) => l === "build dirs " + BUILD_SCRATCH + "/build removed (0 bytes)"));
  // a halted build cleans up too
  const halt = await run(happy({ script: { "role:fleet-coder:r1": { status: "needs_human", reason: "coder stuck" } } }), ARGS);
  assert.equal(halt.result.status, "needs_human");
  assert.equal(halt.build.labels[halt.build.labels.length - 1], "infra:build-clean");
});

test("5.0.6 2019: each role file that runs commands names test_env_prefix", () => {
  for (const r of ["fleet-test-writer", "fleet-test-judge", "fleet-coder", "fleet-code-judge", "pr-review", "gate-change-nonweakening-sweep"]) {
    const t = readFileSync(join(ROLES_SRC, r + ".md"), "utf8");
    assert.match(t, /`<test_env_prefix><command>`/, r);
  }
});

// ---------------------------------------------------------------- the fixtures

// A repo with ignored target/ and __pycache__/, the happy run's two test
// files, and stubs on PATH: `cargo` appends to $CARGO_TARGET_DIR (or
// ./target), `pytest` writes bytecode under $PYTHONPYCACHEPREFIX (or
// ./src/__pycache__), as the real tools do.
function fixture() {
  const home = tmp("fleet-506-");
  const wt = join(home, "repo");
  const scratch = join(home, "scratch");
  const bin = join(home, "bin");
  mkdirSync(join(wt, "tests"), { recursive: true });
  mkdirSync(join(wt, "src"), { recursive: true });
  mkdirSync(scratch);
  mkdirSync(bin);
  sh(wt, "git", "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
  writeFileSync(join(wt, ".gitignore"), "/target\n__pycache__/\n");
  writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    pass\n");
  writeFileSync(join(wt, "tests", "test_b.py"), "def test_b():\n    pass\n");
  writeFileSync(join(wt, "src", "helper.py"), "X = 1\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  mkdirSync(join(wt, "target", "debug"), { recursive: true });
  writeFileSync(join(wt, "target", "debug", "log"), "base\n");
  writeFileSync(join(bin, "cargo"), '#!/bin/sh\nd="${CARGO_TARGET_DIR:-target}"\nmkdir -p "$d/debug" && echo "$$" >> "$d/debug/log"\n', { mode: 0o755 });
  writeFileSync(
    join(bin, "pytest"),
    '#!/bin/sh\nif [ -n "$PYTHONPYCACHEPREFIX" ]; then d="$PYTHONPYCACHEPREFIX$PWD/src"; else d="src/__pycache__"; fi\nmkdir -p "$d" && echo "$$" >> "$d/helper.cpython-313.pyc"\n',
    { mode: 0o755 },
  );
  const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
  delete env.CARGO_TARGET_DIR;
  delete env.PYTHONPYCACHEPREFIX;
  return { home, wt, scratch, env, done: () => rmSync(home, { recursive: true, force: true }) };
}

// the real hasher on the fixture, relayed as a stub would (the map file moved
// to the run's scratch dir, the map registered for the ignored-diff stub)
function realHashes(f, prompt) {
  const r = spawnSync("python3", ["-I", HASHER, f.wt, JSON.stringify(inputsOf(prompt).test_files), "", f.scratch], { encoding: "utf8", env: f.env });
  assert.equal(r.status, 0, r.stderr);
  const h = JSON.parse(r.stdout).hashes;
  const m = JSON.parse(readFileSync(h.ignored.file, "utf8"));
  h.ignored.file = inputsOf(prompt).scratch_dir + "/hashes/" + h.ignored.file.split("/").pop();
  registerIgnored(h.ignored, m);
  return h;
}

// Every hasher step hashes the fixture for real (the fingerprints stay the
// scenario's); every role that runs commands, and the commit step's hooks,
// run `tool` in the fixture: with the prefix the workflow gave them, or
// without it for the roles in `drop`. The build dir is mapped onto the
// fixture's scratch dir (the scenario's repo path does not exist).
function fixtureScript(f, tool, drop) {
  const s = happy();
  const runTool = (label, prompt) => {
    const i = inputsOf(prompt);
    const env = label.startsWith("infra:commit:") ? i.hook_env : i.test_env;
    const prefix = label.startsWith("infra:commit:") ? "env " + Object.entries(env).map(([k, v]) => k + "='" + v + "'").join(" ") + " " : i.test_env_prefix;
    assert.equal(typeof prefix, "string", label);
    const cmd = (drop.includes(label) ? "" : prefix.split(BUILD_SCRATCH).join(f.scratch)) + tool;
    const r = spawnSync("sh", ["-c", cmd], { cwd: f.wt, env: f.env, encoding: "utf8" });
    assert.equal(r.status, 0, label + ": " + r.stderr);
  };
  for (const label of Object.keys(s)) {
    const orig = s[label];
    const value = (p) => JSON.parse(JSON.stringify(typeof orig === "function" ? orig(p) : orig));
    if (label.startsWith("hasher:")) {
      s[label] = (p) => {
        const r = value(p);
        if (r && r.status === "ok") r.hashes = realHashes(f, p);
        return r;
      };
    } else if (/^role:(fleet-test-writer|fleet-test-judge|fleet-coder|fleet-code-judge|pr-review)|^infra:commit:r1$/.test(label)) {
      s[label] = (p) => {
        runTool(label, p);
        return value(p);
      };
    }
  }
  s["hasher:pre-writers:r1"] = (p) => ({ status: "ok", fingerprint: FP_PRE, hashes: realHashes(f, p) });
  return s;
}

test("5.0.6 2019: Rust: cargo in every writer, judge, the coder, the review and the commit hooks, with the prefix: the run completes", async () => {
  const f = fixture();
  try {
    const out = await run(fixtureScript(f, "cargo test", []), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(readFileSync(join(f.wt, "target", "debug", "log"), "utf8"), "base\n", "target/ in the worktree is untouched");
    // the output went to each role's own dir
    const built = readdirSync(join(f.scratch, "build", NONCE)).sort();
    assert.deepEqual(built, ["cjudge-r1", "coder-r1", "commit-r1", "review-v1", "tjudge-r1", "w-AC1-r1", "w-AC2-r1"]);
    for (const k of built) assert.ok(existsSync(join(f.scratch, "build", NONCE, k, "cargo-target", "debug", "log")), k);
  } finally {
    f.done();
  }
});

test("5.0.6 2019: Rust, prefix dropped: a writer or a judge that builds in the worktree stops as in 5.0.5, and the text names the cause", async () => {
  for (const [who, gate, re] of [
    ["role:fleet-test-writer:AC2:r1", "ownership", /^ignored path written: target\/debug\/log \(likely cause: a build or test command ran without the fleet build env, test_env_prefix, [^)]+\) in test round 1$/],
    ["role:fleet-test-judge:r1", "fingerprint", /^judge mutated worktree: fleet-test-judge \(role:fleet-test-judge:r1\) changed ignored path written: target\/debug\/log \(likely cause: [^)]+\); verdict discarded$/],
    ["role:fleet-code-judge:r1", "fingerprint", /changed ignored path written: target\/debug\/log \(likely cause: /],
  ]) {
    const f = fixture();
    try {
      const out = await run(fixtureScript(f, "cargo test", [who]), ARGS);
      assert.equal(out.result.status, "needs_human", who + ": " + out.result.reason);
      assert.equal(out.result.stop_gate, gate, who);
      assert.match(out.result.reason, re, who);
      assert.ok(out.result.reason.includes(HINT), who);
    } finally {
      f.done();
    }
  }
});

test("5.0.6 2019: Python: bytecode goes under PYTHONPYCACHEPREFIX in the role's dir; the worktree gets no __pycache__", async () => {
  const f = fixture();
  try {
    const out = await run(fixtureScript(f, "pytest -q", []), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(!existsSync(join(f.wt, "src", "__pycache__")), "no __pycache__ in the worktree");
    const pyc = join(f.scratch, "build", NONCE, "coder-r1", "pycache", f.wt.replace(/^\//, ""), "src", "helper.cpython-313.pyc");
    assert.ok(existsSync(pyc), pyc);
  } finally {
    f.done();
  }
  // without the prefix the cache lands in the worktree; the hasher leaves
  // __pycache__ out of its ignored map (IGNORED_CACHE, since 5.0.4), so it
  // never was a stop
  const g = fixture();
  try {
    const out = await run(fixtureScript(g, "pytest -q", ["role:fleet-coder:r1"]), ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.ok(existsSync(join(g.wt, "src", "__pycache__", "helper.cpython-313.pyc")));
  } finally {
    g.done();
  }
});
