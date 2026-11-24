// fleet 8.0.1 (yaadgaar #76): two runs on one task shared a worktree and scratch, and the
// seal took the other run's plan doc. Three fixes:
// - a per-task run lock at <git-common-dir>/fleet/locks/<task_id>.json (parked.py claim|release);
//   plan mode claims before the branch slug, build mode before its workspace step, main()'s
//   finally releases it, and only a run that holds it releases;
// - seal 1: plan_ref_write.py refuses a doc whose sha256 is not the message's plan_sha256,
//   before mktag, update-ref, the plan-N rotation or the unlink;
// - seal 2: stage-plan must hash the doc the last approving plan-audit read (plan_dsn.py's
//   plan_sha256 at format-plan), else needs_human "plan doc changed after audit".
//
// dont_care: gate wording beyond the matched phrases; the order of unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, statSync, lstatSync, utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ARGS, PSHA, SCRIPTS_SRC, happy, run, runOne, call, inputsOf, spawnSync, sha256, lockOut } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GITBIN = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const PARKED = join(SCRIPTS_SRC, "parked.py");
const ENV = { PATH: dirname(GITBIN) + ":/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function repo() {
  const root = mkdtempSync(join(tmpdir(), "fleet-801-"));
  const r = join(root, "repo");
  const git = (...a) => {
    const x = spawnSync(GITBIN, ["-C", r].concat(a), { encoding: "utf8", env: Object.assign({ HOME: root, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, ENV) });
    assert.equal(x.status, 0, a.join(" ") + ": " + x.stderr);
    return x.stdout.trim();
  };
  mkdirSync(r);
  git("init", "-q", "-b", "main");
  writeFileSync(join(r, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, repo: r, git, locks: join(r, ".git", "fleet", "locks"), done: () => rmSync(root, { recursive: true, force: true }) };
}
const lockProg = (...a) => {
  const r = spawnSync(PY, ["-I", PARKED].concat(a), { encoding: "utf8", env: ENV });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
};

test("8.0.1 #76: claim on an empty repo writes <git-common-dir>/fleet/locks/<task>.json, mode 0600, with nonce, mode, started, pid and host", () => {
  const t = repo();
  try {
    const r = lockProg("claim", t.repo, "y41", "n1-aaaaaa", "plan");
    assert.equal(r.status, 0, r.stderr);
    const o = r.out;
    assert.equal(o.claimed, true);
    assert.equal(o.again, false);
    assert.equal(o.stale, null);
    assert.equal(o.held_by, null);
    assert.equal(o.lock, join(t.locks, "y41.json"));
    assert.deepEqual(o.args, [t.repo, "y41", "n1-aaaaaa", "plan"]);
    assert.equal(o.program.name, "parked");
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    assert.equal(statSync(o.lock).mode & 0o777, 0o600);
    const j = JSON.parse(readFileSync(o.lock, "utf8"));
    assert.equal(j.nonce, "n1-aaaaaa");
    assert.equal(j.mode, "plan");
    assert.match(j.started, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(j.pid, /^\d+$/);
    assert.equal(typeof j.host, "string");
    // the lock is outside every worktree: git status of the repo does not list it
    assert.equal(t.git("status", "--porcelain", "--untracked-files=all"), "");
  } finally {
    t.done();
  }
});

test("8.0.1 #76: a foreign lock is held (claimed false, the holder named, the file untouched); the same nonce is idempotent", () => {
  const t = repo();
  try {
    assert.equal(lockProg("claim", t.repo, "y41", "n1-aaaaaa", "plan").out.claimed, true);
    const before = readFileSync(join(t.locks, "y41.json"), "utf8");
    const f = lockProg("claim", t.repo, "y41", "n2-bbbbbb", "build");
    assert.equal(f.status, 0, f.stderr);
    assert.equal(f.out.claimed, false);
    assert.equal(f.out.held_by.nonce, "n1-aaaaaa");
    assert.equal(f.out.held_by.mode, "plan");
    assert.match(f.out.held_by.started, /Z$/);
    assert.equal(readFileSync(join(t.locks, "y41.json"), "utf8"), before);
    // confirm "auto": plan then build in one run takes one claim
    const same = lockProg("claim", t.repo, "y41", "n1-aaaaaa", "build");
    assert.equal(same.out.claimed, true);
    assert.equal(same.out.again, true);
    // 8.3.0 #96: the holder's re-claim refreshes only the heartbeat
    const after = JSON.parse(readFileSync(join(t.locks, "y41.json"), "utf8"));
    assert.deepEqual(Object.assign(after, { heartbeat: null }), Object.assign(JSON.parse(before), { heartbeat: null }));
    // another task has its own lock
    assert.equal(lockProg("claim", t.repo, "y42", "n2-bbbbbb", "plan").out.claimed, true);
  } finally {
    t.done();
  }
});

test("8.0.1 #76: a lock older than 12 h is moved to .stale-<old nonce>-<new nonce> and claimed again; a young unreadable lock is held, an old one is stale", () => {
  const t = repo();
  try {
    mkdirSync(t.locks, { recursive: true });
    const p = join(t.locks, "y41.json");
    writeFileSync(p, JSON.stringify({ nonce: "n0-old000", mode: "plan", started: "2026-01-01T00:00:00Z", pid: "1", host: "h" }), { mode: 0o600 });
    const r = lockProg("claim", t.repo, "y41", "n1-aaaaaa", "plan");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.claimed, true);
    assert.equal(r.out.stale.nonce, "n0-old000");
    assert.ok(existsSync(r.out.stale.moved_to), r.out.stale.moved_to);
    assert.equal(dirname(r.out.stale.moved_to), t.locks);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).nonce, "n1-aaaaaa");
    // a partial write (empty file) is a claim in progress: held
    writeFileSync(join(t.locks, "y42.json"), "", { mode: 0o600 });
    const y = lockProg("claim", t.repo, "y42", "n1-aaaaaa", "plan");
    assert.equal(y.out.claimed, false);
    assert.equal(y.out.held_by.nonce, null);
    // the same, 13 h old by mtime: stale
    const old = Date.now() / 1000 - 13 * 3600;
    utimesSync(join(t.locks, "y42.json"), old, old);
    const o = lockProg("claim", t.repo, "y42", "n1-aaaaaa", "plan");
    assert.equal(o.out.claimed, true);
    assert.equal(o.out.stale.nonce, null);
  } finally {
    t.done();
  }
});

