// ccpmcwf 8.9.11 (yaadgaar #125): the gate census relay gets one retry for a relay mis-copy only.
// A preflight gate_tools relay that is an object but fails its args or digest check (a mis-copy: a
// script fact) gets ONE fresh agent (infra:gate-tools:preflight:relay-retry) that runs only the
// census command, on the same args, one model tier above preflight (ADR-1364: sonnet -> opus).
// Max ruled (review of c6b3c5b): a null or absent relay (the program did not run, for example after
// a permission-classifier denial) gets NO retry: a fresh agent sending the same command in other
// text would re-ask a safety classifier until it says yes. The script decides on the relay's shape
// only, never on the reason text. The unusable line carries the agents' own reasons (capped,
// control and bidi characters as spaces), log text only. The census stays advisory.
// (#127, diagnosed: the commit-plan rewrite writers infra:plan-chunks:r<N>w<b> already run on opus;
// v730_chunk_rewrite_model pins it. No change.)
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, AUDIT_IMAGE, happy, run, runOne, gateToolsOut, relayDigestOf, K } from "./harness.mjs";

const RETRY = "infra:gate-tools:preflight:relay-retry";
const PROBE = { mode: "probe", repo: "/r", date: ARGS.date, run_nonce: ARGS.run_nonce };
const DENIED = "Bash denied by the permission classifier: Undermining Oversight";
const USABLE = "gate census other: coverage unsupported, mutation unsupported, security unsupported";
const POINTER = "if a permission denial blocked it, add the allow rule (README: Census retry)";
const unusable = (out) => out.logs.filter((l) => /^gate census unusable/.test(l));
const retries = (out) => out.labels.filter((l) => l.indexOf(RETRY) === 0).length;

// a preflight whose census relay is set by fn, with the agent's reason
function first(fn, label = "preflight") {
  const s = happy();
  s.__mutate = { label, fn: (r) => Object.assign(r, { gate_tools: fn(r.gate_tools), reason: DENIED }) };
  return s;
}
const nullRelay = () => null;
const badDigest = (g) => Object.assign(g, { digest: "0".repeat(64) });
const otherArgs = (g) => {
  g.args = [g.args[0], "semgrep:latest"];
  g.digest = relayDigestOf(g, K("gate_tools"));
  return g;
};

test("8.9.11 #125 (Max's ruling): a null or absent first relay runs no retry; the line has the reason and the allow-rule pointer", async () => {
  for (const [what, fn] of [["null", nullRelay], ["absent", () => undefined], ["a string", () => "denied"]]) {
    for (const mode of [ARGS, PROBE]) {
      const out = await runOne(first(fn), mode);
      assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", what + ": " + out.result.reason);
      assert.equal(retries(out), 0, what + ": " + out.labels.join(", "));
      const u = unusable(out);
      assert.equal(u.length, 1, out.logs.join("\n"));
      assert.equal(u[0], 'gate census unusable (no gate_tools relay: the program did not run; no retry): no gate tool available; the preflight agent\'s reason: "' + DENIED + '"; ' + POINTER, what);
      if (mode === PROBE) assert.equal(out.result.probe.gate_tools, null);
    }
  }
});

