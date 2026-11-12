// fleet 6.1.0 (ledger 2049, strict option b): a re-review after an overlap update-branch that requests
// changes runs ONE delta-scoped coder round on the forge's merge d, but only when the refusal rules R1-R6
// all pass. No re-freeze; ownership checks use d, PR-level checks use the base tip f.base; the push is a
// fast-forward from d; the merge keeps --match-head-commit on the new commit. Also 2051 (D6: fleet_scan
// uses the base tip after an update) and 2052 (N1: a resumed update record with a non-hex sha stops).
// T1, T2, T21 and T22 of the design are the 6.0.1 tests in v601_update.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, HASHES, H, HASHES_FLAT, PB, CSHA, SCRIPTS_SRC, happy, run, call, inputsOf, stateJsonOf, spawnSync } from "./harness.mjs";

const D = "d".repeat(40);
const C = "c".repeat(40);
const C2 = CSHA(2);
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args }, over);
const BEHIND = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
const RED = (p) => {
  const a = inputsOf(p).args;
  const u = "https://github.com/o/r/actions/runs/77/job/88";
  return { status: "ok", reason: "w", state: "red", checks: [{ name: "test", state: "FAILURE", bucket: "fail", url: u }], failed: [{ name: "test", url: u, run_id: "77", verified: true }], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
};
const HASHES_U = H(Object.assign({}, HASHES_FLAT, { "pyproject.toml#tool.pytest": "hp-base" }));
const F1 = { id: "F1", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" };
const NIT = { id: "N1", severity: "nit", category: "style", file: "src/x.py", line: 2, summary: "nit text from the review", evidence: "e" };
const blockingReview = (...f) => ({ status: "ok", reason: "broken", verdict: "changes_requested", findings: f.length ? f : [F1], touches_gate: false, checked: [] });
const approveReview = (...f) => ({ status: "ok", reason: "clean", verdict: "approve", findings: f, touches_gate: false, checked: [] });
const UPD_TEXT = /^re-review after update-branch requested changes: F1 \(1 blocking, 0 nits\); findings are in the run result; no coder round: /;

// personal profile; green PR behind; update-branch moves it to D (merge of the old head and base tip C);
// the base change touches src/x.py (overlap) and moved = `moved`; the re-review u1 (v2) requests changes;
// the coder round r2 runs on D and commits C2; the re-review u2 (v3) approves; CI on C2 is green; merge
function upd(over, moved) {
  const t = happy();
  t["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
  Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES, changed: moved || ["src/x.py"] },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": blockingReview(),
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "role:fleet-coder:r2": { status: "ok", reason: "fixed", changed_paths: ["src/x.py"], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: D, tree: "K2" }, hashes: HASHES, changed: ["src/x.py"] },
    "role:fleet-code-judge:r2": { status: "ok", reason: "good", verdict: "approve", routed_findings: [], suite_result: { command: "pytest", exit_code: 0 } },
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: D, tree: "K2" } },
    "infra:push:p2": (p) => ({ status: "ok", reason: "pushed", push_result: "ok", remote_head: inputsOf(p).approved_sha }),
    "role:fleet-pr-opener:p2": { status: "ok", reason: "updated", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: false, template_used: null, gates_not_run_stated: true },
    "infra:review-paths:v3": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v3": { status: "ok", fingerprint: { head: C2, tree: "K2" } },
    "role:pr-review:v3": approveReview(),
    "hasher:fp-post:pr-review:v3": { status: "ok", fingerprint: { head: C2, tree: "K2" } },
    "infra:review-cleanup:v3": { status: "ok", reason: "clean" },
  });
  return Object.assign(t, over || {});
}
const L_ = (out) => out.build.labels;
const wbCi = (out) => L_(out).filter((l) => l === "infra:ledger-writeback:ci").length;
const wbLine = (out) => inputsOf(call(out, "infra:ledger-writeback:ci").prompt).section_text.split("\n")[0];
function noCoder(out) {
  const L = L_(out);
  assert.ok(!L.some((l) => /^role:fleet-coder:r2|^infra:commit:r2|^infra:pr-merge:u1/.test(l)), L.join(", "));
  // no PR-body write between the re-review and the stop
  assert.ok(!L.slice(L.indexOf("role:pr-review:v2")).some((l) => /^role:fleet-pr-opener/.test(l)), L.join(", "));
  assert.equal(wbCi(out), 1, L.join(", "));
  assert.match(wbLine(out), /; stopped: review$/);
}
async function refused(t, why) {
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review", out.result.reason);
  assert.match(out.result.reason, UPD_TEXT);
  assert.match(out.result.reason, why);
  assert.match(out.result.reason, /; re-plan on the new base or fix by hand$/);
  noCoder(out);
  return out;
}

