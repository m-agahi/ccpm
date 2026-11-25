// ccpmcwf 8.9.2 (yaadgaar #116, #108 follow-ups batch A; ADR-1409, ADR-1406).
// (a) the relaxed re-plan list is sealed in the plan ref; the build-mode :rerun auto gates re-check it, and a
//     transient stop of a relaxed plan re-runs only from a ref that carries the sealed list.
// (b) attended auto_decisions are kept in the run-state, so a resume keeps them.
// (c) a resume at review re-reads the PR head on the forge and refuses when it moved.
// (f0, f2 and the f0 pins live in v890_recover and v820_hardening.)
//
// Run: node --test plugins/ccpmcwf/tests/v892_batch_a.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, PB, NONCE, DIST, SOURCE, HERE, HASHES, happy, runOne, inputsOf, stateJsonOf, sha256, canon } from "./harness.mjs";

const README = readFileSync(join(HERE, "..", "README.md"), "utf8");

const RUN2 = "n2-0000002";
const has = (out, l) => out.labels.includes(l);

// A first build that records each run-state; resume(gate) scripts a build re-run from it (as v890_recover)
async function built(s, bargs0) {
  const states = {};
  for (const label of ["infra:state:committed:r1", "infra:state:pushed:p1", "infra:state:pr_open:p1", "infra:state:reviewed:v1", "infra:state:written_back", "infra:state:shipped"]) {
    const o = s[label];
    s[label] = (prompt, opts) => {
      const st = stateJsonOf(prompt);
      states[st.last_gate] = st;
      if (typeof o === "function") return o(prompt, opts);
      return o || { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  }
  const plan = await runOne(s, ARGS);
  const bargs = Object.assign({}, ARGS, { mode: "build", plan_ref: plan.result.plan_ref }, bargs0 || {});
  delete bargs.input;
  const first = await runOne(s, bargs);
  const resume = (gate, edit) => {
    const x = JSON.parse(JSON.stringify(states[gate]));
    assert.ok(x, "the first build wrote the run-state " + gate);
    if (edit) edit(x);
    s["infra:verify-plan"] = { ...happy()["infra:verify-plan"], head: x.approved_sha, commits_since: [{ sha: x.approved_sha, subject: "feat(thing): add thing" }], changed_since: ["src/x.py", "tests/test_a.py"] };
    s["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: x.approved_sha, message: JSON.stringify(x), head: x.approved_sha, head_tree: x.code_tree, clean: true };
    const h = JSON.parse(JSON.stringify(HASHES));
    h.git["fleetref:refs/fleet/l42/freeze"] = "T1";
    s["hasher:resume"] = { status: "ok", fingerprint: { head: x.approved_sha, tree: x.code_tree }, hashes: h };
    return s;
  };
  return { first, bargs, resume, states, planRef: plan.result.plan_ref };
}

// ---------------------------------------------------------------- (b) attended auto_decisions in the run-state

const RERUN_D = { gate: "rerun", decision: "rerun", reason: "the automatic re-run of run n0-0000009 after a transient stop" };
test("8.9.2 (b): an attended build keeps its auto_decisions in the run-state (no unattended key)", async () => {
  const s = happy();
  const { first, states } = await built(s, { rerun_of: "n0-0000009" });
  assert.equal(first.result.status, "ok", first.result.reason);
  for (const g of ["committed", "pushed", "pr_open", "reviewed", "written_back", "shipped"]) {
    assert.ok(states[g], "run-state " + g);
    assert.ok(!("unattended" in states[g]), g);
    assert.deepEqual(states[g].auto_decisions, [RERUN_D], g);
  }
});

test("8.9.2 (b): a resume of an attended run keeps the run-state's auto_decisions ahead of its own", async () => {
  const s = happy();
  const { bargs, resume } = await built(s, { rerun_of: "n0-0000009" });
  resume("reviewed");
  const a = Object.assign({}, bargs, { run_nonce: RUN2 });
  delete a.rerun_of;
  const r = await runOne(s, a);
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "writeback", r.result.reason);
  assert.deepEqual(r.result.auto_decisions, [RERUN_D]);
});

test("8.9.2 (b): an attended run with no automatic decision writes an empty list; an older run-state without the key resumes", async () => {
  const s = happy();
  const { bargs, resume, states } = await built(s);
  assert.deepEqual(states.reviewed.auto_decisions, []);
  resume("reviewed", (x) => delete x.auto_decisions);
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(!("auto_decisions" in r.result), JSON.stringify(r.result.auto_decisions));
});

test("8.9.2 (b): a run-state whose auto_decisions is malformed is a run-state mismatch (no role runs)", async () => {
  for (const bad of ["x", [null], [{ gate: 1, decision: "d", reason: "r" }], [{ gate: "g", decision: "d" }], [["g", "d", "r"]], {}]) {
    const s = happy();
    const { bargs, resume } = await built(s);
    resume("reviewed", (x) => (x.auto_decisions = bad));
    const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
    assert.equal(r.result.status, "needs_human", JSON.stringify(bad));
    assert.match(r.result.reason, /^run-state mismatch: auto_decisions /, JSON.stringify(bad));
    assert.equal(r.result.stop_class, "safety");
    assert.ok(!r.labels.some((l) => /^role:/.test(l)), r.labels.join(", "));
  }
});

// ---------------------------------------------------------------- (c) a resume at review re-reads the PR head

const VIEW = "infra:pr-view:resume-review";
const viewOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", mode: "view", state: "OPEN", head: inputsOf(p).args[4], merge_sha: null, error: null, args: inputsOf(p).args }, over);
test("8.9.2 (c): a resume at review reads the PR head on the forge before any PR write; the same head goes on", async () => {
  const s = happy();
  const { bargs, resume, states } = await built(s);
  resume("pr_open");
  s[VIEW] = viewOut();
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.equal(r.result.resumed_at, "review");
  const v = r.calls.find((c) => c.label === VIEW);
  assert.ok(v, r.labels.join(", "));
  const a = inputsOf(v.prompt).args;
  assert.deepEqual([a[0], a[3], a[4]], ["view", String(states.pr_open.pr_number), states.pr_open.approved_sha]);
  assert.ok(r.labels.indexOf(VIEW) < r.labels.indexOf("infra:pr-tests:resume"), r.labels.join(", "));
  assert.ok(r.labels.indexOf(VIEW) < r.labels.findIndex((l) => /^role:pr-review/.test(l)), r.labels.join(", "));
});

test("8.9.2 (c): a PR head that moved since the run-state, or a read that fails, refuses the resume (safety, gate resume) before any PR write or review", async () => {
  for (const [over, re] of [
    [{ head: "e".repeat(40) }, /moved to e{40}/],
    [{ head: null, state: null, error: "gh pr view: HTTP 502" }, /gh pr view: HTTP 502/],
    [{ state: "CLOSED" }, /is CLOSED/],
  ]) {
    const s = happy();
    const { bargs, resume } = await built(s);
    resume("pr_open");
    s[VIEW] = viewOut(over);
    const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
    assert.equal(r.result.status, "needs_human", JSON.stringify(over));
    assert.match(r.result.reason, /^resume at review refused: /, r.result.reason);
    assert.match(r.result.reason, re, r.result.reason);
    assert.equal(r.result.stop_gate, "resume");
    assert.equal(r.result.stop_class, "safety");
    assert.deepEqual(r.result.recover, { class: "safety", action: "none" });
    assert.ok(!r.labels.some((l) => /^(infra:pr-tests|role:pr-review|role:fleet-pr-opener|infra:pr-stats)/.test(l)), r.labels.join(", "));
  }
});

test("8.9.2 (c) review: the refusal names its remedy: a failed read is a relaunch, a closed PR or moved head a re-plan", async () => {
  for (const [over, tail] of [
    [{ head: null, state: null, error: "gh pr view: HTTP 502" }, /\. Relaunch the build with the same plan_ref$/],
    [{ state: "CLOSED" }, /\. Check the PR by hand, then re-plan$/],
    [{ head: "e".repeat(40) }, /\. Check the PR by hand, then re-plan$/],
  ]) {
    const s = happy();
    const { bargs, resume } = await built(s);
    resume("pr_open");
    s[VIEW] = viewOut(over);
    const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
    assert.match(r.result.reason, tail, r.result.reason);
    if (over.error) assert.doesNotMatch(r.result.reason, /re-plan/);
    assert.equal(r.result.stop_class, "safety");
  }
});

test("8.9.2 (c) review: a pr_open run-state with no pr_number is a run-state mismatch, never a skipped head check", async () => {
  for (const edit of [(x) => (x.pr_number = null), (x) => ((x.pr_number = null), (x.pr_url = null))]) {
    const s = happy();
    const { bargs, resume } = await built(s);
    resume("pr_open", edit);
    const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
    assert.equal(r.result.status, "needs_human", r.result.reason);
    assert.match(r.result.reason, /^run-state mismatch: pr_number at pr_open \(refs\/fleet\/y42\/state\)$/);
    assert.equal(r.result.stop_gate, "resume");
    assert.equal(r.result.stop_class, "safety");
    assert.ok(!r.labels.some((l) => /^(infra:pr-view|infra:pr-tests|role:)/.test(l)), r.labels.join(", "));
  }
});

test("8.9.2 (c): a resume past the review (writeback) does not read the head again here", async () => {
  const s = happy();
  const { bargs, resume } = await built(s);
  resume("reviewed");
  const r = await runOne(s, Object.assign({}, bargs, { run_nonce: RUN2 }));
  assert.equal(r.result.status, "ok", r.result.reason);
  assert.ok(!has(r, VIEW), r.labels.join(", "));
});

// ---------------------------------------------------------------- (a) the relaxed list sealed in the plan ref

const RELAXED = "criterion AC2 dropped";
const DEV = { item: RELAXED, allowed_by: "task body: 'AC2 is out of scope'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "the task drops it" };
const INTENT = { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "the task" } };
const intentOk = (sfx, dev) => ({
  ["hasher:pre-intent" + sfx]: { status: "ok", fingerprint: { head: PB, tree: "P0" } },
  ["role:fleet-intent-judge" + sfx]: Object.assign({}, INTENT, dev ? { deviations: dev } : {}),
  ["hasher:fp-post:intent" + sfx]: { status: "ok", fingerprint: { head: PB, tree: "P0" } },
});
const PRECOMMIT = { "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" } };
// fault injection: the audited plan comes back relaxed (as v890_recover B1)
const AT = 'budgetStop("the plan commit");';
const relaxedSrc = (src) => {
  assert.equal(src.split(AT).length, 2, "the dist holds the plan-commit budget check once");
  const out = src.replace(AT, AT + "p.relaxed=[" + JSON.stringify(RELAXED) + "];");
  assert.notEqual(out, src);
  return out;
};
const sealedOf = (s, tiny) => JSON.parse(s.__store[tiny.plan_commit]);
// the one sealed plan ref in a scenario's store (a stop result carries no plan_ref)
const storeRef = (s) => {
  const refs = Object.values(s.__store).filter((x) => typeof x === "string" && x.startsWith("{")).map((x) => JSON.parse(x)).filter((x) => x && x.seal);
  assert.equal(refs.length, 1, "one sealed ref in the store");
  return refs[0];
};
function reseal(s, tiny, edit) {
  const content = s.__store[tiny.plan_commit];
  const ref = JSON.parse(content);
  edit(ref);
  delete ref.seal;
  ref.seal = sha256(canon(ref));
  const next = JSON.stringify(ref) + (content.endsWith("\n") ? "\n" : "");
  s.__store[tiny.plan_commit] = next;
  return Object.assign({}, tiny, { ref_sha256: sha256(next) });
}
const LEGACY_WHY = "a relaxed re-plan whose plan ref was sealed before 8.9.2 (no sealed relaxed list): build mode cannot re-check its deviations";
const CHANGED_WHY = "a re-plan changed the relaxed list; build mode cannot re-check it";
const RELAXED_ADVICE = "A relaxed re-plan never passes the auto gates in an attended run. Build the same plan_ref without confirm auto (the interactive Build confirmation), or run it unattended (--auto) so the intent judge rules on each relaxed item.";
const LOOP_ADVICE = "re-run with the same plan_ref after a ruling (build mode, confirm auto)";

test("8.9.2 (a): the plan ref seals the relaxed list: [] for a plan that relaxed nothing, the items when it did", async () => {
  const s = happy();
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.deepEqual(sealedOf(s, out.result.plan_ref).relaxed, []);
  const r = Object.assign(happy(), intentOk("", [DEV]), PRECOMMIT);
  r.__source = relaxedSrc(DIST);
  r["infra:verify-plan"] = [null, null];
  await runOne(r, Object.assign({}, ARGS, { unattended: true }));
  assert.deepEqual(storeRef(r).relaxed, [RELAXED]);
  assert.equal(Object.keys(storeRef(r).plan_facts).includes("relaxed"), false, "a top-level ref key, not in plan_facts");
});

test("8.9.2 (a): a transient build stop of a relaxed plan sealed with its list re-runs; the :rerun intent judge gets the sealed list and rules on each item", async () => {
  const s = Object.assign(happy(), intentOk("", [DEV]), PRECOMMIT);
  s.__source = relaxedSrc(DIST);
  s["infra:verify-plan"] = [null, null];
  const out = await runOne(s, Object.assign({}, ARGS, { unattended: true }));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.equal(out.result.recover.action, "rerun", JSON.stringify(out.result.recover));
  assert.deepEqual(Object.keys(out.result.recover.args), ["mode", "plan_ref", "confirm", "rerun_of"]);
  assert.deepEqual([out.result.recover.args.mode, out.result.recover.args.confirm, out.result.recover.args.rerun_of], ["build", "auto", NONCE]);
  assert.deepEqual(sealedOf(s, out.result.recover.args.plan_ref).relaxed, [RELAXED]);
  const a = Object.assign({}, ARGS, { unattended: true, run_nonce: RUN2 }, out.result.recover.args);
  delete a.input;
  for (const [dev, ok] of [[[DEV], true], [[], false], [[Object.assign({}, DEV, { fails_closed: false })], false]]) {
    const r = Object.assign(s, intentOk(":rerun", dev), { "infra:verify-plan": happy()["infra:verify-plan"] });
    const o = await runOne(r, a);
    const j = o.calls.find((c) => c.label === "role:fleet-intent-judge:rerun");
    assert.ok(j, o.labels.join(", "));
    assert.deepEqual(inputsOf(j.prompt).relaxed, [RELAXED]);
    if (ok) assert.equal(o.result.status, "ok", o.result.reason);
    else {
      assert.equal(o.result.status, "needs_human", JSON.stringify(dev));
      assert.equal(o.result.failed_check, "intent", o.result.reason);
      assert.match(o.result.reason, /relaxed re-plan item "criterion AC2 dropped" has no approved deviation/);
      assert.ok(!o.labels.some((l) => /^role:fleet-(test-writer|coder)/.test(l)), o.labels.join(", "));
    }
  }
});

test("8.9.2 (a): a relaxed plan whose ref carries no sealed list (sealed before 8.9.2) keeps recover none", async () => {
  const s = Object.assign(happy(), intentOk("", [DEV]), PRECOMMIT);
  const mk = "plan_facts:f.planFacts,";
  assert.equal(DIST.split(mk).length, 2, "makePlanRef seals plan_facts once");
  const src = relaxedSrc(DIST);
  // fault injection: makePlanRef seals no relaxed key (a ref of 8.9.1)
  s.__source = src.replace(/relaxed:Array\.isArray\(f\.relaxed\)\?f\.relaxed\.slice\(\):\[\],?/, "");
  assert.notEqual(s.__source, src);
  s["infra:verify-plan"] = [null, null];
  const out = await runOne(s, Object.assign({}, ARGS, { unattended: true }));
  assert.ok(!("relaxed" in storeRef(s)));
  assert.equal(out.result.stop_class, "transient", out.result.reason);
  assert.deepEqual(out.result.recover, { class: "transient", action: "none", why: LEGACY_WHY });
  assert.ok(!has(out, "infra:run-lock:rerun"));
});

test("8.9.2 (a): an attended confirm auto build of a ref with a sealed relaxed list stops before the intent judge (as plan mode)", async () => {
  const s = happy();
  const plan = await runOne(s, ARGS);
  const tiny = reseal(s, plan.result.plan_ref, (ref) => (ref.relaxed = [RELAXED]));
  const a = Object.assign({}, ARGS, { mode: "build", plan_ref: tiny, confirm: "auto" });
  delete a.input;
  const o = await runOne(Object.assign(s, intentOk(":rerun", [DEV])), a);
  assert.equal(o.result.status, "needs_human", o.result.reason);
  assert.equal(o.result.failed_check, "intent");
  assert.match(o.result.reason, /^auto-confirm: intent check failed: re-plan relaxed: criterion AC2 dropped/);
  assert.ok(!has(o, "role:fleet-intent-judge:rerun"), o.labels.join(", "));
  // review of #118: the advice never sends it back to the same confirm auto build (it would stop again)
  assert.ok(o.result.needs_max_section.includes(RELAXED_ADVICE), o.result.needs_max_section);
  assert.ok(!o.result.needs_max_section.includes(LOOP_ADVICE), o.result.needs_max_section);
  // a ref sealed with an empty list builds as before
  const t2 = reseal(s, plan.result.plan_ref, (ref) => (ref.relaxed = []));
  const o2 = await runOne(Object.assign(s, intentOk(":rerun")), Object.assign({}, a, { plan_ref: t2 }));
  assert.equal(o2.result.status, "ok", o2.result.reason);
  assert.equal(inputsOf(o2.calls.find((c) => c.label === "role:fleet-intent-judge:rerun").prompt).relaxed, undefined);
});

test("8.9.2 (a) review: an attended confirm auto plan launch of a relaxed plan gets the same advice; other auto-gate stops keep theirs", async () => {
  const s = Object.assign(happy(), PRECOMMIT);
  s.__source = relaxedSrc(DIST);
  const o = await runOne(s, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(o.result.failed_check, "intent", o.result.reason);
  assert.match(o.result.reason, /re-plan relaxed: criterion AC2 dropped/);
  assert.ok(o.result.needs_max_section.includes(RELAXED_ADVICE), o.result.needs_max_section);
  assert.ok(!o.result.needs_max_section.includes(LOOP_ADVICE));
  // an intent refusal (not the relaxed stop) keeps the re-run advice
  const r = Object.assign(happy(), intentOk(""), PRECOMMIT);
  r["role:fleet-intent-judge"] = Object.assign({}, r["role:fleet-intent-judge"], { verdict: "refuse", reason: "not the task" });
  const o2 = await runOne(r, Object.assign({}, ARGS, { confirm: "auto" }));
  assert.equal(o2.result.failed_check, "intent", o2.result.reason);
  assert.ok(o2.result.needs_max_section.includes(LOOP_ADVICE), o2.result.needs_max_section);
  assert.ok(!o2.result.needs_max_section.includes(RELAXED_ADVICE));
});

test("8.9.2 (a) review: a sealed list that differs from the run's relaxed list names the change, not the version", async () => {
  const s = Object.assign(happy(), intentOk("", [DEV]), PRECOMMIT);
  const src = relaxedSrc(DIST);
  // fault injection: the ref seals another list than the run built
  s.__source = src.replace(/relaxed:Array\.isArray\(f\.relaxed\)\?f\.relaxed\.slice\(\):\[\]/, 'relaxed:["criterion AC1 dropped"]');
  assert.notEqual(s.__source, src);
  s["infra:verify-plan"] = [null, null];
  const out = await runOne(s, Object.assign({}, ARGS, { unattended: true }));
  assert.deepEqual(storeRef(s).relaxed, ["criterion AC1 dropped"]);
  assert.deepEqual(out.result.recover, { class: "transient", action: "none", why: CHANGED_WHY });
});

test("8.9.2 (a): a sealed relaxed list that is not a list of non-empty strings refuses the ref", async () => {
  for (const bad of ["x", [""], [1], null, {}]) {
    const s = happy();
    const plan = await runOne(s, ARGS);
    const tiny = reseal(s, plan.result.plan_ref, (ref) => (ref.relaxed = bad));
    const a = Object.assign({}, ARGS, { mode: "build", plan_ref: tiny });
    delete a.input;
    const o = await runOne(s, a);
    assert.equal(o.result.status, "needs_human", JSON.stringify(bad));
    assert.match(o.result.reason, /relaxed is malformed/, o.result.reason);
    assert.equal(o.result.stop_class, "safety");
    assert.ok(!o.labels.some((l) => /^role:/.test(l)), o.labels.join(", "));
  }
});

test("8.9.2 (a): the relaxed list comes from the sealed ref only, never from recover.args or the launch args", () => {
  const at = SOURCE.indexOf("function recoverOf(status) {");
  const body = SOURCE.slice(at, SOURCE.indexOf("\n}\n", at));
  assert.doesNotMatch(body, /a\.relaxed|relaxed:/);
  assert.doesNotMatch(SOURCE, /input\.relaxed|args\.relaxed/);
});

// ---------------------------------------------------------------- (f1) and the docs

test("8.9.2 (f1): the README says the marker can be deleted or backdated by a role with Bash; no 'can only' claim", () => {
  const t = README.replace(/\s+/g, " ");
  assert.doesNotMatch(t, /marker can only/i);
  assert.match(t, /The marker is not tamper-proof: a role with Bash can delete or backdate `<task_id>\.json` and win back one re-run/);
  assert.match(t, /before the run lock release, so the held lock serializes the marker's read and write/);
  assert.match(t, /The plan ref seals the relaxed list \(`relaxed`, `\[\]` when the plan relaxed nothing\)/);
  assert.match(t, /A resume at the review \(8\.9\.2\) first reads the PR on the forge \(`infra:pr-view:resume-review`/);
  assert.match(t, /`auto_decisions` \(8\.9\.2: an attended run's too, so a resume keeps them/);
});
