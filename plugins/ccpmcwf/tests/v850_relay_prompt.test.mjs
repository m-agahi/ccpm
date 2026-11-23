// fleet 8.5.0 AC1 (yaadgaar #105): the intake prompt and INTAKE_SCHEMA carry the
// required relay field, in plan-mode intake and in the intake:rulings re-read.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, PB, FP_PLAN, happy, run, runOne, inputsOf, call } from "./harness.mjs";

const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };
const P = "m-agahi/ccpm";
const YQ = { ...ARGS, input: "#622", project: P, confirm: "ask" };
const written = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
const read = () => (p) => ({
  status: "ok",
  reason: "read",
  results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false })),
});

// the confirm-auto build fixture of v700_yaadgaar_writeback.test.mjs (local: harness.mjs exports no such helper)
function autoHappy(over = {}) {
  const s = happy(over);
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": { status: "ok", reason: "matches the task", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
  return s;
}
async function buildAuto() {
  const s = autoHappy({ brief: YBRIEF });
  const plan = await runOne(s, YQ);
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["infra:yaadgaar-read"] = read();
  s["infra:yaadgaar-writeback"] = written;
  s["intake:rulings"] = { status: "ok", reason: "re-read", brief: YBRIEF, tried: [{ ledger: "yaadgaar", project: null, call: "read_task(number=622)", error: null }], relay: { kind: "none", text: "" } };
  s["hasher:pre-intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  s["role:fleet-intent-judge:rerun"] = { status: "ok", reason: "fine", verdict: "approve", deviations: [], coverage: { covered: true, missing: [] } };
  s["hasher:fp-post:intent:rerun"] = { status: "ok", fingerprint: FP_PLAN };
  return runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: P, confirm: "auto" });
}

const PINNED = [
  "Every answer carries",
  "relay: {kind, text}",
  '"run the loop"',
  '"try one of the tasks with ccpmcwf"',
  '"also fix the login page"',
  "every message you are unsure about",
  "The workflow, not you, decides whether a delegation may pass.",
];

test("8.5.0 AC1: plan-mode intake prompt carries the relay classification rule", async () => {
  // AC1: c.prompt contains the pinned relay-rule substrings
  const out = await run(happy(), ARGS);
  const c = call(out, "intake");
  for (const sub of PINNED) assert.ok(c.prompt.includes(sub), "intake prompt lacks: " + sub);
});

test("8.5.0 AC1: INTAKE_SCHEMA requires status, reason and relay {kind, text} with the four kinds", async () => {
  // AC1: schema.required, relay.required and relay.kind.enum
  const c = call(await run(happy(), ARGS), "intake");
  assert.deepEqual(c.opts.schema.required, ["status", "reason", "relay"]);
  assert.deepEqual(c.opts.schema.properties.relay.required, ["kind", "text"]);
  assert.deepEqual(c.opts.schema.properties.relay.properties.kind.enum, ["none", "names_input", "delegation", "request"]);
});

test("8.5.0 AC1: triangulation, the schema also rides a confirm-ask launch with another input and mode", async () => {
  // AC1: triangulation, different args, same required relay field in the schema and the prompt
  const c = call(await run(happy(), { ...ARGS, confirm: "ask" }), "intake");
  assert.deepEqual(c.opts.schema.required, ["status", "reason", "relay"]);
  assert.deepEqual(c.opts.schema.properties.relay.properties.kind.enum, ["none", "names_input", "delegation", "request"]);
  assert.ok(c.prompt.includes("relay: {kind, text}"));
});

test("8.5.0 AC1: the intake:rulings re-read prompt and schema carry the relay field", async () => {
  // AC1: re-read path, confirm-auto build dispatches intake:rulings
  const out = await buildAuto();
  const c = call(out, "intake:rulings");
  assert.ok(c.prompt.includes("relay: {kind, text}"), "rulings prompt lacks the relay field");
  assert.deepEqual(c.opts.schema.required, ["status", "reason", "relay"]);
  // AC1: triangulation, the same relay rule text and kind enum on the re-read
  assert.ok(c.prompt.includes("The workflow, not you, decides whether a delegation may pass."));
  assert.deepEqual(c.opts.schema.properties.relay.properties.kind.enum, ["none", "names_input", "delegation", "request"]);
});
