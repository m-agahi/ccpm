// fleet 4.0.0 stream S3 (overhead and access): ledger 1990 (infra model
// tiers, preflight cache), 1985 (push-access probe) and 1988
// (.claude/settings.local.json in the fingerprint).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE,
  ARGS,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  pathRecheckOut,
  sha256,
  H,
  HASHES_FLAT,
  FP_TESTS,
  FP_K1,
  FP_PRE,
} from "./harness.mjs";

// ---------------------------------------------------------------- 1990 tiers

// The INFRA_TIER table, read from the script source.
function infraTier() {
  const m = /\/\/ INFRA_TIER_BEGIN\n([\s\S]*?)\n\/\/ INFRA_TIER_END/.exec(SOURCE);
  assert.ok(m, "INFRA_TIER markers present");
  return Function(m[1] + "\nreturn INFRA_TIER;")();
}
function tierOf(table, label) {
  const hit = table.find(([p]) => label.indexOf(p) === 0);
  return hit ? hit[1] : null;
}

// The tier each infra label must run on (the plan's table, with the brief's
// overrides: park-plan on sonnet, load-parked on haiku; labels the plan does
// not name stay on sonnet).
const WANT = [
  [/^infra:path-check:/, "haiku"],
  [/^preflight/, "haiku"],
  [/^workspace$/, "haiku"],
  [/^infra:branch-scan$/, "haiku"],
  [/^infra:stage-plan/, "haiku"],
  [/^infra:verify-plan/, "haiku"],
  [/^infra:read-state$/, "haiku"],
  [/^infra:callers/, "haiku"],
  [/^infra:check-scripts/, "haiku"],
  [/^infra:precommit-ids/, "haiku"],
  [/^infra:review-paths/, "haiku"],
  [/^infra:remote-head/, "haiku"],
  [/^infra:load-parked$/, "haiku"],
  [/^intake/, "sonnet"],
  [/^hasher:/, "sonnet"],
  [/^infra:load-ref/, "sonnet"],
  [/^infra:commit-plan/, "sonnet"],
  [/^infra:park-plan/, "sonnet"],
  [/^infra:format-/, "sonnet"],
  [/^infra:commit:/, "sonnet"],
  [/^infra:push/, "sonnet"],
  [/^infra:tf-gate/, "sonnet"],
  [/^infra:hook-surface/, "sonnet"],
  [/^infra:changed-defs/, "sonnet"],
  [/^infra:replan-/, "sonnet"],
  [/^infra:state:/, "sonnet"],
  [/^infra:(fleet-scan|purge-bytecode|review-cleanup|ledger-|yaadgaar-|comments-)/, "sonnet"],
];
function wantTier(label) {
  const w = WANT.find(([re]) => re.test(label));
  return w ? w[1] : null;
}

test("4.0.0 1990 AC-1990-2: every infra agent runs on its INFRA_TIER model; every PATH check on haiku", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  let checks = 0;
  for (const c of out.calls) {
    if (c.label.indexOf("role:") === 0) {
      assert.equal(c.opts.model, "sonnet", c.label + " runs on its DISPATCH tier");
      continue;
    }
    const w = wantTier(c.label);
    assert.ok(w, "no expected tier for " + c.label);
    assert.equal(c.opts.model, w, c.label);
    if (/^infra:path-check:/.test(c.label)) checks++;
  }
  assert.ok(checks >= 10, "the happy run has its PATH checks");
});

test("4.0.0 1990: every agent label in the script resolves in INFRA_TIER, and the table has no catch-all", () => {
  const table = infraTier();
  assert.ok(Array.isArray(table) && table.length > 10);
  for (const [p, t] of table) {
    assert.ok(typeof p === "string" && p.length > 3, "no empty or catch-all prefix: " + JSON.stringify(p));
    assert.ok(t === "haiku" || t === "sonnet", p + " -> " + t);
  }
  const labels = new Set();
  for (const m of SOURCE.matchAll(/"((?:infra|hasher|intake|preflight|workspace)[a-z0-9:_-]*)"/g)) labels.add(m[1]);
  // built from another label at run time
  labels.add("infra:remote-head:push");
  assert.ok(labels.size > 40);
  for (const l of labels) {
    for (const sfx of ["", "x", ":replan", ":retry", ":audit-fix", ":p2", "1"]) {
      const label = l + sfx;
      if (l === "hasher") continue; // the program name, not a label
      const t = tierOf(table, label);
      assert.ok(t, "no INFRA_TIER entry for " + label);
      const w = wantTier(label);
      if (w) assert.equal(t, w, label);
    }
  }
});

