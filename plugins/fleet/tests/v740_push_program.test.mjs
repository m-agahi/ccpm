// fleet 7.4.0 (#9 push, L2008): the push and the push-access probe run in a program, push.py.
// The prompt runs one command; the program checks the branch, pushes once, retries a network
// failure on a bounded ladder, classifies the output and reads origin's head itself. The
// target repo's pre-push hooks run on purpose: this is the one fleet git call without
// core.hooksPath=/dev/null.
//
// dont_care: the order of keys in the output; the exact wording of the tail lines; the
// remote_head of a push that did not succeed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, happy, run, ARGS, call, spawnSync, relayDigestOf } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const GITDIR = GIT.slice(0, GIT.lastIndexOf("/"));
const KEYS = ["push_result", "exit_code", "hook_tail", "tail", "attempts", "remote_head", "args"];

function g(cwd, ...a) {
  const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master"].concat(a), { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
// a repo on fleet/x with one commit past master, and a bare origin holding master
function scene() {
  const h = mkdtempSync(join(tmpdir(), "fleet-740-push-"));
  const repo = join(h, "repo");
  const origin = join(h, "origin.git");
  g(h, "init", "-q", "--bare", origin);
  g(h, "init", "-q", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "a");
  g(repo, "remote", "add", "origin", origin);
  g(repo, "push", "-q", "origin", "master");
  g(repo, "checkout", "-q", "-b", "fleet/x");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "b");
  const bin = join(h, "bin");
  mkdirSync(bin);
  return { h, repo, origin, bin, sha: g(repo, "rev-parse", "HEAD") };
}
function pushArgs(e, over = {}) {
  const o = Object.assign({ env: "{}", gh: "-", slug: "-", deadline: "540" }, over);
  return ["push", e.repo, "fleet/x", e.sha, "master", o.env, o.gh, o.slug, o.deadline];
}
function prog(args, e, pathFirst) {
  const PATH = (pathFirst ? pathFirst + ":" : "") + GITDIR + ":/usr/bin:/bin";
  return spawnSync(PY, ["-I", join(SCRIPTS_SRC, "push.py")].concat(args), { encoding: "utf8", env: { PATH, HOME: e.h, GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 200000 });
}
const digestOk = (o, keys) => relayDigestOf(o, keys) === o.digest;

test("7.4.0 #9 P1: push.py pushes the branch to origin at approved_sha and prints ok, args, a digest and remote_head", () => {
  const e = scene();
  try {
    const args = pushArgs(e);
    const r = prog(args, e);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "ok", JSON.stringify(o));
    assert.equal(o.exit_code, 0);
    assert.equal(o.attempts, 1);
    assert.equal(o.remote_head, e.sha);
    assert.deepEqual(o.args, args);
    assert.equal(o.program.name, "push");
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    assert.ok(digestOk(o, KEYS), "digest over " + KEYS.join(", ") + " and program");
    assert.equal(g(e.origin, "rev-parse", "refs/heads/fleet/x"), e.sha);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 #9 P1: push.py refuses the default branch, another HEAD and a dirty worktree (non-zero exit, nothing pushed)", () => {
  const e = scene();
  try {
    const bad = [
      ["push", e.repo, "master", e.sha, "master", "{}", "-", "-", "540"],
      ["push", e.repo, "fleet/x", "0".repeat(40), "master", "{}", "-", "-", "540"],
    ];
    for (const a of bad) {
      const r = prog(a, e);
      assert.notEqual(r.status, 0, a.join(" "));
    }
    writeFileSync(join(e.repo, "c.txt"), "dirty\n");
    assert.notEqual(prog(pushArgs(e), e).status, 0);
    assert.equal(spawnSync(GIT, ["-C", e.origin, "rev-parse", "--verify", "-q", "refs/heads/fleet/x"]).status, 1);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 #9 P2: a pre-push hook that exits 1 is hook_rejected with its output in hook_tail, and no retry runs (hooks run on purpose)", () => {
  const e = scene();
  try {
    const hook = join(e.repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\necho \"check_version_bump: not bumped ($FLEET_HOOK_X)\"\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = prog(pushArgs(e, { env: JSON.stringify({ FLEET_HOOK_X: "seen" }) }), e);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "hook_rejected", JSON.stringify(o));
    assert.equal(o.exit_code, 1);
    assert.equal(o.attempts, 1);
    // the hook ran with the hook env
    assert.match(o.hook_tail, /check_version_bump: not bumped \(seen\)/);
    assert.equal(spawnSync(GIT, ["-C", e.origin, "rev-parse", "--verify", "-q", "refs/heads/fleet/x"]).status, 1);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
  // the source says so: the push sets no core.hooksPath and never --no-verify
  const src = readFileSync(join(SCRIPTS_SRC, "push.py"), "utf8");
  const pushLine = src.split("\n").find((l) => /'push', '-u', 'origin'/.test(l));
  assert.ok(pushLine, "the push call");
  assert.doesNotMatch(pushLine, /hooksPath|--no-verify/);
  assert.match(src, /pre-push hooks run on purpose/);
});

// a stub git: the first <n> pushes fail the way an unreachable host does
function flakyGit(bin, n) {
  const f = join(bin, "git");
  writeFileSync(
    f,
    "#!" + PY + "\nimport os, sys\nbin = " + JSON.stringify(bin) + "\nreal = " + JSON.stringify(GIT) + "\n" +
      "if 'push' in sys.argv[1:]:\n" +
      "    c = os.path.join(bin, 'count')\n    k = int(open(c).read()) if os.path.exists(c) else 0\n    open(c, 'w').write(str(k + 1))\n" +
      "    if k < " + n + ":\n        sys.stderr.write(\"fatal: unable to access 'https://example.com/o/r.git/': Could not resolve host: example.com\\n\")\n        sys.exit(128)\n" +
      "os.execv(real, [real] + sys.argv[1:])\n",
  );
  chmodSync(f, 0o755);
}
const pushes = (bin) => (existsSync(join(bin, "count")) ? Number(readFileSync(join(bin, "count"), "utf8")) : 0);

test("7.4.0 #9 P3: two transient network failures, then ok: attempts is 3", () => {
  const e = scene();
  try {
    flakyGit(e.bin, 2);
    const r = prog(pushArgs(e), e, e.bin);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "ok", JSON.stringify(o));
    assert.equal(o.attempts, 3);
    assert.equal(pushes(e.bin), 3);
    assert.equal(o.remote_head, e.sha);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 #9 P3: with the deadline already spent no retry starts; the result is network", () => {
  const e = scene();
  try {
    flakyGit(e.bin, 5);
    const r = prog(pushArgs(e, { deadline: "0" }), e, e.bin);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "network", JSON.stringify(o));
    assert.equal(o.attempts, 1);
    assert.equal(pushes(e.bin), 1);
    assert.match(o.tail, /Could not resolve host/);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 #9: push.py probe runs the dry run and classifies it with the push-probe keys", () => {
  const e = scene();
  try {
    const base = g(e.repo, "rev-parse", "master");
    const args = ["probe", e.repo, base, "fleet/x"];
    const r = prog(args, e);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual([o.access, o.result, o.exit_code, o.auth_line], ["ok", "ok", 0, null], JSON.stringify(o));
    assert.deepEqual(o.args, args);
    assert.ok(digestOk(o, ["access", "result", "exit_code", "auth_line", "args"]));
    // a dry run: nothing reached origin
    assert.equal(spawnSync(GIT, ["-C", e.origin, "rev-parse", "--verify", "-q", "refs/heads/fleet/x"]).status, 1);
    // a pre-push hook that declines: access ok, hook_rejected
    const hook = join(e.repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const o2 = JSON.parse(prog(args, e).stdout);
    assert.deepEqual([o2.access, o2.result], ["ok", "hook_rejected"]);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 #9: the head read after the push stays inside the deadline (a gh that hangs cannot reach the 600 s Bash limit)", () => {
  const e = scene();
  try {
    const gh = join(e.bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nsleep 30\n");
    chmodSync(gh, 0o755);
    const t0 = Date.now();
    const r = prog(pushArgs(e, { gh: "gh", slug: "o/r", deadline: "3" }), e, e.bin);
    const took = (Date.now() - t0) / 1000;
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "ok", JSON.stringify(o));
    assert.equal(o.remote_head, null);
    assert.ok(took < 15, "took " + took + " s");
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
  // no push retry starts into the head read's reserve
  assert.match(readFileSync(join(SCRIPTS_SRC, "push.py"), "utf8"), /left\(\) < wait \+ took \+ READ_RESERVE/);
});

// P4: the prompts hold no shell exit-code read, redirect or loop; each names push.py through progCmd
const PROG = (name) => new RegExp("sha256sum -- '[^']*/" + name + "\\.py' && python3 -I '[^']*/" + name + "\\.py'");

test("7.4.0 #9 P4: the push and push-probe prompts hold no $?, 2> or for loop, and each runs push.py through progCmd", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const pp = call(out.plan, "infra:push-probe").prompt;
  const pu = call(out.build, "infra:push").prompt;
  for (const [name, p] of [["push-probe", pp], ["push", pu]]) {
    for (const t of ["$?", "2>", "for "]) assert.ok(!p.includes(t), name + " holds " + t + ":\n" + p);
    assert.match(p, PROG("push"), name);
    assert.doesNotMatch(p, /push_classify\.py|push_probe\.py/, name);
  }
  assert.match(pu, /'push' '[^']*' 'fleet\/y42-add-thing' '[0-9a-f]+' 'master' '\{[^']*\}' '[^']*' 'o\/r' '540'/);
  assert.match(pp, /'probe' '[^']*' 'B0' 'fleet\/y42-add-thing'/);
});
