// fleet 8.1.0 (#75, ADR-1319): the gate test runs run in a bubblewrap sandbox.
// scripts/sandbox.py builds the bwrap call for cover_diff.py, mutants.py and scratch_copy.py
// sandbox-run (the held-out runner): / read-only, a new /dev, /proc and /tmp, no network, tmpfs over
// HOME, the held-out store, the cache, data and runtime dirs, the worktree, its fleet root and the main
// checkout. The copy and the env's private dirs are writable through a fresh overlay per run. A
// *_TEST_DSN port on 127.0.0.1 reaches the host through a unix-socket relay pair. No bwrap, or a
// failed self-check: the gate is not_run "sandbox unavailable: ..." and no test process runs.
//
// ACs (#75):
// - a child writes a sentinel to ~/x and /tmp/x: neither exists on the host afterwards;
// - a child reads the held-out store: the read fails;
// - a child connects to 1.1.1.1:53: the connect fails; the DSN port alone is reachable;
// - no bwrap (or a bwrap that fails its self-check): not_run, the reason names the sandbox, no test ran;
// - bypass 1: the tree's run poisons ~, /tmp, a private dir and the DB; the base re-run is fresh
//   (the DB dropped and created again first): "tree red, base green";
// - bypass 2: the tree's tests rewrite the coverage launcher and leave a setsid daemon that rewrites the
//   data and the report: the findings stay;
// - bypass 3: a test reads the worktree's own copy of the file to spot a mutant: the read fails, the
//   mutants survive.
//
// The runtime tests run the real bwrap. They skip, with the reason, when bwrap is absent or fails its
// self-check (CI has no bwrap).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { HERE, HAVE_PY, SOURCE, ARGS, happy, run, inputsOf, call, spawnSync, passBwrap, bwrapOk } from "./harness.mjs";

const SCRIPTS = join(HERE, "..", "scripts");
const SBX = join(SCRIPTS, "sandbox.py");
const COVER = join(SCRIPTS, "cover_diff.py");
const MUT = join(SCRIPTS, "mutants.py");
const COPY = join(SCRIPTS, "scratch_copy.py");
const sh = (c) => spawnSync("sh", ["-c", c], { encoding: "utf8" }).stdout.trim();
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const GIT = sh("command -v git");
const BWRAP = sh("command -v bwrap");
// the real flags with an overlay: a kernel or a policy that refuses user namespaces fails here
const NO_SBX = (() => {
  if (!HAVE_PY) return "no python3";
  if (!BWRAP) return "bwrap is not on PATH (CI has none): the sandbox runtime tests skip";
  const d = mkdtempSync(join(tmpdir(), "fleet-sbx-chk-"));
  const r = spawnSync(BWRAP, ["--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--overlay-src", d, "--tmp-overlay", d, "--", PY, "-I", "-S", "-c", ""], { encoding: "utf8" });
  rmSync(d, { recursive: true, force: true });
  return r.status === 0 ? false : "bwrap fails its self-check here: " + (r.stderr || "").trim();
})();
const rnd = () => randomBytes(6).toString("hex");
const gitEnv = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" });
function g(cwd, ...a) {
  const r = spawnSync(GIT, a, { cwd, encoding: "utf8", env: gitEnv(cwd) });
  if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}
function put(p, body, mode) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  if (mode) chmodSync(p, mode);
}
const pyenv = (o) => Object.assign({ PATH: process.env.PATH }, o);
function prog(p, args, env) {
  const r = spawnSync(PY, ["-I", p].concat(args), { encoding: "utf8", env: pyenv(env) });
  return { r, out: r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
}

// ---------------------------------------------------------------- the held-out runner's copy

// the probe the copy holds: write, read, net, mark modes
const PROBE = `import json, os, pwd, socket, sys, time
m, a = sys.argv[1], sys.argv[2:]
if m == 'write':
    for p in [os.path.expanduser('~/' + a[0]), os.path.join(pwd.getpwuid(os.getuid()).pw_dir, a[0]), '/tmp/' + a[0]] + a[1:]:
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'w').write('x')
        except OSError as e:
            print('write failed', p, e)
    sys.exit(0)
if m == 'read':
    try:
        print('READ:' + open(a[0]).read())
        sys.exit(3)
    except OSError as e:
        print('read failed', e)
        sys.exit(0)
if m == 'net':
    s = socket.socket()
    s.settimeout(3)
    try:
        s.connect(('1.1.1.1', 53))
        sys.exit(4)
    except OSError as e:
        print('connect failed', e)
        sys.exit(0)
if m == 'unix':
    hit = []
    for p in a:
        u = socket.socket(socket.AF_UNIX)
        u.settimeout(3)
        try:
            u.connect(p)
            hit.append(p)
        except OSError as e:
            print('unix connect failed', p, e)
    print('UNIX:' + json.dumps(hit))
    sys.exit(5 if hit else 0)
if m == 'nixadd':
    import subprocess
    r = subprocess.run(['nix-store', '--add', a[0]], capture_output=True, text=True)
    print('NIX:', r.returncode, r.stdout.strip(), r.stderr.strip()[-300:])
    sys.exit(6 if r.returncode == 0 else 0)
if m == 'mark':
    open(a[0], 'w').write('ran')
if m == 'sleep':
    import subprocess
    subprocess.Popen(['sleep', '120', a[0]], start_new_session=True)
    os.setsid()
    time.sleep(120)
`;
// a repo <d>/main holding probe.py; a copy <d>/scratch/copy-* made by scratch_copy.py make; a held-out store
// under <d>/cfg (the scratch_copy process's XDG_CONFIG_HOME); the runner's private dirs under <d>/scratch/build
function copyFixture() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v810-")));
  const wt = join(d, "main");
  put(join(wt, "probe.py"), PROBE);
  g(d, "init", "-q", "-b", "master", wt);
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const store = join(d, "cfg", "fleet", "held-out", "t1", "a".repeat(64) + ".json");
  put(store, '{"examples": "SECRET-EXAMPLE"}');
  const mk = prog(COPY, ["make", wt]);
  assert.ok(mk.out, mk.r.stderr);
  const priv = join(d, "scratch", "build", "n1", "held-out-r1");
  const env = Object.fromEntries("HOME TMPDIR XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME".split(" ").map((v) => [v, join(priv, v)]));
  return { d, wt, tmp: mk.out.tmp, store, env, priv, done: () => rmSync(d, { recursive: true, force: true }) };
}
const srun = (x, argv, path) => prog(COPY, ["sandbox-run", x.wt, x.tmp, JSON.stringify(argv), JSON.stringify(x.env)], Object.assign({ XDG_CONFIG_HOME: join(x.d, "cfg"), PATH: path || process.env.PATH }, path ? bwrapOk(path) : {}));

