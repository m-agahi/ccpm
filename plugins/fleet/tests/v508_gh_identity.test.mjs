// fleet 5.0.8 (ledger 2030): one GitHub identity rule, decided by a program.
//
// Run wf_aea3186a-4e1 (yadgarhq/iam-db, 5.0.7) passed every gate, committed
// and pushed, then stopped at the PR step: fleet-pr-opener used plain `gh`
// (the work login) and got "GraphQL: must be a collaborator". Each prompt
// told the agent to use gh-personal only when `gh-personal api user` equals
// the repo owner, which never holds for an org repo. 5.0.8: gh_identity.py
// picks the command per repo ([gh-personal if installed, gh], the first with
// push, else the first that reads); the workspace step runs it, the script
// checks it, and every gh prompt and role gets that command as gh_cmd.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOURCE,
  SCRIPTS_SRC,
  ROLES_SRC,
  ARGS,
  HASHES,
  CSHA,
  happy,
  run,
  runOne,
  call,
  inputsOf,
  noUnscripted,
  stateJsonOf,
  spawnSync,
  sha256,
  canon,
  redigest,
} from "./harness.mjs";

const PROG = join(SCRIPTS_SRC, "gh_identity.py");
const TRIED = {
  // gh-personal can push, the work login can only read: the 5.0.7 failure
  personalPush: [{ cmd: "gh-personal", installed: true, push: true }, { cmd: "gh", installed: true, push: false }],
  noPersonal: [{ cmd: "gh-personal", installed: false, push: null }, { cmd: "gh", installed: true, push: true }],
  noPush: [{ cmd: "gh-personal", installed: true, push: false }, { cmd: "gh", installed: true, push: false }],
};

// ---------------------------------------------------------------- the program, with stub binaries

