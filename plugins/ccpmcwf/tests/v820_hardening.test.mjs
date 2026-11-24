// fleet 8.2.0 (#80): low hardening of the gate sandbox (scripts/sandbox.py).
// - bwrap is trusted only when its real path is under /nix/store, or the file and its dir are root-owned
//   and not group- or other-writable; otherwise the run is refused (sandbox unavailable) and nothing runs;
// - the relay socket dir is mode 0700;
// - /var/lib is a tmpfs;
// - the git common dir: refs/fleet, logs/refs/fleet and every worktrees/<x> but the copy's own are tmpfs;
// - every bound host unix socket in /proc/net/unix (a spec's socklist in tests) the child could reach is
//   hidden: a tmpfs over its sockets-only dir, else /dev/null bound over the socket; an unreadable list
//   refuses the run ("socket list ...").
// The runtime tests run the real bwrap and skip when it is absent or fails its self-check (CI).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, existsSync, realpathSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { HERE, HAVE_PY, spawnSync } from "./harness.mjs";

const SBX = join(HERE, "..", "scripts", "sandbox.py");
const sh = (c) => spawnSync("sh", ["-c", c], { encoding: "utf8" }).stdout.trim();
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const GIT = sh("command -v git");
const BWRAP = sh("command -v bwrap");
const NO_SBX = (() => {
  if (!HAVE_PY) return "no python3";
  if (!BWRAP) return "bwrap is not on PATH (CI has none): the sandbox runtime tests skip";
  const r = spawnSync(BWRAP, ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", PY, "-I", "-S", "-c", ""], { encoding: "utf8" });
  return r.status === 0 ? false : "bwrap fails its self-check here: " + (r.stderr || "").trim();
})();
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
function sbx(mode, spec, d, env) {
  const f = join(d, "spec-" + Math.random().toString(36).slice(2) + ".json");
  writeFileSync(f, JSON.stringify(Object.assign({ result: join(d, "res.json") }, spec)));
  if (existsSync(join(d, "res.json"))) rmSync(join(d, "res.json"));
  const r = spawnSync(PY, ["-I", SBX, mode, f], { encoding: "utf8", env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME }, env || {}) });
  const res = existsSync(join(d, "res.json")) ? JSON.parse(readFileSync(join(d, "res.json"), "utf8")) : null;
  return { r, out: mode === "plan" && r.status === 0 ? JSON.parse(r.stdout) : null, res };
}
const pairs = (a, flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
// a plain (non-git) worktree dir and a work dir under one fixture root
function plainFixture() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v820-")));
  const wt = join(d, "fleet", "main");
  mkdirSync(wt, { recursive: true });
  const cwd = join(d, "cwd");
  mkdirSync(cwd);
  return { d, wt, cwd, done: () => rmSync(d, { recursive: true, force: true }) };
}
const listen = (p) =>
  new Promise((ok, no) => {
    const s = createServer(() => {});
    s.once("error", no).listen(p, () => ok(s));
  });
const UNIX = "import socket, sys\nhit = []\nfor p in sys.argv[1:]:\n    u = socket.socket(socket.AF_UNIX)\n    u.settimeout(3)\n    try:\n        u.connect(p)\n        hit.append(p)\n    except OSError as e:\n        print('unix connect failed', p, e)\nprint('UNIX', hit)\nsys.exit(5 if hit else 0)\n";

test("8.2.0 #80: the bwrap argv puts a tmpfs over /var (so /var/lib)", { skip: !HAVE_PY || !existsSync("/var/lib") }, () => {
  const x = plainFixture();
  try {
    const { r, out } = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" } }, x.d);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(out.reason, null, out.reason);
    assert.ok(pairs(out.argv, "--tmpfs").includes(realpathSync("/var")), "tmpfs /var in " + pairs(out.argv, "--tmpfs"));
  } finally {
    x.done();
  }
});

