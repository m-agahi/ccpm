// fleet 7.4.0 review (A-M1, A-M2 program side, B-M2, B-m6): push.py pushes to the URL sealed at
// plan time with an explicit refspec and no +, and never follows repo config that rewrites or
// redirects a push. The tests run real git against local bare repos. A wrapper git on PATH maps
// the sealed https URL to the bare origin (and allows the file protocol, which the program's
// own -c protocol.allow=never refuses); it changes nothing else.
// - R1 (A-M1): a + push config, a push config that maps to master, a pushurl, a pushInsteadOf, an
//   insteadOf and a remote named by the sealed URL: each is a refusal (non-zero exit), nothing
//   reaches any ref of origin or of the decoy. Security follow-up: so is any local http.*,
//   credential.*, ssh.*, core.sshCommand or core.gitProxy key, and any remote.* key but url and fetch.
// - R2 (A-M1): with no such config, a diverged origin branch is non_ff, never a forced update.
// - R3 (A-M1): the repo's origin URL is not used (its uploadpack is refused, R1): the push and the head read go to
//   the sealed URL; the upstream is set (branch.<b>.remote, branch.<b>.merge).
// - R4 (A-M2): with <parent> and <tree>, push.py checks approved^ == parent, approved^{tree} ==
//   tree and origin's head at the sealed URL == parent before it pushes.
// - R5 (B-M2): each push attempt's timeout leaves READ_RESERVE for the head read.
// - R6 (B-m6): the push and the probe run git with the hard address-space limit (the B1 lift).
//
// dont_care: the wording of the refusal text after "repo config"; the order of keys.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, spawnSync, liftSkip, relayDigestOf } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const SLEEP = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
const URL = "https://example.com/o/r.git";
const KEYS = ["push_result", "exit_code", "hook_tail", "tail", "attempts", "remote_head", "args"];

function g(cwd, ...a) {
  const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-c", "core.hooksPath=/dev/null"].concat(a), { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
const refOf = (bare, ref) => {
  const r = spawnSync(GIT, ["-C", bare, "rev-parse", "--verify", "-q", ref], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
// the wrapper git: the sealed URL -> the bare origin; FLEET_T_SLEEP makes a push hang
function wrapper(dir, origin) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "git");
  writeFileSync(
    f,
    "#!" + PY + "\nimport os, sys\nreal = " + JSON.stringify(GIT) + "\nm = {" + JSON.stringify(URL) + ": " + JSON.stringify(origin) + "}\n" +
      "a = [m.get(x, x) for x in sys.argv[1:]]\n" +
      "if 'push' in a and os.environ.get('FLEET_T_SLEEP'):\n    os.execv(" + JSON.stringify(SLEEP) + ", ['sleep', os.environ['FLEET_T_SLEEP']])\n" +
      "os.execv(real, [real, '-c', 'protocol.file.allow=always'] + a)\n",
  );
  chmodSync(f, 0o755);
}
// a repo on fleet/x one commit past master; origin (the sealed URL) and a decoy hold master;
// the repo's own origin remote points at the decoy
function scene() {
  const h = mkdtempSync(join(tmpdir(), "fleet-740r-push-"));
  const repo = join(h, "repo");
  const origin = join(h, "origin.git");
  const decoy = join(h, "decoy.git");
  g(h, "init", "-q", "--bare", origin);
  g(h, "init", "-q", "--bare", decoy);
  g(h, "init", "-q", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "a");
  g(repo, "push", "-q", origin, "master");
  g(repo, "push", "-q", decoy, "master");
  g(repo, "remote", "add", "origin", decoy);
  g(repo, "checkout", "-q", "-b", "fleet/x");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "b");
  const w = join(h, "w");
  wrapper(w, origin);
  return { h, repo, origin, decoy, w, sha: g(repo, "rev-parse", "HEAD"), master: g(repo, "rev-parse", "master") };
}
function pushArgs(e, over = {}) {
  const o = Object.assign({ env: "{}", gh: "-", slug: "-", deadline: "540", url: URL, parent: "-", tree: "-" }, over);
  return ["push", e.repo, "fleet/x", e.sha, "master", o.env, o.gh, o.slug, o.deadline, o.url, o.parent, o.tree];
}
function prog(args, e, extraEnv = {}, pathDir) {
  const PATH = (pathDir || e.w) + ":/usr/bin:/bin";
  return spawnSync(PY, ["-I", join(SCRIPTS_SRC, "push.py")].concat(args), { encoding: "utf8", env: Object.assign({ PATH, HOME: e.h, GIT_CONFIG_GLOBAL: "/dev/null" }, extraEnv), timeout: 200000 });
}
const untouched = (e) => {
  assert.equal(refOf(e.origin, "refs/heads/master"), e.master, "origin master unchanged");
  assert.equal(refOf(e.origin, "refs/heads/fleet/x"), null, "origin has no fleet/x");
  assert.equal(refOf(e.decoy, "refs/heads/master"), e.master, "decoy master unchanged");
  assert.equal(refOf(e.decoy, "refs/heads/fleet/x"), null, "decoy has no fleet/x");
};

