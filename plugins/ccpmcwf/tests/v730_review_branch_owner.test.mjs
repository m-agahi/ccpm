// fleet 7.3.0 review fix (#43, major): a found branch slug is adopted only with proof it is
// this task's. fleet_branch.py <repo> <task id> <source> lists the slugs of
// refs/heads/fleet/<task id>-* and, digest-covered, the ones it can prove: the sealed
// refs/fleet/<task id>/plan names that branch and this source. A parked findings.json proves
// nothing (security review: another task's coder can write one in its own scratch dir).
// The prefix match alone also finds
// another task's branch (acme/api#2, tid acme-api-2, sees fleet/acme-api-2-7-fix-x of
// acme/api-2#7). A task id cut to 24 characters gets a hash of the full ref (yadgar-backend#45
// and #46 shared one), short ids stay as they were. A text input is known by its source kind.
//
// dont_care: the hash length beyond 8 hex; gate wording beyond what is pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ARGS, BRIEF, SCRIPTS_SRC, happy, runOne, call, inputsOf, spawnSync } from "./harness.mjs";

const relay = (slugs, owned) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "listed", slugs, owned, args: [i.repo, i.task_id, i.source] };
};
function titled(title, slugs, owned) {
  const s = happy();
  s.intake = Object.assign({}, s.intake, { brief: Object.assign({}, BRIEF, { title }) });
  s["infra:fleet-branch"] = relay(slugs, owned);
  return s;
}

