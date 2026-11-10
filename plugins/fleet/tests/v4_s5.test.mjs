// fleet 4.0.0 stream S5 (build loop and DB): the short path (ledger 1991,
// one writer split per criterion), the frozen resume (ledger 1987) and the
// throwaway test DB (ledger 1981).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as rawSpawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mapView, ignoredView, buildAssignsRe, roleTestEnv, buildEnvSites } from "./harness.mjs";
import {
  ARGS,
  PC,
  HASHES,
  H,
  HASHES_FLAT,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  sha256,
  canon,
  gitEnv,
  SCRIPTS_SRC,
  scratchRepo,
  runHasherRaw,
  sh,
} from "./harness.mjs";

// ---------------------------------------------------------------- short path (1991)

// A small, no-new-behaviour plan: est_diff_lines < 20 and new_behaviour false.
function shortScript(writer, more) {
  const s = happy({ script: more || {} });
  s["role:scope-and-plan"].est_diff_lines = 10;
  s["role:scope-and-plan"].new_behaviour = false;
  delete s["role:fleet-test-writer:AC1:r1"];
  delete s["role:fleet-test-writer:AC2:r1"];
  s["role:fleet-test-writer:short:r1"] = writer || {
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [
      { name: "test_a1", covers: "AC1: behaviour 1" },
      { name: "test_b1", covers: "AC2: behaviour 2" },
      { name: "test_a2", covers: "AC1: edge" },
    ],
    files: ["tests/test_a.py", "tests/test_b.py"],
  };
  return s;
}

test("AC-1991-5: the short path runs one writer for every criterion and splits its tests by the covers prefix", async () => {
  const out = await run(shortScript(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.path, "short");
  assert.equal(out.labels.filter((l) => /^role:fleet-test-writer:/.test(l)).length, 1, out.labels.join(", "));
  assert.ok(out.labels.includes("role:fleet-test-writer:short:r1"));
  // every gate stays: plan-audit, the test judge, the freeze, the code judge
  for (const l of ["role:plan-audit", "role:fleet-test-judge:r1", "hasher:freeze:f1", "role:fleet-code-judge:r1"]) assert.ok(out.labels.includes(l), l);
  const w = inputsOf(call(out, "role:fleet-test-writer:short:r1").prompt);
  assert.deepEqual(w.criteria.map((c) => c.id), ["AC1", "AC2"]);
  assert.deepEqual(w.test_files, ["tests/test_a.py", "tests/test_b.py"]);
  // per-criterion writer outputs for the judge
  const tj = inputsOf(call(out, "role:fleet-test-judge:r1").prompt);
  const ac1 = tj.writer_outputs.find((x) => x.criterion_id === "AC1");
  const ac2 = tj.writer_outputs.find((x) => x.criterion_id === "AC2");
  assert.deepEqual(ac1.tests.map((t) => t.name), ["test_a1", "test_a2"]);
  assert.deepEqual(ac2.tests.map((t) => t.name), ["test_b1"]);
  assert.deepEqual(ac1.files, ["tests/test_a.py"]);
  assert.deepEqual(ac2.files, ["tests/test_b.py"]);
  assert.ok(out.result.gate_log.some((g) => /short path: one writer/.test(g)), out.result.gate_log.join("\n"));
});

for (const [name, covers] of [
  ["an unknown criterion", "AC9: x"],
  ["a longer id with a pending prefix", "AC10: x"],
  ["no colon", "AC1 x"],
]) {
  test("AC-1991-5: a test whose covers prefix names " + name + " halts ownership", async () => {
    const s = shortScript({
      status: "ok",
      reason: "red",
      criterion_id: "short",
      tests: [{ name: "a", covers: "AC1: x" }, { name: "b", covers: "AC2: y" }, { name: "c", covers }],
      files: ["tests/test_a.py", "tests/test_b.py"],
    });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "ownership");
    assert.match(out.result.reason, /covers/);
    assert.ok(!out.labels.includes("role:fleet-test-judge:r1"));
  });
}

