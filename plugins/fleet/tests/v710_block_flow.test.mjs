// fleet 7.1.0 (L2145, yaadgaar #37), AC4: after every accepted pr-opener call
// the workflow runs infra:pr-tests<sfx> on every policy, with args
// [gh_cmd, owner/repo, pr, base64(block), headers_json] and digest id
// 'pr_test_block' (ruling AC4: digestRetry runs). A bad relay stops
// needs_human with stop gate stats; claims_truncated stops with stop gate
// role (fail closed). No PR: a gate line and no step.
//
// Expected values come only from the plan's AC4 examples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, CSHA, happy, run, call, inputsOf, redigest } from "./harness.mjs";

const URL7 = "https://github.com/o/r/pull/7";
const OPEN7 = { status: "ok", reason: "updated", pr_url: URL7, pr_number: 7, created: false, template_used: null, gates_not_run_stated: true };
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const polOut = (caps) => (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, caps), matched: "profile personal", error: null, args: inputsOf(p).args });
const REV = (v, fs) => ({ status: "ok", reason: "x", verdict: v, findings: fs, touches_gate: false, checked: [] });
const NIT = { id: "N1", severity: "nit", category: "style", file: "README.md", line: 1, summary: "typo", evidence: "q" };
const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body overstates", evidence: "npm test" };
const CODE = { id: "R2", severity: "blocking", category: "correctness", file: "src/x.py", line: 3, summary: "empty input passes", evidence: "ran x" };
const JUDGE = (suite) => ({ status: "ok", reason: "good", verdict: "approve", routed_findings: [], hash_check: { match: true, mismatched: [] }, suite_result: suite });

const idx = (out, l) => {
  const i = out.labels.indexOf(l);
  assert.ok(i >= 0, "label " + l + " in " + out.labels.join(", "));
  return i;
};
const count = (out, l) => out.labels.filter((x) => x === l).length;
const hasLog = (out, line) => out.logs.indexOf(line) >= 0;
const blockOf = (out, label) => Buffer.from(inputsOf(call(out, label).prompt).args[3], "base64").toString("utf8");
const forgeAll = (fn) => ({ label: /^infra:pr-tests/, fn });
const forgeFirst = (fn) => ({ label: /^infra:pr-tests/, fn: (r, prompt, real) => (/-retry$/.test(real) ? r : fn(r, prompt, real)) });
const stop = (out, gate, reason) => {
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, gate);
  assert.equal(out.result.reason, reason);
};

function codeFix(s, suite2) {
  const rs = s["hasher:pre-review:v1"];
  return Object.assign(s, {
    "role:pr-review:v1": REV("changes_requested", [CODE]),
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "done", changed_paths: ["src/x.py"], frozen_tests_red_at_start: true, suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": JUDGE(suite2),
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: CSHA(1), tree: "K2" } },
    "infra:push:p2": (prompt) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(prompt).approved_sha }),
    "role:fleet-pr-opener:p2": OPEN7,
    "role:pr-review:v2": REV("approve", []),
  });
}
function bodyFix() {
  const s = happy();
  const rs = s["hasher:pre-review:v1"];
  return Object.assign(s, {
    "role:pr-review:v1": REV("changes_requested", [BODY]),
    "role:fleet-pr-opener:body-v1": OPEN7,
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:pr-review:v2": REV("approve", []),
  });
}

test("AC4 ex1: the happy build runs infra:pr-tests once after the opener, before the pr_open state write", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(count(out, "infra:pr-tests"), 1);
  const t = idx(out, "infra:pr-tests");
  assert.ok(idx(out, "role:fleet-pr-opener") < t);
  assert.ok(t < idx(out, "infra:state:pr_open:p1"));
  const c = call(out, "infra:pr-tests");
  const a = inputsOf(c.prompt).args;
  assert.deepEqual(a, ["gh", "o/r", "7", Buffer.from(blockOf(out, "infra:pr-tests"), "utf8").toString("base64"), "[]"]);
  assert.ok(hasLog(out, "infra:pr-tests: test block written in " + URL7), out.logs.join("\n"));
  assert.equal(c.opts.model, "sonnet");
});

test("AC4 ex2: policy stats false still runs infra:pr-tests; no pr-stats", async () => {
  const s = happy();
  s["infra:policy"] = polOut({ stats: false });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(count(out, "infra:pr-tests"), 1);
  assert.ok(!out.labels.some((l) => l.startsWith("infra:pr-stats")), out.labels.join(", "));
});

test("AC4 ex3: a pr_body_claim body update is followed by infra:pr-tests:body-v1", async () => {
  const out = await run(bodyFix(), ARGS);
  assert.equal(idx(out, "infra:pr-tests:body-v1"), idx(out, "role:fleet-pr-opener:body-v1") + 1);
});

test("AC4 ex4: a review notes update is followed by infra:pr-tests:notes", async () => {
  const out = await run(happy({ script: { "role:pr-review:v1": REV("approve", [NIT]), "role:fleet-pr-opener:notes": OPEN7 } }), ARGS);
  assert.equal(idx(out, "infra:pr-tests:notes"), idx(out, "role:fleet-pr-opener:notes") + 1);
});

