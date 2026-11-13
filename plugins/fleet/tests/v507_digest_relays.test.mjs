// fleet 5.0.7 (ledger 2020): no relayed field carries a per-file hash.
//
// Run wf_108c5076-e06 (yadgarhq/iam-db, fleet 5.0.6) failed at
// hasher:fp-post:test-judge:r1: the relay agent copied the 19-entry files map
// and the git map of 64-hex values and mis-copied one, so the digest check
// failed. 5.0.5 had moved only the ignored map to disk.
//
// - hasher.py writes every map to <scratch>/hashes/<map>-<sha256>.json and
//   relays {count, sha256, file} per map (git: plus its inline hooks path and
//   run-state refs; ignored: plus settings), and {count, sha256} of the
//   shipped programs' map.
// - hash_diff.py lists the changed [map, key, kind] rows between two states,
//   from the verified files, for every step that routes by key.
// - A program relay that fails only on its digest is dispatched once more.
//
// The non-weakening table below was recorded by running these scenarios
// through the 5.0.6 workflow (harness stubs, no model in between).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { happy, run, ARGS, H, HASHES_FLAT, FP_PRE, FP_TESTS, FP_K1, FP_K2, FP_M3, inputsOf, call, sh, spawnSync, SCRIPTS_SRC, HASH_MAP_NAMES, sha256, canon, registerMap, hashDiffOut, tfGateRelay } from "./harness.mjs";

const HASHER = join(SCRIPTS_SRC, "hasher.py");

export const BASE_FLAT = { ...HASHES_FLAT, "conftest.py": "hc", "git:config:local": "g1" };
export function base() {
  const h = H(BASE_FLAT);
  h.ignored = { "build.log": "i1" };
  h.symlinks = { lib: "../x" };
  return h;
}
export const KINDS = {
  file: (h) => (h.files["conftest.py"] = "hc2"),
  section: (h) => (h.sections["pyproject.toml#tool.pytest"] = "hp2"),
  git: (h) => (h.git["config:local"] = "g2"),
  ignored: (h) => (h.ignored["build.log"] = "i2"),
  symlink: (h) => (h.symlinks.lib = "../y"),
  added: (h) => (h.files["tests/conftest.py"] = "hn"),
  deleted: (h) => delete h.files["conftest.py"],
};
const CODER2 = { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: false, suite_result: { command: "pytest", exit_code: 0 } };
const CJ = { status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } };
export function scenario(site, kind) {
  const s = happy();
  const mod = base();
  KINDS[kind](mod);
  const at = (x) => (site === x ? mod : base());
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: FP_PRE, hashes: base() };
  const pw = s["hasher:post-writers:r1"];
  s["hasher:post-writers:r1"] = (p) => Object.assign(pw(p), { hashes: at("writers") });
  s["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: FP_TESTS, hashes: at("judge") };
  s["hasher:freeze:f1"] = { status: "ok", fingerprint: FP_TESTS, hashes: base() };
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: at("coder") };
  s["hasher:fp-post:code-judge:r1"] = { status: "ok", fingerprint: FP_K1, hashes: base() };
  s["role:fleet-coder:r2"] = CODER2;
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: FP_K2, hashes: base() };
  s["role:fleet-code-judge:r2"] = CJ;
  s["hasher:fp-post:code-judge:r2"] = { status: "ok", fingerprint: FP_K2, hashes: base() };
  return s;
}
// a fix_tests round whose test judge also routes AC2: AC2's writer changes
// its test (owned, so the writers pass), the re-freeze allows AC1's only
export function refreezeScenario() {
  const AC1 = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const AC2 = { target: "tests", criterion: "AC2", finding: "also wrong" };
  const after = base();
  after.files["tests/test_a.py"] = "ha2";
  after.files["tests/test_b.py"] = "hb2";
  const s = scenario("none", "file");
  Object.assign(s, {
    "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [AC1] },
    "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [AC1, AC2] },
    "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1, hashes: base() },
    "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1", files: ["tests/test_a.py"] },
    "role:fleet-test-writer:AC2:r3": { status: "ok", criterion_id: "AC2", files: ["tests/test_b.py"] },
    "hasher:post-writers:r3": { status: "ok", fingerprint: FP_M3, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: after },
    "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
    "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: FP_M3, hashes: after },
    "hasher:freeze:f2": { status: "ok", fingerprint: FP_M3, hashes: after },
  });
  return s;
}
export async function outcome(s) {
  const out = await run(s, ARGS);
  const o = { status: out.result.status, gate: out.result.stop_gate, reason: out.result.reason };
  if (out.labels.includes("role:fleet-coder:r2")) o.coder2 = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings.map((f) => f.finding);
  return o;
}
export const SITES = ["writers", "judge", "coder"];

