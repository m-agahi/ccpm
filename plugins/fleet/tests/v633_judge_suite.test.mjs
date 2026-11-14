// fleet 6.3.3 (ledger 2144), AC8 (fix (b)): the declared schemas, before the
// STRICT null-widening. The fleet-code-judge suite_result is JUDGE_SUITE, whose
// exit_code, failed and errors are each typed ["integer", "null"]; the
// fleet-coder suite_result stays {type: "object"} and is a different object.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE } from "./harness.mjs";

// the constants section, loaded as v403_schema_types.test.mjs loads it
function load() {
  const a = SOURCE.indexOf("// ---------------------------------------------------------------- constants");
  const b = SOURCE.indexOf("// ---------------------------------------------------------------- pure helpers");
  assert.ok(a >= 0 && b > a, "the constants section");
  return new Function(SOURCE.slice(a, b) + "\nreturn { SCHEMAS, STRICT };")();
}
const { SCHEMAS, STRICT } = load();
const INT_OR_NULL = { type: ["integer", "null"] };

test("AC8 ex1: the code judge's declared suite_result is typed", () => {
  assert.deepEqual(STRICT["fleet-code-judge"].suite_result, { type: "object", properties: { exit_code: INT_OR_NULL, failed: INT_OR_NULL, errors: INT_OR_NULL } });
});

test("AC8 ex2: the coder's declared suite_result stays untyped and is a different object", () => {
  assert.deepEqual(STRICT["fleet-coder"].suite_result, { type: "object" });
  assert.notEqual(STRICT["fleet-coder"].suite_result, STRICT["fleet-code-judge"].suite_result);
});

test("AC8 ex3: exit_code is integer or null, never string or number", () => {
  const t = STRICT["fleet-code-judge"].suite_result.properties.exit_code.type;
  assert.deepEqual(t, ["integer", "null"]);
  assert.ok(!t.includes("string"));
  assert.ok(!t.includes("number"));
});

test("AC8 ex4: the widened SCHEMAS copy keeps the typed properties", () => {
  assert.deepEqual(SCHEMAS["fleet-code-judge"].properties.suite_result.properties, { exit_code: INT_OR_NULL, failed: INT_OR_NULL, errors: INT_OR_NULL });
});
