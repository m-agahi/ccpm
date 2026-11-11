// fleet 4.0.0 stream S3 (overhead and access): ledger 1990 (infra model
// tiers, preflight cache), 1985 (push-access probe) and 1988
// (.claude/settings.local.json in the fingerprint).
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PB,
  spawnSync,
  canon,
  commitStub,
  ROLE_NAMES,
  redigest,
  HAVE_PY,
  SCRIPTS_SRC,
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
  scriptsProbe,
  SCRIPTS_DIR,
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
  // 4.0.0 review (Max): workspace and precommit-ids moved to sonnet
  [/^workspace$/, "sonnet"],
  [/^infra:branch-scan$/, "haiku"],
  [/^infra:stage-plan/, "haiku"],
  [/^infra:verify-plan/, "haiku"],
  [/^infra:read-state$/, "haiku"],
  [/^infra:callers/, "haiku"],
  [/^infra:check-scripts/, "haiku"],
  [/^infra:precommit-ids/, "sonnet"],
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
  [/^infra:ruleset-surface/, "sonnet"],
  [/^infra:policy$/, "haiku"],
  [/^infra:pr-stats/, "sonnet"],
  [/^infra:pr-convention/, "haiku"],
  [/^infra:changed-defs/, "sonnet"],
  [/^infra:replan-/, "sonnet"],
  [/^infra:state:/, "sonnet"],
  [/^infra:(fleet-scan|purge-bytecode|review-cleanup|ledger-|yaadgaar-|comments-)/, "sonnet"],
  // 4.0.0 S5 (1987, 1981): writes with digest-checked relays
  [/^infra:freeze-ref/, "sonnet"],
  // 5.0.6 (ledger 2019): the build-dir program, mechanical
  [/^infra:build-/, "haiku"],
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

test("4.0.0 1990: a label with no INFRA_TIER entry stops the run (no default tier)", () => {
  const grab = (name) => {
    const i = SOURCE.indexOf("\nfunction " + name + "(");
    assert.ok(i >= 0, name);
    return SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  };
  const m = /\/\/ INFRA_TIER_BEGIN\n([\s\S]*?)\n\/\/ INFRA_TIER_END/.exec(SOURCE);
  const halt = (status, msg) => {
    const e = new Error(msg);
    e.status = status;
    throw e;
  };
  const infraModel = Function("halt", m[1] + "\n" + grab("infraModel") + "\nreturn infraModel;")(halt);
  assert.equal(infraModel("infra:path-check:coder:r1"), "haiku");
  assert.equal(infraModel("infra:push"), "sonnet");
  for (const bad of ["infra:bogus", "role:fleet-coder", "", "Preflight"])
    assert.throws(() => infraModel(bad), (e) => e.status === "failed" && /no INFRA_TIER entry for agent label/.test(e.message), JSON.stringify(bad));
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
  // the code judge's hash_recheck does not list the exempt change either
  const hr = inputsOf(call(out, "role:fleet-code-judge:r1").prompt).hash_recheck;
  assert.ok(!("ignored/" + SETTINGS in hr), JSON.stringify(hr));
  assert.ok(Object.values(hr).every((x) => x.match === true), JSON.stringify(hr));
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
  const M3 = { head: "b0de1234567", tree: "M3" };
  const K2 = { head: "b0de1234567", tree: "K2" };
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
  assert.deepEqual(out.result.refreeze_log[0].changed, [{ path: "tests/test_a.py", change: "changed" }]);
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
  s["hasher:pre-writers:r1"] = withIgnored({ head: "b0de1234567", tree: "T0" }, { [SETTINGS]: OWN });
  s["hasher:freeze:f1"] = withIgnored(FP_TESTS, { [SETTINGS]: OWN });
  s["hasher:fp-post:test-judge:r1"] = withIgnored(FP_TESTS, {});
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "fingerprint", out.result.reason);
});

// ---------------------------------------------------------------- 1985 push-access probe

const probe = (over) => Object.assign({ status: "ok", reason: "probed", access: "ok", result: "ok", exit_code: 0, auth_line: null, args: ["/tmp/p.out", "0"] }, over);

test("4.0.0 1985 AC-1985-1: an auth line from the dry run stops plan mode before the planner", async () => {
  const s = happy();
  const line = "ERROR: Permission to m-agahi/yadgar.git denied to quinyx-max.";
  s["infra:push-probe"] = probe({ access: "denied", result: "denied", exit_code: 128, auth_line: line, args: ["/tmp/p.out", "128"] });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(out.result.reason.includes(line), out.result.reason);
  assert.ok(!out.labels.includes("role:scope-and-plan"), out.labels.join(", "));
});

