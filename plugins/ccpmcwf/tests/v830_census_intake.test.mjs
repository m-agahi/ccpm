// ccpmcwf (yaadgaar #94): a task that REQUIRES a gate the preflight gate census
// reports unsupported stops at intake, before scope-and-plan, with needs_human.
// The match is conservative: the gate term and a requirement word in one
// sentence, with no negation. A task that only mentions a gate goes on. An
// unusable census never stops a run (the census stays advisory).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, runOne, gateToolsOut } from "./harness.mjs";

const briefWith = (body) => Object.assign({}, BRIEF, { sources: [Object.assign({}, BRIEF.sources[0], { body })] });
function scen(body, census) {
  const s = happy({ brief: briefWith(body) });
  if (census) s.preflight = { gate_tools: census };
  return s;
}
const planned = (out) => out.labels.some((l) => /^role:scope-and-plan/.test(l));

test("#94: the daneel sentence (coverage gate enforces 100%) stops at intake; the reason names the gate and the census line", async () => {
  const out = await runOne(scen("Fix the parser. The fleet coverage gate enforces 100% branch coverage."), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /coverage/);
  assert.ok(out.result.reason.includes("gate census other: coverage unsupported, mutation unsupported, security unsupported"), out.result.reason);
  assert.ok(out.logs.includes("gate census other: coverage unsupported, mutation unsupported, security unsupported"));
  assert.equal(planned(out), false, "no planner ran");
  assert.ok(!out.labels.some((l) => /^infra:workspace|^infra:branch-scan/.test(l)), out.labels.join(", "));
});

test("#94: mutation and security scan requirements stop too", async () => {
  for (const t of ["Mutation testing must kill every mutant on the changed lines.", "A security scan is required before merge."]) {
    const out = await runOne(scen(t), ARGS);
    assert.equal(out.result.status, "needs_human", t);
    assert.equal(planned(out), false, t);
  }
});

test("#94: a task that only mentions a gate, or a requirement word in another sentence, or a negated one, does not stop", async () => {
  for (const t of [
    "Speed up the coverage report.",
    "Raise mutation scores in the docs. Tests must pass.",
    "The coverage gate is not required for this docs change.",
    "Make the security dashboard load faster; it must render in 1s.",
  ]) {
    const out = await runOne(scen(t), ARGS);
    assert.equal(out.result.status, "awaiting_confirmation", t + ": " + out.result.reason);
    assert.ok(planned(out), t);
  }
});

test("#94: a supported gate does not stop", async () => {
  const g = gateToolsOut("/r");
  g.languages = ["python"];
  g.matrix = Object.assign({}, g.matrix, { python: { coverage: "coverage", mutation: "builtin", security: "unsupported" } });
  const out = await runOne(scen("The coverage gate must enforce 100% branch coverage. Mutation testing is required.", g), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
  assert.ok(planned(out));
});

test("#94: a gate supported in one of two languages does not stop (stop only when no language supports it)", async () => {
  const g = gateToolsOut("/r");
  g.languages = ["node", "python"];
  g.matrix = Object.assign({}, g.matrix, { python: { coverage: "coverage", mutation: "builtin", security: "unsupported" } });
  const out = await runOne(scen("The fleet coverage gate enforces 100% branch coverage.", g), ARGS);
  assert.equal(out.result.status, "awaiting_confirmation", out.result.reason);
});
