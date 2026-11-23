// ccpmcwf 8.5.0 (yaadgaar #105), AC5: a malformed or unknown intake relay value halts with relaunch
// in every mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, triedFor } from "./harness.mjs";

const PREFIX = "intake: missing or malformed relay field";
const MODES = [ARGS, { ...ARGS, unattended: true }];
const OK = () => ({ status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF) });

async function assertHalts(relay, label) {
  for (const args of MODES) {
    const s = happy();
    s.intake = { ...OK(), relay };
    const out = await runOne(s, args);
    const tag = label + " / " + JSON.stringify(args);
    assert.equal(out.result.status, "needs_human", tag);
    assert.equal(out.result.stop_gate, "relaunch", tag);
    assert.equal(out.result.relaunch, "intake", tag);
    assert.ok(!out.labels.includes("workspace"), tag + ": no workspace");
    assert.ok(String(out.result.reason).startsWith(PREFIX), tag + ": reason " + out.result.reason);
  }
}

// AC5: unknown kind
test("AC5: relay kind outside the four values halts with relaunch", async () => {
  await assertHalts({ kind: "other", text: "x" }, "kind other");
  // AC5 triangulation: another unknown kind
  await assertHalts({ kind: "delegate", text: "run the loop" }, "kind delegate");
});

// AC5: not a plain object
test("AC5: relay that is a string, null or an array halts with relaunch", async () => {
  await assertHalts("delegation", "string");
  await assertHalts(null, "null");
  await assertHalts([], "array");
  // AC5 triangulation: a string naming a valid kind other than delegation
  await assertHalts("none", "string none");
});

// AC5: delegation without usable text
test("AC5: delegation relay with missing or empty text halts with relaunch", async () => {
  await assertHalts({ kind: "delegation" }, "delegation no text");
  await assertHalts({ kind: "delegation", text: "" }, "delegation empty text");
});

// AC5: text missing or not a string
test("AC5: relay with missing or non-string text halts with relaunch", async () => {
  await assertHalts({ kind: "none" }, "none no text");
  await assertHalts({ kind: "none", text: 5 }, "none numeric text");
  // AC5 triangulation: another kind with a non-string text
  await assertHalts({ kind: "names_input", text: null }, "names_input null text");
});
