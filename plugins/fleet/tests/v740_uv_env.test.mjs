// fleet 7.4.0 car 6 (#73): uv projects stopped at the ownership gate in test round 1: `uv run`
// creates or updates <project>/.venv (and an editable install writes its .pth files there), and
// the fleet build env did not send it elsewhere. The build env every role command gets now holds
// UV_PROJECT_ENVIRONMENT (a per-role dir under <scratch>/build) and UV_CACHE_DIR (review B-M4: per
// run and tier, <scratch>/uv-cache/<nonce>/write for test writers and the coder, .../gate for the
// rest; never reset), two more BUILD_ENV_ROWS rows like TURBO_CACHE_DIR.
// - U1: a uv test_cmd run gives every role env both vars, in test_env and in test_env_prefix.
// - U2: with uv installed, a real uv project (no dependencies, offline) run with the emitted env
//   writes nothing under the worktree; the same run without the env writes <worktree>/.venv.
//
// dont_care: the order of the vars inside the prefix beyond the BUILD_ENV_ROWS order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, NONCE, BUILD_SCRATCH, happy, run, call, inputsOf, spawnSync } from "./harness.mjs";

const UV = spawnSync("sh", ["-c", "command -v uv"], { encoding: "utf8" }).stdout.trim();
const UVCMD = { command: "uv run --frozen pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: ["uv"] };

function uvRun() {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { test_cmd: UVCMD });
  return run(s, ARGS);
}

test("7.4.0 #73 U1: a uv test_cmd run gives each role UV_PROJECT_ENVIRONMENT and UV_CACHE_DIR in its own build dir", async () => {
  const out = await uvRun();
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const [label, key] of [["role:fleet-test-writer:AC1:r1", "w-AC1-r1"], ["role:fleet-coder:r1", "coder-r1"], ["role:fleet-code-judge:r1", "cjudge-r1"]]) {
    const i = inputsOf(call(out, label).prompt);
    const dir = BUILD_SCRATCH + "/build/" + NONCE + "/" + key;
    assert.equal(i.test_env.UV_PROJECT_ENVIRONMENT, dir + "/uv-venv", label);
    // 7.4.0 review B-M4: the uv cache is one per run, outside build/
    const uc = BUILD_SCRATCH + "/uv-cache/" + NONCE + (label === "role:fleet-code-judge:r1" ? "/gate" : "/write");
    assert.equal(i.test_env.UV_CACHE_DIR, uc, label);
    assert.ok(i.test_env_prefix.includes("UV_PROJECT_ENVIRONMENT='" + dir + "/uv-venv'"), label);
    assert.ok(i.test_env_prefix.includes("UV_CACHE_DIR='" + uc + "'"), label);
    assert.match(i.test_env_note, /UV_PROJECT_ENVIRONMENT, UV_CACHE_DIR/);
  }
  // the commit step's hook env too (the repo's hooks may run uv)
  const c = inputsOf(call(out, "infra:commit:r1").prompt);
  assert.equal(c.hook_env.UV_PROJECT_ENVIRONMENT, BUILD_SCRATCH + "/build/" + NONCE + "/commit-r1/uv-venv");
});

function listAll(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.name === ".git") continue;
    out.push(r);
    if (e.isDirectory()) out.push(...listAll(dir, r));
  }
  return out.sort();
}

test("7.4.0 #73 U2: a real uv project run with the emitted env writes nothing under the worktree", { skip: UV ? false : "uv is not installed" }, async (t) => {
  const out = await uvRun();
  assert.equal(out.result.status, "ok", out.result.reason);
  const emitted = inputsOf(call(out, "role:fleet-coder:r1").prompt).test_env;
  const home = mkdtempSync(join(tmpdir(), "fleet-740uv-"));
  try {
    const wt = join(home, "wt");
    const scratch = join(home, "scratch");
    mkdirSync(wt);
    mkdirSync(scratch);
    writeFileSync(join(wt, "pyproject.toml"), '[project]\nname = "fx"\nversion = "0.1.0"\nrequires-python = ">=3.8"\ndependencies = []\n\n[tool.uv]\npackage = false\n');
    writeFileSync(join(wt, "t.py"), "print('ran')\n");
    const py = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const base = { PATH: process.env.PATH, HOME: home, UV_PYTHON_DOWNLOADS: "never", UV_PYTHON: py, UV_NO_CONFIG: "1", UV_OFFLINE: "1" };
    // the lock file is part of the repo (an uv run --frozen reads it); its own cache stays outside
    const lock = spawnSync(UV, ["lock", "--offline"], { cwd: wt, encoding: "utf8", env: Object.assign({}, base, { UV_CACHE_DIR: join(home, "lock-cache") }) });
    if (lock.status !== 0) {
      t.skip("uv lock needs the network here: " + lock.stderr);
      return;
    }
    const before = listAll(wt);
    // the workflow's own env, moved from its fixture scratch dir to this one
    const env = Object.assign({}, base);
    for (const [k, v] of Object.entries(emitted)) env[k] = String(v).split(BUILD_SCRATCH).join(scratch);
    const r = spawnSync(UV, ["run", "--frozen", "python", "t.py"], { cwd: wt, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ran/);
    assert.deepEqual(listAll(wt), before, "uv wrote under the worktree");
    assert.ok(existsSync(join(env.UV_PROJECT_ENVIRONMENT, "pyvenv.cfg")), "the env went to UV_PROJECT_ENVIRONMENT");
    // control: without the build env, uv writes <worktree>/.venv (the #73 stop)
    const c = spawnSync(UV, ["run", "--frozen", "python", "t.py"], { cwd: wt, encoding: "utf8", env: Object.assign({}, base, { UV_CACHE_DIR: join(home, "c2") }) });
    assert.equal(c.status, 0, c.stderr);
    assert.ok(existsSync(join(wt, ".venv")), "control: uv run without the env writes .venv");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