test("8.2.0 #80: git true: refs/fleet and every other worktree's admin dir are tmpfs over the read-only git dir; the copy's own stays", { skip: !HAVE_PY || !GIT }, () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fleet-v820-git-")));
  try {
    const repo = join(d, "repo");
    g(d, "init", "-q", "-b", "master", repo);
    put(join(repo, "f"), "x");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "b");
    g(repo, "update-ref", "refs/fleet/other-task/plan", "HEAD");
    const wt = join(d, "fleet-x", "main");
    g(repo, "worktree", "add", "-q", "--detach", wt);
    const copy = join(d, "fleet-x", "scratch", "copy-1");
    g(repo, "worktree", "add", "-q", "--detach", copy);
    const other = join(d, "fleet-y", "main");
    g(repo, "worktree", "add", "-q", "--detach", other);
    const gc = join(repo, ".git");
    const own = realpathSync(readFileSync(join(copy, ".git"), "utf8").replace(/^gitdir: /, "").trim());
    const { r, out } = sbx("plan", { worktree: wt, cwd: copy, copy, argv: ["true"], env: { PATH: "/usr/bin" }, git: true }, d);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(out.reason, null, out.reason);
    const a = out.argv;
    const tmpfs = pairs(a, "--tmpfs");
    const gi = a.findIndex((v, j) => v === "--ro-bind" && a[j + 1] === gc);
    assert.ok(gi >= 0, "the git dir is bound read-only");
    const after = (p) => a.findIndex((v, j) => j > gi && v === "--tmpfs" && a[j + 1] === p) > gi;
    assert.ok(after(join(gc, "refs", "fleet")), "refs/fleet is a tmpfs after the git dir bind: " + tmpfs);
    for (const n of ["main", "main1", "copy-1"].map((n) => join(gc, "worktrees", n)).filter((p) => existsSync(p) && realpathSync(p) !== own)) assert.ok(after(n), n + " is a tmpfs: " + tmpfs);
    assert.ok(!tmpfs.includes(own), "the copy's own admin dir stays: " + own);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

const LIST_HEAD = "Num       RefCount Protocol Flags    Type St Inode Path\n";
// a /proc/net/unix fixture naming these paths (plus an abstract, an unnamed and a relative one, never paths)
function socklist(d, paths) {
  const f = join(d, "unix-" + Math.random().toString(36).slice(2));
  writeFileSync(f, LIST_HEAD + "0000000000000000: 00000002 00000000 00010000 0001 01 1 @abstract\n0000000000000000: 00000002 00000000 00000000 0001 03 2\n0000000000000000: 00000002 00000000 00010000 0001 01 3 rel/s.sock\n" + paths.map((p, i) => "0000000000000000: 00000002 00000000 00010000 0001 01 " + (10 + i) + " " + p + "\n").join(""));
  return f;
}

test("8.2.0 #80: a listed host unix socket the child could reach: a tmpfs over its sockets-only dir, else /dev/null over it; a hidden one needs nothing; an unreadable list refuses", { skip: !HAVE_PY }, async () => {
  const x = plainFixture();
  const srv = join(x.d, "srv");
  const sock = join(srv, "sub", "s.sock");
  const mixed = join(srv, "mixed", "m.sock");
  const hidden = join(x.d, "fleet", "h.sock");
  for (const s of [sock, mixed, hidden]) mkdirSync(dirname(s), { recursive: true });
  writeFileSync(join(srv, "mixed", "config"), "x");
  const srvs = [await listen(sock), await listen(mixed), await listen(hidden)];
  try {
    const list = socklist(x.d, [sock, mixed, hidden]);
    const base = { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, socklist: list };
    let p = sbx("plan", Object.assign({ ro: [srv] }, base), x.d);
    assert.equal(p.r.status, 0, p.r.stderr);
    assert.equal(p.out.reason, null, p.out.reason);
    let a = p.out.argv;
    assert.ok(pairs(a, "--tmpfs").includes(dirname(sock)), "tmpfs over the sockets-only dir: " + pairs(a, "--tmpfs"));
    const nul = (q) => a.findIndex((v, j) => v === "--ro-bind" && a[j + 1] === "/dev/null" && a[j + 2] === q);
    assert.ok(nul(mixed) > a.findIndex((v, j) => v === "--ro-bind" && a[j + 1] === srv), "/dev/null over a socket in a dir with other files, after the bind of its dir");
    assert.ok(!JSON.stringify(a).includes(hidden), "a socket under a hidden dir needs nothing");
    assert.ok(!JSON.stringify(a).includes("abstract") && !JSON.stringify(a).includes("rel/s.sock"));
    p = sbx("plan", Object.assign({ ro: [dirname(sock)] }, base), x.d);
    a = p.out.argv;
    assert.ok(nul(sock) >= 0 && !pairs(a, "--tmpfs").includes(dirname(sock)), "the dir is bound back: /dev/null over the socket");
    p = sbx("plan", Object.assign({}, base, { socklist: join(x.d, "no-such-list") }), x.d);
    assert.equal(p.out.argv, null);
    assert.match(p.out.reason, /^socket list .* unreadable/);
  } finally {
    for (const s of srvs) s.close();
    x.done();
  }
});

test("8.2.0 #80: a big tree costs nothing: 30,000 files bound back, the socket deep in them is still hidden, the plan takes under 2 s", { skip: !HAVE_PY }, async () => {
  const x = plainFixture();
  const opt = join(x.d, "opt");
  for (let i = 0; i < 300; i++) {
    const dd = join(opt, "d" + i);
    mkdirSync(dd, { recursive: true });
    for (let k = 0; k < 100; k++) writeFileSync(join(dd, "f" + k), "");
  }
  const sock = join(opt, "d7", "deep", "s.sock");
  mkdirSync(dirname(sock), { recursive: true });
  const srv = await listen(sock);
  try {
    const t0 = Date.now();
    const p = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, ro: [opt] }, x.d);
    const ms = Date.now() - t0;
    assert.equal(p.out.reason, null, p.out.reason);
    assert.ok(pairs(p.out.argv, "--tmpfs").includes(dirname(sock)), "the socket (from the real /proc/net/unix) is hidden");
    assert.ok(ms < 2000, "plan took " + ms + " ms");
  } finally {
    srv.close();
    x.done();
  }
});