test("1991 short path: a test with no covers string halts ownership", async () => {
  const s = shortScript({
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [{ name: "a", covers: "AC1: x" }, { name: "b" }],
    files: ["tests/test_a.py"],
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /covers/);
});

test("1991 short path: a reported file outside every pending criterion halts ownership", async () => {
  const s = shortScript({
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [{ name: "a", covers: "AC1: x" }, { name: "b", covers: "AC2: y" }],
    files: ["tests/test_a.py", "tests/test_b.py", "src/x.py"],
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /src\/x\.py/);
});

test("1991 short path: at most MAX_SHORT_TEST_ROUNDS (2) test rounds, each with one writer", async () => {
  const revise = (cid) => ({ status: "ok", reason: "weak", verdict: "revise", routed_findings: [{ target: "tests", criterion: cid, finding: "weak" }], checked: [] });
  const s = shortScript(null, {
    "role:fleet-test-judge:r1": revise("AC2"),
    "role:fleet-test-judge:r2": revise("AC2"),
    "role:fleet-test-judge:r3": revise("AC2"),
    "hasher:post-writers:r2": { status: "ok", fingerprint: { head: "abc1234def0", tree: "T2" }, changed: ["tests/test_b.py"] },
    "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: { head: "abc1234def0", tree: "T2" } },
  });
  s["role:fleet-test-writer:short:r2"] = { status: "ok", reason: "red", criterion_id: "short", tests: [{ name: "b", covers: "AC2: y" }], files: ["tests/test_b.py"] };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "cap");
  assert.match(out.result.reason, /test rounds exhausted \(2\)/);
  assert.ok(!out.labels.includes("role:fleet-test-writer:short:r3"));
  // round 2 rewrites only the routed criterion
  const w2 = inputsOf(call(out, "role:fleet-test-writer:short:r2").prompt);
  assert.deepEqual(w2.criteria.map((c) => c.id), ["AC2"]);
});

test("1991 short path: a drifting writer retries once as <label>:retry after the round", async () => {
  const s = shortScript({ __raw: true, status: "ok", reason: "x", criterion_id: "short", tests: [] });
  s["role:fleet-test-writer:short:r1:retry"] = {
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [{ name: "a", covers: "AC1: x" }, { name: "b", covers: "AC2: y" }],
    files: ["tests/test_a.py", "tests/test_b.py"],
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const i = out.labels.indexOf("role:fleet-test-writer:short:r1:retry");
  assert.ok(i > 0, out.labels.join(", "));
  assert.equal(out.labels[i - 1], "infra:path-check:fleet-test-writer:short:r1:retry");
});

test("1991: a full-path plan keeps one writer per criterion", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.path, "full");
  assert.ok(out.labels.includes("role:fleet-test-writer:AC1:r1"));
  assert.ok(out.labels.includes("role:fleet-test-writer:AC2:r1"));
  assert.ok(!out.labels.some((l) => /:short:/.test(l)));
});

// ---------------------------------------------------------------- frozen resume (1987)

const HEX64 = /^[0-9a-f]{64}$/;
function mapsDigestOf(h) {
  const o = {};
  // 5.0.7 (ledger 2020): the script keeps each map's digest and count, and
  // the inline keys (5.0.5: ignored only)
  for (const m of ["files", "sections", "git", "symlinks", "ignored"]) o[m] = mapView(m, h[m] || {});
  for (const k of Object.keys(o.git)) if (k.startsWith("fleetref:")) delete o.git[k];
  return sha256(canon(o));
}
const freezeRefOf = (planRef) => planRef.plan_ref.replace(/\/plan$/, "/freeze");
function buildArgsOf(planRef, over) {
  const b = Object.assign({}, ARGS, { mode: "build", plan_ref: planRef }, over || {});
  delete b.input;
  return b;
}
// A build whose coder stops after the freeze, with the plan run before it.
async function coderStop() {
  const s = happy({ script: { "role:fleet-coder:r1": { status: "needs_human", reason: "coder stuck" } } });
  const out = await run(s, ARGS);
  return { s, out, planRef: out.planResult.plan_ref };
}
// The resume run's worktree as the frozen hasher reads it.
function frozenState(planRef, over) {
  const o = Object.assign({ tree: "T1", flat: HASHES_FLAT, ref: "T1", head: PC }, over || {});
  const h = H(o.flat);
  if (o.ref !== null) h.git["fleetref:" + freezeRefOf(planRef)] = o.ref;
  return { status: "ok", fingerprint: { head: o.head, tree: o.tree }, hashes: h };
}

test("1987: each freeze writes refs/fleet/<id>/freeze to the freeze tree, with hooks off and no commit", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = call(out, "infra:freeze-ref:f1");
  const i = inputsOf(c.prompt);
  assert.equal(i.ref, freezeRefOf(out.planResult.plan_ref));
  assert.equal(i.tree, "T1");
  assert.match(c.prompt, /core\.hooksPath=\/dev\/null update-ref/);
  assert.ok(!/git commit|commit -m/.test(c.prompt));
  assert.ok(out.labels.indexOf("infra:freeze-ref:f1") > out.labels.indexOf("hasher:freeze:f1"));
  assert.ok(out.labels.indexOf("infra:freeze-ref:f1") < out.labels.indexOf("role:fleet-coder:r1"));
});

test("1987: a freeze-ref write that lands elsewhere halts", async () => {
  const s = happy({ script: { "infra:freeze-ref:f1": { status: "ok", reason: "written", ref_target: "T9" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /freeze ref/);
  assert.ok(!out.labels.includes("role:fleet-coder:r1"));
});

test("AC-1987-1: a coder stop returns a 64-hex freeze_digest over the ref sha256, the freeze tree and the maps", async () => {
  const { out, planRef } = await coderStop();
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.freeze_digest, HEX64);
  assert.equal(out.result.freeze_digest, sha256(canon({ ref_sha256: planRef.ref_sha256, tree: "T1", mapsDigest: mapsDigestOf(HASHES) })));
  assert.deepEqual(out.result.plan_ref, planRef);
  // a stop before the freeze carries none
  const early = await run(happy({ script: { "role:fleet-test-judge:r1": { status: "needs_human", reason: "x" } } }), ARGS);
  assert.equal(early.result.status, "needs_human");
  assert.equal(early.result.freeze_digest, undefined);
});

test("AC-1987-2: a re-run with the freeze_digest and the frozen tree resumes at the coder", async () => {
  const { s, out, planRef } = await coderStop();
  s["role:fleet-coder:r1"] = happy()["role:fleet-coder:r1"];
  s["hasher:resume-frozen"] = frozenState(planRef);
  const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: out.result.freeze_digest }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "frozen");
  assert.ok(!r.labels.some((l) => /^role:fleet-test-(writer|judge)/.test(l)), r.labels.join(", "));
  assert.ok(!r.labels.includes("infra:freeze-ref:f1"));
  assert.ok(r.labels.includes("role:fleet-coder:r1"));
  assert.ok(r.labels.includes("role:fleet-code-judge:r1"));
  // the workspace step allows the frozen worktree's dirty paths
  assert.equal(inputsOf(call(r, "workspace").prompt).frozen_resume, true);
  // bytecode is purged before the frozen state is read
  const pi = r.labels.indexOf("infra:purge-bytecode:resume-frozen");
  assert.ok(pi >= 0 && pi < r.labels.indexOf("hasher:resume-frozen"), r.labels.join(", "));
  // the coder gets the frozen tree
  assert.equal(inputsOf(call(r, "role:fleet-coder:r1").prompt).freeze_tree, "T1");
});

