// fleet 8.0.0 car B2 (#62): the capped read-only surface steps run in one agent.
// M3: plan mode ran infra:hook-surface:plan, infra:ruleset-surface:plan and infra:pr-convention:plan
// as three agents; now infra:surfaces:plan runs the three programs, each in its own slot
// (hook_surface, ruleset_surface, pr_convention). M4: after a code-judge approve the build ran
// infra:hook-surface:rM, the first approving round's infra:ruleset-surface:rM (only when the plan
// ref seals no ruleset surface) and infra:changed-defs:rM; now infra:surfaces:rM runs them.
// The script still checks each slot at the point where it checked that step before, so the
// order of the stops is unchanged: the obligations route still wins over a callers stop.
//
// ACs (plan-8.0.0-gates.md, B2):
// - B2-1: a plan run drops 2 calls (22 -> 20); 1 of them was capped (17 -> 16): the old
//   infra:pr-convention:plan matched TAIL_RE's infra:pr- and was never capped.
// - B2-2: an approving code round drops 1 (2 in round 1 of a ref that seals no ruleset surface).
// - B2-3 (non-weakening): every hook-surface, ruleset and callers stop test passes with only
//   label or count changes (the old suites, edited for labels only).
// - B2-4: a hook_surface error inside the merged relay reaches its own error branch.
//
// dont_care: the merged prompt's wording outside its commands and slot names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, happy, run, runOne, inputsOf, call, noUnscripted, programOf, programSha, relayDigestOf, K, defsOut, sha256, canon, planRefFor, buildArgs } from "./harness.mjs";

const PROGS = ["hook_surface", "ruleset_surface", "pr_convention", "changed_defs"];
const ran = (prompt) => PROGS.filter((p) => prompt.includes("/" + p + ".py'"));
const OLD = /^infra:(hook-surface|ruleset-surface|pr-convention|changed-defs):(plan|r\d)/;

// a relay as the shipped program prints it (program, file_sha256 and digest)
function relay(name, o) {
  const r = Object.assign({}, o, { program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(name));
  return r;
}
const hsArgs = (p) => [inputsOf(p).worktree, inputsOf(p).rev, JSON.stringify(inputsOf(p).targets)];
const hsRelay = (p, over) => relay("hook_surface", Object.assign({ surface: [], make_paths: {}, error: null, args: hsArgs(p) }, over));
const rsRelay = (p, over) => relay("ruleset_surface", Object.assign({ surface: [], sources: [], read: ["x"], unreadable: [], error: null, args: inputsOf(p).args }, over));
const pcRelay = (p) =>
  relay("pr_convention", {
    title: { style: "conventional", types: ["feat", "fix"], key_required: false },
    body: { template: null, template_repo: null, required_sections: null, min_chars: null, checker: null },
    source: ["title: fallback"],
    unreadable: [],
    args: inputsOf(p).args,
  });

// a plan ref whose plan_facts seal no ruleset surface (sealed before 6.0.0)
async function unsealed(s) {
  const tiny = await planRefFor(s);
  const ref = JSON.parse(s.__store[tiny.plan_commit]);
  delete ref.plan_facts.ruleset_surface;
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  s.__store[tiny.plan_commit] = JSON.stringify(ref) + "\n";
  return buildArgs({ ...tiny, ref_sha256: sha256(s.__store[tiny.plan_commit]) });
}

// one obligation the code judge does not confirm in round 1 (obligations gate: fix_code), then
// a round 2 that passes
function obFail() {
  const s = happy();
  const ob = { id: "OB2", kind: "changelog", rule_source: ".pre-commit-config.yaml:check-changelog", files: ["CHANGELOG.md"], instruction: "add a CHANGELOG line" };
  s["role:scope-and-plan"].repo_obligations = [ob];
  s["role:fleet-code-judge:r1"].obligations_check = [{ id: "OB2", met: false, evidence: "no line" }];
  s["role:fleet-coder:r2"] = { status: "ok", changed_paths: ["src/x.py"] };
  s["hasher:post-coder:r2"] = { status: "ok", fingerprint: { head: PB, tree: "K2" } };
  s["role:fleet-code-judge:r2"] = { status: "ok", verdict: "approve", routed_findings: [], obligations_check: [{ id: "OB2", met: true, evidence: "diff" }] };
  s["hasher:fp-post:code-judge:r2"] = { status: "ok", fingerprint: { head: PB, tree: "K2" } };
  return s;
}

test("8.0.0 B2-1: a plan run is 20 calls; infra:surfaces:plan runs the hook, ruleset and convention programs in that order on sonnet as fleet:judge", async () => {
  const out = await run(happy(), Object.assign({}, ARGS, { confirm: "ask" }));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.plan.calls.length, 20, out.plan.labels.join(", "));
  assert.equal(out.planResult.agents, 20);
  assert.ok(!out.labels.some((l) => OLD.test(l)), out.labels.join(", "));
  const c = call(out, "infra:surfaces:plan");
  assert.deepEqual(ran(c.prompt), ["hook_surface", "ruleset_surface", "pr_convention"]);
  assert.ok(c.prompt.indexOf("hook_surface.py") < c.prompt.indexOf("ruleset_surface.py") && c.prompt.indexOf("ruleset_surface.py") < c.prompt.indexOf("pr_convention.py"));
  assert.equal(c.opts.model, "sonnet");
  assert.equal(c.opts.agentType, "fleet:judge");
  // each program has its own slot in the schema
  for (const k of ["hook_surface", "ruleset_surface", "pr_convention"]) assert.ok(c.opts.schema.required.includes(k), k);
  // the step sits where the three did: after the planner, before the plan hooks
  const L = out.plan.labels;
  assert.equal(L.indexOf("infra:surfaces:plan"), L.indexOf("role:scope-and-plan") + 1);
});

