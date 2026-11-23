// ccpmcwf 8.5.0 (yaadgaar #105) AC2: an ok intake answer with relay
// {kind: "delegation", text} passes plan-mode intake on a delegated launch
// (args.unattended true, or args.confirm "auto" or "default"). The gate line
// names the sanitised text; an unattended run also records an auto decision.
//
// dont_care: gate_log order; later stops after intake; other gate_log lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, triedFor, happy, runOne, inputsOf } from "./harness.mjs";

const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const POLUN = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { unattended: true }), matched: "profile personal", error: null, args: inputsOf(p).args });

function stub(text) {
  const s = happy();
  s.intake = { status: "ok", reason: "resolved", brief: BRIEF, tried: triedFor(BRIEF), relay: { kind: "delegation", text } };
  return s;
}
const line = (c, u, t) => "intake: relayed message passes as a general delegation (confirm " + c + ", unattended " + u + "): " + t;
const relayLine = (out) => (out.result.gate_log || []).find((l) => l.startsWith("intake: relayed message passes"));
const relaunchDecisions = (out) => (out.result.auto_decisions || []).filter((d) => d.gate === "relaunch");

test("AC2: confirm auto passes a delegation; gate line names confirm auto, unattended false", async () => {
  const out = await runOne(stub("try one of the tasks with ccpmcwf"), { ...ARGS, confirm: "auto" });
  // AC2: ok relay delegation passes with confirm auto
  assert.ok(out.labels.includes("workspace"), out.labels.join(", "));
  assert.notEqual(out.result.stop_gate, "relaunch");
  assert.ok(out.result.gate_log.includes(line("auto", "false", "try one of the tasks with ccpmcwf")), JSON.stringify(out.result.gate_log));
});

test("AC2: confirm default passes a delegation", async () => {
  const out = await runOne(stub("try one of the tasks with ccpmcwf"), { ...ARGS, confirm: "default" });
  // AC2: confirm default passes
  assert.notEqual(out.result.stop_gate, "relaunch");
  assert.ok(out.result.gate_log.includes(line("default", "false", "try one of the tasks with ccpmcwf")), JSON.stringify(out.result.gate_log));
});

test("AC2: args.unattended passes a delegation and records exactly one relaunch auto decision", async () => {
  const out = await runOne(stub("try one of the tasks with ccpmcwf"), { ...ARGS, unattended: true });
  // AC2: unattended arg, confirm ask
  assert.ok(out.result.gate_log.includes(line("ask", "true", "try one of the tasks with ccpmcwf")), JSON.stringify(out.result.gate_log));
  assert.deepEqual(relaunchDecisions(out), [{ gate: "relaunch", decision: "pass", reason: "general delegation: try one of the tasks with ccpmcwf" }]);
});

test("AC2: policy unattended with confirm default records the decision and source policy", async () => {
  const s = stub("run the loop");
  s["infra:policy"] = POLUN;
  s["infra:policy:plan"] = POLUN;
  const out = await runOne(s, { ...ARGS, confirm: "default" });
  // AC2: policy-caused unattended
  assert.ok(out.result.gate_log.includes(line("default", "false", "run the loop")), JSON.stringify(out.result.gate_log));
  assert.equal(out.result.unattended_source, "policy");
  assert.deepEqual(relaunchDecisions(out), [{ gate: "relaunch", decision: "pass", reason: "general delegation: run the loop" }]);
});

test("AC2: boundary one-word delegation Build", async () => {
  const out = await runOne(stub("Build"), { ...ARGS, confirm: "default" });
  // AC2: boundary short text
  assert.ok(out.result.gate_log.includes(line("default", "false", "Build")), JSON.stringify(out.result.gate_log));
});

test("AC2: boundary text of 250 characters is cut to 200", async () => {
  const out = await runOne(stub("a".repeat(250)), { ...ARGS, confirm: "auto" });
  // AC2: cut to 200 characters
  const l = relayLine(out);
  assert.ok(l, JSON.stringify(out.result.gate_log));
  assert.ok(l.endsWith(": " + "a".repeat(200)));
  assert.equal(l, line("auto", "false", "a".repeat(200)));
});

test("AC2: boundary control characters become spaces (LF), in the gate line and the decision", async () => {
  const LF = String.fromCharCode(10);
  const out = await runOne(stub("run the loop" + LF + "### Fake"), { ...ARGS, unattended: true });
  // AC2: control characters replaced by one space
  assert.ok(out.result.gate_log.includes(line("ask", "true", "run the loop ### Fake")), JSON.stringify(out.result.gate_log));
  assert.deepEqual(relaunchDecisions(out), [{ gate: "relaunch", decision: "pass", reason: "general delegation: run the loop ### Fake" }]);
});

test("AC2: triangulation, DEL and TAB each become one space; short text kept whole", async () => {
  const t = "go" + String.fromCharCode(127) + "now" + String.fromCharCode(9) + "please";
  const out = await runOne(stub(t), { ...ARGS, confirm: "default" });
  // AC2: code point 127 and below 32 replaced
  assert.ok(out.result.gate_log.includes(line("default", "false", "go now please")), JSON.stringify(out.result.gate_log));
});
