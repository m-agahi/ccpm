// fleet 6.2.2: three bug fixes ruled by Max (ledger 2104, 2106, 2107).
//
// 2106 / ADR-1235: the ownership gate compares only refs under
//   refs/fleet/<own task id>/* (and the run's own layout key). Another run's
//   refs in the shared git-common-dir are never blamed on this run's roles.
// 2107 / ADR-1234: format_files.py reports the exit status of the final,
//   stable pre-commit run (check-only hooks included). A failure on the
//   writers' files sends a fix_tests round to the writers with the hook
//   output; the run never freezes while a hook fails on a test file.
// 2104: the preflight probe prints its own count of hash lines. A relay with
//   no hash line, or fewer than the count, is retried once; then a distinct
//   reason, never "missing" and never "reinstall".

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

// ---------------------------------------------------------------- 2107 (ADR-1237)

const HOOK_OUT = "[cargo-fmt] cargo fmt..............Failed\n- hook id: cargo-fmt\n- exit code: 1\n\nDiff in tests/test_a.py at line 13";
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
// the sealed policy read: the repos override's pre_freeze_hooks (undefined: no list)
const policyWith = (hooks) => (p) => ({
  status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64),
  caps: Object.assign({}, DEFAULT_CAPS, hooks === undefined ? {} : { pre_freeze_hooks: hooks }),
  matched: "profile personal, repos[\"o/r\"]", error: null, args: inputsOf(p).args,
});
// a format_files result for the writers' files
function hookResult(prompt, failed, over) {
  const sel = inputsOf(prompt).select;
  return Object.assign({ status: "ok", reason: "ran", note: "ran pre-commit run --files in a scratch checkout of HEAD", ran: true, runs: 1, stable: true, files: sel.paths || [], changed: [], refused: [], purged: 0, purged_paths: [], hook_failed: failed, hook_output: failed ? HOOK_OUT : "", unknown_hooks: [] }, over || {});
}
const failing = (prompt) => hookResult(prompt, true);
const passing = (prompt) => hookResult(prompt, false);
const selectOf = (out, label) => inputsOf(call(out, label).prompt).select;

function round(n, writers) {
  const s = {};
  for (const id of writers) s["role:fleet-test-writer:" + id + ":r" + n] = { status: "ok", reason: "fixed", criterion_id: id, tests: [], files: ["tests/test_" + (id === "AC1" ? "a" : "b") + ".py"] };
  s["hasher:post-writers:r" + n] = { status: "ok", fingerprint: FP_TESTS, changed: writers.map((id) => "tests/test_" + (id === "AC1" ? "a" : "b") + ".py") };
  return s;
}

