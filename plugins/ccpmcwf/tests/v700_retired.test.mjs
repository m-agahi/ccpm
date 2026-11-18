// fleet 7.0.0 AC5 (yaadgaar #699): the yadgar ledger machinery is gone from the
// source and the shipped dist, and the ledger-writer agent is deleted.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SOURCE, DIST, HERE } from "./harness.mjs";

const BANNED = [
  "mcp__yadgar__task_get",
  "mcp__yadgar__task_write",
  "mcp__yadgar__wiki_read",
  "mcp__yadgar__wiki_add",
  "mcp__yadgar__wiki_append_section",
  "infra:ledger-read",
  "infra:ledger-writeback",
  "infra:ledger-body",
  "fleet:ledger-writer",
  "ccpmcwf:ledger-writer",
];
const CONSTANTS = ["TASK_DATA", "TITLE_MAX", "WRITER_AGENT", "BODY_PAGE_REASON"];

test("7.0.0 AC5: no retired yadgar ledger string or constant in src or dist", () => {
  for (const [name, text] of [["src", SOURCE], ["dist", DIST]]) {
    for (const b of BANNED) assert.ok(text.indexOf(b) < 0, name + " still holds " + b);
    for (const c of CONSTANTS) assert.doesNotMatch(text, new RegExp("\\b" + c + "\\b"), name + " still holds " + c);
    // the bare INFRA_TIER prefix stays
    assert.ok(text.indexOf('["infra:ledger-", "sonnet"]') >= 0, name + ": INFRA_TIER row");
  }
});

test("7.0.0 AC5: agents/ledger-writer.md is deleted", () => {
  assert.equal(existsSync(join(HERE, "..", "agents", "ledger-writer.md")), false);
  assert.equal(existsSync(join(HERE, "..", "agents", "judge.md")), true);
});