test("4.0.0 1990: a haiku PATH check whose relay is broken is retried once on sonnet; a real finding is not", async () => {
  // relay drift: the digest does not match the relayed values
  const s = happy();
  s["infra:path-check:plan-audit"] = (prompt) => {
    const i = inputsOf(prompt);
    const r = pathRecheckOut({}, [i.repo, i.token]);
    r.digest = "0".repeat(64);
    return r;
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const retry = call(out, "infra:path-check:plan-audit:relay-retry");
  assert.equal(retry.opts.model, "sonnet");
  assert.equal(call(out, "infra:path-check:plan-audit").opts.model, "haiku");
  // the retry has its own token
  assert.notEqual(inputsOf(retry.prompt).token, inputsOf(call(out, "infra:path-check:plan-audit").prompt).token);
  // twice broken -> the iac stop, as before
  const s2 = happy();
  const broken = (prompt) => {
    const i = inputsOf(prompt);
    const r = pathRecheckOut({}, [i.repo, i.token]);
    r.digest = "0".repeat(64);
    return r;
  };
  s2["infra:path-check:plan-audit"] = broken;
  s2["infra:path-check:plan-audit:relay-retry"] = broken;
  const o2 = await runOne(s2, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.stop_gate, "iac");
  // a real IaC tool on PATH is a finding: no retry
  const s3 = happy();
  s3["infra:path-check:plan-audit"] = (prompt) => {
    const i = inputsOf(prompt);
    return pathRecheckOut({ ["terra" + "form"]: { path: "/usr/bin/x", real: "/usr/bin/x", shim: false } }, [i.repo, i.token]);
  };
  const o3 = await runOne(s3, ARGS);
  assert.equal(o3.result.stop_gate, "iac");
  assert.ok(!o3.labels.includes("infra:path-check:plan-audit:relay-retry"), o3.labels.join(", "));
  // a dead or not-ok haiku check is retried on sonnet too
  const s4 = happy();
  s4["infra:path-check:plan-audit"] = null;
  const o4 = await runOne(s4, ARGS);
  assert.equal(o4.result.status, "awaiting_confirmation", o4.result.reason);
  assert.ok(o4.labels.includes("infra:path-check:plan-audit:relay-retry"));
});

// ---------------------------------------------------------------- 1988 settings.local.json

const MAIN_WT = "/r/.claude/worktrees/fleet-l42-add-thing/main";
const SETTINGS = ".claude/settings.local.json";
// the bytes the workspace step writes (settingsFor in the script)
const settingsFor = (wt) => JSON.stringify({ permissions: { allow: ["Edit(/" + wt + "/**)", "Write(/" + wt + "/**)"] } });
const OWN = sha256(settingsFor(MAIN_WT));
function withIgnored(fp, ignored) {
  const h = H({ ...HASHES_FLAT });
  h.ignored = ignored;
  return { status: "ok", fingerprint: fp, hashes: h };
}

test("4.0.0 1988 AC-1988-1: the fleet's own settings.local.json appearing during a judge, a writer round or the coder is no stop", async () => {
  // a judge run and a writer round: absent before, the fleet's exact bytes after
  for (const label of ["hasher:fp-post:test-judge:r1", "hasher:post-writers:r1"]) {
    const s = happy();
    const orig = s[label];
    s[label] = (prompt) => {
      const r = typeof orig === "function" ? orig(prompt) : JSON.parse(JSON.stringify(orig));
      return Object.assign(r, { hashes: withIgnored(FP_TESTS, { [SETTINGS]: OWN }).hashes });
    };
    // absent before (explicit: the harness seeds earlier states from the freeze stub)
    s["hasher:pre-writers:r1"] = withIgnored(FP_PRE, {});
    // the file stays: every later state holds it
    s["hasher:freeze:f1"] = withIgnored(FP_TESTS, { [SETTINGS]: OWN });
    s["hasher:post-coder:r1"] = withIgnored(FP_K1, { [SETTINGS]: OWN });
    const out = await run(s, ARGS);
    noUnscripted(out);
    assert.equal(out.result.status, "ok", label + ": " + out.result.reason);
    // it was absent before the step under test
    const at = out.build.labels.indexOf(label);
    assert.ok(at > 0, label);
  }
  // the coder round: the frozen maps lack it, the post-coder maps have it
  const s = happy();
  s["hasher:post-coder:r1"] = withIgnored(FP_K1, { [SETTINGS]: OWN });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  // between test approval and the freeze
  const s2 = happy();
  s2["hasher:pre-writers:r1"] = withIgnored(FP_PRE, {});
  s2["hasher:freeze:f1"] = withIgnored(FP_TESTS, { [SETTINGS]: OWN });
  s2["hasher:post-coder:r1"] = withIgnored(FP_K1, { [SETTINGS]: OWN });
  const o2 = await run(s2, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
});

// A fix_tests re-entry (as fixTestsReentry in build_task_run.test.mjs) where
// the fleet's settings file appears in the writer round and stays.
test("4.0.0 1988: the fleet's own settings file appearing in a fix_tests round passes the re-freeze; the log lists only the test file", async () => {
  const testFinding = { target: "tests", criterion: "AC1", finding: "wrong expectation" };
  const h = H({ ...HASHES_FLAT, "tests/test_a.py": "ha2" });
  h.ignored = { [SETTINGS]: OWN };
  const M3 = { head: "abc1234def0", tree: "M3" };
  const K2 = { head: "abc1234def0", tree: "K2" };
  const s = happy({
    script: {
      "role:fleet-code-judge:r1": { status: "ok", verdict: "fix_tests", routed_findings: [testFinding] },
      "role:fleet-test-judge:r2": { status: "ok", verdict: "revise", routed_findings: [testFinding] },
      "hasher:fp-post:test-judge:r2": { status: "ok", fingerprint: FP_K1 },
      "role:fleet-test-writer:AC1:r3": { status: "ok", criterion_id: "AC1" },
      "hasher:post-writers:r3": { status: "ok", fingerprint: M3, changed: ["tests/test_a.py"], hashes: h },
      "role:fleet-test-judge:r3": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:test-judge:r3": { status: "ok", fingerprint: M3 },
      "hasher:freeze:f2": { status: "ok", fingerprint: M3, hashes: h },
      "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
      "hasher:post-coder:r2": { status: "ok", fingerprint: K2, hashes: h },
      "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
      "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: K2 },
    },
  });
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.refreeze_log[0].changed, [{ path: "tests/test_a.py", before: "ha", after: "ha2" }]);
});

test("4.0.0 1988 AC-1988-2: other bytes (the fleet's plus a newline) stop, and the reason names the before and after hashes", async () => {
  const other = sha256(settingsFor(MAIN_WT) + "\n");
  const s = happy();
  s["hasher:fp-post:test-judge:r1"] = withIgnored(FP_TESTS, { [SETTINGS]: other });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "fingerprint");
  const why = out.result.reason;
  assert.match(why, /ignored path written: \.claude\/settings\.local\.json/);
  assert.ok(why.includes("not the fleet's own settings"), why);
  assert.ok(why.includes("before absent"), why);
  assert.ok(why.includes("after " + other), why);
  assert.ok(why.includes("the fleet's own " + OWN), why);
  assert.ok(why.includes("the harness or a role rewrote it"), why);
  // the code round names it too (as a finding or a stop)
  const s2 = happy();
  s2["hasher:post-coder:r1"] = withIgnored(FP_K1, { [SETTINGS]: other });
  const o2 = await run(s2, ARGS);
  assert.notEqual(o2.result.status, "ok");
  const seen = o2.calls.map((c) => c.prompt).concat([o2.result.reason]);
  assert.ok(seen.some((t) => t.includes("not the fleet's own settings") && t.includes("after " + other)), o2.result.reason);
});

