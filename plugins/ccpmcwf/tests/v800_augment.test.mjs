// fleet 8.0.0 car G6: the augmentation round (#7; ADR-1316).
//
// A survivor of the mutation gate that the code judge rules `target: tests` goes into the existing
// fix_tests detour, once per run: the writers run first (no judge-first round) with
// surviving_mutants [{id, path, line, op}] and frozen_tests (the frozen list before the round); the
// script assigns the round's new, add-only test file (the first test file of the first testable
// criterion, with _mut<m> before its suffix), owned by that criterion's writer. Writers report
// red_kind "kills_mutant" and name each survivor id in a covers. The test judge gets
// surviving_mutants too. The re-freeze allows only the new files, as added keys; every original
// frozen key must be unchanged. Then the originals plus the new files are frozen, and the new files
// join frozen_tests, the hashed files and the gates' exclude list.
// Red/green: the next code round is the check. Its coder must report the frozen tests green at the
// start (the new tests pass on the approved tree), and its mutation run must kill the survivor; a
// second `tests` ruling stops the run (G6-3). mutants.py has no one-mutant mode, so the script does
// not run the mutant itself; the test judge checks it in its throwaway copy.
//
// ACs (plan-8.0.0-gates.md, G6):
// - G6-1: one round runs, with new files only.
// - G6-2: a writer that edits an original frozen test stops at hash.
// - G6-3: a 2nd `tests` ruling after the round gives needs_human.
// - G6-4: the round counts against MAX_CODE_ROUNDS.
// - G6-5 (non-weakening): plain fix_tests without survivors works as before (v633/v4_s2 unchanged).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, SOURCE, ARGS, H, HASHES, HASHES_FLAT, FP_K1, FP_K2, FP_M3, PB, happy, run, runOne, inputsOf, call, noUnscripted, stateJsonOf } from "./harness.mjs";

const NEW = "tests/test_a_mut1.py";
const FP_A = { head: PB, tree: "A2" };
const AUG = H(Object.assign({}, HASHES_FLAT, { [NEW]: "hm" }));
const SURV = {
  status: "ran",
  reason: "1 killed, 2 survived of 3 mutant(s)",
  killed: 1,
  survived: [
    { id: "m1", path: "src/x.py", line: 3, op: "boundary: < -> <=" },
    { id: "m3", path: "src/x.py", line: 9, op: "flip: == -> !=" },
  ],
  not_run: 0,
  budget_hit: false,
};
const NR = { status: "not_run", reason: "no coverage tool: coverage is not on PATH", findings: [] };
function argsOf(prompt, n) {
  const m = new RegExp(n + "\\.py'((?: '(?:[^']|'\\\\'')*')+)").exec(prompt);
  return m ? [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")) : [];
}
const gates = (mut) => (prompt) => ({
  status: "ok",
  reason: "ran",
  coverage: Object.assign({}, NR, { args: argsOf(prompt, "cover_diff") }),
  mutation: Object.assign({}, mut, { args: argsOf(prompt, "mutants") }),
});
const approve = (rul) => ({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 }, mutant_rulings: rul });
const EQ1 = { id: "m1", target: "equivalent", reason: "no input reaches the boundary" };
const T3 = { id: "m3", target: "tests", reason: "no test covers equal inputs" };
const C1 = { id: "m1", target: "code", reason: "the boundary is wrong" };
const KILL = [{ file: NEW, name: "test_equal_inputs", covers: "AC1: kills m3 (equal inputs)", red_kind: "kills_mutant", failure_excerpt: "assert False" }];