test("8.0.1 #76: N parallel claims of one task: exactly one wins", async () => {
  const t = repo();
  try {
    const one = (k) =>
      new Promise((res) => {
        const c = spawn(PY, ["-I", PARKED, "claim", t.repo, "y41", "n" + k + "-par000", "plan"], { env: ENV });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("close", (code) => res({ code, out: code === 0 ? JSON.parse(out.trim()) : null }));
      });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, k) => one(k)));
    assert.ok(rs.every((r) => r.code === 0));
    const won = rs.filter((r) => r.out.claimed);
    assert.equal(won.length, 1, JSON.stringify(rs.map((r) => r.out)));
    assert.equal(JSON.parse(readFileSync(join(t.locks, "y41.json"), "utf8")).nonce, won[0].out.args[2]);
  } finally {
    t.done();
  }
});

test("8.0.1 #76: a symlink at the lock path, at locks/ or at fleet/ is refused and nothing is written through it", () => {
  const t = repo();
  try {
    const target = join(t.root, "elsewhere.json");
    mkdirSync(t.locks, { recursive: true });
    symlinkSync(target, join(t.locks, "y41.json"));
    const r = lockProg("claim", t.repo, "y41", "n1-aaaaaa", "plan");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /symlink/);
    assert.ok(!existsSync(target));
    assert.ok(lstatSync(join(t.locks, "y41.json")).isSymbolicLink());
    assert.notEqual(lockProg("release", t.repo, "y41", "n1-aaaaaa").status, 0);
    // a symlinked directory on the way
    const t2 = repo();
    try {
      const away = join(t2.root, "away");
      mkdirSync(away);
      symlinkSync(away, join(t2.repo, ".git", "fleet"));
      const s = lockProg("claim", t2.repo, "y41", "n1-aaaaaa", "plan");
      assert.notEqual(s.status, 0);
      assert.deepEqual(readdirSync(away), []);
    } finally {
      t2.done();
    }
    // a bad task id or nonce is refused before any path is built
    assert.notEqual(lockProg("claim", t.repo, "../x", "n1-aaaaaa", "plan").status, 0);
    assert.notEqual(lockProg("claim", t.repo, "y43", "bad nonce", "plan").status, 0);
    assert.notEqual(lockProg("claim", t.repo, "y43", "n1-aaaaaa", "other").status, 0);
  } finally {
    t.done();
  }
});

