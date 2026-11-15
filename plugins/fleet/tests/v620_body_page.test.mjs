// fleet 6.2.0 (ledger 2058, Max's ruling option 1): a yadgar ledger task kept
// its body on the wiki page its body_slug named, and intake read that page with
// wiki_read (BODY_PAGE_REASON on a missing page).
//
// 7.0.0 (yaadgaar #699): the yadgar ledger is retired; every project's tasks
// live in yaadgaar, whose read_task answer carries the body. Intake reads no
// body page, the script checks no page read, and BODY_PAGE_REASON is gone. The
// schema keeps the body_slug property (a follow-up removes it), and the sealed
// brief never carried it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, BRIEF, happy, runOne, call, inputsOf, noUnscripted } from "./harness.mjs";

const SLUG = "o_r_task-42";
const MARKER = "<!-- fleet-brief:v1 -->";
const PAGE = "## Fleet brief (plan-task, 2026-11-12)\n\n" + MARKER + "\n\nRepo: o/r Component: x\n";
const pageBrief = (over) => ({ ...BRIEF, sources: [Object.assign({ kind: "ledger", ref: "42", url: null, body: "Add Thing! (open)\n\n" + PAGE, body_slug: SLUG }, over || {})] });

test("7.0.0 body page retired: no reason code, and the intake prompt names no page read", async () => {
  assert.doesNotMatch(SOURCE, /BODY_PAGE_REASON/);
  const out = await runOne(happy(), ARGS);
  const p = call(out, "intake").prompt;
  for (const banned of ["wiki_read", "body_slug", "task body page unreadable"]) assert.ok(p.indexOf(banned) < 0, banned);
  assert.ok(p.includes("sources: [{kind, ref, url, body, id, project}]"), "return shape");
});

test("6.2.0 body page: the intake schema accepts body_slug on a source", () => {
  assert.match(SOURCE, /const SOURCE_SCHEMA = \{[\s\S]*?body_slug: STR_OR_NULL[\s\S]*?\};/);
});

test("7.0.0 body page retired: a legacy source with a body_slug and no page read is not stopped by the script", async () => {
  const out = await runOne(happy({ brief: pageBrief(), tried: [] }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(call(out, "role:scope-and-plan").prompt.includes(MARKER), "the planner sees the sealed body");
});

test("6.2.0 body page: the sealed brief carries no body_slug (the plan ref shape is unchanged)", async () => {
  const out = await runOne(happy({ brief: pageBrief() }), ARGS);
  const src = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.ok(!JSON.stringify(src).includes('"body_slug"'), "body_slug is intake data only");
});
