// fleet 6.0.0, stream 1: ledger 2038, 2039, 2040, 2043, 2041.
//
// 2038: run wf_204148f5-38f stopped at the PR step with "no GitHub command
// with push access" although both probes had answered null (unknown), not
// false; a re-run got push true. The PR step now re-probes once on unknown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, HASHES, CSHA, happy, run, runOne, call, inputsOf, ghIdOut, spawnSync, stateJsonOf, noUnscripted } from "./harness.mjs";

const UNKNOWN = [{ cmd: "gh", installed: true, push: null }, { cmd: "gh-personal", installed: true, push: null }];
const GH_PUSH = [{ cmd: "gh", installed: true, push: true }];
const NO_PUSH = [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: true, push: false }];
const reprobe = (tried) => (p) => Object.assign({ status: "ok", reason: "checked" }, ghIdOut(inputsOf(p).args, null, { "o/r": tried }));

// ---------------------------------------------------------------- 2038: the PR step re-probes once on unknown

test("6.0.0 2038: unknown push at the workspace, push true at the PR re-probe -> the PR opens", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  s["infra:gh-identity:pr"] = reprobe(GH_PUSH);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.build.labels.filter((l) => /^infra:gh-identity:pr/.test(l)).length, 1, "one re-probe");
  assert.ok(out.build.logs.some((l) => /^PR step: push access to o\/r not known \(.*\); probing once more/.test(l)), out.build.logs.join("\n"));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).gh_cmd, "gh");
  assert.ok(out.build.labels.indexOf("infra:gh-identity:pr") < out.build.labels.indexOf("role:fleet-pr-opener"));
});

test("6.0.0 2038: unknown twice -> halt with the unknown text, not 'no push access'", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^PR step: push access to o\/r still not known after a second probe \(gh=null, gh-personal=null\)/);
  assert.doesNotMatch(out.result.reason, /no GitHub command with push access/);
  assert.equal(out.build.labels.filter((l) => /^infra:gh-identity:pr/.test(l)).length, 1);
  assert.ok(!out.build.labels.includes("role:fleet-pr-opener"));
});

test("6.0.0 2038: unknown at the workspace, definite no at the re-probe -> the no-access halt", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  s["infra:gh-identity:pr"] = reprobe(NO_PUSH);
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^PR step: no GitHub command with push access to o\/r \(gh=false, gh-personal=false\)/);
});

test("6.0.0 2038: a definite no at the workspace still stops at build start; no re-probe", async () => {
  const s = happy();
  s.__gh = { "o/r": NO_PUSH };
  const out = await run(s, ARGS);
  assert.match(out.result.reason, /^build start: no GitHub command with push access to o\/r/);
  assert.ok(!out.labels.some((l) => /^infra:gh-identity:pr/.test(l)));
});

