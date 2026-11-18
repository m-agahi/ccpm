// fleet 7.4.0 (#34, L2141, Max ruling 2026-11-14 "Lift caps on git network calls"): a git
// child that talks to a remote (fetch, push, ls-remote) and the credential helper it starts
// run without the program's 1 GiB memory and CPU caps; local git commands keep the caps.
//
// The tests put a stub `git` on PATH. It logs its verb with its soft and hard RLIMIT_AS. A
// network verb first starts a stub credential helper (a child: it inherits the limits) that
// exits 2 when its soft RLIMIT_AS is below 2 GiB; the stub git then fails as git does. A local
// verb runs the real git.
//
// dont_care: the stub's log format; the canned ls-remote sha; the wording of program errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, spawnSync, liftSkip } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const TWO_GIB = 2 ** 31;
// the helper needs 2 GiB, so the lift is observable only above that hard limit
const SKIP = liftSkip(process.env, TWO_GIB);
const CAP = 1 << 30;
const NET = ["fetch", "push", "ls-remote"];

// the stub git: logs "<verb> <soft> <hard>"; a network verb runs the helper first
function stubGit(bin, opts = {}) {
  const helper = join(bin, "cred-helper");
  writeFileSync(
    helper,
    "#!" + PY + "\nimport resource, sys\nsoft = resource.getrlimit(resource.RLIMIT_AS)[0]\n" +
      "sys.exit(2 if soft != resource.RLIM_INFINITY and soft < " + TWO_GIB + " else 0)\n",
  );
  chmodSync(helper, 0o755);
  const f = join(bin, "git");
  writeFileSync(
    f,
    "#!" + PY + "\nimport json, os, resource, subprocess, sys\n" +
      "bin = " + JSON.stringify(bin) + "\nreal = " + JSON.stringify(GIT) + "\n" +
      "opts = " + JSON.stringify(opts) + "\n" +
      "a = sys.argv[1:]\ni = 0\nverb = None\n" +
      "while i < len(a):\n" +
      "    if a[i] in ('-c', '-C'):\n        i += 2\n        continue\n" +
      "    if a[i].startswith('-'):\n        i += 1\n        continue\n" +
      "    verb = a[i]\n    break\n" +
      "soft, hard = resource.getrlimit(resource.RLIMIT_AS)\n" +
      "fmt = lambda v: 'inf' if v == resource.RLIM_INFINITY else str(v)\n" +
      "open(os.path.join(bin, 'git.log'), 'a').write('%s %s %s\\n' % (verb, fmt(soft), fmt(hard)))\n" +
      "if verb in " + JSON.stringify(NET).replace(/"/g, "'") + ":\n" +
      "    if subprocess.run([os.path.join(bin, 'cred-helper')]).returncode != 0:\n" +
      "        sys.stderr.write('fatal: credential helper failed (runtime: out of memory)\\n')\n        sys.exit(128)\n" +
      "    if verb == 'ls-remote':\n" +
      "        ref = a[-1]\n        sys.stdout.write(opts.get('ls_remote', 'c' * 40) + '\\t' + ref + '\\n')\n        sys.exit(0)\n" +
      "    url_map = opts.get('url_map', {})\n" +
      "    a = [url_map.get(x, x) for x in a]\n" +
      "    os.execv(real, [real, '-c', 'protocol.file.allow=always'] + a)\n" +
      "os.execv(real, [real] + a)\n",
  );
  chmodSync(f, 0o755);
}
const logOf = (bin) => (existsSync(join(bin, "git.log")) ? readFileSync(join(bin, "git.log"), "utf8").trim().split("\n").map((l) => l.split(" ")) : []);
const lifted = (row) => row[1] === row[2];

function g(cwd, ...a) {
  const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-c", "core.hooksPath=/dev/null"].concat(a), { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
function home() {
  const h = mkdtempSync(join(tmpdir(), "fleet-740-lift-"));
  const bin = join(h, "bin");
  mkdirSync(bin);
  const repo = join(h, "repo");
  mkdirSync(repo);
  g(h, "init", "-q", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "a");
  return { h, bin, repo };
}
function prog(name, args, e) {
  return spawnSync(PY, ["-I", join(SCRIPTS_SRC, name + ".py")].concat(args), { encoding: "utf8", env: { PATH: e.bin, HOME: e.h, GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 120000 });
}

test("7.4.0 #34 B1: remote_head.py runs ls-remote with the hard address-space limit; the helper and the call succeed", { skip: SKIP }, () => {
  const e = home();
  try {
    stubGit(e.bin, { ls_remote: "d".repeat(40) });
    const r = prog("remote_head", [e.repo, "fleet/x", "https://example.com/o/r.git"], e);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).head, "d".repeat(40));
    const net = logOf(e.bin).filter((x) => x[0] === "ls-remote");
    assert.equal(net.length, 1);
    assert.ok(lifted(net[0]), net[0].join(" "));
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

test("7.4.0 #34 B1: tf_gate.py runs ls-remote and fetch lifted; its local git keeps the 1 GiB cap", { skip: SKIP }, () => {
  const e = home();
  try {
    // origin has a commit the repo lacks, so the program fetches it by sha
    const origin = join(e.h, "origin.git");
    g(e.h, "clone", "-q", "--bare", e.repo, origin);
    const up = join(e.h, "up");
    g(e.h, "clone", "-q", origin, up);
    writeFileSync(join(up, "b.txt"), "b\n");
    g(up, "add", "-A");
    g(up, "commit", "-q", "-m", "b");
    g(up, "push", "-q", "origin", "HEAD:master");
    const remote = g(up, "rev-parse", "HEAD");
    const url = "https://example.com/o/r.git";
    stubGit(e.bin, { ls_remote: remote, url_map: { [url]: origin } });
    const sha = g(e.repo, "rev-parse", "HEAD");
    const r = prog("tf_gate", [e.repo, "master", sha, url], e);
    assert.equal(r.status, 0, r.stderr);
    const log = logOf(e.bin);
    const net = log.filter((x) => NET.includes(x[0]));
    assert.deepEqual(net.map((x) => x[0]), ["ls-remote", "fetch"]);
    for (const x of net) assert.ok(lifted(x), x.join(" "));
    const local = log.filter((x) => !NET.includes(x[0]));
    assert.ok(local.length > 0);
    for (const x of local) assert.equal(Number(x[1]), CAP, x.join(" "));
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

// pr_state fetch: the worktree on fleet/x at old; origin's fleet/x at new = merge(old, base)
function fetchScene(e) {
  const origin = join(e.h, "origin.git");
  g(e.repo, "checkout", "-q", "-b", "fleet/x");
  writeFileSync(join(e.repo, "x.txt"), "x\n");
  g(e.repo, "add", "-A");
  g(e.repo, "commit", "-q", "-m", "x");
  const old = g(e.repo, "rev-parse", "HEAD");
  g(e.h, "clone", "-q", "--bare", e.repo, origin);
  g(e.repo, "remote", "add", "origin", origin);
  const up = join(e.h, "up");
  g(e.h, "clone", "-q", "-b", "master", origin, up);
  writeFileSync(join(up, "b.txt"), "b\n");
  g(up, "add", "-A");
  g(up, "commit", "-q", "-m", "b");
  const base = g(up, "rev-parse", "HEAD");
  g(up, "checkout", "-q", "fleet/x");
  g(up, "merge", "-q", "--no-edit", "--no-ff", base);
  const nw = g(up, "rev-parse", "HEAD");
  g(up, "push", "-q", "origin", "fleet/x");
  return { old, base, nw };
}

test("7.4.0 #34 B1, B2: pr_state.py fetch runs git fetch lifted and git status at the 1 GiB cap", { skip: SKIP }, () => {
  const e = home();
  try {
    const s = fetchScene(e);
    stubGit(e.bin);
    const r = prog("pr_state", ["fetch", e.repo, "fleet/x", s.old, s.nw, s.base], e);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.error, null, o.error);
    assert.equal(o.head, s.nw);
    const log = logOf(e.bin);
    const fetch = log.filter((x) => x[0] === "fetch");
    assert.equal(fetch.length, 1);
    assert.ok(lifted(fetch[0]), fetch[0].join(" "));
    const status = log.filter((x) => x[0] === "status");
    assert.equal(status.length, 1);
    assert.equal(Number(status[0][1]), CAP, status[0].join(" "));
  } finally {
    rmSync(e.h, { recursive: true, force: true });
  }
});

// B3: every git network call in the programs passes the child-only cap lift
const LIFT_DEF = /\ndef lift\(\):\n    # [^\n]*\n    for k in \(_r\.RLIMIT_AS, _r\.RLIMIT_CPU\):\n        _r\.setrlimit\(k, \(_r\.getrlimit\(k\)\[1\],\) \* 2\)\n/;
const NET_TOKEN = /'(fetch|push|ls-remote)'|'remote', 'update'/;
const CALL = /\b(subprocess\.(run|Popen|call|check_call|check_output)|g)\(/;

test("7.4.0 #34 B3: every git fetch, push, ls-remote or remote update call in scripts/*.py passes lift; push.py included", () => {
  const files = readdirSync(SCRIPTS_SRC).filter((f) => f.endsWith(".py"));
  assert.ok(files.includes("push.py"), "push.py ships");
  const hits = [];
  for (const f of files) {
    const src = readFileSync(join(SCRIPTS_SRC, f), "utf8");
    for (const line of src.split("\n")) {
      if (!CALL.test(line) || !NET_TOKEN.test(line)) continue;
      // gh_identity's dict keys are no git argv
      if (!/'git'|\bG \+|\bHARD \+|\bg\(|GIT\b/.test(line)) continue;
      hits.push([f, line.trim()]);
      assert.match(line, /preexec_fn=lift\b|net=True/, f + ": " + line.trim());
      assert.match(src, LIFT_DEF, f + " defines lift()");
    }
  }
  const by = (f) => hits.filter((h) => h[0] === f).length;
  assert.equal(by("remote_head.py"), 1, JSON.stringify(hits));
  assert.equal(by("tf_gate.py"), 2, JSON.stringify(hits));
  assert.equal(by("pr_state.py"), 1, JSON.stringify(hits));
  assert.ok(by("push.py") >= 2, JSON.stringify(hits));
  // pr_state's run(): gh always lifted, git only for a network call
  const ps = readFileSync(join(SCRIPTS_SRC, "pr_state.py"), "utf8");
  assert.match(ps, /\ndef run\(\*a, timeout=120, cmd=None, net=False\):\n    r = subprocess\.run\(\[cmd or gh\] \+ list\(a\), capture_output=True, timeout=timeout, preexec_fn=lift if \(not cmd or net\) else None\)\n/);
  // the caps themselves stay in the header of every program
  for (const f of ["remote_head.py", "tf_gate.py", "pr_state.py", "push.py"])
    assert.match(readFileSync(join(SCRIPTS_SRC, f), "utf8"), /for _k, _v in \(\(_r\.RLIMIT_AS, 1 << 30\), \(_r\.RLIMIT_CPU, 300\)\):/, f);
});
