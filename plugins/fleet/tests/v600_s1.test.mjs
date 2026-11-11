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
import { SCRIPTS_SRC, ARGS, HASHES, CSHA, FP_K1, happy, run, runOne, call, inputsOf, ghIdOut, spawnSync, stateJsonOf, noUnscripted } from "./harness.mjs";

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
  // 6.0.0 security review: + blob
  assert.deepEqual(req("infra:verify-plan", "plan_hash").slice().sort(), ["blob", "file_sha256", "plan_sha256", "program"]);
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
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: st.approved_sha, commits_since: [{ sha: st.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
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
  assert.match(cp.subject, /^fix\(thing\): code round 2$/);
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

// ---------------------------------------------------------------- 2041: rulesets and self-references are hook surface

const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
// a fake gh: `api -i <path>` answers from a JSON table {path: [status, body, headers]}; 404 otherwise
function fakeGh(dir, table) {
  writeFileSync(join(dir, "table.json"), JSON.stringify(table));
  const f = join(dir, "gh");
  writeFileSync(
    f,
    "#!" + PY + "\nimport json, sys\nopen(" + JSON.stringify(join(dir, "gh.log")) + ", 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" +
      "t = json.load(open(" + JSON.stringify(join(dir, "table.json")) + "))\n" +
      "st, body, hdr = t.get(sys.argv[-1], [404, {'message': 'Not Found'}, {}])\n" +
      "sys.stdout.write('HTTP/2.0 %d X\\r\\n' % st + ''.join('%s: %s\\r\\n' % kv for kv in hdr.items()) + '\\r\\n' + json.dumps(body))\n" +
      "if st >= 300:\n    sys.stderr.write('gh: X (HTTP %d)\\n' % st)\n    sys.exit(1)\n",
  );
  chmodSync(f, 0o755);
}
function rsRepo(home, files) {
  const r = join(home, "repo");
  mkdirSync(r, { recursive: true });
  spawnSync(GIT, ["init", "-q", r]);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), t);
  }
  spawnSync(GIT, ["-C", r, "add", "-A"]);
  return r;
}
function rsProg(args, bin) {
  if (!existsSync(join(bin, "git"))) symlinkSync(GIT, join(bin, "git"));
  const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "ruleset_surface.py")].concat(args), { encoding: "utf8", env: { PATH: bin, HOME: bin } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const FILES = {
  ".github/workflows/ci.yaml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./local-act\n      - uses: q/actions/pr-title-convention@master\n",
  "local-act/action.yaml": "runs: {}\n",
  "pr-title-convention/action.yaml": "runs: {}\n",
  "pr-title-convention/pr_title_check.py": "print(1)\n",
  "src/x.py": "x = 1\n",
};
const b64 = (t) => Buffer.from(t).toString("base64");
const ORG = (over) =>
  Object.assign(
    {
      "repos/q/actions": [200, { id: 7, owner: { type: "Organization" } }, {}],
      "repos/q/actions/rules/branches/master": [200, [{ type: "workflows", ruleset_id: 15, ruleset_source_type: "Organization", parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/ai-usage-label.yaml", ref: "refs/heads/master" }, { repository_id: 9, path: ".github/workflows/other.yaml", ref: "refs/heads/main" }] } }], {}],
      "repositories/9": [200, { full_name: "q/flux" }, {}],
      "repos/q/flux/contents/.github/workflows/other.yaml?ref=refs%2Fheads%2Fmain": [200, { content: b64("steps:\n  - uses: q/actions/shared-check@v1\n  - uses: q/flux/own@v1\n") }, {}],
      "orgs/q/rulesets?per_page=100": [200, [{ id: 18773609 }], {}],
      "orgs/q/rulesets/18773609": [200, { id: 18773609, name: "PR Title Convention", rules: [{ type: "workflows", parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/pr-title-convention.yaml", ref: "refs/heads/master" }] } }] }, {}],
    },
    over || {},
  );
function withRs(table, fn, gh = "gh", files = FILES) {
  const home = mkdtempSync(join(tmpdir(), "fleet-600rs-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    fakeGh(bin, table);
    return fn(rsProg([rsRepo(home, files), gh, "q/actions", "master"], bin), bin);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("6.0.0 2041: ruleset_surface: repo-rule paths hosted here, org-ruleset paths hosted here, references from another repo's required workflow, and the self-reference floor", () =>
  withRs(ORG(), (o, bin) => {
    assert.equal(o.error, null);
    assert.deepEqual(o.surface, [".github/workflows/ai-usage-label.yaml", ".github/workflows/pr-title-convention.yaml", "local-act/", "pr-title-convention/", "shared-check/"]);
    const by = Object.fromEntries(o.sources.map((s) => [s.path, s]));
    assert.equal(by[".github/workflows/pr-title-convention.yaml"].name, "PR Title Convention");
    assert.equal(by[".github/workflows/pr-title-convention.yaml"].ruleset_id, 18773609);
    assert.equal(by["shared-check/"].via, "q/flux:.github/workflows/other.yaml");
    assert.equal(by["local-act/"].source_type, "self-reference");
    assert.ok(o.read.some((x) => /^rules\/branches\/master: 1 rule\(s\)$/.test(x)), JSON.stringify(o.read));
    assert.ok(o.read.some((x) => /^org rulesets of q: 1$/.test(x)));
    assert.deepEqual(o.unreadable, []);
    // GET only
    for (const l of readFileSync(join(bin, "gh.log"), "utf8").trim().split("\n")) assert.match(l, /^api -i [^ ]+$/, l);
    assert.equal(o.program.name, "ruleset_surface");
  }));

test("6.0.0 2041 (ruling 1): org rulesets 404 -> reported, the floor stands, no error", () =>
  withRs(ORG({ "orgs/q/rulesets?per_page=100": [404, { message: "Not Found" }, {}] }), (o) => {
    assert.equal(o.error, null);
    assert.ok(o.surface.indexOf("pr-title-convention/") >= 0, "self-reference floor");
    assert.ok(o.surface.indexOf(".github/workflows/pr-title-convention.yaml") < 0);
    assert.deepEqual(o.unreadable, ["org rulesets not readable (HTTP 404; needs admin:org): hosting-side required workflows not checked"]);
  }));

test("6.0.0 2041 (ruling 1): org rulesets 403/5xx stop only with the admin:org scope present", () => {
  for (const st of [403, 502]) {
    withRs(ORG({ "orgs/q/rulesets?per_page=100": [st, { message: "x" }, { "X-OAuth-Scopes": "repo, read:org" }] }), (o) => {
      assert.equal(o.error, null, st);
      assert.match(o.unreadable[0], /^org rulesets not readable \(HTTP \d+, no admin:org scope\)/);
    });
    withRs(ORG({ "orgs/q/rulesets?per_page=100": [st, { message: "x" }, { "X-OAuth-Scopes": "repo, admin:org" }] }), (o) => {
      assert.equal(o.error, "org rulesets of q not readable (HTTP " + st + ") with the admin:org scope");
      assert.deepEqual(o.surface, []);
    });
  }
});

test("6.0.0 2041: a user owner has no org call; an unreadable repo rule list is an error; no gh command keeps the floor", () => {
  withRs(ORG({ "repos/q/actions": [200, { id: 7, owner: { type: "User" } }, {}] }), (o, bin) => {
    assert.equal(o.error, null);
    assert.ok(!/orgs\//.test(readFileSync(join(bin, "gh.log"), "utf8")));
    assert.ok(o.read.indexOf("owner q is not an organization: no org rulesets") >= 0);
  });
  withRs(ORG({ "repos/q/actions/rules/branches/master": [500, {}, {}] }), (o) => assert.equal(o.error, "rules of q/actions branch master not readable (HTTP 500)"));
  withRs(ORG(), (o, bin) => {
    assert.equal(o.error, null);
    assert.deepEqual(o.surface, ["local-act/", "pr-title-convention/"]);
    assert.match(o.unreadable[0], /^rulesets of q\/actions not read: no GitHub command can read it/);
    assert.ok(!existsSync(join(bin, "gh.log")), "no gh call");
  }, "-");
});

// the ruleset step's relay for its prompt's args
const rsOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", surface: [], sources: [], read: ["rules/branches/main: 1 rule(s)", "org rulesets of o: 1"], unreadable: [], error: null, args: inputsOf(p).args }, over);

test("6.0.0 2041: the plan gate stops on a path a ruleset runs, naming the ruleset", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = rsOut({ surface: ["tests/"], sources: [{ ruleset_id: 18773609, name: "PR Title Convention", source_type: "Organization", path: "tests/", via: ".github/workflows/pr-title-convention.yaml" }] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "hooks");
  assert.match(out.result.reason, /^hook change(s must be a separate PR \(Max's rule\)| needs Max's confirmation): the plan scope touches tests\/test_a\.py \(run by Organization ruleset "PR Title Convention" 18773609 via \.github\/workflows\/pr-title-convention\.yaml\)/);
  // the program ran with the checked gh command, the repo and its default branch
  assert.deepEqual(inputsOf(call(out, "infra:ruleset-surface:plan").prompt).args.slice(1), ["gh", "o/r", "master"]);
});

test("6.0.0 2041: an error stops with 'hook surface cannot be computed'", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = rsOut({ error: "org rulesets of o not readable (HTTP 403) with the admin:org scope" });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks");
  assert.ok(out.result.reason.startsWith("hook surface cannot be computed (org rulesets of o not readable (HTTP 403) with the admin:org scope); hook change needs Max's confirmation"), out.result.reason);
});

test("6.0.0 2041: the no-hook line names what was read; the build reuses the sealed list (no second call)", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.plan.logs.some((l) => /^the plan scope: no hook-surface path \(read: hook config, CI and hook-manager files; self-references in 0 local workflow file\(s\); rules\/branches\/main: 0 rule\(s\);/.test(l)), out.plan.logs.join("\n"));
  assert.ok(out.build.logs.some((l) => /^the approved tree K1: no hook-surface path \(read: .*rules\/branches\/main/.test(l)), out.build.logs.join("\n"));
  assert.ok(!out.build.labels.some((l) => /^infra:ruleset-surface:/.test(l)), out.build.labels.join(", "));
});

test("6.0.0 2041 (ruling 1): unreadable org rulesets -> a gate warning and a gates_not_run line the PR body states", async () => {
  const s = happy();
  const gap = "org rulesets not readable (HTTP 404; needs admin:org): hosting-side required workflows not checked";
  s["infra:ruleset-surface:plan"] = rsOut({ unreadable: [gap] });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.plan.logs.includes("warning: " + gap));
  const g = inputsOf(call(out, "role:fleet-pr-opener").prompt).gates_not_run;
  assert.ok(g.some((x) => x.gate === "org-rulesets" && x.reason === gap), JSON.stringify(g));
  assert.ok(out.result.gates_not_run.some((x) => x.gate === "org-rulesets"));
});

test("6.0.0 2041: the approved tree is checked against the sealed ruleset surface", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = rsOut({ surface: ["src/x.py"], sources: [{ ruleset_id: 5, name: null, source_type: "Repository", path: "src/x.py", via: "src/x.py" }] });
  // the plan scope avoids the path; the coder's tree changes it
  s["hasher:post-coder:r1"] = { status: "ok", fingerprint: FP_K1, hashes: HASHES, changed: ["src/x.py"] };
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
  assert.match(out.result.reason, /^hook change needs Max's confirmation: the approved tree K1 touches src\/x\.py \(run by Repository ruleset 5 via src\/x\.py\)/);
});

// security review of 092a17a: root self-references and paginated lists fail closed
test("6.0.0 2041 (review): a root self-reference (./, ., <slug>@ref, <slug>/@ref) makes the whole repo surface", () => {
  for (const u of ["./", ".", "q/actions@v1", "q/actions/@v1", "Q/Actions@main"]) {
    const files = { ".github/workflows/ci.yaml": "steps:\n  - uses: " + u + "\n", "src/x.py": "x = 1\n" };
    withRs(ORG(), (o) => {
      assert.equal(o.error, null, u);
      assert.ok(o.surface.indexOf("./") >= 0, u + ": " + JSON.stringify(o.surface));
    }, "-", files);
  }
});

test("6.0.0 2041 (security review): a /./, backslash or escaping self-reference fails closed to whole-repo surface, never skipped", () => {
  for (const u of ["q/actions//./@v1", "q/actions/.\\@v1", "q/actions/..@v1", "q/actions//..@v1", "./../x", "q/actions/a/../../b@v1"]) {
    const files = { ".github/workflows/ci.yaml": "steps:\n  - uses: " + u + "\n", "src/x.py": "x = 1\n" };
    withRs(ORG(), (o) => {
      assert.equal(o.error, null, u);
      assert.ok(o.surface.indexOf("./") >= 0, u + ": " + JSON.stringify(o.surface));
    }, "-", files);
  }
  const files = { ".github/workflows/ci.yaml": "steps:\n  - uses: q/actions/sub\\act@v1\n", "sub/act/action.yaml": "runs: {}\n" };
  withRs(ORG(), (o) => assert.deepEqual(o.surface, ["sub/act/"]), "-", files);
});

test("6.0.0 2041 (review): rulesetSurface keeps './' as whole-repo surface; the gate stops on any path", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = rsOut({ surface: ["./"], sources: [{ ruleset_id: null, name: null, source_type: "self-reference", path: "./", via: ".github/workflows/ci.yaml" }] });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
});

const LINK = (p) => ({ link: '<https://api.github.com/' + p + '>; rel="next", <https://api.github.com/' + p + '>; rel="last"' });
test("6.0.0 2041 (review): paginated rule and org-ruleset lists are followed; a failed or capped page never reads as complete", () => {
  const rule = (id, path) => ({ type: "workflows", ruleset_id: id, ruleset_source_type: "Repository", parameters: { workflows: [{ repository_id: 7, path, ref: "refs/heads/master" }] } });
  // page 2 of the rules is read
  withRs(ORG({
    "repos/q/actions/rules/branches/master": [200, [rule(1, ".github/workflows/a.yaml")], LINK("repositories/7/rules/branches/master?page=2")],
    "repositories/7/rules/branches/master?page=2": [200, [rule(2, "ci/b.yaml")], {}],
  }), (o) => {
    assert.equal(o.error, null);
    assert.ok(o.surface.indexOf("ci/b.yaml") >= 0, JSON.stringify(o.surface));
    assert.ok(o.read.some((x) => /^rules\/branches\/master: 2 rule\(s\)/.test(x)), JSON.stringify(o.read));
  });
  // a later rules page fails -> error
  withRs(ORG({
    "repos/q/actions/rules/branches/master": [200, [rule(1, ".github/workflows/a.yaml")], LINK("repositories/7/rules/branches/master?page=2")],
    "repositories/7/rules/branches/master?page=2": [502, {}, {}],
  }), (o) => assert.match(String(o.error), /^rules of q\/actions branch master not readable \(page 2: HTTP 502\)/));
  // an endless rules list hits the cap -> error
  withRs(ORG({ "repos/q/actions/rules/branches/master": [200, [], LINK("repos/q/actions/rules/branches/master")] }), (o) => assert.match(String(o.error), /more than 10 pages/));
  // org rulesets: page 2 read; a failed page 2 -> unreadable with the count read
  withRs(ORG({
    "orgs/q/rulesets?per_page=100": [200, [{ id: 1 }], LINK("organizations/3/rulesets?per_page=100&page=2")],
    "organizations/3/rulesets?per_page=100&page=2": [200, [{ id: 18773609 }], {}],
    "orgs/q/rulesets/1": [200, { id: 1, name: "x", rules: [] }, {}],
  }), (o) => {
    assert.ok(o.surface.indexOf(".github/workflows/pr-title-convention.yaml") >= 0);
    assert.ok(o.read.indexOf("org rulesets of q: 2") >= 0, JSON.stringify(o.read));
  });
  withRs(ORG({
    "orgs/q/rulesets?per_page=100": [200, [{ id: 18773609 }], LINK("organizations/3/rulesets?per_page=100&page=2")],
    "organizations/3/rulesets?per_page=100&page=2": [500, {}, {}],
  }), (o) => {
    assert.equal(o.error, null);
    assert.ok(o.unreadable.some((x) => /^org rulesets of q: only 1 read; page 2 not readable \(HTTP 500\): the rest not checked$/.test(x)), JSON.stringify(o.unreadable));
  });
});
