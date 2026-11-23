// ccpmcwf 8.5.2 (yaadgaar #107): the intake check for a required gate the census
// reports unsupported (#94) fired on text that only describes a gate.
// - Text in quotes ("…", '…', `…`, “…”, ‘…’) is a quotation or example: the check ignores it.
//   A single-quoted span counts only when both quotes sit next to a non-word char, so an
//   apostrophe ("don't", "task's") never swallows text.
// - An opt-out sentence (gate term, requirement word, negation) for a gate suppresses the
//   stop for that gate only.
// - A real requirement still stops with today's reason.
// - Under --auto (args.unattended) the run records an auto_decisions entry and goes on;
//   the gate then shows in gates_not_run. Attended and policy-only runs keep the stop.
//
// Run: node --test plugins/ccpmcwf/tests/v852_unsupported_required.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, PB, happy, runOne, call, inputsOf, gateToolsOut } from "./harness.mjs";

const briefWith = (body) => Object.assign({}, BRIEF, { sources: [Object.assign({}, BRIEF.sources[0], { body })] });
function scen(body, census) {
  const s = happy({ brief: briefWith(body) });
  if (census) s.preflight = { gate_tools: census };
  return s;
}
const planned = (out) => out.labels.some((l) => /^role:scope-and-plan/.test(l));
const CENSUS = "gate census other: coverage unsupported, mutation unsupported, security unsupported";
const reasonFor = (k) => "intake: the task requires the " + k + " gate, but the gate census reports it unsupported (" + CENSUS + "); drop the requirement or install a " + k + " tool, then re-run";

async function passes(t) {
  const out = await runOne(scen(t), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", t + ": " + out.result.reason);
  assert.ok(planned(out), t);
}
async function stops(t, k) {
  const out = await runOne(scen(t), ARGS);
  assert.equal(out.result.status, "needs_human", t);
  assert.equal(out.result.reason, reasonFor(k), t);
  assert.equal(out.result.stop_gate, "gates", t);
  assert.equal(planned(out), false, t);
}

test("8.5.2 (#107): the describing sentences seen in real runs do not stop", async () => {
  for (const t of [
    'Plan runs on ccpm stopped at intake, stop gate "gates": "the task requires the coverage gate, but the gate census reports it unsupported".',
    'Its body held the sentence "Intake then stops every task that requires the coverage gate."',
    'A real requirement ("coverage must be 100%") still stops.',
    "Intake reads the brief, while a real requirement such as 'coverage must be 100%' still stops.",
    "Intake's own summary: the task's describing text goes on, while a real requirement such as 'coverage must be 100%' still stops.",
  ])
    await passes(t);
});

test("8.5.2 (#107): every quote kind hides a requirement: \"…\", '…', `…`, “…”, ‘…’", async () => {
  for (const t of [
    'The old note said "mutation testing must kill every mutant".',
    "The old note said 'mutation testing must kill every mutant'.",
    "The old note said `mutation testing must kill every mutant`.",
    "The old note said “mutation testing must kill every mutant”.",
    "The old note said ‘mutation testing must kill every mutant’.",
    "The old note said ‘mutants don’t survive, coverage must be 100%’ and nothing more.",
  ])
    await passes(t);
});

test("8.5.2 (#107): an apostrophe in a contraction or possessive never swallows a real requirement", async () => {
  await stops("The parser's fix: coverage must be 100% for the module's code.", "coverage");
  await stops("Don't skip it. Coverage must be 100%. It's the task's rule.", "coverage");
  await stops("The users' tests stay; mutation testing is required on the team's code.", "mutation");
  await stops("Keep the 'fast' path. Coverage must be 100% for the parser's code.", "coverage");
  // a single-quoted span never crosses a sentence end: a stray opening quote and a plural possessive
  await stops("Use the 'strict mode. Coverage must be 100% for the users' code.", "coverage");
  await stops("Use the ‘strict mode. Coverage must be 100% for the users’ code.", "coverage");
});

test("8.5.2 (#107): a real requirement still stops with today's reason", async () => {
  await stops("Coverage must be 100%.", "coverage");
  await stops("This change requires the mutation gate.", "mutation");
  await stops('The old note said "coverage is optional". This change requires the mutation gate.', "mutation");
});

test("8.5.2 (#107): an opt-out sentence for a gate suppresses the stop for that gate only", async () => {
  await passes("Intake then stops every task that requires the coverage gate. This build does not require the coverage gate.");
  await passes("This build does not require the coverage gate. Intake stops a task that requires coverage.");
  await stops("Intake stops every task that requires the coverage gate. This build does not require the coverage gate. Mutation testing is required.", "mutation");
});

test("8.5.2 (#107): a quoted opt-out does not cancel a real requirement", async () => {
  await stops('Coverage must be 100%. The old brief said "this build does not require the coverage gate".', "coverage");
});

test("8.5.2 (#107): a supported gate still never stops", async () => {
  const g = gateToolsOut("/r");
  g.languages = ["python"];
  g.matrix = Object.assign({}, g.matrix, { python: { coverage: "coverage", mutation: "builtin", security: "unsupported" } });
  const out = await runOne(scen("Coverage must be 100%.", g), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});

// ---- unattended (--auto): record the decision, go on, and list the gate as not run
function gated(body) {
  const s = scen(body);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] }, classification: { change_kind: "approve", new_behaviour: "approve", quote: "add a thing" } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return s;
}
const gatesDecision = (out) => (out.result.auto_decisions || []).filter((d) => d.gate === "gates");

test("8.5.2 (#107): --auto records a gates: continue decision, builds, and lists the gate in gates_not_run", async () => {
  const out = await runOne(gated("Coverage must be 100%."), { ...ARGS, unattended: true, confirm: "default" });
  assert.equal(out.result.status, "ok", out.result.reason);
  const d = gatesDecision(out);
  assert.equal(d.length, 1, JSON.stringify(out.result.auto_decisions));
  assert.equal(d[0].decision, "continue");
  assert.match(d[0].reason, /coverage gate/);
  assert.match(d[0].reason, /unsupported/);
  assert.match(d[0].reason, /will not run/);
  assert.ok(out.result.gates_not_run.some((g) => g.gate === "coverage"), JSON.stringify(out.result.gates_not_run));
  assert.ok(planned(out));
  assert.ok(inputsOf(call(out, "role:fleet-pr-opener").prompt).unattended_section.includes("gates: continue ("));
});

test("8.5.2 (#107): --auto in plan mode (confirm ask) goes on to the plan and records the decision", async () => {
  const out = await runOne(scen("This change requires the mutation gate."), { ...ARGS, unattended: true, confirm: "ask" });
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  const d = gatesDecision(out);
  assert.equal(d.length, 1);
  assert.match(d[0].reason, /mutation gate/);
});

test("8.5.2 (#107): attended runs keep the stop, also under confirm auto", async () => {
  for (const args of [ARGS, { ...ARGS, confirm: "auto" }, { ...ARGS, confirm: "default" }]) {
    const out = await runOne(gated("Coverage must be 100%."), args);
    assert.equal(out.result.status, "needs_human", JSON.stringify(args));
    assert.equal(out.result.reason, reasonFor("coverage"));
    assert.equal(out.result.stop_gate, "gates");
  }
});