test("8.0.0 B2-2: an approving code round is one agent (hook surface and changed defs); the happy build is 60 calls", async () => {
  const out = await run(happy(), Object.assign({}, ARGS, { confirm: "ask" }));
  noUnscripted(out);
  assert.equal(out.build.calls.length, 60, out.build.labels.join(", "));
  assert.equal(out.result.agents, 59);
  const c = call(out, "infra:surfaces:r1");
  // the plan ref seals the ruleset surface: the build reads none
  assert.deepEqual(ran(c.prompt), ["hook_surface", "changed_defs"]);
  const L = out.build.labels;
  assert.ok(L.indexOf("hasher:fp-post:code-judge:r1") < L.indexOf("infra:surfaces:r1") && L.indexOf("infra:surfaces:r1") < L.indexOf("infra:build-reset:commit:r1"));
});

test("8.0.0 B2-2: a ref that seals no ruleset surface reads it in round 1's merged step (2 agents saved)", async () => {
  const s = happy();
  const out = await runOne(s, await unsealed(s));
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(ran(call(out, "infra:surfaces:r1").prompt), ["hook_surface", "ruleset_surface", "changed_defs"]);
  assert.equal(out.calls.length, 60, out.labels.join(", "));
});

test("8.0.0 B2-3 order: an obligations failure routes to fix_code before a broken changed_defs, ruleset_surface or callers result of the same round is read", async () => {
  // a changed_defs relay with a broken digest and a callers stop in round 1
  for (const r1 of [{ status: "ok", reason: "x", defs: [], excluded: [], unclassified: [], unattributed: [], generated: [], digest: "0".repeat(64) }, defsOut([{ name: "elsewhere", at: "lib/other.py:3", end: 5 }]), { status: "failed", reason: "changed_defs.py exited 1" }]) {
    const s = obFail();
    s["infra:changed-defs:r1"] = r1;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", JSON.stringify(r1) + ": " + out.result.reason);
    assert.equal(out.result.rounds.code, 2);
    assert.ok(out.result.gate_log.some((m) => /code round 1: obligations gate: code-judge approve converted to fix_code/.test(m)));
    assert.ok(out.labels.includes("infra:surfaces:r2"));
    assert.ok(!out.labels.includes("infra:surfaces:r1:digest-retry"), "a changed_defs miss gets no retry (it had none)");
  }
  // a ruleset_surface error in round 1 of a ref that seals none: read again in round 2
  const s = obFail();
  s["infra:ruleset-surface:r1"] = (p) => ({ status: "ok", reason: "read", surface: [], sources: [], read: [], unreadable: [], error: "org rulesets not readable (HTTP 403)", args: inputsOf(p).args });
  const out = await runOne(s, await unsealed(s));
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(ran(call(out, "infra:surfaces:r2").prompt), ["hook_surface", "ruleset_surface", "changed_defs"]);
});

