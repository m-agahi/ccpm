// fleet 7.3.0 (#43, L2177) A11, A12: plan mode adopts the slug of the one
// existing local branch fleet/<task_id>-<slug>, so a re-run whose intake
// titles the task differently keeps its branch, worktree and parked drafts.
// The read is a shipped program (fleet_branch.py, digest id fleet_branch).
//
// dont_care: the wording of the gate lines beyond "adopted"; the order of
// unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARGS, BRIEF, SCRIPTS_SRC, happy, runOne, call, inputsOf, spawnSync } from "./harness.mjs";

const slugs = (list) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "listed", slugs: list, args: [i.repo, i.task_id] };
};
function titled(title, list) {
  const s = happy();
  s.intake = Object.assign({}, s.intake, { brief: Object.assign({}, BRIEF, { title }) });
  s["infra:fleet-branch"] = slugs(list);
  return s;
}

test("7.3.0 #43 A11: one existing fleet/y42-<slug> branch: its slug is adopted over the intake title's", async () => {
  const out = await runOne(titled("Intake slug drift", ["intake-branch-slug-drifts"]), ARGS);
  const ws = inputsOf(call(out, "workspace").prompt);
  assert.equal(ws.branch, "fleet/y42-intake-branch-slug-drifts");
  assert.ok(out.logs.some((l) => /branch slug intake-branch-slug-drifts adopted from existing fleet\/y42-intake-branch-slug-drifts \(intake gave intake-slug-drift\)/.test(l)), out.logs.join("\n"));
  assert.ok(out.labels.indexOf("infra:fleet-branch") < out.labels.indexOf("workspace"));
  assert.match(call(out, "infra:fleet-branch").prompt, /fleet_branch\.py' '\/r' 'y42'/);
});

test("7.3.0 #43 A12: several slugs without the derived one stop; none or the derived one keep it; a text input reads none", async () => {
  const two = await runOne(titled("c", ["a", "b"]), ARGS);
  assert.equal(two.result.status, "needs_human", two.result.reason);
  assert.match(two.result.reason, /fleet\/y42-a.*fleet\/y42-b/);
  assert.ok(!two.labels.includes("workspace"));
  const none = await runOne(titled("c", []), ARGS);
  assert.equal(inputsOf(call(none, "workspace").prompt).branch, "fleet/y42-c");
  const mine = await runOne(titled("c", ["a", "c"]), ARGS);
  assert.equal(inputsOf(call(mine, "workspace").prompt).branch, "fleet/y42-c");
  // a slug that is not a slug (a path, upper case) is never adopted
  const odd = await runOne(titled("c", ["../x"]), ARGS);
  assert.equal(inputsOf(call(odd, "workspace").prompt).branch, "fleet/y42-c");
  const text = happy();
  text.intake = Object.assign({}, text.intake, { brief: Object.assign({}, BRIEF, { title: "free text", sources: [{ kind: "text", ref: "text", url: null, body: "add a thing" }] }) });
  const t = await runOne(text, { ...ARGS, input: "add a thing" });
  assert.ok(!t.labels.includes("infra:fleet-branch"), t.labels.join(", "));
});

test("7.3.0 #43: fleet_branch.py lists the slugs of refs/heads/fleet/<id>-* only", () => {
  const repo = mkdtempSync(join(tmpdir(), "fleet-730b-"));
  try {
    const git = (...a) => assert.equal(spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
    git("init", "-q", "-b", "main");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    for (const b of ["fleet/y43-one", "fleet/y43-two", "fleet/y430-other", "fleet/x43-no", "y43-no"]) git("branch", b);
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "fleet_branch.py"), repo, "y43"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.slugs, ["one", "two"]);
    assert.deepEqual(o.args, [repo, "y43"]);
    assert.match(o.digest, /^[0-9a-f]{64}$/);
    assert.notEqual(spawnSync("python3", ["-I", join(SCRIPTS_SRC, "fleet_branch.py"), repo, "../x"]).status, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
