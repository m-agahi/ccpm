// fleet 7.0.0 AC6 (yaadgaar #699): the build-task and plan-task skills describe
// one ledger, yaadgaar, for every project.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./harness.mjs";

const skill = (n) => readFileSync(join(HERE, "..", "skills", n, "SKILL.md"), "utf8");
const BANNED = ["task_get", "task_write", "wiki_add", "wiki_append_section", "wiki_read", "body_slug", "task_list", "yadgar ledger", "mcp__yadgar__"];

test("7.0.0 AC6: build-task and plan-task name no yadgar ledger path", () => {
  for (const n of ["build-task", "plan-task"]) {
    const t = skill(n);
    for (const b of BANNED) assert.ok(t.indexOf(b) < 0, n + " still names " + b);
    assert.match(t, /read_task/, n);
  }
});

test("7.0.0 AC6: plan-task writes through yaadgaar edit_task and files with create_task; the duplicate check uses find_tasks", () => {
  const t = skill("plan-task");
  assert.match(t, /edit_task/);
  assert.match(t, /expect_version/);
  assert.match(t, /create_task/);
  assert.match(t, /find_tasks/);
  assert.doesNotMatch(t, /`yadgarhq\/\*` projects/);
  const b = skill("build-task");
  assert.match(b, /yaadgaar/);
  assert.doesNotMatch(b, /On a `yadgarhq\/` project a task id/);
});
