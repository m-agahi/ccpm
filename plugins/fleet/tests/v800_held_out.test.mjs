// fleet 8.0.0 car G3: the held-out store, plan side (#6, gate 3; threat model ADR-1152).
// held_out.py write <worktree> <task id> <plan_path> <plan_sha256> <chunk dir> <n> <expected> <shas>
// reads the planner's held-out examples (and each criterion's visible examples list) from base64 chunk files
// under the run's scratch dir, drops an example whose `when` and `then` both appear verbatim in the
// plan doc or that equals a visible example (given, when and then all equal), and stores the rest in
// $XDG_CONFIG_HOME/fleet/held-out/<task id>/<plan_sha256>.json (dir 0700, file 0600, a random
// salt). It prints {sha256 (of the file bytes), count, per_criterion, dropped, args}; the dropped list
// carries criterion and index only. The chunk dir is removed on every exit. One plan-mode agent
// (infra:held-out:write, sonnet, a write step: no digest retry) runs it after the plan is staged;
// the plan ref seals only {sha256, count, per_criterion}, or held_out null when the write fails.
// held_out.py show <task id> <plan_sha256> <sealed sha256> prints the examples only when the file
// hashes to the sealed sha256 (G4's runner role).
//
// ACs (plan-8.0.0-gates.md, G3):
// - G3-1: the file exists with those modes, and the ref holds held_out.sha256.
// - G3-2 (sentinel, non-weakening): a sentinel string in an example appears in no role prompt, plan
//   ref, run-state chunk, result or PR body (decoded: only the write step's own chunks carry it).
// - G3-3: an example copied into the plan doc is dropped and logged.
// - G3-4: a write failure gives held_out: null in the ref, and the build reports not_run.
// - G3-5: planRefProblem accepts a ref without the key (old refs) and refuses a malformed one.
//
// Program tests use a temp XDG_CONFIG_HOME and umask 000 (the modes must come from the program).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, HAVE_PY, SOURCE, ARGS, happy, run, runOne, inputsOf, call, sha256, canon, spawnSync, planRefFor, buildArgs, writerChunksOf } from "./harness.mjs";

const PROG = join(HERE, "..", "scripts", "held_out.py");
const PY = HAVE_PY ? spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : null;
const SENTINEL = "ZQX-HELDOUT-SENTINEL-7731";
const TASK = "y42";
const DOC = "# plan\n\nAC1: given g, when f(1), then 2.\nIt also says f(5) and 25 somewhere.\n";

// a run root <d>: <d>/main (the worktree, holding the plan doc), <d>/scratch/chunks/held-out-t, <d>/xdg
function root() {
  const d = mkdtempSync(join(tmpdir(), "fleet-g3-"));
  mkdirSync(join(d, "main", "docs", "plans"), { recursive: true });
  writeFileSync(join(d, "main", "docs", "plans", "x.md"), DOC);
  mkdirSync(join(d, "scratch", "chunks", "held-out-t"), { recursive: true });
  return d;
}
// the payload as chunk files and the write args
function chunks(d, payload, mut) {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const parts = [];
  for (let i = 0; i < b64.length; i += 4000) parts.push(b64.slice(i, i + 4000));
  const dir = join(d, "scratch", "chunks", "held-out-t");
  mkdirSync(dir, { recursive: true });
  parts.forEach((p, i) => writeFileSync(join(dir, i + ".b64"), mut ? mut(i, p) : p));
  const shas = parts.map((p, i) => ({ i, sha256: sha256(p) }));
  return [join(d, "main"), TASK, "docs/plans/x.md", sha256(DOC), dir, String(parts.length), sha256(JSON.stringify(payload)), JSON.stringify(shas)];
}
// runs the program with umask 000, HOME and XDG_CONFIG_HOME of the test's choice
function prog(args, env) {
  const old = process.umask(0);
  try {
    return spawnSync(PY, ["-I", PROG].concat(args), { encoding: "utf8", env: Object.assign({ PATH: "/nonexistent" }, env) });
  } finally {
    process.umask(old);
  }
}
const ex = (cid, when, then, given) => ({ criterion_id: cid, given: given === undefined ? "g" : given, when, then });
const VISIBLE = [[{ given: "g", when: "f(4)", then: "16", kind: "main" }], null];
const storeFile = (d, sha) => join(d, "xdg", "fleet", "held-out", TASK, sha + ".json");
const mode = (p) => statSync(p).mode & 0o777;
const XENV = (d) => ({ HOME: join(d, "home"), XDG_CONFIG_HOME: join(d, "xdg") });

