// ccpmcwf 8.9.11 (yaadgaar #125): the gate census relay gets one retry.
// A preflight gate_tools relay that is null, or fails its args or digest check, gets ONE fresh
// agent (infra:gate-tools:preflight:relay-retry) that runs only the census command, on the same
// args, one model tier above preflight (ADR-1364: sonnet -> opus). Only a second unusable relay
// logs "gate census unusable", and that line now carries the agents' own reasons (capped, control
// characters stripped): a permission-classifier denial shows in gate_log. The reasons are log text
// only; nothing routes on them. The census stays advisory: no outcome stops the run.
// (#127, diagnosed: the commit-plan rewrite writers infra:plan-chunks:r<N>w<b> already run on opus;
// v730_chunk_rewrite_model pins it. The :rewrite-<N> commit step and its PATH re-check stay on
// sonnet by design. No change.)
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, AUDIT_IMAGE, happy, runOne, gateToolsOut } from "./harness.mjs";

const RETRY = "infra:gate-tools:preflight:relay-retry";
const PROBE = { mode: "probe", repo: "/r", date: ARGS.date, run_nonce: ARGS.run_nonce };
const DENIED = "Bash denied by the permission classifier: Undermining Oversight";
const USABLE = "gate census other: coverage unsupported, mutation unsupported, security unsupported";
const unusable = (out) => out.logs.filter((l) => /^gate census unusable/.test(l));

// a preflight whose census relay is null, with its reason
function nullCensus() {
  const s = happy();
  s.__mutate = { label: "preflight", fn: (r) => Object.assign(r, { gate_tools: null, reason: DENIED }) };
  return s;
}

test("8.9.11 #125: a null gate_tools first relay gets one retry on opus; a good retry gives a usable census", async () => {
  for (const mode of [ARGS, PROBE]) {
    const out = await runOne(nullCensus(), mode);
    assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", mode.mode + ": " + out.result.reason);
    const rc = out.calls.filter((c) => c.label === RETRY);
    assert.equal(rc.length, 1, out.labels.join(", "));
    assert.equal(rc[0].opts.model, "opus");
    assert.equal(rc[0].opts.agentType, "ccpmcwf:judge");
    // only the census command, on preflight's args
    assert.ok(rc[0].prompt.includes("/gate_tools.py' '/r' '" + AUDIT_IMAGE + "'"), rc[0].prompt);
    assert.ok(!/path_check\.py|session_project\.py|ToolSearch/.test(rc[0].prompt), "only the census runs");
    assert.ok(out.logs.some((l) => l.startsWith("preflight: no usable gate_tools") && l.includes("once more on opus")), out.logs.join("\n"));
    assert.ok(out.logs.includes(USABLE), out.logs.join("\n"));
    assert.deepEqual(unusable(out), []);
    if (mode === PROBE) assert.ok(out.result.probe.gate_tools, "the probe carries the retried census");
  }
});

test("8.9.11 #125: two failures give census unusable, with both reasons (capped, control characters stripped) in the line", async () => {
  const s = nullCensus();
  const long = "permission denied\x1b[31m\nby the classifier: " + "x".repeat(400);
  s[RETRY] = { status: "failed", reason: long, gate_tools: null };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(out.calls.filter((c) => c.label === RETRY).length, 1, "one retry only");
  const u = unusable(out);
  assert.equal(u.length, 1, out.logs.join("\n"));
  assert.ok(u[0].startsWith("gate census unusable (no digest-checked gate_tools after one retry): no gate tool available"), u[0]);
  assert.ok(u[0].includes(DENIED), "the preflight agent's reason: " + u[0]);
  assert.ok(u[0].includes("permission denied [31m by the classifier: x"), "the retry's reason, control characters stripped: " + u[0]);
  assert.ok(!/[\x00-\x1f\x7f]/.test(u[0]), "no control character in the line");
  assert.ok(!u[0].includes("x".repeat(201)), "the reason is capped");
  assert.ok(!out.logs.some((l) => /^gate census (python|node|go|rust|other|security):/.test(l)), "no tool claimed");
});

test("8.9.11 #125: a retry whose digest mismatches is not used (and is not retried again)", async () => {
  for (const mode of [ARGS, PROBE]) {
    const s = nullCensus();
    s[RETRY] = { status: "ok", reason: "ran", gate_tools: Object.assign(gateToolsOut("/r"), { digest: "0".repeat(64) }) };
    const out = await runOne(s, mode);
    assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", out.result.reason);
    assert.equal(out.labels.filter((l) => l.indexOf(RETRY) === 0).length, 1, out.labels.join(", "));
    assert.equal(unusable(out).length, 1, out.logs.join("\n"));
    assert.ok(!out.logs.includes(USABLE));
    if (mode === PROBE) assert.equal(out.result.probe.gate_tools, null, "the probe shows no census");
  }
});

test("8.9.11 #125: a retry on other args (a host image) is not used either", async () => {
  const s = nullCensus();
  s[RETRY] = { status: "ok", reason: "ran", gate_tools: Object.assign(gateToolsOut("/r"), { args: ["/r", "semgrep:latest"] }) };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(out.calls.filter((c) => c.label === RETRY).length, 1, out.labels.join(", "));
  assert.equal(unusable(out).length, 1, out.logs.join("\n"));
});

test("8.9.11 #125: a retry that returns no result counts as the second failure; the run goes on, no third agent", async () => {
  const s = nullCensus();
  s[RETRY] = null;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(out.labels.filter((l) => l.indexOf(RETRY) === 0 || /^preflight/.test(l)).length, 2, out.labels.join(", "));
  const u = unusable(out);
  assert.equal(u.length, 1, out.logs.join("\n"));
  assert.ok(u[0].endsWith('; the retry said "no reason"'), u[0]);
});

test("8.9.11 #125: a usable first census runs no retry", async () => {
  const out = await runOne(happy(), ARGS);
  assert.ok(!out.labels.includes(RETRY), out.labels.join(", "));
  assert.ok(out.logs.includes(USABLE));
});
