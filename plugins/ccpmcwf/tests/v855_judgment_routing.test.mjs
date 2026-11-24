// ccpmcwf 8.5.5 (yaadgaar #108 step 2, ADR-1397): judgment routing, progress fingerprint, fail-fast.
// Plan run wf_a5e02d51-28c spent 2 re-plan rounds on a finding the planner could not fix, then stopped
// with no stop_gate and a raw list of findings. The stop class is fixed in script code at each site:
// (a) planner-contract halts take a re-plan round (MAX_AUDIT_ROUNDS); allowlist halts stay safety stops.
// (b) a finding tagged human_only at its producer stops at round 0, with options.
// (c) a round whose findings repeat the round before stops at once ("no progress"), with options.
// (d) the final plan-findings stop has a stop_gate (`plan` unless the site names one) and options.
// (e) a definite no-push stops plan mode before the planner; an early plan_dsn read sits in the plan
//     surfaces step, and the surfaces and hook gate run before the caller check.
// (f) push-access stops are gate `push`; refs/replace stops are gate `refs`.
//
// Run: node --test plugins/ccpmcwf/tests/v855_judgment_routing.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, FP_TESTS, HASHES_FLAT, H, happy, run, runOne, inputsOf } from "./harness.mjs";

const STOP_GATES = JSON.parse(/const STOP_GATES = (\[[^\]]*\]);/.exec(SOURCE)[1]);
const RE_PLAN = "role:scope-and-plan:audit-fix";
const RE_PLAN_2 = "role:scope-and-plan:audit-fix-2";
const fps = (out) => out.result.gate_log.filter((g) => /^plan findings fingerprint round \d+: [0-9a-f]{16}$/.test(g));
function hasOptions(out) {
  const o = out.result.options;
  assert.ok(Array.isArray(o) && o.length >= 2 && o.length <= 3 && o.every((x) => typeof x === "string" && x.length > 10), JSON.stringify(o));
}
const grep = (capped) => (p) => {
  const syms = inputsOf(p).symbols;
  return { status: "ok", reason: "grepped", occurrences: Object.fromEntries(syms.map((x) => [x, ["src/" + x + ".py:1"]])), capped: syms.filter((x) => capped.indexOf(x) >= 0), auto_dont_care: {}, doctest_md: [] };
};
const one = (x) => ({ symbol: x, occurrences: [{ at: "src/" + x + ".py:1", criterion: "AC1", dont_care: null }] });

// ---------------------------------------------------------------- (a)

test("8.5.5 (a): a planner-contract error takes a re-plan round, then stops with no progress, gate contract and options", async () => {
  const s = happy();
  s["role:scope-and-plan"].plan_diff = [];
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "contract");
  assert.match(out.result.reason, /^role scope-and-plan contract drift: .*no progress/);
  assert.ok(out.labels.includes(RE_PLAN), out.labels.join(", "));
  assert.ok(!out.labels.includes(RE_PLAN_2), out.labels.join(", "));
  hasOptions(out);
});

test("8.5.5 (a): a duplicate criterion id is a re-plan finding; a fixed round reaches confirmation", async () => {
  const s = happy();
  const fixed = JSON.parse(JSON.stringify(s["role:scope-and-plan"]));
  s["role:scope-and-plan"].criteria[1].id = "AC1";
  s[RE_PLAN] = fixed;
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.labels.includes(RE_PLAN));
  const f = inputsOf(out.calls.find((c) => c.label === RE_PLAN).prompt).prior_round.findings.map((x) => x.finding);
  assert.ok(f.some((x) => /duplicate criterion id AC1/.test(x)), f.join("\n"));
});

test("8.5.5 (a): overlapping test_files and a missing tldr are re-plan findings", async () => {
  for (const bad of [(p) => (p.criteria[1].test_files = p.criteria[0].test_files.slice()), (p) => (p.tldr = "")]) {
    const s = happy();
    s[RE_PLAN] = JSON.parse(JSON.stringify(s["role:scope-and-plan"]));
    bad(s["role:scope-and-plan"]);
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
    assert.ok(out.labels.includes(RE_PLAN));
  }
});