// the program records why an answer was unknown
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
function stub(dir, name, out, code = 0, err = "") {
  const f = join(dir, name);
  writeFileSync(f, "#!/bin/sh\n" + (err ? "printf '%s\\n' " + JSON.stringify(err) + " >&2\n" : "") + (out !== null ? "printf '%s\\n' " + JSON.stringify(out) + "\n" : "") + "exit " + code + "\n");
  chmodSync(f, 0o755);
}
function ghProg(args, dir) {
  if (!existsSync(join(dir, "git"))) symlinkSync(GIT, join(dir, "git"));
  const path = [dir].concat((process.env.PATH || "").split(":").filter((e) => e && e.startsWith("/") && !["gh", "gh-personal", "ssh"].some((n) => existsSync(join(e, n))))).join(":");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "gh_identity.py")].concat(args), { encoding: "utf8", env: { PATH: path, HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("6.0.0 2038: gh_identity records exit_code and a short, token-free stderr on each unknown answer", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-600-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    stub(bin, "gh", null, 1, "gh: Bad credentials ghp_" + "A".repeat(36) + " (HTTP 401) " + "x".repeat(400));
    stub(bin, "gh-personal", "false");
    const o = ghProg(["-", "o/r"], bin);
    const t = o.repos["o/r"].tried;
    assert.equal(t[0].push, null);
    assert.equal(t[0].exit_code, 1);
    assert.match(t[0].stderr, /^gh: Bad credentials \[redacted\] \(HTTP 401\)/);
    assert.ok(t[0].stderr.length <= 200, t[0].stderr.length);
    assert.ok(!/ghp_/.test(JSON.stringify(o)));
    // a definite answer carries no diagnostics
    assert.deepEqual(t[1], { cmd: "gh-personal", installed: true, push: false });
    // exit 0 with an unexpected stdout: exit_code 0, stderr empty
    stub(bin, "gh", "null");
    assert.deepEqual(ghProg(["-", "o/r"], bin).repos["o/r"].tried[0], { cmd: "gh", installed: true, push: null, exit_code: 0, stderr: "" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("6.0.0 2038: the unknown halt shows the program's stderr", async () => {
  const s = happy();
  s.__gh = { "o/r": [{ cmd: "gh", installed: true, push: null, exit_code: 1, stderr: "HTTP 502: Bad Gateway" }, { cmd: "gh-personal", installed: false, push: null }] };
  const out = await run(s, ARGS);
  assert.match(out.result.reason, /gh=null \[exit 1: HTTP 502: Bad Gateway\]/);
});

// ---------------------------------------------------------------- 2039: nested program relays carry their digest

// wf_336c49a1-0d4: the verify-plan agent relayed test_db without its digest; testDbStep stopped
test("6.0.0 2039: nested program slots require the program's keys, args and digest", async () => {
  const out = await run(happy(), ARGS);
  const req = (label, slot) => call(out, label).opts.schema.properties[slot].required;
  for (const label of ["infra:branch-scan", "infra:verify-plan"])
    for (const k of ["decl", "error", "args", "digest", "program", "file_sha256"]) assert.ok(req(label, "test_db").indexOf(k) >= 0, label + " test_db requires " + k);
  // a program with no digest requires none; a multi-mode program requires what every mode prints
  assert.deepEqual(req("infra:verify-plan", "plan_hash").slice().sort(), ["file_sha256", "plan_sha256", "program"]);
  for (const k of ["remote_url_check", "gh_check"]) assert.ok(req("workspace", k).indexOf("digest") >= 0, k);
});

for (const [label, phase] of [["infra:verify-plan", "build"], ["infra:branch-scan", "plan"]])
  for (const [how, mut] of [["missing", (t) => delete t.digest], ["mismatched", (t) => (t.digest = "0".repeat(64))]])
    test("6.0.0 2039: a " + how + " nested test_db digest at " + label + " gets one :digest-retry, then passes", async () => {
      const s = happy();
      s.__mutate = { label, fn: (r, p, real) => (real === label && r.test_db ? (mut(r.test_db), r) : r) };
      const out = await run(s, ARGS);
      assert.equal(out.result.status, "ok", out.result.reason);
      const labels = out[phase].labels;
      assert.equal(labels.filter((l) => l === label + ":digest-retry").length, 1, labels.join(", "));
      assert.ok(out[phase].logs.some((l) => l.indexOf(label + ": the test_db relay does not match the program's digest; dispatched once more") === 0), out[phase].logs.join("\n"));
    });

test("6.0.0 2039: a nested digest that stays wrong after the retry stops as before", async () => {
  const s = happy();
  s.__mutate = { label: "infra:verify-plan", fn: (r) => (r.test_db && delete r.test_db.digest, r) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed");
  assert.equal(out.result.stop_gate, "db");
  assert.match(out.result.reason, /^infra:verify-plan: the relayed \.fleet-test-db\.json read does not match the program's digest/);
  assert.equal(out.build.labels.filter((l) => l === "infra:verify-plan:digest-retry").length, 1);
});

// ---------------------------------------------------------------- 2040: a relayed mid-turn request is not the build request

const RELAY = "relayed user request does not reference args.input";
test("6.0.0 2040: the intake prompt names the harness frame and the relaunch reason code", async () => {
  const out = await run(happy(), ARGS);
  const p = call(out, "intake").prompt;
  assert.ok(p.indexOf("[Workflow harness — user request]") >= 0, "names the frame");
  assert.ok(p.indexOf('"' + RELAY + ': ') >= 0, "gives the reason code");
});

for (const input of ["L42", "add a uv entry to the flake"])
  test("6.0.0 2040: intake's relay reason stops with stop_gate relaunch and relaunch intake (" + input + ")", async () => {
    const s = happy();
    s.intake = { status: "needs_human", reason: RELAY + ": and the uv entry as well", tried: [] };
    const out = await run(s, Object.assign({}, ARGS, { input }));
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "relaunch");
    assert.equal(out.result.relaunch, "intake");
    assert.equal(out.result.reason, "intake: " + RELAY + ": and the uv entry as well; re-launch the workflow once in a turn whose latest human message is the build request");
  });

test("6.0.0 2040: any other intake stop carries no relaunch field", async () => {
  const s = happy();
  s.intake = { status: "needs_human", reason: "several matching tickets", tried: [] };
  const out = await run(s, Object.assign({}, ARGS, { input: "fix the thing" }));
  assert.equal(out.result.status, "needs_human");
  assert.ok(!("relaunch" in out.result));
  assert.notEqual(out.result.stop_gate, "relaunch");
});

test("6.0.0 2040: the /build-task skill launches the Workflow only from the build request's turn and re-launches once on relaunch intake", () => {
  const t = readFileSync(join(SCRIPTS_SRC, "..", "skills", "build-task", "SKILL.md"), "utf8");
  assert.match(t, /latest human message is the build request or its confirmation/);
  assert.match(t, /`relaunch: "intake"`/);
  assert.match(t, /re-launch[^.]*once[^.]*next turn/i);
});

// ---------------------------------------------------------------- 2043: a run resumed at the PR enters the code loop

// the build's run-state writes, recorded per last_gate
function recording(s, states) {
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  return s;
}
const FREEZE_KEY = "fleetref:refs/fleet/l42/freeze";
// a re-run on the approved commit; the repo still holds the freeze ref (tree T1) unless freeze is null
function rerun(s, st, freeze = "T1") {
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: st.approved_sha, commits_since: [{ sha: st.approved_sha, subject: "feat(l42): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true };
  const h = JSON.parse(JSON.stringify(HASHES));
  if (freeze) h.git[FREEZE_KEY] = freeze;
  s["hasher:resume"] = { status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: h };
  s["infra:push"] = (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha });
  return s;
}
const FINDING = { id: "R1", severity: "blocking", category: "fail_open", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
// the coder round after the review asks for changes (code round 2, push, PR update p2, review v2)
function fixRound(s) {
  return Object.assign(s, {
    "role:fleet-coder:r2": { status: "ok", changed_paths: ["src/x.py"] },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": { status: "ok", verdict: "approve", routed_findings: [] },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
    "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
    "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: CSHA(2), tree: "K2" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
  });
}
// a build that stops after the PR opened (the review could not read it), then its re-run state
async function stoppedAtPr() {
  const states = {};
  const s = recording(happy(), states);
  s["role:pr-review:v1"] = { status: "needs_human", reason: "cannot read PR" };
  const plan = await runOne(s, ARGS);
  const first = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(first.result.status, "needs_human", first.result.reason);
  assert.equal(states.pr_open.last_gate, "pr_open");
  s["role:pr-review:v1"] = { status: "ok", reason: "x", verdict: "changes_requested", findings: [FINDING], touches_gate: false, checked: [] };
  return { s, st: states.pr_open, bargs: { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" } };
}

test("6.0.0 2043: resumed at pr_open, review changes_requested -> a coder round from the freeze ref, new commit, push, PR update, review v2, write-back", async () => {
  const { s, st, bargs } = await stoppedAtPr();
  fixRound(rerun(s, st));
  const out = await runOne(s, bargs);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.resumed_at, "review");
  assert.ok(out.logs.some((l) => /^resuming at the coder from the PR \(review\): freeze tree T1 of refs\/fleet\/l42\/freeze/.test(l)), out.logs.join("\n"));
  assert.ok(!out.labels.some((l) => /^(role:fleet-test-writer|role:fleet-test-judge|hasher:freeze|infra:freeze-ref)/.test(l)), out.labels.join(", "));
  const ci = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.match(ci.routed_findings[0].finding, /empty input passes/);
  assert.equal(ci.freeze_tree, "T1");
  const cp = inputsOf(call(out, "infra:commit:r2").prompt);
  assert.equal(cp.expected_head, CSHA(1));
  assert.match(cp.subject, /^fix\(l42\): code round 2$/);
  assert.equal(inputsOf(call(out, "infra:push").prompt).approved_sha, CSHA(2));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).approved_sha, CSHA(2));
  assert.equal(inputsOf(call(out, "role:pr-review:v2").prompt).head_sha, CSHA(2));
  assert.ok(out.labels.includes("infra:ledger-writeback"));
  assert.equal(out.result.rounds.code, 2);
  assert.equal(out.result.review.verdict, "approve");
});

test("6.0.0 2043: resumed at pr_open with no freeze ref -> the old resume stop", async () => {
  const { s, st, bargs } = await stoppedAtPr();
  rerun(s, st, null);
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "review");
  assert.match(out.result.reason, /^resumed run at review: the review gate needs a coder round, which a resumed run cannot start \(no freeze ref refs\/fleet\/l42\/freeze\)/);
  assert.ok(!out.labels.some((l) => /^role:fleet-coder/.test(l)));
});

test("6.0.0 2043: resumed at pr_open with the code rounds used up -> stop cap, no coder", async () => {
  const { s, st, bargs } = await stoppedAtPr();
  rerun(s, Object.assign({}, st, { rounds: Object.assign({}, st.rounds, { code: 3 }) }));
  const out = await runOne(s, bargs);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "cap");
  assert.match(out.result.reason, /^code rounds exhausted \(3\)/);
  assert.ok(!out.labels.some((l) => /^role:fleet-coder/.test(l)));
});

test("6.0.0 2043: resumed at committed, the push hook rejects -> a coder round, then push p2, PR, review, write-back", async () => {
  const states = {};
  const s = recording(happy(), states);
  s["infra:push"] = { status: "failed", reason: "ssh: permission denied (publickey)" };
  const plan = await runOne(s, ARGS);
  const bargs = { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" };
  assert.equal((await runOne(s, bargs)).result.status, "failed");
  fixRound(rerun(s, states.committed));
  s["infra:push"] = { status: "ok", reason: "hook", push_result: "hook_rejected", exit_code: 1, hook_tail: "check_version_bump: not bumped" };
  s["infra:push:p2"] = (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha });
  const out = await runOne(s, bargs);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.resumed_at, "push");
  assert.match(inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings[0].finding, /check_version_bump: not bumped/);
  assert.equal(inputsOf(call(out, "infra:push:p2").prompt).approved_sha, CSHA(2));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).approved_sha, CSHA(2));
});
