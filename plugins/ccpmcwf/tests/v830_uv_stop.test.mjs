// ccpmcwf 8.3.0 (#98): daneel run wf_647f2d1a-c2d stopped at the ownership gate in test round 1 with
// "ignored path written: .venv/...". The cause (journal): test writer AC6 ran
//   eval "$E uv run --frozen pytest \$(uv run --frozen pytest <file> --collect-only -q 2>/dev/null ...)"
// The prefix covered the outer uv run only; the inner command substitution ran uv with the agent's
// own env, so uv synced <worktree>/.venv. The stop cost 37 agents and left 19 uncommitted test files
// that blocked a rerun with the same plan_ref.
// - U3 (fix a): a uv test_cmd reaches each role that runs it with the uv env bound into the
//   command itself, so the command holds without test_env_prefix (outside the worktree).
// - U4 (fix c): an ownership stop after the writers saves the writers' output under a ref,
//   then cleans the worktree to HEAD; the stop reason names the ref. Ignored paths stay.
// - U5: the ownership gate itself is unchanged: a .venv write still stops the run.
// Not done (b): the gate is not relaxed for a .venv (Max has not approved it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, NONCE, BUILD_SCRATCH, FP_TESTS, HASHES_FLAT, H, happy, run, call, inputsOf, sh, spawnSync } from "./harness.mjs";

const UVCMD = { command: "uv run --frozen pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: ["uv"] };
const MAIN = BUILD_SCRATCH.replace(/\/scratch$/, "/main");

function withCmd(tc, s = happy()) {
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { test_cmd: tc });
  return s;
}

test("8.3.0 #98 U3: a uv test_cmd reaches each role with UV_PROJECT_ENVIRONMENT and UV_CACHE_DIR bound in the command", async () => {
  const out = await run(withCmd(UVCMD), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const [label, key, tier] of [
    ["role:fleet-test-writer:AC1:r1", "w-AC1-r1", "write"],
    ["role:fleet-test-writer:AC2:r1", "w-AC2-r1", "write"],
    ["role:fleet-test-judge:r1", "tjudge-r1", "gate"],
    ["role:fleet-coder:r1", "coder-r1", "write"],
    ["role:fleet-code-judge:r1", "cjudge-r1", "gate"],
  ]) {
    const i = inputsOf(call(out, label).prompt);
    const venv = BUILD_SCRATCH + "/build/" + NONCE + "/" + key + "/uv-venv";
    const cache = BUILD_SCRATCH + "/uv-cache/" + NONCE + "/" + tier;
    assert.equal(i.test_cmd.command, "env UV_PROJECT_ENVIRONMENT='" + venv + "' UV_CACHE_DIR='" + cache + "' uv run --frozen pytest <paths>", label);
    // the same dirs as the role's test_env, never under the worktree
    assert.equal(i.test_env.UV_PROJECT_ENVIRONMENT, venv, label);
    assert.ok(!venv.startsWith(MAIN + "/") && !cache.startsWith(MAIN + "/"), label);
    assert.equal(i.test_cmd.paths_placeholder, "<paths>", label);
  }
  // the held-out runner passes argv and env to its sandbox: its test_cmd stays the plan's
  const ho = out.calls.find((c) => c.label === "role:fleet-held-out-runner:r1");
  assert.ok(ho, "the held-out runner ran");
  assert.equal(inputsOf(ho.prompt).test_cmd.command, UVCMD.command);
  // the plan's sealed test_cmd and the commands Max confirms are unchanged
  assert.ok(!JSON.stringify(out.result).includes("env UV_PROJECT_ENVIRONMENT="), "the uv binding is role input only");
});

test("8.3.0 #98 U3: a test_cmd that does not start with uv is passed as the plan wrote it", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const label of ["role:fleet-test-writer:AC1:r1", "role:fleet-coder:r1"]) assert.equal(inputsOf(call(out, label).prompt).test_cmd.command, "pytest <paths>", label);
});