test("6.1.0 T3: u1 blocking with no refusal: one coder round on d, commit, push p2, re-review u2 on the base tip, merge at the new commit", async () => {
  const out = await run(upd(), ARGS);
  const L = L_(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  for (const l of ["role:fleet-coder:r2", "infra:commit:r2", "infra:push:p2", "role:fleet-pr-opener:p2", "role:pr-review:v3", "infra:pr-merge:u1"]) assert.ok(L.includes(l), l + ": " + L.join(", "));
  assert.ok(L.indexOf("role:pr-review:v2") < L.indexOf("role:fleet-coder:r2") && L.indexOf("infra:commit:r2") < L.indexOf("infra:push:p2") && L.indexOf("role:pr-review:v3") < L.indexOf("infra:pr-merge:u1"), L.join(", "));
  // never re-frozen: no writer, no test judge, no second freeze
  assert.ok(!L.some((l) => /^(role:fleet-test-writer|role:fleet-test-judge|hasher:freeze:f2|infra:freeze-ref:f2)/.test(l) && L.indexOf(l) > L.indexOf("role:pr-review:v2")), L.join(", "));
  assert.equal(inputsOf(call(out, "infra:review-paths:v3").prompt).base_ref, C);
  assert.equal(inputsOf(call(out, "role:pr-review:v3").prompt).base_ref, C);
  assert.deepEqual(inputsOf(call(out, "infra:pr-merge:u1").prompt).args.slice(-1), [C2]);
  assert.equal(inputsOf(call(out, "infra:push:p2").prompt).approved_sha, C2);
  assert.ok(out.result.ci.merged, JSON.stringify(out.result.ci));
  assert.equal(L.filter((l) => l === "infra:pr-update").length, 1);
});

test("6.1.0 T4: a blocking re-review u2 stops with gate review and one CI write-back; no coder round r3", async () => {
  const out = await run(upd({ "role:pr-review:v3": blockingReview() }), ARGS);
  const L = L_(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.match(out.result.reason, UPD_TEXT);
  assert.match(out.result.reason, /review round u2 after update-branch requested changes again/);
  assert.ok(!L.includes("role:fleet-coder:r3"), L.join(", "));
  assert.equal(wbCi(out), 1, L.join(", "));
  assert.match(wbLine(out), /; stopped: review$/);
  assert.ok(!L.slice(L.indexOf("role:pr-review:v3")).some((l) => /^role:fleet-pr-opener/.test(l)), L.join(", "));
});

test("6.1.0 T5 (R1): the base change hits a frozen hashed key: no coder round", async () => {
  const t = upd({ "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES_U, changed: ["src/x.py", "pyproject.toml"] } });
  await refused(t, /the base change hits frozen hashed keys \(the sections map\)/);
});

test("6.1.0 T5 (R1): the u1 hasher diffs the old head against the merge (moved = the net base change)", async () => {
  const out = await run(upd(), ARGS);
  const i = inputsOf(call(out, "hasher:update:u1").prompt);
  assert.equal(i.base_tree, inputsOf(call(out, "infra:pr-update").prompt).args[4]);
});

test("6.1.0 T6 (R2): a moved path on the hook surface at the base tip or at the plan base stops; a moved path off it does not", async () => {
  const hs = (surface) => (p) => ({ status: "ok", reason: "read", surface, make_paths: {}, error: null, args: [inputsOf(p).worktree, inputsOf(p).rev, JSON.stringify(inputsOf(p).targets)] });
  // the surface at the base tip (the adopt-time read) names it
  await refused(upd({ "infra:hook-surface:u1": hs(["tools/lint.sh"]) }, ["src/x.py", "tools/lint.sh"]), /the base change touches the hook surface \(tools\/lint\.sh\)/);
  // the surface at the plan base names it
  const pb = await refused(upd({ "infra:hook-surface:u1:pb": hs(["tools/lint.sh"]) }, ["src/x.py", "tools/lint.sh"]), /hook surface \(tools\/lint\.sh\)/);
  assert.equal(inputsOf(call(pb, "infra:hook-surface:u1:pb").prompt).rev, PB);
  // a hook-config path outside the overlap
  await refused(upd({}, ["src/x.py", ".pre-commit-config.yaml"]), /hook surface \(\.pre-commit-config\.yaml\)/);
  // not on any surface: the coder round runs
  const ok = await run(upd({}, ["src/x.py", "tools/lint.sh"]), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  assert.ok(L_(ok).includes("role:fleet-coder:r2"));
});

test("6.1.0 T7 (R3): a moved IaC or fenced path stops", async () => {
  await refused(upd({}, ["src/x.py", "infra/main.tf"]), /the base change touches fenced or IaC paths \(infra\/main\.tf\)/);
  await refused(upd({}, ["src/x.py", "deploy/.env.prod"]), /fenced or IaC paths \(deploy\/\.env\.prod\)/);
});

// a plan with one obligation whose check_cmd is `cmd`
function withOb(t, cmd) {
  t["role:scope-and-plan"].repo_obligations = [{ id: "OB1", kind: "other", rule_source: "Makefile", files: [], instruction: "lint", check_cmd: cmd }];
  for (const k of ["role:fleet-code-judge:r1", "role:fleet-code-judge:r2"]) t[k] = Object.assign({}, t[k], { obligations_check: [{ id: "OB1", met: true, evidence: "ran", check_exit: 0 }] });
  return t;
}
test("6.1.0 T8 (R4): a moved check_cmd script or make recipe file stops; an unrelated moved file does not", async () => {
  const hs = (mp) => (p) => ({ status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [inputsOf(p).worktree, inputsOf(p).rev, JSON.stringify(inputsOf(p).targets)] });
  const r = await refused(withOb(upd({ "infra:hook-surface:u1:pb": hs({ lint: ["tools/gen.py"] }) }, ["src/x.py", "tools/gen.py"]), "make lint"), /the base change touches files the test or check commands run \(tools\/gen\.py\)/);
  assert.deepEqual(inputsOf(call(r, "infra:hook-surface:u1:pb").prompt).targets, ["lint"]);
  await refused(withOb(upd({}, ["src/x.py", "mk/rules.mk"]), "make lint"), /test or check commands run \(mk\/rules\.mk\)/);
  const t = withOb(upd({}, ["src/x.py", "scripts/check.sh"]), "scripts/check.sh");
  t["infra:check-scripts"] = (p) => ({ status: "ok", reason: "checked", checks: Object.fromEntries(inputsOf(p).paths.map((x) => [x, { ok: true, reason: "ok" }])) });
  for (const m of [1, 2]) t["infra:check-scripts:r" + m] = t["infra:check-scripts"];
  await refused(t, /test or check commands run \(scripts\/check\.sh\)/);
  const ok = await run(withOb(upd({ "infra:hook-surface:u1:pb": hs({ lint: ["tools/gen.py"] }) }, ["src/x.py", "tools/other.py"]), "make lint"), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
});

// a plan that changes guard_verdict (sealed occurrences at src/a.py:10 and src/y.py:5)
const OCC = [{ at: "src/a.py:10", criterion: "AC1", dont_care: null }, { at: "src/y.py:5", criterion: "AC2", dont_care: null }];
function callersOut(occ, capped) {
  return { status: "ok", reason: "grepped", occurrences: occ, capped: capped || [], auto_dont_care: {}, doctest_md: [] };
}
function withSyms(t, regrep) {
  t["role:scope-and-plan"].changed_symbols = [{ symbol: "guard_verdict", occurrences: OCC }];
  t["infra:callers"] = callersOut({ guard_verdict: ["src/a.py:10", "src/y.py:5"] });
  t["infra:callers:u1"] = regrep || callersOut({ guard_verdict: ["src/a.py:10", "src/y.py:5"] });
  return t;
}
test("6.1.0 T9 (R5): a moved file with a sealed occurrence, or with an occurrence the re-grep at d finds, stops; a capped grep stops", async () => {
  // a sealed occurrence in a moved file (the base removed that caller: the grep at d no longer lists it)
  await refused(withSyms(upd({}, ["src/x.py", "src/y.py"]), callersOut({ guard_verdict: ["src/a.py:10"] })), /the base change touches files with occurrences of the changed symbols \(src\/y\.py\)/);
  // a caller the base added
  await refused(withSyms(upd({}, ["src/x.py", "src/z.py"]), callersOut({ guard_verdict: ["src/a.py:10", "src/y.py:5", "src/z.py:3"] })), /occurrences of the changed symbols \(src\/z\.py\)/);
  await refused(withSyms(upd({}, ["src/x.py", "src/z.py"]), callersOut({ guard_verdict: [] }, ["guard_verdict"])), /more than \d+ occurrences/);
  // a caller the base added in the overlap file
  const o = await refused(withSyms(upd({}, ["src/x.py"]), callersOut({ guard_verdict: ["src/a.py:10", "src/x.py:4", "src/y.py:5"] })), /occurrences of the changed symbols \(src\/x\.py\)/);
  assert.equal(inputsOf(call(o, "infra:callers:u1").prompt).symbols[0], "guard_verdict");
});

test("6.1.0 T9 (R5): moved files with no occurrence let the coder round run; the callers re-grep runs only with changed_symbols", async () => {
  const t = withSyms(upd({ "infra:pr-update": (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/w.py"], error: null, args: inputsOf(p).args }) }, ["src/w.py"]));
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(L_(out).includes("infra:callers:u1"));
  const plain = await run(upd(), ARGS);
  assert.ok(!L_(plain).includes("infra:callers:u1"));
});

test("6.1.0 T10 (R6): code judge fix_tests in the update round stops; no test writer, no re-freeze; one CI write-back", async () => {
  const out = await run(upd({ "role:fleet-code-judge:r2": { status: "ok", reason: "tests", verdict: "fix_tests", routed_findings: [{ target: "tests", criterion: "AC1", finding: "x" }] } }), ARGS);
  const L = L_(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.match(out.result.reason, /^code judge returned fix_tests in a code round after update-branch: .*re-plan on the new base or fix by hand$/);
  assert.ok(!L.slice(L.indexOf("role:fleet-code-judge:r2")).some((l) => /^(role:fleet-test-writer|role:fleet-test-judge|hasher:freeze|infra:freeze-ref|infra:commit:r2)/.test(l)), L.join(", "));
  assert.equal(wbCi(out), 1, L.join(", "));
  assert.match(wbLine(out), /; stopped: review$/);
});

test("6.1.0 T11 (R6): code judge plan_wrong in the update round stops; no re-plan", async () => {
  const out = await run(upd({ "role:fleet-code-judge:r2": { status: "ok", reason: "plan", verdict: "plan_wrong", routed_findings: [{ target: "plan", criterion: null, finding: "x" }] } }), ARGS);
  const L = L_(out);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.match(out.result.reason, /^code judge returned plan_wrong in a code round after update-branch: /);
  assert.ok(!L.some((l) => /^infra:replan-|role:scope-and-plan:replan/.test(l)), L.join(", "));
  assert.equal(wbCi(out), 1, L.join(", "));
});

test("6.1.0 T12-T15: the update round's ownership checks use d; the PR-level checks use the base tip", async () => {
  const out = await run(withSyms(upd({ "infra:pr-update": (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/w.py"], error: null, args: inputsOf(p).args }) }, ["src/w.py"])), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  // T12: the post-coder hasher diffs against tree(d), so its changed list is the coder delta
  assert.equal(inputsOf(call(out, "hasher:post-coder:r2").prompt).base_tree, "KU");
  assert.equal(inputsOf(call(out, "hasher:post-coder:r1").prompt).base_tree, PB);
  // T13: the build caller check diffs the base tip against the approved tree
  assert.equal(inputsOf(call(out, "infra:changed-defs:r2").prompt).base, C);
  assert.equal(inputsOf(call(out, "infra:changed-defs:r1").prompt).base, PB);
  // T14: the commit step expects HEAD d
  assert.equal(inputsOf(call(out, "infra:commit:r2").prompt).expected_head, D);
  // T15: the coder diffs against tree(d); the hook surface is read at d
  const ci = inputsOf(call(out, "role:fleet-coder:r2").prompt);
  assert.deepEqual([ci.freeze_tree, ci.freeze_ref, ci.code_base_ref], ["KU", D, D]);
  assert.equal(inputsOf(call(out, "infra:hook-surface:r2").prompt).rev, D);
  // the review findings reach the coder
  assert.match(ci.routed_findings.map((f) => f.finding).join("\n"), /review F1 \[correctness\] src\/x\.py:1: the merge broke x/);
});

test("6.1.0 T12: a moved .github path in the post-coder hasher's changed list (base d) still stops at the fence", async () => {
  const out = await run(upd({ "hasher:post-coder:r2": { status: "ok", fingerprint: { head: D, tree: "K2" }, hashes: HASHES, changed: ["src/x.py", ".github/workflows/x.yml"] } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "scope");
  assert.equal(wbCi(out), 1, L_(out).join(", "));
});

test("6.1.0 T16: the obligations gate in the update round sees the PR net diff and the coder delta", async () => {
  const hs = (mp) => (p) => ({ status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [inputsOf(p).worktree, inputsOf(p).rev, JSON.stringify(inputsOf(p).targets)] });
  // at d, the make recipe runs tests/test_a.py, a file of the PR net diff (u1 review paths) but not of the delta
  const t = withOb(upd({ "infra:hook-surface:r2": hs({ lint: ["tests/test_a.py"] }), "role:fleet-coder:r3": { status: "ok", reason: "x", changed_paths: [] }, "hasher:post-coder:r3": { status: "ok", fingerprint: { head: D, tree: "K3" }, hashes: HASHES, changed: ["src/x.py"] }, "role:fleet-code-judge:r3": { status: "ok", reason: "plan", verdict: "plan_wrong", routed_findings: [] } }), "make lint");
  const out = await run(t, ARGS);
  const L = L_(out);
  assert.ok(L.includes("role:fleet-coder:r3"), L.join(", "));
  assert.match(inputsOf(call(out, "role:fleet-coder:r3").prompt).routed_findings.map((f) => f.finding).join("\n"), /OB1: the change edits tests\/test_a\.py, which check_cmd "make lint" runs/);
});

test("6.1.0 T17: no code round left at u1: stop review, not cap", async () => {
  const fix = { status: "ok", reason: "again", verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "again" }] };
  const t = upd({ "role:fleet-code-judge:r1": fix });
  Object.assign(t, {
    "role:fleet-coder:r2": { status: "ok", reason: "x", changed_paths: ["src/x.py"] },
    "hasher:post-coder:r2": { status: "ok", fingerprint: { head: PB, tree: "K2" }, hashes: HASHES },
    "role:fleet-code-judge:r2": fix,
    "hasher:fp-post:code-judge:r2": { status: "ok", fingerprint: { head: PB, tree: "K2" } },
    "role:fleet-coder:r3": { status: "ok", reason: "x", changed_paths: ["src/x.py"] },
    "hasher:post-coder:r3": { status: "ok", fingerprint: { head: PB, tree: "K3" }, hashes: HASHES },
    "role:fleet-code-judge:r3": { status: "ok", reason: "good", verdict: "approve", routed_findings: [] },
    "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: { head: PB, tree: "K3" } },
  });
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review", out.result.reason);
  assert.match(out.result.reason, /no coder round: no code round left after update-branch \(3 used\)/);
  assert.ok(!L_(out).includes("role:fleet-coder:r4"));
  assert.equal(wbCi(out), 1);
});

test("6.1.0 T18: a stop inside the update coder round (callers) writes exactly one CI write-back", async () => {
  const t = withSyms(upd({ "infra:pr-update": (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/w.py"], error: null, args: inputsOf(p).args }) }, ["src/w.py"]));
  const o = { defs: [{ name: "other_fn", at: "src/w.py:3", end: 9 }], excluded: [], unclassified: [], unattributed: [] };
  t["infra:changed-defs:r2"] = Object.assign({ status: "ok", reason: "listed" }, o);
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "callers", out.result.reason);
  assert.equal(wbCi(out), 1, L_(out).join(", "));
  assert.match(wbLine(out), /; stopped: other$/);
});

test("6.1.0 T19: still behind after the new commit: stop merge, update-branch ran once", async () => {
  const out = await run(upd({ "infra:pr-merge:u1": BEHIND }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "merge");
  assert.match(out.result.reason, /^green, merge blocked: behind/);
  assert.equal(L_(out).filter((l) => l === "infra:pr-update").length, 1);
  assert.equal(wbCi(out), 1);
});

test("6.1.0 T20: CI red caused by the diff on the new commit stops with ci; no coder round r3", async () => {
  const out = await run(upd({ "infra:ci-watch:w2": RED, "role:fleet-ci-classifier:w2": { status: "ok", reason: "c", checks: [{ name: "test", cause: "diff" }] } }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ci");
  assert.match(out.result.reason, /^CI red after update-branch, caused by the diff/);
  assert.ok(!L_(out).includes("role:fleet-coder:r3"));
  assert.equal(inputsOf(call(out, "role:fleet-ci-classifier:w2").prompt).base_ref, C);
  assert.equal(wbCi(out), 1);
});

test("6.1.0 T23: refusal inputs present but the re-review approves: the 6.0.1 merge path is unchanged", async () => {
  const t = upd({ "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES_U, changed: ["src/x.py", "infra/main.tf", ".pre-commit-config.yaml"] }, "role:pr-review:v2": approveReview() });
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "infra:pr-merge:u1").prompt).args.slice(-1), [D]);
  assert.ok(!L_(out).includes("role:fleet-coder:r2"));
  assert.ok(!L_(out).includes("infra:hook-surface:u1:pb"), "the refusal reads run only after a blocking re-review");
});

test("6.1.0 review text never reaches the PR body on the update path: no u1 nits in pr-opener p2, no notes call after u2", async () => {
  const out = await run(upd({ "role:pr-review:v2": blockingReview(F1, NIT), "role:pr-review:v3": approveReview(NIT) }), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const p2 = inputsOf(call(out, "role:fleet-pr-opener:p2").prompt);
  assert.ok(!JSON.stringify(p2.review_notes || []).includes("nit text from the review"), JSON.stringify(p2.review_notes));
  assert.ok(!L_(out).some((l) => /^role:fleet-pr-opener:notes/.test(l) && L_(out).indexOf(l) > L_(out).indexOf("role:pr-review:v2")), L_(out).join(", "));
});

test("6.1.0 D6 (2051): after an update the fleet scan diffs against the base tip it merged; other scans keep the 6.0.1 command", async () => {
  const out = await run(upd(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.match(call(out, "infra:fleet-scan:push:p2").prompt, new RegExp("'" + C2 + "' '" + C + "'"));
  assert.ok(!new RegExp(C).test(call(out, "infra:fleet-scan:push").prompt));
  // a relay that drops the base is refused
  const bad = upd({ "infra:fleet-scan:push:p2": { status: "ok", reason: "scanned", diff: [], commits: [] } });
  const b = await run(bad, ARGS);
  assert.equal(b.result.status, "needs_human");
  assert.equal(b.result.stop_gate, "scope");
  assert.match(b.result.reason, /fleet internal files check did not complete/);
  // a program run on another base (its digest matches its own output) is refused too
  const ob = { diff: [], commits: [], base: "e".repeat(40) };
  const other = await run(upd({ "infra:fleet-scan:push:p2": Object.assign({ status: "ok", reason: "scanned", digest: sha256(canon(ob)) }, ob) }), ARGS);
  assert.equal(other.result.stop_gate, "scope", other.result.reason);
  assert.match(other.result.reason, /fleet internal files check did not complete/);
});

test("6.1.0 D6 (2051): fleet_scan.py with the base tip lists the PR side only; the stale local origin ref lists the base change too", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-610s-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (...a) => {
    const r = spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  // the fleet's workspace step fetched origin/main here
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("checkout", "-q", "-b", "fleet");
  writeFileSync(join(dir, "pr.txt"), "pr\n");
  g("add", "-A");
  g("commit", "-q", "-m", "pr");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "base_only.txt"), "b\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base moves");
  const tip = g("rev-parse", "HEAD");
  g("checkout", "-q", "fleet");
  g("merge", "-q", "--no-edit", "main");
  writeFileSync(join(dir, "fix.txt"), "f\n");
  g("add", "-A");
  g("commit", "-q", "-m", "fix");
  const c = g("rev-parse", "HEAD");
  const scan = (...extra) => spawnSync("python3", ["-I", join(SCRIPTS_SRC, "fleet_scan.py"), dir, "main", c].concat(extra), { encoding: "utf8", env });
  const stale = JSON.parse(scan().stdout);
  assert.deepEqual(stale.diff.sort(), ["base_only.txt", "fix.txt", "pr.txt"]);
  const r = scan(tip);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.diff.sort(), ["fix.txt", "pr.txt"]);
  assert.equal(o.base, tip);
  assert.ok(!o.commits.some((x) => x.sha === tip), JSON.stringify(o.commits));
  assert.ok(!("base" in stale));
  // a base that is not 40 hex, or not a commit here, fails
  assert.notEqual(scan("main").status, 0);
  assert.notEqual(scan("0".repeat(40)).status, 0);
});

// 2052 (N1): a resumed update record with pr_updated true needs two 40-hex shas
function capture(t, labels) {
  const got = {};
  for (const l of labels)
    t[l] = (prompt) => {
      got[l] = stateJsonOf(prompt);
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  return got;
}
test("6.1.0 N1 (2052): a resumed update record whose head is not 40 hex, or no update record with pr_updated true, stops", async () => {
  const t = upd({ "role:pr-review:v2": approveReview() });
  const got = capture(t, ["infra:state:reviewed:v2"]);
  const first = await run(t, ARGS);
  assert.equal(first.result.status, "ok", first.result.reason);
  for (const u of [{ head: "c0ffee", base: C }, { head: null, base: C }, null]) {
    const st = Object.assign({}, got["infra:state:reviewed:v2"], { pr_updated: true, update: u });
    const r = Object.assign(upd({ "role:pr-review:v2": approveReview() }), t);
    r["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { head: D, commits_since: [{ sha: D, subject: "feat(thing): add thing" }], changed_since: ["src/x.py"] });
    r["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: D, message: JSON.stringify(st), head: D, head_tree: "KU", clean: true };
    r["hasher:resume"] = { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: JSON.parse(JSON.stringify(HASHES)) };
    const out = await run(r, { mode: "build", plan_ref: first.plan.result.plan_ref, date: ARGS.date, project: "o/r" });
    assert.equal(out.result.status, "needs_human", JSON.stringify(u) + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "resume", out.result.reason);
    assert.match(out.result.reason, /^run-state mismatch: update record /);
  }
});

// ---------------------------------------------------------------- review of PR #61
import { mkdirSync, existsSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { SOURCE, compile, sha256, canon } from "./harness.mjs";
import { readFileSync } from "node:fs";

test("6.1.0 review B1: the update round's coder and code judge get plan_commit = the base tip", async () => {
  const out = await run(upd(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(inputsOf(call(out, "role:fleet-coder:r2").prompt).plan_commit, C);
  assert.equal(inputsOf(call(out, "role:fleet-code-judge:r2").prompt).plan_commit, C);
  assert.equal(inputsOf(call(out, "role:fleet-coder:r1").prompt).plan_commit, PB);
  assert.equal(inputsOf(call(out, "role:fleet-code-judge:r1").prompt).plan_commit, PB);
});

test("6.1.0 review B2: the fleet scan prompt after an update names base in the printed and returned keys; others do not", async () => {
  const out = await run(upd(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const p2 = call(out, "infra:fleet-scan:push:p2").prompt;
  assert.match(p2, /It prints one JSON object \{diff, commits, base, program, digest\}/);
  assert.match(p2, /Return \{status, reason, diff, commits, base, program, file_sha256, digest\}/);
  const p1 = call(out, "infra:fleet-scan:push").prompt;
  assert.match(p1, /It prints one JSON object \{diff, commits, program, digest\}/);
  assert.match(SOURCE, /\n  fleet_scan: \{[^\n]*\bbase: STR\b/);
});

// a bare origin with core.hooksPath .husky in the fleet worktree; the base adds hooks that write markers
const HOOKS = ["post-merge", "post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc"];
function hookRepos() {
  const root = mkdtempSync(join(tmpdir(), "fleet-610hook-"));
  const env = Object.assign({}, process.env, { HOME: root, GIT_CONFIG_GLOBAL: join(root, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  writeFileSync(join(root, "gc"), "");
  const git = (cwd, ...a) => {
    const r = spawnSync("git", ["-C", cwd].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, a.join(" ") + ": " + r.stderr);
    return r.stdout.trim();
  };
  const origin = join(root, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  const wt = join(root, "wt");
  spawnSync("git", ["clone", "-q", origin, wt], { env });
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "init");
  git(wt, "push", "-q", "origin", "HEAD:main");
  git(wt, "checkout", "-q", "-b", "fleet/k");
  writeFileSync(join(wt, "pr.txt"), "pr\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "pr");
  git(wt, "push", "-q", "origin", "fleet/k");
  git(wt, "config", "core.hooksPath", ".husky");
  const old = git(wt, "rev-parse", "HEAD");
  const other = join(root, "other");
  spawnSync("git", ["clone", "-q", origin, other], { env });
  mkdirSync(join(other, ".husky"));
  for (const h of HOOKS) {
    writeFileSync(join(other, ".husky", h), "#!/bin/sh\necho ran > " + JSON.stringify(join(root, "marker-" + h)) + "\n");
    chmodSync(join(other, ".husky", h), 0o755);
  }
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "base adds hooks");
  git(other, "push", "-q", "origin", "HEAD:main");
  const base = git(other, "rev-parse", "HEAD");
  git(other, "checkout", "-q", "fleet/k");
  git(other, "merge", "-q", "--no-ff", "-m", "Merge branch 'main' into fleet/k", base);
  const neu = git(other, "rev-parse", "HEAD");
  git(other, "push", "-q", "origin", "HEAD:fleet/k");
  return { root, wt, old, base, neu, env, git };
}
test("6.1.0 review B3: pr_state.py fetch runs no repo hook; a base-added hook under an in-tree core.hooksPath writes no marker", () => {
  const h = hookRepos();
  try {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "pr_state.py"), "fetch", h.wt, "fleet/k", h.old, h.neu, h.base], { encoding: "utf8", env: h.env });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual([o.error, o.head], [null, h.neu]);
    assert.ok(existsSync(join(h.wt, ".husky", "post-merge")), "the hook file came in with the merge");
    for (const m of HOOKS) assert.ok(!existsSync(join(h.root, "marker-" + m)), m + " ran in pr_state.py fetch");
    // the programs that read or index the worktree after the fetch run no hook either
    mkdirSync(join(h.root, "scratch"), { recursive: true });
    // review 2: parked.py (git status) and format_files.py (temp-index read-tree and add -A) too
    for (const [prog, args] of [
      ["read_state.py", [h.wt, "refs/fleet/x/state"]],
      ["hasher.py", [h.wt, "[]", "", join(h.root, "scratch")]],
      ["parked.py", ["park", h.wt, "docs/plans/x.md", join(h.root, "scratch"), "n1-0000001"]],
      ["format_files.py", [h.wt, JSON.stringify({ paths: ["a.txt"] }), "[]", join(h.root, "scratch"), "60"]],
    ]) {
      // a stale index stat makes git rewrite the index (the post-index-change channel)
      utimesSync(join(h.wt, "a.txt"), new Date(), new Date(Date.now() + 5000));
      writeFileSync(join(h.wt, "untracked.txt"), prog + "\n");
      spawnSync("python3", ["-I", join(SCRIPTS_SRC, prog)].concat(args), { encoding: "utf8", env: h.env });
      rmSync(join(h.wt, "untracked.txt"), { force: true });
      for (const m of HOOKS) assert.ok(!existsSync(join(h.root, "marker-" + m)), prog + ": " + m + " ran");
    }
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("6.1.0 review S1: code rounds run out inside the update round: stop review (CI stop code review), not cap", async () => {
  const fix = { status: "ok", reason: "again", verdict: "fix_code", routed_findings: [{ target: "code", criterion: null, finding: "again" }] };
  const t = upd({ "role:fleet-code-judge:r2": fix, "role:fleet-coder:r3": { status: "ok", reason: "x", changed_paths: ["src/x.py"] }, "hasher:post-coder:r3": { status: "ok", fingerprint: { head: D, tree: "K3" }, hashes: HASHES, changed: ["src/x.py"] }, "role:fleet-code-judge:r3": fix, "hasher:fp-post:code-judge:r3": { status: "ok", fingerprint: { head: D, tree: "K3" } } });
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review", out.result.reason);
  assert.match(out.result.reason, /^code rounds exhausted \(3\) without code-judge approval in the code rounds after update-branch/);
  assert.match(out.result.reason, /re-plan on the new base or fix by hand$/);
  assert.ok(L_(out).includes("role:fleet-coder:r3") && !L_(out).includes("role:fleet-coder:r4"));
  assert.equal(wbCi(out), 1);
  assert.match(wbLine(out), /; stopped: review$/);
});

test("6.1.0 review S2: R4 derives test_cmd inputs; a shape it cannot read refuses every moved file (fail closed)", async () => {
  const src = SOURCE.replace(/^export const meta/m, "const meta").replace("\nlet input = args;\n", "\nreturn { testCmdRuns };\nlet input = args;\n");
  assert.ok(src.indexOf("return { testCmdRuns };") > 0);
  const { testCmdRuns } = await compile(src)(null, null, null, () => {}, () => {}, {}, {}, {}, Date, Math);
  const runs = (cmd, p, mp) => testCmdRuns(cmd, p, mp || {});
  assert.equal(runs("scripts/test.sh <paths>", "scripts/test.sh"), true);
  assert.equal(runs("scripts/test.sh <paths>", "src/x.py"), false);
  assert.equal(runs("bash scripts/test.sh <paths>", "scripts/test.sh"), true);
  assert.equal(runs("sh ./scripts/t.sh", "scripts/t.sh"), true);
  assert.equal(runs("python3 tools/run_tests.py <paths>", "tools/run_tests.py"), true);
  assert.equal(runs("python3 -m pytest <paths>", "pyproject.toml"), true);
  assert.equal(runs("python3 -m pytest <paths>", "src/x.py"), false);
  assert.equal(runs("uv run pytest <paths>", "uv.lock"), true);
  assert.equal(runs("npm run test:unit", "package.json"), true);
  assert.equal(runs("npm run test:unit", "web/package.json"), true);
  assert.equal(runs("cargo test", "Cargo.toml"), true);
  assert.equal(runs("cargo test", "crates/a/build.rs"), true);
  assert.equal(runs("go test ./...", "go.mod"), true);
  assert.equal(runs("make test", "mk/x.mk"), true);
  assert.equal(runs("make test", "tools/gen.py", { test: ["tools/gen.py"] }), true);
  assert.equal(runs("make test", "src/x.py"), false);
  // shapes it cannot read refuse every file
  for (const c of ["bash", "bash -c x", "weird-runner <paths>", "sh -e scripts/t.sh", ""]) assert.equal(runs(c, "src/anything.py"), true, JSON.stringify(c));
});

test("6.1.0 review S2: R4 refuses a base edit of a make test recipe file", async () => {
  const hs = (mp) => (p) => ({ status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [inputsOf(p).worktree, inputsOf(p).rev, JSON.stringify(inputsOf(p).targets)] });
  const t = upd({ "infra:hook-surface:u1:pb": hs({ test: ["tools/gen.py"] }) }, ["src/x.py", "tools/gen.py"]);
  t["role:scope-and-plan"].test_cmd = { command: "make test", paths_placeholder: null, env: {}, tools: [] };
  const r = await refused(t, /test or check commands run \(tools\/gen\.py\)/);
  assert.deepEqual(inputsOf(call(r, "infra:hook-surface:u1:pb").prompt).targets, ["test"]);
});

test("6.1.0 review N6: R2 includes the ruleset surface", async () => {
  const t = upd({}, ["src/x.py", "tools/rs.sh"]);
  t["infra:ruleset-surface:plan"] = (p) => ({ status: "ok", reason: "read", surface: ["tools/rs.sh"], sources: [{ ruleset_id: 1, name: "R", source_type: "Repository", path: "tools/rs.sh", via: ".github/workflows/r.yml" }], read: ["x"], unreadable: [], error: null, args: inputsOf(p).args });
  await refused(t, /the base change touches the hook surface \(tools\/rs\.sh/);
});

test("6.1.0 review N7: after pr-opener p2 the stats block is written again before the re-review u2", async () => {
  const out = await run(upd({ "role:pr-review:v3": blockingReview() }), ARGS);
  const L = L_(out);
  const i = L.indexOf("role:fleet-pr-opener:p2");
  const s = L.findIndex((l, k) => k > i && /^infra:pr-stats/.test(l));
  assert.ok(i >= 0 && s > i && s < L.indexOf("role:pr-review:v3"), L.join(", "));
});

test("6.1.0 review N8: a stop after the update reports CI not_run for the head nobody watched", async () => {
  const r1 = await run(upd({ "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES_U, changed: ["src/x.py"] } }), ARGS);
  assert.equal(r1.result.stop_gate, "review");
  assert.match(wbLine(r1), /^CI: not_run; /);
  const r2 = await run(upd({ "role:pr-review:v3": blockingReview() }), ARGS);
  assert.match(wbLine(r2), /^CI: not_run; /);
});

test("6.1.0 review N9: review_paths.py lists both sides of a rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-610r-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (...a) => {
    const r = spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "old.py"), "x = 1\n".repeat(20));
  g("add", "-A");
  g("commit", "-q", "-m", "a");
  const a = g("rev-parse", "HEAD");
  g("mv", "old.py", "new.py");
  g("commit", "-q", "-m", "b");
  const b = g("rev-parse", "HEAD");
  g("config", "diff.renames", "true");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "review_paths.py"), dir, a, b], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).changed_paths.sort(), ["new.py", "old.py"]);
});

// ---------------------------------------------------------------- delta review of 8c74456
test("6.1.0 review 2 (S2 wiring): test_cmd pytest <paths> and a base edit of pyproject.toml refuse with the R4 reason", async () => {
  const t = upd({}, ["src/x.py", "pyproject.toml"]);
  assert.equal(t["role:scope-and-plan"].test_cmd, undefined, "the harness default test_cmd is pytest <paths>");
  await refused(t, /the base change touches files the test or check commands run \(pyproject\.toml\)/);
});

// an npm test_cmd; the hook-surface read at d lists what scripts.<name> names
function npmPlan(t, cmd, npmPaths) {
  t["role:scope-and-plan"].test_cmd = { command: cmd, paths_placeholder: null, env: {}, tools: [] };
  t["infra:hook-surface:u1:d"] = (p) => {
    const i = inputsOf(p);
    const mp = {};
    for (const k of i.targets) if (npmPaths !== undefined) mp[k] = npmPaths;
    return { status: "ok", reason: "read", surface: [], make_paths: mp, error: null, args: [i.worktree, i.rev, JSON.stringify(i.targets)] };
  };
  return t;
}
test("6.1.0 review 3: R4 reads scripts.<name> of package.json at d for npm; a target the base edited refuses, a missing entry refuses", async () => {
  const r = await refused(npmPlan(upd({}, ["src/x.py", "scripts/run-tests.mjs"]), "npm run test:unit", ["scripts/run-tests.mjs"]), /test or check commands run \(scripts\/run-tests\.mjs\)/);
  const i = inputsOf(call(r, "infra:hook-surface:u1:d").prompt);
  assert.deepEqual([i.rev, i.targets], [D, ["npm:test:unit"]]);
  // no entry for the script (package.json or the entry unreadable): every moved file refuses
  await refused(npmPlan(upd({}, ["src/x.py"]), "npm test", undefined), /test or check commands run \(src\/x\.py\)/);
  // a moved file the script does not name passes
  const ok = await run(npmPlan(upd({}, ["src/x.py"]), "npm test", ["scripts/run-tests.mjs"]), ARGS);
  assert.equal(ok.result.status, "ok", ok.result.reason);
  // pytest needs no read at d
  const py = await run(upd(), ARGS);
  assert.ok(!L_(py).includes("infra:hook-surface:u1:d"));
});

test("6.1.0 review 3: hook_surface.py lists the paths of an npm script at rev; no entry for a missing script or package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-610npm-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (...a) => {
    const r = spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "run-tests.mjs"), "x\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "test:unit": "node scripts/run-tests.mjs --ci", lint: "x" } }));
  g("add", "-A");
  g("commit", "-q", "-m", "a");
  const hs = (targets) => {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hook_surface.py"), dir, "HEAD", JSON.stringify(targets)], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(hs(["npm:test:unit"]).make_paths, { "npm:test:unit": ["scripts/run-tests.mjs"] });
  assert.deepEqual(hs(["npm:test"]).make_paths, {});
  g("rm", "-q", "package.json");
  g("commit", "-q", "-m", "b");
  assert.deepEqual(hs(["npm:test:unit"]).make_paths, {});
});

test("6.1.0 review 4: treeCmd runs no hook; a post-index-change hook under a custom core.hooksPath writes no marker", async () => {
  const src = SOURCE.replace(/^export const meta/m, "const meta").replace("\nlet input = args;\n", "\nreturn { treeCmd };\nlet input = args;\n");
  const { treeCmd } = await compile(src)(null, null, null, () => {}, () => {}, {}, {}, {}, Date, Math);
  const dir = mkdtempSync(join(tmpdir(), "fleet-610tc-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const wt = join(dir, "wt");
  mkdirSync(join(wt, "tools", "git-hooks"), { recursive: true });
  const marker = join(dir, "marker");
  writeFileSync(join(wt, "tools", "git-hooks", "post-index-change"), "#!/bin/sh\necho ran > " + JSON.stringify(marker) + "\n");
  chmodSync(join(wt, "tools", "git-hooks", "post-index-change"), 0o755);
  writeFileSync(join(wt, "a.txt"), "a\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "a"], ["config", "core.hooksPath", "tools/git-hooks"]]) assert.equal(spawnSync("git", ["-C", wt].concat(a), { env }).status, 0);
  rmSync(marker, { force: true });
  writeFileSync(join(wt, "b.txt"), "b\n");
  const r = spawnSync("sh", ["-c", treeCmd(wt)], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
  assert.ok(!existsSync(marker), "post-index-change ran in treeCmd");
  // control: the same commands with hooks on do fire it (the hook channel is real)
  const on = spawnSync("sh", ["-c", treeCmd(wt).split(" -c core.hooksPath=/dev/null").join("")], { encoding: "utf8", env });
  assert.equal(on.status, 0, on.stderr);
  assert.ok(existsSync(marker), "control: the hook fires without the override");
});

test("6.1.0 review 4: the re-plan reset prompt and the code judge's scratch read-tree run git with hooks off", async () => {
  const jr = readFileSync(join(SCRIPTS_SRC, "..", "roles", "fleet-code-judge.md"), "utf8");
  assert.match(jr, /git -C <scratch>\/<name> -c core\.hooksPath=\/dev\/null read-tree -u --reset <code_tree>/);
  const at = SOURCE.indexOf("function replanResetPrompt(");
  const body = SOURCE.slice(at, SOURCE.indexOf("\n}\n", at));
  assert.match(body, /git -C <main_worktree> -c core\.hooksPath=\/dev\/null branch <superseded_branch> <expected_head>/);
  assert.match(body, /git -C <main_worktree> -c core\.hooksPath=\/dev\/null update-ref <superseded_tree_ref> <expected_tree>/);
});

test("6.1.0 review 5: pr_state.py fetch runs git with core.fsmonitor=false", () => {
  const src = readFileSync(join(SCRIPTS_SRC, "pr_state.py"), "utf8");
  assert.match(src, /g = lambda \*a: run\('-c', 'core\.fsmonitor=false', '-c', 'core\.hooksPath=\/dev\/null', '-C', wt, \*a, cmd='git'\)/);
});

// ---------------------------------------------------------------- third delta review (M1)
test("6.1.0 review M1: hook_surface.py collects pre<name> and post<name> into npm:<name> (npm and yarn v1 run them)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-610pre-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (...a) => {
    const r = spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "tsconfig.build.json"), "{}\n");
  writeFileSync(join(dir, "scripts", "after.mjs"), "x\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { pretest: "tsc -p tsconfig.build.json", test: "node --test", posttest: "node scripts/after.mjs" } }));
  g("add", "-A");
  g("commit", "-q", "-m", "a");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "hook_surface.py"), dir, "HEAD", JSON.stringify(["npm:test"])], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).make_paths, { "npm:test": ["scripts/after.mjs", "tsconfig.build.json"] });
});

test("6.1.0 review M1: a base edit of a file only pretest names refuses the round", async () => {
  // the hook-surface read at d, as the fixed program prints it for {pretest: "tsc -p tsconfig.build.json", test: "node --test"}
  await refused(npmPlan(upd({}, ["src/x.py", "tsconfig.build.json"]), "npm test", ["tsconfig.build.json"]), /test or check commands run \(tsconfig\.build\.json\)/);
});
