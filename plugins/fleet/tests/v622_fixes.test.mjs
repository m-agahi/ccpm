// fleet 6.2.2: three bug fixes ruled by Max (ledger 2104, 2106, 2107).
//
// 2106 / ADR-1235: the ownership gate compares only refs under
//   refs/fleet/<own task id>/* (and the run's own layout key). Another run's
//   refs in the shared git-common-dir are never blamed on this run's roles;
//   a change to one is logged once (review N2).
// 2107 / ADR-1237 (supersedes ADR-1234, ADR-1236): only the hook ids in the
//   repo's policy override pre_freeze_hooks run before the freeze, each alone
//   on each writer file. A failure sends a fix_tests round to the writers that
//   own the failing files; the run never freezes while a listed hook fails on
//   a test file. No list: no pre-freeze hook, as in 6.2.1.
// 2104: the preflight probe prints its own count of hash lines. A relay with
//   fewer hash lines than the workflow's own tables expect, or with no single
//   count line, is retried once; then a distinct reason, never a bare
//   "missing" (review M1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARGS, happy, run, runOne, call, noUnscripted, inputsOf, H, HASHES, HASHES_FLAT, FP_PRE, FP_TESTS, FP_K1, FP_K2,
  SCRIPTS_SRC, SCRIPTS_DIR, PROGRAMS, scriptsProbe, PREFLIGHT_PROBE, spawnSync, sh, K,
} from "./harness.mjs";

// ---------------------------------------------------------------- 2106

const OWN = "refs/fleet/l42/";
const withRefs = (refs) => H(Object.assign({}, HASHES_FLAT, Object.fromEntries(Object.entries(refs).map(([k, v]) => ["git:fleetref:" + k, v]))));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// pre-writers and post-writers hashes, round 1
function writerRound(preRefs, postRefs) {
  return happy({
    script: {
      "hasher:pre-writers:r1": { status: "ok", fingerprint: FP_PRE, hashes: withRefs(preRefs) },
      "hasher:post-writers:r1": { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: withRefs(postRefs) },
    },
  });
}