test("8.0.0 B2-3 order: the plan-scope hook gate stops before a broken pr_convention slot is read", async () => {
  const s = happy();
  s["infra:surfaces:plan"] = (p) => ({ status: "failed", reason: "pr_convention.py exited 1", hook_surface: hsRelay(p, { surface: ["tests/"] }), ruleset_surface: rsRelay(p), pr_convention: null });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.match(out.result.reason, /hook change needs Max's confirmation: the plan scope touches/);
  // with no hook path in the plan scope the broken slot halts as the step did
  const t = happy();
  t["infra:surfaces:plan"] = (p) => ({ status: "failed", reason: "pr_convention.py exited 1", hook_surface: hsRelay(p), ruleset_surface: rsRelay(p), pr_convention: null });
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "failed", o2.result.reason);
  assert.match(o2.result.reason, /^infra:surfaces:plan returned failed: pr_convention\.py exited 1/);
});

test("8.0.0 B2-4: a hook_surface error in the merged relay reaches the hooks stop, under an ok and under a failed top level", async () => {
  const err = "repo o/r not readable (HTTP 404)";
  for (const [status, rs] of [["ok", true], ["failed", true], ["failed", false]]) {
    const s = happy();
    s["infra:surfaces:plan"] = (p) => ({ status, reason: "x", hook_surface: hsRelay(p, { error: err }), ruleset_surface: rs ? rsRelay(p) : null, pr_convention: rs ? pcRelay(p) : null });
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human", status + " " + out.result.reason);
    assert.equal(out.result.stop_gate, "hooks");
    assert.ok(out.result.reason.startsWith("hook surface cannot be computed (" + err + "); hook change needs Max's confirmation"), out.result.reason);
    assert.ok(!out.labels.includes("infra:surfaces:plan:digest-retry"));
  }
  // the ruleset_surface error branch too, behind a clean hook surface
  const s = happy();
  s["infra:surfaces:plan"] = (p) => ({ status: "failed", reason: "x", hook_surface: hsRelay(p), ruleset_surface: rsRelay(p, { error: "repo o/r not readable (HTTP None: runtime: out of memory)" }), pr_convention: pcRelay(p) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.stop_gate, "hooks", out.result.reason);
  assert.ok(out.result.reason.startsWith("hook surface cannot be computed (repo o/r not readable (HTTP None: runtime: out of memory)); transient GitHub read failure; re-run"), out.result.reason);
  // in the build too: a hook_surface error at r1
  const b = happy();
  b["infra:hook-surface:r1"] = { status: "ok", reason: "read", surface: [], make_paths: {}, error: err };
  const ob = await run(b, ARGS);
  assert.equal(ob.result.stop_gate, "hooks", ob.result.reason);
  assert.ok(!ob.labels.some((l) => /^infra:commit:/.test(l)));
});

test("8.0.0 B2-4: an error relay with a broken digest gets one retry, then the generic halt (never routed)", async () => {
  const s = happy();
  s["infra:surfaces:plan"] = (p) => {
    const h = hsRelay(p, { error: "x" });
    h.digest = "f".repeat(64);
    return { status: "failed", reason: "the program reported an error", hook_surface: h, ruleset_surface: rsRelay(p), pr_convention: pcRelay(p) };
  };
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.equal(out.labels.filter((l) => l === "infra:surfaces:plan:digest-retry").length, 1, out.labels.join(", "));
  // the generic halt names the step, as before the merge
  assert.ok(out.result.reason.startsWith("infra:surfaces:plan returned failed: the program reported an error"), out.result.reason);
  // an error relay run on other arguments is not routed either
  const t = happy();
  t["infra:surfaces:plan"] = (p) => ({ status: "failed", reason: "y", hook_surface: hsRelay(p), ruleset_surface: rsRelay(p, { error: "x", args: ["/elsewhere", "gh", "o/r", "master"] }), pr_convention: pcRelay(p) });
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.status, "failed", o2.result.reason);
  assert.ok(o2.result.reason.startsWith("infra:surfaces:plan returned failed: y"), o2.result.reason);
});

