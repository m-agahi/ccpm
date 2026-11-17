// fleet 8.0.0 car G4: the held-out runner, build side (#6, gate 3; threat model ADR-1152).
// A twelfth role, fleet-held-out-runner (JUDGE_AGENT, read-only on the worktree), runs in every code
// round after infra:gates:r<m> and before the code judge, after its own build-dir reset (B1-5: every
// guarded step gets its own PATH check). It runs held_out.py show itself, turns each example into a
// throwaway test in a scratch copy of the judged tree, and returns {store, store_digest, results:
// [{criterion, index, pass}]} with no example text. The script checks the store digest against the
// seal and that the results cover exactly the sealed per_criterion counts (else needs_human at gate
// gates); the code judge gets pass/fail per index only. An approve with a failing example becomes
// fix_code ("criterion X fails a hidden example"). A null seal, an old ref and a re-plan dispatch no
// runner and give their own not_run reasons.
//
// ACs (plan-8.0.0-gates.md, G4):
// - G4-1: all pass gives held_out ran, and it leaves gates_not_run.
// - G4-2: a fail plus an approve gives fix_code, and the finding holds no example text (sentinel).
// - G4-3: a missing file gives not_run: store file missing on this machine.
// - G4-4: a digest that differs from the seal gives needs_human.
// - G4-5: a runner that changes the main worktree hits the fingerprint stop.
// - G4-6: v5_roles passes with 12 roles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HERE, SOURCE, ARGS, happy, run, runOne, inputsOf, call, sha256, canon, planRefFor, buildArgs, writerChunksOf, noUnscripted, ROLE_NAMES, FP_K1, FP_K2, HASHES } from "./harness.mjs";
import { ROLE_COUNT } from "../scripts/gen.mjs";

const SENTINEL = "ZQX-HELDOUT-SENTINEL-7731";
const RUNNER = "fleet-held-out-runner";
const R1 = "role:" + RUNNER + ":r1";
const ex = (cid, when, then) => ({ criterion_id: cid, given: "g", when, then });
const CRIT = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: "AC" + (i + 1),
    text: "[unit] behaviour " + (i + 1),
    test_files: ["tests/test_" + (i + 1) + ".py"],
    examples: [{ given: "g", when: "f(" + (i + 1) + ")", then: String(i + 2), kind: "main" }],
    dont_care: [],
    property: null,
    guards_existing: false,
    spec_quote: null,
  }));
// two examples for AC1, one for AC2; every one carries the sentinel
const SECRET = [ex("AC1", "f(9)", SENTINEL), ex("AC2", "f(0)", "x " + SENTINEL), ex("AC1", "f(7) " + SENTINEL, "49")];
function withExamples(examples, script) {
  const s = happy({ criteria: CRIT(2), script });
  s["role:scope-and-plan"].held_out_examples = examples;
  return s;
}
// a runner stub over the prompt's sealed per_criterion: every example passes unless fail(c, i)
function runnerStub(fail, over) {
  return (prompt) => {
    const ho = inputsOf(prompt).held_out;
    const results = [];
    for (const [c, n] of Object.entries(ho.per_criterion)) for (let i = 0; i < n; i++) results.push({ criterion: c, index: i, pass: !(fail && fail(c, i)) });
    return Object.assign({ status: "ok", reason: "ran " + results.length, store: "ok", store_digest: ho.sha256, results }, over);
  };
}
const approve = () => ({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } });
const R2 = {
  "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
  "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: HASHES },
  "role:fleet-code-judge:r2": approve(),
  "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
};
const sealedRef = (s, tiny) => JSON.parse(s.__store[tiny.plan_commit]);
function reseal(s, tiny, edit) {
  const ref = sealedRef(s, tiny);
  edit(ref);
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  return { ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) };
}
const decoded = (prompt) => {
  const c = writerChunksOf(prompt);
  const ids = Object.keys(c).map(Number).sort((a, b) => a - b);
  return ids.length ? Buffer.from(ids.map((i) => c[i]).join(""), "base64").toString("utf8") : "";
};
const hoGate = (out) => out.result.gates_not_run && out.result.gates_not_run.find((g) => g.gate === "held_out");