for (const [name, over] of [
  ["one test file edited (another tree, another hash)", { tree: "T9", ref: "T1", flat: Object.assign({}, HASHES_FLAT, { "tests/test_a.py": "hX" }) }],
  ["the maps changed under the same tree", { flat: Object.assign({}, HASHES_FLAT, { "tests/test_b.py": "hX" }) }],
  ["coder edits in the worktree (tree != freeze tree)", { tree: "K1" }],
  ["no freeze ref", { ref: null }],
  ["a freeze ref at another tree", { ref: "T7" }],
  ["HEAD moved off the plan commit", { head: "d".repeat(40) }],
]) {
  test("AC-1987-3/4: frozen resume with " + name + " halts resume", async () => {
    const { s, out, planRef } = await coderStop();
    s["hasher:resume-frozen"] = frozenState(planRef, over);
    const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: out.result.freeze_digest }));
    assert.equal(r.result.status, "needs_human");
    assert.equal(r.result.stop_gate, "resume");
    assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
  });
}

test("AC-1987-3: another digest on the frozen tree halts resume", async () => {
  const { s, planRef } = await coderStop();
  s["hasher:resume-frozen"] = frozenState(planRef);
  const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: "0".repeat(64) }));
  assert.equal(r.result.stop_gate, "resume");
  assert.match(r.result.reason, /freeze_digest/);
});

