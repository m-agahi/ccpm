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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync, symlinkSync } from "node:fs";
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
// review of #56 (S4, N1): gh first; gh-personal only when gh has no push
const TRIED = {
  // the work login can only read, gh-personal can push: the 5.0.7 failure
  personalPush: [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: true, push: true }],
  // gh can push: gh-personal is never tried
  ghPush: [{ cmd: "gh", installed: true, push: true }],
  noPush: [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: true, push: false }],
};

// ---------------------------------------------------------------- the program, with stub binaries

const SLEEP = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
// A stub command: logs its argv, prints `out` with exit `code` (stderr `err`), after `sleep` s.
function stub(dir, name, out, code = 0, err = "", sleep = 0, shebang = "#!/bin/sh") {
  const f = join(dir, name);
  writeFileSync(
    f,
    shebang + "\nprintf '%s\\n' \"$*\" >> " + JSON.stringify(join(dir, name + ".log")) + "\n" +
      (sleep ? SLEEP + " " + sleep + "\n" : "") +
      (err ? "printf '%s\\n' " + JSON.stringify(err) + " >&2\n" : "") +
      (out !== null ? "printf '%s\\n' " + JSON.stringify(out) + "\n" : "") + "exit " + code + "\n",
  );
  chmodSync(f, 0o755);
}
// `ssh -G <host>` stub: prints `hostname <name>` for the alias
function sshStub(dir, map) {
  const f = join(dir, "ssh");
  writeFileSync(
    f,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + JSON.stringify(join(dir, "ssh.log")) + "\n" +
      "[ \"$1\" = -G ] || exit 255\ncase \"$2\" in\n" +
      Object.entries(map).map(([a, h]) => "  " + a + ") printf 'user git\\nhostname %s\\nport 22\\n' " + h + " ;;\n").join("") +
      "  *) printf 'hostname %s\\n' \"$2\" ;;\nesac\n",
  );
  chmodSync(f, 0o755);
}
const logOf = (dir, name) => (existsSync(join(dir, name + ".log")) ? readFileSync(join(dir, name + ".log"), "utf8").trim().split("\n") : []);
// PATH: the stub dir first, then the caller's PATH without any real gh, gh-personal or ssh
function pathWith(dir) {
  return [dir].concat((process.env.PATH || "").split(":").filter((e) => e && e.startsWith("/") && !["gh", "gh-personal", "ssh"].some((n) => existsSync(join(e, n))))).join(":");
}
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
function repoWithOrigin(home, url) {
  const r = mkdtempSync(join(home, "repo-"));
  spawnSync(GIT, ["init", "-q", r]);
  spawnSync(GIT, ["-C", r, "remote", "add", "origin", url]);
  return r;
}
function prog(args, dir) {
  // git must stay findable even when its dir also holds a real gh: link it in
  if (!existsSync(join(dir, "git"))) symlinkSync(GIT, join(dir, "git"));
  const t = Date.now();
  const r = spawnSync("python3", ["-I", PROG].concat(args), { encoding: "utf8", env: { PATH: pathWith(dir), HOME: dir } });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null, ms: Date.now() - t };
}
function withBin(fn) {
  const home = mkdtempSync(join(tmpdir(), "fleet-508-"));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    return fn(home, bin);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("5.0.8 2030: gh_identity tries gh first; gh-personal only when gh has no push, and picks it for an org repo", () =>
  withBin((home, bin) => {
    stub(bin, "gh", "false");
    stub(bin, "gh-personal", "true");
    const r = prog([repoWithOrigin(home, "git@github.com:yadgarhq/iam-db.git")], bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.origin, "yadgarhq/iam-db");
    assert.deepEqual(r.out.repos["yadgarhq/iam-db"], { gh_cmd: "gh-personal", push: true, tried: TRIED.personalPush });
    // each candidate ran exactly the read-only permissions query; no token on any command line
    for (const c of ["gh", "gh-personal"]) assert.deepEqual(logOf(bin, c), ["api repos/yadgarhq/iam-db --jq .permissions.push"], c);
    assert.deepEqual(logOf(bin, "ssh"), [], "a github.com host needs no ssh -G");
    assert.ok(!/token/i.test(JSON.stringify(r.out)), "no token in the output");
    const o = { origin: r.out.origin, repos: r.out.repos, args: r.out.args, program: r.out.program };
    assert.equal(r.out.digest, sha256(JSON.stringify(JSON.parse(canon(o)))));
    assert.deepEqual(r.out.program, { name: "gh_identity", sha256: sha256(readFileSync(PROG, "utf8")) });
  }));

test("5.0.8 2030: gh with push is picked and gh-personal never runs (work repos never touch it)", () =>
  withBin((home, bin) => {
    stub(bin, "gh", "true");
    stub(bin, "gh-personal", "true");
    const r = prog(["-", "quinyx/x"], bin);
    assert.deepEqual(r.out.repos["quinyx/x"], { gh_cmd: "gh", push: true, tried: TRIED.ghPush });
    assert.deepEqual(logOf(bin, "gh-personal"), []);
  }));

test("5.0.8 2030: no push: gh when it reads, else gh-personal when it reads, else null; gh-personal not installed", () =>
  withBin((home, bin) => {
    stub(bin, "gh", "false");
    stub(bin, "gh-personal", "false");
    assert.deepEqual(prog(["-", "o/r"], bin).out.repos["o/r"], { gh_cmd: "gh", push: false, tried: TRIED.noPush });
    stub(bin, "gh", null, 1, "gh: Not Found (HTTP 404)");
    assert.deepEqual(prog(["-", "o/r"], bin).out.repos["o/r"], { gh_cmd: "gh-personal", push: false, tried: [{ cmd: "gh", installed: true, push: null, exit_code: 1, stderr: "gh: Not Found (HTTP 404)" }, { cmd: "gh-personal", installed: true, push: false }] });
    stub(bin, "gh-personal", null, 1, "gh: Not Found (HTTP 404)");
    const r = prog(["-", "o/r"], bin);
    assert.deepEqual([r.out.repos["o/r"].gh_cmd, r.out.repos["o/r"].push], [null, false]);
    rmSync(join(bin, "gh-personal"));
    stub(bin, "gh", "false");
    assert.deepEqual(prog(["-", "o/r"], bin).out.repos["o/r"], { gh_cmd: "gh", push: false, tried: [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: false, push: null }] });
    // a bad slug or a relative repo is refused before any gh runs
    assert.notEqual(prog(["-", "o/r; rm -rf /"], bin).status, 0);
    assert.notEqual(prog(["relative/path"], bin).status, 0);
  }));

