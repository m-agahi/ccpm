// fleet 7.3.0 (#41, L2174) A16, A17, A32: after an update-branch, a blocking
// re-review routes pr_body_claim findings as the main path does: the code
// findings go to the coder (update round), the body findings to the next
// pr-opener call; a body-only re-review runs one pr-opener body update and a
// re-review, no code round. The code-judge guard is on in update rounds.
// An update round whose commit step commits nothing stops loudly (failed).
//
// dont_care: gate line wording; the R1-R5 refusal checks (v610_update_coder).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf } from "./harness.mjs";

const D = "d".repeat(40);
const C = "c".repeat(40);
const CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "auto", update_branch: "once", ci_trigger: true, review_post: "none" };
const BEHIND = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
const R1 = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed", evidence: "npm test: 133 pass" };
const R2 = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" };
const TAGF = { target: "code", criterion: null, finding: "review R1 [pr_body_claim] PR body: body says 147 passed (evidence: npm test: 133 pass)" };
const REV = (v, f) => ({ status: "ok", reason: "x", verdict: v, findings: f, touches_gate: false, checked: [] });
const OPEN7 = { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };

// as v610_update_coder upd(): an overlap update to D, the re-review v2 on D, a coder round r2, the re-review v3
function upd(over, v3 = { head: CSHA(2), tree: "K2" }) {
  const t = happy();
  t["infra:policy"] = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
  Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES, changed: ["src/x.py"] },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": REV("changes_requested", [R1, R2]),
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "fixed", changed_paths: ["src/x.py"], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: D, tree: "K2" }, hashes: HASHES, changed: ["src/x.py"] },
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: D, tree: "K2" } },
    "infra:push:p2": (p) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(p).approved_sha }),
    "role:fleet-pr-opener:p2": OPEN7,
    "infra:review-paths:v3": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v3": { status: "ok", fingerprint: v3 },
    "role:pr-review:v3": REV("approve", []),
    "hasher:fp-post:pr-review:v3": { status: "ok", fingerprint: v3 },
    "infra:review-cleanup:v3": { status: "ok", reason: "clean" },
  });
  return Object.assign(t, over || {});
}
test("7.3.0 A16: an update re-review with [R1 pr_body_claim, R2 code]: the coder gets R2 only, the next pr-opener gets body_findings [R1]", async () => {
  const out = await run(upd(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const rf = inputsOf(call(out, "role:fleet-coder:r2").prompt).routed_findings;
  assert.equal(rf.length, 1, JSON.stringify(rf));
  assert.match(rf[0].finding, /^review R2 \[correctness\] /);
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:p2").prompt).body_findings, [R1]);
});

test("7.3.0 A17: an update re-review with only R1 pr_body_claim: one body update and a re-review, no code round", async () => {
  const out = await run(upd({ "role:pr-review:v2": REV("changes_requested", [R1]), "role:fleet-pr-opener:body-v2": OPEN7 }, { head: D, tree: "KU" }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.build.labels;
  assert.ok(!L.some((l) => /^role:fleet-coder:r2|^infra:commit:r2|^infra:push:p2/.test(l)), L.join(", "));
  assert.equal(L.filter((l) => l === "role:fleet-pr-opener:body-v2").length, 1, L.join(", "));
  assert.ok(L.indexOf("role:fleet-pr-opener:body-v2") < L.indexOf("role:pr-review:v3"), L.join(", "));
  assert.deepEqual(inputsOf(call(out, "role:fleet-pr-opener:body-v2").prompt).body_findings, [R1]);
  assert.equal(out.result.rounds.code, 1);
});

test("7.3.0 A17: in an update round a tagged-only fix_code with a passing suite becomes approve", async () => {
  const t = upd({ "role:pr-review:v2": REV("changes_requested", [R2]), "role:fleet-code-judge:r2": { status: "ok", reason: "x", verdict: "fix_code", routed_findings: [TAGF], hash_check: { match: true, mismatched: [] }, suite_result: { command: "pytest", exit_code: 0 } } });
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.logs.some((l) => /^role:fleet-code-judge:r2: 1 \[pr_body_claim\] review finding\(s\) dropped .*fix_code -> approve/.test(l)), out.build.logs.join("\n"));
  assert.ok(!out.build.labels.includes("role:fleet-coder:r3"));
});

test("7.3.0 A32: an update round whose commit step commits nothing stops failed, never ok", async () => {
  const t = upd({ "role:pr-review:v2": REV("changes_requested", [R2]), "infra:commit:r2": (p) => ({ status: "ok", reason: "nothing", commit_result: "nothing_to_commit", staged_tree: inputsOf(p).code_tree, worktree_tree: inputsOf(p).code_tree, head: null, head_tree: null }) });
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.match(out.result.reason, /commit_result "nothing_to_commit"/);
});
