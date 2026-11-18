// fleet 7.1.1 (L2142, yaadgaar #35), AC4: pr_state report paths. A routed
// failed pr_state relay with a non-null error (valid program, args and digest)
// gets the same report as an ok relay with that error, and does not stop with
// 'returned failed'. Callers: cleanup, logs, rerun and the resume view.
//
// dont_care: out.result.ci.merged in the view example (the resumed personal run
// merges after its own CI watch); the order of warning lines; I/O failure paths
// (scripted relays only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, call, inputsOf, stateJsonOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "no policy file", error: null, now: 1000, args: inputsOf(p).args }, over);
function personal() {
  const s = happy();
  s["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  return s;
}
// watchOut('red') of v600_s3: one verified failed check
const redWatch = (p) => {
  const a = inputsOf(p).args;
  return {
    status: "ok",
    reason: "w",
    state: "red",
    checks: [{ name: "test", state: "FAILURE", bucket: "fail", url: "https://github.com/o/r/actions/runs/77/job/88" }],
    failed: [{ name: "test", url: "https://github.com/o/r/actions/runs/77/job/88", run_id: "77", excerpt: "FAILED tests/test_a.py::test_x", verified: true }],
    required: true,
    head: a[3],
    elapsed_s: 60,
    error: null,
    args: a,
  };
};
const cls = (cause) => ({ status: "ok", reason: "c", checks: [{ name: "test", cause }] });
// the step's relay as failed (routed) and as ok: both outcomes must be equal
async function both(make, label, relay, runIt) {
  const outs = [];
  for (const status of ["failed", "ok"]) {
    const s = make();
    s[label] = (p) => Object.assign(relay(p), { status });
    outs.push(await (runIt || ((x) => run(x, ARGS)))(s));
  }
  const pick = (o) => [o.result.status, o.result.stop_gate, o.result.reason];
  assert.deepEqual(pick(outs[0]), pick(outs[1]), "a routed failed relay equals the ok relay with the same error");
  return outs[0];
}

test("7.1.1 L2142 AC4: a routed failed pr_state cleanup relay is reported with a follow-up; the run ends ok", async () => {
  const out = await both(personal, "infra:fleet-cleanup", (p) => F("pr_state", "pr_state:cleanup", { mode: "cleanup", removed: false, deleted: false, error: "worktree busy" }, inputsOf(p).args));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.reason, "PR ready for review; merged as " + "e".repeat(40) + ", remote branch deleted");
  assert.ok(out.build.logs.some((l) => l.includes("warning: fleet cleanup not done: worktree busy")), out.build.logs.join("\n"));
  assert.ok(out.result.follow_ups.includes("remove the fleet worktree /r/.claude/worktrees/fleet-y42-add-thing/main and branch fleet/y42-add-thing by hand (worktree busy)"), JSON.stringify(out.result.follow_ups));
});

test("7.1.1 L2142 AC4: a routed failed pr_state logs relay is reported; the classifier gets no log tail", async () => {
  const mk = () => Object.assign(happy(), { "infra:ci-watch:w1": redWatch, "role:fleet-ci-classifier:w1": cls("pre_existing") });
  const out = await both(mk, "infra:ci-logs:w1", (p) => F("pr_state", "pr_state:logs", { mode: "logs", head: inputsOf(p).args[4], logs: null, error: "gh run view: HTTP 502" }, inputsOf(p).args));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.reason, "PR ready for review; CI red, reported with no code change: test (pre_existing, https://github.com/o/r/actions/runs/77/job/88)");
  assert.ok(out.build.logs.some((l) => l.includes("warning: CI log read failed (gh run view: HTTP 502); the classifier gets no log tail")), out.build.logs.join("\n"));
  assert.deepEqual(inputsOf(call(out, "role:fleet-ci-classifier:w1").prompt).checks, [{ name: "test", url: "https://github.com/o/r/actions/runs/77/job/88", run_id: "77", log_excerpt: null }]);
});

test("7.1.1 L2142 AC4: a routed failed pr_state rerun relay is reported; no rerun, and the expected merge stops at gate ci", async () => {
  const mk = () => Object.assign(personal(), { "infra:ci-watch:w1": redWatch, "role:fleet-ci-classifier:w1": cls("flaky") });
  const out = await both(mk, "infra:ci-rerun", (p) => F("pr_state", "pr_state:rerun", { mode: "rerun", rerun: [], error: "gh run rerun: HTTP 403" }, inputsOf(p).args));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ci");
  assert.equal(out.result.reason, "CI red, nothing merged: test (flaky, https://github.com/o/r/actions/runs/77/job/88)");
  assert.ok(out.build.logs.some((l) => l.includes("warning: rerun failed: gh run rerun: HTTP 403")), out.build.logs.join("\n"));
  assert.ok(!out.build.labels.includes("infra:ci-watch:w2"), out.build.labels.join(", "));
});

test("7.1.1 L2142 AC4: a routed failed pr_state view relay on resume is reported; the resume goes on to the stats and the CI watch", async () => {
  // the resume scenario of v600_s4 ("a resume finds the PR merged ..."), with the view read failing
  const s = personal();
  const states = {};
  s["infra:state:written_back"] = (prompt) => {
    states.written_back = stateJsonOf(prompt);
    return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
  };
  s["infra:ci-watch:w1"] = (p) => ({ status: "ok", reason: "w", state: "error", checks: [], failed: [], required: null, head: null, elapsed_s: 10, error: "crash", args: inputsOf(p).args });
  const first = await run(s, ARGS);
  assert.equal(first.result.status, "needs_human", first.result.reason);
  const st = states.written_back;
  const resume = (status) => {
    const r = personal();
    Object.assign(r, s);
    delete r["infra:ci-watch:w1"];
    r["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { head: st.approved_sha, commits_since: first.build.calls.filter((c) => /^infra:commit:r/.test(c.label)).map(() => ({ sha: st.approved_sha, subject: "feat(thing): add thing" })), changed_since: ["src/x.py"] });
    r["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true };
    r["hasher:resume"] = { status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: JSON.parse(JSON.stringify(happy()["hasher:freeze:f1"].hashes)) };
    r["infra:pr-view:resume"] = (p) => Object.assign(F("pr_state", "pr_state:view", { mode: "view", state: null, head: null, merge_sha: null, error: "gh pr view: HTTP 502" }, inputsOf(p).args), { status });
    return run(r, { mode: "build", plan_ref: first.plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  };
  const out = await resume("failed");
  const ok = await resume("ok");
  assert.deepEqual([out.result.status, out.result.stop_gate, out.result.reason], [ok.result.status, ok.result.stop_gate, ok.result.reason]);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.labels;
  assert.ok(!L.includes("infra:state:shipped:resume"), L.join(", "));
  const v = L.indexOf("infra:pr-view:resume");
  assert.ok(v >= 0 && L.indexOf("infra:pr-tests:resume") > v && L.indexOf("infra:pr-stats") > v, L.join(", "));
  assert.doesNotMatch(out.result.reason, /returned failed/);
});
