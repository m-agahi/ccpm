// fleet 6.3.3 (ledger 2144), AC6: the pr-opener role file documents the
// optional input body_findings and lists it as a source.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./harness.mjs";

const lines = readFileSync(join(HERE, "..", "roles", "fleet-pr-opener.md"), "utf8").split("\n");

test("AC6 ex1: one input line for body_findings, marked optional", () => {
  const l = lines.filter((x) => x.startsWith("- `body_findings`"));
  assert.equal(l.length, 1);
  assert.ok(l[0].includes("optional"), l[0]);
});

test("AC6 ex2: the Sources rule lists body_findings", () => {
  const l = lines.filter((x) => x.startsWith("- **Sources:**"));
  assert.equal(l.length, 1);
  assert.ok(l[0].includes("`body_findings`"), l[0]);
});