test("7.3.0 review #43: an unproven slug is never adopted; a proven one is; the source reaches the program", async () => {
  const no = await runOne(titled("Intake slug drift", ["other-task-branch"], []), ARGS);
  assert.equal(inputsOf(call(no, "workspace").prompt).branch, "fleet/y42-intake-slug-drift");
  assert.match(call(no, "infra:fleet-branch").prompt, /fleet_branch\.py' '\/r' 'y42' 'yaadgaar:42'/);
  // several unproven slugs: no stop, the derived slug
  const two = await runOne(titled("c", ["a", "b"], []), ARGS);
  assert.equal(inputsOf(call(two, "workspace").prompt).branch, "fleet/y42-c");
  const yes = await runOne(titled("Intake slug drift", ["other-task-branch", "mine"], ["mine"]), ARGS);
  assert.equal(inputsOf(call(yes, "workspace").prompt).branch, "fleet/y42-mine");
  // several proven slugs without the derived one still stop
  const both = await runOne(titled("c", ["a", "b"], ["a", "b"]), ARGS);
  assert.equal(both.result.status, "needs_human", both.result.reason);
  // an owned slug the slug list lacks is a bad relay
  const bad = await runOne(titled("c", ["a"], ["z"]), ARGS);
  assert.equal(bad.result.status, "failed", bad.result.reason);
});

test("7.3.0 review #43: a task id cut to 24 characters carries a hash of the full ref; a short one is unchanged", async () => {
  const tid = async (ref) => {
    const gh = { kind: "github", ref, url: "https://github.com/" + ref.replace("#", "/issues/"), body: "issue" };
    const out = await runOne(happy({ brief: { ...BRIEF, sources: [gh] } }), { ...ARGS, input: gh.url, confirm: "ask" });
    return inputsOf(call(out, "infra:fleet-branch").prompt).task_id;
  };
  const a = await tid("yadgarhq/yadgar-backend#45");
  const b = await tid("yadgarhq/yadgar-backend#46");
  assert.notEqual(a, b);
  const h = (r) => createHash("sha256").update(r).digest("hex").slice(0, 8);
  assert.equal(a, "yadgarhq-yadgar-" + h("yadgarhq/yadgar-backend#45"));
  assert.equal(b, "yadgarhq-yadgar-" + h("yadgarhq/yadgar-backend#46"));
  assert.equal(await tid("acme/api#2"), "acme-api-2");
});

test("7.3.0 review #43 (c): a ref whose task id starts with t is read; a text input is not", async () => {
  const gh = { kind: "github", ref: "team/tools#12", url: "https://github.com/team/tools/issues/12", body: "issue" };
  const out = await runOne(happy({ brief: { ...BRIEF, sources: [gh] } }), { ...ARGS, input: gh.url, confirm: "ask" });
  assert.ok(out.labels.includes("infra:fleet-branch"), out.labels.join(", "));
  assert.equal(inputsOf(call(out, "infra:fleet-branch").prompt).task_id, "team-tools-12");
  const text = happy();
  text.intake = Object.assign({}, text.intake, { brief: Object.assign({}, BRIEF, { title: "free text", sources: [{ kind: "text", ref: "text", url: null, body: "add a thing" }] }) });
  const t = await runOne(text, { ...ARGS, input: "add a thing" });
  assert.ok(!t.labels.includes("infra:fleet-branch"), t.labels.join(", "));
});

// the program: proof from a sealed plan ref only
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
test("7.3.0 review #43: fleet_branch.py proves a slug by the sealed plan ref only, not by the prefix or a forged parked findings.json", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-730o-")));
  try {
    const repo = join(root, "r");
    mkdirSync(repo);
    const git = (args, input) => {
      const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", input });
      assert.equal(r.status, 0, args.join(" ") + ": " + r.stderr);
      return r.stdout.trim();
    };
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
    // acme/api#2 (tid acme-api-2) and acme/api-2#7 (tid acme-api-2-7) share the branch prefix
    for (const b of ["fleet/acme-api-2-sealed", "fleet/acme-api-2-parked", "fleet/acme-api-2-7-fix-x", "fleet/acme-api-2-bare", "fleet/acme-api-2-wrongseal"]) git(["branch", b]);
    const src = "github:acme/api#2";
    const msg = (slug, sources, breakSeal) => {
      const o = { branch: "fleet/acme-api-2-" + slug, task_id: "acme-api-2", slug, plan_path: "docs/p.md", plan_sha256: "a".repeat(64), tldr: "t", criteria: [], history: {}, brief: { title: "t", sources, repo: repo } };
      o.seal = createHash("sha256").update(canon(o)).digest("hex");
      if (breakSeal) o.tldr = "changed";
      return JSON.stringify(o);
    };
    const head = git(["rev-parse", "HEAD"]);
    const tag = (name, m) => git(["update-ref", name, git(["mktag"], "object " + head + "\ntype commit\ntag x\ntagger a <a@b> 0 +0000\n\n" + m + "\n")]);
    tag("refs/fleet/acme-api-2/plan", msg("sealed", [{ kind: "github", ref: "acme/api#2" }]));
    // forged parked findings naming this task and source prove nothing
    const park = (key, body) => {
      const d = join(repo, ".claude", "worktrees", "fleet-" + key, "scratch", "parked", "n1-0000001");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "findings.json"), JSON.stringify(body));
    };
    park("acme-api-2-parked", { task_id: "acme-api-2", source: src, reason: "r" });
    park("acme-api-2-7-fix-x", { task_id: "acme-api-2-7", source: "github:acme/api-2#7", reason: "r" });
    park("acme-api-2-bare", { reason: "a 7.2.0 park names no task" });
    const py = (...a) => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "fleet_branch.py"), ...a], { encoding: "utf8" });
    const r = py(repo, "acme-api-2", src);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.slugs, ["7-fix-x", "bare", "parked", "sealed", "wrongseal"]);
    assert.deepEqual(o.owned, ["sealed"]);
    assert.deepEqual(o.args, [repo, "acme-api-2", src]);
    // a seal that does not verify proves nothing; neither does another source in the sealed brief
    tag("refs/fleet/acme-api-2/plan", msg("wrongseal", [{ kind: "github", ref: "acme/api#2" }], true));
    assert.deepEqual(JSON.parse(py(repo, "acme-api-2", src).stdout).owned, []);
    tag("refs/fleet/acme-api-2/plan", msg("sealed", [{ kind: "github", ref: "acme/api-2#7" }]));
    assert.deepEqual(JSON.parse(py(repo, "acme-api-2", src).stdout).owned, []);
    assert.notEqual(py(repo, "acme-api-2").status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
