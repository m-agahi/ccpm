// fleet 7.1.1 (L2142, yaadgaar #35), AC3: pr_state stop paths. A pr_state
// relay marked failed, from the shipped program, on the sent args, with a valid
// digest over K('pr_state:<mode>') and a non-null error, reaches its caller's
// own error branch. That branch stops the run with the same status, stop gate
// and reason as an ok relay with the same error (non-weakening), never with
// 'returned failed'. Callers: ready, merge, update and fetch.
//
// dont_care: the order of gate log lines; I/O failure paths (scripted relays
// only; the forge errors are the program's own error strings).

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
function personal() {
  const s = happy();
  s["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  return s;
}
const behindMerge = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
// the step's relay as failed (routed) and as ok: both outcomes must be equal
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
const ROUTED = (label) => label + ": the agent returned failed for the program's own error; its error branch decides";

test("7.1.1 L2142 AC3: a routed failed pr_state ready relay stops at gate ci, as the ok relay does", async () => {
  const out = await both(happy, "infra:pr-ready", (p) => F("pr_state", "pr_state:ready", { mode: "ready", was_draft: true, is_draft: true, head: inputsOf(p).args[4], state: "OPEN", error: "gh pr ready: HTTP 502" }, inputsOf(p).args));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ci");
  assert.equal(out.result.reason, "infra:pr-ready: https://github.com/o/r/pull/7 is not ready at the approved c000001 (gh pr ready: HTTP 502)");
  assert.ok(out.build.logs.some((l) => l.includes(ROUTED("infra:pr-ready"))), out.build.logs.join("\n"));
});

test("7.1.1 L2142 AC3: a routed failed pr_state merge relay stops at gate merge, as the ok relay does", async () => {
  const out = await both(personal, "infra:pr-merge", (p) =>
    F("pr_state", "pr_state:merge", { mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: null, merge_state: "CLEAN", head: inputsOf(p).args[4], branch_deleted: null, error: "gh pr merge: HTTP 405" }, inputsOf(p).args),
  );
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "merge");
  assert.equal(out.result.reason, "green, merge blocked: gh pr merge: HTTP 405 (https://github.com/o/r/pull/7)");
});

test("7.1.1 L2142 AC3: a routed failed pr_state update relay stops at gate merge, as the ok relay does", async () => {
  const mk = () => Object.assign(personal(), { "infra:pr-merge": behindMerge });
  const out = await both(mk, "infra:pr-update", (p) => F("pr_state", "pr_state:update", { mode: "update", updated: false, head: null, base: null, overlap: [], error: "update-branch: HTTP 422" }, inputsOf(p).args));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "merge");
  assert.equal(out.result.reason, "green, merge blocked: update-branch failed (update-branch: HTTP 422): https://github.com/o/r/pull/7");
});

test("7.1.1 L2142 AC3: a routed failed pr_state fetch relay stops at gate merge, as the ok relay does", async () => {
  const mk = () =>
    Object.assign(personal(), {
      "infra:pr-merge": behindMerge,
      "infra:pr-update": (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: "d".repeat(40), base: "c".repeat(40), overlap: ["src/x.py"], error: null, args: inputsOf(p).args }),
    });
  const out = await both(mk, "infra:pr-fetch:u1", (p) => F("pr_state", "pr_state:fetch", { mode: "fetch", head: null, tree: null, error: "not a fast-forward" }, inputsOf(p).args));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "merge");
  assert.equal(out.result.reason, "green, merge blocked: the update-branch head " + "d".repeat(40) + " is not a plain forge merge of c000001 and the base tip " + "c".repeat(40) + " (not a fast-forward): https://github.com/o/r/pull/7");
});