test("8.0.1 #76: release unlinks only its own lock; a foreign lock stays; an absent one is absent", () => {
  const t = repo();
  try {
    const p = join(t.locks, "y41.json");
    const absent = lockProg("release", t.repo, "y41", "n1-aaaaaa");
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(absent.out.released, false);
    assert.equal(absent.out.absent, true);
    lockProg("claim", t.repo, "y41", "n1-aaaaaa", "plan");
    const foreign = lockProg("release", t.repo, "y41", "n2-bbbbbb");
    assert.equal(foreign.out.released, false);
    assert.equal(foreign.out.absent, false);
    assert.equal(foreign.out.held_by.nonce, "n1-aaaaaa");
    assert.ok(existsSync(p));
    const own = lockProg("release", t.repo, "y41", "n1-aaaaaa");
    assert.equal(own.out.released, true);
    assert.deepEqual(own.out.args, [t.repo, "y41", "n1-aaaaaa"]);
    assert.match(own.out.digest, /^[0-9a-f]{64}$/);
    assert.ok(!existsSync(p));
  } finally {
    t.done();
  }
});

test("8.0.1 #76: a claim from a linked worktree lands in the main repo's common dir; the hasher's output does not change", () => {
  const t = repo();
  try {
    const wt = join(t.root, "wt");
    t.git("worktree", "add", "-q", "-b", "fleet/y41-x", wt);
    const scratch = join(t.root, "scratch");
    mkdirSync(scratch);
    const hash = () => {
      const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "hasher.py"), wt, "[]", "", scratch], { encoding: "utf8", env: Object.assign({ HOME: t.root }, ENV) });
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      const maps = {};
      for (const [k, v] of Object.entries(o.hashes)) maps[k] = v && typeof v === "object" && typeof v.file === "string" ? readFileSync(v.file, "utf8") : v;
      return JSON.stringify({ fingerprint: o.fingerprint, maps });
    };
    const before = hash();
    const r = lockProg("claim", wt, "y41", "n1-aaaaaa", "plan");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.lock, join(t.locks, "y41.json"));
    assert.equal(hash(), before, "the lock under the common dir is no worktree file, ref or hashed git file");
    assert.equal(spawnSync(GITBIN, ["-C", wt, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", env: ENV }).stdout, "");
  } finally {
    t.done();
  }
});

// ---------------------------------------------------------------- seal 1: plan_ref_write.py

function planRepo() {
  const t = repo();
  const wt = join(t.root, "main");
  t.git("worktree", "add", "-q", "-b", "fleet/t1-x", wt);
  mkdirSync(join(wt, "docs"), { recursive: true });
  const scratch = join(t.root, "scratch");
  mkdirSync(scratch);
  return Object.assign(t, { wt, scratch, base: t.git("rev-parse", "HEAD") });
}
function writeRef(rp, doc, msg, dir) {
  writeFileSync(join(rp.wt, "docs", "p.md"), doc);
  const d = join(rp.scratch, dir);
  mkdirSync(d, { recursive: true });
  const b = Buffer.from(msg).toString("base64");
  writeFileSync(join(d, "0.b64"), b);
  const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "plan_ref_write.py"), rp.wt, "t1", rp.base, "docs/p.md", d, "1", sha256(msg), JSON.stringify([{ i: 0, sha256: sha256(b) }])], { encoding: "utf8", env: Object.assign({ HOME: rp.root }, ENV) });
  return { status: r.status, stderr: r.stderr };
}
const refOf = (rp, name) => spawnSync(GITBIN, ["-C", rp.wt, "rev-parse", "-q", "--verify", name], { encoding: "utf8", env: ENV }).stdout.trim() || null;