// recorded on 5.0.6 (c43917b)
const V506 = {
  "writers/file": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "writer touched conftest.py in test round 1 (not a test file of AC1, AC2)"
  },
  "writers/section": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "writer touched pyproject.toml#tool.pytest in test round 1 (not a test file of AC1, AC2)"
  },
  "writers/git": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "writer touched git:config:local in test round 1 (not a test file of AC1, AC2)"
  },
  "writers/ignored": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "ignored path written: build.log (likely cause: a build or test command ran without the fleet build env, test_env_prefix, so build output or a cache such as target/ or __pycache__ changed in the worktree) in test round 1"
  },
  "writers/symlink": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "writer touched symlink:lib in test round 1 (not a test file of AC1, AC2)"
  },
  "writers/added": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "writer touched tests/conftest.py in test round 1 (not a test file of AC1, AC2)"
  },
  "writers/deleted": {
    "status": "needs_human",
    "gate": "ownership",
    "reason": "writer touched conftest.py in test round 1 (not a test file of AC1, AC2)"
  },
  "judge/file": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed conftest.py; verdict discarded"
  },
  "judge/section": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed pyproject.toml#tool.pytest; verdict discarded"
  },
  "judge/git": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed git:config:local; verdict discarded"
  },
  "judge/ignored": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed ignored path written: build.log (likely cause: a build or test command ran without the fleet build env, test_env_prefix, so build output or a cache such as target/ or __pycache__ changed in the worktree); verdict discarded"
  },
  "judge/symlink": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed symlink:lib; verdict discarded"
  },
  "judge/added": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed tests/conftest.py; verdict discarded"
  },
  "judge/deleted": {
    "status": "needs_human",
    "gate": "fingerprint",
    "reason": "judge mutated worktree: fleet-test-judge (role:fleet-test-judge:r1) changed conftest.py; verdict discarded"
  },
  "coder/file": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: conftest.py -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "coder/section": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: pyproject.toml#tool.pytest -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "coder/git": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: git:config:local -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "coder/ignored": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: ignored path written: build.log (likely cause: a build or test command ran without the fleet build env, test_env_prefix, so build output or a cache such as target/ or __pycache__ changed in the worktree) -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "coder/symlink": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: symlink:lib -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "coder/added": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: tests/conftest.py -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "coder/deleted": {
    "status": "ok",
    "gate": null,
    "reason": "PR ready for review; CI green, ready for human merge (no merge: policy merge never)",
    "coder2": [
      "frozen test or runner-config hash changed: conftest.py -- frozen paths are read-only; restore them to their content in freeze tree T1 and fix production code instead"
    ]
  },
  "refreeze/file": {
    "status": "needs_human",
    "gate": "hash",
    "reason": "re-freeze touched unrouted path tests/test_b.py"
  }
};

for (const site of SITES)
  for (const kind of Object.keys(KINDS))
    test("5.0.7 2020: non-weakening at " + site + ": one changed " + kind + " key stops or routes as in 5.0.6", async () => {
      assert.deepEqual(await outcome(scenario(site, kind)), V506[site + "/" + kind]);
    });

test("5.0.7 2020: non-weakening at the re-freeze: a test file of a criterion the code judge did not route stops as in 5.0.6", async () => {
  assert.deepEqual(await outcome(refreezeScenario()), V506["refreeze/file"]);
});