test("4.0.0 1985 AC-1985-2: hook_rejected, non_ff and fetch_first are access ok; the plan goes on", async () => {
  for (const [result, code] of [["hook_rejected", 1], ["non_ff", 1], ["fetch_first", 1], ["ok", 0]]) {
    const s = happy();
    s["infra:push-probe"] = probe({ result, exit_code: code, args: ["/tmp/p.out", String(code)] });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", result + ": " + out.result.reason);
    assert.ok(out.result.gate_log.some((g) => g.includes("push access ok: dry run " + result)), result);
  }
  // a timeout or an unknown result logs "push access unknown" and goes on
  for (const [result, code] of [["timeout", 124], ["unknown", 2]]) {
    const s = happy();
    s["infra:push-probe"] = probe({ access: "unknown", result, exit_code: code, args: ["/tmp/p.out", String(code)] });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", result + ": " + out.result.reason);
    assert.ok(out.result.gate_log.some((g) => g.startsWith("push access unknown")), result);
  }
});

test("4.0.0 1985: a probe relay that is not the program's own never halts and never passes an access verdict", async () => {
  const cases = [
    // a forged "denied" whose digest does not match: ignored, never a halt
    () => Object.assign(probe({ access: "denied", result: "denied", exit_code: 128, auth_line: "x", args: ["/tmp/p.out", "128"] }), { digest: "0".repeat(64) }),
    // args that are not the exit code it printed
    () => probe({ args: ["/tmp/p.out", "1"] }),
    () => null,
    () => ({ status: "failed", reason: "no git" }),
  ];
  for (const [k, f] of cases.entries()) {
    const s = happy();
    s["infra:push-probe"] = f;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", k + ": " + out.result.reason);
    assert.ok(out.result.gate_log.some((g) => g.startsWith("push access unknown")), String(k));
    assert.ok(!out.result.gate_log.some((g) => g.startsWith("push access ok")), String(k));
  }
  // a wrong program self-hash is no access verdict either
  const s = happy();
  s.__mutate = { label: "infra:push-probe", fn: (r, prompt) => {
    r.program = { name: "push_probe", sha256: "0".repeat(64) };
    return redigest("infra:push-probe", r, prompt);
  } };
  const out = await runOne(s, ARGS);
  assert.ok(out.result.gate_log.some((g) => g.startsWith("push access unknown") && g.includes("did not run the shipped program push_probe")), out.result.gate_log.join("\n"));
});

test("4.0.0 1985 AC-1985-3: the probe is a dry run with hooks, right after its own PATH re-check, after the workspace and before the planner", async () => {
  const out = await runOne(happy(), ARGS);
  noUnscripted(out);
  const c = call(out, "infra:push-probe");
  assert.match(c.prompt, /--dry-run/);
  assert.match(c.prompt, /push --dry-run --porcelain origin 'B0:refs\/heads\/fleet\/l42-add-thing'/);
  assert.doesNotMatch(c.prompt, /--no-verify/);
  assert.doesNotMatch(c.prompt, /hooksPath/);
  assert.match(c.prompt, /push_probe\.py/);
  assert.equal(c.opts.model, "sonnet");
  const L = out.labels;
  const at = L.indexOf("infra:push-probe");
  assert.equal(L[at - 1], "infra:path-check:push-probe", L.join(", "));
  assert.ok(L.indexOf("workspace") < at - 1);
  assert.ok(at < L.indexOf("role:scope-and-plan"));
  // a tool planted on PATH before the probe stops the run; the probe never runs
  const s = happy();
  s["infra:path-check:push-probe"] = (prompt) => {
    const i = inputsOf(prompt);
    return pathRecheckOut({ ["terra" + "form"]: { path: "/usr/bin/x", real: "/usr/bin/x", shim: false } }, [i.repo, i.token]);
  };
  const o2 = await runOne(s, ARGS);
  assert.equal(o2.result.stop_gate, "iac");
  assert.ok(!o2.labels.includes("infra:push-probe"));
});

test("4.0.0 1985 AC-1985-4: build mode dispatches no probe", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.plan.labels.includes("infra:push-probe"));
  assert.ok(!out.build.labels.some((l) => /push-probe/.test(l)), out.build.labels.join(", "));
});