test("8.0.1 #76 seal 1: plan_ref_write.py refuses a doc that does not hash to the message's plan_sha256; the ref, plan-N, the doc and plan/ stay as they were", () => {
  const rp = planRepo();
  try {
    const ok = writeRef(rp, "# a\n", JSON.stringify({ plan_sha256: sha256("# a\n") }) + "\n", "c1");
    assert.equal(ok.status, 0, ok.stderr);
    const tag = refOf(rp, "refs/fleet/t1/plan");
    assert.ok(tag);
    const planDir = join(rp.root, "plan");
    const kept = readFileSync(join(planDir, "docs", "p.md"), "utf8");
    // another run's bytes in the worktree doc: the audited sha in the message is not theirs
    const bad = writeRef(rp, "# b\n", JSON.stringify({ plan_sha256: sha256("# a\n") }) + "\n", "c2");
    assert.notEqual(bad.status, 0);
    assert.notEqual(bad.status, 3, "exit 3 means rewrite chunks");
    assert.match(bad.stderr, /plan_sha256/);
    assert.equal(refOf(rp, "refs/fleet/t1/plan"), tag, "the ref did not move");
    assert.equal(refOf(rp, "refs/fleet/t1/plan-1"), null, "no rotation");
    assert.equal(readFileSync(join(rp.wt, "docs", "p.md"), "utf8"), "# b\n", "the doc stays in the worktree");
    assert.equal(readFileSync(join(planDir, "docs", "p.md"), "utf8"), kept, "plan/ is untouched");
    // a message that is no JSON object with plan_sha256 is a mismatch too
    for (const m of ['{"ref":1}\n', "not json\n", JSON.stringify({ plan_sha256: 7 }) + "\n"]) {
      const x = writeRef(rp, "# b\n", m, "c3");
      assert.notEqual(x.status, 0, m);
      assert.equal(refOf(rp, "refs/fleet/t1/plan"), tag);
    }
  } finally {
    rp.done();
  }
});

// ---------------------------------------------------------------- the workflow

const held = (p) => lockOut(p, { claimed: false, held_by: { nonce: "n9-other00", mode: "plan", started: "2026-11-18T09:49:51Z", pid: "7", host: "h" } });

test("8.0.1 #76: plan mode claims the task's lock after intake and before the branch slug and the workspace; main()'s finally releases it", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const c = call(out, "infra:run-lock");
  assert.match(c.prompt, /parked\.py' 'claim' '\/r' 'y42' 'n1-0000001' 'plan'/);
  const L = out.labels;
  assert.ok(L.indexOf("intake") < L.indexOf("infra:run-lock"));
  assert.ok(L.indexOf("infra:run-lock") < L.indexOf("infra:fleet-branch"), L.join(", "));
  assert.ok(L.indexOf("infra:run-lock") < L.indexOf("workspace"));
  assert.equal(L.filter((l) => l === "infra:run-lock").length, 1);
  assert.equal(L[L.length - 1], "infra:run-lock:release", L.join(", "));
  assert.match(call(out, "infra:run-lock:release").prompt, /parked\.py' 'release' '\/r' 'y42' 'n1-0000001'/);
  assert.ok(out.logs.some((l) => /^run lock .*y42\.json released/.test(l)), out.logs.join("\n"));
});

test("8.0.1 #76: a refused claim stops needs_human naming the holder's nonce, mode, start and the path; no workspace step and no release", async () => {
  const s = happy();
  s["infra:run-lock"] = held;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /n9-other00/);
  assert.match(out.result.reason, /plan/);
  assert.match(out.result.reason, /2026-11-18T09:49:51Z/);
  assert.match(out.result.reason, /\/r\/\.git\/fleet\/locks\/y42\.json/);
  for (const l of ["infra:fleet-branch", "workspace", "infra:branch-scan", "infra:run-lock:release"]) assert.ok(!out.labels.includes(l), l + ": " + out.labels.join(", "));
  // build mode: refused before its workspace step
  const p = await runOne(happy(), ARGS);
  const b = happy();
  b["infra:run-lock"] = held;
  const bo = await runOne(b, Object.assign({}, ARGS, { mode: "build", plan_ref: p.result.plan_ref, input: undefined }));
  assert.equal(bo.result.status, "needs_human");
  assert.match(bo.result.reason, /n9-other00/);
  assert.match(call(bo, "infra:run-lock").prompt, /'claim' '\/r' 'y42' 'n1-0000001' 'build'/);
  for (const l of ["workspace", "infra:load-ref", "infra:run-lock:release"]) assert.ok(!bo.labels.includes(l), l + ": " + bo.labels.join(", "));
});

