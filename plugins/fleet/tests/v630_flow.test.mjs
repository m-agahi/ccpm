// fleet 6.3.0, part A: the flow fixes (ledger 2108; wiki fleet-auto-flow-review-2026-11-13).
//
// A1 (ADR-1238): the caller check runs in dispatches of at most 30 symbols and
//    CALLER_BATCH_OCC mapped occurrences each; no changed_symbols count cap and
//    no "split the task" finding.
// A2: a symbol dropped after a round is a re-plan finding (planFindingsStop).
// A3: an invalid policy.json is the strict default plus a gate line; a bad
//    pre_freeze_hooks list is no list.
// A4: plan mode on a branch with build commits returns resume_with "build".
// A5: one scripted retry at the PR-step push probe, the two pr-opener checks
//    and a test-judge revise with no routed finding.
// A6: a test-judge plan finding takes the plan_wrong re-plan path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARGS, PC, PB, FP_TESTS, SOURCE, SCRIPTS_SRC, happy, run, runOne, call, inputsOf, noUnscripted, criteria, commitStub,
  planRefFor, buildArgs, ghIdOut, scratchRepo, sh, spawnSync,
} from "./harness.mjs";

const num = (name) => Number(new RegExp("\\nconst " + name + " = (\\d+);").exec(SOURCE)[1]);
const SYMBOL_HITS = num("MAX_SYMBOL_HITS");
// re-review: at most 30 symbols per dispatch, no planner weights; callers.py's relay-cap marker splits a batch
const PER = num("CALLER_BATCH_SYMBOLS");

// ---------------------------------------------------------------- A1

const grep = (extra) => (p) => {
  const syms = inputsOf(p).symbols;
  const e = extra || {};
  if (e.over !== undefined && syms.length > e.over) return { status: "failed", reason: "FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap (99999 bytes; symbols: " + syms.join(", ") + ")" };
  return {
    status: "ok",
    reason: "grepped",
    occurrences: Object.fromEntries(syms.map((x) => [x, (e.hits && e.hits[x]) || ["src/" + x + ".py:1"]])),
    capped: syms.filter((x) => (e.capped || []).indexOf(x) >= 0),
    auto_dont_care: Object.fromEntries(syms.filter((x) => e.auto && e.auto[x]).map((x) => [x, e.auto[x]])),
    doctest_md: [],
  };
};
const one = (x) => ({ symbol: x, occurrences: [{ at: "src/" + x + ".py:1", criterion: "AC1", dont_care: null }] });
const labelsOf = (n, sfx) => Array.from({ length: n }, (_, b) => "infra:callers" + (sfx || "") + (b ? ":b" + (b + 1) : ""));
const script = (s, n, extra, sfx) => {
  for (const l of labelsOf(n, sfx)) s[l] = grep(extra);
};

test("6.3.0 A1 (re-review): a dispatch holds at most 30 symbols, with no planner weights; no symbol-count cap", () => {
  assert.equal(PER, 30);
  assert.ok(!/MAX_CHANGED_SYMBOLS|split the task|occWeight|CALLER_BATCH_OCC/.test(SOURCE));
});

test("6.3.0 A1 (ADR-1238): 31 changed symbols are checked in 2 dispatches (30 + 1), however many lines each maps", async () => {
  const s = happy();
  const syms = Array.from({ length: 31 }, (_, i) => "f" + i);
  const hits = { f0: Array.from({ length: 100 }, (_, j) => "src/f0.py:" + (j + 1)) };
  s["role:scope-and-plan"].changed_symbols = syms.map((x) => (hits[x] ? { symbol: x, occurrences: hits[x].map((at) => ({ at, criterion: "AC1", dont_care: null })) } : one(x)));
  script(s, 2, { hits });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(inputsOf(call(out, "infra:callers").prompt).symbols, syms.slice(0, 30));
  assert.deepEqual(inputsOf(call(out, "infra:callers:b2").prompt).symbols, ["f30"]);
  assert.ok(!out.labels.includes("infra:callers:b3"));
  assert.ok(out.logs.includes("infra:callers: 31 symbols in 2 caller-check dispatches (at most 30 symbols each)"), out.logs.join("\n"));
});