test("8.0.0 G4-6: the twelfth role ships: ROLE_COUNT, ROLES, REQUIRED_ON_OK, the schema, the DISPATCH line, the README list", () => {
  assert.equal(ROLE_COUNT, 12);
  assert.equal(ROLE_NAMES.length, 12);
  assert.ok(ROLE_NAMES.includes(RUNNER));
  assert.match(SOURCE, /\n  "fleet-held-out-runner",\n\];/, "ROLES ends with the runner");
  assert.match(SOURCE, /"fleet-held-out-runner": \["store", "store_digest", "results"\]/, "REQUIRED_ON_OK");
  assert.match(SOURCE, /"fleet-held-out-runner": "DISPATCH: model=sonnet \(fallback=opus\)"/);
  const t = readFileSync(join(HERE, "..", "roles", RUNNER + ".md"), "utf8");
  assert.match(t, /^DISPATCH: model=sonnet \(fallback=opus\)$/m);
  assert.match(t, /READ-ONLY on `worktree`/);
  assert.match(t, /<held_out_cmd> show <task_id> <plan_sha256> <held_out\.sha256>/);
  assert.match(t, /scratch_copy_cmd> make <worktree> <plan_commit>/);
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
  assert.match(readme, /twelve role prompts/);
  assert.match(readme, /`fleet-held-out-runner`/);
  // 8.0.0 (G4): one more capped agent per code round
  assert.match(SOURCE, /reserve\(10 \+ \(planFacts\.changed_symbols/);
});

test("8.0.0 G4-1: all pass -> held_out ran; it leaves gates_not_run; the runner sits after infra:gates:r1 behind its own reset, before the judge's reset", async () => {
  const s = withExamples(SECRET, { [R1]: runnerStub() });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  noUnscripted(out);
  const i = out.labels.indexOf(R1);
  assert.ok(i > 0, out.labels.join(", "));
  assert.deepEqual(out.labels.slice(i - 2, i + 3), ["infra:gates:r1", "infra:build-reset:held-out:r1", R1, "infra:build-reset:code-judge:r1", "role:fleet-code-judge:r1"]);
  // the reset runs the runner's PATH check and empties its build dir
  assert.match(call(out, "infra:build-reset:held-out:r1").prompt, /path_check\.py/);
  assert.match(call(out, "infra:build-reset:held-out:r1").prompt, /held-out-r1/);
  const c = call(out, R1);
  assert.equal(c.opts.agentType, "fleet:judge", "read-only agent");
  const io = inputsOf(c.prompt);
  const ref = sealedRef(s, out.planResult.plan_ref);
  assert.deepEqual(io.held_out, ref.held_out);
  assert.equal(io.task_id, ref.task_id);
  assert.equal(io.plan_sha256, ref.plan_sha256);
  assert.match(io.held_out_cmd, /^python3 -I '\/.*\/held_out\.py'$/);
  assert.match(io.scratch_copy_cmd, /scratch_copy\.py/);
  assert.equal(io.code_tree, FP_K1.tree);
  assert.deepEqual(io.test_cmd, ref.plan_facts.test_cmd);
  assert.match(io.test_env.PYTHONPYCACHEPREFIX, /\/held-out-r1\//, "the runner's own build dir");
  assert.ok(!c.prompt.includes(SENTINEL));
  // the judge gets the per-index result only
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cj.held_out_results, { status: "ran", reason: null, results: [{ criterion: "AC1", index: 0, pass: true }, { criterion: "AC1", index: 1, pass: true }, { criterion: "AC2", index: 0, pass: true }] });
  assert.ok(!hoGate(out), JSON.stringify(out.result.gates_not_run));
  assert.ok(out.logs.includes("gate held_out: ran (3 of 3 pass)"), out.logs.join("\n"));
});

test("8.0.0 G4-2 (sentinel): a fail plus an approve -> fix_code 'criterion AC1 fails a hidden example'; the sentinel reaches no prompt, log, result, PR body or judge input", async () => {
  // a hostile runner: the sentinel in reason, memory_notes and an extra key of a result item
  const hostile = (prompt) => {
    const r = runnerStub((c, i) => c === "AC1" && i === 1, { reason: "AC1 fails: " + SENTINEL, memory_notes: [SENTINEL] })(prompt);
    r.results[1].when = SENTINEL;
    return r;
  };
  const s = withExamples(SECRET, Object.assign({ [R1]: hostile, "role:fleet-code-judge:r1": approve(), "role:fleet-held-out-runner:r2": runnerStub() }, R2));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.includes("code round 1: held_out gate: approve -> fix_code (AC1)"), out.logs.join("\n"));
  const c2 = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.deepEqual(c2.routed_findings, [{ target: "code", criterion: "AC1", finding: "criterion AC1 fails a hidden example" }]);
  // the judge saw criterion, index and pass only
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  assert.deepEqual(cj.held_out_results.results[1], { criterion: "AC1", index: 1, pass: false });
  assert.equal(cj.held_out_results.status, "ran");
  assert.ok(!hoGate(out), "round 2 all pass");
  const carriers = [];
  for (const c of out.calls) {
    assert.ok(!c.prompt.includes(SENTINEL), c.label + ": raw sentinel in the prompt");
    if (decoded(c.prompt).includes(SENTINEL)) carriers.push(c.label);
  }
  assert.deepEqual(carriers, ["infra:held-out:write"], "decoded, only the plan's write step carries the examples");
  assert.ok(!out.logs.some((l) => l.includes(SENTINEL)), "the gate log");
  for (const r of [out.planResult, out.result]) assert.ok(!JSON.stringify(r).includes(SENTINEL), "a result (memory_notes too)");
  assert.ok(!JSON.stringify(inputsOf(call(out, "role:fleet-pr-opener").prompt)).includes(SENTINEL), "the PR body inputs");
});