test("8.2.0 #80: a child cannot connect to a host unix socket in a dir bound back read-only (the control with an empty socket list can)", { skip: NO_SBX }, async () => {
  const x = plainFixture();
  const sock = join(x.d, "srv", "s.sock");
  mkdirSync(dirname(sock), { recursive: true });
  writeFileSync(join(x.d, "srv", "other"), "x");
  put(join(x.cwd, "u.py"), UNIX);
  const srv = await listen(sock);
  try {
    const spec = { worktree: x.wt, cwd: x.cwd, ro: [x.cwd, dirname(sock)], argv: [PY, "-I", join(x.cwd, "u.py"), sock], env: { PATH: process.env.PATH } };
    const c = sbx("run", Object.assign({ socklist: socklist(x.d, []) }, spec), x.d);
    assert.equal(c.res && c.res.started, true, c.r.stderr + JSON.stringify(c.res));
    assert.equal(c.res.exit, 5, "control: with the socket not listed the child reaches it");
    const r = sbx("run", spec, x.d);
    assert.equal(r.res && r.res.started, true, r.r.stderr + JSON.stringify(r.res));
    assert.equal(r.res.exit, 0, "the socket is hidden: " + r.r.stdout);
  } finally {
    srv.close();
    x.done();
  }
});

test("8.2.0 #80: a bwrap whose real path is in a dir the user can write is refused (sandbox unavailable) and nothing runs; the test hook names it exactly", { skip: !HAVE_PY }, () => {
  const x = plainFixture();
  try {
    const bin = join(x.d, "bin");
    const mark = join(x.d, "ran");
    // a pass-through bwrap: it would run the command with no sandbox
    put(join(bin, "bwrap"), "#!/bin/sh\nfd=\nwhile [ \"$#\" -gt 0 ] && [ \"$1\" != \"--\" ]; do\n  [ \"$1\" = --json-status-fd ] && fd=$2\n  shift\ndone\nshift\nif [ -n \"$fd\" ]; then eval \"printf '{\\\"child-pid\\\": 1}\\n' >&$fd; exec $fd>&-\"; fi\nexec \"$@\"\n", 0o755);
    const spec = { worktree: x.wt, cwd: x.cwd, argv: ["sh", "-c", "echo ran > " + mark], env: { PATH: process.env.PATH } };
    const env = { PATH: bin + ":" + process.env.PATH };
    const r = sbx("run", spec, x.d, env);
    assert.equal(r.res && r.res.started, false, JSON.stringify(r.res));
    assert.match(r.res.reason, /^bwrap at .* is not under \/nix\/store or in a root-owned dir others cannot write/);
    assert.ok(!existsSync(mark), "nothing ran");
    const t = sbx("run", spec, x.d, Object.assign({ FLEET_SANDBOX_TEST_BWRAP: realpathSync(join(bin, "bwrap")) }, env));
    assert.equal(t.res && t.res.started, true, JSON.stringify(t.res));
  } finally {
    x.done();
  }
});

