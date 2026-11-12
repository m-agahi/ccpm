// fleet 6.2.0 (ledger 2058, Max's ruling option 1): a yadgar ledger task keeps
// its body on the wiki page its body_slug names; task_get returns the row only
// (title, status, body_slug). Intake reads that page with wiki_read and uses it
// as the task body. A missing or unreadable page stops with BODY_PAGE_REASON;
// the run never plans on the title only. A task whose answer carries body text
// needs no wiki_read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, BRIEF, PB, happy, runOne, call, inputsOf, noUnscripted } from "./harness.mjs";

const REASON = /^const BODY_PAGE_REASON = "([^"]+)";$/m.exec(SOURCE);
const CODE = REASON ? REASON[1] : "task body page unreadable";
const SLUG = "o_r_task-42";
const MARKER = "<!-- fleet-brief:v1 -->";
const PAGE = "## Fleet brief (plan-task, 2026-11-12)\n\n" + MARKER + "\n\nRepo: o/r Component: x\n";
const pageBrief = (over) => ({ ...BRIEF, sources: [Object.assign({ kind: "ledger", ref: "42", url: null, body: "Add Thing! (open)\n\n" + PAGE, body_slug: SLUG }, over || {})] });
const getCall = { ledger: "yadgar", project: "o/r", call: "task_get(project_id=o/r, id=42)", error: null };
const readCall = (slug, error) => ({ ledger: "yadgar", project: "o/r", call: "wiki_read(slug=" + slug + ", project=o/r)", error: error === undefined ? null : error });

test("6.2.0 body page: the reason code is a named constant", () => {
  assert.ok(REASON, "BODY_PAGE_REASON missing in build-task-run.js");
});

test("6.2.0 body page: the intake prompt tells the agent to wiki_read the body_slug page and stop on a missing page", async () => {
  const out = await runOne(happy(), ARGS);
  const p = call(out, "intake").prompt;
  assert.match(p, /mcp__yadgar__wiki_read/);
  assert.match(p, /wiki_read\(slug=<body_slug>, project=<project>\)/);
  assert.ok(p.includes("One with a body_slug and no body text: its body is that wiki page."));
  assert.ok(p.includes(CODE), "the prompt names the reason code");
  assert.match(p, /never (plan|proceed) on the title only/i);
  // 6.2.0 review M1: the return shape names body_slug, and a ledger source must carry it
  assert.ok(p.includes("sources: [{kind, ref, url, body, id, project, body_slug}]"), "return shape names body_slug");
  assert.ok(p.includes("A kind ledger source MUST carry body_slug exactly as task_get returned it (null only when task_get had none)."));
  // 6.2.0 review L2: one exact call format for the page read
  assert.ok(p.includes("record it in `tried` with call exactly `wiki_read(slug=<body_slug>, project=<project>)`"));
  // body text in the answer: no page read
  assert.match(p, /carries body text[^.]*: use it[^.]*do not call wiki_read/i);
});

test("6.2.0 body page: the intake schema accepts body_slug on a source", () => {
  assert.match(SOURCE, /const SOURCE_SCHEMA = \{[\s\S]*?body_slug: STR_OR_NULL[\s\S]*?\};/);
});

test("6.2.0 body page: a page read by wiki_read reaches the planner (fleet-brief marker included)", async () => {
  const s = happy({ brief: pageBrief(), tried: [getCall, readCall(SLUG)] });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const plan = call(out, "role:scope-and-plan").prompt;
  assert.ok(plan.includes(MARKER), "the planner sees the page body");
});

test("6.2.0 body page: body_slug with no recorded wiki_read stops with the reason code before the planner", async () => {
  for (const tried of [[getCall], [getCall, readCall("other_task-1")], [getCall, readCall(SLUG, "page not found")], [getCall, readCall(SLUG + "x")]]) {
    const out = await runOne(happy({ brief: pageBrief(), tried }), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(tried));
    assert.ok(out.result.reason.includes(CODE), out.result.reason);
    assert.ok(!out.labels.includes("role:scope-and-plan"));
    assert.ok(!out.labels.some((l) => /^infra:workspace/.test(l)), "nothing set up");
  }
});