test("7.4.0 review A-M1 R1: push config, pushurl, (push)insteadOf and a remote named by the sealed URL are refused; nothing is pushed anywhere", () => {
  const cases = [
    ["remote.origin.push", "+refs/heads/fleet/x:refs/heads/master"],
    ["remote.origin.push", "refs/heads/fleet/x:refs/heads/master"],
    ["remote.origin.pushurl", "DECOY"],
    ["url.DECOY.pushInsteadOf", URL],
    ["url.DECOY.insteadOf", URL],
    ["remote." + URL + ".pushurl", "DECOY"],
    ["remote." + URL + ".push", "+refs/heads/fleet/x:refs/heads/master"],
    // security follow-up (MEDIUM): transport config outside the user's global config
    ["http.proxy", "http://127.0.0.1:9"],
    ["http.https://example.com.proxy", "http://127.0.0.1:9"],
    ["http.sslVerify", "false"],
    ["core.sshCommand", "ssh -o ProxyCommand=evil"],
    ["core.gitProxy", "evil"],
    ["credential.helper", "!evil"],
    ["credential.https://example.com.helper", "!evil"],
    ["ssh.variant", "simple"],
    ["remote.origin.uploadpack", "evil"],
    ["remote.origin.receivepack", "evil"],
  ];
  for (const [k, v] of cases) {
    const e = scene();
    try {
      g(e.repo, "config", "--local", k.replace("DECOY", e.decoy), v.replace("DECOY", e.decoy));
      const r = prog(pushArgs(e), e);
      assert.notEqual(r.status, 0, k + " " + v + ": " + r.stdout);
      assert.match(r.stderr, /repo config rewrites or redirects the push/, k);
      untouched(e);
    } finally {
      rmSync(e.h, { recursive: true, force: true });
    }
  }
});

