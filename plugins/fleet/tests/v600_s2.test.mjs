// fleet 6.0.0, stream 2: ledger 2033 (per-owner policy), 2042 (plan doc off the
// pushed branch; commit and PR title and body conventions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SCRIPTS_SRC, ARGS, PC, PB, PBLOB, sha256, canon, happy, run, runOne, call, inputsOf, spawnSync, stateJsonOf } from "./harness.mjs";

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

test("6.0.0 2033: policy.py: a bad file is an error (strict JSON, unknown keys, types, duplicates); 6.3.0: with the strict default caps", () => {
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
    assert.deepEqual(o.caps, DEFAULT_CAPS, text);
  }
});

// ---------------------------------------------------------------- 2033: the policy step in the build

// the subject of the build commit in the happy path
const SUBJECT = "feat(thing): add thing";
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

test("6.0.0 2033: a policy result with no caps stops the build (needs_human, gate policy); 6.3.0: an invalid file is the strict default (v630_flow)", async () => {
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

test("6.0.0 2042a: plan_ref_write.py writes a dangling plan commit on plan_base, tags it, moves the plan out of the worktree and leaves the branch where it was", () => {
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const r = writeRef(rp, rp.base, "docs/plans/x.md", '{"ref":1}\n');
    assert.equal(r.status, 0, r.stderr);
    const o = r.out;
    assert.equal(o.plan_base, rp.base);
    assert.equal(o.reused, false);
    assert.deepEqual(o.dirty, []);
    // security review: outside the scratch dir, which roles may write
    assert.equal(o.plan_file, join(rp.root, "plan", "docs/plans/x.md"));
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

test("6.0.0 2042a: plan_files.py lists the files of a given commit against its parent; plan_hash.py hashes the worktree file and the sealed blob alike", () => {
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const wtHash = prog(rp, "plan_hash", [rp.wt, "", "docs/plans/x.md"]);
    assert.equal(wtHash.status, 0, wtHash.stderr);
    const w = writeRef(rp, rp.base, "docs/plans/x.md", "{}\n");
    const pf = prog(rp, "plan_files", [rp.wt, w.out.plan_commit]);
    assert.equal(pf.status, 0, pf.stderr);
    assert.deepEqual([pf.out.head, pf.out.commit, pf.out.parent, pf.out.files, pf.out.args], [rp.base, w.out.plan_commit, rp.base, ["docs/plans/x.md"], [rp.wt, w.out.plan_commit]]);
    const at = prog(rp, "plan_hash", [rp.wt, w.out.plan_commit, "docs/plans/x.md"]);
    assert.equal(at.status, 0, at.stderr);
    assert.equal(at.out.plan_sha256, wtHash.out.plan_sha256);
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

const PLAN_BLOB = PBLOB;
const PLAN_ROLES = ["fleet-test-writer", "fleet-test-judge", "fleet-coder", "fleet-code-judge", "fleet-pr-opener"];

test("6.0.0 2042a (security review): roles read the plan from the sealed plan commit (plan_blob), never from a file a role could rewrite; code diffs start at plan_base", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const vp = call(out, "infra:verify-plan").prompt;
  assert.ok(vp.includes("/plan_hash.py' '/r/.claude/worktrees/fleet-l42-add-thing/main' '" + PC + "' 'docs/plans/x.md'\n"), vp);
  assert.ok(vp.includes("/verify_since.py' '/r/.claude/worktrees/fleet-l42-add-thing/main' '" + PB + "' 'docs/plans/x.md'"));
  assert.doesNotMatch(vp, /plan_hash_head|'HEAD' 'docs\/plans|plan_file/);
  for (const l of ["role:fleet-test-writer:AC1:r1", "role:fleet-test-judge:r1", "role:fleet-coder:r1", "role:fleet-code-judge:r1", "role:fleet-pr-opener"]) {
    const i = inputsOf(call(out, l).prompt);
    assert.equal(i.plan_blob, PLAN_BLOB, l);
    assert.equal(i.plan_path, "docs/plans/x.md", l);
  }
  for (const c of out.build.calls) assert.ok(!/\/plan\/docs\/plans\/x\.md/.test(c.prompt), c.label + " names no plan file copy");
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).tldr, "adds a thing");
  assert.equal(inputsOf(call(out, "infra:hook-surface:r1").prompt).rev, PB);
  assert.equal(inputsOf(call(out, "role:pr-review:v1").prompt).base_ref, PB);
  assert.ok(out.build.logs.indexOf("verify: HEAD is plan_base " + PB + "; plan hash matches at " + PLAN_BLOB) >= 0, out.build.logs.join("\n"));
  for (const r of PLAN_ROLES) {
    const t = readFileSync(join(SCRIPTS_SRC, "..", "roles", r + ".md"), "utf8");
    assert.match(t, /`plan_blob`: the plan doc's git blob id; read it only with `git --no-replace-objects -C <worktree> cat-file blob <plan_blob>`\. The plan doc is not in the worktree: never write it there\./, r);
  }
});

test("6.0.0 2042a (security review): plan_ref_write.py and plan_hash.py refuse a plan path that escapes the worktree or runs through a symlink; nothing outside is read or deleted", () => {
  const rp = planRepo();
  try {
    const outside = join(rp.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), "secret\n");
    symlinkSync(outside, join(rp.wt, "docs", "link"));
    for (const p of ["docs/link/x.md", "../outside/x.md", "docs/plans/../../../outside/x.md", "docs\\plans\\x.md"]) {
      const w = writeRef(rp, rp.base, p, "{}\n", "c-" + p.length);
      assert.notEqual(w.status, 0, p);
      assert.equal(readFileSync(join(outside, "x.md"), "utf8"), "secret\n", p + ": the file outside is untouched");
      assert.notEqual(prog(rp, "plan_hash", [rp.wt, "", p]).status, 0, "plan_hash: " + p);
    }
    assert.equal(rp.git("for-each-ref", "refs/fleet/"), "", "no ref written");
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
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
// ---------------------------------------------------------------- 2042b: pr_convention.py (fake gh, real git)

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
const b64 = (t) => Buffer.from(t).toString("base64");
function convRun(files, table, gh = "gh", slug = "q/actions") {
  const home = mkdtempSync(join(tmpdir(), "fleet-600conv-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    symlinkSync(GITBIN, join(bin, "git"));
    fakeGh(bin, table);
    const r = join(home, "repo");
    spawnSync(GITBIN, ["init", "-q", r]);
    for (const [p, t] of Object.entries(Object.assign({ "src/x.py": "x = 1\n" }, files))) {
      mkdirSync(dirname(join(r, p)), { recursive: true });
      writeFileSync(join(r, p), t);
    }
    spawnSync(GITBIN, ["-C", r, "add", "-A"]);
    const p = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "pr_convention.py"), r, gh, slug, "master"], { encoding: "utf8", env: { PATH: bin, HOME: bin } });
    assert.equal(p.status, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    o.__log = existsSync(join(bin, "gh.log")) ? readFileSync(join(bin, "gh.log"), "utf8") : "";
    return o;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const CC = ["feat", "fix", "perf", "revert", "chore", "refactor", "docs", "style", "test", "build", "ci"];
const merged = (titles) => [200, titles.map((t, i) => ({ title: t, merged_at: "2026-11-0" + ((i % 9) + 1) + "T00:00:00Z" })).concat([{ title: "closed, not merged", merged_at: null }]), {}];
const PULLS = "repos/q/actions/pulls?state=closed&sort=updated&direction=desc&per_page=50";
const RULES = "repos/q/actions/rules/branches/master";
const TITLE_WF = "name: PR title\non: pull_request\njobs:\n  t:\n    steps:\n      - uses: q/actions/pr-title-convention@master\n";
const CHECKER = "TYPES = ['feat', 'fix', 'chore']\nKEY_RE = re.compile(r'^([A-Za-z][A-Za-z0-9]+-\\d+|NOJIRA)$')\n";
const BODY_WF = "steps:\n  - uses: q/actions/pr-body-convention@master\n";
const BODY_CHECKER = "REQUIRED_SECTIONS = ['## Summary', '## Testing']\nPR_BODY_MIN_CHARS = 120\n";

test("6.0.0 2042b: pr_convention.py: a required pr-title workflow wins; types and the key rule come from its checker", () => {
  const o = convRun({}, {
    [RULES]: [200, [{ type: "workflows", ruleset_id: 18773609, parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/pr-title-convention.yaml", ref: "refs/heads/master" }] } }], {}],
    "repositories/7": [200, { full_name: "q/actions" }, {}],
    "repos/q/actions/contents/.github/workflows/pr-title-convention.yaml?ref=refs%2Fheads%2Fmaster": [200, { content: b64(TITLE_WF) }, {}],
    "repos/q/actions/contents/pr-title-convention?ref=master": [200, [{ name: "pr_title_check.py", path: "pr-title-convention/pr_title_check.py", type: "file" }, { name: "README.md", path: "pr-title-convention/README.md", type: "file" }], {}],
    "repos/q/actions/contents/pr-title-convention/pr_title_check.py?ref=master": [200, { content: b64(CHECKER) }, {}],
    [PULLS]: merged(["chore: x", "chore: y"]),
  });
  assert.deepEqual(o.unreadable, []);
  assert.deepEqual(o.title, { style: "scoped-key", types: ["feat", "fix", "chore"], key_required: true });
  assert.match(o.source[0], /^title: required workflow \.github\/workflows\/pr-title-convention\.yaml \(ruleset 18773609, q\/actions\), checker q\/actions\/pr-title-convention\/pr_title_check\.py$/);
  for (const l of o.__log.trim().split("\n")) assert.match(l, /^api -i [^ ]+$/, l);
  assert.equal(o.program.name, "pr_convention");
});

test("6.0.0 2042b: pr_convention.py: commitlint config, then >= 80 % of the last 20 merged titles, then conventional", () => {
  const cl = convRun({ "commitlint.config.js": "module.exports = { rules: { 'type-enum': [2, 'always', ['feat', 'fix', 'docs']] } };\n" }, { [RULES]: [200, [], {}] });
  assert.deepEqual(cl.title, { style: "conventional", types: ["feat", "fix", "docs"], key_required: false });
  assert.equal(cl.source[0], "title: commitlint config commitlint.config.js");
  const pj = convRun({ "package.json": JSON.stringify({ name: "x", commitlint: { extends: ["@commitlint/config-conventional"] } }) }, { [RULES]: [200, [], {}] });
  assert.deepEqual(pj.title, { style: "conventional", types: CC, key_required: false });
  const keyed = Array.from({ length: 20 }, (_, i) => (i < 17 ? "feat(go-pr, DEVOPS-" + (100 + i) + "): add thing " + i : "Update README"));
  const sk = convRun({}, { [RULES]: [200, [], {}], [PULLS]: merged(keyed) });
  assert.deepEqual(sk.title, { style: "scoped-key", types: CC, key_required: true });
  assert.equal(sk.source[0], "title: 17 of the last 20 merged PR titles are type(component, KEY)");
  const conv = convRun({}, { [RULES]: [200, [], {}], [PULLS]: merged(Array.from({ length: 10 }, (_, i) => (i < 8 ? "fix(fleet): x " + i : "wip"))) });
  assert.deepEqual(conv.title, { style: "conventional", types: CC, key_required: false });
  assert.equal(conv.source[0], "title: 8 of the last 10 merged PR titles are type(scope): summary");
  const free = convRun({}, { [RULES]: [200, [], {}], [PULLS]: merged(["a", "b", "fix: c"]) });
  assert.deepEqual(free.title, { style: "conventional", types: CC, key_required: false });
  assert.equal(free.source[0], "title: no convention found; the fallback type(component): summary");
  // no GitHub command: local sources only, said so
  const none = convRun({}, {}, "-");
  assert.equal(none.title.style, "conventional");
  assert.match(none.unreadable[0], /^rules and merged PR titles of q\/actions not read: no GitHub command can read it/);
  assert.equal(none.__log, "");
});

test("6.0.0 2042b: pr_convention.py: the body convention: the repo or org PR template and a required pr-body checker", () => {
  const repo = convRun({ ".github/PULL_REQUEST_TEMPLATE.md": "## Summary\n" }, { [RULES]: [200, [], {}] });
  assert.deepEqual(repo.body, { template: ".github/PULL_REQUEST_TEMPLATE.md", template_repo: null, required_sections: null, min_chars: null, checker: null });
  const org = convRun({}, {
    [RULES]: [200, [{ type: "workflows", ruleset_id: 19117936, parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/pr-body-convention.yaml", ref: "refs/heads/master" }] } }], {}],
    "repositories/7": [200, { full_name: "q/actions" }, {}],
    "repos/q/actions/contents/.github/workflows/pr-body-convention.yaml?ref=refs%2Fheads%2Fmaster": [200, { content: b64(BODY_WF) }, {}],
    "repos/q/actions/contents/pr-body-convention?ref=master": [200, [{ name: "pr_body_check.py", path: "pr-body-convention/pr_body_check.py", type: "file" }], {}],
    "repos/q/actions/contents/pr-body-convention/pr_body_check.py?ref=master": [200, { content: b64(BODY_CHECKER) }, {}],
    "repos/q/.github/contents/.github": [200, [{ name: "pull_request_template.md", path: ".github/pull_request_template.md", type: "file" }], {}],
  });
  assert.deepEqual(org.body, { template: ".github/pull_request_template.md", template_repo: "q/.github", required_sections: ["## Summary", "## Testing"], min_chars: 120, checker: "q/actions/pr-body-convention/pr_body_check.py" });
  // an unreadable checker: named, its rules null, and said so
  const blind = convRun({}, {
    [RULES]: [200, [{ type: "workflows", ruleset_id: 5, parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/pr_body.yml", ref: "refs/heads/main" }] } }], {}],
    "repositories/7": [200, { full_name: "q/actions" }, {}],
  });
  assert.deepEqual([blind.body.required_sections, blind.body.min_chars, blind.body.checker], [null, null, "q/actions:.github/workflows/pr_body.yml"]);
  assert.ok(blind.unreadable.some((x) => /^pr-body checker of q\/actions:\.github\/workflows\/pr_body\.yml not readable/.test(x)), JSON.stringify(blind.unreadable));
});

// ---------------------------------------------------------------- 2042b: the workflow

const convOut = (title) => (p) => ({ status: "ok", reason: "read", title, body: { template: null, template_repo: "q/.github", required_sections: ["## Summary"], min_chars: 50, checker: "q/actions/pr-body-convention/pr_body_check.py" }, source: ["title: x"], unreadable: [], args: inputsOf(p).args });

test("6.0.0 2042b: plan mode reads the convention after the ruleset surface and seals it with the planner's component", async () => {
  const s = happy();
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const L = out.labels;
  assert.equal(L.indexOf("infra:pr-convention:plan"), L.indexOf("infra:ruleset-surface:plan") + 1);
  assert.deepEqual(inputsOf(call(out, "infra:pr-convention:plan").prompt).args, ["/r/.claude/worktrees/fleet-l42-add-thing/main", "gh", "o/r", "master"]);
  const pf = JSON.parse(s.__store[PC]).plan_facts;
  assert.equal(pf.component, "thing");
  assert.equal(pf.conventions.title.style, "conventional");
  assert.ok(out.logs.indexOf("conventions: title: no convention found; the fallback type(component): summary") >= 0);
});

test("6.0.0 2042b (ruling 4): commit subjects and the PR title follow the sealed convention; the internal task id appears in neither", async () => {
  for (const [title, main, fix] of [
    [null, "feat(thing): add thing", "fix(thing): code round 2"],
    [{ style: "scoped-key", types: ["feat", "fix", "chore"], key_required: true }, "feat(thing, NOJIRA): add thing", "fix(thing, NOJIRA): code round 2"],
    [{ style: "conventional", types: ["feat", "chore"], key_required: false }, "feat(thing): add thing", "chore(thing): code round 2"],
  ]) {
    const s = happy();
    if (title) s["infra:pr-convention:plan"] = convOut(title);
    s["infra:push"] = { status: "ok", reason: "hook", push_result: "hook_rejected", exit_code: 1, hook_tail: "no" };
    s["role:fleet-coder:r2"] = { status: "ok", changed_paths: ["src/x.py"] };
    s["hasher:post-coder:r2"] = { status: "ok", fingerprint: { head: "c1", tree: "K2" }, hashes: happy()["hasher:freeze:f1"].hashes };
    s["role:fleet-code-judge:r2"] = { status: "ok", verdict: "approve", routed_findings: [] };
    s["hasher:fp-post:code-judge:r2"] = { status: "ok", fingerprint: { head: "c1", tree: "K2" } };
    s["infra:push:p2"] = (p) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(p).approved_sha });
    const out = await run(s, ARGS);
    const c1 = call(out, "infra:commit:r1").prompt;
    assert.equal(inputsOf(c1).subject, main, JSON.stringify(title));
    const c2 = out.calls.find((c) => c.label === "infra:commit:r2");
    if (c2) assert.equal(inputsOf(c2.prompt).subject, fix);
    const op = out.calls.find((c) => /^role:fleet-pr-opener/.test(c.label));
    if (op) {
      assert.equal(inputsOf(op.prompt).title, main);
      if (title) assert.deepEqual(inputsOf(op.prompt).body_convention.required_sections, ["## Summary"]);
    }
    for (const c of out.calls.filter((x) => /^infra:commit:|^role:fleet-pr-opener/.test(x.label))) {
      const i = inputsOf(c.prompt);
      assert.ok(!/l42/.test(String(i.subject || "") + String(i.title || "")), c.label);
    }
  }
});

test("6.0.0 2042b: verify knows fleet commits by the sealed subjects; the old task-id subjects are foreign", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  const ok = Object.assign({}, happy()["infra:verify-plan"], { head: "fedcba9876", commits_since: [{ sha: "1111111", subject: "feat(thing): add thing" }, { sha: "2222222", subject: "fix(thing): code round 2" }] });
  s["infra:verify-plan"] = ok;
  let out = await runOne(s, BARGS(plan));
  assert.match(out.result.reason, /approved but unresumable/);
  for (const subject of ["feat(l42): add thing", "fix(l42): code round 2", "fix(thing): code round x"]) {
    s["infra:verify-plan"] = Object.assign({}, ok, { commits_since: [{ sha: "5555555", subject }] });
    out = await runOne(s, BARGS(plan));
    assert.match(out.result.reason, /non-fleet commit/, subject);
  }
});

test("6.0.0 2042b: a PR opener that sets another title stops; a planner with no usable component gets the repo name", async () => {
  const s = happy();
  s["role:fleet-pr-opener"] = Object.assign({}, s["role:fleet-pr-opener"], { title: "feat(l42): add thing" });
  // 6.3.0: one scripted retry, wrong again
  s["role:fleet-pr-opener:again"] = s["role:fleet-pr-opener"];
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^pr-opener set the PR title "feat\(l42\): add thing", not "feat\(thing\): add thing"/);
  const t = happy();
  t["role:scope-and-plan"] = Object.assign({}, t["role:scope-and-plan"], { component: "DEVOPS 12!" });
  const o2 = await runOne(t, ARGS);
  assert.equal(JSON.parse(t.__store[PC]).plan_facts.component, "r");
  assert.ok(o2.logs.indexOf('planner component "DEVOPS 12!" unusable; component r') >= 0, o2.logs.join("\n"));
});

test("6.0.0 2042b: the planner names a component; the PR opener uses the title verbatim and meets the body convention", () => {
  const sp = readFileSync(join(SCRIPTS_SRC, "..", "roles", "scope-and-plan.md"), "utf8");
  assert.match(sp, /`component`: the part of the repo the change is about/);
  assert.match(sp, /Never a task, ledger or ticket id\./);
  const po = readFileSync(join(SCRIPTS_SRC, "..", "roles", "fleet-pr-opener.md"), "utf8");
  assert.match(po, /Title: exactly `title`, never your own; it never carries an internal id\./);
  assert.match(po, /\*\*Body convention:\*\* the body holds every heading in `body_convention\.required_sections`/);
});

// ---------------------------------------------------------------- 2042 security review: refs/replace

test("6.0.0 2042 (security review): every program runs git with replacement objects off; plan_hash and verify_since see the real objects and list refs/replace", () => {
  for (const f of readdirSync(SCRIPTS_SRC).filter((x) => x.endsWith(".py"))) assert.match(readFileSync(join(SCRIPTS_SRC, f), "utf8"), /^_o\.environ\['GIT_NO_REPLACE_OBJECTS'\] = '1'$/m, f);
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const w = writeRef(rp, rp.base, "docs/plans/x.md", "{}\n");
    const real = rp.git("rev-parse", w.out.plan_commit + ":docs/plans/x.md");
    const fake = spawnSync(GITBIN, ["-C", rp.wt, "hash-object", "-w", "--stdin"], { input: "# altered\n", encoding: "utf8", env: rp.env }).stdout.trim();
    rp.git("replace", real, fake);
    const h = prog(rp, "plan_hash", [rp.wt, w.out.plan_commit, "docs/plans/x.md"]);
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.out.blob, real);
    assert.equal(h.out.plan_sha256, sha256("# plan\n"));
    const v = prog(rp, "verify_since", [rp.wt, rp.base, "docs/plans/x.md"]);
    assert.deepEqual(v.out.replace_refs, ["refs/replace/" + real]);
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
});

test("6.0.0 2042 (security review): roles get the plan's own blob sha; verify and every hasher run stop on any refs/replace entry", async () => {
  const s = happy();
  s["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { plan_hash: { plan_sha256: "a".repeat(64), blob: "e".repeat(40) } });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:fleet-test-writer:AC1:r1", "role:fleet-coder:r1", "role:fleet-pr-opener"]) assert.equal(inputsOf(call(out, l).prompt).plan_blob, "e".repeat(40), l);
  for (const r of PLAN_ROLES)
    assert.match(readFileSync(join(SCRIPTS_SRC, "..", "roles", r + ".md"), "utf8"), /`plan_blob`: the plan doc's git blob id; read it only with `git --no-replace-objects -C <worktree> cat-file blob <plan_blob>`/, r);
  const t = happy();
  t["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { replace_refs: ["refs/replace/" + "1".repeat(40)] });
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.stop_gate, "hash");
  assert.match(o2.result.reason, /^verify: refs\/replace\/1{40} exists; replacement objects could change what a sealed object id reads as/);
  const u = happy();
  const h = JSON.parse(JSON.stringify(happy()["hasher:freeze:f1"]));
  h.hashes.git["fleetref:refs/replace/" + "2".repeat(40)] = "3".repeat(40);
  u["hasher:post-coder:r1"] = Object.assign({}, u["hasher:post-coder:r1"], { hashes: h.hashes });
  const o3 = await run(u, ARGS);
  assert.equal(o3.result.status, "needs_human");
  assert.match(o3.result.reason, /^hasher hasher:post-coder:r1: refs\/replace\/2{40} exists/);
});

// ---------------------------------------------------------------- 2042b security review: convention data is untrusted

test("6.0.0 2042b (security review): pr_convention.py keeps only safe types and heading-shaped sections, follows checkers only in the workflow's own repo or the target, never through ..", () => {
  const evil = "TYPES = ['feat', 'x$(rm -rf ~)', 'Fix`id`', 'chore']\n";
  const t1 = convRun({}, {
    [RULES]: [200, [{ type: "workflows", ruleset_id: 1, parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/pr-title.yaml", ref: "refs/heads/master" }] } }], {}],
    "repositories/7": [200, { full_name: "q/actions" }, {}],
    "repos/q/actions/contents/.github/workflows/pr-title.yaml?ref=refs%2Fheads%2Fmaster": [200, { content: b64("steps:\n  - uses: q/evil/chk@v1\n  - uses: q/actions/../x/chk@v1\n  - uses: q/actions/chk@v1\n") }, {}],
    "repos/q/evil/contents/chk?ref=v1": [200, [{ name: "c.py", path: "chk/c.py", type: "file" }], {}],
    "repos/q/actions/contents/chk?ref=v1": [200, [{ name: "c.py", path: "chk/c.py", type: "file" }, { name: "d.py", path: "../d.py", type: "file" }], {}],
    "repos/q/actions/contents/chk/c.py?ref=v1": [200, { content: b64(evil) }, {}],
  });
  assert.deepEqual(t1.title.types, ["feat", "chore"]);
  assert.doesNotMatch(t1.__log, /q\/evil|\.\./);
  const allBad = convRun({ "commitlint.config.js": "module.exports = { rules: { 'type-enum': [2, 'always', ['$(id)', 'A b']] } };\n" }, { [RULES]: [200, [], {}] });
  assert.deepEqual(allBad.title.types, CC);
  const body = convRun({}, {
    [RULES]: [200, [{ type: "workflows", ruleset_id: 5, parameters: { workflows: [{ repository_id: 7, path: ".github/workflows/pr-body.yaml", ref: "refs/heads/master" }] } }], {}],
    "repositories/7": [200, { full_name: "q/actions" }, {}],
    "repos/q/actions/contents/.github/workflows/pr-body.yaml?ref=refs%2Fheads%2Fmaster": [200, { content: b64("steps:\n  - uses: q/actions/bc@v1\n") }, {}],
    "repos/q/actions/contents/bc?ref=v1": [200, [{ name: "b.py", path: "bc/b.py", type: "file" }], {}],
    "repos/q/actions/contents/bc/b.py?ref=v1": [200, { content: b64("REQUIRED_SECTIONS = ['## Summary', '## `$(id)`', 'plain', '### Tests']\nPR_BODY_MIN_CHARS = 99999999\n") }, {}],
  });
  assert.deepEqual(body.body.required_sections, ["## Summary", "### Tests"]);
  assert.equal(body.body.min_chars, null);
});

test("6.0.0 2042b (security review): the workflow re-filters convention types, checks the final subject and title, and the opener passes the title in single quotes", async () => {
  for (const [types, main] of [[["feat; rm -rf ~", "fix"], "fix(thing): add thing"], [["$(id)"], "feat(thing): add thing"]]) {
    const s = happy();
    s["infra:pr-convention:plan"] = convOut({ style: "conventional", types, key_required: false });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(inputsOf(call(out, "infra:commit:r1").prompt).subject, main, JSON.stringify(types));
  }
  // a sealed component that is not a plain word stops before any commit
  const s = happy();
  const plan = await run(s, ARGS).then((o) => o.plan);
  const ref = JSON.parse(s.__store[PC]);
  ref.plan_facts.component = "x$(id)";
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[PC] = JSON.stringify(ref) + "\n";
  const out = await runOne(s, BARGS({ result: { plan_ref: Object.assign({}, plan.result.plan_ref, { ref_sha256: sha256(s.__store[PC]) }) } }));
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /^plan ref refs\/fleet\/l42\/plan: unsafe commit subject "feat\(x\$\(id\)\): add thing"; re-run plan$/);
  assert.ok(!out.labels.some((l) => /^infra:commit:/.test(l)));
  const po = readFileSync(join(SCRIPTS_SRC, "..", "roles", "fleet-pr-opener.md"), "utf8");
  assert.match(po, /--title '<title>'/);
  assert.doesNotMatch(po, /--title "<title>"/);
});

test("6.0.0 2042 (security review): plan_hash prints args and a digest; a relayed blob id the program did not print, other args or a short id stop the build", async () => {
  const rp = planRepo();
  try {
    writeFileSync(join(rp.wt, "docs", "plans", "x.md"), "# plan\n");
    const w = writeRef(rp, rp.base, "docs/plans/x.md", "{}\n");
    const h = prog(rp, "plan_hash", [rp.wt, w.out.plan_commit, "docs/plans/x.md"]);
    assert.deepEqual(h.out.args, [rp.wt, w.out.plan_commit, "docs/plans/x.md"]);
    assert.equal(h.out.digest, sha256(canon({ plan_sha256: h.out.plan_sha256, blob: h.out.blob, args: h.out.args, program: h.out.program })));
  } finally {
    rmSync(rp.root, { recursive: true, force: true });
  }
  for (const [fn, re] of [
    [(r) => ((r.plan_hash.blob = "c".repeat(40)), r), /^infra:verify-plan: the relayed plan hash does not match the program's digest, arguments or a full blob id/],
    [(r) => ((r.plan_hash.args = ["/r/.claude/worktrees/fleet-l42-add-thing/main", "HEAD", "docs/plans/x.md"]), r), /^infra:verify-plan: the relayed plan hash does not match/],
  ]) {
    const s = happy();
    const plan = await runOne(s, ARGS);
    s.__mutate = { label: "infra:verify-plan", fn };
    const out = await runOne(s, BARGS(plan));
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.match(out.result.reason, re);
    assert.ok(!out.labels.some((l) => /^role:/.test(l)));
  }
  const s = happy();
  const plan = await runOne(s, ARGS);
  s["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { plan_hash: { plan_sha256: "a".repeat(64), blob: "abc1234" } });
  const out = await runOne(s, BARGS(plan));
  assert.match(out.result.reason, /full blob id/);
});

test("6.0.0 2042b (ruling 4): a task id or source ref inside the task title never reaches the commit subject or the PR title", async () => {
  const s = happy({ brief: { title: "L42: Add Thing (ABC-9)", description: "add a thing", sources: [{ kind: "ledger", ref: "42", url: null, body: "task body" }, { kind: "jira", ref: "ABC-9", url: null, body: "x" }], repo: "/r", plan_path: null } });
  const out = await run(s, ARGS);
  const cs = out.calls.filter((c) => /^infra:commit:r/.test(c.label)).map((c) => inputsOf(c.prompt).subject);
  const titles = out.calls.filter((c) => /^role:fleet-pr-opener/.test(c.label)).map((c) => inputsOf(c.prompt).title);
  assert.ok(cs.length, out.result.reason);
  for (const x of cs.concat(titles)) assert.doesNotMatch(x, /l42|abc-9|abc 9/i, x);
  assert.equal(cs[0], "feat(thing): add thing");
});

test("6.0.0 2042 (security review): the intent judge reads the plan with replacement objects off", () => {
  const t = readFileSync(join(SCRIPTS_SRC, "..", "roles", "fleet-intent-judge.md"), "utf8");
  assert.match(t, /Read the plan only with `git --no-replace-objects -C <worktree> show <plan_commit>:<plan_path>`/);
  assert.doesNotMatch(t, /Read with `git show <plan_commit>:<path>`/);
});
