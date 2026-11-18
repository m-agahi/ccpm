// fleet 7.4.0 car 5 (#70 item 4), U3: a run-state write over one writer's bound whose chunk 1 is
// bad on every rewrite round halts when the rounds run out, with stop_gate resume (chunkRounds'
// stopGate argument at the run-state site). A pin: the mutation below shows the test catches a
// change of that argument.
//
// dont_care: the halt wording after "still do not match".

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, happy, run } from "./harness.mjs";

const L = "infra:state:committed:r1";
function bigBad() {
  const s = happy();
  s["role:fleet-code-judge:r1"] = Object.assign({}, s["role:fleet-code-judge:r1"], { suite_result: { command: "pytest", exit_code: 0, tail: "x".repeat(40000) } });
  const bad = () => ({ status: "failed", reason: "bad chunks", bad_chunks: [1] });
  s[L] = s[L + ":rewrite-1"] = s[L + ":rewrite-2"] = bad;
  return s;
}
const SITE = '"run-state", "no run-state was written", "resume")';

test("7.4.0 #70 U3: run-state chunks still bad after the rewrite rounds halt with stop_gate resume", async () => {
  const out = await run(bigBad(), ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.equal(out.result.stop_gate, "resume");
  assert.match(out.result.reason, /chunk\(s\) 1 still do not match their sha256 after 2 rewrite rounds; no run-state was written/);
});

test("7.4.0 #70 U3 mutation: with another stopGate at the run-state site the stop_gate differs", async () => {
  assert.equal(SOURCE.split(SITE).length - 1, 1, "one run-state chunkRounds site");
  const s = bigBad();
  s.__source = SOURCE.replace(SITE, '"run-state", "no run-state was written", "contract")');
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.notEqual(out.result.stop_gate, "resume");
});
