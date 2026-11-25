// fleet 7.2.0 (L2178, yaadgaar #44) AC9: the update-merge grep infra:callers:u1 takes the disk path
// at path level: the sealed path set per symbol against the summary paths_sha256 (8.9.5, yaadgaar #112:
// the code paths against code_paths_sha256); a line shift
// needs no read; a changed path set reads part paths only; over the budget R5 refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, HASHES, happy, run, inputsOf, callersDisk, callersReadStub } from "./harness.mjs";

// the update-merge fixture of tests/v610_update_coder.test.mjs (T9)
const D = "d".repeat(40);
const C = "c".repeat(40);
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args }, over);
const BEHIND = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
const F1 = { id: "F1", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" };
function upd(symbols, planGrep) {
  const t = happy();
  t["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/w.py"], error: null, args: inputsOf(p).args });
  Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES, changed: ["src/w.py"] },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py", "tests/test_a.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": { status: "ok", reason: "broken", verdict: "changes_requested", findings: [F1], touches_gate: false, checked: [] },
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
  });
  t["role:scope-and-plan"].changed_symbols = symbols;
  t["infra:callers"] = { status: "ok", reason: "grepped", occurrences: planGrep, capped: [], auto_dont_care: {}, doctest_md: [] };
  return t;
}
const GV = (ats) => [{ symbol: "guard_verdict", occurrences: ats.map((at, i) => ({ at, criterion: at.endsWith(".md:3") ? null : "AC" + ((i % 2) + 1), dont_care: at.endsWith(".md:3") ? "a doc" : null })) }];
const SEALED = ["src/a.py:10", "src/y.py:5"];
const SEALED_MD = ["README.md:3", "src/a.py:10", "src/y.py:5"];
const u1Reads = (out) => out.labels.filter((l) => l.startsWith("infra:callers:u1:read:"));
const passed = (out) => out.logs.some((l) => l.includes("R1-R5 pass -> code rounds on the update merge"));

test("7.2.0 AC9: a line shift with the same files needs no read at the update merge", async () => {
  const t = upd(GV(SEALED), { guard_verdict: SEALED });
  callersDisk(t, "infra:callers:u1", { guard_verdict: { hits: ["src/a.py:14", "src/y.py:5"] } });
  const out = await run(t, ARGS);
  assert.ok(out.labels.includes("infra:callers:u1:file"), out.labels.join(", "));
  assert.deepEqual(u1Reads(out), []);
  assert.ok(passed(out), out.logs.join("\n"));
});

test("7.2.0 AC9: a changed path set reads part paths only and joins the moved-file check", async () => {
  const t = upd(GV(SEALED), { guard_verdict: SEALED });
  callersDisk(t, "infra:callers:u1", { guard_verdict: { hits: ["src/a.py:14", "src/w.py:2", "src/y.py:5"] } });
  const out = await run(t, ARGS);
  assert.deepEqual(u1Reads(out), ["infra:callers:u1:read:paths:0"]);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("no coder round: the base change touches files with occurrences of the changed symbols (src/w.py)"), out.result.reason);
});

test("7.2.0 AC9: sealed auto entries count in the path set; a new path reads part paths only, never auto or all", async () => {
  const t = upd(GV(SEALED_MD), { guard_verdict: SEALED_MD });
  callersDisk(t, "infra:callers:u1", { guard_verdict: { hits: ["README.md:3", "src/a.py:14", "src/y.py:5"], auto: ["README.md:3"] } });
  const out = await run(t, ARGS);
  assert.deepEqual(u1Reads(out), []);
  assert.ok(passed(out), out.logs.join("\n"));
  const t2 = upd(GV(SEALED_MD), { guard_verdict: SEALED_MD });
  callersDisk(t2, "infra:callers:u1", { guard_verdict: { hits: ["README.md:3", "src/a.py:14", "src/w.py:2", "src/y.py:5"], auto: ["README.md:3"] } });
  const o2 = await run(t2, ARGS);
  assert.deepEqual(u1Reads(o2), ["infra:callers:u1:read:paths:0"]);
  assert.ok(!o2.labels.some((l) => /:u1:read:(auto|all):/.test(l)));
  assert.equal(o2.result.status, "needs_human", o2.result.reason);
  assert.ok(o2.result.reason.includes("(src/w.py)"), o2.result.reason);
});

test("7.2.0 AC9: differing path sets over the read budget refuse the coder round", async () => {
  const names = ["p_one", "p_two", "p_three"];
  const syms = names.map((x) => ({ symbol: x, occurrences: [{ at: "src/p.py:1", criterion: "AC1", dont_care: null }] }));
  const t = upd(syms, Object.fromEntries(names.map((x) => [x, ["src/p.py:1"]])));
  callersDisk(t, "infra:callers:u1", Object.fromEntries(names.map((x) => [x, { hits: Array.from({ length: 84 }, (_, j) => "src/" + x + "_" + j + ".py:1") }])));
  const out = await run(t, ARGS);
  assert.deepEqual(u1Reads(out), []);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.ok(out.result.reason.includes("the occurrences of p_one, p_three, p_two at the update merge differ from the sealed map and are over the caller read budget"), out.result.reason);
});

test("7.2.0 AC9: control: an ok inline u1 relay takes no file step", async () => {
  const t = upd(GV(SEALED), { guard_verdict: SEALED });
  t["infra:callers:u1"] = { status: "ok", reason: "grepped", occurrences: { guard_verdict: ["src/a.py:14", "src/y.py:5"] }, capped: [], auto_dont_care: {}, doctest_md: [] };
  const out = await run(t, ARGS);
  assert.ok(!out.labels.includes("infra:callers:u1:file"));
  assert.ok(passed(out), out.logs.join("\n"));
});

test("7.2.0 AC9 (non-weakening): a paths read that differs from the summary halts failed", async () => {
  const t = upd(GV(SEALED), { guard_verdict: SEALED });
  callersDisk(t, "infra:callers:u1", { guard_verdict: { hits: ["src/a.py:14", "src/w.py:2", "src/y.py:5"] } });
  t["infra:callers:u1:read:paths:0"] = callersReadStub({ guard_verdict: { hits: ["src/a.py:14", "src/y.py:5", "src/z.py:1"] } });
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:callers:u1:read:paths: the read occurrences of guard_verdict do not match the summary count or sha256"), out.result.reason);
});
