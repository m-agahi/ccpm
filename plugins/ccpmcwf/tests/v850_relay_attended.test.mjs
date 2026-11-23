// fleet 8.5.0 (yaadgaar #105), AC3: a reported delegation halts an attended launch with relaunch.
// Attended = args.confirm absent or "ask", and no args.unattended. Only the args count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, triedFor } from "./harness.mjs";

const DELEGATION = (text) => ({ status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF), relay: { kind: "delegation", text } });
const TAIL = "; re-launch the workflow once in a turn whose latest human message is the build request";
const reasonFor = (text) => "intake: relayed message is a general delegation, but this launch is attended (confirm ask, no unattended): " + text + TAIL;

function assertRelaunchHalt(out) {
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "relaunch");
  assert.equal(out.result.relaunch, "intake");
  assert.ok(!out.labels.includes("workspace"), "the run stops before the workspace step");
}

test("AC3: delegation under ARGS (no confirm) halts with relaunch and the attended reason", async () => {
  // AC3: example 1, a delegation with no confirm
  const s = happy();
  s.intake = DELEGATION("try one of the tasks with ccpmcwf");
  const out = await runOne(s, ARGS);
  assertRelaunchHalt(out);
  assert.equal(out.result.reason, reasonFor("try one of the tasks with ccpmcwf"));
});

test("AC3: delegation under confirm ask halts with the same result", async () => {
  // AC3: example 2, the same stub under confirm "ask"
  const s = happy();
  s.intake = DELEGATION("try one of the tasks with ccpmcwf");
  const out = await runOne(s, { ...ARGS, confirm: "ask" });
  assertRelaunchHalt(out);
  assert.equal(out.result.reason, reasonFor("try one of the tasks with ccpmcwf"));
});

test("AC3: a bare answer \"Build\" is a delegation and halts an attended launch", async () => {
  // AC3: example 3, the bare answer
  const s = happy();
  s.intake = DELEGATION("Build");
  const out = await runOne(s, ARGS);
  assertRelaunchHalt(out);
});

test("AC3: triangulation, other delegation text is carried into the attended reason", async () => {
  // AC3: the reason names the relayed text, so a hardcoded reason fails
  const s = happy();
  s.intake = DELEGATION("run the loop");
  const out = await runOne(s, { ...ARGS, confirm: "ask" });
  assertRelaunchHalt(out);
  assert.equal(out.result.reason, reasonFor("run the loop"));
});