test("5.0.7 2020: only a changed map is expanded, by one hash-diff call; unchanged summaries run none", async () => {
  const out = await run(scenario("writers", "git"), ARGS);
  const diffs = out.labels.filter((l) => l.startsWith("infra:hash-diff:"));
  assert.deepEqual(diffs, ["infra:hash-diff:writers:r1"]);
  const args = inputsOf(call(out, "infra:hash-diff:writers:r1").prompt).args;
  // the git map only (the stubs' test-file hashes do not change), by its two files
  assert.deepEqual(args.filter((a, i) => i % 3 === 1), ["git"]);
  assert.match(args[0], /\/scratch$/);
  assert.ok(args.slice(2).every((x) => /^[0-9a-f]{12}$/.test(x)));
  // the per-call schema the agent's StructuredOutput is held to: rows are string arrays
  const sch = call(out, "infra:hash-diff:writers:r1").opts.schema.properties;
  assert.deepEqual(sch.changed.items, { type: "array", items: { type: "string" } });
  assert.ok([].concat(sch.changed.type).includes("array"));
  assert.deepEqual(sch.counts.additionalProperties, { type: "array", items: { type: "integer" } });
  assert.deepEqual(sch.total.type, ["integer", "null"]);
  assert.deepEqual(sch.resolved.additionalProperties, { type: "array", items: { type: "string" } });
  assert.ok(!("digest" in call(out, "infra:hash-diff:writers:r1").opts), "the script's own opts never reach the runtime");
  const ok = await run(happy(), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.deepEqual(ok.labels.filter((l) => l.startsWith("infra:hash-diff:")), []);
});

// ---------------------------------------------------------------- the relay

test("5.0.7 2020: a 19-file frozen map: the relay holds no per-file hash, only summaries and the program's own digests", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-507-"));
  try {
    const wt = join(home, "repo");
    const scratch = join(home, "scratch");
    mkdirSync(join(wt, "tests"), { recursive: true });
    mkdirSync(scratch);
    sh(wt, "git", "init", "-q");
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(wt, "git", "config", k, v);
    writeFileSync(join(wt, ".gitignore"), "local.txt\n");
    writeFileSync(join(wt, "conftest.py"), "");
    const tests = [];
    for (let i = 1; i <= 17; i++) {
      tests.push("tests/test_" + i + ".py");
      writeFileSync(join(wt, tests[i - 1]), "def test_" + i + "():\n    pass\n");
    }
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "i");
    const r = spawnSync("python3", ["-I", HASHER, wt, JSON.stringify(tests), "", scratch], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const relay = JSON.parse(r.stdout);
    const files = JSON.parse(readFileSync(relay.hashes.files.file, "utf8"));
    assert.equal(Object.keys(files).length, 19, "17 tests, conftest.py, .gitignore");
    // 5.0.6 relayed 71 64-hex values here (6615 bytes): 19 files, 18 git, 31 programs
    assert.ok(Buffer.byteLength(r.stdout) < 2500, "relay is " + Buffer.byteLength(r.stdout) + " bytes");
    const allowed = new Set([relay.digest, relay.program.sha256, relay.scripts.sha256]);
    for (const m of HASH_MAP_NAMES) {
      allowed.add(relay.hashes[m].sha256);
      allowed.add(relay.hashes[m].file.match(/([0-9a-f]{64})\.json$/)[1]);
    }
    const hex = r.stdout.match(/[0-9a-f]{64}/g);
    assert.deepEqual(hex.filter((x) => !allowed.has(x)), [], "every 64-hex value is a summary's or the program's own");
    assert.ok(hex.length <= 13, hex.length + " 64-hex values");
    for (const m of HASH_MAP_NAMES) {
      const map = JSON.parse(readFileSync(relay.hashes[m].file, "utf8"));
      for (const v of Object.values(map)) if (/^[0-9a-f]{64}$/.test(v)) assert.ok(!r.stdout.includes(v), m + " value relayed");
    }
    // the summaries are the files' own digests
    for (const m of ["files", "sections", "symlinks"]) assert.equal(relay.hashes[m].sha256, sha256(readFileSync(relay.hashes[m].file, "utf8")));
    assert.deepEqual(Object.keys(relay.hashes.git.inline).sort(), ["core.hooksPath"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- fail closed

// a stub's args and resolved shas, as the program prints them
const hd = (p) => {
  const o = hashDiffOut(inputsOf(p).args);
  return { args: o.args, resolved: o.resolved };
};
// a relayed state whose files summary points at a file no step wrote
function unwritten(h, scratch) {
  return Object.assign({}, h, { files: { count: 3, sha256: "e".repeat(64), file: scratch + "/hashes/files-" + "e".repeat(64) + ".json" } });
}

test("5.0.7 2020: a forged summary (file name, count, sha256, git inline) fails the hasher step", async () => {
  const forge = [
    (h, d) => (h.files = { count: 2, sha256: "a".repeat(64), file: d + "/hashes/files-" + "b".repeat(64) + ".json" }),
    (h, d) => (h.files = { count: -1, sha256: "a".repeat(64), file: d + "/hashes/files-" + "a".repeat(64) + ".json" }),
    (h, d) => (h.sections = { count: 0, sha256: "abc", file: d + "/hashes/sections-abc.json" }),
    (h, d) => (h.symlinks = { count: 0, sha256: "a".repeat(64), file: "/elsewhere/hashes/symlinks-" + "a".repeat(64) + ".json" }),
    (h, d) => (h.git = { count: 0, sha256: "a".repeat(64), file: d + "/hashes/git-" + "a".repeat(64) + ".json", inline: { "core.editor": "vi" } }),
  ];
  for (const f of forge) {
    const s = happy();
    s["hasher:pre-writers:r1"] = (p) => {
      const h = H(HASHES_FLAT);
      h.ignored = {};
      f(h, inputsOf(p).scratch_dir);
      return { status: "ok", fingerprint: FP_PRE, hashes: h };
    };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed", f.toString());
    assert.match(out.result.reason, /^hasher hasher:pre-writers:r1 failed: (the (files|sections|git|symlinks) summary |incomplete output)/, f.toString());
  }
});

test("5.0.7 2020: a missing map file never reads as no change: the writers stop at ownership, the post-coder check at hash", async () => {
  let s = scenario("none", "file");
  const pw = s["hasher:post-writers:r1"];
  s["hasher:post-writers:r1"] = (p) => {
    const r = pw(p);
    return Object.assign(r, { hashes: unwritten(r.hashes || base(), inputsOf(p).scratch_dir) });
  };
  let out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "ownership");
  assert.match(out.result.reason, /^writer touched frozen files map changed \(\d+ -> 3 entries; the key list is unavailable: the step returned failed: 0 files match files-[0-9a-f]{12}\*\.json [^)]+\) in test round 1 \(not a test file of AC1, AC2\)$/);
  s = scenario("none", "file");
  s["hasher:post-coder:r1"] = (p) => ({ status: "ok", fingerprint: FP_K1, hashes: unwritten(base(), inputsOf(p).scratch_dir) });
  out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "hash");
  assert.match(out.result.reason, /^hasher maps code:r1: the files map\(s\) changed and the key list is unavailable: the step returned failed: 0 files match .*; a key is never routed unseen$/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"), "never routed to the coder");
});

test("5.0.7 2020: a comparison whose file does not match its sha256, or whose counts differ from the relay, is never routed", async () => {
  for (const diff of [
    { status: "ok", reason: "x", changed: [], total: null, counts: {}, error: "/s/hashes/git-x.json does not match its sha256" },
    (p) => ({ status: "ok", reason: "x", changed: [["git", "config:local", "changed"]], total: 1, counts: { git: [9, 9] }, error: null, ...hd(p) }),
    (p) => ({ status: "ok", reason: "x", changed: [["git", "config:local", "changed"]], total: 1, counts: { git: [1, 1] }, error: null, resolved: hd(p).resolved, args: ["/elsewhere"] }),
  ]) {
    let s = scenario("writers", "git");
    s["infra:hash-diff:writers:r1"] = diff;
    let out = await run(s, ARGS);
    assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "ownership"]);
    assert.match(out.result.reason, /^writer touched frozen git map changed \(1 -> 1 entries; the key list is unavailable: [^)]+\) in test round 1/);
    s = scenario("coder", "section");
    s["infra:hash-diff:code:r1"] = diff;
    out = await run(s, ARGS);
    assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "hash"]);
    assert.match(out.result.reason, /^hasher maps code:r1: the sections map\(s\) changed and the key list is unavailable/);
  }
});