test("AC-1987-4: no digest keeps the clean-worktree workspace rule", async () => {
  const { s, planRef } = await coderStop();
  const r = await runOne(s, buildArgsOf(planRef));
  assert.equal(inputsOf(call(r, "workspace").prompt).frozen_resume, undefined);
  assert.match(call(r, "workspace").prompt, /status --porcelain` must be empty/);
  assert.ok(!r.labels.includes("hasher:resume-frozen"));
});

test("1987: a malformed freeze_digest stops before any agent", async () => {
  const { planRef } = await coderStop();
  const r = await runOne(happy(), buildArgsOf(planRef, { freeze_digest: "abc" }));
  assert.equal(r.result.status, "needs_human");
  assert.match(r.result.reason, /freeze_digest/);
  assert.deepEqual(r.labels, []);
});

test("AC-1987-5: no prompt asks for a commit before the code judge approves", async () => {
  const { s, out, planRef } = await coderStop();
  s["role:fleet-coder:r1"] = happy()["role:fleet-coder:r1"];
  s["hasher:resume-frozen"] = frozenState(planRef);
  const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: out.result.freeze_digest }));
  for (const o of [out.build, r]) {
    const j = o.labels.indexOf("role:fleet-code-judge:r1");
    const upto = j < 0 ? o.calls : o.calls.slice(0, j);
    for (const c of upto) assert.ok(!/git commit|commit -m/.test(c.prompt), c.label);
  }
});

// ---------------------------------------------------------------- throwaway test DB (1981)

const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
// a role's own user, granted on its own database only: never root
const DSN_RE = /^mysql:\/\/(fleet_[a-z0-9_]+):[0-9a-f]{32}@127\.0\.0\.1:[0-9]+\/\1$/;
// the read steps relay a declaration (the program's output; the harness adds the self-hash)
function withDecl(s, decl, over) {
  const td = (prompt) => Object.assign({ decl: decl === undefined ? DECL : decl, error: null, args: [inputsOf(prompt).main_worktree, inputsOf(prompt).default_branch] }, over || {});
  const bs = s["infra:branch-scan"];
  const vp = s["infra:verify-plan"];
  s["infra:branch-scan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(bs)), { test_db: td(prompt) });
  s["infra:verify-plan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(vp)), { test_db: td(prompt) });
  return s;
}
const dsnOf = (out, label) => inputsOf(call(out, label).prompt).test_env.YADGAR_TEST_DSN;

test("AC-1981-1: with a declaration the database is up before the planner; every role gets its own database", async () => {
  const out = await run(withDecl(happy()), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const pl = out.plan.labels;
  assert.ok(pl.indexOf("infra:db-up") >= 0 && pl.indexOf("infra:db-up") < pl.indexOf("role:scope-and-plan"), pl.join(", "));
  assert.equal(pl[pl.indexOf("infra:db-up") - 1], "infra:path-check:db-up");
  const up = inputsOf(call(out, "infra:db-up").prompt);
  assert.match(up.name, /^fleet-db-[a-z0-9-]+$/);
  assert.ok(!/tf-local/.test(up.name));
  assert.match(up.image, /^docker\.io\/library\/mariadb@sha256:[0-9a-f]{64}$/);
  assert.equal(up.ttl, 21600);
  assert.match(call(out, "infra:db-up").prompt, /db_sweep\.py/);
  // one database per consumer, the DSN built by the script
  const dsns = {
    plan: dsnOf(out.plan, "role:scope-and-plan"),
    audit: dsnOf(out.plan, "role:plan-audit"),
    w1: dsnOf(out.build, "role:fleet-test-writer:AC1:r1"),
    w2: dsnOf(out.build, "role:fleet-test-writer:AC2:r1"),
    tj: dsnOf(out.build, "role:fleet-test-judge:r1"),
    coder: dsnOf(out.build, "role:fleet-coder:r1"),
    cj: dsnOf(out.build, "role:fleet-code-judge:r1"),
    review: dsnOf(out.build, "role:pr-review:v1"),
  };
  for (const [k, v] of Object.entries(dsns)) assert.match(v, DSN_RE, k);
  assert.match(dsns.w1, /\/fleet_w_ac1$/);
  assert.match(dsns.w2, /\/fleet_w_ac2$/);
  assert.equal(new Set(Object.values(dsns).map((d) => d.split("/").pop())).size, Object.keys(dsns).length, JSON.stringify(dsns));
  // TEST_ENV is not changed in place: a writer sees only its own DSN
  const w1env = inputsOf(call(out.build, "role:fleet-test-writer:AC1:r1").prompt).test_env;
  assert.equal(w1env.PYTHONDONTWRITEBYTECODE, "1");
  assert.ok(!JSON.stringify(w1env).includes("fleet_w_ac2"));
  // the repo's hooks get their own database in the commit step and the push
  // 5.0.6 (ledger 2019): after the build vars of the step's own dir
  assert.match(call(out.build, "infra:commit:r1").prompt, new RegExp("env GIT_CONFIG_NOSYSTEM=1 PYTHONDONTWRITEBYTECODE=1 " + buildAssignsRe("commit-r1") + " YADGAR_TEST_DSN='mysql:\\/\\/fleet_hooks:[0-9a-f]{32}@127\\.0\\.0\\.1:40000\\/fleet_hooks' git "));
  assert.match(call(out.build, "infra:push").prompt, new RegExp("`env " + buildAssignsRe("push") + " YADGAR_TEST_DSN='mysql:\\/\\/[^']+\\/fleet_hooks' git -C <main_worktree> push -u origin <branch>`"));
  // each run removes its own database at the end
  assert.equal(out.plan.labels[out.plan.labels.length - 1], "infra:db-down");
  assert.equal(out.build.labels[out.build.labels.length - 1], "infra:db-down");
  assert.ok(out.result.gate_log.some((g) => /test database fleet-db-.* removed/.test(g)));
  // no prompt carries a root DSN; the root password is in no prompt (the program keeps it in the container)
  for (const c of out.calls) {
    assert.ok(!/root:/.test(c.prompt), c.label + " holds root:");
    assert.ok(!/MARIADB_ROOT_PASSWORD/.test(c.prompt), c.label);
  }
  // never sealed: the plan ref holds no DSN
  const s2 = withDecl(happy());
  const o2 = await run(s2, ARGS);
  assert.ok(!JSON.stringify(s2.__store).includes("mysql://"));
  assert.ok(!JSON.stringify(o2.planResult.plan_ref).includes("mysql://"));
  // 5.0.6 (ledger 2019): with a database each role keeps its build dir too
  assert.equal(buildEnvSites(out), 8);
});

test("1981: no declaration starts no database and changes no role input", async () => {
  const out = await run(happy(), ARGS);
  assert.ok(!out.labels.some((l) => /db-(up|down)/.test(l)), out.labels.join(", "));
  assert.equal(inputsOf(call(out, "role:scope-and-plan").prompt).test_env, undefined);
  // 5.0.6 (ledger 2019): the build vars of the role's own dir, never a DSN
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r1").prompt).test_env, roleTestEnv("coder-r1"));
  assert.match(call(out.build, "infra:commit:r1").prompt, new RegExp("env GIT_CONFIG_NOSYSTEM=1 PYTHONDONTWRITEBYTECODE=1 " + buildAssignsRe("commit-r1") + " git "));
});