test("8.5.5 (a) non-weakening: a refused test_cmd and a refused criterion test_args still stop at round 0, gate commands", async () => {
  const s = happy();
  s["role:scope-and-plan"].test_cmd = { command: "pytest `id`" };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_gate, "commands");
  assert.match(out.result.reason, /test_cmd refused/);
  assert.ok(!out.labels.includes(RE_PLAN));
  const t = happy();
  t["role:scope-and-plan"].criteria[0].test_args = "; rm -rf /";
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "needs_human");
  assert.equal(o2.result.stop_gate, "commands", o2.result.reason);
  assert.ok(!o2.labels.includes(RE_PLAN));
});

// ---------------------------------------------------------------- (b)

test("8.5.5 (b): a human_only finding (too common a name) stops at round 0 with options; no planner runs after it", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("run")];
  s["infra:callers"] = grep(["run"]);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "plan");
  assert.match(out.result.reason, /run: more than 100 call-shaped occurrences.*a human decides/);
  const at = out.labels.indexOf("infra:callers");
  assert.ok(at >= 0);
  assert.ok(!out.labels.slice(at).some((l) => /^role:/.test(l)), out.labels.join(", "));
  hasOptions(out);
  assert.ok(out.result.options.some((x) => /\brun\b/.test(x)), JSON.stringify(out.result.options));
});

test("8.5.5 (b): human_only is set at its producer only (one script site), never read from finding text", () => {
  assert.equal((SOURCE.match(/human_only: true/g) || []).length, 1);
  assert.match(SOURCE, /too common a name to check by grep[^\n]*\n\s*human_only: true/);
});

// ---------------------------------------------------------------- (c)

// identical plan-audit findings every round: 8.5.4 ran 3 planner rounds (30 agents); 8.5.5 stops after round 1
const OLD_AGENTS = 30;
test("8.5.5 (c): identical findings in 2 rounds stop with no progress after round 1, fewer agents than 8.5.4", async () => {
  const s = happy({ script: { "role:plan-audit": { status: "ok", verdict: "plan_defect", routed_findings: [{ target: "plan", criterion: "AC1", finding: "bad" }] } } });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "audit");
  assert.match(out.result.reason, /^plan-audit verdict plan_defect: no progress/);
  assert.ok(out.labels.includes(RE_PLAN) && !out.labels.includes(RE_PLAN_2), out.labels.join(", "));
  assert.ok(out.result.agents < OLD_AGENTS, String(out.result.agents));
  assert.equal(out.result.agents, 24);
  assert.match(out.result.options[0], /settle these findings \(AC1\)/);
  const f = fps(out);
  assert.equal(f.length, 2, out.result.gate_log.join("\n"));
  assert.equal(f[0].split(": ")[1], f[1].split(": ")[1]);
  hasOptions(out);
});

test("8.5.5 (c): findings that change each round still take every round; the cap stop has gate plan and options", async () => {
  const s = happy();
  const nb = (p, i) => (p.criteria[i].text = "a b " + i);
  for (const [l, i] of [["role:scope-and-plan", 0], [RE_PLAN, 1], [RE_PLAN_2, 0]]) {
    s[l] = JSON.parse(JSON.stringify(happy()["role:scope-and-plan"]));
    nb(s[l], i);
  }
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.ok(out.labels.includes(RE_PLAN_2), out.labels.join(", "));
  assert.equal(out.result.stop_gate, "plan");
  assert.match(out.result.reason, /^criteria hold an invisible or confusable character: .*\(after 2 re-plan rounds\)(;|$)/);
  assert.equal(fps(out).length, 3);
  hasOptions(out);
});

// ---------------------------------------------------------------- (d)

test("8.5.5 (d): STOP_GATES names plan, push and refs", () => {
  for (const g of ["plan", "push", "refs"]) assert.ok(STOP_GATES.includes(g), g);
});

// ---------------------------------------------------------------- (e)

