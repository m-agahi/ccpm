// fleet 4.0.0 stream S5 (build loop and DB): the short path (ledger 1991,
// one writer split per criterion), the frozen resume (ledger 1987) and the
// throwaway test DB (ledger 1981).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
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
  const s = shortScript({ __raw: true, status: "ok", reason: "x", role_version: 11, role_contract: "CONTRACT: fleet-v4", criterion_id: "short", tests: [] });
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
  for (const m of ["files", "sections", "git", "symlinks", "ignored"]) o[m] = Object.assign({}, h[m] || {});
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