test("8.3.0 #98 U3: the bound command runs uv with the build env even with no prefix", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-830uv-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    // a stub uv that records the env it sees
    writeFileSync(join(bin, "uv"), '#!/bin/sh\necho "$UV_PROJECT_ENVIRONMENT|$UV_CACHE_DIR"\n', { mode: 0o755 });
    const cmd = "env UV_PROJECT_ENVIRONMENT='/x/build/w/uv-venv' UV_CACHE_DIR='/x/uv-cache/write' uv run --frozen pytest";
    // the AC6 shape: the bound command inside a command substitution, no prefix anywhere
    const r = spawnSync("sh", ["-c", "echo $(" + cmd + ")"], { encoding: "utf8", env: { PATH: bin + ":" + process.env.PATH } });
    assert.equal(r.stdout.trim(), "/x/build/w/uv-venv|/x/uv-cache/write");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// the post-writers state with an ignored .venv file written (the #98 stop)
function venvStop(s = happy()) {
  s["hasher:post-writers:r1"] = {
    status: "ok",
    fingerprint: FP_TESTS,
    changed: ["tests/test_a.py", "tests/test_b.py"],
    hashes: Object.assign(H(HASHES_FLAT), { ignored: { ".venv/lib/python3.12/site-packages/_virtualenv.pth": "h1" } }),
  };
  return s;
}

test("8.3.0 #98 U5: a .venv write by a writer still stops the run at the ownership gate", async () => {
  const out = await run(venvStop(), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /ignored path written: \.venv\/lib\/python3\.12\/site-packages\/_virtualenv\.pth/);
  assert.ok(!out.calls.some((c) => c.label === "role:fleet-code-judge:r1"), "no later role runs");
});

test("8.3.0 #98 U4: an ownership stop after the writers saves their output under a ref and cleans the worktree; the reason names the ref", async () => {
  const out = await run(venvStop(), ARGS);
  assert.equal(out.result.stop_gate, "ownership");
  const c = call(out, "infra:stop-save:r1");
  assert.ok(c, "the save step ran");
  const i = inputsOf(c.prompt);
  assert.equal(i.main_worktree, MAIN);
  assert.equal(i.expected_head, FP_TESTS.head);
  assert.equal(i.expected_tree, FP_TESTS.tree);
  assert.match(i.ref, /^refs\/fleet\/[^/]+\/stopped-[A-Za-z0-9_.-]+-r1-tree$/);
  assert.ok(out.result.reason.endsWith(" in test round 1; writers' output saved as " + i.ref + ", worktree reset to " + FP_TESTS.head), out.result.reason);
  // save first, then reset; never clean -x, never force
  const p = c.prompt;
  assert.ok(p.indexOf("update-ref") < p.indexOf("reset -q --hard"), "save before reset");
  assert.ok(!/clean -[a-z]*x/.test(p) && !/--force/.test(p));
});

test("8.3.0 #98 U4: a save step that fails leaves the worktree as it is, and the run still stops at ownership", async () => {
  for (const bad of [{ status: "needs_human", reason: "tree differs" }, { status: "ok", reason: "x", ref_target: "OTHER", head: FP_TESTS.head, clean: true }, { status: "ok", reason: "x", ref_target: FP_TESTS.tree, head: FP_TESTS.head, clean: false }]) {
    const s = venvStop();
    s["infra:stop-save:r1"] = bad;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.equal(out.result.stop_gate, "ownership", JSON.stringify(bad));
    assert.match(out.result.reason, /ignored path written: \.venv\//);
    assert.ok(!out.result.reason.includes("saved as"), out.result.reason);
  }
});

// the save step's commands, as the prompt writes them, on a real repo
test("8.3.0 #98 U4: the save step's commands save the writers' files under the ref and leave a clean worktree; ignored files stay", async () => {
  const out = await run(venvStop(), ARGS);
  const prompt = call(out, "infra:stop-save:r1").prompt;
  const home = mkdtempSync(join(tmpdir(), "fleet-830save-"));
  try {
    const wt = join(home, "main");
    mkdirSync(join(wt, "tests"), { recursive: true });
    sh(wt, "git", "init", "-q");
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
    writeFileSync(join(wt, ".gitignore"), ".venv/\n");
    writeFileSync(join(wt, "tests", "test_old.py"), "def test_old():\n    pass\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    const head = sh(wt, "git", "rev-parse", "HEAD").trim();
    // the writers' output: a new file and an edit; uv's .venv (ignored)
    writeFileSync(join(wt, "tests", "test_new.py"), "def test_new():\n    assert False\n");
    writeFileSync(join(wt, "tests", "test_old.py"), "def test_old():\n    assert True\n");
    mkdirSync(join(wt, ".venv"));
    writeFileSync(join(wt, ".venv", "pyvenv.cfg"), "x\n");
    const treeOf = () => spawnSync("sh", ["-c", 'tmp=$(mktemp) && GIT_INDEX_FILE="$tmp" git read-tree HEAD && GIT_INDEX_FILE="$tmp" git add -A && GIT_INDEX_FILE="$tmp" git write-tree; rm -f "$tmp"'], { cwd: wt, encoding: "utf8" }).stdout.trim();
    const tree = treeOf();
    const i = inputsOf(prompt);
    const sub = (x) => x.split(i.main_worktree).join(wt).split(i.expected_tree).join(tree).split(i.expected_head).join(head);
    // the backticked commands of steps 2 and 3, in prompt order
    const cmds = [...prompt.matchAll(/`([^`]*git [^`]*(update-ref|reset -q --hard|clean -fdq)[^`]*)`/g)].map((m) => sub(m[1]));
    assert.equal(cmds.length, 3, cmds.join("\n"));
    for (const cmd of cmds) {
      const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
      assert.equal(r.status, 0, cmd + ": " + r.stderr);
    }
    assert.equal(sh(wt, "git", "rev-parse", i.ref).trim(), tree, "the ref holds the writers' tree");
    assert.match(sh(wt, "git", "show", i.ref + ":tests/test_new.py"), /assert False/);
    assert.equal(sh(wt, "git", "status", "--porcelain").trim(), "", "the worktree is clean");
    assert.equal(sh(wt, "git", "rev-parse", "HEAD").trim(), head);
    assert.ok(!existsSync(join(wt, "tests", "test_new.py")));
    assert.ok(existsSync(join(wt, ".venv", "pyvenv.cfg")), "ignored files stay (never clean -x)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