test("5.0.8 review N2: only rc 0 with stdout exactly true or false counts; anything else is unknown, not readable", () =>
  withBin((home, bin) => {
    stub(bin, "gh-personal", "true");
    for (const [out, code] of [["null", 0], ["", 0], ["True", 0], ["true\ntrue", 0], ["false", 1], ["true", 2]]) {
      stub(bin, "gh", out, code);
      const r = prog(["-", "o/r"], bin);
      // 6.0.0 (2038): an unknown answer carries its exit code and stderr
      assert.deepEqual(r.out.repos["o/r"].tried[0], { cmd: "gh", installed: true, push: null, exit_code: code, stderr: "" }, JSON.stringify([out, code]));
      assert.equal(r.out.repos["o/r"].gh_cmd, "gh-personal", JSON.stringify([out, code]));
    }
  }));

test("5.0.8 review N3: gh absent or not executable is reported not installed, with no retry", () =>
  withBin((home, bin) => {
    stub(bin, "gh-personal", "false");
    let r = prog(["-", "o/r"], bin);
    assert.deepEqual(r.out.repos["o/r"].tried, [{ cmd: "gh", installed: false, push: null }, { cmd: "gh-personal", installed: true, push: false }]);
    assert.equal(r.out.repos["o/r"].gh_cmd, "gh-personal");
    // an OSError (a gh whose interpreter is missing) is not installed, never retried
    stub(bin, "gh", "true", 0, "", 0, "#!/nonexistent/interpreter");
    r = prog(["-", "o/r"], bin);
    assert.deepEqual(r.out.repos["o/r"].tried[0], { cmd: "gh", installed: false, push: null });
    assert.ok(r.ms < 2500, "no 3 s retry wait: " + r.ms + " ms");
  }));