test("8.0.0 B2-3: a failed top level that no slot explains still halts", async () => {
  const s = happy();
  s["infra:surfaces:plan"] = (p) => ({ status: "failed", reason: "z", hook_surface: hsRelay(p), ruleset_surface: rsRelay(p), pr_convention: pcRelay(p) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:surfaces:plan returned failed: z"), out.result.reason);
  assert.ok(!out.labels.includes("infra:format-plan"));
});

test("8.0.0 B2: every surface program still runs at its sites (plan, the approving round, the unsealed first round)", async () => {
  const out = await run(happy(), ARGS);
  const all = new Set(out.calls.flatMap((c) => ran(c.prompt)));
  assert.deepEqual([...all].sort(), PROGS.slice().sort());
  const s = happy();
  const o2 = await runOne(s, await unsealed(s));
  assert.ok(ran(call(o2, "infra:surfaces:r1").prompt).includes("ruleset_surface"));
});

test("8.0.0 B2 (review): an ok step with a null slot reaches that program's own stop, as its own step did with no program key", async () => {
  // hook_surface: needs_human at hooks (requireProgram, the hooks gate)
  const s = happy();
  s["infra:surfaces:plan"] = (p) => ({ status: "ok", reason: "x", hook_surface: null, ruleset_surface: rsRelay(p), pr_convention: pcRelay(p) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "hooks");
  assert.match(out.result.reason, /infra:surfaces:plan hook_surface: did not run the shipped program hook_surface/);
  // ruleset_surface: the same hooks stop
  const t = happy();
  t["infra:surfaces:plan"] = (p) => ({ status: "ok", reason: "x", hook_surface: hsRelay(p), ruleset_surface: null, pr_convention: pcRelay(p) });
  const o2 = await runOne(t, ARGS);
  assert.equal(o2.result.stop_gate, "hooks", o2.result.reason);
  assert.match(o2.result.reason, /infra:surfaces:plan ruleset_surface: did not run the shipped program ruleset_surface/);
  // changed_defs: the "no defs" halt
  const b = happy();
  b["infra:surfaces:r1"] = (p) => ({ status: "ok", reason: "x", hook_surface: hsRelay(p), changed_defs: null });
  const o3 = await run(b, ARGS);
  assert.equal(o3.result.status, "failed", o3.result.reason);
  assert.match(o3.result.reason, /infra:surfaces:r1 changed_defs returned no defs, excluded, unclassified or unattributed list/);
  assert.ok(!o3.labels.includes("infra:commit:r1"));
});

test("8.0.0 B2 (review): a failed status no slot explains halts before the obligations route skips the later slots", async () => {
  const cd = (p) => {
    const o = { defs: [], excluded: [], unclassified: [], unattributed: [], generated: [], args: undefined };
    delete o.args;
    return relay("changed_defs", o);
  };
  const s = obFail();
  s["infra:surfaces:r1"] = (p) => ({ status: "failed", reason: "w", hook_surface: hsRelay(p), changed_defs: cd(p) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:surfaces:r1 returned failed: w"), out.result.reason);
  assert.ok(!out.labels.includes("role:fleet-coder:r2"), "no fix_code round");
  // a null slot explains it: the obligations route still runs
  const t = obFail();
  t["infra:surfaces:r1"] = (p) => ({ status: "failed", reason: "changed_defs.py exited 1", hook_surface: hsRelay(p), changed_defs: null });
  const o2 = await run(t, ARGS);
  assert.equal(o2.result.status, "ok", o2.result.reason);
  assert.equal(o2.result.rounds.code, 2);
});

test("8.0.0 B2 (review): a failed status no slot explains halts before an npm walk-up finding skips the convention slot", async () => {
  const s = happy();
  s["role:scope-and-plan"] = Object.assign({}, s["role:scope-and-plan"], { test_cmd: { command: "npm test", paths_placeholder: null, env: {}, tools: [] } });
  // no package.json script at HEAD (make_paths names no target): a walk-up finding when the step is ok
  s["infra:surfaces:plan"] = (p) => ({ status: "failed", reason: "v", hook_surface: hsRelay(p), ruleset_surface: rsRelay(p), pr_convention: pcRelay(p) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:surfaces:plan returned failed: v"), out.result.reason);
  assert.ok(!out.labels.includes("role:scope-and-plan:audit-fix"), out.labels.join(", "));
  // an ok step: the walk-up finding as before
  const t = happy();
  t["role:scope-and-plan"] = Object.assign({}, t["role:scope-and-plan"], { test_cmd: { command: "npm test", paths_placeholder: null, env: {}, tools: [] } });
  t["infra:surfaces:plan"] = (p) => ({ status: "ok", reason: "v", hook_surface: hsRelay(p), ruleset_surface: rsRelay(p), pr_convention: pcRelay(p) });
  const o2 = await runOne(t, ARGS);
  assert.ok(o2.labels.includes("role:scope-and-plan:audit-fix"), o2.labels.join(", "));
});
