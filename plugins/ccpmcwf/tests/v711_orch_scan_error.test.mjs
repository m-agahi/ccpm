// fleet 7.1.1 (L2142, yaadgaar #35), AC6: orch_scan. A routed failed orch_scan
// relay with a non-null error, all four flags true as the program prints them
// (fail closed), keeps the PR a draft and stops 'orchestrator PR: needs Max',
// the same as the ok relay. A failed orch_scan relay mis-copied on both calls
// gets exactly one infra:orch-scan:digest-retry, then halts 'returned failed'.
//
// dont_care: the orch-scan gate line wording; I/O failure paths (scripted
// relays only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const scan = (p) => F("orch_scan", "orch_scan", { orchestrator: true, iac_repo: true, apply_on_merge: true, hook_surface_pr: true, reasons: [], error: "gh pr view: HTTP 502" }, inputsOf(p).args);

test("7.1.1 L2142 AC6: a routed failed orch_scan relay (7.3.0: ready, not merged) stops 'orchestrator PR: needs Max', as the ok relay does", async () => {
  const outs = [];
  for (const status of ["failed", "ok"]) {
    const s = happy();
    s["infra:orch-scan"] = (p) => Object.assign(scan(p), { status });
    // 7.3.0 (#32): the error stays on the one retry
    s["infra:orch-scan:retry"] = s["infra:orch-scan"];
    outs.push(await run(s, ARGS));
  }
  const [out, ok] = outs;
  assert.deepEqual([out.result.status, out.result.stop_gate, out.result.reason], [ok.result.status, ok.result.stop_gate, ok.result.reason]);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "merge");
  assert.equal(out.result.reason, "orchestrator PR: needs Max (https://github.com/o/r/pull/7; CI green: test SUCCESS)");
  // 7.3.0 (#33): changed on purpose: the PR opened ready; the ready check runs, nothing merges
  assert.ok(out.build.labels.includes("infra:pr-ready"), out.build.labels.join(", "));
  assert.ok(!out.build.labels.some((l) => /^infra:pr-merge/.test(l)), out.build.labels.join(", "));
  assert.ok(out.build.labels.includes("infra:ci-watch:w1"), out.build.labels.join(", "));
});

test("7.1.1 L2142 AC6 (boundary): a failed orch_scan relay mis-copied twice gets exactly one digest retry, then halts", async () => {
  const s = happy();
  s["infra:orch-scan"] = (p) => Object.assign(scan(p), { digest: "0".repeat(64) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:orch-scan returned failed"), out.result.reason);
  assert.equal(out.build.labels.filter((l) => l === "infra:orch-scan:digest-retry").length, 1, out.build.labels.join(", "));
});
