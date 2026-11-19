// ccpmcwf 8.3.2:
// - yaadgaar #101: a re-plan round that shortens a criterion with no finding naming it was a gate-log
//   line only under confirm "ask". Max's ruling: a visible result warning (criterion and round), not a
//   stop. Under "ask" the confirm_reason names it too; the default, auto and unattended paths keep
//   their stops and judge.
// - yaadgaar #103 (#96): the run lock's heartbeat is refreshed at each build-mode gate. Every hasher
//   step (one before and one after each judge) runs `parked.py beat`, which rewrites the heartbeat
//   only of a lock that holds this run's nonce; it never creates or moves a lock.
//
// dont_care: gate wording beyond the matched phrases; the order of unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ARGS, SCRIPTS_SRC, happy, run, runOne, criteria, spawnSync } from "./harness.mjs";

// ---------------------------------------------------------------- #101

const REFUSE = (finding, criterion) => ({ status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: criterion || "AC1", finding }] });
const APPROVE = { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] };
const planRound = (s, over) => Object.assign({}, s["role:scope-and-plan"], over);
const short2 = () => {
  const c = criteria(2);
  c[1].text = "beh 2";
  return c;
};

test("8.3.2 #101: a re-plan that shortens a criterion with no finding naming it yields a result warning naming the criterion and round, and the ask confirm_reason", async () => {
  const s = happy();
  s["role:plan-audit"] = REFUSE("r0", "AC1");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { criteria: short2() });
  s["role:plan-audit:audit-fix"] = APPROVE;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const w = out.result.warnings.filter((x) => x.gate === "re-plan-relaxed");
  assert.equal(w.length, 1, JSON.stringify(out.result.warnings));
  assert.equal(w[0].criterion, "AC2");
  assert.equal(w[0].round, 1);
  assert.match(w[0].reason, /^criterion AC2 text shortened with no finding naming it$/);
  assert.match(out.result.confirm_reason, /re-plan relaxed: criterion AC2 text shortened with no finding naming it/);
  // the gate-log line stays
  assert.ok(out.logs.some((l) => /re-plan relaxed round 0: criterion AC2 text shortened/.test(l)));
});

test("8.3.2 #101: a shortened criterion a finding names, and a plan with no re-plan, carry no relaxed warning and no confirm_reason", async () => {
  const s = happy();
  s["role:plan-audit"] = REFUSE("r0", "AC2");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { criteria: short2() });
  s["role:plan-audit:audit-fix"] = APPROVE;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(out.result.warnings.filter((x) => x.gate === "re-plan-relaxed"), []);
  assert.ok(!("confirm_reason" in out.result));
  const plain = await runOne(happy(), ARGS);
  assert.deepEqual(plain.result.warnings, []);
  assert.ok(!("confirm_reason" in plain.result));
});

test("8.3.2 #101: under confirm auto a relaxed re-plan still stops (the warning is added, never a pass)", async () => {
  const s = happy();
  s["role:plan-audit"] = REFUSE("r0", "AC1");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { criteria: short2() });
  s["role:plan-audit:audit-fix"] = APPROVE;
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.failed_check, "intent");
  assert.ok(out.result.warnings.some((x) => x.gate === "re-plan-relaxed" && x.criterion === "AC2"));
});

