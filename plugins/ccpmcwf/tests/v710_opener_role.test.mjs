// fleet 7.1.0 (L2145, yaadgaar #37), AC6: the pr-opener role file forbids test
// counts in the opener's own text, names the script block's markers, and
// tells a retry to remove the counts.
//
// Expected values come only from the plan's AC6 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROLE = join(dirname(fileURLToPath(import.meta.url)), "..", "roles", "fleet-pr-opener.md");
const lines = () => readFileSync(ROLE, "utf8").split("\n");
const lineStarting = (p) => {
  const hit = lines().filter((l) => l.startsWith(p));
  assert.equal(hit.length, 1, "one line starts with " + p);
  return hit[0];
};

test("AC6 ex1: exactly one '- **No test counts:**' line with the rule and both markers", () => {
  const l = lineStarting("- **No test counts:**");
  for (const part of ["write no number of tests, passed, failed or errors anywhere in the body", "`<!-- ccpm-fleet-tests -->`", "`<!-- /ccpm-fleet-tests -->`", "never write, copy or edit that block"]) assert.ok(l.includes(part), part);
});

test("AC6 ex2: the No template list names the test command and the workflow-added counts", () => {
  const l = lineStarting("- **No template:**");
  assert.ok(l.includes("Test evidence (the test command; the workflow adds the measured counts)"), l);
  assert.ok(!l.includes("Test evidence (suite command + result)"), l);
});

test("AC6 ex3: the retry_reason input tells a retry to remove every test count", () => {
  const l = lineStarting("- `retry_reason`");
  assert.ok(l.includes("It can also name test counts outside the script-written test block: remove every test count from your text."), l);
});
