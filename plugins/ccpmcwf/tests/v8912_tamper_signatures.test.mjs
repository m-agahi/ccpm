// ccpmcwf 8.9.12 (yaadgaar #120): the code judge's step 9 "Dodges" lists coverage-tool tamper
// signatures (ADR-1427: the coverage gate is honest-coder-only; on the uv tier the judged tree's
// uv.lock and pyproject decide which coverage runs). The list is advisory: a signature is a code
// finding only with evidence that it changes a verdict; otherwise it goes in memory_notes, never in
// routed_findings, pointing at the diff hunk. This is a role-text change with no script behaviour:
// the test is a text pin that fails if the list or its advisory rule is deleted or hardened.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const role = readFileSync(join(HERE, "..", "roles", "fleet-code-judge.md"), "utf8");
// 8.9.17 (#133): step 9 has an indented continuation line (the advisories), read with it
const step9 = /\n9\. \*\*Dodges\.\*\*[^\n]*(?:\n {3}[^\n]*)*/.exec(role)[0];

test("8.9.12 (#120): step 9 names every coverage-tool tamper signature", () => {
  for (const k of [
    "Coverage-tool tamper (advisory, 8.9.12)",
    "`uv.lock`",
    "`coverage`",
    "`[tool.uv.sources]`",
    "a `tool.uv.index` table",
    "`index-url`",
    "`extra-index-url`",
    "`[project.scripts]`",
    "`[project.entry-points]`",
    "`.pth`",
    "`sitecustomize`",
    "`usercustomize`",
    "`*.pth`",
    "`.venv`",
    "`pyvenv.cfg`",
  ]) assert.ok(step9.includes(k), "step 9 names " + k);
  // the whole change, tests included, not only the production diff
  assert.ok(step9.includes("in the whole change (`git diff <plan_commit> <code_tree>`, tests included)"));
});

// 8.9.17 (#133): changed on purpose: the destination moved from a memory_notes line to the
// advisories schema field (one {path, hunk, signature} entry per hit, an id from a fixed enum),
// so the PR shows the flags; the evidence rule and the "never routed" rule are unchanged
test("8.9.12 (#120): the signatures are advisory: advisories with the hunk, never routed without evidence", () => {
  assert.ok(step9.includes("Each is a `code` finding only with evidence that it changes a test, coverage or mutation verdict."), "the 8.3.4 evidence rule stays");
  assert.ok(step9.includes("The same evidence rule applies."));
  assert.ok(step9.includes("A signature of either list without that evidence goes in `advisories`, never in `routed_findings` or `memory_notes`"));
  assert.ok(step9.includes("`hunk` is the hunk's `@@ -a,b +c,d @@` header (the workflow drops any text after it), or `added path`"), "the entry points at the hunk");
  assert.ok(!step9.includes("tamper signature (advisory):"), "no memory_notes line any more");
  assert.ok(step9.includes("These flags never relax checks 1 and 7"), "the scope fence and the frozen inputs stay defects");
});