test("8.1.0 #75: a child writes a sentinel to ~/x and /tmp/x (and its private HOME): none exists on the host afterwards", { skip: NO_SBX }, () => {
  const x = copyFixture();
  const s = "fleet-sentinel-" + rnd();
  const hostHome = join(homedir(), s);
  try {
    const r = srun(x, ["python3", "probe.py", "write", s, join(x.env.HOME, "deep", s)]);
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
    for (const p of [hostHome, "/tmp/" + s, join(x.env.HOME, s), join(x.env.HOME, "deep", s)]) assert.ok(!existsSync(p), p);
  } finally {
    rmSync(hostHome, { force: true });
    rmSync("/tmp/" + s, { force: true });
    x.done();
  }
});

test("8.1.0 #75 control: the unsandboxed run mode (the other copy roles) does let a /tmp sentinel through, so the fixture bites", { skip: NO_SBX }, () => {
  const x = copyFixture();
  const s = "fleet-sentinel-" + rnd();
  try {
    const r = prog(COPY, ["run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "write", s]), JSON.stringify({ HOME: join(x.d, "h") })]);
    assert.equal(r.out.exit_code, 0);
    assert.ok(existsSync("/tmp/" + s));
  } finally {
    rmSync("/tmp/" + s, { force: true });
    x.done();
  }
});

test("8.1.0 #75: a child cannot read the held-out store (the read fails; the unsandboxed control reads it)", { skip: NO_SBX }, () => {
  const x = copyFixture();
  try {
    const r = srun(x, ["python3", "probe.py", "read", x.store]);
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
    assert.ok(!r.out.tail.includes("SECRET-EXAMPLE"));
    const c = prog(COPY, ["run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "read", x.store])]);
    assert.equal(c.out.exit_code, 3, "control: the plain run reads it");
  } finally {
    x.done();
  }
});

// 8.1.0 review (HIGH 1): --unshare-net does not cover path-based unix sockets; /run is hidden, so a child
// cannot reach podman, docker, D-Bus or an agent socket of the host
test("8.1.0 #75 review: a child cannot connect to a host unix socket under /run or the runtime dir (the unsandboxed control can)", { skip: NO_SBX }, async () => {
  const rt = process.env.XDG_RUNTIME_DIR || "/run/user/" + process.getuid();
  const cand = ["/run/dbus/system_bus_socket"].filter((p) => existsSync(p));
  let srv = null;
  const own = join(rt, "fleet-v810-" + rnd() + ".sock");
  if (existsSync(rt)) {
    srv = createServer(() => {});
    await new Promise((ok, no) => srv.once("error", no).listen(own, ok)).then(() => cand.push(own), () => (srv = null));
  }
  const x = copyFixture();
  try {
    if (!cand.length) return;
    const c = prog(COPY, ["run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "unix"].concat(cand)), JSON.stringify({ HOME: join(x.d, "h") })]);
    assert.equal(c.out.exit_code, 5, "control: the plain run reaches a host socket: " + c.out.tail);
    const r = srun(x, ["python3", "probe.py", "unix"].concat(cand));
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
  } finally {
    if (srv) srv.close();
    rmSync(own, { force: true });
    x.done();
  }
});

// 8.1.0 review (H1): the nix daemon writes the host store and fetches URLs; its socket is hidden
const NIX_STORE = spawnSync("sh", ["-c", "command -v nix-store"], { encoding: "utf8" }).stdout.trim();
test("8.1.0 #75 review: a child cannot add a path to the host's /nix/store through the nix daemon", { skip: NO_SBX || !NIX_STORE || !existsSync("/nix/var/nix/daemon-socket") }, () => {
  const x = copyFixture();
  const leak = "fleet-v810-leak-" + rnd();
  try {
    // the file is in the copy, so both runs read the same bytes; the path it would get in the store
    put(join(x.tmp, leak), "leak " + leak + "\n");
    const r = srun(x, ["python3", "probe.py", "nixadd", leak]);
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
    assert.ok(!readdirSync("/nix/store").some((n) => n.endsWith("-" + leak)), "no new store path");
  } finally {
    x.done();
  }
});

// 8.1.0 review (R1): /var/tmp is a channel from the host's unsandboxed runs into the sandbox
test("8.1.0 #75 review: a file the host writes to /var/tmp is not visible in the sandbox (the unsandboxed control sees it)", { skip: NO_SBX || !existsSync("/var/tmp") }, () => {
  const x = copyFixture();
  const f = join("/var/tmp", "fleet-v810-" + rnd());
  try {
    writeFileSync(f, "PRISTINE-SOURCE");
    const c = prog(COPY, ["run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "read", f])]);
    assert.equal(c.out.exit_code, 3, "control: the plain run reads it");
    const r = srun(x, ["python3", "probe.py", "read", f]);
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
    assert.ok(!r.out.tail.includes("PRISTINE-SOURCE"));
  } finally {
    rmSync(f, { force: true });
    x.done();
  }
});

// 8.1.0 review (HIGH 2): a PATH dir that is HOME, or holds the held-out store, is never bound back
test("8.1.0 #75 review: with HOME and the store's parent on PATH, a child still cannot read the held-out store", { skip: NO_SBX }, () => {
  const x = copyFixture();
  // the host HOME outside the fleet root (a dir under the root is never bound back anyway)
  const hh = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v810-home-")));
  try {
    const store = join(hh, ".config", "fleet", "held-out", "t1", "b".repeat(64) + ".json");
    put(store, '{"examples": "SECRET-HOME-EXAMPLE"}');
    const path = [process.env.PATH, hh, join(hh, ".config", "fleet")].join(":");
    const r = prog(COPY, ["sandbox-run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "read", store]), JSON.stringify(x.env)], { HOME: hh, PATH: path });
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
    assert.ok(!r.out.tail.includes("SECRET-HOME-EXAMPLE"));
  } finally {
    rmSync(hh, { recursive: true, force: true });
    x.done();
  }
});

// 8.1.0 review: the role users share the repo's test_db_prefix grants in one container, so the reset
// drops the DSN's own database and its <db>_* databases only; another role's or run's database stays
test("8.1.0 #75 review: dbreset drops the gate's database and its <db>_* databases only; another role's database survives; a DSN with no database is refused", { skip: !HAVE_PY }, () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v810-dbr-")));
  try {
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = join(d, "db.log");
    put(join(bin, "mariadb"), "#!/bin/sh\necho \"$*\" >> '" + log + "'\ncase \"$*\" in *'SHOW DATABASES'*) printf 'information_schema\\nfleet_gates\\nfleet_gates_gw0\\nfleet_cjudge_x\\nfleet_hrun\\napp_test_1\\n' ;; esac\nexit 0\n", 0o755);
    const reset = (dsn, keep = ["fleet_gates", "fleet_gates_gw0", "fleet_cjudge_x", "fleet_hrun", "app_test_1"]) => {
      const spec = join(d, "spec.json");
      writeFileSync(spec, JSON.stringify({ worktree: d, cwd: d, argv: ["true"], env: { APP_TEST_DSN: dsn }, keep, result: join(d, "res.json") }));
      const r = spawnSync(PY, ["-I", SBX, "dbreset", spec], { encoding: "utf8", env: { PATH: bin + ":" + process.env.PATH } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(join(d, "res.json"), "utf8"));
    };
    assert.deepEqual(reset("mysql://fleet_gates:pw@127.0.0.1:3399/fleet_gates"), { ok: true, reason: null });
    const sql = readFileSync(log, "utf8");
    assert.match(sql, /DROP DATABASE `fleet_gates`; DROP DATABASE `fleet_gates_gw0`; CREATE DATABASE `fleet_gates`;/);
    for (const other of ["fleet_cjudge_x", "fleet_hrun", "app_test_1"]) assert.ok(!sql.includes("DROP DATABASE `" + other + "`"), other + " survives");
    rmSync(log, { force: true });
    const no = reset("mysql://fleet_gates:pw@127.0.0.1:3399/");
    assert.equal(no.ok, false);
    assert.match(no.reason, /APP_TEST_DSN names no test database/);
    assert.ok(!existsSync(log), "no SQL ran");
    // review M1: a <test_db_prefix>* database the tree run made (not in the list from before it) is dropped;
    // one that was there before stays; with no list the reset is refused
    assert.equal(reset("mysql://fleet_gates:pw@127.0.0.1:3399/fleet_gates", ["fleet_gates", "fleet_cjudge_x", "fleet_hrun"]).ok, true);
    const sql2 = readFileSync(log, "utf8");
    assert.match(sql2, /DROP DATABASE `fleet_gates`; DROP DATABASE `fleet_gates_gw0`; DROP DATABASE `app_test_1`; CREATE DATABASE `fleet_gates`;/);
    for (const other of ["fleet_cjudge_x", "fleet_hrun"]) assert.ok(!sql2.includes("DROP DATABASE `" + other + "`"), other + " survives");
    rmSync(log, { force: true });
    const nokeep = reset("mysql://fleet_gates:pw@127.0.0.1:3399/fleet_gates", null);
    assert.equal(nokeep.ok, false);
    assert.match(nokeep.reason, /no database list from before the tree run/);
    assert.ok(!existsSync(log), "no SQL ran");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.1.0 #75: a child cannot connect to 1.1.1.1:53", { skip: NO_SBX }, () => {
  const x = copyFixture();
  try {
    const r = srun(x, ["python3", "probe.py", "net"]);
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.exit_code, 0, r.out.tail);
  } finally {
    x.done();
  }
});

test("8.1.0 #75: at the run deadline the whole sandbox dies: no process of the run (a setsid child included) is left on the host", { skip: NO_SBX }, () => {
  const x = copyFixture();
  const tag = "fleet-dl-" + rnd();
  try {
    const t0 = Date.now();
    const r = prog(COPY, ["sandbox-run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "sleep", tag]), JSON.stringify(x.env)], { FLEET_SCRATCH_RUN_DEADLINE: "3" });
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.timed_out, true);
    assert.ok(Date.now() - t0 < 30000);
    // give the kernel a moment to reap the namespace
    spawnSync("sleep", ["1"]);
    const left = readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).filter((n) => {
      try {
        return readFileSync(join("/proc", n, "cmdline"), "utf8").includes(tag);
      } catch {
        return false;
      }
    });
    assert.deepEqual(left, [], "processes left: " + left.join(", "));
  } finally {
    x.done();
  }
});

// a bin dir with git and python3 only (no bwrap), or with a bwrap that always fails
function noBwrapPath(d, failing) {
  const bin = join(d, "nobw");
  mkdirSync(bin);
  symlinkSync(GIT, join(bin, "git"));
  symlinkSync(PY, join(bin, "python3"));
  if (failing) put(join(bin, "bwrap"), "#!/bin/sh\necho 'bwrap: no user namespaces' >&2\nexit 1\n", 0o755);
  return bin;
}

test("8.1.0 #75: no bwrap, or a bwrap that fails its self-check: sandbox-run refuses (sandbox unavailable) and no test process runs", { skip: !HAVE_PY }, () => {
  for (const failing of [false, true]) {
    const x = copyFixture();
    try {
      const mark = join(x.d, "marker-" + rnd());
      const r = srun(x, ["python3", "probe.py", "mark", mark], noBwrapPath(x.d, failing));
      assert.notEqual(r.r.status, 0);
      assert.match(r.r.stderr, failing ? /^sandbox unavailable: the bwrap self-check failed/m : /^sandbox unavailable: bwrap is not on PATH/m);
      assert.ok(!existsSync(mark), "no test process ran");
    } finally {
      x.done();
    }
  }
});

test("8.1.0 #75: the bwrap argv hides the store, the caches, ~/.ssh, the runtime dir, the worktree, the fleet root and the main checkout; it re-binds no secret dir", { skip: !HAVE_PY }, () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v810-plan-")));
  try {
    const repo = join(d, "repo");
    const wt = join(repo, ".claude", "worktrees", "fleet-x", "main");
    mkdirSync(wt, { recursive: true });
    g(d, "init", "-q", "-b", "master", repo);
    put(join(repo, "f"), "x");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "b");
    g(repo, "worktree", "add", "-q", "--detach", wt);
    const home = join(d, "home");
    const cfg = join(d, "cfg");
    const rund = join(d, "run");
    for (const p of [join(home, ".ssh"), join(home, ".cache", "fleet"), join(home, ".cache", "tool", "bin"), join(home, ".local", "bin"), join(cfg, "fleet", "held-out"), rund]) mkdirSync(p, { recursive: true });
    const root = dirname(wt);
    const copy = join(root, "scratch", "copy-1");
    mkdirSync(copy, { recursive: true });
    const priv = join(root, "scratch", "build", "n1", "k", "HOME");
    const spec = join(d, "spec.json");
    // a profile link under HOME to a dir outside every hidden dir (as ~/.nix-profile -> /nix/store/...)
    symlinkSync("/usr", join(home, ".nix-profile"));
    const env = { PATH: [join(home, ".local", "bin"), join(home, ".cache", "tool", "bin"), home, join(cfg, "fleet"), join(home, ".nix-profile", "bin"), "/usr/bin"].join(":"), HOME: priv, X_TEST_DSN: "mysql://u:p@127.0.0.1:3307/fleet_gates" };
    writeFileSync(spec, JSON.stringify({ worktree: wt, cwd: copy, copy, argv: ["true"], env, git: true, result: join(d, "res") }));
    const r = spawnSync(PY, ["-I", SBX, "plan", spec], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: cfg, XDG_RUNTIME_DIR: rund } });
    assert.equal(r.status, 0, r.stderr);
    const { argv: a, dropped } = JSON.parse(r.stdout);
    assert.ok(a, r.stdout);
    for (const f of ["--unshare-all", "--die-with-parent", "--new-session"]) assert.ok(a.includes(f), f);
    assert.ok(!a.includes("--share-net"));
    const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
    const tmpfs = pairs("--tmpfs");
    for (const h of ["/tmp", "/run", home, cfg, rund, repo]) assert.ok(tmpfs.includes(h), "tmpfs " + h + " in " + tmpfs);
    // from /run only the NixOS system profile and wrappers come back, by exact path
    const fromRun = pairs("--ro-bind").concat(a.flatMap((v, i) => (v === "--symlink" ? [a[i + 2]] : []))).filter((b) => b.startsWith("/run/"));
    for (const b of fromRun) assert.ok(["/run/current-system", "/run/wrappers"].includes(b) || b.startsWith("/nix/store/"), b);
    // the worktree and the fleet root are under the main checkout (one tmpfs covers them)
    assert.ok(tmpfs.some((t) => (wt + "/").startsWith(t + "/")));
    // what comes back read-only or writable: never a secret dir
    const secret = [join(home, ".ssh"), join(home, ".cache"), join(cfg, "fleet", "held-out"), cfg, rund, wt];
    const back = pairs("--ro-bind").concat(pairs("--bind"), pairs("--overlay-src"));
    for (const b of back) if (b !== "/") for (const s of secret) assert.ok(!(b + "/").startsWith(s + "/"), b + " is under " + s);
    // no bind-back holds HOME, the store or the checkout
    for (const b of back) if (b !== "/") for (const k of [home, cfg, repo, join(cfg, "fleet", "held-out")]) assert.ok(!(k + "/").startsWith(b + "/"), b + " holds " + k);
    assert.ok(!back.includes(join(home, ".local", "bin")), "a PATH dir whose real path is under HOME is dropped");
    for (const e of [join(home, ".local", "bin"), home, join(cfg, "fleet")]) assert.ok(dropped.includes(e), e + " dropped: " + dropped);
    const i = a.findIndex((v, j) => v === "--ro-bind" && a[j + 2] === join(home, ".nix-profile", "bin"));
    assert.equal(a[i + 1], "/usr/bin", "a profile link under HOME comes back as its real dir");
    assert.ok(!back.includes(join(home, ".cache", "tool", "bin")), "a PATH dir under the cache stays hidden");
    assert.ok(pairs("--overlay-src").includes(copy) && pairs("--overlay-src").includes(priv), "the copy and the private HOME: fresh overlays");
    assert.ok(pairs("--ro-bind").includes(join(repo, ".git")), "git: true re-binds the git dir read-only");
    assert.deepEqual(pairs("--bind"), [], "nothing is written through");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.1.0 #75: the DB: a *_TEST_DSN port on 127.0.0.1 is reachable inside, another port and the internet are not", { skip: NO_SBX }, async () => {
  const x = copyFixture();
  const srv = join(x.d, "srv.py");
  // a host echo server on a free port P, and a listener on P + 1
  put(srv, "import socket, sys, time\nl = socket.socket(); l.bind(('127.0.0.1', 0)); l.listen(4)\nm = socket.socket(); m.bind(('127.0.0.1', l.getsockname()[1] + 1)); m.listen(4)\nprint(l.getsockname()[1], flush=True)\nl.settimeout(60)\nc = l.accept()[0]; c.sendall(c.recv(4)); c.close()\n");
  put(join(x.tmp, "dbprobe.py"), "import socket, sys\nP = int(sys.argv[1])\ndef c(h, p, send=False):\n    s = socket.socket(); s.settimeout(3)\n    try:\n        s.connect((h, p))\n        if send:\n            s.sendall(b'ping'); return s.recv(4).decode()\n        return 'connected'\n    except OSError:\n        return 'fail'\nprint('R', c('127.0.0.1', P, True), c('127.0.0.1', P + 1), c('1.1.1.1', 53))\n");
  const p = spawn(PY, ["-I", srv]);
  try {
    const port = await new Promise((ok, no) => {
      p.stdout.once("data", (b) => ok(Number(String(b).trim())));
      p.once("error", no);
    });
    const env = Object.assign({}, x.env, { APP_TEST_DSN: "mysql://fleet_hrun:pw@127.0.0.1:" + port + "/fleet_hrun" });
    // async: the echo server runs in this process's event loop's child
    const r = await new Promise((ok) => {
      const c = spawn(PY, ["-I", COPY, "sandbox-run", x.wt, x.tmp, JSON.stringify(["python3", "dbprobe.py", String(port)]), JSON.stringify(env)], { env: pyenv({ XDG_CONFIG_HOME: join(x.d, "cfg") }) });
      let o = "";
      let e = "";
      c.stdout.on("data", (b) => (o += b));
      c.stderr.on("data", (b) => (e += b));
      c.on("close", (code) => ok({ code, o, e }));
    });
    assert.equal(r.code, 0, r.e);
    const out = JSON.parse(r.o.trim());
    assert.equal(out.exit_code, 0, out.tail);
    assert.match(out.tail, /R ping fail fail/);
  } finally {
    p.kill();
    x.done();
  }
});

// ---------------------------------------------------------------- cover_diff.py and mutants.py

const BASE_MOD = "def f(x):\n    return x\n";
const NEW_MOD = "def f(x):\n    return x\n\n\ndef g(x):\n    if x > 1:\n        return 1\n    # a comment\n    return 2\n";
// a fake coverage module in a venv under the gates' private dirs (UV_PROJECT_ENVIRONMENT): run executes
// the module in-process and records lines 1, 2, 5, 6, 7 of pkg/mod.py; json reports from the data file
const FAKE_COV = `import json, os, runpy, sys
a = sys.argv[1:]
if a[:1] == ['--version']:
    print('fake coverage 1.0')
    sys.exit(0)
o = dict(x.split('=', 1) for x in a if x.startswith('--') and '=' in x)
if a[:1] == ['run']:
    i = a.index('-m')
    sys.argv = [a[i + 1]] + a[i + 2:]
    sys.path.insert(0, os.getcwd())
    code = 0
    try:
        runpy.run_module(a[i + 1], run_name='__main__', alter_sys=True)
    except SystemExit as e:
        code = e.code or 0
    with open(o['--data-file'], 'w') as fh:
        json.dump({'pkg/mod.py': [1, 2, 5, 6, 7]}, fh)
    sys.exit(code)
if a[:1] == ['json']:
    with open(o['--data-file']) as fh:
        d = json.load(fh)
    files = {p: {'executed_lines': l, 'missing_lines': [n for n in (1, 2, 5, 6, 7, 9) if n not in l], 'excluded_lines': []} for p, l in d.items()}
    with open(a[a.index('-o') + 1], 'w') as fh:
        json.dump({'meta': {}, 'files': files}, fh)
    sys.exit(0)
sys.exit(2)
`;
// a repo <d>/main: base and judged tree each hold a test runner package pytest/ (python3 -m pytest);
// the gates' private dirs under <d>/scratch/build/n1/gates-r1; stub mariadb, bwrap-free PATH on request
function gateFixture(o) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v810g-")));
  const wt = join(d, "main");
  put(join(wt, "pkg", "__init__.py"), "");
  put(join(wt, "pkg", "mod.py"), BASE_MOD);
  put(join(wt, "pytest", "__init__.py"), "");
  put(join(wt, "pytest", "__main__.py"), o.baseRunner);
  put(join(wt, "tests", "test_mod.py"), "def test_f():\n    pass\n");
  g(d, "init", "-q", "-b", "master", wt);
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "base");
  const base = g(wt, "rev-parse", "HEAD");
  put(join(wt, "pkg", "mod.py"), NEW_MOD);
  put(join(wt, "pytest", "__main__.py"), o.treeRunner);
  const idx = join(d, "idx");
  const ie = Object.assign(gitEnv(d), { GIT_INDEX_FILE: idx });
  spawnSync(GIT, ["read-tree", "HEAD"], { cwd: wt, env: ie });
  spawnSync(GIT, ["add", "-A"], { cwd: wt, env: ie });
  const tree = spawnSync(GIT, ["write-tree"], { cwd: wt, env: ie, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  const priv = join(d, "scratch", "build", "n1", "gates-r1");
  const venv = join(priv, "uv-venv");
  let env = { UV_PROJECT_ENVIRONMENT: venv };
  if (o.venv) {
    const v = spawnSync(PY, ["-I", "-m", "venv", "--without-pip", venv], { encoding: "utf8" });
    assert.equal(v.status, 0, v.stderr);
    const lib = readdirSync(join(venv, "lib")).filter((n) => n.startsWith("python3"));
    assert.equal(lib.length, 1, "one python3* dir in the venv");
    const sp = join(venv, "lib", lib[0], "site-packages");
    assert.ok(existsSync(sp), sp);
    put(join(sp, "coverage", "__init__.py"), "");
    put(join(sp, "coverage", "__main__.py"), FAKE_COV);
    env.PATH = join(venv, "bin");
  }
  env = Object.assign(env, o.env || {});
  const bin = join(d, "agentbin");
  mkdirSync(bin);
  const dblog = join(d, "db.log");
  // a stub mariadb client: logs argv and MYSQL_PWD's presence; SHOW DATABASES lists two
  // the first SHOW DATABASES (before the tree run) has no app_poison; later ones do (the tree run made it)
  const cnt = join(d, "db.count");
  put(join(bin, "mariadb"), "#!/bin/sh\necho \"argv: $* pwd=${MYSQL_PWD:+set}\" >> '" + dblog + "'\ncase \"$*\" in *'SHOW DATABASES'*) printf 'information_schema\\nfleet_gates\\nfleet_gates_gw0\\nfleet_cjudge_x\\napp_extra\\n'; if [ -e '" + cnt + "' ]; then echo app_poison; fi; touch '" + cnt + "' ;; esac\nexit 0\n", 0o755);
  const hostHome = join(d, "hosthome");
  mkdirSync(hostHome);
  // the program's own temp dir (its work dir): a daemon a control run leaves walks this dir only
  const tmpd = join(d, "tmp");
  mkdirSync(tmpd);
  if (o.passBwrap) passBwrap(bin);
  const agentPath = o.noBwrap ? noBwrapPath(d, o.failing) : bin + ":" + process.env.PATH;
  const go = (p) => {
    const args = [wt, base, tree, "python3 -m pytest <paths>", JSON.stringify(env), JSON.stringify(["tests/test_mod.py", "pytest/__main__.py"])];
    return prog(p, args, Object.assign({ PATH: agentPath, HOME: hostHome, TMPDIR: tmpd, FLEET_MUTANTS_DEADLINE: "200" }, bwrapOk(agentPath.split(":")[0])));
  };
  return { d, wt, base, tree, priv, venv, hostHome, dblog, go, done: () => rmSync(d, { recursive: true, force: true }) };
}

const POISON_BASE = `import os, sys
bad = [p for p in (os.path.expanduser('~/.fleet-poison'), os.environ['POISON'], os.path.join(os.environ['UV_PROJECT_ENVIRONMENT'], 'poison')) if os.path.exists(p)]
print('poisoned' if bad else 'clean', bad)
sys.exit(1 if bad else 0)
`;
const POISON_TREE = `import os, sys
for p in (os.path.expanduser('~/.fleet-poison'), os.environ['POISON'], os.path.join(os.environ['UV_PROJECT_ENVIRONMENT'], 'poison')):
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w').write('x')
    except OSError as e:
        print('poison failed', p, e)
sys.exit(1)
`;

for (const [name, p] of [["cover_diff", COVER], ["mutants", MUT]]) {
  test("8.1.0 #75 bypass 1 (" + name + "): the tree's run poisons ~, /tmp, a private dir and the DB; the base re-run is fresh (the DB dropped and created first): tree red, base green", { skip: NO_SBX }, () => {
    const poison = "/tmp/fleet-poison-" + rnd();
    const x = gateFixture({ baseRunner: POISON_BASE, treeRunner: POISON_TREE, venv: name === "cover_diff", env: { POISON: poison, APP_TEST_DSN: "mysql://fleet_gates:pw1@127.0.0.1:3399/fleet_gates" } });
    try {
      const r = x.go(p);
      assert.ok(r.out, r.r.stderr);
      assert.equal(r.out.status, "not_run");
      assert.match(r.out.reason, /^tree red, base green/);
      assert.ok(!existsSync(poison) && !existsSync(join(x.hostHome, ".fleet-poison")) && !existsSync(join(x.venv, "poison")), "no poison reached the host");
      const db = existsSync(x.dblog) ? readFileSync(x.dblog, "utf8") : "";
      assert.match(db, /SHOW DATABASES/);
      assert.match(db, /DROP DATABASE `fleet_gates`; DROP DATABASE `fleet_gates_gw0`; DROP DATABASE `app_poison`; CREATE DATABASE `fleet_gates`;/);
      assert.doesNotMatch(db, /DROP DATABASE `(fleet_cjudge_x|app_extra)`/);
      assert.ok(!db.includes("pw1") && /pwd=set/.test(db), "the password goes in MYSQL_PWD, never in argv");
    } finally {
      rmSync(poison, { force: true });
      x.done();
    }
  });

  test("8.1.0 #75 (" + name + "): no bwrap, or one that fails its self-check: not_run 'sandbox unavailable: ...' and no test process ran", { skip: !HAVE_PY }, () => {
    for (const failing of [false, true]) {
      const mark = "/tmp/fleet-mark-" + rnd();
      const runner = "import sys\nopen('" + mark + "', 'w').write('ran')\nsys.exit(0)\n";
      const x = gateFixture({ baseRunner: runner, treeRunner: runner, venv: name === "cover_diff", noBwrap: true, failing });
      try {
        const r = x.go(p);
        assert.ok(r.out, r.r.stderr);
        assert.equal(r.out.status, "not_run");
        assert.match(r.out.reason, failing ? /^sandbox unavailable: the bwrap self-check failed/ : /^sandbox unavailable: bwrap is not on PATH/);
        assert.ok(!existsSync(mark), "no test process ran");
      } finally {
        rmSync(mark, { force: true });
        x.done();
      }
    }
  });
}

// the tree's tests: rewrite every coverage launcher they can find; in the plain run (no coverage loaded)
// leave a setsid daemon that rewrites every coverage data file and report under the temp dir for 4 s
const TAMPER = `import json, os, sys, tempfile, time
LINES = list(range(1, 10))
FORGED = {'meta': {}, 'files': {'pkg/mod.py': {'executed_lines': LINES, 'missing_lines': [], 'excluded_lines': []}}}
def walk(names):
    for r, ds, fs in os.walk(tempfile.gettempdir()):
        for f in fs:
            if f in names:
                yield os.path.join(r, f)
for p in walk(('cov.py',)):
    try:
        open(p, 'w').write('import json, sys\\nif "-o" in sys.argv:\\n    json.dump(' + repr(FORGED) + ', open(sys.argv[sys.argv.index("-o") + 1], "w"))\\n')
    except OSError:
        pass
if 'coverage' not in sys.modules and os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        end = time.time() + 4
        while time.time() < end:
            for p in walk(('data', 'cov.json')):
                try:
                    # atomic (write aside, rename over): a plain open(p, 'w') truncates first, and a reader
                    # that lands in that window sees an empty file (the CI flake of #84)
                    json.dump(FORGED if p.endswith('.json') else {'pkg/mod.py': LINES}, open(p + '.t', 'w'))
                    os.replace(p + '.t', p)
                except OSError:
                    pass
            time.sleep(0.01)
    os._exit(0)
time.sleep(0.2)
sys.exit(0)
`;
test("8.1.0 #75 bypass 2 (cover_diff): the tree's tests rewrite the coverage launcher and leave a setsid daemon on the data and the report: the uncovered line stays a finding (the pass-through control loses it)", { skip: NO_SBX }, () => {
  for (const pass of [true, false]) {
    const x = gateFixture({ baseRunner: "import sys\nsys.exit(0)\n", treeRunner: TAMPER, venv: true, passBwrap: pass });
    try {
      const r = x.go(COVER);
      assert.ok(r.out, r.r.stderr);
      assert.equal(r.out.status, "ran", r.out.reason);
      if (pass) assert.deepEqual(r.out.findings, [], "control: with no sandbox the daemon forges the data");
      else assert.deepEqual(r.out.findings, [{ path: "pkg/mod.py", lines: [9] }]);
    } finally {
      x.done();
    }
  }
});

// the tree's test spots a mutant by reading the worktree's own pkg/mod.py (its absolute path baked in)
test("8.1.0 #75 bypass 3 (mutants): a test that compares its file with the worktree's cannot read it; the mutants survive", { skip: NO_SBX }, () => {
  const x = gateFixture({ baseRunner: "import sys\nsys.exit(0)\n", treeRunner: "import sys\nsys.exit(0)\n" });
  try {
    // the judged tree's runner, with the worktree path baked in
    const spy = "import os, sys\ntry:\n    orig = open(" + JSON.stringify(join(x.wt, "pkg", "mod.py")) + ").read()\nexcept OSError:\n    sys.exit(0)\nsys.exit(0 if open('pkg/mod.py').read() == orig else 1)\n";
    put(join(x.wt, "pytest", "__main__.py"), spy);
    const idx = join(x.d, "idx2");
    const ie = Object.assign(gitEnv(x.d), { GIT_INDEX_FILE: idx });
    spawnSync(GIT, ["read-tree", "HEAD"], { cwd: x.wt, env: ie });
    spawnSync(GIT, ["add", "-A"], { cwd: x.wt, env: ie });
    const tree = spawnSync(GIT, ["write-tree"], { cwd: x.wt, env: ie, encoding: "utf8" }).stdout.trim();
    const r = prog(MUT, [x.wt, x.base, tree, "python3 -m pytest <paths>", JSON.stringify({}), JSON.stringify(["tests/test_mod.py", "pytest/__main__.py"])], { PATH: join(x.d, "agentbin") + ":" + process.env.PATH, HOME: x.hostHome, FLEET_MUTANTS_DEADLINE: "200" });
    assert.ok(r.out, r.r.stderr);
    assert.equal(r.out.status, "ran", r.out.reason);
    assert.ok(r.out.survived.length > 0);
    assert.equal(r.out.killed, 0, "no mutant was spotted through the worktree");
  } finally {
    x.done();
  }
});

// ---------------------------------------------------------------- the helper pin and the workflow

test("8.1.0 #75: cover_diff, mutants and scratch_copy pin sandbox.py's sha256; a changed helper is refused (sandbox unavailable)", { skip: !HAVE_PY }, () => {
  const sha = createHash("sha256").update(readFileSync(SBX)).digest("hex");
  for (const f of [COVER, MUT, COPY]) assert.match(readFileSync(f, "utf8"), new RegExp("\\nSANDBOX_SHA256 = '" + sha + "'\\n"), f);
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v810-pin-")));
  try {
    for (const f of ["scratch_copy.py", "sandbox.py"]) writeFileSync(join(d, f), readFileSync(join(SCRIPTS, f)));
    writeFileSync(join(d, "sandbox.py"), readFileSync(SBX, "utf8") + "\n# changed\n");
    const x = copyFixture();
    try {
      const mark = join(x.d, "marker");
      const r = prog(join(d, "scratch_copy.py"), ["sandbox-run", x.wt, x.tmp, JSON.stringify(["python3", "probe.py", "mark", mark]), "{}"]);
      assert.notEqual(r.r.status, 0);
      assert.match(r.r.stderr, /^sandbox unavailable: sandbox\.py does not hash to its pinned sha256/m);
      assert.ok(!existsSync(mark));
    } finally {
      x.done();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.1.0 #75: the held-out runner's store 'sandbox' gives held_out not_run 'sandbox unavailable: ...'; the judge sees it; the run goes on", async () => {
  const s = happy({ script: {} });
  const crit = s["role:scope-and-plan"].criteria;
  s["role:scope-and-plan"].held_out_examples = [{ criterion_id: crit[0].id, given: "g", when: "w1", then: "t1" }];
  s["role:fleet-held-out-runner:r1"] = () => ({ status: "ok", reason: "sandbox", store: "sandbox", store_digest: null, results: null });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const ho = out.result.gates_not_run.find((x) => x.gate === "held_out");
  assert.match(ho.reason, /^sandbox unavailable: /);
  assert.match(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).held_out_results.reason, /^sandbox unavailable: /);
  assert.match(SOURCE, /enum: \["ok", "missing", "mismatch", "error", "timeout", "sandbox"\]/);
});

test("8.1.0 #75: the held-out runner role runs its examples through sandbox-run and maps a sandbox refusal to store sandbox", () => {
  const role = readFileSync(join(HERE, "..", "roles", "fleet-held-out-runner.md"), "utf8");
  assert.match(role, /<scratch_copy_cmd> sandbox-run <worktree> <tmp>/);
  assert.ok(!/<scratch_copy_cmd> run <worktree>/.test(role), "no unsandboxed run of an example");
  assert.match(role, /sandbox unavailable:[^\n]*`store: "sandbox"`/);
});
