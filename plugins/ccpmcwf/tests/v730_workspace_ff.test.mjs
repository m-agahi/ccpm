// fleet 7.3.0 (#39 part 1, L2162) A13: in plan mode the workspace step
// fast-forwards a reused fleet branch that has no own commits to
// origin/<default_branch>. Build mode never does (its worktree must stay at
// the audited plan_base).
//
// dont_care: the wording of the step beyond the two git commands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, runOne, call } from "./harness.mjs";

const IS_ANC = "merge-base --is-ancestor HEAD origin/<default_branch>";
const FF = "merge --ff-only origin/<default_branch>";

test("7.3.0 #39 A13: the plan-mode workspace prompt fast-forwards a reused branch; the build-mode prompt does not", async () => {
  const out = await run(happy(), ARGS);
  const plan = call(out.plan, "workspace").prompt;
  assert.ok(plan.includes(IS_ANC) && plan.includes(FF), plan);
  const build = call(out.build, "workspace").prompt;
  assert.ok(!build.includes(IS_ANC) && !build.includes(FF));
  assert.ok(!build.includes("ff_reused"));
});

test("7.3.0 #39 A13: a workspace relay with fast_forwarded true logs it", async () => {
  const s = happy();
  s.workspace = Object.assign({}, s.workspace, { fast_forwarded: true });
  const out = await runOne(s, ARGS);
  assert.ok(out.logs.some((l) => /fast-forwarded to origin\/master/.test(l)), out.logs.join("\n"));
});