test("8.2.0 #80: the relay socket dir is mode 0700", { skip: NO_SBX }, () => {
  const x = plainFixture();
  try {
    put(join(x.cwd, "m.py"), "import os\nprint('MODE %o' % (os.stat('/tmp/.fleet-db').st_mode & 0o777))\n");
    const spec = { worktree: x.wt, cwd: x.cwd, ro: [x.cwd], argv: [PY, "-I", join(x.cwd, "m.py")], env: { PATH: process.env.PATH, APP_TEST_DSN: "mysql://u:p@127.0.0.1:39999/fleet_x" } };
    const r = sbx("run", spec, x.d);
    assert.equal(r.res && r.res.started, true, r.r.stderr + JSON.stringify(r.res));
    assert.match(r.r.stdout, /MODE 700/);
  } finally {
    x.done();
  }
});

// 8.2.0 review (MED a): the bwrap path is resolved once; the trust check and the run use that one real path
test("8.2.0 #80 review: sandbox.py runs the resolved bwrap path it checked, never the PATH name (no swap between check and run)", { skip: !HAVE_PY }, () => {
  const x = plainFixture();
  try {
    const bin = join(x.d, "bin");
    const store = join(x.d, "store");
    put(join(store, "bwrap"), "#!/bin/sh\nfd=\nwhile [ \"$#\" -gt 0 ] && [ \"$1\" != \"--\" ]; do\n  [ \"$1\" = --json-status-fd ] && fd=$2\n  shift\ndone\nshift\nif [ -n \"$fd\" ]; then eval \"printf '{\\\"child-pid\\\": 1}\\n' >&$fd; exec $fd>&-\"; fi\nexec \"$@\"\n", 0o755);
    mkdirSync(bin);
    symlinkSync(join(store, "bwrap"), join(bin, "bwrap"));
    const spec = { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: process.env.PATH } };
    const r = sbx("run", spec, x.d, { PATH: bin + ":" + process.env.PATH, FLEET_SANDBOX_TEST_BWRAP: realpathSync(join(store, "bwrap")) });
    assert.equal(r.res && r.res.started, true, r.r.stderr + JSON.stringify(r.res));
    assert.equal(r.res.bwrap, realpathSync(join(store, "bwrap")), "the run used the checked real path: " + JSON.stringify(r.res));
  } finally {
    x.done();
  }
});

// 8.2.0 review (MED b): a socket in a dir that cannot be listed is never skipped while the child can reach it:
// /dev/null goes over the socket itself; one in a dir the child cannot enter needs nothing
test("8.2.0 #80 review: a socket in an unreadable dir: /dev/null over the socket; in a dir nobody can enter: nothing", { skip: !HAVE_PY || process.getuid() === 0 }, async () => {
  const x = plainFixture();
  const root = join(x.d, "srv");
  const u = join(root, "u");
  const shut = join(root, "shut");
  mkdirSync(u, { recursive: true });
  mkdirSync(shut);
  const s1 = join(u, "s.sock");
  const s2 = join(shut, "s.sock");
  const srvs = [await listen(s1), await listen(s2)];
  chmodSync(u, 0o311);
  chmodSync(shut, 0o200);
  try {
    const p = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, ro: [root], socklist: socklist(x.d, [s1, s2]) }, x.d);
    assert.equal(p.out.reason, null, p.out.reason);
    const a = p.out.argv;
    assert.ok(a.some((v, j) => v === "--ro-bind" && a[j + 1] === "/dev/null" && a[j + 2] === s1), "/dev/null over the socket in the unreadable dir: " + JSON.stringify(a));
    assert.ok(!pairs(a, "--tmpfs").includes(u));
    assert.ok(!JSON.stringify(a).includes(s2), "a dir the child cannot enter needs nothing");
  } finally {
    chmodSync(u, 0o755);
    chmodSync(shut, 0o755);
    for (const s of srvs) s.close();
    x.done();
  }
});

