// fleet 7.1.0 (L2145, yaadgaar #37), AC3: the workflow builds the test block
// text from the code judge's measured suite_result (passed, failed, errors)
// and the sealed plan test_cmd, never from suite_result.command. JUDGE_SUITE
// types `passed` as integer or null.
//
// The block is base64-decoded from args[3] of the infra:pr-tests call.
// Expected values come only from the plan's AC3 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, happy, run, inputsOf } from "./harness.mjs";

const LF = String.fromCharCode(10);
const START = "<!-- ccpm-fleet-tests -->";
const END = "<!-- /ccpm-fleet-tests -->";
const NOT_REPORTED = "**Tests (measured by the fleet):** not reported (the code judge's suite run gave no counts).";
const cmdOf = (command, env = {}) => ({ command, paths_placeholder: "<paths>", env, tools: [] });

// the happy build with a plan test_cmd and a code judge suite_result (undefined: no suite_result key)
async function build(testCmd, suite) {
  const F = happy();
  F["role:scope-and-plan"] = Object.assign({}, F["role:scope-and-plan"], { test_cmd: testCmd });
  const j = Object.assign({}, F["role:fleet-code-judge:r1"]);
  if (suite === undefined) delete j.suite_result;
  else j.suite_result = suite;
  F["role:fleet-code-judge:r1"] = j;
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  return out;
}
function blockOf(out) {
  const c = out.calls.find((x) => x.label === "infra:pr-tests");
  assert.ok(c, "expected an infra:pr-tests call; got " + out.labels.join(", "));
  return Buffer.from(inputsOf(c.prompt).args[3], "base64").toString("utf8");
}
const line = (out, i) => blockOf(out).split(LF)[i];
const NPM = cmdOf("npm test -- <paths>");

test("AC3 ex1: counts from the judge, command from the plan", async () => {
  const out = await build(NPM, { command: "pytest", exit_code: 0, passed: 133, failed: 0, errors: 0 });
  assert.equal(blockOf(out), START + LF + "**Tests (measured by the fleet):** 133 passed, 0 failed, 0 errors, 133 total." + LF + "Command: `npm test`" + LF + END);
});

test("AC3 ex2: env entries prefix the command, sorted by key; <paths> dropped", async () => {
  const out = await build(cmdOf("pytest <paths> -q", { TZ: "UTC", CI: "1" }), { exit_code: 0, passed: 133, failed: 0, errors: 0 });
  assert.equal(line(out, 2), "Command: `CI=1 TZ=UTC pytest -q`");
});

// 7.4.0 #64 item 5: errors null is "errors not reported" (was "0 errors"), not added to the total
test("AC3 ex3: errors null is not reported; failures count in the total", async () => {
  const out = await build(NPM, { exit_code: 1, passed: 133, failed: 2, errors: null });
  assert.equal(line(out, 1), "**Tests (measured by the fleet):** 133 passed, 2 failed, errors not reported, 135 total.");
});

test("AC3 ex4: all zero is a valid count", async () => {
  const out = await build(NPM, { exit_code: 0, passed: 0, failed: 0, errors: 0 });
  assert.equal(line(out, 1), "**Tests (measured by the fleet):** 0 passed, 0 failed, 0 errors, 0 total.");
});

test("AC3 ex5: no suite_result key gives the not-reported line; the command line stays", async () => {
  const out = await build(NPM, undefined);
  assert.equal(line(out, 1), NOT_REPORTED);
  assert.equal(line(out, 2), "Command: `npm test`");
});

test("AC3 ex6: passed absent gives the not-reported line", async () => {
  const out = await build(NPM, { command: "pytest", exit_code: 0, failed: 0 });
  assert.equal(line(out, 1), NOT_REPORTED);
});

test("AC3 ex7: a negative passed gives the not-reported line", async () => {
  const out = await build(NPM, { exit_code: 0, passed: -1, failed: 0, errors: 0 });
  assert.equal(line(out, 1), NOT_REPORTED);
});

test("AC3 ex8: a negative failed gives the not-reported line", async () => {
  const out = await build(NPM, { exit_code: 1, passed: 133, failed: -2, errors: 0 });
  assert.equal(line(out, 1), NOT_REPORTED);
});

test("AC3 ex9: the judge's own command text never reaches the block", async () => {
  const out = await build(NPM, { command: "DSN=secretpw pytest", exit_code: 0, passed: 1, failed: 0, errors: 0 });
  assert.ok(!blockOf(out).includes("secretpw"));
  assert.equal(line(out, 2), "Command: `npm test`");
});

test("AC3 ex10: JUDGE_SUITE types passed as integer or null, optional", () => {
  const a = SOURCE.indexOf("// ---------------------------------------------------------------- constants");
  const b = SOURCE.indexOf("// ---------------------------------------------------------------- pure helpers");
  const { SCHEMAS } = new Function(SOURCE.slice(a, b) + "\nreturn { SCHEMAS };")();
  const s = SCHEMAS["fleet-code-judge"].properties.suite_result;
  const I = { type: ["integer", "null"] };
  assert.deepEqual(s.properties, { exit_code: I, failed: I, errors: I, passed: I });
  assert.ok(!(s.required || []).includes("passed"));
});

test("AC3 property: any suite_result value gives one of the two line-2 forms", async () => {
  for (const suite of [{}, { passed: 3, failed: 1 }, { passed: 3, failed: 1, errors: 2 }, { passed: 3, failed: null }]) {
    const out = await build(NPM, suite);
    assert.match(line(out, 1), /^\*\*Tests \(measured by the fleet\):\*\* (\d+ passed, \d+ failed, (\d+ errors|errors not reported), \d+ total\.|not reported \(the code judge's suite run gave no counts\)\.)$/);
  }
});
