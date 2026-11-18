// fleet 7.4.0 car 4 (#39 part 2, L2162): the plan-time npm walk-up guard. Fleet worktrees sit at
// <repo>/.claude/worktrees/...; with no package.json at the worktree root npm walks up into the
// main checkout's package.json. npm 11.19 checked: npm_config_prefix and npm_config_local_prefix
// do not stop the walk-up; only the --prefix flag does.
// - J1: test_cmd npm/pnpm/yarn test (or npm run <x>): the plan hook-surface read asks for
//   npm:<name>; no entry (package.json or scripts.<name> not tracked at HEAD) is a plan finding
//   ("... npm would walk up into the main checkout"), routed through planFindingsStop: a re-plan
//   while rounds are left, needs_human after the last. A tracked script gives no finding; a
//   pytest test_cmd asks for no target.
//
// dont_care: the finding's wording after "npm would walk up".

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, call, inputsOf } from "./harness.mjs";

const hsOut = (mp) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [i.worktree, i.rev, JSON.stringify(i.targets)] };
};
const SFX = ["", ":audit-fix", ":audit-fix-2"];
function npmPlan(cmd, mp) {
  const s = happy();
  for (const x of SFX) {
    if (x) s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan"]);
    s["role:scope-and-plan" + x] = Object.assign({}, s["role:scope-and-plan" + x], { test_cmd: { command: cmd, paths_placeholder: null, env: {}, tools: [] } });
    s["infra:hook-surface:plan" + x] = hsOut(mp);
  }
  return s;
}

test("7.4.0 #39 J1: npm test with no tracked package.json script: a re-plan finding, then needs_human naming the walk-up", async () => {
  for (const [cmd, tgt] of [["npm test", "npm:test"], ["pnpm test", "npm:test"], ["yarn test", "npm:test"], ["npm run test:unit", "npm:test:unit"]]) {
    const out = await runOne(npmPlan(cmd, {}), ARGS);
    assert.equal(out.result.status, "needs_human", cmd + ": " + out.result.reason);
    assert.match(out.result.reason, /npm would walk up into the main checkout/, cmd);
    assert.ok(out.result.reason.includes("scripts." + tgt.slice(4)), out.result.reason);
    // 7.4.0 review B-M1: the guard reads pkg:scripts.<name>; npm:<name> is for R4
    assert.deepEqual(inputsOf(call(out, "infra:surfaces:plan").prompt).targets, [tgt, "pkg:scripts." + tgt.slice(4)]);
    const pr = inputsOf(call(out, "role:scope-and-plan:audit-fix").prompt).prior_round;
    assert.ok(pr.findings.some((f) => /npm would walk up/.test(f.finding)), JSON.stringify(pr.findings));
  }
});

test("7.4.0 #39 J1: a re-plan to a tracked script goes on; package.json with scripts.test gives no finding", async () => {
  const s = npmPlan("npm test", {});
  s["infra:hook-surface:plan:audit-fix"] = hsOut({ "pkg:scripts.test": [] });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const ok = await runOne(npmPlan("npm test", { "npm:test": ["scripts/run.mjs"], "pkg:scripts.test": [] }), ARGS);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  assert.ok(!ok.labels.includes("role:scope-and-plan:audit-fix"), ok.labels.join(", "));
});

test("7.4.0 #39 J1: a pytest test_cmd asks the plan hook-surface read for no target", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "infra:surfaces:plan").prompt).targets, []);
});
