// fleet 7.0.0 AC1 (yaadgaar #699): every project's tasks live in yaadgaar.
// Intake gets ledger "yaadgaar" for any args.project, and for none; its prompt
// holds one ledger branch, yaadgaar read_task, and no yadgar ledger branch.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, inputsOf, call, noUnscripted } from "./harness.mjs";

const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };

test("7.0.0 AC1: a task id on any project, or on none, is read from yaadgaar", async () => {
  for (const project of ["o/r", "m-agahi/x", "yadgarhq/docs", undefined]) {
    for (const input of ["#622", "622", "yaadgaar #622"]) {
      const a = { ...ARGS, input, confirm: "ask" };
      if (project === undefined) delete a.project;
      else a.project = project;
      const s = happy({ brief: YBRIEF });
      const out = await runOne(s, a);
      noUnscripted(out);
      assert.equal(out.result.status, "awaiting_confirmation", project + " " + input + ": " + out.result.reason);
      assert.equal(inputsOf(call(out, "intake").prompt).ledger, "yaadgaar", String(project));
      const ref = JSON.parse(s.__store[out.result.plan_ref.plan_commit]);
      assert.deepEqual(ref.brief.sources.map((x) => x.kind + ":" + x.ref), ["yaadgaar:622"]);
    }
  }
});

test("7.0.0 AC1: the intake prompt holds no yadgar ledger branch; an L<N> id stops for the yaadgaar number", async () => {
  for (const project of ["o/r", undefined]) {
    const a = { ...ARGS, confirm: "ask" };
    if (project === undefined) delete a.project;
    const out = await runOne(happy(), a);
    const p = call(out, "intake").prompt;
    for (const banned of ["mcp__yadgar__task_get", "mcp__yadgar__wiki_read", "wiki_read(", "body_slug", "ledger `yadgar`", "ledger `either`", "frozen history"])
      assert.ok(p.indexOf(banned) < 0, String(project) + ": intake prompt still names " + banned);
    assert.match(p, /mcp__yaadgaar__read_task/);
    assert.match(p, /read_task|number=<the number>/);
    // a legacy id is not resolved: the migrated task carries the title prefix L<N>:
    assert.match(p, /`L42` input -> needs_human/);
    assert.match(p, /title prefix `L42: `/);
  }
});