test("AC-1981-2: a coder halt still removes the database, and the halt reason stays", async () => {
  const s = withDecl(happy({ script: { "role:fleet-coder:r1": { status: "needs_human", reason: "coder stuck" } } }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /coder stuck/);
  assert.equal(out.build.labels[out.build.labels.length - 1], "infra:db-down");
  const d = inputsOf(call(out.build, "infra:db-down").prompt);
  assert.equal(d.name, inputsOf(call(out.build, "infra:db-up").prompt).name);
});

test("1981: a failed teardown never replaces the result", async () => {
  const s = withDecl(happy({ script: { "infra:db-down": { status: "failed", reason: "podman gone" } } }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.some((g) => /not confirmed removed.*ends by itself/.test(g)), out.result.gate_log.join("\n"));
});

for (const [name, decl] of [
  ["env PATH", Object.assign({}, DECL, { env: "PATH" })],
  ["an extra key", Object.assign({}, DECL, { host: "db.example" })],
  ["engine postgres", Object.assign({}, DECL, { engine: "postgres" })],
  ["a major with no pinned image", Object.assign({}, DECL, { major: "10.6" })],
]) {
  test("AC-1981-3: a declaration with " + name + " halts before any role", async () => {
    const out = await run(withDecl(happy(), decl), ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "db");
    assert.match(out.result.reason, /\.fleet-test-db\.json/);
    assert.ok(!out.labels.some((l) => /^role:|db-up/.test(l)), out.labels.join(", "));
  });
}

test("AC-1981-3: a declaration error from the program halts", async () => {
  const out = await run(withDecl(happy(), null, { error: "env must match" }), ARGS);
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /refused: env must match/);
});

test("AC-1981-4: a diff that touches .fleet-test-db.json halts scope", async () => {
  const s = withDecl(happy());
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: { head: "abc1234def0", tree: "K1" }, hashes: HASHES, changed: ["src/x.py", ".fleet-test-db.json"] };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "scope");
  assert.match(out.result.reason, /\.fleet-test-db\.json/);
});

test("AC-1981-5: a declaration relay with a bad digest halts", async () => {
  const out = await run(withDecl(happy(), DECL, { digest: "0".repeat(64) }), ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /does not match the program's digest/);
  assert.ok(!out.labels.includes("infra:db-up"));
  // the read ran on other arguments
  const o2 = await run(withDecl(happy(), DECL, { args: ["/elsewhere", "master"] }), ARGS);
  assert.equal(o2.result.stop_gate, "db");
});

test("AC-1981-7: a db-up that started nothing (no expiry mechanism) halts; nothing to remove", async () => {
  const s = withDecl(happy({ script: { "infra:db-up": { status: "needs_human", reason: "no expiry mechanism (podman run --timeout or systemd-run): no container started" } } }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /no expiry mechanism/);
  assert.ok(!out.labels.includes("role:scope-and-plan"));
  // the teardown still runs on the name (db_down finds nothing: absent)
  assert.equal(out.labels[out.labels.length - 1], "infra:db-down");
});

for (const [name, mut] of [
  ["another container name", (u) => Object.assign(u, { name: "fleet-db-other" })],
  ["a port that is not a number", (u) => Object.assign(u, { port: "3306" })],
  ["no expiry", (u) => Object.assign(u, { expiry: null })],
  ["a missing user", (u) => Object.assign(u, { users: { fleet_plan: "b".repeat(32) } })],
  ["a root user", (u) => Object.assign(u, { users: Object.assign({}, u.users, { root: "b".repeat(32) }) })],
  ["a short password", (u) => Object.assign(u, { users: Object.assign({}, u.users, { fleet_plan: "abc" }) })],
]) {
  test("1981: a db-up relay with " + name + " halts", async () => {
    const s = withDecl(happy());
    s["infra:db-up"] = (prompt) => {
      const i = inputsOf(prompt);
      const up = mut({ name: i.name, port: 40000, dbs: i.dbs, users: Object.fromEntries(i.dbs.map((d) => [d, "b".repeat(32)])), expiry: { mechanism: "podman-timeout", expires: 1 }, args: ["up", i.name, i.image, String(i.ttl), i.nonce, JSON.stringify(i.dbs)] });
      return { status: "ok", reason: "up", up };
    };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed");
    assert.equal(out.result.stop_gate, "db");
    assert.ok(!out.labels.includes("role:scope-and-plan"));
    // a started container never outlives a relay stop
    assert.equal(out.labels[out.labels.length - 1], "infra:db-down");
  });
}

test("1981: confirm auto continues into the build and adds the build's databases to the same container", async () => {
  const s = withDecl(happy());
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [],
      coverage: { covered: true, missing: [] },
      classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
  });
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "infra:db-up").length, 1);
  const add = out.labels.indexOf("infra:db-up:add");
  assert.ok(add > out.labels.indexOf("infra:verify-plan"), out.labels.join(", "));
  assert.equal(out.labels[add - 1], "infra:path-check:db-up:add");
  assert.deepEqual(inputsOf(call(out, "infra:db-up:add").prompt).dbs, ["fleet_w_ac1", "fleet_w_ac2", "fleet_tjudge", "fleet_coder", "fleet_cjudge", "fleet_review", "fleet_hooks"]);
  assert.match(dsnOf(out, "role:fleet-coder:r1"), /\/fleet_coder$/);
  assert.equal(out.labels.filter((l) => l === "infra:db-down").length, 1);
});

test("1981: an add relay that does not match the build's databases halts", async () => {
  const s = withDecl(happy());
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "ok",
      verdict: "approve",
      deviations: [],
      coverage: { covered: true, missing: [] },
      classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "infra:db-up:add": (prompt) => {
      const i = inputsOf(prompt);
      return { status: "ok", reason: "added", up: { name: i.name, port: null, dbs: i.dbs.slice(1), users: Object.fromEntries(i.dbs.slice(1).map((d) => [d, "c".repeat(32)])), expiry: null, args: ["add", i.name, JSON.stringify(i.dbs.slice(1))] } };
    },
  });
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_gate, "db");
  assert.ok(!out.labels.some((l) => /^role:fleet-test-writer/.test(l)));
  assert.equal(out.labels[out.labels.length - 1], "infra:db-down");
});