test("7.4.0 review A-M1 R1: a config include that sets remote.origin.push is refused too", () => {
  const e = scene();
  try {
    const inc = join(e.h, "inc.cfg");
    writeFileSync(inc, '[remote "origin"]\n\tpush = +refs/heads/fleet/x:refs/heads/master\n');
    g(e.repo, "config", "--local", "include.path", inc);
    const r = prog(pushArgs(e), e);
    assert.notEqual(r.status, 0, r.stdout);
    untouched(e);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 review A-M1 R2: a diverged origin branch is non_ff, never a forced update", () => {
  const e = scene();
  try {
    // someone else's fleet/x on origin
    const other = join(e.h, "other");
    g(e.h, "clone", "-q", e.origin, other);
    g(other, "checkout", "-q", "-b", "fleet/x");
    writeFileSync(join(other, "c.txt"), "c\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "c");
    g(other, "push", "-q", "origin", "fleet/x");
    const theirs = refOf(e.origin, "refs/heads/fleet/x");
    const r = prog(pushArgs(e), e);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "non_ff", JSON.stringify(o));
    assert.equal(refOf(e.origin, "refs/heads/fleet/x"), theirs);
    assert.equal(refOf(e.origin, "refs/heads/master"), e.master);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 review A-M1 R3: the push and the head read use the sealed URL, not the repo's origin; the upstream is set", () => {
  const e = scene();
  try {
    const args = pushArgs(e);
    const r = prog(args, e);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "ok", JSON.stringify(o));
    assert.equal(o.remote_head, e.sha);
    assert.deepEqual(o.args, args);
    assert.equal(relayDigestOf(o, KEYS), o.digest);
    assert.equal(refOf(e.origin, "refs/heads/fleet/x"), e.sha, "the sealed origin has the branch");
    assert.equal(refOf(e.decoy, "refs/heads/fleet/x"), null, "the repo's origin remote got nothing");
    assert.equal(g(e.repo, "config", "branch.fleet/x.remote"), "origin");
    assert.equal(g(e.repo, "config", "branch.fleet/x.merge"), "refs/heads/fleet/x");
    // the refspec is explicit, with no +
    const src = readFileSync(join(SCRIPTS_SRC, "push.py"), "utf8");
    assert.match(src, /'push', '--receive-pack=git-receive-pack', url, 'refs\/heads\/' \+ branch \+ ':refs\/heads\/' \+ branch\]/);
    assert.doesNotMatch(src, /'push', '-u'/);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 review A-M1: a sealed URL that is not https or git@host: is a usage error", () => {
  const e = scene();
  try {
    const r = prog(pushArgs(e, { url: e.decoy }), e);
    assert.notEqual(r.status, 0);
    untouched(e);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 review A-M2 R4: with parent and tree, push.py checks the parent, the tree and origin's head before it pushes", () => {
  const e = scene();
  try {
    // the open PR's head: fleet/x at master's child; the rebuilt commit on it
    g(e.repo, "push", "-q", e.origin, "fleet/x");
    const prHead = e.sha;
    writeFileSync(join(e.repo, "d.txt"), "d\n");
    g(e.repo, "add", "-A");
    g(e.repo, "commit", "-q", "-m", "d");
    const sha = g(e.repo, "rev-parse", "HEAD");
    const tree = g(e.repo, "rev-parse", "HEAD^{tree}");
    const e2 = Object.assign({}, e, { sha });
    // a wrong parent, a wrong tree: refused, origin unchanged
    for (const over of [{ parent: e.master, tree }, { parent: prHead, tree: "0".repeat(40) }]) {
      const r = prog(pushArgs(e2, over), e2);
      assert.notEqual(r.status, 0, JSON.stringify(over) + ": " + r.stdout);
      assert.equal(refOf(e.origin, "refs/heads/fleet/x"), prHead);
    }
    // origin's head moved (someone pushed): refused
    const other = join(e.h, "other");
    g(e.h, "clone", "-q", "-b", "fleet/x", e.origin, other);
    writeFileSync(join(other, "e.txt"), "e\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "e");
    g(other, "push", "-q", "origin", "fleet/x");
    const moved = refOf(e.origin, "refs/heads/fleet/x");
    const r1 = prog(pushArgs(e2, { parent: prHead, tree }), e2);
    assert.notEqual(r1.status, 0, r1.stdout);
    assert.match(r1.stderr, /not the open PR's head/);
    assert.equal(refOf(e.origin, "refs/heads/fleet/x"), moved);
    // back at the PR head: the push goes on
    g(other, "push", "-q", "-f", "origin", prHead + ":refs/heads/fleet/x");
    const r2 = prog(pushArgs(e2, { parent: prHead, tree }), e2);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).push_result, "ok", r2.stdout);
    assert.equal(refOf(e.origin, "refs/heads/fleet/x"), sha);
    // parent and tree come together
    assert.notEqual(prog(pushArgs(e2, { parent: prHead }), e2).status, 0);
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 review B-M2 R5: a hanging push is cut at the deadline minus READ_RESERVE, not at the deadline", () => {
  const e = scene();
  try {
    const t0 = Date.now();
    // deadline 65 s, READ_RESERVE 60 s: the attempt gets 5 s; the old code waited the whole 65 s
    const r = prog(pushArgs(e, { deadline: "65" }), e, { FLEET_T_SLEEP: "40" });
    const took = (Date.now() - t0) / 1000;
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.push_result, "network", JSON.stringify(o));
    assert.equal(o.attempts, 1);
    assert.match(o.tail, /push timed out at the deadline/);
    assert.ok(took > 4 && took < 20, "took " + took + " s");
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
  assert.match(readFileSync(join(SCRIPTS_SRC, "push.py"), "utf8"), /timeout=max\(1, left\(\) - READ_RESERVE\)/);
});

// B-m6: the B1 lift, for the push and the probe (v740_git_net_lift's stub: a network verb starts a
// credential helper that fails under a 2 GiB soft limit)
const TWO_GIB = 2 ** 31;
const SKIP = liftSkip(process.env, TWO_GIB);
function liftGit(bin, origin) {
  const helper = join(bin, "cred-helper");
  writeFileSync(helper, "#!" + PY + "\nimport resource, sys\nsoft = resource.getrlimit(resource.RLIMIT_AS)[0]\nsys.exit(2 if soft != resource.RLIM_INFINITY and soft < " + TWO_GIB + " else 0)\n");
  chmodSync(helper, 0o755);
  const f = join(bin, "git");
  writeFileSync(
    f,
    "#!" + PY + "\nimport os, resource, subprocess, sys\nreal = " + JSON.stringify(GIT) + "\nm = {" + JSON.stringify(URL) + ": " + JSON.stringify(origin) + "}\n" +
      "a = [m.get(x, x) for x in sys.argv[1:]]\n" +
      "if any(v in a for v in ('push', 'ls-remote')):\n" +
      "    soft, hard = resource.getrlimit(resource.RLIMIT_AS)\n" +
      "    open(os.path.join(" + JSON.stringify(bin) + ", 'net.log'), 'a').write('%s %s\\n' % (soft, hard))\n" +
      "    if subprocess.run([" + JSON.stringify(helper) + "]).returncode != 0:\n" +
      "        sys.stderr.write('fatal: credential helper failed (runtime: out of memory)\\n')\n        sys.exit(128)\n" +
      "os.execv(real, [real, '-c', 'protocol.file.allow=always'] + a)\n",
  );
  chmodSync(f, 0o755);
}

test("7.4.0 review B-m6 R6: push.py push and probe run their network git with the hard address-space limit", { skip: SKIP }, () => {
  const e = scene();
  try {
    const bin = join(e.h, "lbin");
    mkdirSync(bin);
    liftGit(bin, e.origin);
    const r = prog(pushArgs(e), e, {}, bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).push_result, "ok", r.stdout);
    // the probe: origin is the repo's remote (a dry run at plan time); point it at the bare origin
    g(e.repo, "remote", "set-url", "origin", e.origin);
    const p = prog(["probe", e.repo, e.master, "fleet/y"], e, {}, bin);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).access, "ok", p.stdout);
    const rows = readFileSync(join(bin, "net.log"), "utf8").trim().split("\n").map((l) => l.split(" "));
    assert.ok(rows.length >= 2, rows.join("|"));
    for (const x of rows) assert.equal(x[0], x[1], "soft == hard: " + x.join(" "));
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});
