// fleet 5.0.7 (ledger 2027): run wf_5cc06208-e0b stopped at test-judge check 4.
// The plan mixed new-behaviour examples with refusal or guard examples that
// already pass on the current code (unknown id, soft-deleted record, expired
// token) in criteria with guards_existing=false, and the test judge refuses a
// GREEN test unless guards_existing is true. The planner now splits them; the
// plan audit refuses a mixed criterion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS_SRC, SOURCE } from "./harness.mjs";

const role = (n) => readFileSync(join(SCRIPTS_SRC, "..", "roles", n + ".md"), "utf8");

test("5.0.7 2027: scope-and-plan puts examples that already hold in their own guards_existing=true criterion", () => {
  const t = role("scope-and-plan");
  assert.ok(
    t.includes(
      "An example that already holds on the current code (a refusal, a not-found or unknown id, a soft-deleted record, an expiry such as an expired token, and similar) goes in its OWN criterion with `guards_existing: true` and a `spec_quote`.",
    ),
  );
  assert.ok(t.includes("Never mix it with examples that must go RED: every example of a `guards_existing: false` criterion must fail on the current code"));
});

test("5.0.7 2027: plan-audit refuses a guards_existing=false criterion with an example the code already satisfies", () => {
  const t = role("plan-audit");
  assert.ok(t.includes("no example of a `guards_existing: false` criterion that the current code already satisfies. Verify each example against the code"));
  assert.ok(t.includes('routed finding "split guard examples into a guards_existing=true criterion"'));
  const line = t.split("\n").find((l) => l.includes("split guard examples into a guards_existing=true criterion"));
  assert.match(line, /the verdict is `untestable_criteria`/);
  // the verdict exists and is a refusal the workflow routes back to the planner
  assert.match(SOURCE, /"plan-audit": \["approve", "untestable_criteria", "plan_defect"\]/);
  assert.match(SOURCE, /audit\.verdict === "plan_defect" \|\| audit\.verdict === "untestable_criteria"/);
});

test("5.0.7 2027: the test judge's check 4 is the rule both texts state", () => {
  assert.ok(role("fleet-test-judge").includes("A test that already PASSES is a finding unless `guards_existing` is true."));
});