test("1981: a teardown agent that throws never replaces the result", async () => {
  const s = withDecl(happy());
  s["infra:db-down"] = () => {
    throw new Error("agent died");
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.some((g) => /teardown failed \(agent died\)/.test(g)), out.result.gate_log.join("\n"));
});

test("1981: the short path's one writer gets one database", async () => {
  const s = withDecl(shortScript());
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.match(dsnOf(out.build, "role:fleet-test-writer:short:r1"), /\/fleet_w_short$/);
});

test("1981: a frozen resume keeps its dirty worktree through verify-plan too", async () => {
  const { s, out, planRef } = await coderStop();
  s["role:fleet-coder:r1"] = happy()["role:fleet-coder:r1"];
  s["hasher:resume-frozen"] = frozenState(planRef);
  const r = await runOne(s, buildArgsOf(planRef, { freeze_digest: out.result.freeze_digest }));
  const vp = call(r, "infra:verify-plan");
  assert.equal(inputsOf(vp.prompt).frozen_resume, true);
  assert.match(vp.prompt, /Exception \(frozen_resume is true\)/);
  assert.ok(!call(out.build, "infra:verify-plan").prompt.includes("Exception (frozen_resume"));
});

// ---------------------------------------------------------------- the programs, against stub binaries

const PY3 = rawSpawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
// A podman stub (shell builtins only: PATH holds the stub dir alone).
const PODMAN_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  'case "$1" in',
  '  run) if [ "$2" = "--help" ]; then [ -n "$STUB_NO_TIMEOUT" ] || printf "      --timeout uint   Maximum length of time\\n"; exit 0; fi; printf "cid\\n"; exit 0;;',
  '  port) printf "%s\\n" "${STUB_PORT:-127.0.0.1:40001}"; exit 0;;',
  '  exec) exit 0;;',
  '  rm) exit 0;;',
  '  ps) while IFS= read -r l || [ -n \"$l\" ]; do printf "%s\\n" "$l"; done < "$STUB_PS"; exit 0;;',
  '  container) if [ "$3" = "--format" ]; then printf "1\\n"; exit 0; fi; [ -f "$STUB_INSPECT" ] || exit 1; while IFS= read -r l || [ -n \"$l\" ]; do printf "%s\\n" "$l"; done < "$STUB_INSPECT"; exit 0;;',
  "esac",
  "exit 0",
].join("\n") + "\n";
const SYSTEMD_STUB = '#!/bin/sh\nprintf "systemd-run %s\\n" "$*" >> "$STUB_LOG"\nexit 0\n';

function stubDir(opts = {}) {
  const d = mkdtempSync(join(tmpdir(), "fleet-db-stub-"));
  const bin = join(d, "bin");
  mkdirSync(bin);
  if (opts.podman !== false) {
    writeFileSync(join(bin, "podman"), PODMAN_STUB);
    chmodSync(join(bin, "podman"), 0o755);
  }
  if (opts.systemd) {
    writeFileSync(join(bin, "systemd-run"), SYSTEMD_STUB);
    chmodSync(join(bin, "systemd-run"), 0o755);
  }
  const env = { PATH: bin, HOME: d, STUB_LOG: join(d, "log") };
  if (opts.noTimeout) env.STUB_NO_TIMEOUT = "1";
  if (opts.port) env.STUB_PORT = opts.port;
  if (opts.ps) {
    writeFileSync(join(d, "ps.json"), JSON.stringify(opts.ps));
    env.STUB_PS = join(d, "ps.json");
  }
  if (opts.inspect) {
    writeFileSync(join(d, "inspect.json"), JSON.stringify(opts.inspect));
    env.STUB_INSPECT = join(d, "inspect.json");
  }
  writeFileSync(env.STUB_LOG, "");
  return { d, env, log: () => readFileSync(env.STUB_LOG, "utf8").split("\n").filter(Boolean) };
}
function runProg(name, args, st) {
  return rawSpawnSync(PY3, ["-I", join(SCRIPTS_SRC, name + ".py")].concat(args), { encoding: "utf8", env: st.env, timeout: 60000 });
}
const IMG = "docker.io/library/mariadb@sha256:" + "d".repeat(64);
const UP_ARGS = (name) => ["up", name, IMG, "21600", "n1-0000001", JSON.stringify(["fleet_plan", "fleet_audit"])];
function digestOk(o) {
  const c = Object.assign({}, o);
  delete c.digest;
  return sha256(JSON.stringify(sortDeep(c))) === o.digest;
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

test("AC-1981-6 (stub podman): db_up starts a capped, self-expiring container bound to 127.0.0.1", { skip: !PY3 }, () => {
  const st = stubDir();
  const r = runProg("db_up", UP_ARGS("fleet-db-l42-1"), st);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.name, "fleet-db-l42-1");
  assert.equal(o.port, 40001);
  assert.deepEqual(o.dbs, ["fleet_plan", "fleet_audit"]);
  assert.equal(o.expiry.mechanism, "podman-timeout");
  assert.deepEqual(o.args, UP_ARGS("fleet-db-l42-1"));
  // one user per database, random 32-hex passwords; the root password is never printed
  assert.deepEqual(Object.keys(o.users).sort(), ["fleet_audit", "fleet_plan"]);
  for (const v of Object.values(o.users)) assert.match(v, /^[0-9a-f]{32}$/);
  assert.notEqual(o.users.fleet_plan, o.users.fleet_audit);
  const rootPw = /MARIADB_ROOT_PASSWORD=([0-9a-f]+)/.exec(st.log().find((l) => l.startsWith("run -d")))[1];
  assert.match(rootPw, /^[0-9a-f]{32}$/);
  assert.ok(!r.stdout.includes(rootPw), "the output holds no root password");
  const again = JSON.parse(runProg("db_up", UP_ARGS("fleet-db-l42-1"), stubDir()).stdout);
  assert.notEqual(again.users.fleet_plan, o.users.fleet_plan, "passwords are random per run");
  assert.equal(o.program.name, "db_up");
  assert.ok(digestOk(o), "the digest covers the printed object");
  const runLine = st.log().find((l) => l.startsWith("run -d"));
  assert.ok(runLine, st.log().join("\n"));
  for (const want of ["--rm", "--name fleet-db-l42-1", "--label fleet.db=1", "--label fleet.nonce=n1-0000001", "-p 127.0.0.1::3306", "--tmpfs /var/lib/mysql:size=1g", "--memory 1g", "--cpus 2", "--pids-limit 512", "--timeout 21600"])
    assert.ok(runLine.includes(want), want + " in " + runLine);
  assert.ok(runLine.endsWith(IMG));
  assert.ok(st.log().some((l) => /^exec .*mariadb-admin --protocol=tcp -h127\.0\.0\.1 -uroot ping$/.test(l)));
  const sqlLine = st.log().find((l) => l.includes("CREATE DATABASE"));
  assert.match(sqlLine, /CREATE DATABASE IF NOT EXISTS fleet_plan; CREATE OR REPLACE USER 'fleet_plan'@'%' IDENTIFIED BY '[0-9a-f]{32}'; GRANT ALL PRIVILEGES ON fleet_plan\.\* TO 'fleet_plan'@'%';/);
  assert.match(sqlLine, /GRANT ALL PRIVILEGES ON fleet_audit\.\* TO 'fleet_audit'@'%';/);
  assert.ok(!/GRANT[^;]*\*\.\*/.test(sqlLine), "no global grant");
});