test("6.2.2 2106: another run's refs/fleet/<other>/freeze, written during test round 1, is no ownership violation", async () => {
  const out = await run(writerRound({}, { "refs/fleet/y690/freeze": SHA_A }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  // moved, not only created
  const o2 = await run(writerRound({ "refs/fleet/y690/freeze": SHA_A }, { "refs/fleet/y690/freeze": SHA_B }), ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
  // removed
  const o3 = await run(writerRound({ "refs/fleet/y690/state": SHA_A }, {}), ARGS);
  assert.equal(o3.result.status, "ok", o3.result.reason);
});

test("6.2.2 2106: a write to the run's own refs/fleet/<id>/* in test round 1 still stops the run", async () => {
  for (const [pre, post, name] of [
    [{}, { [OWN + "freeze"]: SHA_A }, OWN + "freeze"],
    [{ [OWN + "state"]: SHA_A }, { [OWN + "state"]: SHA_B }, OWN + "state"],
    // the layout key (task id + slug) is the run's own too: the re-plan's superseded tree
    [{}, { "refs/fleet/l42-add-thing/superseded-1-tree": SHA_A }, "refs/fleet/l42-add-thing/superseded-1-tree"],
  ]) {
    const out = await run(writerRound(pre, post), ARGS);
    assert.equal(out.result.status, "needs_human", name);
    assert.equal(out.result.stop_gate, "ownership", name);
    assert.equal(out.result.reason, "run-state ref touched by role: " + name + " in test round 1");
  }
});

test("6.2.2 2106: a task id that only shares a prefix with the own id (l4, l420) is another run's", async () => {
  for (const ref of ["refs/fleet/l4/freeze", "refs/fleet/l420/freeze", "refs/fleet/l42x/state"]) {
    const out = await run(writerRound({}, { [ref]: SHA_A }), ARGS);
    assert.equal(out.result.status, "ok", ref + ": " + out.result.reason);
  }
});

test("6.2.2 2106: foreign refs are no violation in the judge fingerprint and the post-coder hash either; own refs still are", async () => {
  const foreign = withRefs({ "refs/fleet/y690/freeze": SHA_A });
  let out = await run(happy({ script: { "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: FP_K1, hashes: foreign } } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  out = await run(happy({ script: { "hasher:post-coder:r1": { status: "ok", fingerprint: FP_K1, hashes: foreign } } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"), "no coder round 2 for a foreign ref");
  out = await run(happy({ script: { "hasher:fp-post:code-judge:r1": { status: "ok", fingerprint: FP_K1, hashes: withRefs({ [OWN + "x"]: SHA_A }) } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /judge mutated worktree.*run-state ref touched by role: refs\/fleet\/l42\/x/);
});

test("6.2.2 2106: replacement refs still stop every hasher read, own task or not", async () => {
  const out = await run(writerRound({}, { ["refs/replace/" + "c".repeat(40)]: SHA_A }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "hash");
  assert.match(out.result.reason, /refs\/replace\/c{40} exists/);
});

test("6.2.2 review N2: another run's ref that changes between hasher reads gets one gate line naming it, and no stop", async () => {
  const out = await run(writerRound({ "refs/fleet/y690/state": SHA_A }, { "refs/fleet/y690/state": SHA_B, "refs/fleet/y690/freeze": SHA_A }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const ref of ["refs/fleet/y690/state", "refs/fleet/y690/freeze"]) {
    const lines = out.result.gate_log.filter((g) => g.includes("another fleet run's ref changed: " + ref + " "));
    assert.equal(lines.length, 1, ref + ": " + out.result.gate_log.filter((g) => /another fleet run/.test(g)).join("\n"));
  }
});

// ---------------------------------------------------------------- 2107 (ADR-1237)

const HOOK_HEAD = "[cargo-fmt tests/test_a.py] cargo fmt..............Failed\n- hook id: cargo-fmt\n- exit code: 1\n\nDiff in tests/test_a.py at line 13";
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
// the sealed policy read: the repos override's pre_freeze_hooks (undefined: no list)
const policyWith = (hooks) => (p) => ({
  status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64),
  caps: Object.assign({}, DEFAULT_CAPS, hooks === undefined ? {} : { pre_freeze_hooks: hooks }),
  matched: "profile personal, repos[\"o/r\"]", error: null, args: inputsOf(p).args,
});
// a format_files result for the writers' files; failures: [[file, id]]
function hookResult(prompt, failures, over) {
  const sel = inputsOf(prompt).select;
  const f = failures || [];
  return Object.assign({ status: "ok", reason: "ran", note: "ran pre-commit run --files in a scratch checkout of HEAD", ran: true, runs: 1, stable: true, files: sel.paths || [], changed: [], refused: [], purged: 0, purged_paths: [], hook_failed: f.length > 0, hook_failures: f, hook_head: f.length ? HOOK_HEAD : "", hook_sha256: f.length ? "e".repeat(64) : "", hook_timeout: [], fix_timeout: false, unknown_hooks: [] }, over || {});
}
const failing = (prompt) => hookResult(prompt, [["tests/test_a.py", "cargo-fmt"]]);
const passing = (prompt) => hookResult(prompt, []);
const selectOf = (out, label) => inputsOf(call(out, label).prompt).select;

function round(n, writers) {
  const s = {};
  for (const id of writers) s["role:fleet-test-writer:" + id + ":r" + n] = { status: "ok", reason: "fixed", criterion_id: id, tests: [], files: ["tests/test_" + (id === "AC1" ? "a" : "b") + ".py"] };
  s["hasher:post-writers:r" + n] = { status: "ok", fingerprint: FP_TESTS, changed: writers.map((id) => "tests/test_" + (id === "AC1" ? "a" : "b") + ".py") };
  return s;
}

test("6.2.2 2107: format_files relays the pre-freeze result as digest keys (no free-text output: a head and a sha256)", () => {
  const keys = K("format_files");
  for (const k of ["hook_failed", "hook_failures", "hook_head", "hook_sha256", "hook_timeout", "unknown_hooks"]) assert.ok(keys.includes(k), keys.join(","));
  assert.ok(!keys.includes("hook_output"));
});

test("6.2.2 2107: no pre_freeze_hooks list: no hook is judged before the freeze (6.2.1 behaviour), even when the program says one failed", async () => {
  for (const pol of [undefined, []]) {
    const s = happy({ script: { "infra:policy": policyWith(pol), "infra:format-tests:r1": failing } });
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(selectOf(out, "infra:format-tests:r1").check_hooks, undefined, "no check_hooks sent");
    assert.ok(out.labels.includes("role:fleet-test-judge:r1"));
    assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r2"));
  }
});

test("6.2.2 2107 / review L3: a listed hook failing on one writer's file sends a fix_tests round to that writer only, never the judge, never a freeze then", async () => {
  const s = happy({
    script: Object.assign(
      {
        "infra:policy": policyWith(["cargo-fmt"]),
        "infra:format-tests:r1": failing,
        "infra:format-tests:r2": passing,
        "role:fleet-test-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], checked: [] },
        "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_TESTS },
      },
      round(2, ["AC1"]),
    ),
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(selectOf(out, "infra:format-tests:r1"), { paths: ["tests/test_a.py", "tests/test_b.py"], check_hooks: ["cargo-fmt"] });
  assert.equal(selectOf(out, "infra:format-code:r1").check_hooks, undefined, "the coder's files are never checked here");
  const l = out.labels;
  assert.ok(!l.includes("role:fleet-test-judge:r1"), "no test judge on a failing hook");
  assert.ok(!l.includes("role:fleet-test-writer:AC2:r2"), "AC2's file passed: no round for it");
  assert.ok(l.indexOf("role:fleet-test-writer:AC1:r2") > l.indexOf("infra:format-tests:r1"));
  assert.ok(l.indexOf("hasher:freeze:f1") > l.indexOf("role:fleet-test-judge:r2"), "the freeze follows the judge's approval of a clean round");
  const w = inputsOf(call(out, "role:fleet-test-writer:AC1:r2").prompt);
  assert.equal(w.routed_findings.length, 1);
  const f = w.routed_findings[0];
  assert.equal(f.criterion, "AC1");
  assert.equal(f.target, "tests");
  assert.ok(f.finding.includes("tests/test_a.py") && !f.finding.includes("tests/test_b.py"), f.finding);
  assert.match(f.finding, /edit only your own test files/);
  assert.ok(f.finding.includes("pre-commit run cargo-fmt --files tests/test_a.py"), f.finding);
  assert.ok(f.finding.includes(HOOK_HEAD), f.finding);
  assert.ok(out.result.gate_log.some((g) => /format-tests:r1: pre_freeze_hooks fail on tests\/test_a\.py \(cargo-fmt\); fix_tests round to AC1/.test(g)), out.result.gate_log.join("\n"));
});

test("6.2.2 2107: a listed hook still failing in the last test round stops for a human; no judge, no freeze", async () => {
  const s = happy({
    script: Object.assign(
      { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": failing, "infra:format-tests:r2": failing, "infra:format-tests:r3": failing },
      round(2, ["AC1"]),
      round(3, ["AC1"]),
    ),
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "cap");
  assert.match(out.result.reason, /pre_freeze_hooks still fail after 3 test round\(s\): tests\/test_a\.py \(cargo-fmt\)/);
  assert.ok(out.result.reason.includes("Diff in tests/test_a.py at line 13"), out.result.reason);
  assert.match(out.result.reason, /never frozen/);
  assert.ok(!out.labels.some((x) => /^role:fleet-test-judge:/.test(x)), "no judge ran");
  assert.ok(!out.labels.some((x) => /^hasher:freeze:/.test(x)), "no freeze");
});

test("6.2.2 2107: a listed hook that passes leaves the round on the normal path", async () => {
  const out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": passing } }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-test-judge:r1"));
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r2"));
});

test("6.2.2 2107 / review L1: a listed id the repo cannot run before commit stops for a human, naming it and why", async () => {
  const out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt", "nope"]), "infra:format-tests:r1": (p) => hookResult(p, [], { ran: false, note: "pre-freeze hook id(s) cannot run: nope; no hook was run", unknown_hooks: ["nope: not in .pre-commit-config.yaml"] }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "policy");
  assert.match(out.result.reason, /pre_freeze_hooks names hook id\(s\) the repo cannot run at the pre-commit stage: nope: not in \.pre-commit-config\.yaml/);
  assert.ok(!out.labels.some((x) => /^hasher:freeze:/.test(x)));
});

test("6.2.2 review L2: a listed hook that timed out stops for a human with its own reason; the writers get nothing", async () => {
  const out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": (p) => hookResult(p, [], { hook_timeout: ["cargo-fmt"] }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "hooks");
  assert.match(out.result.reason, /pre_freeze_hooks check phase ran out of time: cargo-fmt/);
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r2"));
  assert.ok(!out.labels.some((x) => /^hasher:freeze:/.test(x)));
});

test("6.2.2 re-review D-M1: a whole-tree failure (file \"\") goes to every writer of the round, named as one", async () => {
  const s = happy({
    script: Object.assign(
      {
        "infra:policy": policyWith(["clippy"]),
        "infra:format-tests:r1": (p) => hookResult(p, [["", "clippy"]]),
        "infra:format-tests:r2": passing,
        "role:fleet-test-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], checked: [] },
        "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_TESTS },
      },
      round(2, ["AC1", "AC2"]),
    ),
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const id of ["AC1", "AC2"]) {
    const f = inputsOf(call(out, "role:fleet-test-writer:" + id + ":r2").prompt).routed_findings[0].finding;
    assert.match(f, /whole-tree failure of clippy/, f);
    assert.match(f, /edit only your own test files/);
    assert.ok(f.includes(HOOK_HEAD), f);
  }
  assert.ok(out.result.gate_log.some((g) => /pre_freeze_hooks fail on the whole tree \(clippy\); fix_tests round to AC1, AC2/.test(g)), out.result.gate_log.join("\n"));
});

test("6.2.2 re-review D-L1: fixer runs that ran out of time stop with a reason naming the fixer phase, never 'still rewrite'", async () => {
  for (const label of ["infra:format-tests:r1", "infra:format-code:r1"]) {
    const out = await run(happy({ script: { [label]: (p) => hookResult(p, [], { stable: false, runs: 1, fix_timeout: true }) } }), ARGS);
    assert.equal(out.result.status, "needs_human", label);
    assert.equal(out.result.stop_gate, "hooks", label);
    assert.match(out.result.reason, /the fixer hook runs ran out of time \(each run at most 180 s, at most 3 runs\)/, label);
    assert.doesNotMatch(out.result.reason, /still rewrite/, label);
  }
  // the check phase names itself
  const out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": (p) => hookResult(p, [], { hook_timeout: ["cargo-fmt"] }) } }), ARGS);
  assert.match(out.result.reason, /the pre_freeze_hooks check phase ran out of time: cargo-fmt/);
});

test("6.2.2 2107: listed hooks that could not run (no pre-commit) stop for a human; 6.3.0: a bad sealed list is no list (v630_flow)", async () => {
  let out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": (p) => hookResult(p, [], { ran: false, note: "pre-commit is not installed" }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "policy");
  assert.match(out.result.reason, /pre_freeze_hooks \(cargo-fmt\) did not run \(pre-commit is not installed\)/);
  for (const bad of ["cargo-fmt", [""], ["a b"], ["-x"], [1]]) {
    out = await run(happy({ script: { "infra:policy": policyWith(bad) } }), ARGS);
    assert.equal(out.result.status, "ok", JSON.stringify(bad));
  }
});

test("6.2.2 2107: a format result with a mistyped pre-freeze key is a broken relay", async () => {
  for (const over of [{ hook_failed: "no" }, { unknown_hooks: null }, { hook_failures: null }, { hook_timeout: "x" }, { hook_head: 1 }, { hook_failures: [["tests/test_a.py"]] }, { fix_timeout: "no" }]) {
    const out = await run(happy({ script: { "infra:format-tests:r1": (prompt) => hookResult(prompt, [], over) } }), ARGS);
    assert.equal(out.result.status, "failed", JSON.stringify(over));
    assert.match(out.result.reason, /hook_failed|unknown_hooks|hook_failures|hook_timeout|hook_head|fix_timeout/);
  }
});

test("6.2.2 review M2: a format relay whose hook_head was miscopied gets the one digest retry, and the run goes on", async () => {
  const s = happy({
    script: Object.assign(
      {
        "infra:policy": policyWith(["cargo-fmt"]),
        "infra:format-tests:r1": failing,
        "infra:format-tests:r2": passing,
        "role:fleet-test-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], checked: [] },
        "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_TESTS },
      },
      round(2, ["AC1"]),
    ),
  });
  // the first relay of format-tests:r1 drops a character of hook_head after the program's digest
  s.__mutate = { label: "infra:format-tests:r1", fn: (r, prompt, label) => (label === "infra:format-tests:r1" ? Object.assign(r, { hook_head: r.hook_head.slice(1) }) : r) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:format-tests:r1:digest-retry"), out.labels.join(", "));
  assert.ok(out.labels.includes("role:fleet-test-writer:AC1:r2"));
});

// policy.py run for real (an absolute python3: the env has a bare PATH)
const PY3 = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
function policyRun(doc) {
  const home = mkdtempSync(join(tmpdir(), "fleet-622pol-"));
  try {
    mkdirSync(join(home, ".config", "fleet"), { recursive: true });
    writeFileSync(join(home, ".config", "fleet", "policy.json"), JSON.stringify(doc));
    const r = spawnSync(PY3, ["-I", join(SCRIPTS_SRC, "policy.py"), "github.com", "yadgarhq/iam-db"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const polDoc = (repoOver, profOver) => ({
  version: 1,
  profiles: [Object.assign({ name: "personal", match: { owners: ["yadgarhq"] }, repos: { "yadgarhq/iam-db": repoOver } }, profOver || {})],
});

test("6.2.2 2107: policy.py: a repos override's pre_freeze_hooks reaches the caps; no list, no key", () => {
  const o = policyRun(polDoc({ pre_freeze_hooks: ["cargo-fmt"] }));
  assert.equal(o.error, null);
  assert.deepEqual(o.caps.pre_freeze_hooks, ["cargo-fmt"]);
  const e = policyRun(polDoc({ merge: "never" }));
  assert.equal(e.error, null);
  assert.ok(!("pre_freeze_hooks" in e.caps));
  assert.deepEqual(policyRun(polDoc({ pre_freeze_hooks: [] })).caps.pre_freeze_hooks, []);
});

test("6.2.2 2107: policy.py: a pre_freeze_hooks that is not a list of hook ids makes the policy invalid (6.3.0: the strict default, no list); the key is per repo only", () => {
  for (const bad of ["cargo-fmt", [""], [1], ["a b"], ["-x"], [null], { a: 1 }]) {
    const o = policyRun(polDoc({ pre_freeze_hooks: bad }));
    assert.deepEqual(o.caps, DEFAULT_CAPS, JSON.stringify(bad));
    assert.match(o.error, /pre_freeze_hooks must be a list of hook ids/, JSON.stringify(bad));
  }
  const p = policyRun(polDoc({}, { pre_freeze_hooks: ["cargo-fmt"] }));
  assert.deepEqual(p.caps, DEFAULT_CAPS);
  assert.match(p.error, /unknown key "pre_freeze_hooks"/);
});

// format_files.py run for real with a fake pre-commit: `pre-commit run --files ...`
// (the fixer runs) exits 1 (ignored); `pre-commit run <id> --files <file>` follows the case below
const CFG622 = "repos:\n  - repo: local\n    hooks:\n      - id: fmt-check\n        name: fmt-check\n        entry: fmt --check\n        language: system\n      - id: clippy\n        name: clippy\n        entry: clippy --all-targets\n        language: system\n        pass_filenames: false\n      - id: suite\n        name: suite\n        entry: suite\n        language: system\n        always_run: true\n      - id: push-only\n        name: push-only\n        entry: push-only\n        language: system\n        stages: [pre-push]\n      - id: legacy-commit\n        name: legacy-commit\n        entry: legacy\n        language: system\n        stages: [commit]\n";
function hookRepo(perId, cfg, fixer) {
  const home = mkdtempSync(join(tmpdir(), "fleet-622-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  mkdirSync(join(wt, "tests"), { recursive: true });
  mkdirSync(bin);
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, ".pre-commit-config.yaml"), cfg || CFG622);
  writeFileSync(join(wt, "src.py"), "x = 1\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  const log = join(home, "log");
  writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\necho \"$2 $4\" >> '" + log + "'\nif [ \"$2\" = --files ]; then " + (fixer || "exit 1") + "; fi\ncase \"$2\" in\n" + perId + "\nesac\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    assert  1\n");
  writeFileSync(join(wt, "tests", "test_b.py"), "def test_b():\n    assert 1\n");
  const runF = (check, tmo) => {
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
    const paths = ["tests/test_a.py", "tests/test_b.py"];
    const sel = check === undefined ? { paths } : { paths, check_hooks: check };
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "format_files.py"), wt, JSON.stringify(sel), "[]", join(home, "scratch"), String(tmo || 60)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.doesNotMatch(o.note, /hook surface unknown/, o.note);
    return o;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { wt, runF, calls, done: () => rmSync(home, { recursive: true, force: true }) };
}
const NONE = { hook_failed: false, hook_failures: [], hook_head: "", hook_sha256: "", hook_timeout: [], fix_timeout: false, unknown_hooks: [] };
const pick6 = (o) => Object.fromEntries(Object.keys(NONE).map((k) => [k, o[k]]));
// every hook fails when run alone; fmt-check only on test_a
const ALL_FAIL = "  fmt-check) if [ \"$4\" = tests/test_a.py ]; then echo 'fmt-check..........Failed'; echo 'Diff in tests/test_a.py at line 2'; exit 1; fi;;\n  clippy) echo 'clippy: cannot find function new_thing'; exit 1;;\n  suite) echo 'suite: 1 failed'; exit 1;;";

test("6.2.2 2107: format_files.py: no check_hooks: no hook runs alone and nothing fails, whatever the fixer runs exit with", () => {
  const r = hookRepo(ALL_FAIL);
  try {
    const o = r.runF();
    assert.equal(o.ran, true, o.note);
    assert.deepEqual(pick6(o), NONE);
    assert.deepEqual(r.calls().filter((x) => !x.startsWith("--files")), [], "no per-id run");
  } finally {
    r.done();
  }
});

test("6.2.2 re-review D-M1: format_files.py: a listed hook runs once on all the round's files; only on failure is each file re-run alone, and only the failing file is blamed", () => {
  const r = hookRepo(ALL_FAIL);
  try {
    const o = r.runF(["fmt-check"]);
    assert.equal(o.ran, true, o.note);
    assert.equal(o.hook_failed, true);
    assert.deepEqual(o.hook_failures, [["tests/test_a.py", "fmt-check"]]);
    assert.match(o.hook_head, /^\[fmt-check\] fmt-check\.+Failed/);
    assert.match(o.hook_head, /Diff in tests\/test_a\.py at line 2/);
    assert.match(o.hook_sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(o.hook_head, /clippy|suite/);
    // one run on both files, then one isolated run per file; unlisted hooks never run
    assert.deepEqual(r.calls().filter((x) => !x.startsWith("--files")), ["fmt-check tests/test_a.py", "fmt-check tests/test_a.py", "fmt-check tests/test_b.py"]);
  } finally {
    r.done();
  }
  // a listed hook that passes on all files runs once and is never isolated
  const q = hookRepo("  fmt-check) exit 0;;");
  try {
    assert.deepEqual(pick6(q.runF(["fmt-check"])), NONE);
    assert.deepEqual(q.calls().filter((x) => !x.startsWith("--files")), ["fmt-check tests/test_a.py"]);
  } finally {
    q.done();
  }
});

// a whole-tree hook (pass_filenames: false) fails on what is in the checkout, whatever files it is given;
// a file-scoped hook fails on the files it is given; a combination hook fails only with both files
const WHOLE = "  clippy) if grep -q 'assert  1' tests/test_a.py 2>/dev/null; then echo 'clippy: test_a is bad'; exit 1; fi;;";
const SCOPED = "  fmt-check) shift 3; for f in \"$@\"; do if [ \"$f\" = tests/test_a.py ]; then echo 'fmt-check: test_a is bad'; exit 1; fi; done;;";
const COMBO = "  clippy) if [ -f tests/test_a.py ] && [ -f tests/test_b.py ]; then echo 'clippy: a and b clash'; exit 1; fi;;";

test("6.2.2 re-review D-M1: a listed whole-tree hook (pass_filenames: false) blames only the bad file; a file-scoped hook gives the same result", () => {
  for (const [body, id] of [[WHOLE, "clippy"], [SCOPED, "fmt-check"]]) {
    const r = hookRepo(body);
    try {
      const o = r.runF([id]);
      assert.equal(o.hook_failed, true, id);
      assert.deepEqual(o.hook_failures, [["tests/test_a.py", id]], id);
      assert.match(o.hook_head, new RegExp("^\\[" + id + "\\] " + id + ": test_a is bad"));
    } finally {
      r.done();
    }
  }
});

test("6.2.2 re-review D-M1: a failure that needs the files together, with no file failing alone, is a whole-tree failure (file \"\")", () => {
  const r = hookRepo(COMBO);
  try {
    const o = r.runF(["clippy"]);
    assert.equal(o.hook_failed, true);
    assert.deepEqual(o.hook_failures, [["", "clippy"]]);
    assert.match(o.hook_head, /^\[clippy\] clippy: a and b clash/);
  } finally {
    r.done();
  }
});

test("6.2.2 2107 / review L1: format_files.py: an unknown id, or one whose stages exclude pre-commit, runs nothing and is named with a reason", () => {
  let r = hookRepo(ALL_FAIL);
  try {
    const o = r.runF(["fmt-check", "nope", "push-only"]);
    assert.equal(o.ran, false);
    assert.deepEqual(o.unknown_hooks, ["nope: not in .pre-commit-config.yaml", "push-only: its stages (pre-push) exclude pre-commit"]);
    assert.deepEqual(r.calls(), [], "nothing ran");
    // the legacy stage name `commit` is the pre-commit stage
    assert.deepEqual(r.runF(["legacy-commit"]).unknown_hooks, []);
  } finally {
    r.done();
  }
  // default_stages without the pre-commit stage applies to a hook with no stages of its own
  r = hookRepo(ALL_FAIL, "default_stages: [pre-push]\n" + CFG622);
  try {
    assert.deepEqual(r.runF(["fmt-check"]).unknown_hooks, ["fmt-check: its stages (pre-push) exclude pre-commit"]);
  } finally {
    r.done();
  }
  // pre-commit's own refusal (a stage a remote manifest set) is reported the same way, never as a failure
  r = hookRepo("  fmt-check) echo 'No hook with id `fmt-check` in stage `pre-commit`'; exit 1;;");
  try {
    const o = r.runF(["fmt-check"]);
    assert.equal(o.hook_failed, false);
    assert.deepEqual(o.unknown_hooks, ["fmt-check: pre-commit has no such hook at the pre-commit stage"]);
  } finally {
    r.done();
  }
});

test("6.2.2 review L2 / re-review D-L1: format_files.py: a listed hook that runs past its time is a check timeout, not a failure; a fixer run past its time is a fixer timeout", () => {
  let r = hookRepo("  fmt-check) sleep 5;;");
  try {
    const o = r.runF(["fmt-check"], 1);
    assert.equal(o.hook_failed, false);
    assert.deepEqual(o.hook_failures, []);
    assert.deepEqual(o.hook_timeout, ["fmt-check"]);
    assert.equal(o.fix_timeout, false);
  } finally {
    r.done();
  }
  r = hookRepo("  fmt-check) exit 0;;", undefined, "sleep 5");
  try {
    const o = r.runF(["fmt-check"], 1);
    assert.equal(o.fix_timeout, true);
    assert.equal(o.stable, false);
    assert.deepEqual(o.hook_timeout, []);
    assert.equal(o.hook_failed, false);
  } finally {
    r.done();
  }
  const src = readFileSync(join(SCRIPTS_SRC, "format_files.py"), "utf8");
  // the fixers keep their 5.x budget (3 runs of at most tmo); the checks get their own, inside one step ceiling
  assert.match(src, /timeout=tmo, env=dict\(env, PATH=clean_path\(\[wt, scratch_root\]\)\), preexec_fn=lift\)/);
  const n = (k) => Number(new RegExp(k + " = (\\d+)").exec(src)[1]);
  assert.equal(n("CHECK_BUDGET"), 240);
  assert.ok(n("STEP_CEILING") <= 570, "the step stays under the 600 s Bash limit");
});

test("6.2.2 review M2: format_files.py: the failing hooks' head is at most 300 printable characters; the sha256 covers the whole output", () => {
  const r = hookRepo("  fmt-check) printf '\\033[31mred\\033[0m\\001\\n'; i=0; while [ $i -lt 400 ]; do echo \"line $i of a long hook report\"; i=$((i+1)); done; exit 1;;");
  try {
    const o = r.runF(["fmt-check"]);
    assert.equal(o.hook_failed, true);
    assert.ok(o.hook_head.length <= 300, String(o.hook_head.length));
    assert.match(o.hook_head, /^\[fmt-check\] red\?/);
    assert.doesNotMatch(o.hook_head, /[^\n\x20-\x7e]/);
    assert.match(o.hook_sha256, /^[0-9a-f]{64}$/);
  } finally {
    r.done();
  }
});

// ---------------------------------------------------------------- 2104

const PROSE = ["sha256sum lines for the 40 scripts and roles/* (46 files) follow."];
// the probe's lines without its hash lines, plus a prose summary
function proseProbe() {
  return scriptsProbe().filter((x) => !/^[0-9a-f]{64} /.test(x)).concat(PROSE);
}
function relayMutate(first, second) {
  return {
    label: "preflight",
    fn: (r, prompt, label) => Object.assign(r, { scripts_probe: label === "preflight" ? first() : second() }),
  };
}

test("6.2.2 2104: a prose-only scripts_probe is retried once, then stops with its own reason (no 'missing', no reinstall)", async () => {
  const s = happy();
  s.__mutate = relayMutate(proseProbe, proseProbe);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.deepEqual(out.labels, ["preflight", "preflight:relay-retry"]);
  assert.match(out.result.reason, /preflight agent returned no hash lines/);
  assert.doesNotMatch(out.result.reason, /missing|install|reinstall/);
  const retry = call(out, "preflight:relay-retry").prompt;
  assert.match(retry, /returned no hash lines/);
  assert.match(retry, /every output line/);
});

test("6.2.2 2104: a prose relay then a full relay passes preflight", async () => {
  const s = happy();
  s.__mutate = relayMutate(proseProbe, () => scriptsProbe());
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("preflight:relay-retry"));
  assert.ok(out.result.gate_log.some((g) => /preflight: the agent relayed no hash lines; retried once/.test(g)), out.result.gate_log.join("\n"));
});

// the workflow's own count: every shipped program, role file and shared file
const FULL = scriptsProbe();
const WANT = FULL.filter((x) => /^[0-9a-f]{64} /.test(x)).length;
const META = FULL.filter((x) => !/^[0-9a-f]{64} /.test(x) && !/^hash_lines=/.test(x));
const FIRST10 = FULL.filter((x) => /^[0-9a-f]{64} /.test(x)).slice(0, 10);

test("6.2.2 review M1: 10 of the expected hash lines is a relay drop when the count line says more, is missing or is doubled: retried, then 'relayed 10 of N expected'", async () => {
  for (const [name, counts] of [
    ["true count", ["hash_lines=" + WANT]],
    ["count dropped", []],
    ["count doubled", ["hash_lines=10", "hash_lines=10"]],
  ]) {
    const partial = () => META.concat(counts, FIRST10);
    const s = happy();
    s.__mutate = relayMutate(partial, partial);
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", name);
    assert.equal(out.result.stop_gate, "contract", name);
    assert.deepEqual(out.labels, ["preflight", "preflight:relay-retry"], name);
    assert.match(out.result.reason, new RegExp("preflight agent relayed 10 of " + WANT + " expected hash lines \\(after one retry\\)"), name + ": " + out.result.reason);
    assert.doesNotMatch(out.result.reason, /is missing/, name);
    assert.ok(out.result.reason.includes("no line for: "), name);
  }
});

test("6.2.2 review M1: every hash line but no single hash_lines= line (none, or two) is a relay drop too", async () => {
  for (const counts of [[], ["hash_lines=" + WANT, "hash_lines=" + WANT]]) {
    const relay = () => META.concat(counts, FULL.filter((x) => /^[0-9a-f]{64} /.test(x)));
    const s = happy();
    s.__mutate = relayMutate(relay, relay);
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(counts));
    assert.deepEqual(out.labels, ["preflight", "preflight:relay-retry"]);
    assert.match(out.result.reason, new RegExp("preflight agent relayed " + counts.length + " hash_lines= lines \\(the probe prints one\\)"));
  }
  // and a retry that brings the full relay passes
  const s = happy();
  s.__mutate = relayMutate(() => META.concat(FULL.filter((x) => /^[0-9a-f]{64} /.test(x))), () => scriptsProbe());
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("6.2.2 re-review D-L2: one count line equal to the lines relayed, short of the tables, is a file absent on disk: no retry, named with the install text", async () => {
  // a real missing file: the probe hashed one file fewer and counted it
  let s = happy();
  s.preflight = Object.assign({}, s.preflight, { scripts_probe: scriptsProbe({ sums: { hasher: undefined } }) });
  let out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.deepEqual(out.labels, ["preflight"]);
  assert.match(out.result.reason, /hasher\.py is absent from the installed plugin/);
  assert.match(out.result.reason, /install fleet 6\.3\.0/);
  assert.doesNotMatch(out.result.reason, /relayed/);
  // 10 lines with a count of 10 reads the same way
  s = happy();
  s.preflight = Object.assign({}, s.preflight, { scripts_probe: META.concat(["hash_lines=10"], FIRST10) });
  out = await runOne(s, ARGS);
  assert.deepEqual(out.labels, ["preflight"]);
  assert.match(out.result.reason, /is absent from the installed plugin/);
});

test("6.2.2 2104: the probe, run for real, prints hash_lines= with the count of its sha256sum lines before them", { skip: spawnSync("python3", ["-c", "1"]).status !== 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-622-probe-"));
  try {
    const ver = join(home, ".claude", "plugins", "cache", "mkt", "fleet", SCRIPTS_DIR.split("/").slice(-2)[0]);
    mkdirSync(join(ver, "scripts"), { recursive: true });
    for (const [n] of PROGRAMS) cpSync(join(SCRIPTS_SRC, n + ".py"), join(ver, "scripts", n + ".py"));
    cpSync(join(SCRIPTS_SRC, "..", "roles"), join(ver, "roles"), { recursive: true });
    const p = spawnSync("bash", ["-c", await PREFLIGHT_PROBE()], { encoding: "utf8", env: Object.assign({}, process.env, { HOME: home }) });
    assert.equal(p.status, 0, p.stderr);
    const lines = p.stdout.split("\n");
    const counts = lines.filter((x) => x.startsWith("hash_lines="));
    assert.equal(counts.length, 1, p.stdout);
    const hashes = lines.filter((x) => /^[0-9a-f]{64} /.test(x));
    assert.equal(counts[0], "hash_lines=" + hashes.length);
    assert.ok(hashes.length >= PROGRAMS.length + 10);
    assert.ok(lines.indexOf(counts[0]) < lines.indexOf(hashes[0]), "the count comes before the hash lines");
    // and the workflow accepts the real relay
    const s = happy();
    delete s.__dispatch;
    s.preflight = { scripts_probe: lines, scripts_dir: join(ver, "scripts") };
    const out = await runOne(s, ARGS);
    assert.ok(out.labels.length > 1 && out.labels[1] !== "preflight:relay-retry", out.result && out.result.reason);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
