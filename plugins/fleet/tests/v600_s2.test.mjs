// fleet 6.0.0, stream 2: ledger 2033 (per-owner policy), 2042 (plan doc off the
// pushed branch; commit and PR title and body conventions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SCRIPTS_SRC, ARGS, PC, PB, sha256, canon, happy, run, runOne, call, inputsOf, spawnSync, stateJsonOf } from "./harness.mjs";

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

// ---------------------------------------------------------------- 2042a: the plan commit is off the branch (programs, real git)

const GITBIN = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
// <root>/main is the worktree, <root>/scratch its scratch dir (the fleet layout)
function planRepo() {
  const root = mkdtempSync(join(tmpdir(), "fleet-600plan-"));
  const wt = join(root, "main");
  mkdirSync(join(root, "scratch"), { recursive: true });
  const env = Object.assign({}, process.env, { HOME: root, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  writeFileSync(join(root, "gitconfig"), "");
  const git = (...a) => {
    const r = spawnSync(GITBIN, ["-C", wt].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
    return r.stdout.trim();
  };
  spawnSync(GITBIN, ["init", "-q", "-b", "fleet/t1-x", wt], { env });
  mkdirSync(join(wt, "docs", "plans"), { recursive: true });
  writeFileSync(join(wt, "src.py"), "x = 1\n");
  writeFileSync(join(wt, "docs", "plans", "old.md"), "# old\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, wt, scratch: join(root, "scratch"), git, env, base: git("rev-parse", "HEAD") };
}
function prog(rp, name, args) {
  const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, name + ".py")].concat(args), { encoding: "utf8", env: { PATH: dirname(GITBIN) + ":/usr/bin:/bin", HOME: rp.root, GIT_CONFIG_GLOBAL: join(rp.root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
}
// the tag message as checked base64 chunks under <scratch>/<dir>
function chunkArgs(rp, dir, message) {
  const d = join(rp.scratch, dir);
  mkdirSync(d, { recursive: true });
  const b = Buffer.from(message).toString("base64");
  writeFileSync(join(d, "0.b64"), b);
  const h = (t) => spawnSync("sh", ["-c", "printf %s \"$1\" | sha256sum", "-", t], { encoding: "utf8" }).stdout.slice(0, 64);
  return [d, "1", h(message), JSON.stringify([{ i: 0, sha256: h(b) }])];
}
const writeRef = (rp, base, planPath, message, dir) => prog(rp, "plan_ref_write", [rp.wt, "t1", base, planPath].concat(chunkArgs(rp, dir || "c1", message)));

test("6.0.0 2042a: plan_ref_write.py writes a dangling plan commit on plan_base, tags it, moves the plan to scratch and leaves the branch where it was", () => {
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const r = writeRef(rp, rp.base, "docs/plans/x.md", '{"ref":1}\n');
    assert.equal(r.status, 0, r.stderr);
    const o = r.out;
    assert.equal(o.plan_base, rp.base);
    assert.equal(o.reused, false);
    assert.deepEqual(o.dirty, []);
    assert.equal(o.plan_file, join(rp.scratch, "plan", "docs/plans/x.md"));
    assert.equal(readFileSync(o.plan_file, "utf8"), "# plan\n");
    assert.equal(rp.git("rev-parse", "HEAD"), rp.base, "the branch did not move");
    assert.equal(rp.git("status", "--porcelain"), "", "the worktree is clean");
    assert.equal(rp.git("rev-parse", o.plan_commit + "^"), rp.base);
    assert.equal(rp.git("diff-tree", "-r", "--name-only", "--no-commit-id", o.plan_commit), "docs/plans/x.md");
    assert.equal(rp.git("show", o.plan_commit + ":docs/plans/x.md"), "# plan");
    assert.equal(rp.git("cat-file", "-p", "refs/fleet/t1/plan").split("\n")[0], "object " + o.plan_commit);
    assert.equal(rp.git("rev-parse", "refs/fleet/t1/plan"), o.tag_sha);
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    // the same plan again on the same base: the same commit, reused
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const again = writeRef(rp, rp.base, "docs/plans/x.md", '{"ref":2}\n', "c2");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.out.reused, true);
    assert.equal(again.out.plan_commit, o.plan_commit);
    assert.equal(rp.git("rev-parse", "refs/fleet/t1/plan-1"), o.tag_sha, "the earlier tag is archived");
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
});

test("6.0.0 2042a: plan_ref_write.py: an ingested tracked plan is restored in the worktree; a base that is not HEAD's ancestor is refused", () => {
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "old.md"), "# old, updated\n");
    const r = writeRef(rp, rp.base, "docs/plans/old.md", "{}\n");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(rp.wt, "docs", "plans", "old.md"), "utf8"), "# old\n");
    assert.equal(rp.git("status", "--porcelain"), "");
    assert.equal(rp.git("show", r.out.plan_commit + ":docs/plans/old.md"), "# old, updated");
    // a re-plan worktree sits on the old plan commit: base is its parent
    rp.git("checkout", "-q", "--detach", r.out.plan_commit);
    writeFileSync(join(rp.wt, "docs", "plans", "old.md"), "# old, re-planned\n");
    const rr = writeRef(rp, rp.base, "docs/plans/old.md", "{}\n", "c2");
    assert.equal(rr.status, 0, rr.stderr);
    assert.equal(rp.git("rev-parse", rr.out.plan_commit + "^"), rp.base);
    assert.equal(rp.git("status", "--porcelain"), "");
    const bad = writeRef(rp, "0".repeat(40), "docs/plans/old.md", "{}\n", "c3");
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
});