// 8.2.0 (#80, final): whole roots are a tmpfs; the visible trees are walked and every socket is masked by its
// real path. The fixture root stands for / (hide_roots and walk add fixture dirs; socklist feeds the kernel list).
async function rootFixture() {
  const x = plainFixture();
  const R = join(x.d, "R");
  const socks = {};
  for (const [k, p] of [["var", "var/lib/c/s.sock"], ["srv", "srv/s.sock"], ["opt", "opt/t/s.sock"]]) {
    socks[k] = join(R, p);
    mkdirSync(dirname(socks[k]), { recursive: true });
  }
  const srvs = [];
  for (const k of Object.keys(socks)) srvs.push(await listen(socks[k]));
  return Object.assign(x, { R, socks, close: () => srvs.forEach((s) => s.close()) });
}
const WHOLE_FIX = (R) => ["var", "srv", "opt"].map((n) => join(R, n));

test("8.2.0 #80 final: a socket under the fixture root's /var, /srv or /opt: each root is a tmpfs after the bind of the root above it", { skip: !HAVE_PY }, async () => {
  const x = await rootFixture();
  try {
    const p = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, ro: [x.R], hide_roots: WHOLE_FIX(x.R), socklist: socklist(x.d, []) }, x.d);
    assert.equal(p.out.reason, null, p.out.reason);
    const a = p.out.argv;
    const bi = a.findIndex((v, j) => v === "--ro-bind" && a[j + 1] === x.R);
    for (const h of WHOLE_FIX(x.R)) assert.ok(a.findIndex((v, j) => j > bi && v === "--tmpfs" && a[j + 1] === h) > bi, h + " is a tmpfs after the bind of " + x.R);
  } finally {
    x.close();
    x.done();
  }
});

test("8.2.0 #80 final: a child cannot reach a socket under the fixture root's /var, /srv or /opt (the control without the roots can)", { skip: NO_SBX }, async () => {
  const x = await rootFixture();
  put(join(x.cwd, "u.py"), UNIX);
  try {
    const spec = { worktree: x.wt, cwd: x.cwd, ro: [x.cwd, x.R], argv: [PY, "-I", join(x.cwd, "u.py")].concat(Object.values(x.socks)), env: { PATH: process.env.PATH }, socklist: socklist(x.d, []) };
    const c = sbx("run", spec, x.d);
    assert.equal(c.res && c.res.exit, 5, "control: " + c.r.stdout + JSON.stringify(c.res));
    const r = sbx("run", Object.assign({ hide_roots: WHOLE_FIX(x.R) }, spec), x.d);
    assert.equal(r.res && r.res.exit, 0, "every socket is hidden: " + r.r.stdout + JSON.stringify(r.res));
  } finally {
    x.close();
    x.done();
  }
});

test("8.2.0 #80 final: a socket file renamed after its bind (the kernel list names the old path) is masked by the walk", { skip: !HAVE_PY }, async () => {
  const x = plainFixture();
  const v = join(x.d, "etc");
  mkdirSync(v);
  writeFileSync(join(v, "conf"), "x");
  const old = join(v, "a.sock");
  const srv = await listen(old);
  const moved = join(v, "b.sock");
  spawnSync("mv", [old, moved]);
  put(join(x.cwd, "u.py"), UNIX);
  try {
    const spec = { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: process.env.PATH }, ro: [x.cwd, v], socklist: socklist(x.d, [old]), walk: [v] };
    const p = sbx("plan", spec, x.d);
    assert.equal(p.out.reason, null, p.out.reason);
    const a = p.out.argv;
    assert.ok(a.some((q, j) => q === "--ro-bind" && a[j + 1] === "/dev/null" && a[j + 2] === moved), "/dev/null over the renamed socket: " + JSON.stringify(a));
    if (!NO_SBX) {
      const r = sbx("run", Object.assign({}, spec, { argv: [PY, "-I", join(x.cwd, "u.py"), moved] }), x.d);
      assert.equal(r.res && r.res.exit, 0, "the renamed socket is hidden: " + r.r.stdout + JSON.stringify(r.res));
    }
  } finally {
    srv.close();
    x.done();
  }
});