test("8.0.1 #76: a claim relay that fails its digest or arguments stops failed (and the nonce-matched release still runs)", async () => {
  for (const mut of [(r) => (r.digest = "0".repeat(64)), (r) => (r.args = ["/r", "y42", "n2-other00", "plan"])]) {
    const s = happy();
    s["infra:run-lock"] = (p) => {
      const r = lockOut(p);
      mut(r);
      return r;
    };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.match(out.result.reason, /infra:run-lock/);
    assert.ok(!out.labels.includes("workspace"));
  }
});

test("8.0.1 #76: the release runs on a halt and on a throw; under confirm auto plan and build take one claim and one release", async () => {
  // a halt after the claim (a 5.x plan commit on the branch)
  const h = happy();
  h["infra:branch-scan"] = { status: "ok", reason: "scanned", head: "b0de1234567", commits: [{ sha: "c0ffee1", subject: "plan", files: ["docs/p.md"] }], refs: [] };
  const ho = await runOne(h, ARGS);
  assert.equal(ho.result.status, "needs_human");
  assert.equal(ho.labels[ho.labels.length - 1], "infra:run-lock:release");
  // a throw after the claim
  const t = happy();
  const rel = [];
  t["infra:branch-scan"] = () => {
    throw new Error("boom");
  };
  t["infra:run-lock:release"] = (p) => {
    rel.push(p);
    return lockOut(p);
  };
  await assert.rejects(runOne(t, ARGS), /boom/);
  assert.equal(rel.length, 1);
  // confirm auto: plan, then build in the same run
  const a = await runOne(happy(), Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(a.labels.filter((l) => l === "infra:run-lock").length, 1, a.labels.join(", "));
  assert.equal(a.labels.filter((l) => l === "infra:run-lock:release").length, 1);
  // a separate build run takes its own claim and releases it
  const both = await run(happy(), ARGS);
  assert.equal(both.result.status, "ok", both.result.reason);
  assert.equal(both.build.labels.filter((l) => l === "infra:run-lock").length, 1);
  assert.equal(both.build.labels[both.build.labels.length - 1], "infra:run-lock:release");
  assert.ok(both.build.labels.indexOf("infra:run-lock") < both.build.labels.indexOf("workspace"));
});

test("8.0.1 #76 seal 2: a stage-plan sha that is not the sha the approving plan-audit read stops needs_human before any chunk writer or commit", async () => {
  const s = happy();
  s["infra:format-plan"] = (p) => {
    const i = inputsOf(p);
    return { status: "ok", reason: "formatted", changed_paths: [], dsn_check: { holds: false, lines: [], plan_sha256: "e".repeat(64), args: [i.worktree, i.plan_path] } };
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /plan doc changed after audit/);
  assert.match(out.result.reason, new RegExp(PSHA));
  assert.ok(!out.labels.some((l) => /^infra:(plan-chunks|commit-plan)/.test(l)), out.labels.join(", "));
  // a format-plan relay with no plan_sha256 fails its check
  const n = happy();
  n["infra:format-plan"] = (p) => {
    const i = inputsOf(p);
    return { status: "ok", reason: "formatted", changed_paths: [], dsn_check: { holds: false, lines: [], plan_sha256: null, args: [i.worktree, i.plan_path] } };
  };
  const no = await runOne(n, ARGS);
  assert.notEqual(no.result.status, "awaiting_confirmation");
  assert.ok(!no.labels.some((l) => /^infra:commit-plan/.test(l)));
});

test("8.0.1 #76 seal 2: plan_dsn.py prints the sha256 of the bytes it read", () => {
  const t = repo();
  try {
    writeFileSync(join(t.repo, "p.md"), "# plan\n");
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "plan_dsn.py"), t.repo, "p.md"], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).plan_sha256, sha256("# plan\n"));
  } finally {
    t.done();
  }
});