// ---------------------------------------------------------------- #103: the lock heartbeat

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const GITBIN = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const PARKED = join(SCRIPTS_SRC, "parked.py");
const ENV = { PATH: dirname(GITBIN) + ":/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().replace(/\.\d+Z$/, "Z");

function repo() {
  const root = mkdtempSync(join(tmpdir(), "fleet-832-"));
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
const prog = (file, ...a) => {
  const r = spawnSync(PY, ["-I", file].concat(a), { encoding: "utf8", env: ENV });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
};
const beatAge = (p) => Date.now() / 1000 - Date.parse(JSON.parse(readFileSync(p, "utf8")).heartbeat) / 1000;

test("8.3.2 #103: parked.py beat moves the heartbeat of this nonce's lock forward and keeps every other field; a foreign or absent lock is left as it is", () => {
  const t = repo();
  try {
    mkdirSync(t.locks, { recursive: true });
    const p = join(t.locks, "y96.json");
    const held = { nonce: "n0-live00", mode: "build", started: iso(11 * 3600), heartbeat: iso(11 * 3600), pid: "1", host: "h" };
    writeFileSync(p, JSON.stringify(held), { mode: 0o600 });
    const b = prog(PARKED, "beat", t.repo, "y96", "n0-live00");
    assert.equal(b.status, 0, b.stderr);
    assert.equal(b.out.beat, true);
    assert.deepEqual(b.out.args, [t.repo, "y96", "n0-live00"]);
    assert.match(b.out.digest, /^[0-9a-f]{64}$/);
    assert.ok(beatAge(p) < 120, "the heartbeat moved forward");
    assert.deepEqual(Object.assign(JSON.parse(readFileSync(p, "utf8")), { heartbeat: null }), Object.assign({}, held, { heartbeat: null }));
    // a foreign nonce: no write
    const before = readFileSync(p, "utf8");
    const f = prog(PARKED, "beat", t.repo, "y96", "n2-other0");
    assert.equal(f.out.beat, false);
    assert.equal(f.out.held_by.nonce, "n0-live00");
    assert.equal(readFileSync(p, "utf8"), before);
    // no lock: none is created
    const a = prog(PARKED, "beat", t.repo, "y97", "n0-live00");
    assert.equal(a.out.beat, false);
    assert.equal(a.out.absent, true);
    assert.ok(!existsSync(join(t.locks, "y97.json")));
    // a bad task id or nonce is refused
    assert.notEqual(prog(PARKED, "beat", t.repo, "../x", "n0-live00").status, 0);
    assert.notEqual(prog(PARKED, "beat", t.repo, "y96", "bad nonce").status, 0);
  } finally {
    t.done();
  }
});

test("8.3.2 #103: a hasher run with the lock's task and nonce beats; its output is the same as without them; a run with a fresh heartbeat is not judged stale", () => {
  const t = repo();
  try {
    const wt = join(t.root, "wt");
    t.git("worktree", "add", "-q", "-b", "fleet/y96-x", wt);
    const scratch = join(t.root, "scratch");
    mkdirSync(scratch);
    mkdirSync(t.locks, { recursive: true });
    const p = join(t.locks, "y96.json");
    // a long live run: started 20 h ago, last beat 11 h ago
    writeFileSync(p, JSON.stringify({ nonce: "n0-live00", mode: "build", started: iso(20 * 3600), heartbeat: iso(11 * 3600), pid: "1", host: "h" }), { mode: 0o600 });
    const hash = (...beat) => {
      const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "hasher.py"), wt, "[]", "", scratch].concat(beat), { encoding: "utf8", env: Object.assign({ HOME: t.root }, ENV) });
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      const maps = {};
      for (const [k, v] of Object.entries(o.hashes)) maps[k] = v && typeof v === "object" && typeof v.file === "string" ? readFileSync(v.file, "utf8") : v;
      return JSON.stringify({ fingerprint: o.fingerprint, maps, keys: Object.keys(o).sort() });
    };
    const plain = hash();
    assert.ok(beatAge(p) > 10 * 3600, "a hasher with no lock args does not beat");
    // gate 1
    assert.equal(hash("y96", "n0-live00"), plain);
    const b1 = JSON.parse(readFileSync(p, "utf8")).heartbeat;
    assert.ok(beatAge(p) < 120, "the heartbeat moved forward at gate 1");
    // 13 h later the run is still live: another run's claim finds it held, not stale
    const c = prog(PARKED, "claim", t.repo, "y96", "n1-aaaaaa", "plan");
    assert.equal(c.out.claimed, false);
    assert.equal(c.out.stale, null);
    assert.equal(c.out.held_by.nonce, "n0-live00");
    // gate 2: forward again (never backward)
    writeFileSync(p, JSON.stringify(Object.assign(JSON.parse(readFileSync(p, "utf8")), { heartbeat: iso(3600) })), { mode: 0o600 });
    hash("y96", "n0-live00");
    assert.ok(beatAge(p) < 120);
    assert.ok(Date.parse(JSON.parse(readFileSync(p, "utf8")).heartbeat) >= Date.parse(b1));
    // another nonce's hasher never writes the lock
    const before = readFileSync(p, "utf8");
    assert.equal(hash("y96", "n2-other0"), plain);
    assert.equal(readFileSync(p, "utf8"), before);
  } finally {
    t.done();
  }
});

test("8.3.2 #103: every build-mode hasher step carries the lock's task and nonce (a beat at each gate); plan-mode hashers carry none; agent counts do not change", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const bh = out.build.calls.filter((c) => /^hasher:/.test(c.label));
  assert.ok(bh.length >= 4, bh.map((c) => c.label).join(", "));
  for (const c of bh) assert.match(c.prompt, /hasher\.py' .* 'y42' 'n1-0000001'\n/, c.label);
  const ph = out.plan.calls.filter((c) => /^hasher:/.test(c.label));
  for (const c of ph) assert.doesNotMatch(c.prompt, /'y42' 'n1-0000001'\n/, c.label);
  // no extra agent: the beat rides in the hasher step
  assert.ok(!out.build.labels.some((l) => /^infra:run-lock:beat/.test(l)));
  assert.equal(out.build.labels.filter((l) => l === "infra:run-lock").length, 1);
});