test("8.0.0 G4-3: a missing store file -> held_out not_run 'store file missing on this machine'; the judge sees it; the run goes on", async () => {
  const s = withExamples(SECRET, { [R1]: (p) => ({ status: "ok", reason: "missing", store: "missing", store_digest: null, results: null }) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(hoGate(out), { gate: "held_out", reason: "store file missing on this machine" });
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).held_out_results, { status: "not_run", reason: "store file missing on this machine" });
  // the harness default is the same (no store on the test machine)
  const d = await run(withExamples(SECRET), ARGS);
  assert.deepEqual(hoGate(d), { gate: "held_out", reason: "store file missing on this machine" });
});

test("8.0.0 G4-4: a store that does not match the seal, a store_digest off the seal, an incomplete or malformed result list -> needs_human at gate gates; no agent text in the reason", async () => {
  const cases = [
    [() => ({ status: "ok", reason: SENTINEL, store: "mismatch", store_digest: null, results: null }), /held_out\.py show: store mismatch$/],
    [() => ({ status: "ok", reason: SENTINEL, store: "error", store_digest: null, results: null }), /held_out\.py show: store error$/],
    [runnerStub(null, { store_digest: "0".repeat(64) }), /store_digest off the seal/],
    [(p) => Object.assign(runnerStub()(p), { results: runnerStub()(p).results.slice(1) }), /results off the sealed per_criterion/],
    [(p) => Object.assign(runnerStub()(p), { results: runnerStub()(p).results.concat([{ criterion: "AC1", index: 0, pass: true }]) }), /results off the sealed/],
    [(p) => Object.assign(runnerStub()(p), { results: runnerStub()(p).results.map((x, i) => (i ? x : Object.assign({}, x, { criterion: SENTINEL }))) }), /results off the sealed/],
    [(p) => Object.assign(runnerStub()(p), { results: runnerStub()(p).results.map((x, i) => (i ? x : Object.assign({}, x, { index: "0" }))) }), /results off the sealed/],
    [(p) => Object.assign(runnerStub()(p), { results: runnerStub()(p).results.map((x, i) => (i ? x : Object.assign({}, x, { pass: "yes" }))) }), /results off the sealed/],
    [(p) => Object.assign(runnerStub()(p), { results: null }), /results off the sealed/],
  ];
  for (const [stub, why] of cases) {
    const out = await run(withExamples(SECRET, { [R1]: stub }), ARGS);
    assert.equal(out.result.status, "needs_human", why + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "gates", out.result.reason);
    assert.match(out.result.reason, why);
    assert.ok(!JSON.stringify(out.result).includes(SENTINEL), out.result.reason);
    assert.ok(!out.labels.includes("role:fleet-code-judge:r1"), "no judge");
  }
  // a runner that fails, or drifts from its contract: a fixed-text stop, no retry
  for (const [stub, st, gate] of [
    [{ status: "failed", reason: SENTINEL }, "failed", "role"],
    [{ status: "needs_human", reason: SENTINEL }, "needs_human", "role"],
    [{ status: "ok", reason: SENTINEL, store: SENTINEL, store_digest: null, results: null }, "needs_human", "contract"],
    [{ __raw: true, status: "ok", reason: SENTINEL, store: "ok" }, "needs_human", "contract"],
  ]) {
    const out = await run(withExamples(SECRET, { [R1]: stub }), ARGS);
    assert.equal(out.result.status, st, JSON.stringify(stub) + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, gate, out.result.reason);
    assert.ok(!JSON.stringify(out.result).includes(SENTINEL), out.result.reason);
    assert.ok(!out.labels.includes(R1 + ":retry"));
  }
});