// 6.2.0 review L1: an empty page is the agent's stop (its body also holds the title and status, so
// the script cannot see an empty page); the script relays the code
test("6.2.0 body page: intake's empty-page stop keeps the reason code", async () => {
  const s = happy();
  s.intake = { status: "needs_human", reason: CODE + ": " + SLUG + ": the page is empty", tried: [getCall, readCall(SLUG)] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(out.result.reason.startsWith("intake: " + CODE + ": "), out.result.reason);
  assert.ok(!out.labels.includes("role:scope-and-plan"));
});

// 6.2.0 review L2: the read counts only in the exact format the prompt names, at the start of the call
test("6.2.0 body page: a page read recorded in another format, negated, or for another project does not count", async () => {
  for (const c of [
    "wiki_read(project=o/r, slug=" + SLUG + ")",
    "mcp__yadgar__wiki_read({\"slug\": \"" + SLUG + "\"})",
    "wiki_read(slug: \"" + SLUG + "\")",
    "did NOT wiki_read(slug=" + SLUG + ", project=o/r)",
    "wiki_read(slug=" + SLUG + ", project=other/p)",
    "wiki_read(slug=" + SLUG + ", project=o/r) failed",
  ]) {
    const out = await runOne(happy({ brief: pageBrief(), tried: [getCall, { ledger: "yadgar", project: "o/r", call: c, error: null }] }), ARGS);
    assert.equal(out.result.status, "needs_human", c);
    assert.ok(out.result.reason.includes(CODE), out.result.reason);
    assert.ok(!out.labels.includes("role:scope-and-plan"), c);
  }
  // the read's own project must be args.project, and named
  for (const t of [
    { ledger: "yadgar", project: "other/p", call: "wiki_read(slug=" + SLUG + ", project=other/p)", error: null },
    { ledger: "yadgar", project: null, call: "wiki_read(slug=" + SLUG + ", project=null)", error: null },
  ]) {
    const out = await runOne(happy({ brief: pageBrief(), tried: [getCall, t] }), ARGS);
    assert.equal(out.result.status, "needs_human", JSON.stringify(t));
    assert.ok(out.result.reason.includes(CODE), out.result.reason);
  }
});

test("6.2.0 body page: with no args.project the read must still name a project", async () => {
  const noProj = { ...ARGS };
  delete noProj.project;
  const ok = await runOne(happy({ brief: pageBrief(), tried: [getCall, readCall(SLUG)] }), noProj);
  assert.equal(ok.result.status, "awaiting_confirmation", ok.result.reason);
  for (const project of [null, ""]) {
    const t = { ledger: "yadgar", project, call: "wiki_read(slug=" + SLUG + ", project=" + project + ")", error: null };
    const out = await runOne(happy({ brief: pageBrief(), tried: [getCall, t] }), noProj);
    assert.equal(out.result.status, "needs_human", JSON.stringify(t));
    assert.ok(out.result.reason.includes(CODE), out.result.reason);
  }
});

// 6.2.0 review M1: the script cannot see a body_slug the agent dropped; the prompt rule is the guard,
// and the prompt pins (v5010) catch a regression in it
test("6.2.0 body page: an intake that omits body_slug is not caught by the script (the prompt rule is the guard)", async () => {
  const src = { kind: "ledger", ref: "42", url: null, body: "Add Thing! (open)" };
  const out = await runOne(happy({ brief: { ...BRIEF, sources: [src] }, tried: [getCall] }), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(call(out, "intake").prompt.includes("A kind ledger source MUST carry body_slug exactly as task_get returned it"));
});

test("6.2.0 body page: a body_slug that is not a slug stops, even with a matching read", async () => {
  for (const slug of ["", "../o_r_task-42", "a/b"]) {
    const out = await runOne(happy({ brief: pageBrief({ body_slug: slug }), tried: [getCall, readCall(slug)] }), ARGS);
    assert.equal(out.result.status, "needs_human", slug);
    assert.ok(out.result.reason.includes(CODE), out.result.reason);
  }
});

test("6.2.0 body page: intake's own missing-page stop keeps the reason code", async () => {
  const s = happy();
  s.intake = { status: "needs_human", reason: CODE + ": " + SLUG + ": page not found", tried: [getCall, readCall(SLUG, "page not found")] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(out.result.reason.startsWith("intake: " + CODE + ": "), out.result.reason);
  assert.ok(!out.labels.includes("role:scope-and-plan"));
});

test("6.2.0 body page: a task whose answer carries the body (no body_slug) needs no wiki_read", async () => {
  const out = await runOne(happy({ tried: [getCall] }), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  // body_slug null is the same
  const out2 = await runOne(happy({ brief: { ...BRIEF, sources: [{ ...BRIEF.sources[0], body_slug: null }] }, tried: [getCall] }), ARGS);
  assert.equal(out2.result.status, "awaiting_confirmation", out2.result.reason);
});

test("6.2.0 body page: the sealed brief carries no body_slug (the plan ref shape is unchanged)", async () => {
  const out = await runOne(happy({ brief: pageBrief(), tried: [getCall, readCall(SLUG)] }), ARGS);
  const src = inputsOf(call(out, "role:scope-and-plan").prompt);
  assert.ok(!JSON.stringify(src).includes('"body_slug"'), "body_slug is intake data only");
});

// the build's re-read for current rulings (confirm auto) uses the same gate
function autoHappy(over = {}) {
  const s = happy(over);
  return Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
}

test("6.2.0 body page: the rulings re-read stops on a body_slug with no wiki_read", async () => {
  const s = autoHappy();
  const plan = await runOne(s, ARGS);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["intake:rulings"] = { status: "ok", reason: "re-read", brief: pageBrief(), tried: [getCall] };
  const build = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r", confirm: "auto" });
  assert.equal(build.result.status, "needs_human");
  assert.ok(build.result.reason.includes(CODE), build.result.reason);
  assert.ok(!build.labels.some((l) => /^role:fleet-test-writer/.test(l)));
});
