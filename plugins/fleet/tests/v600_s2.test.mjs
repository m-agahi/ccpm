// fleet 6.0.0, stream 2: ledger 2033 (per-owner policy), 2042 (plan doc off the
// pushed branch; commit and PR title and body conventions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_SRC, ARGS, happy, run, call, inputsOf, spawnSync, stateJsonOf } from "./harness.mjs";

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();

// ---------------------------------------------------------------- 2033: policy.py

const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
function policyProg(file, args) {
  const home = mkdtempSync(join(tmpdir(), "fleet-600pol-"));
  try {
    if (file !== null) {
      mkdirSync(join(home, ".config", "fleet"), { recursive: true });
      writeFileSync(join(home, ".config", "fleet", "policy.json"), typeof file === "string" ? file : JSON.stringify(file));
    }
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "policy.py")].concat(args), { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    o.__home = home;
    return o;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const POLICY = {
  version: 1,
  profiles: [
    {
      name: "personal",
      match: { hosts: ["github.com", "github-personal"], owners: ["m-agahi", "yadgarhq"] },
      merge: "auto",
      update_branch: "once",
      ci_trigger: true,
      review_post: "own_pr",
      ci_watch_minutes: 30,
      repos: { "yadgarhq/actions": { merge: "never" }, "yadgarhq/argo*": { merge: "never" } },
    },
    { name: "work", match: { owners: ["quinyx"] }, merge: "auto", review_post: "own_pr" },
  ],
};

test("6.0.0 2033: policy.py: no file -> the default profile (ready, CI watch and stats on, merge never)", () => {
  const o = policyProg(null, ["github.com", "m-agahi/ccpm"]);
  assert.equal(o.error, null);
  assert.equal(o.profile, null);
  assert.equal(o.policy_sha256, null);
  assert.equal(o.matched, "no policy file");
  assert.deepEqual(o.caps, DEFAULT_CAPS);
  assert.deepEqual(o.args, ["github.com", "m-agahi/ccpm"]);
  assert.equal(o.program.name, "policy");
  assert.match(o.digest, /^[0-9a-f]{64}$/);
});

test("6.0.0 2033: policy.py: first match on host and owner; per-repo glob override; unset caps keep the default", () => {
  const o = policyProg(POLICY, ["github-personal", "m-agahi/ccpm"]);
  assert.equal(o.error, null);
  assert.equal(o.profile, "personal");
  assert.match(o.policy_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(o.caps, Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true, review_post: "own_pr", ci_watch_minutes: 30 }));
  for (const repo of ["yadgarhq/actions", "YadgarHQ/Actions", "yadgarhq/argocd"]) {
    const p = policyProg(POLICY, ["github.com", repo]);
    assert.equal(p.profile, "personal", repo);
    assert.equal(p.caps.merge, "never", repo);
    assert.match(p.matched, /^profile personal, repos\["yadgarhq\/(actions|argo\*)"\]$/, repo);
  }
  // hosts listed: another host does not match
  const g = policyProg(POLICY, ["codeberg.org", "m-agahi/ccpm"]);
  assert.equal(g.profile, null);
  assert.equal(g.matched, "no profile matches codeberg.org m-agahi/ccpm");
  assert.deepEqual(g.caps, DEFAULT_CAPS);
  // no hosts listed: every host
  assert.equal(policyProg(POLICY, ["gitlab.com", "quinyx/x"]).profile, "work");
});

test("6.0.0 2033: policy.py: a bad file is an error, never the default (strict JSON, unknown keys, types, duplicates)", () => {
  const bad = [
    ["{", /not valid JSON/],
    [JSON.stringify({ version: 2, profiles: [] }), /version must be 1/],
    [JSON.stringify({ version: 1, profiles: [], extra: 1 }), /unknown key "extra"/],
    [JSON.stringify({ version: 1, profiles: [{ name: "p", match: { owners: ["a"] }, merge: "when_green" }] }), /profiles\[0\]\.merge/],
    [JSON.stringify({ version: 1, profiles: [{ name: "p", match: { owners: ["a"] }, pr_ready: "yes" }] }), /profiles\[0\]\.pr_ready/],
    [JSON.stringify({ version: 1, profiles: [{ name: "p", match: { owners: ["a"] }, mark_ready: true }] }), /unknown key "mark_ready"/],
    [JSON.stringify({ version: 1, profiles: [{ name: "p", match: {} }] }), /profiles\[0\]\.match\.owners/],
    [JSON.stringify({ version: 1, profiles: [{ name: "p", match: { owners: ["a"] }, ci_watch_minutes: 0 }] }), /ci_watch_minutes/],
    [JSON.stringify({ version: 1, profiles: [{ name: "p", match: { owners: ["a"] }, repos: { "a/b": { name: "x" } } }] }), /repos\["a\/b"\]: unknown key "name"/],
    ['{"version": 1, "version": 1, "profiles": []}', /duplicate key "version"/],
  ];
  for (const [text, re] of bad) {
    const o = policyProg(text, ["github.com", "a/b"]);
    assert.match(String(o.error), re, text);
    assert.equal(o.profile, null);
    assert.equal(o.caps, null, text);
  }
});

// ---------------------------------------------------------------- 2033: the policy step in the build

