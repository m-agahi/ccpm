// fleet 7.3.0 review fix (M3, #65 backstop): the intent judge files each plan_diff entry
// (except "new plan"), copied exactly, as a deviation item or in bookkept; the script refuses
// the plan when an entry is in neither (fail closed: a missing bookkept counts as []). Only an
// est_diff_lines change and a verified process item are bookkeeping; a changed_symbols addition
// and a test-example change that flips an accept/refuse outcome are deviations.
//
// dont_care: the order of the intent-gate reasons.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_TEXT, PB, happy, runOne, ARGS } from "./harness.mjs";

const DIFF = ["est_diff_lines 80 -> 120", "adds f()", "changed_symbols adds g"];
function auto(judge) {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { plan_diff: DIFF.slice() });
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": Object.assign(
      {
        status: "ok",
        reason: "matches the task",
        verdict: "approve",
        deviations: [
          { item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" },
          { item: "changed_symbols adds g", allowed_by: "task body: 'and g'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" },
        ],
        coverage: { covered: true, missing: [] },
        classification: { change_kind: "approve", new_behaviour: "approve", quote: "add f" },
      },
      judge,
    ),
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  });
  return s;
}
const gateLine = (out) => out.logs.find((l) => /^auto-confirm: intent/.test(l)) || "";

test("7.3.0 review M3: every plan_diff entry in a deviation or bookkept passes the intent check", async () => {
  const out = await runOne(auto({ bookkept: ["est_diff_lines 80 -> 120"] }), { ...ARGS, confirm: "auto" });
  assert.match(gateLine(out), /^auto-confirm: intent approve/, out.logs.join("\n"));
});

test("7.3.0 review M3: a plan_diff entry in neither refuses the plan; a missing bookkept counts as []", async () => {
  for (const judge of [{ bookkept: [] }, {}, { bookkept: ["est_diff_lines 80 -> 121"] }]) {
    const out = await runOne(auto(judge), { ...ARGS, confirm: "auto" });
    assert.match(gateLine(out), /intent check failed: .*plan_diff entry "est_diff_lines 80 -> 120" is neither a deviation nor bookkept/, JSON.stringify(judge) + "\n" + out.logs.join("\n"));
  }
  // a bookkept entry does not cover a changed_symbols addition the deviations drop
  const out = await runOne(auto({ bookkept: ["est_diff_lines 80 -> 120"], deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }] }), { ...ARGS, confirm: "auto" });
  assert.match(gateLine(out), /plan_diff entry "changed_symbols adds g" is neither/);
});

test("7.3.0 review M3: the role keeps only est_diff_lines and verified process items as bookkeeping", () => {
  const t = ROLE_TEXT["fleet-intent-judge"];
  assert.ok(!/changed_symbols` update/.test(t), "a changed_symbols update is no longer bookkeeping");
  assert.ok(!/test-example refinement/.test(t), "a test-example refinement is no longer bookkeeping");
  assert.match(t, /`bookkept`/);
  assert.match(t, /changed_symbols` addition/);
  assert.match(t, /flips an accept or refuse outcome/);
});