test("AC-1981-6 (stub podman): a tf-local name, or any name off fleet-db-*, exits 2 and runs no podman", { skip: !PY3 }, () => {
  for (const n of ["tf-local-x", "fleet-db-tf-local-x", "x", "fleet-db-A", "fleet-db-a;rm"]) {
    const st = stubDir();
    const r = runProg("db_up", UP_ARGS(n), st);
    assert.equal(r.status, 2, n + ": " + r.stderr);
    assert.deepEqual(st.log(), [], n);
    const d = runProg("db_down", [n, "n1"], st);
    assert.equal(d.status, 2, n);
    assert.deepEqual(st.log(), [], n);
  }
  // an image not pinned by digest
  for (const img of ["docker.io/library/mariadb:11.4", "docker.io/library/mariadb", "docker.io/library/mariadb@sha256:abc"]) {
    const st = stubDir();
    const a = UP_ARGS("fleet-db-a");
    a[2] = img;
    assert.equal(runProg("db_up", a, st).status, 2, img);
    assert.deepEqual(st.log(), [], img);
  }
});

test("AC-1981-7 (stub podman): no podman --timeout and no systemd-run exits non-zero and starts no container", { skip: !PY3 }, () => {
  const st = stubDir({ noTimeout: true });
  const r = runProg("db_up", UP_ARGS("fleet-db-a"), st);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /no expiry mechanism/);
  assert.ok(!st.log().some((l) => l.startsWith("run -d")), st.log().join("\n"));
  const np = stubDir({ podman: false, systemd: true });
  assert.equal(runProg("db_up", UP_ARGS("fleet-db-a"), np).status, 4);
});

test("1981 (stub podman): without --timeout a systemd-run timer is the expiry", { skip: !PY3 }, () => {
  const st = stubDir({ noTimeout: true, systemd: true });
  const r = runProg("db_up", UP_ARGS("fleet-db-a"), st);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).expiry.mechanism, "systemd-run");
  const runLine = st.log().find((l) => l.startsWith("run -d"));
  assert.ok(!runLine.includes("--timeout"));
  assert.ok(st.log().some((l) => /^systemd-run --user --on-active=21600s --unit=fleet-db-a-expire .*podman rm -f fleet-db-a$/.test(l)), st.log().join("\n"));
});

test("1981 (stub podman): a port not bound to 127.0.0.1 only removes the container and exits non-zero", { skip: !PY3 }, () => {
  const st = stubDir({ port: "0.0.0.0:40001" });
  const r = runProg("db_up", UP_ARGS("fleet-db-a"), st);
  assert.equal(r.status, 5, r.stderr);
  assert.ok(st.log().includes("rm -f fleet-db-a"), st.log().join("\n"));
});

