// ccpmcwf 8.5.0 (yaadgaar #105) AC4: an intake answer with no relay field halts with relaunch in every mode,
// whatever its status. The raw stubs below skip the harness default, so the answer carries no relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, triedFor } from "./harness.mjs";

const PREFIX = "intake: missing or malformed relay field";
const OK = () => ({ status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF) });

const MODES = [
  ["attended (no confirm)", ARGS],
  ["delegated unattended", { ...ARGS, unattended: true }],
  ["confirm ask", { ...ARGS, confirm: "ask" }],
  ["confirm auto", { ...ARGS, confirm: "auto" }],
  ["confirm default", { ...ARGS, confirm: "default" }],
];

function assertRelaunchHalt(out, label) {
  assert.equal(out.result.status, "needs_human", label + ": " + out.result.reason);
  assert.equal(out.result.stop_gate, "relaunch", label);
  assert.equal(out.result.relaunch, "intake", label);
  assert.ok(!out.labels.includes("workspace"), label + ": the run went past intake");
  assert.ok(out.result.reason.startsWith(PREFIX), label + ": " + out.result.reason);
}

// AC4: an ok answer with no relay field, in every mode
for (const [name, args] of MODES)
  test("8.5.0 #105 AC4: ok intake answer with no relay field halts with relaunch (" + name + ")", async () => {
    const s = happy();
    s.intake = { ...OK(), __raw: true };
    const out = await runOne(s, args);
    assertRelaunchHalt(out, name);
  });

// AC4: a needs_human answer with no relay field, attended and delegated
for (const [name, args] of [
  ["attended", ARGS],
  ["delegated", { ...ARGS, unattended: true }],
])
  test("8.5.0 #105 AC4: needs_human intake answer with no relay field halts with relaunch (" + name + ")", async () => {
    const s = happy();
    s.intake = { status: "needs_human", reason: "several matching tickets", tried: [], __raw: true };
    const out = await runOne(s, args);
    assertRelaunchHalt(out, name);
  });

// AC4 triangulation: whatever its status, a failed answer with another reason and no relay halts the same way
for (const [name, args] of MODES)
  test("8.5.0 #105 AC4: failed intake answer with no relay field halts with relaunch (" + name + ")", async () => {
    const s = happy();
    s.intake = { status: "failed", reason: "tool error", tried: [], __raw: true };
    const out = await runOne(s, args);
    assertRelaunchHalt(out, name);
  });