test("5.0.7 2020: a capped key list routes nothing it did not list: past the cap a writer round stops at ownership", async () => {
  const s = scenario("writers", "git");
  s["infra:hash-diff:writers:r1"] = (p) => ({ status: "ok", reason: "x", changed: [["git", "config:local", "changed"]], total: 60, counts: { git: [1, 1] }, error: null, ...hd(p) });
  const out = await run(s, ARGS);
  assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "ownership"]);
  assert.equal(out.result.reason, "writer touched git:config:local in test round 1 (not a test file of AC1, AC2)");
  const s2 = scenario("writers", "git");
  s2["infra:hash-diff:writers:r1"] = (p) => ({ status: "ok", reason: "x", changed: [["files", "tests/test_a.py", "changed"]].slice(0, 0), total: 60, counts: { git: [1, 1] }, error: null, ...hd(p) });
  const o2 = await run(s2, ARGS);
  assert.deepEqual([o2.result.status, o2.result.stop_gate], ["needs_human", "ownership"]);
  assert.match(o2.result.reason, /^writer touched git: \(60 more\) in test round 1/);
});

// ---------------------------------------------------------------- one retry on a digest-only miss

const BAD = "0".repeat(64);
test("5.0.7 2020: a relay that fails only on its digest is dispatched once more; the run goes on and the gate log names it", async () => {
  const s = happy();
  s["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: FP_TESTS, digest: BAD };
  s["hasher:fp-post:test-judge:r1:digest-retry"] = { status: "ok", fingerprint: FP_TESTS };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const i = out.labels.indexOf("hasher:fp-post:test-judge:r1");
  assert.equal(out.labels[i + 1], "hasher:fp-post:test-judge:r1:digest-retry");
  assert.ok(out.result.gate_log.includes("hasher:fp-post:test-judge:r1: the relay does not match the program's digest; dispatched once more to a fresh agent (hasher:fp-post:test-judge:r1:digest-retry)"));
  assert.match(call(out, "hasher:fp-post:test-judge:r1:digest-retry").prompt, /A first relay of this step did not match the program's digest/);
  const base0 = await run(happy(), ARGS);
  assert.equal(out.result.agents, base0.result.agents + 1, "the retry is on the agent cap");
});

test("5.0.7 2020: two digest misses fail as in 5.0.6; any other contract failure is never retried", async () => {
  let s = happy();
  s["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: FP_TESTS, digest: BAD };
  let out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.reason, "hasher hasher:fp-post:test-judge:r1:digest-retry failed: the relayed maps do not match the program's digest (a key was dropped or changed in the copy)".replace(":digest-retry", ""));
  assert.equal(out.labels.filter((l) => l.endsWith(":digest-retry")).length, 1);
  for (const r of [
    { status: "ok", fingerprint: FP_TESTS, program: { name: "hasher", sha256: BAD }, digest: BAD },
    { status: "ok", fingerprint: FP_TESTS, program: null, digest: BAD },
    { status: "ok", fingerprint: FP_TESTS, digest: "not hex" },
    { status: "failed", reason: "boom", fingerprint: FP_TESTS, digest: BAD },
  ]) {
    s = happy();
    s["hasher:fp-post:test-judge:r1"] = r;
    out = await run(s, ARGS);
    assert.equal(out.result.status, "failed", JSON.stringify(r));
    assert.ok(!out.labels.some((l) => l.endsWith(":digest-retry")), JSON.stringify(r));
  }
  // 6.2.2 review M2: format_files is the one write step with the retry: a second run finds the
  // files settled (the fixers changed them already) and re-runs only the read-only checks.
  // Two misses still fail.
  s = happy();
  s["infra:format-code:r1"] = { status: "ok", reason: "x", ran: true, note: "n", runs: 1, stable: true, files: [], changed: [], refused: [], purged: 0, purged_paths: [], frozen_changed: [], digest: BAD };
  out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.deepEqual(out.labels.filter((l) => l.endsWith(":digest-retry")), ["infra:format-code:r1:digest-retry"]);
});

test("5.0.7 2020: the read-only program steps carry the retry; no write step does", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "..", "workflows", "build-task-run.js"), "utf8");
  const ro = [...src.matchAll(/JUDGE_AGENT,\s*"([a-z_:]+)"\)?/g)].map((m) => m[1]).concat([...src.matchAll(/digest: (?:baseTree \? "hasher:base" : )?"([a-z_]+)"/g)].map((m) => m[1]));
  // 6.2.2 re-review D-N1: the default-agent (write) form infra(..., undefined, "<id>") too
  const writes = [...src.matchAll(/,\s*undefined,\s*"([a-z_:]+)"\)?/g)].map((m) => m[1]);
  const RO = ["read_state", "fleet_scan", "hook_surface", "tf_gate", "remote_head", "branch_scan", "verify_since", "review_paths", "callers", "precommit_ids", "script_check", "hasher", "hash_diff", "gh_identity", "ruleset_surface", "policy", "pr_convention", "orch_scan", "ci_watch"];
  // the write steps allowed the retry: format_files only (6.2.2 review M2: a second run finds the files settled)
  const WRITE_RETRY = ["format_files"];
  assert.deepEqual([...new Set(ro)].sort(), RO.slice().sort());
  assert.deepEqual([...new Set(writes)].sort(), WRITE_RETRY);
});