test("6.3.0 A1 (re-review): a batch of 30 over the relay cap splits in halves until each part fits; one symbol alone over it stops with its name", async () => {
  const s = happy();
  const syms = Array.from({ length: 30 }, (_, i) => "g" + i);
  s["role:scope-and-plan"].changed_symbols = syms.map(one);
  script(s, 7, { over: 8 });
  const out = await runOne(s, ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const sizes = out.calls.filter((c) => /^infra:callers/.test(c.label)).map((c) => inputsOf(c.prompt).symbols.length);
  assert.deepEqual(sizes, [30, 15, 7, 8, 15, 7, 8]);
  const done = out.calls.filter((c) => /^infra:callers/.test(c.label)).map((c) => inputsOf(c.prompt).symbols).filter((x) => x.length <= 8).flat();
  assert.deepEqual(done, syms);
  assert.ok(out.logs.includes("infra:callers: 30 symbols are over the relay cap; split in two"), out.logs.join("\n"));
  // a single symbol over the cap
  const t = happy();
  t["role:scope-and-plan"].changed_symbols = ["big", "b2"].map(one);
  script(t, 3, { over: 0 });
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.stop_gate, "callers");
  assert.match(o2.result.reason, /: the occurrences of big are over the 65536-byte relay cap \(relay size; at most 100 hits, long paths\)/);
});

