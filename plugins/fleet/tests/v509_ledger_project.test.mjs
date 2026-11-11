// fleet 5.0.9 (ledger 2032): a yaadgaar read_task answer names no project
// for a task in the client's own project (the gateway's TaskView has no
// project field; a find_tasks index row names one only for ANOTHER project,
// and no tool names the session's). Run wf_ed820f22-b98 (5.0.8) relayed that
// absent field as "" and the write-back refused task #671 as "in project """.
// An absent or empty project is not a named one, and it is not a match
// either: session_project.py (run by preflight in the session's start
// directory, digest-checked) derives the client's project by the client's own
// rule, and the script compares it with the expected project. No proof: the
// write-back is unavailable (soft) and intake stops. A named project that
// differs is still refused.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, BRIEF, HERE, happy, runOne, inputsOf, call, noUnscripted } from "./harness.mjs";

const YURN = "yadgar:task:01a1b2dd-245e-71fd-b001-1219925b3422";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "671", url: null, body: "yaadgaar task body", id: YURN }] };
const YQ = { ...ARGS, input: "yaadgaar #671", project: "yadgarhq/docs", confirm: "ask" };
const written = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
const read = (over) => (p) => ({
  status: "ok",
  reason: "read",
  results: inputsOf(p).tasks.map((t) => Object.assign({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false }, over)),
});

// plan under the proof args.project; then build with `session` as the build
// session's proof (undefined: none is scripted, so args.project) and `rd` as
// the read step's answer
async function build(session, rd) {
  const s = happy({ brief: YBRIEF });
  const plan = await runOne(s, YQ);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  if (session !== undefined) s.__session_project = session;
  s["infra:yaadgaar-read"] = rd;
  s["infra:yaadgaar-writeback"] = written;
  return runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
}
const entry = (out) => out.result.write_back.ledger.find((e) => e.ref === "yaadgaar #671");

test("5.0.9 write-back: no project in the answer (\"\" or absent) + session proof = args.project -> written", async () => {
  for (const over of [{ project: "" }, {}, { project: null }]) {
    const out = await build(undefined, read(over));
    noUnscripted(out);
    assert.equal(out.result.status, "ok", out.result.reason);
    assert.equal(entry(out).status, "written", JSON.stringify(over) + ": " + entry(out).reason);
    assert.ok(out.labels.includes("infra:yaadgaar-writeback"));
    assert.ok(out.logs.some((l) => /session yaadgaar project: "yadgarhq\/docs"/.test(l)), "the proof is gate-logged");
  }
});

