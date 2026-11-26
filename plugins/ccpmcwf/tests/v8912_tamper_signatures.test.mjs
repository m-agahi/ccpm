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
const step9 = /\n9\. \*\*Dodges\.\*\*[^\n]*/.exec(role)[0];

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

test("8.9.12 (#120): the signatures are advisory: memory_notes with the hunk, never routed without evidence", () => {
  assert.ok(step9.includes("Each is a `code` finding only with evidence that it changes a test, coverage or mutation verdict."), "the 8.3.4 evidence rule stays");
  assert.ok(step9.includes("The same evidence rule applies. A signature of either list without that evidence goes in `memory_notes`, never in `routed_findings`"));
  assert.ok(step9.includes("`tamper signature (advisory): <path> <the hunk's @@ header, or \"added path\"> — <the signature>`"), "the note points at the hunk");
  assert.ok(step9.includes("with no \"(observed at …)\" tag"), "the note is not offered as a memory");
  assert.ok(step9.includes("These flags never relax checks 1 and 7"), "the scope fence and the frozen inputs stay defects");
});
