// fleet 7.0.1 (ledger 2190), AC5: the build caller check carries `generated`.
// The changed_defs relay lists a `generated` array: only the dist path
// plugins/fleet/workflows/build-task-run.js is a valid entry. A valid entry is
// logged as skipped and the build continues; a missing array, a non-string
// entry or any other path halts the step as failed before any commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, call, defsOut, sha256, canon } from "./harness.mjs";

const DIST_REL = "plugins/fleet/workflows/build-task-run.js";
const LABEL = "infra:changed-defs:r1";

function withRelay(relay) {
  const s = happy();
  s[LABEL] = relay;
  return s;
}

test("AC5: a generated dist entry is logged as skipped and the build continues", async () => {
  // AC5: valid relay with the dist path -> ok, skipped line, commit runs
  const out = await run(withRelay(defsOut([], { generated: [DIST_REL] })), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.result.gate_log.includes(LABEL + ": skipped " + DIST_REL + " (generated from src)"));
  assert.ok(out.labels.includes("infra:commit:r1"));
});

test("AC5: triangulation, an empty generated array builds with no generated skip line", async () => {
  // AC5: generated [] is a valid relay; nothing is skipped as generated
  const out = await run(withRelay(defsOut([], { generated: [] })), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!out.result.gate_log.some((m) => /\(generated from src\)/.test(m)));
  assert.ok(out.labels.includes("infra:commit:r1"));
});

test("AC5: a relay with no generated array halts the step before any commit", async () => {
  // AC5: four-key object literal, never built through defsOut
  const o = { defs: [], excluded: [], unclassified: [], unattributed: [] };
  const relay = { status: "ok", reason: "listed", defs: [], excluded: [], unclassified: [], unattributed: [], digest: sha256(canon(o)) };
  const out = await run(withRelay(relay), ARGS);
  assert.equal(out.result.status, "failed");
  assert.ok(out.result.reason.startsWith(LABEL), out.result.reason);
  assert.match(out.result.reason, /generated/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
});

test("AC5: a non-string generated entry halts the step before any commit", async () => {
  // AC5: generated: [5]
  const out = await run(withRelay(defsOut([], { generated: [5] })), ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /generated/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
});

test("AC5: triangulation, a null generated entry halts the step before any commit", async () => {
  // AC5: another non-string type
  const out = await run(withRelay(defsOut([], { generated: [null] })), ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /generated/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
});

test("AC5: a generated entry other than the dist path halts and names the path", async () => {
  // AC5: tampering example src/app.py with a valid digest
  const out = await run(withRelay(defsOut([], { generated: ["src/app.py"] })), ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /src\/app\.py/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
});

test("AC5: triangulation, the src file itself is not an allowed generated path", async () => {
  // AC5: only the dist path is valid
  const bad = "plugins/fleet/src/build-task-run.js";
  const out = await run(withRelay(defsOut([], { generated: [bad] })), ARGS);
  assert.equal(out.result.status, "failed");
  assert.match(out.result.reason, /plugins\/fleet\/src\/build-task-run\.js/);
  assert.ok(!out.labels.includes("infra:commit:r1"));
});

test("AC5: the changed_defs prompt lists generated among the printed keys", async () => {
  // AC5: prompt printed-keys list
  const out = await run(happy(), ARGS);
  const c = call(out, LABEL);
  const m = /It prints one JSON object \{([^}]*)\}/.exec(c.prompt);
  assert.ok(m, "printed keys object not found in the prompt");
  assert.ok(m[1].split(", ").includes("generated"), m[1]);
});