test("1981 (stub podman): db_sweep removes only expired fleet-db-* containers labelled fleet.db=1", { skip: !PY3 }, () => {
  const past = "1000";
  const future = String(Math.floor(Date.now() / 1000) + 3600);
  const row = (n, labels) => ({ Names: [n], Labels: labels });
  const st = stubDir({
    ps: [
      row("fleet-db-old-1", { "fleet.db": "1", "fleet.expires": past }),
      row("fleet-db-live-2", { "fleet.db": "1", "fleet.expires": future }),
      row("tf-local-main", { "fleet.db": "1", "fleet.expires": past }),
      row("fleet-db-tf-local-3", { "fleet.db": "1", "fleet.expires": past }),
      row("mysql", { "fleet.db": "1", "fleet.expires": past }),
      row("fleet-db-nolabel-4", { "fleet.expires": past }),
      row("fleet-db-noexp-5", { "fleet.db": "1" }),
    ],
  });
  const r = runProg("db_sweep", [], st);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.removed, ["fleet-db-old-1"]);
  assert.ok(digestOk(o));
  assert.deepEqual(st.log().filter((l) => l.startsWith("rm")), ["rm -f fleet-db-old-1"]);
  // no podman: nothing to do
  const np = stubDir({ podman: false });
  assert.equal(JSON.parse(runProg("db_sweep", [], np).stdout).podman, false);
});

test("1981 (stub podman): db_down removes only this run's container", { skip: !PY3 }, () => {
  const mine = [{ Config: { Labels: { "fleet.db": "1", "fleet.nonce": "n1" } } }];
  let st = stubDir({ inspect: mine });
  let o = JSON.parse(runProg("db_down", ["fleet-db-a", "n1"], st).stdout);
  assert.equal(o.removed, true);
  assert.ok(st.log().includes("rm -f fleet-db-a"));
  st = stubDir({ inspect: [{ Config: { Labels: { "fleet.db": "1", "fleet.nonce": "other" } } }] });
  o = JSON.parse(runProg("db_down", ["fleet-db-a", "n1"], st).stdout);
  assert.equal(o.removed, false);
  assert.match(o.error, /not this run/);
  assert.ok(!st.log().some((l) => l.startsWith("rm")));
  st = stubDir();
  o = JSON.parse(runProg("db_down", ["fleet-db-a", "n1"], st).stdout);
  assert.equal(o.absent, true);
});

test("1981 (real git): test_db_decl reads the declaration at origin/<default>, never the worktree", { skip: !PY3 }, () => {
  const d = mkdtempSync(join(tmpdir(), "fleet-decl-"));
  const env = gitEnv(d, join(d, "gitconfig"));
  writeFileSync(join(d, "gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n");
  const up = join(d, "up");
  const wt = join(d, "wt");
  const g = (cwd, ...a) => {
    const r = rawSpawnSync("git", a, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
    return r.stdout;
  };
  mkdirSync(up);
  g(up, "init", "-q", "-b", "master");
  writeFileSync(join(up, "a.txt"), "a\n");
  g(up, "add", "a.txt");
  g(up, "commit", "-q", "-m", "a");
  g(d, "clone", "-q", up, wt);
  const decl = () => {
    const r = rawSpawnSync(PY3, ["-I", join(SCRIPTS_SRC, "test_db_decl.py"), wt, "master"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.ok(digestOk(o));
    return o;
  };
  assert.deepEqual([decl().decl, decl().error], [null, null]);
  // a worktree-only file is not a declaration
  writeFileSync(join(wt, ".fleet-test-db.json"), JSON.stringify(DECL));
  assert.equal(decl().decl, null);
  writeFileSync(join(up, ".fleet-test-db.json"), JSON.stringify(DECL));
  g(up, "add", ".fleet-test-db.json");
  g(up, "commit", "-q", "-m", "decl");
  g(wt, "fetch", "-q", "origin");
  assert.deepEqual(decl().decl, DECL);
  writeFileSync(join(up, ".fleet-test-db.json"), JSON.stringify(Object.assign({}, DECL, { env: "PATH" })));
  g(up, "commit", "-q", "-am", "bad");
  g(wt, "fetch", "-q", "origin");
  const bad = decl();
  assert.equal(bad.decl, null);
  assert.match(bad.error, /env must match/);
  assert.deepEqual(bad.args, [wt, "master"]);
});

test("1987 (real git): the hasher reports a ref to the freeze tree object, and the ref does not change the tree", { skip: !PY3 }, () => {
  const wt = scratchRepo("fleet-freeze-ref-");
  writeFileSync(join(wt, "a.txt"), "a\n");
  sh(wt, "git", "add", "a.txt");
  sh(wt, "git", "commit", "-q", "-m", "a");
  writeFileSync(join(wt, "test_new.py"), "def test_x():\n    assert False\n");
  const h1 = runHasherRaw(wt, "hash", ["test_new.py"]);
  const tree = h1.fingerprint.tree;
  sh(wt, "git", "-c", "core.hooksPath=/dev/null", "update-ref", "refs/fleet/t/freeze", tree);
  const h2 = runHasherRaw(wt, "hash", ["test_new.py"]);
  assert.equal(h2.hashes.git["fleetref:refs/fleet/t/freeze"], tree);
  assert.equal(h2.fingerprint.tree, tree);
  assert.equal(sh(wt, "git", "cat-file", "-t", "refs/fleet/t/freeze").trim(), "tree");
});