test("AC4 ex5: a later suite run of 140 passed gives the p2 block 140 passed", async () => {
  const out = await run(codeFix(happy(), { exit_code: 0, passed: 140, failed: 0, errors: 0 }), ARGS);
  assert.equal(count(out, "infra:pr-tests"), 1);
  assert.equal(count(out, "infra:pr-tests:p2"), 1);
  assert.ok(blockOf(out, "infra:pr-tests:p2").includes("140 passed, 0 failed, 0 errors, 140 total."));
});

test("AC4 ex6: edited false logs 'test block unchanged'", async () => {
  const s = happy();
  s.__mutate = forgeAll((r, prompt, real) => redigest(real, Object.assign(r, { edited: false }), prompt));
  const out = await run(s, ARGS);
  assert.ok(hasLog(out, "infra:pr-tests: test block unchanged in " + URL7), out.logs.join("\n"));
});

// 7.3.0 (#49): changed on purpose: no PR stops the run before the test block (stop gate role)
test("AC4 ex7: no PR: a stop and no infra:pr-tests step", async () => {
  const s = happy({ script: { "role:fleet-pr-opener": Object.assign({}, happy()["role:fleet-pr-opener"], { pr_url: null, pr_number: null }) } });
  const out = await run(s, ARGS);
  assert.equal(out.result.stop_gate, "role", out.result.reason);
  assert.ok(!out.labels.some((l) => l.startsWith("infra:pr-tests")), out.labels.join(", "));
});

test("AC4 ex8: a program error stops needs_human, stop gate stats", async () => {
  const s = happy();
  s.__mutate = forgeAll((r, prompt, real) => redigest(real, Object.assign(r, { error: "gh pr edit: HTTP 422" }), prompt));
  stop(await run(s, ARGS), "stats", "infra:pr-tests: gh pr edit: HTTP 422; check the body of " + URL7);
});

test("AC4 ex9: a block sha that is not the script's block stops", async () => {
  const s = happy();
  s.__mutate = forgeAll((r, prompt, real) => redigest(real, Object.assign(r, { block_sha256: "0".repeat(64) }), prompt));
  stop(await run(s, ARGS), "stats", "infra:pr-tests: the PR body's test block is not the script's block; check " + URL7);
});

test("AC4 ex10: claims that is not a list of strings stops", async () => {
  const s = happy();
  s.__mutate = forgeAll((r, prompt, real) => redigest(real, Object.assign(r, { claims: "x" }), prompt));
  stop(await run(s, ARGS), "stats", "infra:pr-tests: claims is not a list of strings");
});

test("AC4 ex11: claims_truncated stops with stop gate role before any rewrite", async () => {
  const s = happy();
  s.__mutate = forgeAll((r, prompt, real) => redigest(real, Object.assign(r, { claims_truncated: true }), prompt));
  const out = await run(s, ARGS);
  stop(out, "role", "infra:pr-tests: the PR body holds more test-count phrases than the program reports (16384 bytes); remove them from the body of " + URL7 + " by hand, then re-run the build with the same plan_ref");
  assert.ok(!out.labels.includes("role:fleet-pr-opener:counts"), out.labels.join(", "));
});

test("AC4 ex12: a bad digest on the step and its digest retry stops", async () => {
  const s = happy();
  s.__mutate = forgeAll((r) => Object.assign(r, { digest: "f".repeat(64) }));
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("infra:pr-tests:digest-retry"), out.labels.join(", "));
  stop(out, "stats", "infra:pr-tests: the relayed result does not match the program's digest or arguments");
});

test("AC4 ex13: a bad digest that the digest retry fixes goes on", async () => {
  const s = happy();
  s.__mutate = forgeFirst((r) => Object.assign(r, { digest: "f".repeat(64) }));
  const out = await run(s, ARGS);
  assert.equal(count(out, "infra:pr-tests:digest-retry"), 1);
  assert.ok(hasLog(out, "infra:pr-tests: test block written in " + URL7), out.logs.join("\n"));
  assert.equal(out.result.status, "ok", out.result.reason);
});

test("AC4 ex14: other args on the step and its args retry stops", async () => {
  const s = happy();
  s.__mutate = forgeAll((r, prompt, real) => redigest(real, Object.assign(r, { args: ["gh", "o/r", "8"].concat(r.args.slice(3)) }), prompt));
  const out = await run(s, ARGS);
  assert.ok(out.labels.includes("infra:pr-tests:args-retry"), out.labels.join(", "));
  stop(out, "stats", "infra:pr-tests: the relayed result does not match the program's digest or arguments");
});

test("AC4 ex15: a result with no program self-hash stops with stop gate stats", async () => {
  const s = happy();
  s.__mutate = forgeAll((r) => Object.assign(r, { program: { name: null, sha256: null } }));
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "stats");
  assert.ok(out.result.reason.startsWith("infra:pr-tests: "), out.result.reason);
});