test("4.0.0 1985 (real python): push_probe.py classifies the dry-run output", { skip: !HAVE_PY }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-probe-"));
  try {
    const go = (text, code) => {
      const f = join(dir, "out");
      writeFileSync(f, text);
      const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "push_probe.py"), f, String(code)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      const { digest, ...rest } = o;
      assert.equal(digest, sha256(canon(rest)));
      assert.deepEqual(o.args, [f, String(code)]);
      return o;
    };
    const to = "To github.com:o/r.git\n";
    let o = go(to + "*\tB0:refs/heads/fleet/x\t[new branch]\nDone\n", 0);
    assert.deepEqual([o.access, o.result], ["ok", "ok"]);
    o = go("error: failed to push some refs to 'x'\nhint: ...\n" + to + "!\tB0:refs/heads/fleet/x\t[rejected] (non-fast-forward)\nDone\n", 1);
    assert.deepEqual([o.access, o.result], ["ok", "non_ff"]);
    o = go("error: failed to push some refs to 'x'\n" + to + "!\tB0:refs/heads/fleet/x\t[rejected] (fetch first)\nDone\n", 1);
    assert.deepEqual([o.access, o.result], ["ok", "fetch_first"]);
    o = go("hook says no\nerror: failed to push some refs to 'x'\n", 1);
    assert.deepEqual([o.access, o.result], ["ok", "hook_rejected"]);
    o = go("ERROR: Permission to m-agahi/yadgar.git denied to quinyx-max.\nfatal: Could not read from remote repository.\n", 128);
    assert.deepEqual([o.access, o.result, o.auth_line], ["denied", "denied", "ERROR: Permission to m-agahi/yadgar.git denied to quinyx-max."]);
    for (const l of ["remote: Repository not found.", "fatal: Authentication failed for 'https://x'"]) {
      o = go(l + "\n", 128);
      assert.deepEqual([o.access, o.result], ["denied", "denied"], l);
    }
    o = go("", 124);
    assert.deepEqual([o.access, o.result, o.auth_line], ["unknown", "timeout", null]);
    o = go("fatal: unable to access 'https://x': Could not resolve host\n", 128);
    assert.deepEqual([o.access, o.result], ["unknown", "unknown"]);
    // a hook line with a fatal: is not a clean hook verdict
    o = go("fatal: something\nerror: failed to push some refs to 'x'\n", 1);
    assert.deepEqual([o.access, o.result], ["unknown", "unknown"]);
    assert.equal(o.program.name, "push_probe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 1990 preflight cache

// Rewrites the sealed plan ref in the store (resealed), and returns the tiny
// ref for it.
function reseal(s, tiny, fn) {
  const content = s.__store[tiny.plan_commit];
  const o = JSON.parse(content);
  fn(o);
  delete o.seal;
  o.seal = sha256(canon(o));
  const next = JSON.stringify(o) + (content.endsWith("\n") ? "\n" : "");
  s.__store[tiny.plan_commit] = next;
  return Object.assign({}, tiny, { ref_sha256: sha256(next) });
}
const BUILD = (tiny, over) => Object.assign({ mode: "build", plan_ref: tiny, date: "2026-11-04", project: "o/r" }, over || {});
const ROLE_LOAD = /agent_prompt_get/;
// 5.0.0 (R1): the preflight probe hashes every role file
// (5.0.0 R3: and the files of its _shared dir, one regular file at a time)
const ROLE_PROBE = /sha256sum -- "\$d"\/\*\.py; for f in "\$\{d%\/scripts\}\/roles"\/\* "\$\{d%\/scripts\}\/roles"\/_shared\/\*; do if \[ -f "\$f" \] && \[ ! -L "\$f" \]; then sha256sum -- "\$f"/;

// 5.0.0 (R1): was "a build with a cached preflight dispatches no more agents
// than before" (plan 17, build 50). The role pages are gone; every run's one
// preflight agent hashes the role files, so the counts are 4.0.3's: plan 17,
// build 50. No agent loads a yadgar page.
test("5.0.0 R1 (was 4.0.0 1990 AC-1990-1): absolute agent counts are 4.0.3's; every run's preflight hashes the role files", async () => {
  const out = await run(happy(), Object.assign({}, ARGS, { confirm: "ask" }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  // 6.0.0 (ledger 2041): + infra:ruleset-surface:plan
  // 6.0.0 (ledger 2042): + infra:pr-convention:plan
  assert.equal(out.plan.calls.length, 19, out.plan.labels.join(", "));
  assert.equal(out.planResult.agents, 19);
  // 5.0.6 (ledger 2019): + 7 build-dir resets (writers, test judge, coder,
  // code judge, commit, push, pr-review) and the teardown, which runs after
  // the result is made
  // 6.0.0 (ledger 2033): + infra:policy
  assert.equal(out.build.calls.length, 61, out.build.labels.join(", "));
  assert.equal(out.result.agents, 60);
  for (const o of [out.plan, out.build]) {
    const first = o.calls[0];
    assert.equal(first.label, "preflight");
    assert.equal(first.opts.model, "haiku");
    assert.match(first.prompt, /path_check\.py/);
    assert.match(first.prompt, /as one Bash call: bash -c '/, "the scripts directory probe runs in every run");
    assert.match(first.prompt, ROLE_PROBE, "the role files are hashed in every run");
    assert.equal(o.calls.filter((c) => ROLE_LOAD.test(c.prompt)).length, 0, "no agent loads a role page");
  }
  assert.ok(!out.labels.includes("preflight:roles"));
  // the build reports the role pins (the scenario's, all-sonnet)
  assert.deepEqual(Object.keys(out.result.role_sha256).sort(), ROLE_NAMES.slice().sort());
});

// 5.0.0 (R1): was "plan mode seals history.preflight {fleet_version, versions,
// dispatch, contract}; the build uses the sealed tier". The record is log only.
test("5.0.0 R1 (was 4.0.0 1990 seal): plan mode seals history.preflight {fleet_version, role_sha256}; never scripts_dir or the PATH check; the build's tier is its own install's", async () => {
  const s = happy();
  s.__dispatch["fleet-coder"] = "DISPATCH: model=opus (fallback=sonnet)";
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const ref = JSON.parse(s.__store[out.result.plan_ref.plan_commit]);
  const p = ref.history.preflight;
  assert.deepEqual(Object.keys(p).sort(), ["fleet_version", "role_sha256"]);
  assert.equal(p.fleet_version, "6.0.0");
  assert.deepEqual(Object.keys(p.role_sha256).sort(), ROLE_NAMES.slice().sort());
  const text = JSON.stringify(ref);
  assert.ok(!text.includes("scripts_dir") && !text.includes("path_check") && !text.includes("/fleet/5.0.8/scripts"), "no scripts dir or PATH check sealed");
  assert.ok(!text.includes("DISPATCH"), "no role text or tier sealed");
  // 6.0.0 (ledger 2044): + audits
  assert.deepEqual(Object.keys(out.result.cumulative).sort(), ["agents", "audits", "replans", "runs"]);
  const b = await runOne(s, BUILD(out.result.plan_ref));
  assert.equal(b.result.status, "ok", b.result.reason);
  assert.equal(call(b, "role:fleet-coder:r1").opts.model, "opus");
  // a build whose role files now say otherwise runs on the new tier
  const s2 = happy();
  const p2 = await runOne(s2, ARGS);
  s2.__dispatch["fleet-coder"] = "DISPATCH: model=haiku";
  const b2 = await runOne(s2, BUILD(p2.result.plan_ref));
  assert.equal(b2.result.status, "ok", b2.result.reason);
  assert.equal(call(b2, "role:fleet-coder:r1").opts.model, "haiku");
});

// 5.0.0 (R1): was "a 3.1.3 record, no record, or fresh_preflight loads the
// role pages; a 4.0.0 record does not". Now every build hashes the files.
test("5.0.0 R1 (was 4.0.0 1990 AC-1990-3): a 3.1.3, 4.x or no record, and fresh_preflight true or false: every build hashes the role files in its one preflight", async () => {
  const fixes = [
    (o) => (o.history.preflight = { fleet_version: "3.1.3", versions: {}, dispatch: {}, contract: {} }),
    (o) => (o.history.preflight = { fleet_version: "4.0.0", versions: { "plan-audit": 17 }, dispatch: { "plan-audit": "DISPATCH: model=fable" }, contract: { "plan-audit": "CONTRACT: fleet-v4" } }),
    (o) => delete o.history.preflight,
  ];
  for (const fix of fixes) {
    const s = happy();
    const plan = await runOne(s, ARGS);
    const tiny = reseal(s, plan.result.plan_ref, fix);
    const b = await runOne(s, BUILD(tiny));
    noUnscripted(b);
    assert.equal(b.result.status, "ok", b.result.reason);
    assert.match(b.calls[0].prompt, ROLE_PROBE);
    assert.equal(call(b, "role:fleet-coder:r1").opts.model, "sonnet", "the scenario files decide, never the sealed record");
  }
  for (const fresh of [true, false]) {
    const s = happy();
    const plan = await runOne(s, ARGS);
    const b = await runOne(s, BUILD(plan.result.plan_ref, { fresh_preflight: fresh }));
    noUnscripted(b);
    assert.equal(b.result.status, "ok", b.result.reason);
    // 5.0.6 (ledger 2019): 50 + 7 build-dir resets + the teardown
    // 6.0.0 (ledger 2033): + infra:policy
    assert.equal(b.calls.length, 61);
    assert.equal(b.labels.filter((l) => l === "preflight").length, 1);
  }
});

// 5.0.0 (R1): was "a page bumped after the plan shows at the first role call;
// the stop says re-run with fresh_preflight". A role file that changed after
// the plan, and is not its pin, stops the build at preflight before any role.
test("5.0.0 R1 (was 4.0.0 1990 page bumped): a role file that is not its pin at build time stops the build at preflight, before any role", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  s.preflight = { scripts_probe: scriptsProbe({ roleSums: { "fleet-test-judge.md": "e".repeat(64) } }), scripts_dir: SCRIPTS_DIR };
  const b = await runOne(s, BUILD(plan.result.plan_ref));
  assert.equal(b.result.status, "needs_human");
  assert.equal(b.result.stop_gate, "contract");
  assert.match(b.result.reason, /fleet-test-judge\.md hashes e{64}, not [0-9a-f]{64}.*install fleet 6\.0\.0/);
  assert.deepEqual(b.labels, ["preflight"]);
  assert.ok(!b.result.reason.includes("fresh_preflight"));
});

test("4.0.0 1990: args.fresh_preflight must be a boolean; checked before any agent", async () => {
  for (const v of ["yes", 1, null]) {
    const out = await runOne(happy(), Object.assign({}, ARGS, { fresh_preflight: v }));
    assert.equal(out.result.status, "needs_human");
    assert.match(out.result.reason, /args\.fresh_preflight must be true or false/);
    assert.equal(out.calls.length, 0);
  }
  const ok = await runOne(happy(), Object.assign({}, ARGS, { fresh_preflight: false }));
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
});

// 5.0.0 (R1): was "... with the role table it loaded; no second load"
test("5.0.0 R1 (was 4.0.0 1990 confirm auto): confirm auto builds in the plan run with the roles its one preflight pinned; no second preflight", async () => {
  // the auto gates' stubs (as autoHappy in build_task_run.test.mjs)
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: "b0de1234567", tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: "b0de1234567", tree: "P0" } },
  });
  const out = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.calls.filter((c) => ROLE_LOAD.test(c.prompt)).length, 0);
  assert.ok(!out.labels.includes("preflight:roles"));
  assert.equal(out.labels.filter((l) => l === "preflight").length, 1);
});

test("4.0.0 1990: a build-mode re-plan seals no preflight record (the next build loads the pages)", async () => {
  const PC2 = "0123456789ab";
  const s = happy();
  Object.assign(s, {
    "role:fleet-code-judge:r1": { status: "ok", reason: "plan wrong", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: "AC2", finding: "x — Proposed plan change: split AC2" }] },
    "infra:replan-worktree": { status: "ok", reason: "ok", head: "abc1234def0" },
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: "d".repeat(64) },
    "infra:replan-reset": { status: "ok", reason: "reset", head: "b0de1234567", superseded_head: "5555555" },
  });
  s["role:scope-and-plan:replan"] = s["role:scope-and-plan"];
  s["infra:commit-plan:replan"] = commitStub(s.__store, PC2, "d".repeat(64));
  const plan = await runOne(s, ARGS);
  const b = await runOne(s, BUILD(plan.result.plan_ref));
  assert.equal(b.result.status, "awaiting_confirmation", b.result.reason);
  const ref = JSON.parse(s.__store[PC2]);
  assert.equal(ref.history.replans, 1);
  assert.ok(!("preflight" in ref.history), JSON.stringify(ref.history));
});