test("6.0.0 2042a: plan_files.py lists the files of a given commit against its parent; plan_hash.py hashes the worktree file and extracts a blob into scratch", () => {
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const wtHash = prog(rp, "plan_hash", [rp.wt, "", "docs/plans/x.md"]);
    assert.equal(wtHash.status, 0, wtHash.stderr);
    const w = writeRef(rp, rp.base, "docs/plans/x.md", "{}\n");
    const pf = prog(rp, "plan_files", [rp.wt, w.out.plan_commit]);
    assert.equal(pf.status, 0, pf.stderr);
    assert.deepEqual([pf.out.head, pf.out.commit, pf.out.parent, pf.out.files, pf.out.args], [rp.base, w.out.plan_commit, rp.base, ["docs/plans/x.md"], [rp.wt, w.out.plan_commit]]);
    const dest = join(rp.scratch, "plan", "docs/plans/x.md");
    rmSync(dest);
    const ex = prog(rp, "plan_hash", [rp.wt, w.out.plan_commit, "docs/plans/x.md", dest]);
    assert.equal(ex.status, 0, ex.stderr);
    assert.equal(ex.out.plan_sha256, wtHash.out.plan_sha256);
    assert.equal(readFileSync(dest, "utf8"), "# plan\n");
    assert.notEqual(prog(rp, "plan_hash", [rp.wt, w.out.plan_commit, "docs/plans/x.md", join(rp.root, "elsewhere.md")]).status, 0, "dest must be under scratch");
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
});

