// fleet 7.3.0 (#50, L2183) A15: the code-judge guard counts any non-null,
// non-0 failed or errors as a failing suite (a string "2" no longer passes),
// and driftOf checks the typed nested properties of a required object one
// level down, so suite_result.failed "2" is contract drift (retried once).
//
// dont_care: the guard's gate line wording.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run } from "./harness.mjs";

const TAGF = { target: "code", criterion: null, finding: "review R1 [pr_body_claim] PR body: body says 147 passed; the suite gives 133 (evidence: npm test: 133 pass)" };
const judge = (suite) => ({ status: "ok", reason: "good", verdict: "fix_code", routed_findings: [TAGF], hash_check: { match: true, mismatched: [] }, suite_result: suite });

test("7.3.0 A15: suite_result.failed \"2\" is contract drift, retried once; the verdict never becomes approve", async () => {
  const bad = judge({ command: "pytest", exit_code: 0, failed: "2", errors: 0 });
  const F = happy({ script: { "role:fleet-code-judge:r1": bad, "role:fleet-code-judge:r1:retry": bad } });
  const out = await run(F, ARGS);
  const logs = out.build.logs;
  assert.ok(logs.includes("fleet-code-judge: contract drift (suite_result.failed type: got string); retried once"), logs.join("\n"));
  assert.notEqual(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.stop_gate, "contract", out.result.reason);
  assert.ok(!out.labels.includes("infra:commit:r1"), out.labels.join(", "));
  assert.ok(!logs.some((l) => /fix_code -> approve/.test(l)), logs.join("\n"));
});

test("7.3.0 A15: failed 0 and errors null pass; the guard converts to approve, as before", async () => {
  const F = happy({ script: { "role:fleet-code-judge:r1": judge({ command: "pytest", exit_code: 0, failed: 0, errors: null }) } });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.logs.some((l) => /fix_code -> approve \(suite passed\)/.test(l)), out.build.logs.join("\n"));
});

test("7.3.0 A15: the guard formula counts a non-0 value of any type as failing", async () => {
  const { SOURCE } = await import("./harness.mjs");
  const i = SOURCE.indexOf("const failing = ");
  assert.ok(i >= 0);
  const expr = SOURCE.slice(i + "const failing = ".length, SOURCE.indexOf(";\n", i));
  const failing = new Function("sr", "return " + expr + ";");
  for (const sr of [{ exit_code: 0, failed: "2", errors: 0 }, { exit_code: 0, failed: 0, errors: "1" }, { exit_code: 0, failed: 2 }, { exit_code: "0" }, { exit_code: 1 }]) assert.equal(failing(sr), true, JSON.stringify(sr));
  for (const sr of [{ exit_code: 0 }, { exit_code: 0, failed: 0, errors: 0 }, { exit_code: 0, failed: null, errors: null }]) assert.equal(failing(sr), false, JSON.stringify(sr));
});