test("8.2.0 #80 final: a socket listed through a symlinked dir is masked at its real path", { skip: !HAVE_PY }, async () => {
  const x = plainFixture();
  const v = join(x.d, "vis");
  const realDir = join(v, "real");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, "conf"), "x");
  symlinkSync(realDir, join(v, "link"));
  const srv = await listen(join(realDir, "s.sock"));
  try {
    const p = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, ro: [v], socklist: socklist(x.d, [join(v, "link", "s.sock")]) }, x.d);
    assert.equal(p.out.reason, null, p.out.reason);
    const a = p.out.argv;
    assert.ok(a.some((q, j) => q === "--ro-bind" && a[j + 1] === "/dev/null" && a[j + 2] === join(realDir, "s.sock")), "masked at the real path: " + JSON.stringify(a));
    assert.ok(!JSON.stringify(a).includes(join(v, "link", "s.sock")), "never the symlinked path");
  } finally {
    srv.close();
    x.done();
  }
});

test("8.2.0 #80 final: a hidden root is never walked: 60,000 files under the fixture /opt (over the walk cap) cost nothing", { skip: !HAVE_PY }, () => {
  const x = plainFixture();
  const R = join(x.d, "R");
  const opt = join(R, "opt");
  for (let i = 0; i < 600; i++) {
    const dd = join(opt, "d" + i);
    mkdirSync(dd, { recursive: true });
    for (let k = 0; k < 100; k++) writeFileSync(join(dd, "f" + k), "");
  }
  try {
    const t0 = Date.now();
    const p = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, hide_roots: [opt], walk: [R], socklist: socklist(x.d, []) }, x.d);
    const ms = Date.now() - t0;
    assert.equal(p.out.reason, null, p.out.reason);
    assert.ok(pairs(p.out.argv, "--tmpfs").includes(opt));
    assert.ok(ms < 2000, "plan took " + ms + " ms");
    const w = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, walk: [R], socklist: socklist(x.d, []) }, x.d);
    assert.match(w.out.reason, /^socket walk over its entry cap/, "control: a walked /opt this big refuses");
  } finally {
    x.done();
  }
});

test("8.9.1 #115: a busy host never refuses the socket walk: the time cap counts CPU, not wall clock", { skip: !HAVE_PY }, async () => {
  const x = plainFixture();
  const R = join(x.d, "R");
  // 20,000 entries: well under the entry cap, a fraction of a second of CPU
  for (let i = 0; i < 200; i++) {
    const dd = join(R, "d" + i);
    mkdirSync(dd, { recursive: true });
    for (let k = 0; k < 99; k++) writeFileSync(join(dd, "f" + k), "");
  }
  const f = join(x.d, "spec.json");
  writeFileSync(f, JSON.stringify({ result: join(x.d, "res.json"), worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, walk: [R], socklist: socklist(x.d, []) }));
  try {
    // the CI runner: the plan process gets about 2% of a CPU (5 ms run, 245 ms stopped), so the walk takes
    // far more than 3 s of wall clock and the same CPU time as on an idle host
    const t0 = Date.now();
    const c = spawn(PY, ["-I", SBX, "plan", f], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    let out = "";
    c.stdout.on("data", (b) => (out += b));
    let live = true;
    const done = new Promise((ok) => c.on("exit", (code) => ((live = false), ok(code))));
    (async () => {
      while (live) {
        await delay(5);
        if (live) c.kill("SIGSTOP");
        await delay(245);
        if (live) c.kill("SIGCONT");
      }
    })();
    const code = await done;
    const ms = Date.now() - t0;
    assert.equal(code, 0);
    assert.ok(ms > 3500, "the throttle held the plan back: " + ms + " ms");
    assert.equal(JSON.parse(out).reason, null, "plan took " + ms + " ms wall");
  } finally {
    x.done();
  }
});

test("8.9.1 #115: a cap hit names the cap and what it measured", { skip: !HAVE_PY }, () => {
  const x = plainFixture();
  const R = join(x.d, "R");
  for (let i = 0; i < 520; i++) {
    const dd = join(R, "d" + i);
    mkdirSync(dd, { recursive: true });
    for (let k = 0; k < 99; k++) writeFileSync(join(dd, "f" + k), "");
  }
  try {
    const w = sbx("plan", { worktree: x.wt, cwd: x.cwd, argv: ["true"], env: { PATH: "/usr/bin" }, walk: [R], socklist: socklist(x.d, []) }, x.d);
    assert.match(w.out.reason, /^socket walk over its entry cap \(more than 50000 entries, after [0-9.]+ s CPU\)$/);
  } finally {
    x.done();
  }
});
