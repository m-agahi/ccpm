// fleet 7.3.0 review fix (B1): a role the workflow dispatches as fleet:judge (agents/judge.md
// disallows Write, Edit and NotebookEdit) is never told to use the Edit or Write tool, and
// the test writer (its Edit rule covers the worktree only) is never told to edit a scratch
// copy with them either: scratch_copy.py patch is the way to change a copy. 7.2.0's roles
// had no such instruction (they had no copy program); 7.3.0 car 4 added it.
//
// dont_care: the wording of the patch instruction beyond naming `patch`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_TEXT, HERE, SOURCE, happy, run, ARGS } from "./harness.mjs";

const TOOL_RE = /\b(Edit|Write|NotebookEdit) tool\b/;

test("7.3.0 review B1: the judge agent disallows Edit and Write", () => {
  const a = readFileSync(join(HERE, "..", "agents", "judge.md"), "utf8");
  assert.match(a, /^disallowedTools: Write, Edit, NotebookEdit,/m);
});

test("7.3.0 review B1: no role dispatched as fleet:judge names the Edit or Write tool; the writer changes a copy only with patch", async () => {
  const out = await run(happy(), ARGS);
  const judged = new Set();
  for (const c of out.plan.calls.concat(out.build.calls)) {
    const m = /^role:([a-z-]+)/.exec(c.label);
    if (m && c.opts && c.opts.agentType === "fleet:judge") judged.add(m[1]);
  }
  for (const r of ["fleet-test-judge", "fleet-code-judge", "pr-review"]) assert.ok(judged.has(r), r + " not seen as fleet:judge: " + [...judged].join(", "));
  // the sweep runs only on a gate change (src: judged(), always JUDGE_AGENT); it is a judge too
  assert.match(SOURCE, /judged\(\s*"gate-change-nonweakening-sweep",/);
  assert.match(SOURCE, /async function judged\([\s\S]{0,800}?callRole\(role, label, inputs, phaseName, JUDGE_AGENT/);
  judged.add("gate-change-nonweakening-sweep");
  for (const r of judged) assert.ok(!TOOL_RE.test(ROLE_TEXT[r]), r + " names " + (TOOL_RE.exec(ROLE_TEXT[r]) || [""])[0]);
  const w = ROLE_TEXT["fleet-test-writer"];
  const copyPara = w.split("\n").find((l) => l.includes("scratch_copy_cmd> make"));
  assert.ok(copyPara && !TOOL_RE.test(copyPara), copyPara);
  for (const r of ["fleet-test-judge", "fleet-code-judge", "fleet-test-writer", "gate-change-nonweakening-sweep"]) assert.match(ROLE_TEXT[r], /<scratch_copy_cmd> patch <worktree> <tmp> <file> <old> <new>/, r);
});

test("7.3.0 review B1: of all role files only the coder's names the Edit or Write tool (covers judges a happy run does not dispatch: intent judge, CI classifier)", () => {
  const named = Object.keys(ROLE_TEXT).filter((r) => TOOL_RE.test(ROLE_TEXT[r]));
  assert.ok(named.every((r) => r === "fleet-coder"), named.join(", "));
  assert.ok("fleet-intent-judge" in ROLE_TEXT && "fleet-ci-classifier" in ROLE_TEXT, Object.keys(ROLE_TEXT).join(", "));
});