const NO_PUSH = [{ cmd: "gh", installed: true, push: false }, { cmd: "gh-personal", installed: true, push: false }];
const UNKNOWN = [{ cmd: "gh", installed: true, push: null }, { cmd: "gh-personal", installed: true, push: null }];

test("8.5.5 (e): a definite no-push stops plan mode before the planner, gate push", async () => {
  const s = happy();
  s.__gh = { "o/r": NO_PUSH };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "push");
  assert.match(out.result.reason, /no GitHub command with push access to o\/r/);
  assert.ok(!out.labels.includes("role:scope-and-plan"), out.labels.join(", "));
});

test("8.5.5 (e): an unknown push check does not stop plan mode (ADR-1201)", async () => {
  const s = happy();
  s.__gh = { "o/r": UNKNOWN };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

const dsnSlot = (holds) => (p) => {
  const i = inputsOf(p);
  return { status: "ok", reason: "read", holds, lines: holds ? [3] : [], plan_sha256: null, args: [i.worktree, "docs/plans/x.md"] };
};

test("8.5.5 (e): a DSN in the planner's draft stops the round before the caller check and the format agent", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("thing")];
  s["infra:callers"] = grep([]);
  s["infra:plan-dsn:plan"] = dsnSlot(true);
  s["infra:plan-dsn:plan:audit-fix"] = dsnSlot(false);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const l = out.labels;
  const re = l.indexOf(RE_PLAN);
  assert.ok(re > 0, l.join(", "));
  assert.ok(!l.slice(0, re).some((x) => /^infra:(callers|format-plan)/.test(x)), l.join(", "));
  assert.ok(l.slice(0, re).includes("infra:surfaces:plan"));
  const src = inputsOf(out.calls[re].prompt).brief.sources.find((x) => x.kind === "text" && /YADGAR_TEST_DSN URL/.test(x.body));
  assert.ok(src, "the planner gets the DSN finding");
});

test("8.5.5 (e): the plan surfaces step and the hook gate run before the caller check", async () => {
  const s = happy();
  s["role:scope-and-plan"].changed_symbols = [one("thing")];
  s["infra:callers"] = grep([]);
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(out.labels.indexOf("infra:surfaces:plan") < out.labels.indexOf("infra:callers"), out.labels.join(", "));
  const g = out.result.gate_log;
  assert.ok(g.findIndex((x) => /^the plan scope: no hook-surface path/.test(x)) < g.findIndex((x) => /^callers: /.test(x)), g.join("\n"));
  const t = happy();
  t["role:scope-and-plan"].changed_symbols = [one("thing")];
  t["role:scope-and-plan"].allowed_additions = { files: [".github/workflows/ci.yml"] };
  t["infra:callers"] = grep([]);
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.stop_gate, "hooks", o2.result.reason);
  assert.ok(!o2.labels.includes("infra:callers"), o2.labels.join(", "));
});

// ---------------------------------------------------------------- (f)

test("8.5.5 (f): every no-push stop is gate push; the refs/replace stops are gate refs", () => {
  for (const m of SOURCE.matchAll(/halt\("needs_human", [^\n]*(noPushText\(|push access to )[^\n]*\);/g)) if (!/, stopGate\);$/.test(m[0])) assert.match(m[0], /"push"\);$/, m[0]);
  assert.match(SOURCE, /ghCmd\("test block", "push"\)/);
  for (const m of SOURCE.matchAll(/halt\("needs_human", [^\n]*refs\/replace[^\n]*\);/g)) assert.match(m[0], /"refs"\);$/, m[0]);
  assert.ok((SOURCE.match(/"push"\);/g) || []).length >= 5);
});

test("8.5.5 (f): a refs/replace ref in the hasher view stops at gate refs", async () => {
  const s = happy();
  s["hasher:post-writers:r1"] = { status: "ok", fingerprint: FP_TESTS, changed: ["tests/test_a.py", "tests/test_b.py"], hashes: H(Object.assign({}, HASHES_FLAT, { ["git:fleetref:refs/replace/" + "c".repeat(40)]: "a".repeat(40) })) };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "refs", out.result.reason);
  assert.match(out.result.reason, /refs\/replace\/c{40} exists/);
});
