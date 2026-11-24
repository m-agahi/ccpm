// fleet 7.4.0 car 3: README facts.
// - D1 (#4, L1995): the Role contract's stop_gate list names every STOP_GATES entry, in src order.
// - D2 (#28, L2056): eleven role prompts; the list names fleet-ci-classifier.
// - D3 (#17 Max ruling Q7 "keep strict and document"; #18 L2024): the Known limits name the Node
//   build leftovers and the one-run-per-worktree limit.
// - D4 (#69, Max ruling Q11 "decline the HMAC"): the Threat model names forged sealed plan refs
//   as not defended (self-hashed; any role with a shell; ADR-1152; the kind:ref check only stops
//   accidental cross-task adoption).
//
// dont_care: line wrapping (the text is matched with whitespace runs folded to one space).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, SOURCE, ROLE_NAMES } from "./harness.mjs";

const README = readFileSync(join(HERE, "..", "README.md"), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const FLAT = flat(README);
const STOP_GATES = JSON.parse(/const STOP_GATES = (\[[^\]]*\]);/.exec(SOURCE)[1]);
// a level-3 section's text, up to the next level-2 or level-3 heading
function section(title) {
  const i = README.indexOf("\n### " + title + "\n");
  assert.ok(i >= 0, "no section " + title);
  const rest = README.slice(i + 1);
  const m = /\n##{1,2} /.exec(rest.slice(4));
  return rest.slice(0, m ? m.index + 4 : rest.length);
}

test("7.4.0 #4 D1: the README stop_gate list names every STOP_GATES entry, in src order", () => {
  // 8.5.5 (#108 step 2): + plan, push, refs
  assert.equal(STOP_GATES.length, 30);
  const t = flat(section("Role contract"));
  const i = t.indexOf("The result's `stop_gate` names the gate:");
  assert.ok(i >= 0, "the stop_gate sentence");
  const list = t.slice(i, t.indexOf("(`null`", i));
  const named = [...list.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((x) => x !== "stop_gate");
  assert.deepEqual(named, STOP_GATES);
});

// 8.0.0 (G4): twelve, with fleet-held-out-runner
test("7.4.0 #28 D2: README says twelve role prompts (8.0.0 G4) and names fleet-ci-classifier", () => {
  assert.equal(ROLE_NAMES.length, 12);
  assert.ok(FLAT.includes("twelve role prompts"));
  assert.ok(!/\beleven role prompts\b/.test(FLAT), "a stale 'eleven role prompts'");
  assert.ok(!/\bten role prompts\b/.test(FLAT), "a stale 'ten role prompts'");
  const req = flat(README.slice(README.indexOf("## Requirements"), README.indexOf("\n## ", README.indexOf("## Requirements") + 5)));
  for (const r of ROLE_NAMES) assert.ok(req.includes("`" + r + "`"), r + " not in the Requirements role list");
});

test("7.4.0 #17 #18 D3: the Known limits name the Node build leftovers and one run per worktree", () => {
  const t = flat(section("Known limits"));
  for (const x of ["`.next/`", "`tsconfig.tsbuildinfo`", "coverage", "`.eslintcache`"]) assert.ok(t.includes(x), x);
  assert.match(t, /stop the hash check/);
  assert.match(t, /one fleet run per worktree at a time/i);
  assert.match(t, /deletes the first run's build dirs/);
});

test("7.4.0 #69 D4: the Threat model names forged sealed plan refs as not defended", () => {
  const t = section("Threat model");
  const nd = flat(t.slice(t.indexOf("Not defended:")));
  assert.match(nd, /sealed plan ref/);
  assert.match(nd, /self-hashed/);
  assert.match(nd, /any role with a shell can forge/);
  assert.match(nd, /ADR-1152/);
  assert.match(nd, /`kind:ref` check/);
  assert.match(nd, /accidental/);
});
