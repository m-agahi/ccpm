// fleet 7.4.0 (#22 cap part, L2029): writer rounds past 50 changed keys.
// hash_diff.py lists at most 50 changed rows. Past 50, the workflow added a `more` row, and the
// writer-round check and the re-freeze loop turned it into a mangled violation name
// ("files: (10 more)"), so 60 writer-owned test files halted the run.
//
// Now hash_diff.py takes `--allow <JSON list of "<map>:<key>">` (right after <scratch>): the
// round's own test files. `changed` and `total` cover only the keys outside the list (still capped
// at 50); `allowed` (at most 50 rows) and `allowed_changed` (their count) cover the listed keys.
// The writer round and the re-freeze pass the list. A `more` row now means more than 50 keys
// OUTSIDE the list and stops with "more than 50 changed files outside the round's test files
// (<n> more)". The writer-round halt names every unowned changed path, not only the first.
//
// dont_care: the order of the names in a halt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, inputsOf, spawnSync, sha256, canon, registerMap, hashDiffOut, H, HASHES, FP_PRE, FP_TESTS, FP_K1, FP_K2, FP_M3 } from "./harness.mjs";

const DIFF = join(SCRIPTS_SRC, "hash_diff.py");
const tf = (i) => "tests/test_" + String(i).padStart(2, "0") + ".py";
const of = (i) => "src/o" + String(i).padStart(2, "0") + ".py";

function store() {
  const home = mkdtempSync(join(tmpdir(), "fleet-740-hd-"));
  mkdirSync(join(home, "hashes"));
  const write = (m, map) => {
    const text = canon(map);
    writeFileSync(join(home, "hashes", m + "-" + sha256(text) + ".json"), text);
    registerMap(join(home, "hashes", m + "-" + sha256(text) + ".json"), map);
    return sha256(text).slice(0, 12);
  };
  const prog = (args) => spawnSync("python3", ["-I", DIFF].concat(args), { encoding: "utf8" });
  return { home, write, prog, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("7.4.0 #22 W1: hash_diff --allow lists only the keys outside the list; the listed ones are counted apart", () => {
  const st = store();
  try {
    const a = {};
    const b = {};
    for (let i = 0; i < 60; i++) b[tf(i)] = "x" + i;
    for (let i = 0; i < 3; i++) b[of(i)] = "o" + i;
    const allow = JSON.stringify(Array.from({ length: 60 }, (_, i) => "files:" + tf(i)));
    const args = [st.home, "--allow", allow, "files", st.write("files", a), st.write("files", b)];
    const r = st.prog(args);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.changed, [0, 1, 2].map((i) => ["files", of(i), "added"]));
    assert.equal(o.total, 3);
    assert.equal(o.allowed_changed, 60);
    assert.equal(o.allowed.length, 50);
    assert.deepEqual(o.allowed[0], ["files", tf(0), "added"]);
    assert.deepEqual(o.args, args);
    // the harness stub agrees with the program
    const stub = hashDiffOut(args);
    for (const k of ["changed", "total", "allowed", "allowed_changed", "counts", "resolved", "error", "args"]) assert.deepEqual(stub[k], o[k], k);
  } finally {
    st.done();
  }
});

test("7.4.0 #22: hash_diff without --allow: the rows are as before, allowed is empty", () => {
  const st = store();
  try {
    const big = {};
    for (let i = 0; i < 60; i++) big[tf(i)] = String(i);
    const o = JSON.parse(st.prog([st.home, "files", st.write("files", {}), st.write("files", big)]).stdout);
    assert.deepEqual([o.changed.length, o.total, o.allowed_changed], [50, 60, 0]);
    assert.deepEqual(o.allowed, []);
  } finally {
    st.done();
  }
});

test("7.4.0 #22: hash_diff refuses a malformed allow list (exit non-zero, nothing listed)", () => {
  const st = store();
  try {
    const h = [st.write("files", {}), st.write("files", { a: "1" })];
    for (const bad of ["not json", "{}", '["a"]', '["nomap:a"]', "[1]", '["files:"]']) {
      const r = st.prog([st.home, "--allow", bad, "files", h[0], h[1]]);
      assert.notEqual(r.status, 0, bad);
      assert.equal(r.stdout, "", bad);
    }
    // --allow anywhere else is not a map name
    assert.notEqual(st.prog([st.home, "files", h[0], h[1], "--allow", "[]"]).status, 0);
  } finally {
    st.done();
  }
});

// ---------------------------------------------------------------- the writer round

function bigRound(extra) {
  const files = Array.from({ length: 60 }, (_, i) => tf(i));
  const crit = [{ id: "AC1", text: "behaviour 1", test_files: files }];
  const pre = { "pyproject.toml#tool.pytest": "hp" };
  const post = Object.assign({}, pre);
  for (const f of files) post[f] = "w";
  for (const f of extra) post[f] = "x";
  const s = happy({ criteria: crit });
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: FP_PRE, hashes: H(pre) };
  s["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: files.concat(extra), hashes: H(post) };
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_TESTS, hashes: H(post) };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: H(post) };
  return s;
}