test("8.9.11 #125 (review of 94efc77): an object relay with no program header or no 64-hex digest (no proof the program ran) runs no retry", async () => {
  const shapes = {
    "all null": () => ({ languages: null, matrix: null, container: null, args: null, program: null, digest: null }),
    "another program": (g) => Object.assign(g, { program: { name: "path_check", sha256: "0".repeat(64) } }),
    "no digest": (g) => Object.assign(g, { digest: null }),
  };
  for (const [what, fn] of Object.entries(shapes)) {
    const out = await runOne(first(fn), ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", what + ": " + out.result.reason);
    assert.equal(retries(out), 0, what + ": " + out.labels.join(", "));
    const u = unusable(out);
    assert.equal(u.length, 1, out.logs.join("\n"));
    assert.ok(u[0].startsWith("gate census unusable (no gate_tools relay: the program did not run; no retry)"), what + ": " + u[0]);
    assert.ok(u[0].endsWith(POINTER), what);
  }
});

test("8.9.11 #125: a digest-mismatch first relay gets one retry on opus; a good retry gives a usable census; the retry line is a warning", async () => {
  for (const mode of [ARGS, PROBE]) {
    const out = await runOne(first(badDigest), mode);
    assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", mode.mode + ": " + out.result.reason);
    const rc = out.calls.filter((c) => c.label === RETRY);
    assert.equal(rc.length, 1, out.labels.join(", "));
    assert.equal(rc[0].opts.model, "opus");
    assert.equal(rc[0].opts.agentType, "ccpmcwf:judge");
    // only the census command, on preflight's args
    assert.ok(rc[0].prompt.includes("/gate_tools.py' '/r' '" + AUDIT_IMAGE + "'"), rc[0].prompt);
    assert.ok(!/path_check\.py|session_project\.py|ToolSearch/.test(rc[0].prompt), "only the census runs");
    // a warning: line, so the stats block's gates count leaves it out
    assert.ok(out.logs.includes("warning: preflight: the gate_tools relay does not check out (args or digest); running the census once more on opus (" + RETRY + ")"), out.logs.join("\n"));
    assert.ok(out.logs.includes(USABLE), out.logs.join("\n"));
    assert.deepEqual(unusable(out), []);
    if (mode === PROBE) assert.ok(out.result.probe.gate_tools, "the probe carries the retried census");
  }
});

test("8.9.11 #125: an args-mismatch first relay (a host image) gets one retry too", async () => {
  const out = await runOne(first(otherArgs), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(retries(out), 1, out.labels.join(", "));
  assert.ok(out.logs.includes(USABLE), out.logs.join("\n"));
});

test("8.9.11 #125: a mismatch first relay plus a bad retry gives unusable with both reasons (capped, control and bidi characters stripped)", async () => {
  const s = first(badDigest);
  const long = "permission denied\x1b[31m\nby\u202ethe\u2066 classifier: " + "x".repeat(400);
  s[RETRY] = { status: "failed", reason: long, gate_tools: null };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.equal(retries(out), 1, "one retry only");
  const u = unusable(out);
  assert.equal(u.length, 1, out.logs.join("\n"));
  assert.ok(u[0].startsWith("gate census unusable (no digest-checked gate_tools after one retry): no gate tool available; the preflight agent's reason: \"" + DENIED + "\"; the retry agent's reason: \"permission denied [31m by the  classifier: x"), u[0]);
  assert.ok(!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(u[0]), "no control or bidi character in the line");
  assert.ok(!u[0].includes("x".repeat(201)), "the reason is capped");
  assert.ok(!u[0].includes(POINTER), "a mis-copy is no denial");
  assert.ok(!out.logs.some((l) => /^gate census (python|node|go|rust|other|security):/.test(l)), "no tool claimed");
});

test("8.9.11 #125: a retry whose digest mismatches, or with no result, is not used; no third agent", async () => {
  for (const r of [{ status: "ok", reason: "ran", gate_tools: Object.assign(gateToolsOut("/r"), { digest: "0".repeat(64) }) }, null]) {
    for (const mode of [ARGS, PROBE]) {
      const s = first(badDigest);
      s[RETRY] = r;
      const out = await runOne(s, mode);
      assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", out.result.reason);
      assert.equal(retries(out), 1, out.labels.join(", "));
      assert.equal(out.labels.filter((l) => /^preflight/.test(l)).length, 1);
      const u = unusable(out);
      assert.equal(u.length, 1, out.logs.join("\n"));
      if (r === null) assert.ok(u[0].endsWith('; the retry agent\'s reason: "no reason"'), u[0]);
      if (mode === PROBE) assert.equal(out.result.probe.gate_tools, null, "the probe shows no census");
    }
  }
});

test("8.9.11 #125: the build's own preflight follows the same rule (no retry for null, one for a mis-copy)", async () => {
  const label = "preflight";
  const none = await run(first(nullRelay, label), ARGS);
  assert.equal(none.result.status, "ok", none.result.reason);
  assert.equal(retries(none), 0, none.labels.join(", "));
  assert.equal(unusable(none).length, 2, "plan and build each log it");
  const mis = await run(first(badDigest, label), ARGS);
  assert.equal(mis.result.status, "ok", mis.result.reason);
  assert.equal(retries(mis), 2, "one in plan, one in build: " + mis.labels.join(", "));
  assert.equal(unusable(mis).length, 0);
});

test("8.9.11 #125: a usable first census runs no retry", async () => {
  const out = await runOne(happy(), ARGS);
  assert.equal(retries(out), 0, out.labels.join(", "));
  assert.ok(out.logs.includes(USABLE));
});