// A stub gh command: logs its argv, prints `out` with exit `code` (stderr `err`).
function stub(dir, name, out, code = 0, err = "") {
  const f = join(dir, name);
  writeFileSync(
    f,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + JSON.stringify(join(dir, name + ".log")) + "\n" +
      (err ? "printf '%s\\n' " + JSON.stringify(err) + " >&2\n" : "") +
      (out !== null ? "printf '%s\\n' " + JSON.stringify(out) + "\n" : "") + "exit " + code + "\n",
  );
  chmodSync(f, 0o755);
}
// PATH: the stub dir first, then the caller's PATH without any real gh-personal
function pathWith(dir) {
  return [dir].concat((process.env.PATH || "").split(":").filter((e) => e && e.startsWith("/") && !existsSync(join(e, "gh-personal")))).join(":");
}
function repoWithOrigin(home, url) {
  const r = join(home, "repo");
  mkdirSync(r);
  spawnSync("git", ["init", "-q", r]);
  spawnSync("git", ["-C", r, "remote", "add", "origin", url]);
  return r;
}
function prog(args, dir) {
  const r = spawnSync("python3", ["-I", PROG].concat(args), { encoding: "utf8", env: { PATH: pathWith(dir), HOME: dir } });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test("5.0.8 2030: gh_identity picks gh-personal for an org repo where only it can push (owner is not a login)", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-508-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    stub(bin, "gh-personal", "true");
    stub(bin, "gh", "false");
    const repo = repoWithOrigin(home, "git@github.com:yadgarhq/iam-db.git");
    const r = prog([repo], bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.origin, "yadgarhq/iam-db");
    assert.deepEqual(r.out.repos["yadgarhq/iam-db"], { gh_cmd: "gh-personal", push: true, tried: TRIED.personalPush });
    // each candidate ran exactly the read-only permissions query; no token on any command line
    for (const c of ["gh-personal", "gh"]) assert.equal(readFileSync(join(bin, c + ".log"), "utf8"), "api repos/yadgarhq/iam-db --jq .permissions.push\n", c);
    assert.ok(!/token/i.test(JSON.stringify(r.out)), "no token in the output");
    // the digest covers every printed key and the self-hash
    const o = { origin: r.out.origin, repos: r.out.repos, args: r.out.args, program: r.out.program };
    assert.equal(r.out.digest, sha256(JSON.stringify(JSON.parse(canon(o)))));
    assert.deepEqual(r.out.program, { name: "gh_identity", sha256: sha256(readFileSync(PROG, "utf8")) });
    // an https origin and an ssh alias give the same slug
    rmSync(join(home, "repo"), { recursive: true, force: true });
    const r2 = prog([repoWithOrigin(home, "github-personal:yadgarhq/iam-db.git")], bin);
    assert.equal(r2.out.origin, "yadgarhq/iam-db");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("5.0.8 2030: gh_identity falls back to gh when gh-personal is not installed", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-508-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    stub(bin, "gh", "true");
    const r = prog(["-", "o/r"], bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.origin, null);
    assert.deepEqual(r.out.repos["o/r"], { gh_cmd: "gh", push: true, tried: TRIED.noPersonal });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("5.0.8 2030: gh_identity with no push: the first reader, push false; no reader: gh_cmd null", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-508-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    stub(bin, "gh-personal", null, 1, "gh: Not Found (HTTP 404)");
    stub(bin, "gh", "false");
    let r = prog(["-", "o/r"], bin);
    assert.deepEqual(r.out.repos["o/r"], { gh_cmd: "gh", push: false, tried: [{ cmd: "gh-personal", installed: true, push: null }, { cmd: "gh", installed: true, push: false }] });
    stub(bin, "gh", null, 1, "gh: Not Found (HTTP 404)");
    r = prog(["-", "o/r"], bin);
    assert.deepEqual({ gh_cmd: r.out.repos["o/r"].gh_cmd, push: r.out.repos["o/r"].push }, { gh_cmd: null, push: false });
    // a 4xx answer is not retried (one call per candidate)
    assert.equal(readFileSync(join(bin, "gh.log"), "utf8").trim().split("\n").length, 2);
    // a bad slug is refused before any gh runs
    assert.notEqual(prog(["-", "o/r; rm -rf /"], bin).status, 0);
    assert.notEqual(prog(["relative/path"], bin).status, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the workflow

// every input value named gh_cmd anywhere in a prompt's Inputs line
function ghCmdsIn(prompt) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "gh_cmd" ? out.push(x) : walk(x));
  };
  try {
    walk(inputsOf(prompt));
  } catch {
    // a prompt with no Inputs line
  }
  return out;
}

test("5.0.8 2030: org repo, gh-personal can push, gh cannot -> gh_cmd gh-personal in every gh prompt and role input", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.personalPush };
  const out = await run(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  // the workspace step runs the program first and relays it
  const ws = call(out.build, "workspace").prompt;
  assert.ok(ws.indexOf("gh_identity.py' '/r'") > 0 && ws.indexOf("gh_identity.py") < ws.indexOf("fetch origin"), "the program runs first");
  assert.match(ws, /`<gh> pr list --head <branch>/);
  assert.ok(out.build.logs.some((l) => /GitHub command for o\/r: gh-personal \(push\)/.test(l)));
  for (const label of ["infra:push", "role:fleet-pr-opener", "role:pr-review:v1"]) assert.equal(inputsOf(call(out, label).prompt).gh_cmd, "gh-personal", label);
  // every prompt that carries a gh_cmd carries this one
  const carried = out.calls.flatMap((c) => ghCmdsIn(c.prompt).map((v) => [c.label, v]));
  assert.ok(carried.length >= 3, JSON.stringify(carried));
  for (const [l, v] of carried) assert.equal(v, "gh-personal", l);
  // the roles use <gh>, the input
  assert.match(readFileSync(join(ROLES_SRC, "fleet-pr-opener.md"), "utf8"), /`gh_cmd`: the GitHub command the workflow checked/);
  assert.match(readFileSync(join(ROLES_SRC, "pr-review.md"), "utf8"), /Use exactly `<gh>` for every GitHub call/);
});

test("5.0.8 2030: gh-personal not installed -> gh_cmd gh", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.noPersonal };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const label of ["infra:push", "role:fleet-pr-opener", "role:pr-review:v1"]) assert.equal(inputsOf(call(out, label).prompt).gh_cmd, "gh", label);
});

test("5.0.8 2030: no command can push -> the PR step stops before any agent, stop_gate role, naming what each answered", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.noPush };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^PR step: no GitHub command with push access to o\/r \(gh-personal=false, gh=false\)/);
  assert.match(out.result.reason, /re-run the build with the same plan_ref/);
  // pushed and recorded (a resume starts at the PR), but no PR agent ran
  assert.ok(out.labels.includes("infra:push") && out.labels.includes("infra:state:pushed:p1"));
  assert.ok(!out.labels.some((l) => /^(role:fleet-pr-opener|infra:fleet-scan:fleet-pr-opener)/.test(l)), out.labels.join(", "));
  const after = out.labels.slice(out.labels.indexOf("infra:state:pushed:p1") + 1);
  assert.deepEqual(after.filter((l) => !/^infra:(build-clean|db-down)/.test(l)), [], "only teardown after the run-state write");
});

test("5.0.8 2030: a broken gh_check relay or a pick that disagrees with its tried list stops at the workspace (contract)", async () => {
  // [mutation, re-digest after it (so only the check under test can stop it)]
  for (const [mut, re] of [
    [(gc) => Object.assign(gc, { digest: "0".repeat(64) }), false],
    [(gc) => Object.assign(gc.repos["o/r"], { gh_cmd: "gh" }), true],
    [(gc) => Object.assign(gc.repos["o/r"], { push: false }), true],
    [(gc) => Object.assign(gc, { args: ["/other"] }), true],
  ]) {
    const s = happy();
    s.__gh = { "o/r": TRIED.personalPush };
    s.__mutate = { label: "workspace", fn: (r, p) => (mut(r.gh_check), re ? redigest("workspace", r, p) : r) };
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.equal(out.result.stop_gate, "contract");
    assert.match(out.result.reason, /^workspace: gh check unusable/);
  }
});

test("5.0.8 2030: a GitHub URL input gets its own gh check before intake, never inside the intake prompt", async () => {
  const s = happy();
  s.__gh = { "yadgarhq/iam-db": TRIED.personalPush };
  const it = s.intake;
  s.intake = (p, o) => Object.assign({}, typeof it === "function" ? it(p, o) : it);
  const out = await runOne(s, Object.assign({}, ARGS, { input: "https://github.com/yadgarhq/iam-db/issues/74" }));
  const i = out.labels.indexOf("infra:gh-identity:intake");
  assert.ok(i >= 0 && i < out.labels.indexOf("intake"), out.labels.join(", "));
  assert.deepEqual(inputsOf(call(out, "infra:gh-identity:intake").prompt).args, ["-", "yadgarhq/iam-db"]);
  const ip = call(out, "intake").prompt;
  assert.equal(inputsOf(ip).gh_cmd, "gh-personal");
  assert.ok(!ip.includes("gh_identity.py"), "intake (task text) runs no program");
  // a non-URL input gets no gh_cmd and no extra step
  const plain = await runOne(happy(), ARGS);
  assert.ok(!plain.labels.some((l) => /^infra:gh-identity:/.test(l)));
  assert.ok(!("gh_cmd" in inputsOf(call(plain, "intake").prompt)));
});

test("5.0.8 2030: a GitHub comment with no push-capable command is failed without an agent; write-back stays soft", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.personalPush, "x/y": TRIED.noPush };
  // the sealed brief: one GitHub source on another repo
  const it = s.intake;
  s.intake = (p, o) => {
    const r = JSON.parse(JSON.stringify(typeof it === "function" ? it(p, o) : it));
    r.brief.sources.push({ kind: "github", ref: "x/y#5", url: "https://github.com/x/y/issues/5", body: "b", id: null, project: null });
    return r;
  };
  s["infra:comments-list"] = (p) => ({ status: "ok", reason: "listed", results: inputsOf(p).sources.map((x) => ({ key: x.key, status: "ok", has_marker: false, reason: null })) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.labels.includes("infra:gh-identity:comments"));
  // the list step reads x/y with the command that can read it
  assert.equal(inputsOf(call(out.build, "infra:comments-list").prompt).sources.find((x) => x.ref === "x/y#5").gh_cmd, "gh-personal");
  assert.deepEqual(inputsOf(call(out.build, "infra:gh-identity:comments").prompt).args, ["-", "x/y"]);
  const c = out.result.write_back.comments.find((e) => e.ref === "x/y#5");
  assert.equal(c.status, "failed");
  assert.match(c.reason, /no GitHub command with push access to x\/y \(gh-personal=false, gh=false\)/);
  assert.ok(!out.build.labels.includes("infra:comments-post"), "nothing to post");
});

// ---------------------------------------------------------------- resume from 5.0.7

// the keys a 5.0.7 saveState wrote (no write-back yet): 5.0.8 adds none
const STATE_507_KEYS = ["approved_sha", "auto_confirmed", "code_tree", "gates_not_run", "intent", "last_gate", "maps_digest", "plan_commit", "pr_created", "pr_number", "pr_url", "ref_sha256", "review", "reviews", "rounds", "seal", "suite_result", "template_used"];

test("5.0.8 2030: a build stopped at the PR step (5.0.7-shaped run-state at pushed) resumes at the PR with gh_cmd set", async () => {
  const states = {};
  const s = happy();
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1"])
    s[label] = (prompt) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  // 5.0.7's failure: the PR cannot be opened with the command the run has
  s.__gh = { "o/r": TRIED.noPush };
  const plan = await runOne(s, ARGS);
  const first = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(first.result.stop_gate, "role", first.result.reason);
  // the run-state holds exactly the 5.0.7 keys: nothing new is sealed in it
  const st = states.pushed;
  assert.deepEqual(Object.keys(st).sort(), STATE_507_KEYS.filter((k) => k in st).sort());
  assert.ok(STATE_507_KEYS.every((k) => k in st || st[k] === undefined));
  assert.ok(!JSON.stringify(st).includes("gh"), "no gh value in the run-state");
  // the re-run (as docs-74 does: same plan_ref), now with gh-personal authorised
  s.__gh = { "o/r": TRIED.personalPush };
  s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: st.approved_sha, commits_since: [{ sha: st.approved_sha, subject: "feat(l42): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
  s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: st.approved_sha, message: JSON.stringify(st), head: st.approved_sha, head_tree: st.code_tree, clean: true };
  s["hasher:resume"] = { status: "ok", fingerprint: { head: st.approved_sha, tree: st.code_tree }, hashes: HASHES };
  const second = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  noUnscripted(second);
  assert.equal(second.result.status, "ok", second.result.reason);
  assert.ok(second.logs.some((l) => /resuming at pr \(run-state pushed at /.test(l)), second.logs.join("\n"));
  assert.ok(!second.labels.includes("infra:push"), "no second push");
  assert.ok(second.labels.indexOf("workspace") < second.labels.indexOf("role:fleet-pr-opener"), "gh_cmd computed again before the PR");
  assert.equal(inputsOf(call(second, "role:fleet-pr-opener").prompt).gh_cmd, "gh-personal");
  assert.equal(inputsOf(call(second, "role:fleet-pr-opener").prompt).approved_sha, CSHA(1));
});

// ---------------------------------------------------------------- source scans

test("5.0.8 2030: no prompt or role holds the login==owner rule or picks a gh command itself", () => {
  const roles = readdirSync(ROLES_SRC).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(ROLES_SRC, f), "utf8")]);
  const texts = [["build-task-run.js", SOURCE]].concat(roles);
  for (const [f, t] of texts) {
    assert.ok(!/api user --jq \.login/.test(t), f + ": login lookup");
    assert.ok(!/equals <owner>/.test(t), f + ": login == owner rule");
    assert.ok(!/wrapper for the repo's owner/.test(t), f + ": owner wrapper rule");
    assert.ok(!/use `gh` only when gh-personal/.test(t), f + ": personal-first rule");
  }
  // gh-personal appears in the workflow only as a candidate name of the checked program
  const hits = SOURCE.split("\n").filter((l) => l.includes("gh-personal") && !/^\s*\/\//.test(l));
  for (const l of hits) assert.match(l, /GH_CMDS = \["gh-personal", "gh"\]|authorise gh-personal or gh/, l);
  // every gh command in a prompt string uses the checked command (<gh> or <gh_cmd>), never a bare gh
  const strs = [...SOURCE.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const bare = strs.filter((x) => /`gh (api|pr|issue|repo|auth)\b/.test(x));
  assert.deepEqual(bare, []);
  for (const [f, t] of roles) assert.deepEqual(t.match(/`gh (api|pr|issue|repo|auth)\b[^`]*`/g) || [], [], f);
});
