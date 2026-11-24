// fleet 7.4.0 car 6: role text (one role edit per file, one ROLE_SHA256 move).
// - X1 (#26, L2054): plan-audit writes a two-sentence paraphrase of the brief's outcome before it
//   reads the plan, compares after the audit; a gap is a routed advisory finding that never
//   changes the verdict.
// - X2 (#45, L2179): a Non-goal covers a brief requirement only when the brief itself puts it out
//   of scope or an Open decision cites the brief line (plan-audit: else plan_defect); the planner
//   puts every narrowing of the brief in Open decisions with the brief line, never in Non-goals
//   alone.
// - X3 (#46, L2180): plan-audit traces each criterion example through the same loader, schema or
//   validator its test will use; an example that path rejects or changes is untestable_criteria.
//   A test writer that cannot reach an example stops needs_human naming the criterion.
// - #60 step 3: the sweep role has a plan mode (no head copy; the shipped gate at base_ref is
//   measured against the plan doc); the planner may set touches_gate.
// - #61: the coder returns needs_human with test_conflict on a wrong-looking frozen test; a
//   pr-review finding whose fix contradicts a frozen test or criterion has target "plan".
//
// dont_care: the wording around each pinned phrase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_TEXT, SOURCE } from "./harness.mjs";

const PA = ROLE_TEXT["plan-audit"];
const SP = ROLE_TEXT["scope-and-plan"];

test("7.4.0 #26 X1: plan-audit holds the paraphrase-first rule, and it never changes the verdict", () => {
  assert.match(PA, /two-sentence paraphrase of the brief's outcome/);
  assert.match(PA, /before you read the plan/i);
  assert.match(PA, /`advisory: paraphrase gap`/);
  assert.match(PA, /paraphrase[^\n]*never changes the verdict/);
});

test("7.4.0 #45 X2: plan-audit and scope-and-plan hold the narrowing rule", () => {
  for (const [name, t] of [["plan-audit", PA], ["scope-and-plan", SP]]) assert.match(t, /an Open decision cites the brief line/, name);
  assert.match(PA, /A Non-goal covers a brief requirement only when the brief itself puts it out of scope, or an Open decision cites the brief line/);
  assert.match(SP, /Any narrowing of the brief goes in Open decisions with the brief line, never in Non-goals alone/);
});

test("7.4.0 #46 X3: plan-audit traces examples through the test's loader; the writer stops on an unreachable example", () => {
  assert.match(PA, /same loader, schema or validator its test will use/);
  assert.match(PA, /rejects or changes[^\n]*`untestable_criteria`/);
  const tw = ROLE_TEXT["fleet-test-writer"];
  assert.match(tw, /cannot reach an example/);
  assert.match(tw, /`needs_human` naming the criterion/);
  assert.match(tw, /never work around it/);
});

test("7.4.0 #60: the sweep role has a plan mode; the planner may set touches_gate", () => {
  const sw = ROLE_TEXT["gate-change-nonweakening-sweep"];
  assert.match(sw, /## Plan mode/);
  assert.match(sw, /`mode: "plan"`/);
  assert.match(sw, /no head copy/i);
  assert.match(sw, /criterion example/);
  assert.match(SP, /`touches_gate`/);
  assert.match(SOURCE, /touches_gate: BOOL\b/);
});

test("7.4.0 #61: the coder names a test conflict; pr-review can target the plan", () => {
  const cd = ROLE_TEXT["fleet-coder"];
  assert.match(cd, /`test_conflict`/);
  assert.match(cd, /\{test, findings, why\}/);
  const pr = ROLE_TEXT["pr-review"];
  assert.match(pr, /`target: "plan"`/);
  assert.match(pr, /contradicts a frozen test or criterion/);
});