// the subject of the build commit in the happy path
const SUBJECT = "feat(l42): add thing";
const BARGS = (plan) => ({ mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "no policy file", error: null, args: inputsOf(p).args }, over);
function stateRecorder(s) {
  const states = {};
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  return states;
}

test("6.0.0 2033: the build reads the policy once after the run-state and seals profile, policy sha and caps in every run-state write", async () => {
  const s = happy();
  const states = stateRecorder(s);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const labels = out.build.labels;
  assert.equal(labels.filter((l) => l === "infra:policy").length, 1, labels.join(", "));
  assert.ok(labels.indexOf("infra:read-state") < labels.indexOf("infra:policy"));
  assert.ok(labels.indexOf("infra:policy") < labels.findIndex((l) => /^role:fleet-test-writer/.test(l)));
  assert.deepEqual(inputsOf(call(out, "infra:policy").prompt).args, ["-", "o/r"]);
  for (const g of ["committed", "pushed", "pr_open", "reviewed", "written_back"])
    assert.deepEqual(states[g].policy, { profile: null, policy_sha256: null, caps: DEFAULT_CAPS }, g);
  assert.ok(out.build.logs.indexOf("policy: no policy file (pr_ready true, ci_watch true 60 min, stats true, merge never, update_branch never, ci_trigger false, review_post none)") >= 0, out.build.logs.join("\n"));
  assert.deepEqual(out.result.policy, { profile: null, policy_sha256: null, caps: DEFAULT_CAPS });
});

test("6.0.0 2033: a work owner (quinyx, concrete-media, any host alias) gets merge and update_branch never whatever the policy says", async () => {
  for (const slug of ["quinyx/actions", "Concrete-Media/site"]) {
    const s = happy();
    s.workspace = Object.assign({}, s.workspace, { remote_slug: slug, remote_host: "github-personal" });
    s.__gh = { [slug]: [{ cmd: "gh", installed: true, push: true }] };
    s["role:fleet-pr-opener"] = Object.assign({}, s["role:fleet-pr-opener"], { pr_url: "https://github.com/" + slug + "/pull/7" });
    s["infra:policy"] = polOut({ profile: "work", policy_sha256: "c".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once" }), matched: "profile work" });
    const states = stateRecorder(s);
    const out = await run(s, ARGS);
    assert.deepEqual(inputsOf(call(out, "infra:policy").prompt).args, ["github-personal", slug]);
    assert.ok(out.build.logs.indexOf("work repo " + slug + ": merge and update_branch never (script rule; the policy said merge auto, update_branch once)") >= 0, out.build.logs.join("\n"));
    assert.deepEqual(states.committed.policy, { profile: "work", policy_sha256: "c".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { merge: "never", update_branch: "never" }) }, slug);
  }
});

test("6.0.0 2033: a policy file error stops the build (needs_human, gate policy); it never falls back to the default", async () => {
  const s = happy();
  s["infra:policy"] = polOut({ caps: null, matched: null, policy_sha256: "d".repeat(64), error: "policy file /h/.config/fleet/policy.json: profiles[0].merge must be one of never|auto" });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "policy");
  assert.equal(out.result.reason, "policy: policy file /h/.config/fleet/policy.json: profiles[0].merge must be one of never|auto; fix or remove the file, then re-run the build");
});

test("6.0.0 2033 (ruling 5.6): a resumed run whose policy changed logs the change and keeps the sealed profile", async () => {
  const s = happy();
  const states = stateRecorder(s);
  s["role:pr-review:v1"] = { status: "needs_human", reason: "cannot read PR" };
  const first = await run(s, ARGS);
  assert.equal(first.result.status, "needs_human", first.result.reason);
  const st = states.pr_open;
  s["role:pr-review:v1"] = happy()["role:pr-review:v1"];
  s["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { head: st.approved_sha, commits_since: first.build.calls.filter((c) => /^infra:commit:r/.test(c.label)).map(() => ({ sha: st.approved_sha, subject: SUBJECT })), changed_since: ["src/x.py"] });
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true };
  s["hasher:resume"] = { status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: JSON.parse(JSON.stringify(happy()["hasher:freeze:f1"].hashes)) };
  s["infra:policy"] = polOut({ profile: "personal", policy_sha256: "e".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { merge: "auto" }), matched: "profile personal" });
  delete states.reviewed;
  const out = await run(s, BARGS(first.plan));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.indexOf("policy changed since this run started (merge never -> auto); keeping the sealed profile default") >= 0, out.logs.join("\n"));
  assert.deepEqual(states.reviewed.policy, st.policy);
  assert.deepEqual(out.result.policy, st.policy);
});

test("6.0.0 2033: policy.example.json is a valid policy; yadgarhq/actions and yadgarhq/argocd keep merge never", () => {
  const ex = JSON.parse(readFileSync(join(SCRIPTS_SRC, "..", "policy.example.json"), "utf8"));
  assert.equal(policyProg(ex, ["github.com", "yadgarhq/docs"]).caps.merge, "auto");
  for (const r of ["yadgarhq/actions", "yadgarhq/argocd"]) assert.equal(policyProg(ex, ["github.com", r]).caps.merge, "never", r);
  assert.equal(policyProg(ex, ["github.com", "quinyx/flux"]).profile, "work");
});