test("6.0.0 2042a: branch_scan.py prints HEAD and takes plan_tip_time from the newest plan ref's commit, not from the branch", () => {
  const rp = planRepo();
  try {
    rp.git("update-ref", "refs/remotes/origin/master", rp.base);
    const kinds = JSON.stringify(["ledger", "text"]);
    const b0 = prog(rp, "branch_scan", [rp.wt, "master", "t1", kinds]);
    assert.equal(b0.status, 0, b0.stderr);
    assert.equal(b0.out.head, rp.base);
    assert.equal(b0.out.plan_tip_time, null);
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const w = writeRef(rp, rp.base, "docs/plans/x.md", "{}\n");
    const b1 = prog(rp, "branch_scan", [rp.wt, "master", "t1", kinds]);
    assert.deepEqual(b1.out.commits, []);
    assert.equal(b1.out.plan_tip_time, Number(rp.git("log", "-1", "--format=%ct", w.out.plan_commit)));
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 2042a: the workflow

const PLAN_FILE = "/r/.claude/worktrees/fleet-l42-add-thing/scratch/plan/docs/plans/x.md";

test("6.0.0 2042a: the build extracts the plan doc to scratch at verify; roles read it there; code diffs start at plan_base", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const vp = call(out, "infra:verify-plan").prompt;
  assert.ok(vp.includes("/plan_hash.py' '/r/.claude/worktrees/fleet-l42-add-thing/main' '" + PC + "' 'docs/plans/x.md' '" + PLAN_FILE + "'"), vp);
  assert.ok(vp.includes("/verify_since.py' '/r/.claude/worktrees/fleet-l42-add-thing/main' '" + PB + "' 'docs/plans/x.md'"));
  assert.doesNotMatch(vp, /plan_hash_head|'HEAD' 'docs\/plans/);
  for (const l of ["role:fleet-test-writer:AC1:r1", "role:fleet-test-judge:r1", "role:fleet-coder:r1", "role:fleet-code-judge:r1", "role:fleet-pr-opener"])
    assert.equal(inputsOf(call(out, l).prompt).plan_path, PLAN_FILE, l);
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).tldr, "adds a thing");
  assert.equal(inputsOf(call(out, "infra:hook-surface:r1").prompt).rev, PB);
  assert.equal(inputsOf(call(out, "role:pr-review:v1").prompt).base_ref, PB);
  assert.ok(out.build.logs.indexOf("verify: HEAD is plan_base " + PB + "; plan hash matches; plan doc at " + PLAN_FILE) >= 0, out.build.logs.join("\n"));
});

test("6.0.0 2042a: a plan ref sealed before 6.0.0 (no plan_base) is refused with 'delete the branch, then re-run plan'", async () => {
  const s = happy();
  const plan = await run(s, ARGS).then((o) => o.plan);
  const ref = JSON.parse(s.__store[PC]);
  delete ref.plan_base;
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[PC] = JSON.stringify(ref) + "\n";
  const out = await runOne(s, BARGS({ result: { plan_ref: Object.assign({}, plan.result.plan_ref, { ref_sha256: sha256(s.__store[PC]) }) } }));
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.reason, "plan ref refs/fleet/l42/plan was sealed before 6.0.0 (its plan commit is on the branch, so the plan doc would ship): delete branch fleet/l42-add-thing, then re-run plan");
  assert.ok(!out.labels.includes("infra:verify-plan"));
});

test("6.0.0 2042a: the plan doc in the PR diff or in a branch commit stops before the push", async () => {
  for (const scan of [{ diff: ["src/x.py", "docs/plans/x.md"], commits: [] }, { diff: ["src/x.py"], commits: [{ sha: "1111111", files: ["./docs/plans/x.md"] }] }]) {
    const s = happy();
    s["infra:fleet-scan:push"] = Object.assign({ status: "ok", reason: "scanned" }, scan);
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(scan));
    assert.equal(out.result.stop_gate, "scope");
    assert.equal(out.result.reason, "the plan doc docs/plans/x.md is in the PR diff or its commits; the plan doc never ships");
    assert.ok(!out.labels.includes("infra:push"));
  }
});

test("6.0.0 2042a: the PR opener puts the TL;DR and the criteria in the body and never ships, links or quotes the plan", () => {
  const t = readFileSync(join(SCRIPTS_SRC, "..", "roles", "fleet-pr-opener.md"), "utf8");
  assert.match(t, /`tldr` \(the plan's TL;DR\)/);
  assert.match(t, /\*\*Plan:\*\* the plan doc never ships\. Never copy, attach or link it, and never quote its path\./);
  assert.match(t, /List the `id` and `text` of every criterion under the acceptance criteria/);
});
