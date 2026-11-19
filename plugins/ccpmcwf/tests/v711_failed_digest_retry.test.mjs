// fleet 7.1.1 (L2142, yaadgaar #35), AC1: a relay marked failed whose only
// defect is a mis-copied 64-hex digest gets the one digest retry an ok relay
// gets; the retry's result decides the step.
//
// dont_care: the wording of the retry prompt; the order of unrelated labels;
// I/O failure paths (scripted relays only). The agent cap: softDispatch skips
// the retry when one more agent would pass MAX_AGENTS (digestRetry returns the
// first relay unchanged); that cap path is covered by the existing digest-retry
// tests and is deliberately not exercised here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf, programOf, programSha, relayDigestOf, K, H, HASHES_FLAT, FP_PRE, hashDiffOut, SAVED_R1 } from "./harness.mjs";

// Fixture F: a relay the agent marked failed, from the shipped program, on the given args
function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const BAD = "0".repeat(64);
const count = (L, l) => L.filter((x) => x === l).length;

test("7.1.1 L2142 AC1: a failed ruleset relay with a mis-copied digest gets one digest retry; the retry reaches the hooks gate", async () => {
  const s = happy();
  let n = 0;
  s["infra:ruleset-surface:plan"] = (p) => {
    const r = F("ruleset_surface", "ruleset_surface", { surface: [], sources: [], read: [], unreadable: [], error: "repo o/r not readable (HTTP 502)" }, inputsOf(p).args);
    if (n++ === 0) r.digest = BAD;
    return r;
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.ok(out.result.reason.startsWith("hook surface cannot be computed (repo o/r not readable (HTTP 502)); hook change needs Max's confirmation"), out.result.reason);
  assert.equal(count(out.labels, "infra:surfaces:plan:digest-retry"), 1, out.labels.join(", "));
});

test("7.1.1 L2142 AC1: a failed orch-scan relay with a mis-copied digest gets one digest retry; an ok retry lets the PR go ready", async () => {
  const s = happy();
  s["infra:orch-scan"] = (p) =>
    Object.assign(F("orch_scan", "orch_scan", { orchestrator: true, iac_repo: true, apply_on_merge: true, hook_surface_pr: true, reasons: [], error: "gh pr view: HTTP 502" }, inputsOf(p).args), { digest: BAD });
  s["infra:orch-scan:digest-retry"] = (p) => ({ status: "ok", reason: "s", orchestrator: false, iac_repo: false, apply_on_merge: false, hook_surface_pr: false, reasons: [], error: null, args: inputsOf(p).args });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.reason, "PR ready for review; CI green, ready for human merge (no merge: policy merge never)");
  assert.equal(count(out.build.labels, "infra:orch-scan:digest-retry"), 1, out.build.labels.join(", "));
  assert.ok(out.build.labels.includes("infra:pr-ready"), out.build.labels.join(", "));
  const line = "infra:orch-scan: the relay does not match the program's digest; dispatched once more to a fresh agent (infra:orch-scan:digest-retry)";
  assert.ok(out.build.logs.some((l) => l.includes(line)), out.build.logs.join("\n"));
});

// plan-audit advisory (b): a softDispatch step. A failed hash-diff relay with a
// mis-copied digest gets the same one retry under the agent cap; the ok retry
// lists the key, so the writers stop on that key, not on "the key list is unavailable".
function base() {
  const h = H(Object.assign({}, HASHES_FLAT, { "conftest.py": "hc", "git:config:local": "g1" }));
  h.ignored = { "build.log": "i1" };
  h.symlinks = { lib: "../x" };
  return h;
}
test("7.1.1 L2142 AC1 (softDispatch): a failed hash-diff relay with a mis-copied digest gets one digest retry; the retry's key list decides", async () => {
  const s = happy();
  const mod = base();
  mod.git["config:local"] = "g2";
  s["hasher:pre-writers:r1"] = { status: "ok", fingerprint: FP_PRE, hashes: base() };
  const pw = s["hasher:post-writers:r1"];
  s["hasher:post-writers:r1"] = (p) => Object.assign(pw(p), { hashes: mod });
  let n = 0;
  s["infra:hash-diff:writers:r1"] = (p) => {
    const o = hashDiffOut(inputsOf(p).args);
    if (n++ === 0) {
      const f = Object.assign({}, o, { error: "a map file does not match its sha256" });
      delete f.args;
      return Object.assign(F("hash_diff", "hash_diff", f, o.args), { digest: BAD });
    }
    return Object.assign({ status: "ok", reason: "compared" }, o);
  };
  const out = await run(s, ARGS);
  assert.equal(count(out.labels, "infra:hash-diff:writers:r1:digest-retry"), 1, out.labels.join(", "));
  assert.deepEqual([out.result.status, out.result.stop_gate], ["needs_human", "ownership"], out.result.reason);
  assert.equal(out.result.reason, "writer touched git:config:local in test round 1 (not a test file of AC1, AC2)" + SAVED_R1);
});
