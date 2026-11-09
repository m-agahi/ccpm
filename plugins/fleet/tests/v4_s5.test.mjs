// fleet 4.0.0 stream S5 (build loop and DB): the short path (ledger 1991,
// one writer split per criterion), the frozen resume (ledger 1987) and the
// throwaway test DB (ledger 1981).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARGS,
  happy,
  run,
  call,
  inputsOf,
  noUnscripted,
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