test("8.0.0 G4-5: a runner that changes the main worktree hits the fingerprint stop", async () => {
  // the judge's post-hasher compares with the post-coder state: the runner ran between them
  const s = withExamples(SECRET, { [R1]: runnerStub(), "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: { head: FP_K1.head, tree: "RUNNER-WROTE" } } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "fingerprint");
  // the stop names the judge whose fp-post hasher found the change (the runner and the gate step ran before it)
  assert.match(out.result.reason, /^judge mutated worktree: fleet-code-judge \(role:fleet-code-judge:r1\) changed tree/);
});

test("8.0.0 G4: a null seal, an old ref and a re-plan dispatch no runner and give their own not_run reasons", async () => {
  // nothing sealed (the planner gave no example)
  let out = await run(withExamples([]), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /held-out-runner|build-reset:held-out/.test(l)), out.labels.join(", "));
  assert.deepEqual(hoGate(out), { gate: "held_out", reason: "no held-out example sealed" });
  assert.deepEqual(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).held_out_results, { status: "not_run", reason: "no held-out example sealed" });
  // an older ref: no key
  let s = withExamples(SECRET);
  let t = reseal(s, await planRefFor(s), (r) => delete r.held_out);
  out = await runOne(s, buildArgs(t));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => /held-out-runner/.test(l)));
  assert.deepEqual(hoGate(out), { gate: "held_out", reason: "a pre-8.0.0 plan ref" });
  // a re-planned ref: null, replans > 0
  s = withExamples(SECRET);
  t = reseal(s, await planRefFor(s), (r) => {
    r.held_out = null;
    r.history.replans = 1;
  });
  out = await runOne(s, buildArgs(t));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(hoGate(out), { gate: "held_out", reason: "not stored on a re-plan" });
});

