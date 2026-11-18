// fleet 7.1.1 (L2142, yaadgaar #35), AC5: ci_watch. A routed failed ci_watch
// relay with a non-null error (valid program, args and digest over
// K('ci_watch')) gives the same 'CI unresolved' outcome as an ok relay with
// that error: reported under DEFAULT_CAPS, a stop at gate ci under PERSONAL.
//
// dont_care: the gate line text; I/O failure paths (scripted relays only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "no policy file", error: null, now: 1000, args: inputsOf(p).args }, over);
async function both(make, label, relay) {
  const outs = [];
  for (const status of ["failed", "ok"]) {
    const s = make();
    s[label] = (p) => Object.assign(relay(p), { status });
    outs.push(await run(s, ARGS));
  }
  const pick = (o) => [o.result.status, o.result.stop_gate, o.result.reason];
  assert.deepEqual(pick(outs[0]), pick(outs[1]), "a routed failed relay equals the ok relay with the same error");
  return outs[0];
}
const errWatch = (p) =>
  F(
    "ci_watch",
    "ci_watch",
    { state: "error", checks: [{ name: "test", state: "PENDING", bucket: "pending", url: "https://github.com/o/r/actions/runs/77/job/88" }], failed: [], required: null, head: null, elapsed_s: 10, error: "gh pr checks: HTTP 502" },
    inputsOf(p).args,
  );
const withCaps = (caps) => () => Object.assign(happy(), { "infra:policy": polOut({ caps }) });

test("7.1.1 L2142 AC5: a routed failed ci_watch relay under the default caps is CI unresolved, reported", async () => {
  const out = await both(withCaps(DEFAULT_CAPS), "infra:ci-watch:w1", errWatch);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.reason, "PR ready for review; CI unresolved (error: gh pr checks: HTTP 502; test PENDING)");
  assert.equal(out.result.ci.verdict, "timeout");
});

test("7.1.1 L2142 AC5: a routed failed ci_watch relay with a merge expected stops at gate ci, nothing merged", async () => {
  const out = await both(withCaps(PERSONAL), "infra:ci-watch:w1", errWatch);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ci");
  assert.equal(out.result.reason, "CI unresolved (error: gh pr checks: HTTP 502; test PENDING); nothing merged: https://github.com/o/r/pull/7");
  assert.ok(!out.build.labels.some((l) => l.startsWith("infra:pr-merge")), out.build.labels.join(", "));
});
