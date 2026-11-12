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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
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

// ---------------------------------------------------------------- 2107

const HOOK_OUT = "cargo-fmt..............Failed\n- hook id: cargo-fmt\n- exit code: 1\n\nDiff in tests/test_a.py at line 13";
// a format_files result for the writers' files, relayed with its digest
function hookResult(prompt, failed) {
  const sel = inputsOf(prompt).select;
  return { status: "ok", reason: "ran", note: "ran pre-commit run --files in a scratch checkout of HEAD", ran: true, runs: 1, stable: true, files: sel.paths || [], changed: [], refused: [], purged: 0, purged_paths: [], hook_failed: failed, hook_output: failed ? HOOK_OUT : "" };
}
const failing = (prompt) => hookResult(prompt, true);
const passing = (prompt) => hookResult(prompt, false);

function round(n, writers) {
  const s = {};
  for (const id of writers) s["role:fleet-test-writer:" + id + ":r" + n] = { status: "ok", reason: "fixed", criterion_id: id, tests: [], files: ["tests/test_" + (id === "AC1" ? "a" : "b") + ".py"] };
  s["hasher:post-writers:r" + n] = { status: "ok", fingerprint: FP_TESTS, changed: writers.map((id) => "tests/test_" + (id === "AC1" ? "a" : "b") + ".py") };
  return s;
}

test("6.2.2 2107: format_files relays hook_failed and hook_output; both are digest keys and schema-typed", () => {
  const keys = K("format_files");
  assert.ok(keys.includes("hook_failed") && keys.includes("hook_output"), keys.join(","));
});

test("6.2.2 2107: a check-only hook failing on a writer file sends a fix_tests round to the writers, never the judge, and never freezes then", async () => {
  const s = happy({
    script: Object.assign(
      {
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
    assert.match(w.routed_findings[0].finding, /pre-commit hook/);
  }
  assert.ok(out.result.gate_log.some((g) => /format-tests:r1: a pre-commit hook fails on the test files/.test(g)), out.result.gate_log.join("\n"));
});

test("6.2.2 2107: a hook still failing in the last test round stops for a human with the hook output; no judge, no freeze", async () => {
  const s = happy({
    script: Object.assign(
      { "infra:format-tests:r1": failing, "infra:format-tests:r2": failing, "infra:format-tests:r3": failing },
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

test("6.2.2 2107: a passing hook leaves the test round unchanged; a failing hook on the coder's files is not acted on here", async () => {
  let out = await run(happy({ script: { "infra:format-tests:r1": passing } }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("role:fleet-test-judge:r1"));
  assert.ok(!out.labels.includes("role:fleet-test-writer:AC1:r2"));
  out = await run(happy({ script: { "infra:format-code:r1": (prompt) => Object.assign(hookResult(prompt, true), { files: ["src/x.py"] }) } }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("6.2.2 2107: a format result without a boolean hook_failed is a broken relay", async () => {
  const out = await run(happy({ script: { "infra:format-tests:r1": (prompt) => Object.assign(passing(prompt), { hook_failed: "no" }) } }), ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /hook_failed/);
});

// format_files.py run for real with a fake pre-commit
function hookRepo(preCommitBody) {
  const home = mkdtempSync(join(tmpdir(), "fleet-622-"));
  const wt = join(home, "repo");
  const bin = join(home, "bin");
  mkdirSync(join(wt, "tests"), { recursive: true });
  mkdirSync(bin);
  sh(wt, "git", "init", "-q");
  sh(wt, "git", "config", "user.email", "t@example.com");
  sh(wt, "git", "config", "user.name", "t");
  sh(wt, "git", "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos:\n  - repo: local\n    hooks:\n      - id: fmt-check\n        name: fmt-check\n        entry: fmt --check\n        language: system\n");
  writeFileSync(join(wt, "src.py"), "x = 1\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-qm", "base");
  writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\n" + preCommitBody, { mode: 0o755 });
  writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    assert  1\n");
  const runF = () => {
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "format_files.py"), wt, JSON.stringify({ paths: ["tests/test_a.py"] }), "[]", join(home, "scratch"), "60"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.doesNotMatch(o.note, /hook surface unknown/, o.note);
    return o;
  };
  return { wt, runF, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("6.2.2 2107: format_files.py reports a check-only hook that fails and changes nothing", () => {
  const r = hookRepo("echo 'fmt-check..........Failed'\necho 'Diff in tests/test_a.py at line 2'\nexit 1\n");
  try {
    const o = r.runF();
    assert.equal(o.ran, true, o.note);
    assert.equal(o.stable, true);
    assert.deepEqual(o.changed, []);
    assert.equal(o.hook_failed, true);
    assert.match(o.hook_output, /fmt-check\.+Failed/);
    assert.match(o.hook_output, /Diff in tests\/test_a\.py at line 2/);
  } finally {
    r.done();
  }
});

test("6.2.2 2107: format_files.py: a fixer that rewrites then passes is no failure; a clean pass is none; the output is capped and printable", () => {
  // first run rewrites and exits 1 (pre-commit's fixer status), the second finds nothing and exits 0
  let r = hookRepo('f=tests/test_a.py\nif grep -q "  1" "$f"; then sed -i "s/  1/ 1/" "$f"; echo fixed; exit 1; fi\nexit 0\n');
  try {
    const o = r.runF();
    assert.equal(o.hook_failed, false, o.hook_output);
    assert.deepEqual(o.changed, ["tests/test_a.py"]);
    assert.equal(o.hook_output, "");
  } finally {
    r.done();
  }
  r = hookRepo("exit 0\n");
  try {
    const o = r.runF();
    assert.equal(o.hook_failed, false);
    assert.equal(o.hook_output, "");
  } finally {
    r.done();
  }
  r = hookRepo("printf '\\033[31mred\\033[0m\\001\\n'\ni=0\nwhile [ $i -lt 400 ]; do echo \"line $i of a long hook report\"; i=$((i+1)); done\nexit 1\n");
  try {
    const o = r.runF();
    assert.equal(o.hook_failed, true);
    assert.ok(o.hook_output.length <= 2000, String(o.hook_output.length));
    assert.match(o.hook_output, /line 399 of a long hook report$/);
    assert.doesNotMatch(o.hook_output, /[^\n\x20-\x7e]/);
  } finally {
    r.done();
  }
});

test("6.2.2 2107: no hook ran (no config, nothing to format) is no failure", () => {
  const r = hookRepo("exit 1\n");
  try {
    rmSync(join(r.wt, "tests", "test_a.py"));
    const o = r.runF();
    assert.equal(o.ran, false);
    assert.equal(o.hook_failed, false);
    assert.equal(o.hook_output, "");
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