test("8.0.0 G4: heldOutProblem refuses a sealed sha256 that is not a string (an array coerces to hex)", async () => {
  const s = withExamples(SECRET);
  const t = reseal(s, await planRefFor(s), (r) => {
    r.held_out = { sha256: ["e".repeat(64)], count: 3, per_criterion: { AC1: 2, AC2: 1 } };
  });
  const out = await runOne(s, buildArgs(t));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /held_out is malformed/);
});

// ---------------------------------------------------------------- security review: leaks through the run's dirs

test("8.0.0 G4 (security review): the runner gets a private HOME, TMPDIR and XDG_* under its own build dir; the code judge's env differs", async () => {
  const out = await run(withExamples(SECRET, { [R1]: runnerStub() }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const io = inputsOf(call(out, R1).prompt);
  const cj = inputsOf(call(out, "role:fleet-code-judge:r1").prompt);
  const dir = io.test_env.PYTHONPYCACHEPREFIX.replace(/\/[^/]+$/, "");
  assert.match(dir, /\/held-out-r1$/);
  for (const k of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    assert.ok(io.test_env[k].startsWith(dir + "/"), k + ": " + io.test_env[k]);
    assert.notEqual(io.test_env[k], cj.test_env[k], k);
    assert.ok(io.test_env_prefix.includes(k + "='" + io.test_env[k] + "'"), k + " in test_env_prefix");
  }
  // the role runs held_out.py show outside that env (the store is under the real XDG_CONFIG_HOME)
  const t = readFileSync(join(HERE, "..", "roles", RUNNER + ".md"), "utf8");
  assert.match(t, /never with `test_env`/);
});

test("8.0.0 G4 (security review): the held-out build dir is gone before any later step: the next reset deletes the whole build root; a stop runs the teardown", async () => {
  // the real program: a sentinel the code under test wrote into held-out-r1 is gone after the code judge's reset
  const d = mkdtempSync(join(tmpdir(), "fleet-g4-"));
  try {
    const sc = join(d, "scratch");
    mkdirSync(join(sc, "build", "n1", "held-out-r1", "home"), { recursive: true });
    writeFileSync(join(sc, "build", "n1", "held-out-r1", "home", "leak"), SENTINEL);
    const r = spawnSync("python3", ["-I", join(HERE, "..", "scripts", "build_dir.py"), "reset", sc, "n1", "cjudge-r1"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(sc, "build", "n1", "held-out-r1")), "held-out-r1 is deleted");
    assert.deepEqual(readdirSync(join(sc, "build", "n1")), ["cjudge-r1"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  // the workflow: right after every runner comes a build reset (pass, fail, missing store); a fail reaches coder r2 only after it
  const stubs = { all: runnerStub(), fail: runnerStub((c, i) => c === "AC1" && i === 0), missing: { status: "ok", reason: "m", store: "missing", store_digest: null, results: null } };
  for (const [name, st] of Object.entries(stubs)) {
    const out = await run(withExamples(SECRET, Object.assign({ [R1]: st, "role:fleet-code-judge:r1": approve(), "role:fleet-held-out-runner:r2": runnerStub() }, R2)), ARGS);
    assert.equal(out.result.status, "ok", name + ": " + out.result.reason);
    for (const [i, l] of out.labels.entries()) if (/^role:fleet-held-out-runner:/.test(l)) assert.match(out.labels[i + 1], /^infra:build-reset:/, name + ": " + out.labels[i + 1]);
  }
  // a stop at the runner: the teardown still removes the build root
  for (const st of [{ status: "failed", reason: "x" }, () => ({ status: "ok", reason: "x", store: "mismatch", store_digest: null, results: null })]) {
    const out = await run(withExamples(SECRET, { [R1]: st }), ARGS);
    assert.notEqual(out.result.status, "ok");
    assert.equal(out.build.labels[out.build.labels.length - 1], "infra:build-clean", out.build.labels.join(", "));
  }
});