test("5.0.8 review B1b: a transient failure is tried once more; another failure and a timeout are not", () =>
  withBin((home, bin) => {
    stub(bin, "gh", null, 1, "error connecting to api.github.com: connection reset by peer");
    let r = prog(["-", "o/r"], bin);
    assert.equal(logOf(bin, "gh").length, 2, "one retry for a transient error");
    rmSync(join(bin, "gh.log"));
    stub(bin, "gh", null, 1, "GraphQL: Could not resolve to a Repository (HTTP 403)");
    r = prog(["-", "o/r"], bin);
    assert.equal(logOf(bin, "gh").length, 1, "no retry for a 4xx");
    rmSync(join(bin, "gh.log"));
    // a call that hangs is cut at 15 s, read as unknown and not retried
    stub(bin, "gh", "true", 0, "", 30);
    r = prog(["-", "o/r"], bin);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.repos["o/r"].tried[0], { cmd: "gh", installed: true, push: null, exit_code: null, stderr: "timed out after 15 s" });
    assert.equal(logOf(bin, "gh").length, 1);
    assert.ok(r.ms >= 14000 && r.ms < 25000, r.ms + " ms");
  }));

test("5.0.8 review S1: only a GitHub-hosted origin is probed (https github.com, ssh host github.com or an alias ssh -G resolves to it)", () =>
  withBin((home, bin) => {
    stub(bin, "gh", "true");
    sshStub(bin, { "github-personal": "github.com", cb: "codeberg.org" });
    for (const [url, want] of [
      ["https://github.com/o/r.git", "o/r"],
      ["https://github.com/o/r", "o/r"],
      ["git@github.com:o/r.git", "o/r"],
      ["ssh://git@github.com/o/r.git", "o/r"],
      ["github-personal:o/r.git", "o/r"],
      ["git@github-personal:o/r.git", "o/r"],
      ["cb:o/r.git", null],
      ["https://codeberg.org/o/r.git", null],
      ["git@gitlab.com:o/r.git", null],
      ["/srv/git/r.git", null],
      ["file:///srv/git/r.git", null],
      ["../r", null],
      ["https://github.com/o", null],
    ]) {
      rmSync(join(bin, "gh.log"), { force: true });
      const r = prog([repoWithOrigin(home, url)], bin);
      assert.equal(r.status, 0, url + ": " + r.stderr);
      assert.equal(r.out.origin, want, url);
      if (want) assert.equal(r.out.repos[want].gh_cmd, "gh", url);
      else assert.deepEqual([r.out.repos, logOf(bin, "gh")], [{}, []], url + ": no probe");
    }
  }));

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
  const ws = call(out.build, "workspace").prompt;
  assert.ok(ws.indexOf("gh_identity.py' '/r'") > 0 && ws.indexOf("gh_identity.py") < ws.indexOf("fetch origin"), "the program runs first");
  // B1a: the program may run longer than the Bash default of 120 s
  assert.match(ws, /as one Bash call with timeout 600000 ms:\nsha256sum -- '[^']*gh_identity\.py'/);
  assert.match(ws, /`<gh> pr list --head <branch>/);
  assert.ok(out.build.logs.some((l) => /GitHub command for o\/r: gh-personal \(push\)/.test(l)));
  for (const label of ["infra:push", "role:fleet-pr-opener", "role:pr-review:v1"]) assert.equal(inputsOf(call(out, label).prompt).gh_cmd, "gh-personal", label);
  const carried = out.calls.flatMap((c) => ghCmdsIn(c.prompt).map((v) => [c.label, v]));
  assert.ok(carried.length >= 3, JSON.stringify(carried));
  for (const [l, v] of carried) assert.equal(v, "gh-personal", l);
  assert.match(readFileSync(join(ROLES_SRC, "fleet-pr-opener.md"), "utf8"), /`gh_cmd`: the GitHub command the workflow checked/);
  assert.match(readFileSync(join(ROLES_SRC, "pr-review.md"), "utf8"), /Use exactly `<gh>` for every GitHub call/);
});

test("5.0.8 2030: gh with push -> gh_cmd gh everywhere", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.ghPush };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const label of ["infra:push", "role:fleet-pr-opener", "role:pr-review:v1"]) assert.equal(inputsOf(call(out, label).prompt).gh_cmd, "gh", label);
});

test("5.0.8 review N6: no push for the build's repo stops the build at its start (role); plan mode only warns", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.noPush };
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  assert.ok(plan.logs.some((l) => /^warning: no GitHub command with push access to o\/r \(gh=false, gh-personal=false\)/.test(l)), plan.logs.join("\n"));
  const b = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(b.result.status, "needs_human");
  assert.equal(b.result.stop_gate, "role");
  assert.match(b.result.reason, /^build start: no GitHub command with push access to o\/r \(gh=false, gh-personal=false\)/);
  assert.deepEqual(b.labels.filter((l) => !/^infra:(build-clean|db-down)/.test(l)), ["preflight", "workspace"]);
});

// workspace relays that the script cannot use: [name, mutation of gh_check, re-digest after it]
const BROKEN = [
  ["no gh_check", (r) => delete r.gh_check, false],
  ["null gh_check", (r) => (r.gh_check = null), false],
  ["wrong digest", (r) => (r.gh_check.digest = "0".repeat(64)), false],
  ["pick not of tried", (r) => (r.gh_check.repos["o/r"].gh_cmd = "gh"), true],
  ["push not of tried", (r) => (r.gh_check.repos["o/r"].push = false), true],
  ["other args", (r) => (r.gh_check.args = ["/other"]), true],
  ["tried after a push", (r) => r.gh_check.repos["o/r"].tried.unshift({ cmd: "gh-personal", installed: true, push: true }), true],
];

test("5.0.8 review B1c: an unusable gh_check never halts the workspace; gh_cmd is null and the PR step stops before any agent", async () => {
  for (const [name, mut, re] of BROKEN) {
    const s = happy();
    s.__gh = { "o/r": TRIED.personalPush };
    s.__mutate = { label: "workspace", fn: (r, p) => (mut(r), re ? redigest("workspace", r, p) : r) };
    const out = await run(s, ARGS);
    assert.ok(out.plan.logs.some((l) => /^workspace: gh check unusable: /.test(l)), name);
    assert.equal(out.planResult.status, "awaiting_confirmation", name + ": " + out.planResult.reason);
    assert.equal(out.result.status, "needs_human", name);
    assert.equal(out.result.stop_gate, "role", name);
    assert.match(out.result.reason, /^PR step: no GitHub command with push access to o\/r \(no gh check\)/, name);
    assert.equal(inputsOf(call(out, "infra:push").prompt).gh_cmd, null, name);
    assert.ok(out.labels.includes("infra:state:pushed:p1"), name);
    assert.ok(!out.labels.some((l) => /^(role:fleet-pr-opener|infra:fleet-scan:fleet-pr-opener)/.test(l)), name);
  }
});

test("5.0.8 review S1: a non-GitHub origin (program origin null) is no halt and no probe; gh_cmd null", async () => {
  const s = happy();
  s.__mutate = { label: "workspace", fn: (r, p) => (Object.assign(r.gh_check, { origin: null, repos: {} }), redigest("workspace", r, p)) };
  const out = await run(s, ARGS);
  assert.ok(out.plan.logs.some((l) => /^workspace: no GitHub-hosted origin; gh_cmd null/.test(l)), out.plan.logs.join("\n"));
  assert.equal(out.planResult.status, "awaiting_confirmation");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^PR step: no GitHub command with push access to o\/r/);
});

test("5.0.8 review S2: the program's origin differs from remote_slug -> a gate line, the probe's answer is used; no halt", async () => {
  const s = happy();
  // the program read origin o/r2 (and probed it); the agent parsed o/r
  s.__mutate = {
    label: "workspace",
    fn: (r, p) => {
      r.gh_check.origin = "o/r2";
      r.gh_check.repos = { "o/r2": { gh_cmd: "gh-personal", push: true, tried: TRIED.personalPush } };
      return redigest("workspace", r, p);
    },
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.logs.some((l) => l === "workspace: the gh check read origin o/r2, not remote_slug o/r; using the probe of o/r2"), out.build.logs.join("\n"));
  assert.equal(inputsOf(call(out, "role:fleet-pr-opener").prompt).gh_cmd, "gh-personal");
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
  assert.match(call(out, "infra:gh-identity:intake").prompt, /with timeout 600000 ms/);
  const ip = call(out, "intake").prompt;
  assert.equal(inputsOf(ip).gh_cmd, "gh-personal");
  assert.ok(!ip.includes("gh_identity.py"), "intake (task text) runs no program");
  const plain = await runOne(happy(), ARGS);
  assert.ok(!plain.labels.some((l) => /^infra:gh-identity:/.test(l)));
  assert.ok(!("gh_cmd" in inputsOf(call(plain, "intake").prompt)));
});

test("5.0.8 2030: a GitHub comment with no push-capable command is failed without an agent; write-back stays soft", async () => {
  const s = happy();
  s.__gh = { "o/r": TRIED.personalPush, "x/y": TRIED.noPush };
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
  assert.equal(inputsOf(call(out.build, "infra:comments-list").prompt).sources.find((x) => x.ref === "x/y#5").gh_cmd, "gh");
  assert.deepEqual(inputsOf(call(out.build, "infra:gh-identity:comments").prompt).args, ["-", "x/y"]);
  const c = out.result.write_back.comments.find((e) => e.ref === "x/y#5");
  assert.equal(c.status, "failed");
  assert.match(c.reason, /no GitHub command with push access to x\/y \(gh=false, gh-personal=false\)/);
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
  // 5.0.7's failure: the opener ran with the work login and was refused
  const opener = s["role:fleet-pr-opener"];
  s["role:fleet-pr-opener"] = { status: "needs_human", reason: "GraphQL: must be a collaborator" };
  s.__gh = { "o/r": TRIED.personalPush };
  const plan = await runOne(s, ARGS);
  const first = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  assert.equal(first.result.status, "needs_human", first.result.reason);
  const st = states.pushed;
  assert.deepEqual(Object.keys(st).sort(), STATE_507_KEYS.filter((k) => k in st).sort());
  assert.ok(!JSON.stringify(st).includes("gh"), "no gh value in the run-state");
  // the re-run (as docs-74 does: same plan_ref)
  s["role:fleet-pr-opener"] = opener;
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
  for (const l of hits) assert.match(l, /GH_CMDS = \["gh", "gh-personal"\]|authorise gh or gh-personal/, l);
  // every gh command in a prompt string uses the checked command (<gh> or <gh_cmd>), never a bare gh
  const strs = [...SOURCE.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const bare = strs.filter((x) => /`gh (api|pr|issue|repo|auth)\b/.test(x));
  assert.deepEqual(bare, []);
  for (const [f, t] of roles) assert.deepEqual(t.match(/`gh (api|pr|issue|repo|auth)\b[^`]*`/g) || [], [], f);
});

// ---------------------------------------------------------------- delta review D1: definite no-push only

const UNKNOWN_PUSH = {
  "gh=null, gh-personal=null": [{ cmd: "gh", installed: true, push: null }, { cmd: "gh-personal", installed: true, push: null }],
  "gh=false, gh-personal=null": [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: true, push: null }],
  "gh=null, gh-personal not installed": [{ cmd: "gh", installed: true, push: null }, { cmd: "gh-personal", installed: false, push: null }],
};

test("5.0.8 delta D1: a probe that was null or transient never stops the build at its start; the PR step stays the backstop", async () => {
  for (const [name, tried] of Object.entries(UNKNOWN_PUSH)) {
    const s = happy();
    s.__gh = { "o/r": tried };
    const out = await run(s, ARGS);
    assert.equal(out.planResult.status, "awaiting_confirmation", name);
    assert.ok(!out.plan.logs.some((l) => /^warning: no GitHub command with push access/.test(l)), name + ": no definite warning");
    assert.ok(out.build.logs.some((l) => /^build start: push access to o\/r not known \(/.test(l)), name + ": " + out.build.logs.join("\n"));
    assert.ok(out.build.labels.includes("infra:verify-plan"), name + ": the build went on");
    assert.equal(out.result.stop_gate, "role", name);
    // 6.0.0 (2038): the PR step probes once more; unknown again -> its own text
    assert.match(out.result.reason, /^PR step: push access to o\/r still not known after a second probe/, name);
  }
});

test("5.0.8 delta D1: a definite no-push (every installed candidate answered false) stops at build start; plan mode warns", async () => {
  for (const tried of [TRIED.noPush, [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: false, push: null }]]) {
    const s = happy();
    s.__gh = { "o/r": tried };
    const plan = await runOne(s, ARGS);
    assert.ok(plan.logs.some((l) => /^warning: no GitHub command with push access to o\/r/.test(l)));
    const b = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r" });
    assert.equal(b.result.stop_gate, "role", JSON.stringify(tried));
    assert.match(b.result.reason, /^build start: no GitHub command with push access to o\/r/);
    assert.deepEqual(b.labels.filter((l) => !/^infra:(build-clean|db-down)/.test(l)), ["preflight", "workspace"]);
  }
});
