// fleet 7.3.0 (#65, #60 steps 1-2, #33 leftovers) A24, A25: role text rules.
// #65: a bookkeeping plan_diff entry is not an intent deviation; G1 still refuses an
// approved deviation with an empty allowed_by. A re-plan round's plan_diff stays relative
// to the ingested plan. #60: plan-audit builds a shipped-vs-planned table for a gate change;
// the planner makes a gate-boundary example an Open decision. #33: the PR opens ready, so no
// role, README or skill text says the fleet opens a draft PR.
//
// dont_care: the wording around the pinned sentences; the order of the rules in a section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_TEXT, HERE, happy, run, ARGS, PB } from "./harness.mjs";

const one = (s) => s.replace(/\s+/g, " ");

test("7.3.0 #65 A24: the intent judge leaves bookkeeping plan_diff items out; a repo rule is never an allowance", () => {
  const t = one(ROLE_TEXT["fleet-intent-judge"]);
  // review fix M3: only est_diff_lines and verified process items are bookkeeping, filed in bookkept
  assert.match(t, /A `plan_diff` entry that only changes `est_diff_lines`, or only restates a process item you verified \(see above\), is bookkeeping: put it, copied character for character, in `bookkept`, not in `deviations`\./);
  assert.match(t, /An approved deviation always has a non-empty verbatim `allowed_by`\. A repo rule is never an allowance\./);
});

test("7.3.0 #65 A24: scope-and-plan and plan-audit keep a re-plan round's plan_diff relative to the ingested plan", () => {
  for (const r of ["scope-and-plan", "plan-audit"]) {
    const t = one(ROLE_TEXT[r]);
    assert.match(t, /In a re-plan round, `plan_diff` stays relative to the ingested plan \(or `"new plan"` plus the intended narrowings against the brief\)\. It never lists round-to-round changes\./, r);
  }
});

test("7.3.0 #65 A24: G1 still refuses an approved deviation whose allowed_by is empty", async () => {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "bumps est_diff_lines", allowed_by: "", source_ref: "", fails_closed: true, verdict: "approve", reason: "bookkeeping" }],
      coverage: { covered: true, missing: [] },
      classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task text" },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  });
  const out = await run(s, { ...ARGS, confirm: "auto" });
  const r = out.plan.result;
  assert.notEqual(r.status, "ok");
  assert.match(JSON.stringify(r), /has no allowed_by/);
});

test("7.3.0 #60 A25: plan-audit builds a shipped-vs-planned table for a gate change; scope-and-plan makes a gate boundary an Open decision", () => {
  const a = one(ROLE_TEXT["plan-audit"]);
  assert.match(a, /When the plan changes a gate, validator or exemption, build a shipped-vs-planned table\. Its rows are the criteria examples plus 2-3 known-bad inputs\./);
  assert.match(a, /A row where the shipped gate refuses, the planned gate accepts, and no Open decision cites the brief → `plan_defect`\./);
  const p = one(ROLE_TEXT["scope-and-plan"]);
  assert.match(p, /A boundary example that makes a gate accept an input the shipped gate refuses must be an Open decision\./);
});

test("7.3.0 #33 leftover: no role, README, skill or plugin text says the fleet opens a draft PR", () => {
  const root = join(HERE, "..", "..", "..");
  const files = [
    "plugins/fleet/roles/pr-review.md",
    "plugins/fleet/docs/build-task-run-notes.md",
    "plugins/fleet/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "README.md",
    "plugins/fleet/src/build-task-run.js",
  ];
  for (const f of files) {
    const t = readFileSync(join(root, f), "utf8");
    assert.ok(!/own draft PR|opens a draft PR|PRs stay draft|code judge, draft PR|push, draft PR|draft PR at the pushed/.test(t), f);
  }
});