// round 1: approve with m3 ruled tests -> the augmentation round (test round 2, freeze f2) -> code round 2
function aug(over) {
  return happy({
    script: Object.assign(
      {
        "infra:gates:r1": gates(SURV),
        "role:fleet-code-judge:r1": approve([EQ1, T3]),
        "role:fleet-test-writer:AC1:r2": { status: "ok", reason: "kills", criterion_id: "AC1", tests: KILL, files: [NEW] },
        "hasher:post-writers:r2": { status: "ok", fingerprint: FP_A, changed: [NEW], hashes: AUG },
        "role:fleet-test-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], checked: [] },
        "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_A },
        "hasher:freeze:f2": { status: "ok", fingerprint: FP_A, hashes: AUG },
        // 8.0.0 car F (A-H1): round 2 reports the mutation gate again (the new test kills m3)
        "infra:gates:r2": gates({ status: "ran", reason: "1 killed, 0 survived of 1 mutant(s)", killed: 1, survived: [], not_run: 0, budget_hit: false }),
        "role:fleet-coder:r2": { status: "ok", reason: "green", changed_paths: [], frozen_tests_red_at_start: false },
        "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: AUG },
        "role:fleet-code-judge:r2": approve(),
        "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
      },
      over || {},
    ),
  });
}

test("8.0.0 G6-1: a survivor ruled tests runs one augmentation round: writers first, a new add-only file, re-freeze, then code round 2", async () => {
  const out = await run(aug(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  noUnscripted(out);
  const L = out.build.labels;
  const i = L.indexOf("role:fleet-code-judge:r1");
  // the writers come first: no judge-first round of the fix_tests shape
  const rest = L.slice(i + 1).filter((l) => /^role:fleet-test-(writer|judge)|^hasher:freeze|^role:fleet-coder:r2/.test(l));
  assert.deepEqual(rest, ["role:fleet-test-writer:AC1:r2", "role:fleet-test-judge:r2", "hasher:freeze:f2", "role:fleet-coder:r2"]);
  assert.ok(!L.includes("role:fleet-test-writer:AC2:r2"), "one writer: the first testable criterion's");
  assert.ok(out.logs.includes("code round 1: mutation gate: augmentation round for m3 -> " + NEW), out.logs.join("\n"));
  // the writer's inputs: the new file only, the survivors and the frozen tests
  const w = inputsOf(call(out, "role:fleet-test-writer:AC1:r2").prompt);
  assert.deepEqual(w.test_files, [NEW]);
  assert.deepEqual(w.surviving_mutants, [SURV.survived[1]]);
  assert.deepEqual(w.frozen_tests, ["tests/test_a.py", "tests/test_b.py"]);
  assert.equal(w.routed_findings.length, 1);
  assert.equal(w.routed_findings[0].target, "tests");
  assert.equal(w.routed_findings[0].criterion, "AC1");
  assert.match(w.routed_findings[0].finding, /mutant m3 \(src\/x\.py:9 flip: == -> !=\) survives the frozen tests; the code judge ruled tests: no test covers equal inputs$/);
  assert.equal(w.criterion.id, "AC1");
  assert.ok(!("surviving_mutants" in w.criterion) && !("test_files" in w.criterion));
  assert.deepEqual(inputsOf(call(out, "role:fleet-test-judge:r2").prompt).surviving_mutants, [SURV.survived[1]]);
  // the re-freeze: the new file only, as an added key
  assert.deepEqual(out.result.refreeze_log, [{ round: 1, freeze_tree_before: "T1", freeze_tree_after: "A2", changed: [{ path: NEW, change: "added" }] }]);
  assert.ok(out.logs.includes("re-freeze after augmentation (code round 1): 1 frozen test file(s) changed"), out.logs.filter((l) => /re-freeze/.test(l)).join("\n"));
  const a = inputsOf(out.build.calls.find((c) => c.label === "infra:hash-diff:refreeze:f2").prompt).args;
  assert.deepEqual(a.slice(1, 3), ["--allow", JSON.stringify(["files:" + NEW])]);
  // the new file is frozen: the coder's frozen_tests, the hashed files and the gates' exclude list
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.deepEqual(c2.frozen_tests, ["tests/test_a.py", "tests/test_b.py", NEW]);
  assert.deepEqual(c2.routed_findings, []);
  assert.deepEqual(JSON.parse(argsOf(call(out, "infra:gates:r2").prompt, "mutants")[5]), ["tests/test_a.py", "tests/test_b.py", NEW]);
  assert.ok(inputsOf(call(out, "hasher:post-coder:r2").prompt).test_files.includes(NEW), "the hasher hashes the new file");
  assert.ok(L.includes("infra:commit:r2"));
});

test("8.0.0 G6-1: a resumed build hashes the round's file as frozen (aug_files in the run state) and runs no second round", async () => {
  const states = {};
  const s = aug();
  for (const label of ["infra:state:committed:r2", "infra:state:pushed:p1"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  const opener = s["role:fleet-pr-opener"];
  s["role:fleet-pr-opener"] = { status: "needs_human", reason: "no PR access" };
  const plan = await runOne(s, ARGS);
  const first = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(first.result.status, "needs_human", first.result.reason);
  const st = states.pushed;
  assert.deepEqual(st.aug_files, [NEW]);
  s["role:fleet-pr-opener"] = opener;
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: st.approved_sha, commits_since: [{ sha: st.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py", NEW] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true };
  s["hasher:resume"] = { status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: AUG };
  const second = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(second.result.status, "ok", second.result.reason);
  assert.deepEqual(inputsOf(call(second, "hasher:resume").prompt).test_files, ["tests/test_a.py", "tests/test_b.py", NEW]);
  // a forged list: not an array, or a path already frozen
  // 8.0.0 G7 step 0: exactly one entry, normPath-equal, relative, no .., the generated name of a round
  for (const bad of ["x", ["tests/test_a.py"], [1], [], [NEW, "tests/test_a_mut2.py"], ["./" + NEW], [NEW + "/"], ["/" + NEW], ["tests/../" + NEW], ["../tests/test_a_mut1.py"], ["tests/test_a_mut9.py"], ["tests/test_b_mut1.py"], ["tests/evil.py"], [" " + NEW]]) {
    s["infra:read-state"] = Object.assign({}, s["infra:read-state"], { message: JSON.stringify(Object.assign({}, st, { aug_files: bad })) });
    const r = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
    assert.equal(r.result.stop_gate, "resume", JSON.stringify(bad));
    assert.match(r.result.reason, /^run-state mismatch: aug_files/);
  }
  // a run without the round writes no aug_files
  assert.match(SOURCE, /\.\.\.\(state\.augFiles \? \{ aug_files: state\.augFiles \} : \{\}\)/);
  assert.match(SOURCE, /let augAt = state\.augFiles \? -1 : 0;/);
});

test("8.0.0 G6-1: a survivor ruled code rides along to the coder; the round's writer sees only the tests survivors", async () => {
  const out = await run(aug({ "role:fleet-code-judge:r1": approve([C1, T3]) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "role:fleet-test-writer:AC1:r2").prompt).surviving_mutants, [SURV.survived[1]]);
  const f = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.deepEqual(f, [{ target: "code", criterion: null, finding: "mutation gate: mutant m1 (src/x.py:3 boundary: < -> <=) survives the frozen tests; the code judge ruled code: the boundary is wrong" }]);
  // an unruled survivor still goes to the coder, with no augmentation round
  const un = await run(aug({ "role:fleet-code-judge:r1": approve([T3]) }), ARGS);
  assert.ok(!un.build.labels.includes("role:fleet-test-writer:AC1:r2"), un.build.labels.join(", "));
  assert.match(inputsOf(call(un, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /^mutation gate: surviving mutants no ruling covers: m1 /);
});

test("8.0.0 G6-1: the new file's name: _mut<m> before the suffix of the first test-named file (never conftest or config)", async () => {
  for (const [files, want] of [
    [["pyproject.toml", "tests/conftest.py", "tests/test_q.py"], "tests/test_q_mut1.py"],
    [["pkg/x_test.go"], "pkg/x_mut1_test.go"],
    [["web/a.test.mjs"], "web/a_mut1.test.mjs"],
    [["src/FooTest.java"], "src/FooTest_mut1.java"],
  ]) {
    const crit = [{ id: "AC1", text: "behaviour 1", test_files: files }];
    const s = aug();
    s["role:scope-and-plan"].criteria = crit;
    s["role:fleet-test-writer:AC1:r1"].files = files;
    s["hasher:post-writers:r1"] = { status: "ok", fingerprint: { head: PB, tree: "T1" }, changed: files };
    delete s["role:fleet-test-writer:AC2:r1"];
    const out = await run(s, ARGS);
    assert.ok(out.logs.includes("code round 1: mutation gate: augmentation round for m3 -> " + want), out.logs.filter((l) => /augmentation/.test(l)).join("\n") + " / " + out.result.reason);
  }
});

test("8.0.0 G6-1: the short path's one writer runs the round", async () => {
  const s = aug();
  Object.assign(s["role:scope-and-plan"], { est_diff_lines: 10, new_behaviour: false });
  delete s["role:fleet-test-writer:AC1:r1"];
  delete s["role:fleet-test-writer:AC2:r1"];
  delete s["role:fleet-test-writer:AC1:r2"];
  s["role:fleet-test-writer:short:r1"] = { status: "ok", reason: "red", criterion_id: "short", tests: [], files: ["tests/test_a.py", "tests/test_b.py"] };
  s["role:fleet-test-writer:short:r2"] = { status: "ok", reason: "kills", criterion_id: "short", tests: KILL, files: [NEW] };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const w = inputsOf(call(out, "role:fleet-test-writer:short:r2").prompt);
  assert.deepEqual(w.test_files, [NEW]);
  assert.deepEqual(w.surviving_mutants, [SURV.survived[1]]);
  assert.deepEqual(w.frozen_tests, ["tests/test_a.py", "tests/test_b.py"]);
});

test("8.0.0 G6-1: the round's tests must report red_kind kills_mutant and name every survivor in a covers", async () => {
  for (const [tests, why] of [
    [[Object.assign({}, KILL[0], { red_kind: "assertion" })], /red_kind/],
    [[], /red_kind/],
    [[Object.assign({}, KILL[0], { covers: "AC1: kills m30" })], /m3/],
  ]) {
    const out = await run(aug({ "role:fleet-test-writer:AC1:r2": { status: "ok", reason: "x", criterion_id: "AC1", tests, files: [NEW] } }), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(tests));
    assert.equal(out.result.stop_gate, "role");
    assert.match(out.result.reason, /^augmentation round \(test round 2\): /);
    assert.match(out.result.reason, why);
    assert.ok(!out.build.labels.includes("role:fleet-test-judge:r2"));
  }
});

test("8.0.0 G6-1: the next round's coder must find the frozen tests green at the start (the new tests pass on the approved tree)", async () => {
  const out = await run(aug({ "role:fleet-coder:r2": { status: "ok", reason: "red", changed_paths: [], frozen_tests_red_at_start: true } }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.match(out.result.reason, /^code round 2: the frozen tests are red at the start of the round after the augmentation round/);
  assert.ok(!out.build.labels.includes("role:fleet-code-judge:r2"));
});

test("8.0.0 G6-2: a writer that edits an original frozen test stops at gate hash (reported or not)", async () => {
  const edited = H(Object.assign({}, HASHES_FLAT, { [NEW]: "hm", "tests/test_a.py": "ha2" }));
  for (const files of [[NEW, "tests/test_a.py"], [NEW]]) {
    const out = await run(aug({
      "role:fleet-test-writer:AC1:r2": { status: "ok", reason: "x", criterion_id: "AC1", tests: KILL, files },
      "hasher:post-writers:r2": { status: "ok", fingerprint: FP_A, changed: [NEW, "tests/test_a.py"], hashes: edited },
    }), ARGS);
    assert.equal(out.result.status, "needs_human", out.result.reason);
    assert.equal(out.result.stop_gate, "hash", out.result.reason);
    assert.match(out.result.reason, /writer (AC1 )?touched tests\/test_a\.py in test round 2/);
    assert.ok(!out.build.labels.includes("hasher:freeze:f2"));
  }
  // another criterion's frozen file too
  const b = await run(aug({ "hasher:post-writers:r2": { status: "ok", fingerprint: FP_A, changed: [NEW, "tests/test_b.py"], hashes: H(Object.assign({}, HASHES_FLAT, { [NEW]: "hm", "tests/test_b.py": "hb2" })) } }), ARGS);
  assert.equal(b.result.stop_gate, "hash", b.result.reason);
  // the re-freeze backs it: only the new file, and only as an added key
  assert.match(SOURCE, /\(refreeze\.files && k\.kind !== "added"\)/);
});

test("8.0.0 G6-3: a second tests ruling after the round stops needs_human at gate gates", async () => {
  const out = await run(aug({ "infra:gates:r2": gates(SURV), "role:fleet-code-judge:r2": approve([EQ1, T3]) }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "gates");
  assert.equal(out.result.reason, "code round 2: the code judge ruled surviving mutant(s) m3 target tests after the augmentation round of this run; one round per run");
  assert.equal(out.build.labels.filter((l) => /^role:fleet-test-writer:AC1:r/.test(l)).length, 2, "the first round's writer and the one augmentation round");
  assert.ok(!out.build.labels.includes("hasher:freeze:f3"));
});

// the v610_update_coder fixture, cut down: a green PR behind its base; update-branch moves it to D;
// the re-review requests changes; code round 2 runs on the forge's merge D
const D = "d".repeat(40);
const CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "auto", update_branch: "once", ci_trigger: true, review_post: "none" };
function upd(over) {
  const t = happy();
  t["infra:policy"] = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args });
  t["infra:pr-merge"] = (p) => {
    const a = inputsOf(p).args;
    return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
  };
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: "c".repeat(40), overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
  const F1 = { id: "F1", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" };
  return Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES, changed: ["src/x.py"] },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": { status: "ok", reason: "broken", verdict: "changes_requested", findings: [F1], touches_gate: false, checked: [] },
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "fixed", changed_paths: ["src/x.py"], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: D, tree: "K2" }, hashes: HASHES, changed: ["src/x.py"] },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: D, tree: "K2" } },
  }, over);
}

test("8.0.0 G6-3: a tests ruling in the code round after update-branch stops at review (no writer or re-freeze on the forge's merge)", async () => {
  const out = await run(upd({ "infra:gates:r2": gates(SURV), "role:fleet-code-judge:r2": approve([EQ1, T3]) }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.equal(out.result.reason, "code round 2: the code judge ruled surviving mutant(s) m3 target tests after update-branch; one round per run");
  const L = out.build.labels;
  assert.ok(!L.slice(L.indexOf("role:fleet-code-judge:r2")).some((l) => /^(role:fleet-test-writer|role:fleet-test-judge|hasher:freeze|infra:freeze-ref|infra:commit:r2)/.test(l)), L.join(", "));
});

test("8.0.0 G6-4: the round counts against MAX_CODE_ROUNDS: an augmentation in round 3 ends at the cap", async () => {
  const fix = { status: "ok", reason: "x", verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "tidy" }], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };
  const s = aug({
    "role:fleet-code-judge:r1": fix,
    "role:fleet-coder:r2": { status: "ok", reason: "x", changed_paths: ["src/x.py"] },
    "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
    "role:fleet-code-judge:r2": fix,
    "role:fleet-coder:r3": { status: "ok", reason: "x", changed_paths: ["src/x.py"] },
    "hasher:post-coder:r3": { status: "ok", fingerprint: FP_M3, hashes: HASHES },
    "infra:gates:r3": gates(SURV),
    "role:fleet-code-judge:r3": approve([EQ1, T3]),
    "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: FP_M3 },
    "role:fleet-test-writer:AC1:r2": { status: "ok", reason: "kills", criterion_id: "AC1", tests: [Object.assign({}, KILL[0], { file: "tests/test_a_mut3.py" })], files: ["tests/test_a_mut3.py"] },
    "hasher:post-writers:r2": { status: "ok", fingerprint: FP_A, changed: ["tests/test_a_mut3.py"], hashes: H(Object.assign({}, HASHES_FLAT, { "tests/test_a_mut3.py": "hm" })) },
    "hasher:freeze:f2": { status: "ok", fingerprint: FP_A, hashes: H(Object.assign({}, HASHES_FLAT, { "tests/test_a_mut3.py": "hm" })) },
  });
  delete s["infra:gates:r1"];
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "cap");
  assert.equal(out.result.reason, "code rounds exhausted (3) without code-judge approval; last round rejected by the mutation gate");
  assert.ok(out.build.labels.includes("hasher:freeze:f2"), "the round ran in code round 3");
  assert.ok(!out.build.labels.includes("role:fleet-coder:r4"));
});

test("8.0.0 G6 cap: the round costs 13 more agents (10 capped) than the same round 2 by fix_code; the existing reserves cover it", async () => {
  const a = await run(aug(), ARGS);
  const b = await run(aug({ "role:fleet-code-judge:r1": approve([EQ1, { id: "m3", target: "code", reason: "x" }]), "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES } }), ARGS);
  assert.equal(a.result.status, "ok", a.result.reason);
  assert.equal(b.result.status, "ok", b.result.reason);
  const extra = a.build.labels.filter((l, i, all) => !b.build.labels.includes(l));
  assert.deepEqual(extra, [
    "infra:build-reset:writers:r2",
    "role:fleet-test-writer:AC1:r2",
    "infra:path-check:format-tests:r2",
    "infra:format-tests:r2",
    "hasher:post-writers:r2",
    "infra:hash-diff:writers:r2",
    "infra:build-reset:test-judge:r2",
    "role:fleet-test-judge:r2",
    "hasher:fp-post:test-judge:r2",
    "infra:purge-bytecode:freeze-f2",
    "hasher:freeze:f2",
    "infra:hash-diff:refreeze:f2",
    "infra:freeze-ref:f2",
  ]);
  assert.equal(a.result.agents - b.result.agents, 13);
  // 13 agents, 2 of them resets and 1 a PATH check outside the cap: 10 capped, under reserve(1 + 5 + 0) and reserve(3)
  assert.match(SOURCE, /reserve\(\(shortPath \? 1 : pending\.length\) \+ 5 \+ \(last \? 0 : 1\), "test round " \+ n\)/);
  assert.match(SOURCE, /if \(refreeze\) reserve\(3, "re-freeze"\)/);
});

test("8.0.0 G6-5 non-weakening: plain fix_tests (no survivors) sends no augmentation input and logs as before", async () => {
  const testFinding = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const out = await run(happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [testFinding] },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [testFinding] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1" },
      "hasher:post-writers:r3": { status: "ok", fingerprint: FP_M3, changed: ["tests/test_a.py"], hashes: HASHES },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: HASHES },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:fleet-test-writer:AC1:r3", "role:fleet-test-judge:r2", "role:fleet-test-judge:r3"]) {
    const i = inputsOf(call(out, l).prompt);
    assert.ok(!("surviving_mutants" in i) && !("frozen_tests" in i), l);
  }
  assert.ok(out.logs.includes("re-freeze after fix_tests (code round 1): 0 frozen test file(s) changed"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-coder:r2").prompt).frozen_tests, ["tests/test_a.py", "tests/test_b.py"]);
});

test("8.0.0 G6: roles: the writer's augmentation section is active; the test judge and the code judge describe the round", () => {
  const r = (n) => readFileSync(join(HERE, "..", "roles", n + ".md"), "utf8");
  const tw = r("fleet-test-writer");
  assert.doesNotMatch(tw, /augmentation rounds — inactive/i);
  for (const k of ["`surviving_mutants`", "`frozen_tests`", 'red_kind: "kills_mutant"', "covers"]) assert.ok(tw.includes(k), "writer: " + k);
  const tj = r("fleet-test-judge");
  for (const k of ["`surviving_mutants`", 'red_kind: "kills_mutant"', "scratch_copy_cmd"]) assert.ok(tj.includes(k), "judge: " + k);
  assert.match(tj, /## Mutation-augmentation round/);
  const cj = r("fleet-code-judge");
  assert.doesNotMatch(cj, /Until the test augmentation round ships/);
  assert.match(cj, /augmentation round/);
});
