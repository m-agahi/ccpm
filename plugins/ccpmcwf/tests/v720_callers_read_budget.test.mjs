// fleet 7.2.0 (L2178, yaadgaar #44) AC11: at most CALLER_READ_BUDGET = 4 read dispatches per
// caller check; a part that does not fit gets one budget finding per symbol.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, runOne, call, inputsOf, callersDisk, callersHash } from "./harness.mjs";

const reads = (out) => out.labels.filter((l) => l.includes(":read:"));
const findingsOf = (out) => {
  const c = call(out, "role:scope-and-plan:audit-fix");
  assert.ok(c, "no re-plan round: " + out.result.status + " " + out.result.reason);
  return inputsOf(c.prompt).prior_round.findings.map((f) => f.finding);
};
const docs = (x, n) => Array.from({ length: n }, (_, j) => "docs/" + x + "_" + String(j).padStart(3, "0") + ".md:1");
const code = (x, n) => Array.from({ length: n }, (_, j) => "src/" + x + ".py:" + (j + 1));
const dcDoc = (x) => ({ symbol: x, occurrences: [{ at: docs(x, 1)[0], criterion: null, dont_care: "a doc" }] });
const dc = (x) => ({ symbol: x, occurrences: [{ at: "src/" + x + ".py:1", criterion: null, dont_care: "x" }] });

// 8.5.3 (#111): auto (doc and lock) reads were outside the budget. 8.9.5 (yaadgaar #112): there is no auto
// read; a map that holds a doc hit is not the code set, so it takes the budgeted part-all read (6 pages here)
test("7.2.0 AC11 / 8.9.5: a map with one doc hit of 84 per symbol (6 pages of part all) is over the budget", async () => {
  const s = happy();
  const names = ["r_one", "r_two", "r_three"];
  // each symbol: 84 doc hits, all auto; the planner maps only its first one
  const data = Object.fromEntries(names.map((x) => [x, { hits: docs(x, 84), auto: docs(x, 84) }]));
  s["role:scope-and-plan"].changed_symbols = names.map(dcDoc);
  callersDisk(s, "infra:callers", data);
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), []);
  const f = findingsOf(out);
  for (const x of names)
    assert.ok(f.includes(x + ": the mapped occurrences differ from git grep -w (84 hits, 1 mapped) and the hit list is over the caller read budget (4 reads of 50 entries); map exactly the code hits (doc and lock hits are auto dont_care), or every hit"), f.join("\n"));
});

test("7.2.0 AC11: a part-all list over the budget reads nothing and gives one finding per symbol", async () => {
  const s = happy();
  const names = ["t_one", "t_two", "t_three"];
  const data = Object.fromEntries(names.map((x) => [x, { hits: code(x, 84) }]));
  s["role:scope-and-plan"].changed_symbols = names.map((x) => ({ symbol: x, occurrences: [{ at: "src/" + x + ".py:999", criterion: "AC1", dont_care: null }] }));
  callersDisk(s, "infra:callers", data);
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), []);
  const f = findingsOf(out);
  for (const x of names)
    assert.ok(f.includes(x + ": the mapped occurrences differ from git grep -w (84 hits, 1 mapped) and the hit list is over the caller read budget (4 reads of 50 entries); map exactly the code hits (doc and lock hits are auto dont_care), or every hit"), f.join("\n"));
});

// 8.9.5 (yaadgaar #112): a map with one doc hit each takes part all; 200 hits fill exactly the 4 reads and the
// doc hits the planner left are auto dont_care (no finding)
test("7.2.0 AC11 / 8.9.5: 200 hits of doc-mapped symbols fill exactly the 4 part-all reads with no budget finding", async () => {
  const s = happy();
  const names = ["u_one", "u_two"];
  const data = Object.fromEntries(names.map((x) => [x, { hits: docs(x, 100), auto: docs(x, 100) }]));
  s["role:scope-and-plan"].changed_symbols = names.map(dcDoc);
  callersDisk(s, "infra:callers", data);
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), [0, 1, 2, 3].map((k) => "infra:callers:read:all:" + k));
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

// 8.9.5 (yaadgaar #112): the code-only maps need no read, so the stale symbol's 2 pages are read from the whole budget
test("7.2.0 AC11 (A3) / 8.9.5: code-only maps take no read; a stale symbol of 56 hits is read and checked", async () => {
  const s = happy();
  const names = ["m_one", "m_two", "m_three"];
  const data = Object.fromEntries(names.map((x) => [x, { hits: ["src/" + x + ".py:1"].concat(docs(x, 34)), auto: docs(x, 34) }]));
  data.m_stale = { hits: code("m_stale", 56) };
  s["role:scope-and-plan"].changed_symbols = names.map(dc).concat([{ symbol: "m_stale", occurrences: [{ at: "src/s.py:999", criterion: "AC1", dont_care: null }] }]);
  callersDisk(s, "infra:callers", data);
  const out = await runOne(s, ARGS);
  assert.deepEqual(reads(out), [0, 1].map((k) => "infra:callers:read:all:" + k));
  const f = findingsOf(out);
  assert.ok(!f.some((y) => y.includes("over the caller read budget")), f.join("\n"));
  assert.ok(f.includes("m_stale: src/m_stale.py:1 is an occurrence (git grep -w) not mapped in changed_symbols; map it to a criterion or to dont_care with a reason"), f.join("\n"));
  assert.ok(f.includes("m_stale: src/s.py:999 is mapped but git grep -w finds no occurrence there (stale line or wrong path; cite lines at the worktree HEAD)"), f.join("\n"));
  assert.ok(callersHash(["a"]).length === 64);
});
