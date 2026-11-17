// fleet 7.3.0 (#63) A9, A10: a brief plan_path under a dot dir, a scratch dir
// or a parked dir is not a tracked repo path: intake stops needs_human before
// the planner runs. The intake prompt asks for a git-tracked plan path.
//
// dont_care: the wording of the stop reason beyond "plan_path"; the order of
// unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, call } from "./harness.mjs";

function withPlanPath(p) {
  const s = happy();
  s.intake = Object.assign({}, s.intake, { brief: Object.assign({}, BRIEF, { plan_path: p }) });
  return s;
}

test("7.3.0 #63 A9: a parked draft path under .claude/worktrees stops at intake; no planner runs", async () => {
  const out = await runOne(withPlanPath(".claude/worktrees/fleet-x/scratch/parked/123/docs/plans/p.md"), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /plan_path/);
  assert.ok(!out.labels.includes("role:scope-and-plan"), out.labels.join(", "));
});

test("7.3.0 #63 A10: docs/plans/x.md reaches the planner; docs/scratch/p.md and .github/p.md stop", async () => {
  const ok = await runOne(withPlanPath("docs/plans/x.md"), ARGS);
  assert.ok(ok.labels.includes("role:scope-and-plan"), ok.result.reason);
  for (const p of ["docs/scratch/p.md", ".github/p.md", "a/parked/p.md"]) {
    const out = await runOne(withPlanPath(p), ARGS);
    assert.equal(out.result.status, "needs_human", p);
    assert.match(out.result.reason, /plan_path .* is not a tracked repo path/, p);
    assert.ok(!out.labels.includes("role:scope-and-plan"), p);
  }
});

test("7.3.0 #63: the intake prompt asks for a plan path git tracks, not one under .claude/ or scratch/", async () => {
  const out = await runOne(happy(), ARGS);
  const p = call(out, "intake").prompt;
  assert.match(p, /ls-files --error-unmatch/);
  assert.match(p, /not under `\.claude\/` or a `scratch\/` dir/);
  assert.ok(!/plan path that exists in the repo/.test(p));
});