test("4.0.0 1988 AC-1988-3: only the exact path with the exact bytes of this worktree is exempt", async () => {
  for (const [key, val] of [
    [".claude/settings.json", OWN],
    ["sub/.claude/settings.local.json", OWN],
    [".claude/settings.local.json.bak", OWN],
    ["./.claude/settings.local.json", OWN],
    // another worktree's settings bytes
    [SETTINGS, sha256(settingsFor("/r/.claude/worktrees/fleet-l42-add-thing/replan-1"))],
    [SETTINGS, "MISSING"],
  ]) {
    const s = happy();
    s["hasher:fp-post:test-judge:r1"] = withIgnored(FP_TESTS, { [key]: val });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", key + " " + val);
    assert.equal(out.result.stop_gate, "fingerprint", key);
    // the judge's own fingerprint stops it, not a later check
    assert.match(out.result.reason, /^judge mutated worktree: fleet-test-judge/, key);
  }
  // the same path in another map (a file git does not ignore) is never exempt
  const sf = happy();
  const hf = H({ ...HASHES_FLAT, [SETTINGS]: OWN });
  hf.ignored = { [SETTINGS]: OWN };
  sf["hasher:fp-post:test-judge:r1"] = { status: "ok", fingerprint: FP_TESTS, hashes: hf };
  const of = await run(sf, ARGS);
  assert.equal(of.result.stop_gate, "fingerprint", of.result.reason);
  assert.match(of.result.reason, /^judge mutated worktree: fleet-test-judge/);
  // the fleet's own file removed during a judge run is a stop
  const s = happy();
  s["hasher:pre-writers:r1"] = withIgnored({ head: "abc1234def0", tree: "T0" }, { [SETTINGS]: OWN });
  s["hasher:freeze:f1"] = withIgnored(FP_TESTS, { [SETTINGS]: OWN });
  s["hasher:fp-post:test-judge:r1"] = withIgnored(FP_TESTS, {});
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "fingerprint", out.result.reason);
});
