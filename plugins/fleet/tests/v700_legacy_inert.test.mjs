// fleet 7.0.0 AC3 (yaadgaar #699): the yadgar ledger is retired. Intake never
// produces a `ledger` source any more; one that a sealed plan ref (or the test
// harness default) still carries is accepted outside yadgarhq/ but never read
// or written: no infra:ledger-* step, one write-back entry `unavailable` with
// the section text to paste into the migrated yaadgaar task, and no re-read
// for rulings under confirm auto.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, PB, FP_PLAN, happy, run, runOne, inputsOf, call, noUnscripted } from "./harness.mjs";

const LEDGER_STEP = /^infra:ledger-/;
const GH = { kind: "github", ref: "o/r#5", url: "https://github.com/o/r/issues/5", body: "issue" };

test("7.0.0 AC3: a legacy ledger source builds with no ledger step; its entry is unavailable and carries the section", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => LEDGER_STEP.test(l)), out.labels.join(", "));
  assert.equal(out.result.write_back.ledger.length, 1);
  const e = out.result.write_back.ledger[0];
  assert.equal(e.ref, "42");
  assert.equal(e.status, "unavailable");
  assert.match(e.reason, /yadgar ledger is retired/);
  assert.match(e.section_text, /<!-- fleet:l42 -->/);
  assert.equal(out.result.ledger_status, "unavailable");
  assert.equal(out.result.ledger_adapter, "none");
  assert.match(out.result.ledger_reason, /yadgar ledger is retired/);
  assert.doesNotMatch(out.result.ledger_reason, /ledger tool absent/);
});

test("7.0.0 AC3: a legacy ledger source beside a tracker source keeps the tracker adapter", async () => {
  const listing = (p) => ({ status: "ok", reason: "listed", results: inputsOf(p).sources.map((x) => ({ key: x.key, status: "ok", has_marker: false })) });
  const posting = (p) => ({ status: "ok", reason: "posted", results: inputsOf(p).posts.map((x) => ({ key: x.key, status: "posted", url: "u" })) });
  const s = happy({ brief: { ...BRIEF, sources: BRIEF.sources.concat([GH]) }, script: { "infra:comments-list": listing, "infra:comments-post": posting } });
  Object.assign(s, { "infra:comments-list": listing, "infra:comments-post": posting });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.some((l) => LEDGER_STEP.test(l)), out.labels.join(", "));
  assert.equal(out.result.ledger_adapter, "tracker");
  assert.match(out.result.ledger_reason, /yadgar ledger is retired/);
  assert.doesNotMatch(out.result.ledger_reason, /ledger tool absent/);
  assert.equal(out.result.write_back.ledger[0].status, "unavailable");
});

test("7.0.0 AC3: confirm auto does not re-read a legacy ledger source; the intent judge gets no ledger task", async () => {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  const plan = await runOne(s, { ...ARGS, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
  s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r", confirm: "auto" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.labels.includes("intake:rulings"), out.labels.join(", "));
  const j = inputsOf(call(out, "role:fleet-intent-judge:rerun").prompt);
  assert.equal(j.ledger_task, null);
  // the sealed source bodies still reach the judge
  assert.equal(j.brief.sources[0].body, "task body");
  assert.ok(!out.labels.some((l) => LEDGER_STEP.test(l)), out.labels.join(", "));
});
