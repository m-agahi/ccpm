// fleet 7.1.1 (L2142, yaadgaar #35), AC7: policy. A routed failed policy relay
// with a non-null error stops at gate policy when caps is null, and applies the
// strict default with a gate line when caps is set. Both are the same as the ok
// relay. The step is scripted as 'infra:policy' (the harness serves it for
// 'infra:policy:plan' too).
//
// dont_care: which of infra:policy:plan or infra:policy stops first in the
// caps-null example; I/O failure paths (scripted relays only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
async function both(relay) {
  const outs = [];
  for (const status of ["failed", "ok"]) {
    const s = happy();
    s["infra:policy"] = (p) => Object.assign(relay(p), { status });
    outs.push(await run(s, ARGS));
  }
  const pick = (o) => [o.result.status, o.result.stop_gate, o.result.reason];
  assert.deepEqual(pick(outs[0]), pick(outs[1]), "a routed failed relay equals the ok relay with the same error");
  return outs[0];
}

test("7.1.1 L2142 AC7: a routed failed policy relay with no caps stops at gate policy, as the ok relay does", async () => {
  const out = await both((p) =>
    F("policy", "policy", { profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: "d".repeat(64), caps: null, matched: null, error: "policy file /h/.config/fleet/policy.json: not JSON", now: 1000 }, inputsOf(p).args),
  );
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "policy");
  assert.equal(out.result.reason, "policy: policy file /h/.config/fleet/policy.json: not JSON; fix or remove the file, then re-run the build");
});

test("7.1.1 L2142 AC7: a routed failed policy relay with caps set applies the strict default with a gate line, as the ok relay does", async () => {
  const err = "policy file /h/.config/fleet/policy.json: profiles[0].merge must be one of never|auto";
  const out = await both((p) => F("policy", "policy", { profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: "d".repeat(64), caps: DEFAULT_CAPS, matched: null, error: err, now: 1000 }, inputsOf(p).args));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.reason, "PR ready for review; CI green, ready for human merge (no merge: policy merge never)");
  const line = "policy: " + err + "; the strict default applies (pr_ready true, ci_watch true 60 min, stats true, merge never, update_branch never, ci_trigger false, review_post none); fix or remove the file";
  assert.ok(out.build.logs.some((l) => l.includes(line)), out.build.logs.join("\n"));
});