test("6.2.2 2107: format_files relays hook_failed, hook_output and unknown_hooks as digest keys; the policy caps type pre_freeze_hooks", () => {
  const keys = K("format_files");
  for (const k of ["hook_failed", "hook_output", "unknown_hooks"]) assert.ok(keys.includes(k), keys.join(","));
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

test("6.2.2 2107: a listed hook failing on a writer file sends a fix_tests round to the writers, never the judge, and never freezes then", async () => {
  const s = happy({
    script: Object.assign(
      {
        "infra:policy": policyWith(["cargo-fmt"]),
        "infra:format-tests:r1": failing,
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
  assert.deepEqual(selectOf(out, "infra:format-tests:r1"), { paths: ["tests/test_a.py", "tests/test_b.py"], check_hooks: ["cargo-fmt"] });
  assert.equal(selectOf(out, "infra:format-code:r1").check_hooks, undefined, "the coder's files are never checked here");
  const l = out.labels;
  assert.ok(!l.includes("role:fleet-test-judge:r1"), "no test judge on a failing hook");
  assert.ok(l.indexOf("role:fleet-test-writer:AC1:r2") > l.indexOf("infra:format-tests:r1"));
  assert.ok(l.indexOf("hasher:freeze:f1") > l.indexOf("role:fleet-test-judge:r2"), "the freeze follows the judge's approval of a clean round");
  for (const id of ["AC1", "AC2"]) {
    const w = inputsOf(call(out, "role:fleet-test-writer:" + id + ":r2").prompt);
    assert.equal(w.routed_findings.length, 1, id);
    assert.equal(w.routed_findings[0].criterion, id);
    assert.equal(w.routed_findings[0].target, "tests");
    assert.ok(w.routed_findings[0].finding.includes(HOOK_OUT), w.routed_findings[0].finding);
    assert.match(w.routed_findings[0].finding, /pre_freeze_hooks \(cargo-fmt\)/);
  }
  assert.ok(out.result.gate_log.some((g) => /format-tests:r1: a pre-commit hook fails on the test files/.test(g)), out.result.gate_log.join("\n"));
});

test("6.2.2 2107: a listed hook still failing in the last test round stops for a human with the hook output; no judge, no freeze", async () => {
  const s = happy({
    script: Object.assign(
      { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": failing, "infra:format-tests:r2": failing, "infra:format-tests:r3": failing },
      round(2, ["AC1", "AC2"]),
      round(3, ["AC1", "AC2"]),
    ),
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "cap");
  assert.match(out.result.reason, /pre-commit hook still fails on the test files after 3 test round\(s\)/);
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

test("6.2.2 2107: a listed id the repo's config does not have stops for a human, naming it", async () => {
  const out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt", "nope"]), "infra:format-tests:r1": (p) => hookResult(p, false, { ran: false, note: "pre-freeze hook id(s) not in .pre-commit-config.yaml: nope; no hook was run", unknown_hooks: ["nope"] }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "policy");
  assert.match(out.result.reason, /pre_freeze_hooks names hook id\(s\) not in \.pre-commit-config\.yaml: nope/);
  assert.ok(!out.labels.some((x) => /^hasher:freeze:/.test(x)));
});

test("6.2.2 2107: listed hooks that could not run (no pre-commit) stop for a human; a bad sealed list stops too", async () => {
  let out = await run(happy({ script: { "infra:policy": policyWith(["cargo-fmt"]), "infra:format-tests:r1": (p) => hookResult(p, false, { ran: false, note: "pre-commit is not installed" }) } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "policy");
  assert.match(out.result.reason, /pre_freeze_hooks \(cargo-fmt\) did not run \(pre-commit is not installed\)/);
  for (const bad of ["cargo-fmt", [""], ["a b"], ["-x"], [1]]) {
    out = await run(happy({ script: { "infra:policy": policyWith(bad) } }), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(bad));
    assert.equal(out.result.stop_gate, "policy", JSON.stringify(bad));
  }
});

test("6.2.2 2107: a format result without a boolean hook_failed or a list unknown_hooks is a broken relay", async () => {
  for (const over of [{ hook_failed: "no" }, { unknown_hooks: null }]) {
    const out = await run(happy({ script: { "infra:format-tests:r1": (prompt) => hookResult(prompt, false, over) } }), ARGS);
    assert.equal(out.result.status, "failed", JSON.stringify(over));
    assert.match(out.result.reason, /hook_failed|unknown_hooks/);
  }
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

test("6.2.2 2107: policy.py: a pre_freeze_hooks that is not a list of hook ids makes the policy invalid; the key is per repo only", () => {
  for (const bad of ["cargo-fmt", [""], [1], ["a b"], ["-x"], [null], { a: 1 }]) {
    const o = policyRun(polDoc({ pre_freeze_hooks: bad }));
    assert.equal(o.caps, null, JSON.stringify(bad));
    assert.match(o.error, /pre_freeze_hooks must be a list of hook ids/, JSON.stringify(bad));
  }
  const p = policyRun(polDoc({}, { pre_freeze_hooks: ["cargo-fmt"] }));
  assert.equal(p.caps, null);
  assert.match(p.error, /unknown key "pre_freeze_hooks"/);
});

// format_files.py run for real with a fake pre-commit: `pre-commit run --files ...`
// (the fixer runs) exits 0; `pre-commit run <id> --files ...` follows the case below
const CFG622 = "repos:\n  - repo: local\n    hooks:\n      - id: fmt-check\n        name: fmt-check\n        entry: fmt --check\n        language: system\n      - id: clippy\n        name: clippy\n        entry: clippy --all-targets\n        language: system\n        pass_filenames: false\n      - id: suite\n        name: suite\n        entry: suite\n        language: system\n        always_run: true\n";
function hookRepo(perId) {
  const home = mkdtempSync(join(tmpdir(), "fleet-622-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  mkdirSync(join(wt, "tests"), { recursive: true });
  mkdirSync(bin);
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, ".pre-commit-config.yaml"), CFG622);
  writeFileSync(join(wt, "src.py"), "x = 1\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  const log = join(home, "log");
  writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\necho \"$2\" >> '" + log + "'\nif [ \"$2\" = --files ]; then exit 1; fi\ncase \"$2\" in\n" + perId + "\nesac\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    assert  1\n");
  const runF = (check) => {
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
    const sel = check === undefined ? { paths: ["tests/test_a.py"] } : { paths: ["tests/test_a.py"], check_hooks: check };
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "format_files.py"), wt, JSON.stringify(sel), "[]", join(home, "scratch"), "60"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.doesNotMatch(o.note, /hook surface unknown/, o.note);
    return o;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { wt, runF, calls, done: () => rmSync(home, { recursive: true, force: true }) };
}
// every hook fails when run alone: the clippy-style and the always_run hook too
const ALL_FAIL = "  fmt-check) echo 'fmt-check..........Failed'; echo 'Diff in tests/test_a.py at line 2'; exit 1;;\n  clippy) echo 'clippy: cannot find function new_thing'; exit 1;;\n  suite) echo 'suite: 1 failed'; exit 1;;";

test("6.2.2 2107: format_files.py: no check_hooks: no hook runs alone and nothing fails, whatever the fixer runs exit with", () => {
  const r = hookRepo(ALL_FAIL);
  try {
    const o = r.runF();
    assert.equal(o.ran, true, o.note);
    assert.equal(o.hook_failed, false);
    assert.equal(o.hook_output, "");
    assert.deepEqual(o.unknown_hooks, []);
    assert.deepEqual(r.calls().filter((x) => x !== "--files"), [], "no per-id run");
  } finally {
    r.done();
  }
});

test("6.2.2 2107: format_files.py: a listed check-only hook that fails is reported; unlisted pass_filenames:false and always_run hooks never run alone", () => {
  const r = hookRepo(ALL_FAIL);
  try {
    const o = r.runF(["fmt-check"]);
    assert.equal(o.ran, true, o.note);
    assert.equal(o.hook_failed, true);
    assert.match(o.hook_output, /^\[fmt-check\] fmt-check\.+Failed/);
    assert.match(o.hook_output, /Diff in tests\/test_a\.py at line 2/);
    assert.doesNotMatch(o.hook_output, /clippy|suite/);
    assert.deepEqual(r.calls().filter((x) => x !== "--files"), ["fmt-check"]);
  } finally {
    r.done();
  }
});

test("6.2.2 2107: format_files.py: a listed hook that passes is no failure; an unknown id runs nothing and is named", () => {
  let r = hookRepo("  fmt-check) exit 0;;\n  clippy) exit 1;;");
  try {
    const o = r.runF(["fmt-check"]);
    assert.equal(o.hook_failed, false);
    assert.equal(o.hook_output, "");
  } finally {
    r.done();
  }
  r = hookRepo(ALL_FAIL);
  try {
    const o = r.runF(["fmt-check", "nope"]);
    assert.equal(o.ran, false);
    assert.deepEqual(o.unknown_hooks, ["nope"]);
    assert.match(o.note, /not in \.pre-commit-config\.yaml: nope/);
    assert.deepEqual(r.calls(), [], "nothing ran");
  } finally {
    r.done();
  }
});

test("6.2.2 2107: format_files.py: the failing hooks' output is capped and printable", () => {
  const r = hookRepo("  fmt-check) printf '\\033[31mred\\033[0m\\001\\n'; i=0; while [ $i -lt 400 ]; do echo \"line $i of a long hook report\"; i=$((i+1)); done; exit 1;;");
  try {
    const o = r.runF(["fmt-check"]);
    assert.equal(o.hook_failed, true);
    assert.ok(o.hook_output.length <= 2000, String(o.hook_output.length));
    assert.match(o.hook_output, /line 399 of a long hook report$/);
    assert.doesNotMatch(o.hook_output, /[^\n\x20-\x7e]/);
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

test("6.2.2 2104: fewer hash lines than the probe's own count is a relay drop: retried, then 'relayed N of M', never 'missing'", async () => {
  const full = scriptsProbe();
  const nHash = full.filter((x) => /^[0-9a-f]{64} /.test(x)).length;
  // the count line the real probe prints, then only the first 10 hash lines
  const partial = () => {
    const meta = full.filter((x) => !/^[0-9a-f]{64} /.test(x) && !/^hash_lines=/.test(x));
    return meta.concat(["hash_lines=" + nHash], full.filter((x) => /^[0-9a-f]{64} /.test(x)).slice(0, 10));
  };
  const s = happy();
  s.__mutate = relayMutate(partial, partial);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "contract");
  assert.deepEqual(out.labels, ["preflight", "preflight:relay-retry"]);
  assert.match(out.result.reason, new RegExp("preflight agent relayed 10 of " + nHash + " hash lines"));
  assert.doesNotMatch(out.result.reason, /missing|install|reinstall/);
});

test("6.2.2 2104: lines that all arrive, but no line for one file, still name that file 'missing' (no retry)", async () => {
  const s = happy();
  s.preflight = Object.assign({}, s.preflight, { scripts_probe: scriptsProbe({ sums: { hasher: undefined } }) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.deepEqual(out.labels, ["preflight"]);
  assert.match(out.result.reason, /hasher\.py is missing/);
  assert.doesNotMatch(out.result.reason, /plan_files\.py is missing/, "only the absent file");
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