// ---------------------------------------------------------------- the stub is the program

test("5.0.7 2020: hash_diff.py and the harness stub print the same rows, counts and resolved shas", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-507-parity-"));
  try {
    mkdirSync(join(home, "hashes"));
    const write = (m, map) => {
      const text = canon(map);
      const f = join(home, "hashes", m + "-" + sha256(text) + ".json");
      writeFileSync(f, text);
      registerMap(f, map);
      return sha256(text).slice(0, 12);
    };
    const pairs = [
      ["files", { "a.py": "1", "b.py": "2", "c.py": "3" }, { "a.py": "1", "b.py": "9", "d.py": "4" }],
      ["sections", { "pyproject.toml#tool.pytest": "x" }, { "pyproject.toml#tool.pytest": "y" }],
      ["git", { "config:local": "g1", "hooks/pre-commit": "h" }, { "config:local": "g1" }],
      ["symlinks", {}, { lib: "../x" }],
      ["ignored", { ".claude/settings.local.json": "s1", "target/a": "t", "z ü": "1" }, { ".claude/settings.local.json": "s2", "target/a": "u", "z ü": "1" }],
    ];
    const args = [home];
    for (const [m, a, b] of pairs) args.push(m, write(m, a), write(m, b));
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hash_diff.py")].concat(args), { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const real = JSON.parse(r.stdout);
    const stub = hashDiffOut(args);
    for (const k of ["changed", "total", "counts", "resolved", "error", "args"]) assert.deepEqual(stub[k], real[k], k);
    assert.equal(real.total, 7);
    // one map past the cap: the same first 50 rows
    const big = {};
    for (let i = 0; i < 60; i++) big["f" + String(i).padStart(2, "0")] = String(i);
    const a2 = [home, "files", write("files", {}), write("files", big)];
    const r2 = JSON.parse(spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hash_diff.py")].concat(a2), { encoding: "utf8" }).stdout);
    const s2 = hashDiffOut(a2);
    for (const k of ["changed", "total", "counts", "resolved", "error"]) assert.deepEqual(s2[k], r2[k], k);
    assert.deepEqual([r2.changed.length, r2.total], [50, 60]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- short handles (review of #55)
// The agent types no 64-hex value: hash_diff gets <scratch> and per map
// <map> <old-prefix> <new-prefix> (12 hex of the file's sha256), resolves each
// to exactly one file and prints the full shas inside its digest; the
// workflow checks them against the summaries it holds.

const HEX64 = /[0-9a-f]{64}/;
const cmdLine = (prompt, prog) => prompt.split("\n").find((l) => l.includes("/" + prog + ".py'"));

test("5.0.7 review: the hash-diff and format-code commands carry no 64-hex value", async () => {
  const out = await run(scenario("coder", "section"), ARGS);
  for (const [label, prog] of [["infra:hash-diff:code:r1", "hash_diff"], ["infra:format-code:r1", "format_files"]]) {
    const line = cmdLine(call(out, label).prompt, prog);
    assert.ok(line, label);
    assert.ok(!HEX64.test(line), label + ": " + line);
    assert.ok(!HEX64.test(JSON.stringify(inputsOf(call(out, label).prompt))), label + " inputs");
  }
  const args = inputsOf(call(out, "infra:hash-diff:code:r1").prompt).args;
  assert.match(args[0], /\/scratch$/);
  assert.deepEqual(args.slice(1).map((a, i) => (i % 3 === 0 ? a : /^[0-9a-f]{12}$/.test(a))), ["sections", true, true]);
});

function handleDir() {
  const home = mkdtempSync(join(tmpdir(), "fleet-507-h-"));
  mkdirSync(join(home, "hashes"));
  const put = (m, map) => {
    const text = canon(map);
    const sha = sha256(text);
    writeFileSync(join(home, "hashes", m + "-" + sha + ".json"), text);
    return sha;
  };
  const prog = (args) => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hash_diff.py")].concat(args), { encoding: "utf8" });
  return { home, put, prog, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("5.0.7 review: hash_diff resolves 12-hex prefixes and prints the full shas; a missing or ambiguous prefix exits non-zero", () => {
  const d = handleDir();
  try {
    const a = d.put("git", { "config:local": "g1" });
    const b = d.put("git", { "config:local": "g2" });
    const r = d.prog([d.home, "git", a.slice(0, 12), b.slice(0, 12)]);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.resolved, { git: [a, b] });
    assert.deepEqual(o.changed, [["git", "config:local", "changed"]]);
    assert.deepEqual(o.args, [d.home, "git", a.slice(0, 12), b.slice(0, 12)]);
    // missing
    let x = d.prog([d.home, "git", "0".repeat(12), b.slice(0, 12)]);
    assert.notEqual(x.status, 0);
    assert.match(x.stderr, /no file|0 files/);
    // ambiguous: a second file with the same 12-hex prefix
    writeFileSync(join(d.home, "hashes", "git-" + a.slice(0, 12) + "f".repeat(52) + ".json"), "{}");
    x = d.prog([d.home, "git", a.slice(0, 12), b.slice(0, 12)]);
    assert.notEqual(x.status, 0);
    assert.match(x.stderr, /2 files/);
    // a prefix that is not 12 lowercase hex, or a full sha
    for (const p of [a.slice(0, 11), a, "../" + a.slice(0, 9), a.slice(0, 12).toUpperCase()]) assert.notEqual(d.prog([d.home, "git", p, b.slice(0, 12)]).status, 0, p);
  } finally {
    d.done();
  }
});

test("5.0.7 review: a printed full sha that is not the summary the workflow holds fails closed", async () => {
  const wrong = (p) => {
    const o = hashDiffOut(inputsOf(p).args);
    const m = Object.keys(o.resolved)[0];
    o.resolved[m] = [o.resolved[m][0], "e".repeat(64)];
    return Object.assign({ status: "ok", reason: "x" }, o);
  };
  let s = scenario("writers", "git");
  s["infra:hash-diff:writers:r1"] = wrong;
  let out = await run(s, ARGS);
  assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "ownership"]);
  assert.match(out.result.reason, /the key list is unavailable: the program read other map files than the summaries name/);
  s = scenario("coder", "section");
  s["infra:hash-diff:code:r1"] = wrong;
  out = await run(s, ARGS);
  assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "hash"]);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("5.0.7 review: a read-only relay whose only fault is other args is dispatched once more; two fail as before", async () => {
  const otherArgs = (p) => {
    const a = inputsOf(p).args.slice();
    a[2] = "0".repeat(12);
    return Object.assign({ status: "ok", reason: "x" }, hashDiffOut(inputsOf(p).args), { args: a });
  };
  let s = scenario("writers", "git");
  s["infra:hash-diff:writers:r1"] = otherArgs;
  s["infra:hash-diff:writers:r1:args-retry"] = (p) => Object.assign({ status: "ok", reason: "x" }, hashDiffOut(inputsOf(p).args));
  let out = await run(s, ARGS);
  assert.deepEqual([out.result.status, out.result.stop_gate, out.result.reason], [V506["writers/git"].status, V506["writers/git"].gate, V506["writers/git"].reason]);
  assert.ok(out.result.gate_log.includes("infra:hash-diff:writers:r1: the program ran on other arguments than the workflow sent; dispatched once more to a fresh agent (infra:hash-diff:writers:r1:args-retry)"));
  s = scenario("writers", "git");
  s["infra:hash-diff:writers:r1"] = otherArgs;
  out = await run(s, ARGS);
  assert.equal(out.labels.filter((l) => l.endsWith(":args-retry")).length, 1);
  assert.match(out.result.reason, /the key list is unavailable: the program ran on other arguments than the workflow sent/);
  // tf_gate (read-only, echoes its args): one retry too
  s = happy();
  const tf = (p) => tfGateRelay({ args: ["/x"] });
  s["infra:tf-gate:push"] = tf;
  out = await run(s, ARGS);
  assert.ok(out.labels.includes("infra:tf-gate:push:args-retry"), out.labels.filter((l) => l.startsWith("infra:tf")).join(","));
});

// ---------------------------------------------------------------- review of #55 (SF1, SF2, cap)

test("5.0.7 review SF1: a format-code relay whose frozen_map is not the frozen files map the workflow holds stops at hash", async () => {
  const s = happy();
  s["infra:format-code:r1"] = { status: "ok", reason: "x", ran: true, note: "n", runs: 1, stable: true, files: [], changed: [], refused: [], purged: 0, purged_paths: [], frozen_changed: [], frozen_map: "e".repeat(64) };
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hash");
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /^infra:format-code:r1: the program read the frozen map "e{64}", not [0-9a-f]{64}$/);
  assert.ok(!out.labels.includes("hasher:post-coder:r1"));
});

// two maps changed; the comparison lists rows for one only (total = rows)
function oneMapListed(site, tag) {
  const s = scenario("none", "file");
  const mod = base();
  mod.files["tests/test_a.py"] = "ha2";
  mod.sections["pyproject.toml#tool.pytest"] = "hp2";
  if (site === "writers") {
    const pw = s["hasher:post-writers:r1"];
    s["hasher:post-writers:r1"] = (p) => Object.assign(pw(p), { hashes: mod });
  } else s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: mod };
  s["infra:hash-diff:" + tag] = (p) => {
    const o = hashDiffOut(inputsOf(p).args);
    o.changed = o.changed.filter((w) => w[0] === "files");
    o.total = o.changed.length;
    return Object.assign({ status: "ok", reason: "x" }, o);
  };
  return s;
}

test("5.0.7 review SF2: a changed map with no listed row and no overflow fails closed (writers: ownership; post-coder: hash)", async () => {
  let out = await run(oneMapListed("writers", "writers:r1"), ARGS);
  assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "ownership"]);
  assert.match(out.result.reason, /^writer touched frozen files map changed \(3 -> 3 entries; the key list is unavailable: the sections map changed but no key of it is listed\) in test round 1/);
  out = await run(oneMapListed("coder", "code:r1"), ARGS);
  assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "hash"]);
  assert.match(out.result.reason, /the key list is unavailable: the sections map changed but no key of it is listed/);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"));
});

test("5.0.7 review: a hash-diff the agent cap cannot fit stops at cap", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "..", "workflows", "build-task-run.js"), "utf8");
  const body = src.slice(src.indexOf("async function expandKeys("), src.indexOf("function keyNames("));
  const i = body.indexOf("reserve(1, ");
  assert.ok(i > 0 && i < body.indexOf("softDispatch("), "expandKeys reserves its agent (stop_gate cap) before the dispatch");
  assert.match(src, /function reserve\(n, what\) \{[\s\S]{0,200}"cap",/);
});