test("7.4.0 #22 W1: 60 changed writer test files, all the round's own: no violation, no halt", async () => {
  const out = await run(bigRound([]), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = out.calls.find((x) => x.label === "infra:hash-diff:writers:r1");
  assert.ok(c, out.labels.join(", "));
  const a = inputsOf(c.prompt).args;
  assert.equal(a[1], "--allow");
  assert.deepEqual(JSON.parse(a[2]).length, 60);
  assert.ok(out.logs.some((l) => /test round 1: writers ok: AC1; 60 owned path\(s\) changed/.test(l)), out.logs.join("\n"));
});

test("7.4.0 #22 W2: 3 changed non-test files among 60: the halt names those 3", async () => {
  const out = await run(bigRound([of(0), of(1), of(2)]), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ownership");
  for (const p of [of(0), of(1), of(2)]) assert.ok(out.result.reason.includes(p), out.result.reason);
  assert.doesNotMatch(out.result.reason, /more\)/);
});

test("7.4.0 #22 W2: 55 changed non-test files: the halt says more than 50 outside the round's test files", async () => {
  const out = await run(bigRound(Array.from({ length: 55 }, (_, i) => of(i))), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /more than 50 changed files outside the round's test files \(5 more\)/);
  assert.doesNotMatch(out.result.reason, /files: \(\d+ more\)/);
});

test("7.4.0 #22 non-weakening: a non-test file among few changes still halts with its name (as before)", async () => {
  const out = await run(bigRound([of(7)]), ARGS);
  assert.equal(out.result.stop_gate, "ownership");
  assert.ok(out.result.reason.startsWith("writer touched " + of(7) + " in test round 1 (not a test file of AC1)"), out.result.reason);
});

// ---------------------------------------------------------------- re-freeze, and forged relays

function refreeze(after) {
  const testFinding = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const h = after || HASHES;
  return happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [testFinding] },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [testFinding] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1" },
      "hasher:post-writers:r3": { status: "ok", fingerprint: FP_M3, changed: ["tests/test_a.py"], hashes: h },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3 },
      "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: h },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: FP_K2, hashes: h },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: FP_K2 },
    },
  });
}

test("7.4.0 #22: a re-freeze with no changed map logs 0 changed test files (never NaN)", async () => {
  const out = await run(refreeze(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.includes("re-freeze after fix_tests (code round 1): 0 frozen test file(s) changed"), out.logs.filter((l) => /re-freeze/.test(l)).join("\n"));
});

test("7.4.0 #22: a re-freeze with one changed test file passes --allow and logs it", async () => {
  const out = await run(refreeze(H({ "tests/test_a.py": "ha2", "tests/test_b.py": "hb", "pyproject.toml#tool.pytest": "hp" })), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.refreeze_log[0].changed, [{ path: "tests/test_a.py", change: "changed" }]);
  const a = inputsOf(out.calls.find((c) => c.label === "infra:hash-diff:refreeze:f2").prompt).args;
  assert.deepEqual(a.slice(1, 3), ["--allow", JSON.stringify(["files:tests/test_a.py"])]);
  assert.ok(out.logs.includes("re-freeze after fix_tests (code round 1): 1 frozen test file(s) changed"));
});

// non-weakening: the workflow checks the relay's split; a forged split fails closed
test("7.4.0 #22 non-weakening: a relay that lists a non-test file as allowed, or an owned file as changed, fails closed at ownership", async () => {
  // a non-test change only the hash map sees (the tree list hides it), forged into allowed
  const s1 = bigRound(["src/evil.py"]);
  const pw = s1["hasher:post-writers:r1"];
  s1["hasher:post-writers:r1"] = Object.assign({}, pw, { changed: pw.changed.filter((p) => p !== "src/evil.py") });
  const honest = await run(s1, ARGS);
  assert.equal(honest.result.stop_gate, "ownership", "the honest relay names src/evil.py");
  assert.match(honest.result.reason, /src\/evil\.py/);
  s1["infra:hash-diff:writers:r1"] = (p) => {
    const o = hashDiffOut(inputsOf(p).args);
    return Object.assign({ status: "ok", reason: "x" }, o, { changed: [], total: 0, allowed: [["files", "src/evil.py", "changed"]].concat(o.allowed).slice(0, 50), allowed_changed: o.allowed_changed + 1 });
  };
  const f1 = await run(s1, ARGS);
  assert.deepEqual([f1.result.status, f1.result.stop_gate], ["needs_human", "ownership"], f1.result.reason);
  assert.match(f1.result.reason, /no usable key list/);
  for (const f of [
    (o) => Object.assign(o, { changed: o.allowed.concat(o.changed), total: o.total + o.allowed_changed, allowed: [], allowed_changed: 0 }),
    (o) => Object.assign(o, { allowed_changed: null }),
  ]) {
    const s = bigRound([]);
    s["infra:hash-diff:writers:r1"] = (p) => Object.assign({ status: "ok", reason: "x" }, f(hashDiffOut(inputsOf(p).args)));
    const out = await run(s, ARGS);
    assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "ownership"], f.toString() + ": " + out.result.reason);
  }
});

test("7.4.0 #22 logPath: unowned paths in a writer halt have control and line-separator characters as ?", async () => {
  for (const [bad, shown] of [["src/a\nWRITER ok", "src/a?WRITER ok"], ["src/b\u2028x", "src/b?x"], ["src/c\u0085y", "src/c?y"], ["src/d\x7fz", "src/d?z"]]) {
    const out = await run(bigRound([bad]), ARGS);
    assert.equal(out.result.stop_gate, "ownership", bad);
    assert.ok(out.result.reason.includes(shown), JSON.stringify(out.result.reason));
    assert.ok(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(out.result.reason), JSON.stringify(out.result.reason));
  }
  // and in the past-the-cap list
  const out = await run(bigRound(["src/n\nl"].concat(Array.from({ length: 55 }, (_, i) => of(i)))), ARGS);
  assert.match(out.result.reason, /more than 50 changed files outside/);
  assert.ok(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(out.result.reason), JSON.stringify(out.result.reason));
});
