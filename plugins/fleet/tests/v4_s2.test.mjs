// fleet 4.0.0 stream S2 (ledger 1984, 1992, 1982): the role output contract
// at the schema with one retry on drift, the sealed project, the brief
// schema, the fleet-v4 marker and the release integration.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, happy, run, call } from "./harness.mjs";

// REQUIRED_ON_OK as written in the script source
function requiredOf() {
  const m = /const REQUIRED_ON_OK = (\{[\s\S]*?\n\});/.exec(SOURCE);
  assert.ok(m, "REQUIRED_ON_OK in source");
  return Function("return " + m[1])();
}

// ---------------------------------------------------------------- S2 keys (D10)

test("4.0.0 S2 keys: REQUIRED_ON_OK has the planner change_kind and the intent-judge classification", () => {
  const req = requiredOf();
  assert.ok(req["scope-and-plan"].includes("change_kind"));
  assert.ok(req["scope-and-plan"].includes("new_behaviour"));
  assert.ok(req["fleet-intent-judge"].includes("classification"));
});

test("4.0.0 S2 keys: the planner schema types change_kind, new_behaviour and criteria[].test_args", async () => {
  const out = await run(happy(), ARGS);
  const sch = call(out, "role:scope-and-plan").opts.schema;
  const ck = sch.properties.change_kind;
  assert.deepEqual([].concat(ck.enum).filter((v) => v !== null), ["bug_fix", "feature", "refactor", "chore"]);
  assert.ok([].concat(sch.properties.new_behaviour.type).includes("boolean"));
  const item = sch.properties.criteria.items;
  assert.ok([].concat(item.properties.test_args.type).includes("string"), "criteria[].test_args is a string");
  assert.ok(!item.required.includes("test_args"), "test_args stays optional");
});

test("4.0.0 S2 keys: the intent-judge schema has classification {change_kind, new_behaviour, quote}", async () => {
  const out = await run(happy({ script: { "hasher:pre-intent": { status: "ok", fingerprint: { head: "abc1234def0", tree: "P0" } } } }), { ...ARGS, confirm: "auto" });
  const c = out.calls.find((x) => x.label === "role:fleet-intent-judge");
  assert.ok(c, "intent judge dispatched: " + out.labels.join(", "));
  const cl = c.opts.schema.properties.classification;
  assert.ok([].concat(cl.type).includes("object"));
  for (const k of ["change_kind", "new_behaviour"]) assert.deepEqual(cl.properties[k].enum, ["approve", "refuse"]);
  assert.deepEqual(cl.properties.quote.type, "string");
  assert.deepEqual(cl.required, ["change_kind", "new_behaviour", "quote"]);
});

test("4.0.0 S2 keys: the caller grep relay carries auto_dont_care and doctest_md", () => {
  const m = /const INFRA_SCHEMA = \{[\s\S]*?\n\};/.exec(SOURCE);
  assert.ok(m);
  assert.match(m[0], /auto_dont_care: \{ type: "array", items: STR \}/);
  assert.match(m[0], /doctest_md: \{ type: "array", items: STR \}/);
});

test("4.0.0 S2 keys: an ok planner without change_kind, or with a bad one, is contract drift", async () => {
  let out = await run(happy({ script: { "role:scope-and-plan": { __raw: true, ...happyPlanner(), change_kind: undefined } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /scope-and-plan contract drift: missing change_kind/);
  out = await run(happy({ script: { "role:scope-and-plan": { __raw: true, ...happyPlanner(), change_kind: "hotfix" } } }), ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, /contract drift: scope-and-plan change_kind/);
});

// A complete planner result as the role runner returns it (raw: no defaults).
export function happyPlanner(over = {}) {
  const s = happy();
  const p = JSON.parse(JSON.stringify(s["role:scope-and-plan"]));
  return Object.assign(
    p,
    {
      role_version: s.preflight.versions["scope-and-plan"],
      role_contract: s.preflight.contract["scope-and-plan"],
      allowed_additions: { files: [], symbols: [], deps: [], settings: [] },
      held_out_examples: [],
      repo_obligations: [],
      test_cmd: { command: "pytest <paths>", paths_placeholder: "<paths>", env: {}, tools: [] },
      changed_symbols: [],
      change_kind: "feature",
    },
    over,
  );
}