test("8.0.0 G3-1: write stores the kept examples at $XDG_CONFIG_HOME/fleet/held-out/<task>/<plan_sha256>.json (dir 0700, file 0600, salted); sha256 is the file's", { skip: !HAVE_PY }, () => {
  const d = root();
  try {
    const payload = { examples: [ex("AC1", "f(9)", "81"), ex("AC2", "h(0)", "x"), ex("AC1", "f(3)", "9")], visible: VISIBLE };
    const a = chunks(d, payload);
    const r = prog(["write"].concat(a), XENV(d));
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(o).sort(), ["args", "count", "digest", "dropped", "per_criterion", "program", "sha256"]);
    assert.equal(o.count, 3);
    assert.deepEqual(o.per_criterion, { AC1: 2, AC2: 1 });
    assert.deepEqual(o.dropped, []);
    assert.deepEqual(o.args, a);
    assert.deepEqual(o.program.name, "held_out");
    const { digest, ...rest } = o;
    assert.equal(digest, sha256(canon(rest)), "the digest covers every other key");
    const f = storeFile(d, sha256(DOC));
    assert.ok(existsSync(f), f);
    const bytes = readFileSync(f);
    assert.equal(o.sha256, sha256(bytes), "sha256 is the hash of the file bytes, salt included");
    assert.equal(mode(f), 0o600);
    assert.equal(mode(join(d, "xdg", "fleet", "held-out", TASK)), 0o700);
    assert.equal(mode(join(d, "xdg", "fleet", "held-out")), 0o700);
    const stored = JSON.parse(bytes.toString("utf8"));
    assert.match(stored.salt, /^[0-9a-f]{32}$/);
    assert.deepEqual(stored.examples.map((e) => e.when), ["f(9)", "h(0)", "f(3)"]);
    assert.ok(!existsSync(a[4]), "the chunk dir is removed");
    // a second write of the same examples: a new salt, a new sha256
    const r2 = prog(["write"].concat(chunks(d, payload)), XENV(d));
    assert.equal(r2.status, 0, r2.stderr);
    assert.notEqual(JSON.parse(r2.stdout).sha256, o.sha256);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G3-3: an example whose when and then both appear in the plan doc, or that equals a visible example, is dropped; the list holds criterion and index only", { skip: !HAVE_PY }, () => {
  const d = root();
  try {
    const payload = {
      examples: [ex("AC1", "f(5)", "25"), ex("AC1", "f(4)", "16"), ex("AC1", "f(5)", SENTINEL), ex("AC2", SENTINEL, "x"), { criterion_id: "AC2", given: "g", when: 7, then: "x" }],
      visible: VISIBLE,
    };
    const r = prog(["write"].concat(chunks(d, payload)), XENV(d));
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.dropped, [
      { criterion: "AC1", index: 0, why: "in the plan doc" },
      { criterion: "AC1", index: 1, why: "equals a visible example" },
      { criterion: "AC2", index: 4, why: "malformed" },
    ]);
    assert.equal(o.count, 2);
    assert.deepEqual(o.per_criterion, { AC1: 1, AC2: 1 });
    assert.ok(!r.stdout.includes("f(5)") && !r.stdout.includes("25\"") && !r.stdout.includes(SENTINEL), "no example text on stdout");
    // a given that differs: not the visible example
    const r2 = prog(["write"].concat(chunks(d, { examples: [ex("AC1", "f(4)", "16", "other")], visible: VISIBLE })), XENV(d));
    assert.deepEqual(JSON.parse(r2.stdout).dropped, []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G3-2 (sentinel): the program's stdout and stderr never carry example text; the store file does", { skip: !HAVE_PY }, () => {
  const d = root();
  try {
    const r = prog(["write"].concat(chunks(d, { examples: [ex("AC1", "f(9)", SENTINEL)], visible: VISIBLE })), XENV(d));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
    const o = JSON.parse(r.stdout);
    assert.ok(readFileSync(storeFile(d, sha256(DOC)), "utf8").includes(SENTINEL));
    // every refusal is fixed wording: a payload that is no list, a bad sha list, a doc that moved
    for (const [mk, why] of [
      [() => chunks(d, { examples: SENTINEL, visible: [] }), /not \{examples, visible\}/],
      [() => chunks(d, { examples: [ex("AC1", "f(9)", SENTINEL)], visible: [] }).map((x, i) => (i === 7 ? JSON.stringify([{ i: 0, sha256: SENTINEL }]) : x)), /bad chunk sha256 list$/],
      [() => chunks(d, { examples: [ex("AC1", "f(9)", SENTINEL)], visible: [] }).map((x, i) => (i === 3 ? "b".repeat(64) : x)), /plan doc does not hash/],
    ]) {
      const args = mk();
      const e = prog(["write"].concat(args), XENV(d));
      assert.notEqual(e.status, 0);
      assert.match(e.stderr.trim(), why);
      assert.ok(!e.stdout.includes(SENTINEL) && !e.stderr.includes(SENTINEL), e.stderr);
      assert.ok(!existsSync(args[4]), "the chunk dir is removed on a refusal too");
    }
    // show prints the examples only for the sealed sha256
    const s = prog(["show", TASK, sha256(DOC), o.sha256], XENV(d));
    assert.equal(s.status, 0, s.stderr);
    const so = JSON.parse(s.stdout);
    assert.deepEqual(so.examples, [ex("AC1", "f(9)", SENTINEL)]);
    assert.equal(so.sha256, o.sha256);
    assert.deepEqual(so.args, [TASK, sha256(DOC), o.sha256]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G3: show refuses without the sealed sha256, with another one, and for a missing file; never prints text then", { skip: !HAVE_PY }, () => {
  const d = root();
  try {
    const o = JSON.parse(prog(["write"].concat(chunks(d, { examples: [ex("AC1", "f(9)", SENTINEL)], visible: [] })), XENV(d)).stdout);
    for (const [args, why] of [
      [["show", TASK, sha256(DOC)], /usage/],
      [["show", TASK, sha256(DOC), "c".repeat(64)], /does not match the sealed sha256/],
      [["show", TASK, "d".repeat(64), o.sha256], /store file missing on this machine/],
      [["show", TASK, sha256(DOC), "nothex"], /bad sealed sha256/],
    ]) {
      const r = prog(args, XENV(d));
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, why);
      assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G3: a relative XDG_CONFIG_HOME is refused (as policy_init); unset falls back to ~/.config; a bad chunk writes nothing", { skip: !HAVE_PY }, () => {
  const d = root();
  try {
    let a = chunks(d, { examples: [ex("AC1", "f(9)", "81")], visible: [] });
    let r = prog(["write"].concat(a), { HOME: join(d, "home"), XDG_CONFIG_HOME: "rel/dir" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /XDG_CONFIG_HOME is relative/);
    assert.ok(!existsSync(a[4]));
    a = chunks(d, { examples: [ex("AC1", "f(9)", "81")], visible: [] });
    r = prog(["write"].concat(a), { HOME: join(d, "home") });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(d, "home", ".config", "fleet", "held-out", TASK, sha256(DOC) + ".json")));
    // a chunk that does not hash to its sha256: no file, the dir removed
    rmSync(join(d, "xdg"), { recursive: true, force: true });
    a = chunks(d, { examples: [ex("AC1", "f(9)", "81")], visible: [] }, (i, p) => p.slice(1));
    r = prog(["write"].concat(a), XENV(d));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /chunk/);
    assert.ok(!existsSync(join(d, "xdg", "fleet", "held-out")));
    assert.ok(!existsSync(a[4]));
    // a chunk dir outside the run's scratch dir is refused and left alone
    const out = mkdtempSync(join(tmpdir(), "fleet-g3-out-"));
    a = chunks(d, { examples: [ex("AC1", "f(9)", "81")], visible: [] });
    r = prog(["write"].concat(a.map((x, i) => (i === 4 ? out : x))), XENV(d));
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(out));
    rmSync(out, { recursive: true, force: true });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("8.0.0 G3: every example dropped: no file, count 0, sha256 null", { skip: !HAVE_PY }, () => {
  const d = root();
  try {
    const r = prog(["write"].concat(chunks(d, { examples: [ex("AC1", "f(4)", "16")], visible: VISIBLE })), XENV(d));
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.sha256, null);
    assert.equal(o.count, 0);
    assert.ok(!existsSync(join(d, "xdg", "fleet", "held-out", TASK)));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the workflow

const VIS_CRIT = (n) =>
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
function withExamples(examples, over) {
  const s = happy(Object.assign({ criteria: VIS_CRIT(2) }, over));
  s["role:scope-and-plan"].held_out_examples = examples;
  return s;
}
const SECRET_EXAMPLES = [ex("AC1", "f(9)", SENTINEL), ex("AC2", "f(0)", "x " + SENTINEL)];
const sealedRef = (s, tiny) => JSON.parse(s.__store[tiny.plan_commit]);
function reseal(s, tiny, edit) {
  const ref = sealedRef(s, tiny);
  edit(ref);
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  return { ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) };
}
const decodedChunks = (prompt) => {
  const c = writerChunksOf(prompt);
  const ids = Object.keys(c).map(Number).sort((a, b) => a - b);
  return ids.length ? Buffer.from(ids.map((i) => c[i]).join(""), "base64").toString("utf8") : "";
};

test("8.0.0 G3-1: plan mode runs infra:held-out:write (sonnet, a write step) after the stage step; the ref seals only {sha256, count, per_criterion}", async () => {
  const s = withExamples(SECRET_EXAMPLES);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const i = out.labels.indexOf("infra:held-out:write");
  assert.ok(i > 0, out.labels.join(", "));
  assert.equal(out.labels[i - 1], "infra:stage-plan");
  assert.equal(out.labels[i + 1], "infra:plan-chunks:r0w0");
  const c = call(out, "infra:held-out:write");
  assert.equal(c.opts.model, "sonnet");
  assert.notEqual(c.opts.agentType, "fleet:judge", "it writes chunk files and the store");
  const io = inputsOf(c.prompt);
  assert.equal(io.task_id, "y42");
  assert.equal(argsOfWrite(c.prompt)[3], "a".repeat(64), "the staged plan sha256");
  assert.match(io.chunk_dir, /\/scratch\/chunks\/held-out-/);
  assert.match(c.prompt, /held_out\.py' 'write'/);
  // the payload: the examples and the plan's visible examples
  const payload = JSON.parse(decodedChunks(c.prompt));
  assert.deepEqual(payload.examples, SECRET_EXAMPLES);
  assert.deepEqual(payload.visible, VIS_CRIT(2).map((k) => k.examples));
  const ref = sealedRef(s, out.result.plan_ref);
  assert.deepEqual(Object.keys(ref.held_out).sort(), ["count", "per_criterion", "sha256"]);
  assert.match(ref.held_out.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ref.held_out.count, 2);
  assert.deepEqual(ref.held_out.per_criterion, { AC1: 1, AC2: 1 });
  assert.ok(out.logs.some((l) => /^held-out: 2 example\(s\) stored \{"AC1":1,"AC2":1\}$/.test(l)), out.logs.join("\n"));
  // no digest retry: a write step
  assert.ok(!out.labels.some((l) => /^infra:held-out:write:/.test(l)));
});

test("8.0.0 G3-2 (sentinel): a held-out example reaches only the write step's own chunks; no prompt, ref, run-state chunk, result or log carries it", async () => {
  const s = withExamples(SECRET_EXAMPLES);
  const out = await run(s, ARGS);
  assert.equal(out.planResult.status, "awaiting_confirmation");
  assert.equal(out.result.status, "ok", out.result.reason);
  const carriers = [];
  for (const c of out.calls) {
    assert.ok(!c.prompt.includes(SENTINEL), c.label + ": raw sentinel in the prompt");
    assert.ok(!c.prompt.includes("held_out_examples"), c.label + ": the prompt names held_out_examples");
    if (decodedChunks(c.prompt).includes(SENTINEL)) carriers.push(c.label);
  }
  assert.deepEqual(carriers, ["infra:held-out:write"], "decoded, only the write step carries the examples");
  // the build read the ref, wrote run-state chunks and opened a PR
  assert.ok(out.build.labels.some((l) => /^infra:state/.test(l)), out.build.labels.join(", "));
  assert.ok(!Object.values(s.__store).some((v) => typeof v === "string" && v.includes(SENTINEL)), "the plan ref");
  for (const r of [out.planResult, out.result]) assert.ok(!JSON.stringify(r).includes(SENTINEL), "a result");
  assert.ok(!out.logs.some((l) => l.includes(SENTINEL)), "the gate log");
  assert.ok(out.build.logs.some((l) => /held_out: 2 example\(s\) sealed/.test(l)), out.build.logs.join("\n"));
});

test("8.0.0 G3-3: the examples the program dropped are logged by criterion and index only", async () => {
  const s = withExamples(SECRET_EXAMPLES);
  s["infra:held-out:write"] = (prompt) => ({ status: "ok", reason: "stored", sha256: "e".repeat(64), count: 1, per_criterion: { AC2: 1 }, dropped: [{ criterion: "AC1", index: 0, why: "in the plan doc" }], args: argsOfWrite(prompt) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.includes('held-out: dropped [{"criterion":"AC1","index":0,"why":"in the plan doc"}]'), out.logs.join("\n"));
  assert.deepEqual(sealedRef(s, out.result.plan_ref).held_out, { sha256: "e".repeat(64), count: 1, per_criterion: { AC2: 1 } });
});
function argsOfWrite(prompt) {
  const m = /held_out\.py'((?: '(?:[^']|'\\'')*')+)/.exec(prompt);
  return [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")).slice(1);
}

test("8.0.0 G3-4: a failed write, a relay off the digest or args, or no example at all seals held_out null; one attempt; the build reports not_run", async () => {
  const cases = [
    [{ status: "failed", reason: "boom " + SENTINEL }, /the store write failed/],
    [(p) => ({ status: "ok", reason: "stored", sha256: "e".repeat(64), count: 2, per_criterion: { AC1: 1, AC2: 1 }, dropped: [], args: argsOfWrite(p), digest: "0".repeat(64) }), /the store write failed/],
    [(p) => ({ status: "ok", reason: "stored", sha256: "e".repeat(64), count: 2, per_criterion: { AC1: 1, AC2: 1 }, dropped: [], args: ["other"] }), /the store write failed/],
    [(p) => ({ status: "ok", reason: "stored", sha256: null, count: 0, per_criterion: {}, dropped: [{ criterion: "AC1", index: 0, why: "malformed" }], args: argsOfWrite(p) }), /^held-out: nothing kept; held_out null$/],
  ];
  for (const [stub, why] of cases) {
    const s = withExamples(SECRET_EXAMPLES);
    s["infra:held-out:write"] = stub;
    const out = await run(s, ARGS);
    assert.equal(out.planResult.status, "awaiting_confirmation", out.planResult.reason);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(out.labels.filter((l) => /^infra:held-out/.test(l)).length, 1, "one attempt");
    assert.ok(out.plan.logs.some((l) => why.test(l)), out.plan.logs.join("\n"));
    assert.ok(!out.logs.some((l) => l.includes(SENTINEL)), "no agent reason is logged");
    assert.equal(sealedRef(s, out.planResult.plan_ref).held_out, null);
    assert.ok(out.build.logs.some((l) => /^held_out: none sealed$/.test(l)), out.build.logs.join("\n"));
    assert.ok(out.result.gates_not_run.some((g) => g.gate === "held_out"));
  }
  // no example: no write step, held_out null
  const s = withExamples([]);
  const out = await runOne(s, ARGS);
  assert.ok(!out.labels.includes("infra:held-out:write"));
  assert.equal(sealedRef(s, out.result.plan_ref).held_out, null);
  assert.ok(out.logs.some((l) => /^held-out: no example; held_out null$/.test(l)), out.logs.join("\n"));
});

test("8.0.0 G3: examples nested in a criterion are not stored (only the top-level list); the gate line says so", async () => {
  const crit = VIS_CRIT(2);
  crit[0].held_out_examples = [ex("AC1", "f(8)", SENTINEL)];
  const s = withExamples([ex("AC2", "f(0)", "x")], { criteria: crit });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(!decodedChunks(call(out, "infra:held-out:write").prompt).includes(SENTINEL));
  assert.ok(out.logs.includes("held-out: a criterion's own list is dropped"), out.logs.join("\n"));
});

test("8.0.0 G3-5: planRefProblem accepts a ref with no held_out key (older refs) and refuses a malformed one", async () => {
  const s = withExamples(SECRET_EXAMPLES);
  const tiny = await planRefFor(s);
  const old = reseal(s, tiny, (r) => {
    delete r.held_out;
  });
  let out = await runOne(s, buildArgs(old));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.some((l) => /^held_out: none sealed$/.test(l)), out.logs.join("\n"));
  const good = { sha256: "e".repeat(64), count: 2, per_criterion: { AC1: 1, AC2: 1 } };
  for (const bad of ["x", [], {}, Object.assign({}, good, { sha256: "nothex" }), Object.assign({}, good, { count: 3 }), Object.assign({}, good, { count: 0, per_criterion: {} }), Object.assign({}, good, { per_criterion: { AC1: "1", AC2: 1 } }), Object.assign({}, good, { examples: [] })]) {
    const s2 = withExamples(SECRET_EXAMPLES);
    const t = reseal(s2, await planRefFor(s2), (r) => {
      r.held_out = bad;
    });
    out = await runOne(s2, buildArgs(t));
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.match(out.result.reason, /plan ref missing or changed.*held_out is malformed/);
  }
});

test("8.0.0 G3: the program wiring: one slot, keys per mode, sonnet tier, off the read-only digest-retry list", () => {
  assert.match(SOURCE, /\[\/\^infra:held-out:write\/, \[\[null, "held_out"\]\]\]/);
  assert.match(SOURCE, /"held_out:write": \["sha256", "count", "per_criterion", "dropped", "args"\]/);
  assert.match(SOURCE, /"held_out:show": \["examples", "sha256", "args"\]/);
  assert.match(SOURCE, /\["infra:held-out", "sonnet"\]/);
});