test("6.3.0 A1: the batches merge: a later batch's auto dont_care and capped symbol count as in one dispatch", async () => {
  const s = happy();
  const syms = Array.from({ length: 31 }, (_, i) => "f" + i);
  s["role:scope-and-plan"].changed_symbols = syms.map(one);
  script(s, 2, { hits: { f30: ["src/f30.py:1", "README.md:3"] }, auto: { f30: ["README.md:3"] } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.some((l) => /^callers: .*f30 1 occurrence\(s\) mapped; git grep -w agrees; 1 doc or lock hit\(s\) mapped/.test(l)), out.logs.join("\n"));
  const t = happy();
  t["role:scope-and-plan"].changed_symbols = syms.map(one);
  for (const sfx of ["", ":audit-fix", ":audit-fix-2"]) script(t, 2, { capped: ["f30"], hits: { f30: [] } }, sfx);
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.match(o2.result.reason, /f30: more than 100 occurrences \(git grep -w\)/);
});

// callers.py run for real
const CALLERS = join(SCRIPTS_SRC, "callers.py");
function callersRun(wt, syms) {
  const r = spawnSync("python3", ["-I", CALLERS, wt, "docs/plans/x.md", JSON.stringify(syms), String(SYMBOL_HITS)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { text: r.stdout, out: JSON.parse(r.stdout) };
}

test("6.3.0 A1: callers.py per symbol does not depend on the batch: 31 symbols in one run equal a 30 + 1 split", () => {
  const wt = scratchRepo("fleet-630-callers-");
  try {
    const syms = Array.from({ length: 31 }, (_, i) => "sym_" + i);
    mkdirSync(join(wt, "src"));
    for (let f = 0; f < 4; f++) writeFileSync(join(wt, "src", "m" + f + ".py"), syms.map((x, i) => (i % 4 === f ? x + "()\n" : "pass\n")).join(""));
    writeFileSync(join(wt, "README.md"), "sym_30 and sym_2\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const all = callersRun(wt, syms).out;
    const a = callersRun(wt, syms.slice(0, 30)).out;
    const b = callersRun(wt, syms.slice(30)).out;
    assert.deepEqual(Object.assign({}, a.occurrences, b.occurrences), all.occurrences);
    assert.deepEqual(Object.assign({}, a.auto_dont_care, b.auto_dont_care), all.auto_dont_care);
    assert.deepEqual(a.capped.concat(b.capped).sort(), all.capped);
    assert.deepEqual(Array.from(new Set(a.doctest_md.concat(b.doctest_md))).sort(), all.doctest_md);
    assert.deepEqual(all.auto_dont_care.sym_30, ["README.md:1"]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("6.3.0 A1 (ADR-1195 measure): 4 symbols x 100 hits relay about 24 KB; a full batch of 30 x 100 is over the cap and prints the marker", () => {
  const wt = scratchRepo("fleet-630-size-");
  try {
    const per = SYMBOL_HITS;
    const n = PER;
    const syms = Array.from({ length: n }, (_, i) => "sym_name_" + i + "_long_identifier");
    for (let f = 0; f < 50; f++) {
      const d = join(wt, "src/services/module_" + (f % 10) + "/handlers");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "request_handler_" + String(f).padStart(2, "0") + ".py"), syms.map((x) => "x = " + x + "(1)\ny = " + x + "(2)\n").join(""));
    }
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const r = callersRun(wt, syms.slice(0, 4));
    const occ = Object.values(r.out.occurrences).reduce((a, v) => a + v.length, 0);
    assert.equal(occ, 4 * per);
    const bytes = Buffer.byteLength(r.text);
    assert.ok(bytes < 32768, bytes + " bytes for " + occ + " occurrences");
    const full = spawnSync("python3", ["-I", CALLERS, wt, "docs/plans/x.md", JSON.stringify(syms), String(per)], { encoding: "utf8" });
    assert.notEqual(full.status, 0);
    assert.match(full.stderr, /^FLEET_CALLERS_RELAY_CAP: .*\(\d+ bytes; symbols: sym_name_0_long_identifier/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- A2

const REFUSE = (finding) => ({ status: "ok", reason: "defect", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding }] });
const planRound = (s, over) => Object.assign({}, s["role:scope-and-plan"], over);

test("6.3.0 A2: a symbol dropped after a round is a re-plan finding; a round that restores it goes on", async () => {
  const s = happy();
  const map = (...xs) => xs.map(one);
  s["role:scope-and-plan"].changed_symbols = map("foo");
  s["role:scope-and-plan:audit-fix"] = planRound(s, { changed_symbols: map("bar") });
  s["role:scope-and-plan:audit-fix-2"] = planRound(s, { changed_symbols: map("foo", "bar") });
  for (const sfx of ["", ":audit-fix", ":audit-fix-2"]) s["infra:callers" + sfx] = grep();
  s["role:plan-audit"] = REFUSE("r0");
  s["role:plan-audit:audit-fix-2"] = { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.logs.includes("changed_symbols dropped a symbol of an earlier round: re-plan round 2 of 2 with the findings"), out.logs.join("\n"));
  const pr = inputsOf(call(out, "role:scope-and-plan:audit-fix-2").prompt).prior_round;
  assert.ok(pr.symbols.includes("foo"));
  assert.ok(pr.findings.some((f) => f.symbol === "foo" && /^changed_symbols dropped foo after the /.test(f.finding)), JSON.stringify(pr.findings));
  // the round-1 drop ran no plan audit for that round
  assert.ok(!out.labels.includes("role:plan-audit:audit-fix"));
});

// ---------------------------------------------------------------- A3

const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
function policyPy(doc) {
  const home = mkdtempSync(join(tmpdir(), "fleet-630pol-"));
  try {
    mkdirSync(join(home, ".config", "fleet"), { recursive: true });
    writeFileSync(join(home, ".config", "fleet", "policy.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "policy.py"), "github.com", "yadgarhq/iam-db"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("6.3.0 A3: policy.py: an invalid file prints the strict default caps (no pre_freeze_hooks list) with the error", () => {
  for (const doc of ["{", { version: 2, profiles: [] }, { version: 1, profiles: [{ name: "p", match: { owners: ["yadgarhq"] }, merge: "sometimes" }] }, { version: 1, profiles: [{ name: "p", match: { owners: ["yadgarhq"] }, repos: { "yadgarhq/iam-db": { pre_freeze_hooks: "fmt" } } }] }]) {
    const o = policyPy(doc);
    assert.ok(o.error, JSON.stringify(doc));
    assert.deepEqual(o.caps, DEFAULT_CAPS, JSON.stringify(doc));
    assert.equal(o.profile, null);
  }
});

const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/.config/fleet/policy.json", policy_sha256: "d".repeat(64), caps: Object.assign({}, DEFAULT_CAPS), matched: null, error: null, args: inputsOf(p).args }, over);

test("6.3.0 A3: an invalid policy file builds with the strict default and a gate line; no policy stop", async () => {
  const s = happy();
  const err = "policy file /h/.config/fleet/policy.json: profiles[0].merge must be one of never|auto";
  s["infra:policy"] = polOut({ error: err });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.logs.includes("policy: " + err + "; the strict default applies (pr_ready true, ci_watch true 60 min, stats true, merge never, update_branch never, ci_trigger false, review_post none); fix or remove the file"), out.build.logs.join("\n"));
  assert.deepEqual(out.result.policy.caps, DEFAULT_CAPS);
});

test("6.3.0 A3: a sealed pre_freeze_hooks that is not a list of hook ids is no list (a gate line), never a stop", async () => {
  for (const bad of ["fmt", ["a b"], [""], ["-x"]]) {
    const s = happy();
    s["infra:policy"] = polOut({ error: null, matched: "profile p", caps: Object.assign({}, DEFAULT_CAPS, { pre_freeze_hooks: bad }) });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", JSON.stringify(bad) + ": " + out.result.reason);
    assert.ok(out.build.logs.some((l) => l.startsWith("policy: pre_freeze_hooks " + JSON.stringify(bad) + " is not a list of hook ids; the strict default (no pre-freeze hook) applies")), out.build.logs.join("\n"));
    assert.ok(!("check_hooks" in inputsOf(call(out, "infra:format-tests:r1").prompt).select));
  }
});

// ---------------------------------------------------------------- A4

const META = { name: "refs/fleet/l42/plan", tag_sha: "7".repeat(40), type: "tag", target: "2222222", target_type: "commit", sha256: "a".repeat(64), task_id: "l42", plan_path: "docs/plans/x.md", ref_ok: true };

test("6.3.0 A4: plan mode on a branch with build commits and its sealed plan ref returns resume_with build and that plan_ref", async () => {
  const s = happy();
  s["infra:branch-scan"] = { status: "ok", reason: "scanned", head: PB, commits: [{ sha: "1111111", subject: "feat(thing): add thing", files: ["src/x.py"] }], refs: [META] };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "resume");
  assert.equal(out.result.resume_with, "build");
  assert.deepEqual(out.result.plan_ref, { branch: "fleet/l42-add-thing", plan_commit: "2222222", plan_ref: "refs/fleet/l42/plan", ref_sha256: "a".repeat(64), repo: "/r" });
  assert.match(out.result.reason, /^branch has build commits; resume_with build: run build with plan_ref refs\/fleet\/l42\/plan/);
  assert.ok(!out.labels.includes("role:scope-and-plan"));
  // no usable plan ref: the stop as before
  for (const refs of [[], [{ ...META, ref_ok: false }], [{ ...META, task_id: "l43" }], [{ ...META, name: "refs/fleet/l42/plan-1" }], [{ ...META, sha256: "x" }]]) {
    s["infra:branch-scan"] = { status: "ok", reason: "scanned", head: PB, commits: [{ sha: "1111111", subject: "feat(thing): add thing", files: ["src/x.py"] }], refs };
    const o = await runOne(s, ARGS);
    assert.equal(o.result.status, "needs_human", JSON.stringify(refs));
    assert.ok(!("resume_with" in o.result), JSON.stringify(refs));
    assert.match(o.result.reason, /branch has build commits; run build, or delete branch/);
  }
});

// ---------------------------------------------------------------- A5

const UNKNOWN = [{ cmd: "gh", installed: true, push: null }, { cmd: "gh-personal", installed: true, push: null }];
const reprobe = (tried) => (p) => Object.assign({ status: "ok", reason: "checked" }, ghIdOut(inputsOf(p).args, null, { "o/r": tried }));

test("6.3.0 A5: push access still unknown at the PR re-probe: one scripted retry of the probe; push true -> the PR opens", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  s["infra:gh-identity:pr"] = reprobe(UNKNOWN);
  s["infra:gh-identity:pr-2"] = reprobe([{ cmd: "gh", installed: true, push: true }]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.build.labels.indexOf("infra:gh-identity:pr-2") < out.build.labels.indexOf("role:fleet-pr-opener"));
  assert.ok(out.build.logs.some((l) => /^PR step: push access to o\/r still not known \(.*\); one scripted retry of the probe$/.test(l)));
});

const OPENER = { status: "ok", reason: "opened", pr_url: "https://github.com/o/r/pull/7", pr_number: 7, created: true, template_used: null, gates_not_run_stated: true };

test("6.3.0 A5: a pr-opener title or gates_not_run miss gets one scripted retry on the same PR; fixed -> the build goes on", async () => {
  for (const [bad, re] of [[{ title: "feat(l42): add thing" }, /^pr-opener set the PR title/], [{ gates_not_run_stated: false }, /^pr-opener did not state gates_not_run/]]) {
    const s = happy();
    s["role:fleet-pr-opener"] = Object.assign({}, OPENER, bad);
    s["role:fleet-pr-opener:again"] = Object.assign({}, OPENER, { created: false });
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", out.result.reason);
    const i = inputsOf(call(out, "role:fleet-pr-opener:again").prompt);
    assert.equal(i.pr_url, OPENER.pr_url);
    assert.equal(i.pr_number, 7);
    assert.match(i.retry_reason, re);
    assert.equal(out.result.pr_url, OPENER.pr_url);
    // wrong twice: the stop as before
    const t = happy();
    t["role:fleet-pr-opener"] = Object.assign({}, OPENER, bad);
    t["role:fleet-pr-opener:again"] = Object.assign({}, OPENER, bad);
    const o2 = await run(t, ARGS);
    assert.equal(o2.result.status, "needs_human");
    assert.match(o2.result.reason, re);
  }
});

test("6.3.0 A5: a test-judge revise that routes no finding to a known criterion gets one scripted retry of the judge", async () => {
  const s = happy();
  s["role:fleet-test-judge:r1"] = { status: "ok", reason: "weak", verdict: "revise", routed_findings: [{ target: "tests", criterion: "AC9", finding: "x" }], checked: [] };
  s["role:fleet-test-judge:r1:again"] = { status: "ok", reason: "good", verdict: "approve", routed_findings: [], checked: [] };
  s["hasher:fp-post:test-judge:r1:again"] = { status: "ok", fingerprint: FP_TESTS };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.match(inputsOf(call(out, "role:fleet-test-judge:r1:again").prompt).retry_reason, /^test-judge revise r1 routed no finding to a known criterion/);
  // again no routed finding: the stop as before
  s["role:fleet-test-judge:r1:again"] = s["role:fleet-test-judge:r1"];
  const o2 = await run(s, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.reason, "test-judge revise r1 routed no finding to a known criterion");
});

// ---------------------------------------------------------------- A6

const PC2 = "0123456789ab";
test("6.3.0 A6: a test-judge plan finding takes the plan_wrong re-plan path (re-plan, save the old head, ask for confirmation)", async () => {
  const s = happy();
  const f = { target: "plan", criterion: "AC2", finding: "AC2 cannot be tested — Proposed plan change: split AC2" };
  Object.assign(s, {
    "role:fleet-test-judge:r1": { status: "ok", reason: "plan", verdict: "revise", routed_findings: [f], checked: [] },
    "infra:replan-worktree": { status: "ok", reason: "ok", head: PC },
    "role:scope-and-plan:replan": Object.assign({}, s["role:scope-and-plan"], { tldr: "re-planned" }),
    "role:plan-audit:replan": { status: "ok", reason: "fine", verdict: "approve", routed_findings: [] },
    "infra:stage-plan:replan": { status: "ok", reason: "staged", plan_sha256: "d".repeat(64) },
    "infra:commit-plan:replan": commitStub(s.__store, PC2, "d".repeat(64)),
    "infra:replan-reset": { status: "ok", reason: "reset", head: PB, superseded_head: "5555555" },
  });
  const ref = await planRefFor(s);
  const out = await runOne(s, buildArgs(ref));
  noUnscripted(out);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.match(out.result.reason, /^test-judge plan_wrong: re-planned; confirm the proposed plan change/);
  assert.deepEqual(out.result.proposed_plan_change, ["split AC2"]);
  assert.deepEqual(inputsOf(call(out, "infra:replan-reset").prompt).expected_tree, FP_TESTS.tree);
  assert.ok(!out.labels.some((l) => /^hasher:freeze/.test(l)), "no freeze");
  assert.ok(!out.labels.includes("role:fleet-coder:r1"));
  const pin = inputsOf(call(out, "role:scope-and-plan:replan").prompt);
  assert.ok(pin.brief.sources.some((x) => x.ref === "test-judge plan findings"));
});

// ---------------------------------------------------------------- D (6.2.2 carry-over lows)

const POL_HOOKS = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: "f".repeat(64), caps: Object.assign({}, DEFAULT_CAPS, { pre_freeze_hooks: ["cargo-fmt"] }), matched: "profile personal", error: null, args: inputsOf(p).args });
const hookOut = (p, over) => Object.assign({ status: "ok", reason: "ran", note: "ran pre-commit run --files in a scratch checkout of HEAD", ran: true, runs: 1, stable: true, files: inputsOf(p).select.paths || [], changed: [], refused: [], purged: 0, purged_paths: [], hook_failed: false, hook_failures: [], hook_head: "", hook_sha256: "", hook_timeout: [], fix_timeout: false, unknown_hooks: [] }, over);

test("6.3.0 D low 1: a check-phase timeout names the fixer time and the ceiling cut (format_files note)", async () => {
  const note = "ran pre-commit run --files in a scratch checkout of HEAD; the fixer runs took 541 s, so the check phase had 29 s (cut by the 570 s step ceiling)";
  const out = await run(happy({ script: { "infra:policy": POL_HOOKS, "infra:format-tests:r1": (p) => hookOut(p, { hook_timeout: ["cargo-fmt"], note }) } }), ARGS);
  assert.equal(out.result.stop_gate, "hooks");
  assert.match(out.result.reason, /check phase ran out of time: cargo-fmt \(each run at most 180 s, the check phase at most 240 s; the fixer runs took 541 s, so the check phase had 29 s \(cut by the 570 s step ceiling\)\)/);
  // format_files.py: the note carries the timing only on a check timeout, and no isolated checkout starts once the budget is spent
  const src = readFileSync(join(SCRIPTS_SRC, "format_files.py"), "utf8");
  assert.match(src, /\(TIMING\[0\] if TIMED_OUT else ''\)/);
  const iso = src.slice(src.indexOf("def isolated(hid, f):"), src.indexOf("def isolated(hid, f):") + 400);
  assert.ok(iso.indexOf("if check_end - time.monotonic() < 1:") >= 0 && iso.indexOf("if check_end - time.monotonic() < 1:") < iso.indexOf("'worktree', 'add'"), iso);
});

// format_files.py run for real (a copy with a small check budget) with a fake pre-commit whose check hook sleeps
function slowHookRun(budget, ceiling) {
  const home = mkdtempSync(join(tmpdir(), "fleet-630-fmt-"));
  try {
    const wt = join(home, "repo");
    const bin = join(home, "bin");
    mkdirSync(join(wt, "tests"), { recursive: true });
    mkdirSync(bin);
    sh(wt, "git", "init", "-q");
    sh(wt, "git", "config", "user.email", "t@example.com");
    sh(wt, "git", "config", "user.name", "t");
    sh(wt, "git", "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, ".pre-commit-config.yaml"), "repos:\n  - repo: local\n    hooks:\n      - id: slow\n        name: slow\n        entry: slow\n        language: system\n");
    writeFileSync(join(wt, "src.py"), "x = 1\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    writeFileSync(join(bin, "pre-commit"), "#!/bin/sh\nif [ \"$2\" = slow ]; then sleep 6; fi\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(wt, "tests", "test_a.py"), "def test_a():\n    assert 1\n");
    const prog = readFileSync(join(SCRIPTS_SRC, "format_files.py"), "utf8").replace("\nCHECK_BUDGET = 240\n", "\nCHECK_BUDGET = " + budget + "\n").replace("\nSTEP_CEILING = 570\n", "\nSTEP_CEILING = " + ceiling + "\n");
    assert.ok(prog.includes("CHECK_BUDGET = " + budget) && prog.includes("STEP_CEILING = " + ceiling));
    const copy = join(home, "format_files.py");
    writeFileSync(copy, prog);
    const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH });
    const r = spawnSync("python3", ["-I", copy, wt, JSON.stringify({ paths: ["tests/test_a.py"], check_hooks: ["slow"] }), "[]", join(home, "scratch"), "60"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("6.3.0 D low 1: format_files.py, run for real: a check timeout names the fixer time; 'cut by the ceiling' only when the ceiling bound", () => {
  const free = slowHookRun(2, 570);
  assert.deepEqual(free.hook_timeout, ["slow"], free.note);
  assert.match(free.note, /; the fixer runs took \d+ s, so the check phase had [12] s$/);
  assert.doesNotMatch(free.note, /cut by/);
  const cut = slowHookRun(30, 1);
  assert.deepEqual(cut.hook_timeout, ["slow"], cut.note);
  assert.match(cut.note, /; the fixer runs took \d+ s, so the check phase had [01] s \(cut by the 1 s step ceiling\)$/);
});

test("6.3.0 A1 (review M1): callers.py prints no output over the relay cap: it exits with the FLEET_CALLERS_RELAY_CAP marker", () => {
  const wt = scratchRepo("fleet-630-cap-");
  try {
    const d = join(wt, ...Array.from({ length: 3 }, (_, k) => "d".repeat(200) + k));
    mkdirSync(d, { recursive: true });
    for (let f = 0; f < 100; f++) writeFileSync(join(d, "m" + String(f).padStart(3, "0") + "_" + "x".repeat(60) + ".py"), "huge_symbol()\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "x");
    const r = spawnSync("python3", ["-I", CALLERS, wt, "docs/plans/x.md", JSON.stringify(["huge_symbol"]), String(SYMBOL_HITS)], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap \(\d+ bytes; symbols: huge_symbol\)/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- review M2

test("6.3.0 review M2: a pr-opener retry that names another PR stops", async () => {
  const s = happy();
  s["role:fleet-pr-opener"] = Object.assign({}, OPENER, { title: "feat(l42): add thing" });
  s["role:fleet-pr-opener:again"] = Object.assign({}, OPENER, { pr_url: "https://github.com/o/r/pull/8", pr_number: 8, created: true });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^pr-opener retry named https:\/\/github\.com\/o\/r\/pull\/8 \(#8\), not https:\/\/github\.com\/o\/r\/pull\/7 \(#7\)/);
});