// Max (8.0.1 extra): two live runs look the same in the progress view. meta.name must be a pure
// literal, so the run's first narrator line (log) names its mode and task input, before intake.
test("8.0.1: the first narrator line names the mode and the task, before any agent", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.logs[0], "plan #42");
  const b = await runOne(happy(), Object.assign({}, ARGS, { mode: "build", plan_ref: out.result.plan_ref, input: undefined }));
  assert.equal(b.logs[0], "build refs/fleet/y42/plan");
});

// 8.3.0 #96: the stale check follows a heartbeat the run refreshes, never the helper pid
const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

test("8.3.0 #96: a lock with a dead helper pid and a fresh heartbeat is held, however old its start; the same nonce claiming again refreshes the heartbeat", () => {
  const t = repo();
  try {
    mkdirSync(t.locks, { recursive: true });
    const p = join(t.locks, "y96.json");
    writeFileSync(p, JSON.stringify({ nonce: "n0-live00", mode: "build", started: iso(20 * 3600), heartbeat: iso(60), pid: "2147483646", host: "h" }), { mode: 0o600 });
    const r = lockProg("claim", t.repo, "y96", "n1-aaaaaa", "plan");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.claimed, false);
    assert.equal(r.out.stale, null);
    assert.equal(r.out.held_by.nonce, "n0-live00");
    assert.equal(JSON.parse(readFileSync(p, "utf8")).nonce, "n0-live00");
    // the holder claiming again beats: the heartbeat moves forward
    writeFileSync(p, JSON.stringify({ nonce: "n0-live00", mode: "build", started: iso(20 * 3600), heartbeat: iso(3600), pid: "1", host: "h" }), { mode: 0o600 });
    const a = lockProg("claim", t.repo, "y96", "n0-live00", "build");
    assert.equal(a.out.again, true);
    assert.ok(Date.now() / 1000 - Date.parse(JSON.parse(readFileSync(p, "utf8")).heartbeat) / 1000 < 120);
  } finally {
    t.done();
  }
});

test("8.3.0 #96: a lock whose heartbeat is over 12 h old is stale and moved, even when its start is recent", () => {
  const t = repo();
  try {
    mkdirSync(t.locks, { recursive: true });
    const p = join(t.locks, "y96.json");
    writeFileSync(p, JSON.stringify({ nonce: "n0-dead00", mode: "build", started: iso(60), heartbeat: iso(13 * 3600), pid: "1", host: "h" }), { mode: 0o600 });
    const r = lockProg("claim", t.repo, "y96", "n1-aaaaaa", "plan");
    assert.equal(r.out.claimed, true);
    assert.equal(r.out.stale.nonce, "n0-dead00");
  } finally {
    t.done();
  }
});

test("8.3.0 #96: the lock-held reason names /workflows and the run nonce, and never says a dead session means a dead run", async () => {
  const s = happy();
  s["infra:run-lock"] = held;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /\/workflows/);
  assert.match(out.result.reason, /n9-other00/);
  assert.doesNotMatch(out.result.reason, /session is dead/);
});