test("5.0.9 write-back: no project in the answer + a session proof of another project -> failed, nothing edited", async () => {
  const out = await build("yadgarhq/iam-db", read({ project: "" }));
  assert.equal(out.result.status, "ok", out.result.reason);
  const e = entry(out);
  assert.equal(e.status, "failed");
  assert.match(e.reason, /session's yaadgaar project is yadgarhq\/iam-db, not yadgarhq\/docs/);
  assert.match(e.section_text, /fleet:y671/);
  assert.ok(!out.labels.includes("infra:yaadgaar-writeback"));
});

test("5.0.9 write-back: no project in the answer + no proof -> unavailable (soft), nothing edited", async () => {
  // the program resolved nothing, or no relay at all, or a relay whose digest is broken
  const broken = (s) => {
    s.preflight = { session_project: { project: "yadgarhq/docs", source: "origin", cwd: "/x", args: [], digest: "0".repeat(64) } };
  };
  for (const how of ["null", "none", "broken"]) {
    const s = happy({ brief: YBRIEF });
    const plan = await runOne(s, YQ);
    assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
    if (how === "null") s.__session_project = null;
    if (how === "none") s.preflight = { session_project: null };
    if (how === "broken") broken(s);
    s["infra:yaadgaar-read"] = read({});
    s["infra:yaadgaar-writeback"] = written;
    const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
    assert.equal(out.result.status, "ok", how + ": " + out.result.reason);
    const e = entry(out);
    assert.equal(e.status, "unavailable", how + ": " + e.reason);
    assert.match(e.reason, /no proof of the session's yaadgaar project/, how);
    assert.equal(out.result.ledger_status, "unavailable", how);
    assert.ok(!out.labels.includes("infra:yaadgaar-writeback"), how);
  }
});

test("5.0.9 write-back: a named project other than args.project is refused, even with a matching proof (unchanged)", async () => {
  const out = await build(undefined, read({ project: "yadgarhq/other" }));
  const e = entry(out);
  assert.equal(e.status, "failed");
  assert.match(e.reason, /is in project "yadgarhq\/other", not args\.project yadgarhq\/docs/);
  assert.ok(!out.labels.includes("infra:yaadgaar-writeback"));
});

// intake (plan mode) reads by number: the session project must be proven
const intake = async (session, srcOver) => {
  const s = happy({ brief: { ...YBRIEF, sources: [Object.assign({}, YBRIEF.sources[0], srcOver)] } });
  if (session !== undefined) s.__session_project = session;
  return runOne(s, YQ);
};

test("5.0.9 intake: no project in the answer + proof = args.project -> plan goes on", async () => {
  for (const over of [{}, { project: "" }, { project: null }]) {
    const out = await intake(undefined, over);
    assert.equal(out.result.status, "awaiting_confirmation", JSON.stringify(over) + ": " + out.result.reason);
  }
});

test("5.0.9 intake: no project in the answer + proof of another project -> needs_human before the workspace", async () => {
  const out = await intake("yadgarhq/iam-db", { project: "" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /intake: .*session's yaadgaar project is yadgarhq\/iam-db, not yadgarhq\/docs/);
  assert.ok(!out.labels.includes("workspace"));
});

test("5.0.9 intake: no project in the answer + no proof -> needs_human before the workspace", async () => {
  const out = await intake(null, {});
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /no proof of the session's yaadgaar project/);
  assert.ok(!out.labels.includes("workspace"));
});

test("5.0.9 intake: a named project other than args.project stops (unchanged)", async () => {
  const out = await intake(undefined, { project: "yadgarhq/other" });
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /of project yadgarhq\/other, not args\.project yadgarhq\/docs/);
});

test("5.0.9 preflight: the prompt runs session_project.py from the start directory, no args", async () => {
  const out = await runOne(happy({ brief: YBRIEF }), YQ);
  const p = call(out, "preflight").prompt;
  assert.match(p, /sha256sum -- <scripts_dir>\/session_project\.py && python3 -I <scripts_dir>\/session_project\.py\n/);
  assert.match(p, /never cd first/);
  assert.match(p, /session_project, reason\}/);
});

// the program itself: the yaadgaar client's rule (yadgar-client project.rs)
function prog(cwd, env) {
  const r = spawnSync("python3", ["-I", join(HERE, "..", "scripts", "session_project.py")], { cwd, encoding: "utf8", env: Object.assign({}, process.env, env || {}) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function git(cwd, ...a) {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

test("5.0.9 session_project.py: project-id file wins; empty file falls through to origin; origin normalised; nothing -> null", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sp-")));
  const cfg = join(root, "gitconfig");
  writeFileSync(cfg, '[url "git@github.com:"]\n\tinsteadOf = gh:\n');
  const env = { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(root, "docs");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "gh:YadgarHQ/Docs.git/");
  let o = prog(join(repo, "sub"), env);
  assert.equal(o.project, "yadgarhq/docs");
  assert.equal(o.source, "origin");
  assert.equal(o.cwd, join(repo, "sub"));
  assert.deepEqual(o.args, []);
  assert.equal(o.program.name, "session_project");
  for (const [url, want] of [["https://codeberg.org/a/b.git", "a/b"], ["ssh://git@host:22/g/s/r/", "g/s/r"], ["codeberg-agent:o/r", "o/r"], ["/srv/m-agahi/x.io", "/srv/m-agahi/x.io"]]) {
    git(repo, "remote", "set-url", "origin", url);
    assert.equal(prog(repo, env).project, want, url);
  }
  mkdirSync(join(repo, ".yadgar"));
  writeFileSync(join(repo, ".yadgar", "project-id"), "\n");
  assert.equal(prog(join(repo, "sub"), env).project, "/srv/m-agahi/x.io", "an empty file falls through");
  writeFileSync(join(repo, ".yadgar", "project-id"), " yadgarhq/docs \n");
  o = prog(join(repo, "sub"), env);
  assert.equal(o.project, "yadgarhq/docs");
  assert.equal(o.source, "project-id");
  const bare = join(root, "bare");
  mkdirSync(bare);
  o = prog(bare, env);
  assert.equal(o.project, null);
  assert.equal(o.source, null);
});
