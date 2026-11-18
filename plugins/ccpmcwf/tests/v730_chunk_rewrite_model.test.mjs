// fleet 7.3.0 (#59) A3: the chunk writers of a rewrite round (r1 and later)
// run one model step up from the first round's model (sonnet -> opus).
//
// dont_care: the wording of the writer prompt; how many writers round 0 has.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PC, happy, runOne, noUnscripted, chunkWriterStub } from "./harness.mjs";

const modelsOf = (out, re) => out.calls.filter((x) => re.test(x.label)).map((x) => [x.label, x.opts.model]);

test("7.3.0 #59 A3: writer r0w0 returns null, commit-plan relays bad_chunks [0]; r1w0 runs on opus and the plan commit seals", async () => {
  const s = happy();
  s["infra:plan-chunks:r0w0"] = () => null;
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(modelsOf(out, /^infra:plan-chunks/), [
    ["infra:plan-chunks:r0w0", "sonnet"],
    ["infra:plan-chunks:r1w0", "opus"],
  ]);
  assert.ok(out.labels.includes("infra:commit-plan:rewrite-1"), out.labels.join(", "));
  assert.ok(out.result.gate_log.some((l) => /chunk\(s\) 0.*fresh writer.* on opus/.test(l)), out.result.gate_log.join("\n"));
  assert.ok(s.__store[PC], "the plan ref was sealed");
});

test("7.3.0 #59 A3: a first-round writer keeps its INFRA_TIER model", async () => {
  const s = happy();
  s["infra:plan-chunks:r0w0"] = chunkWriterStub();
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(modelsOf(out, /^infra:plan-chunks/), [["infra:plan-chunks:r0w0", "sonnet"]]);
});
