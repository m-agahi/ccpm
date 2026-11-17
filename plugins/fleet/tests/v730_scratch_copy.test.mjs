// fleet 7.3.0 (#54, L2189) A23: scratch_copy.py makes, runs in and removes the throwaway
// copy the roles used to build with mktemp -d, worktree add and copy and delete loops.
// make <worktree> [<rev>]: a detached worktree under <dirname(worktree)>/scratch; with no rev
// it holds the CURRENT working tree (changed and untracked paths copied, deleted ones deleted).
// run <worktree> <tmp> <argv json> [<env json>]: argv with cwd <tmp>. remove <worktree>
// <tmp>: worktree remove --force, then prune. A <tmp> outside that scratch dir is refused
// (review M1). The workflow hands the command prefix to the seven copy roles as scratch_copy_cmd.
//
// dont_care: the tmp dir's name below <scratch_dir>; the length of `tail`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCRIPTS_SRC, ROLE_TEXT, happy, run, ARGS, spawnSync, inputsOf } from "./harness.mjs";

const PY = join(SCRIPTS_SRC, "scratch_copy.py");
const py = (...a) => spawnSync("python3", ["-I", PY, ...a], { encoding: "utf8" });
const COPY_ROLES = ["fleet-test-judge", "fleet-code-judge", "fleet-test-writer", "plan-audit", "gate-change-nonweakening-sweep", "scope-and-plan", "pr-review", "fleet-held-out-runner"];

test("7.3.0 #54 A23: make copies the modified, untracked and deleted states; run returns the exit code; remove drops the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-730s-"));
  const repo = join(root, "main");
  const scratch = join(root, "scratch");
  mkdirSync(repo);
  try {
    const git = (...a) => {
      const r = spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
      return r.stdout;
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "mod.txt"), "old\n");
    writeFileSync(join(repo, "gone.txt"), "x\n");
    git("add", "-A");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "mod.txt"), "new\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    rmSync(join(repo, "gone.txt"));
    const m = py("make", repo);
    assert.equal(m.status, 0, m.stderr);
    const o = JSON.parse(m.stdout);
    assert.ok(o.tmp.startsWith(scratch + "/"), o.tmp);
    assert.equal(readFileSync(join(o.tmp, "mod.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(o.tmp, "new.txt"), "utf8"), "untracked\n");
    assert.ok(!existsSync(join(o.tmp, "gone.txt")));
    assert.deepEqual(o.copied.slice().sort(), ["mod.txt", "new.txt"]);
    assert.deepEqual(o.deleted, ["gone.txt"]);
    // the fleet worktree is unchanged
    assert.equal(readFileSync(join(repo, "mod.txt"), "utf8"), "new\n");
    const f = py("run", repo, o.tmp, JSON.stringify(["false"]));
    assert.equal(f.status, 0, f.stderr);
    assert.equal(JSON.parse(f.stdout).exit_code, 1);
    const p = py("run", repo, o.tmp, JSON.stringify(["printenv", "FLEET_X"]), JSON.stringify({ FLEET_X: "seen" }));
    const po = JSON.parse(p.stdout);
    assert.equal(po.exit_code, 0);
    assert.match(po.tail, /seen/);
    assert.ok(JSON.parse(py("run", repo, o.tmp, JSON.stringify(["pwd"])).stdout).tail.includes(o.tmp));
    // a tmp outside scratch_dir is refused by run and remove
    assert.notEqual(py("run", repo, repo, JSON.stringify(["true"])).status, 0);
    assert.notEqual(py("remove", repo, repo).status, 0);
    const r = py("remove", repo, o.tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!git("worktree", "list").includes(o.tmp));
    assert.ok(!existsSync(o.tmp));
    // a rev: a detached copy of that commit, nothing copied
    const head = git("rev-parse", "HEAD").trim();
    const v = JSON.parse(py("make", repo, head).stdout);
    assert.equal(readFileSync(join(v.tmp, "mod.txt"), "utf8"), "old\n");
    assert.ok(existsSync(join(v.tmp, "gone.txt")) && !existsSync(join(v.tmp, "new.txt")));
    assert.deepEqual([v.copied, v.deleted], [[], []]);
    assert.equal(py("remove", repo, v.tmp).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7.3.0 #54 A23: the copy roles name scratch_copy and no mktemp, worktree add or worktree remove", () => {
  for (const r of COPY_ROLES) {
    const t = ROLE_TEXT[r];
    assert.ok(t.includes("scratch_copy"), r);
    assert.ok(!/mktemp|worktree add|worktree remove/.test(t), r);
  }
});

test("7.3.0 #54: the copy roles get scratch_copy_cmd as an input; other roles do not", async () => {
  const out = await run(happy(), ARGS);
  const seen = new Set();
  for (const c of out.plan.calls.concat(out.build.calls)) {
    const m = /^role:([a-z-]+)/.exec(c.label);
    if (!m) continue;
    const i = inputsOf(c.prompt);
    if (COPY_ROLES.includes(m[1])) {
      assert.match(String(i.scratch_copy_cmd), /^python3 -I '[^']*\/scratch_copy\.py'$/, c.label);
      seen.add(m[1]);
    } else assert.ok(!("scratch_copy_cmd" in i), c.label);
  }
  // 8.0.0 (G4): the held-out runner copies the judged tree too
  for (const r of ["fleet-test-judge", "fleet-code-judge", "fleet-test-writer", "plan-audit", "scope-and-plan", "pr-review", "fleet-held-out-runner"]) assert.ok(seen.has(r), r);
});
