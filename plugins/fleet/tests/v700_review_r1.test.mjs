// fleet 7.0.0 review round 1 (PR #72): the retired yadgar ledger is refused in
// script code, not prompt text (F1); the default fixture is the live yaadgaar
// path and its CI follow-up write-back runs (F2); project keys compare
// case-insensitively and the write-back falls back to the digest-checked
// session project (F5).
//
// F1 gates: (a) planMode stops on an L<N> input before any agent; (b) a brief
// that names a `ledger` source stops after intake on every project, and the
// confirm-auto re-read of a yaadgaar, Jira or GitHub source stops on one too.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARGS, BRIEF, PB, FP_PLAN, LEGACY_SOURCE, happy, run, runOne, inputsOf, call, noUnscripted } from "./harness.mjs";

const LEGACY_ID = /is a legacy yadgar ledger id: the yadgar ledger is retired/;
const LEGACY_SRC = /source ledger:42 is a legacy yadgar ledger task: the yadgar ledger is retired/;

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

test("7.0.0 review F1(a): an L<N> input stops needs_human before any agent, on every project and confirm mode", async () => {
  for (const [input, n] of [["L42", "42"], ["l42", "42"], ["L 42", "42"], ["  L7  ", "7"]])
    for (const project of ["o/r", "m-agahi/x", "yadgarhq/docs", undefined])
      for (const confirm of ["ask", "default", "auto"]) {
        const a = { ...ARGS, input, confirm };
        if (project === undefined) delete a.project;
        else a.project = project;
        const out = await runOne(happy(), a);
        const tag = JSON.stringify([input, project, confirm]);
        assert.equal(out.result.status, "needs_human", tag);
        assert.deepEqual(out.calls, [], tag + ": no agent runs");
        assert.match(out.result.reason, LEGACY_ID, tag);
        assert.ok(out.result.reason.includes("title prefix `L" + n + ": `"), tag + ": " + out.result.reason);
      }
  // a yaadgaar id, or text that only starts with L, is not a legacy id
  for (const input of ["#42", "42", "yaadgaar #42", "L42x", "Lint the repo 42"]) assert.ok((await runOne(happy(), { ...ARGS, input })).labels.includes("intake"), input);
});

test("7.0.0 review F1(b): a brief naming a ledger source stops after intake on every project; nothing is sealed", async () => {
  for (const project of ["o/r", "m-agahi/x", "yadgarhq/docs", undefined])
    for (const sources of [[LEGACY_SOURCE], [BRIEF.sources[0], LEGACY_SOURCE]]) {
      const a = { ...ARGS, confirm: "ask" };
      if (project === undefined) delete a.project;
      else a.project = project;
      // an intake agent that read the frozen yadgar ledger (or mapped #42 to L42) and sealed it
      const out = await runOne(happy({ brief: { ...BRIEF, sources } }), a);
      const tag = JSON.stringify([project, sources.map((x) => x.kind)]);
      assert.equal(out.result.status, "needs_human", tag);
      assert.match(out.result.reason, LEGACY_SRC, tag);
      assert.match(out.result.reason, /title prefix `L42: `/, tag);
      assert.deepEqual(out.labels, ["preflight", "intake"], tag);
    }
});

test("7.0.0 review F1(b): the confirm-auto re-read stops when the fresh brief names a ledger source", async () => {
  const s = autoHappy();
  const plan = await runOne(s, { ...ARGS, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s["intake:rulings"] = { status: "ok", reason: "re-read", brief: { ...BRIEF, sources: [BRIEF.sources[0], LEGACY_SOURCE] }, tried: [{ ledger: "yaadgaar", project: null, call: "read_task(number=42)", error: null }] };
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "o/r", confirm: "auto" });
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /^re-read of yaadgaar:42: source ledger:42 is a legacy yadgar ledger task/);
  assert.ok(!out.labels.some((l) => /^role:fleet-(test-writer|coder)/.test(l)), out.labels.join(", "));
});

test("7.0.0 review F1(c): the judge agent cannot call the frozen yadgar ledger read tools", () => {
  const judge = readFileSync(new URL("../agents/judge.md", import.meta.url), "utf8");
  const deny = (/^disallowedTools: (.*)$/m.exec(judge) || [, ""])[1].split(",").map((x) => x.trim());
  for (const t of ["mcp__yadgar__task_get", "mcp__yadgar__task_list", "mcp__yadgar__task_write"]) assert.ok(deny.includes(t), t);
});

test("7.0.0 review F2: the default task's CI follow-up is written back through infra:yaadgaar-writeback:ci", async () => {
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const L = out.labels;
  const w = L.indexOf("infra:ci-watch:w1");
  assert.ok(w >= 0, L.join(", "));
  assert.ok(L.indexOf("infra:yaadgaar-read:ci") > w && L.indexOf("infra:yaadgaar-writeback:ci") > L.indexOf("infra:yaadgaar-read:ci"), L.join(", "));
  const i = inputsOf(call(out, "infra:yaadgaar-writeback:ci").prompt);
  assert.equal(i.project, "o/r");
  assert.equal(i.marker, "fleet:y42:ci");
  assert.match(i.section_text, /^CI: /);
  assert.deepEqual(out.result.ci_write_back.write_back.ledger.map((e) => [e.ref, e.status]), [["yaadgaar #42", "written"]]);
});

test("7.0.0 review F5: args.project in another case matches the lowercased session project", async () => {
  const s = happy();
  s.__session_project = "o/r";
  const out = await run(s, { ...ARGS, project: "O/R" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.deepEqual(out.result.write_back.ledger.map((e) => [e.ref, e.status]), [["yaadgaar #42", "written"]]);
  // a read answer naming the project in another case is the same project
  const n = happy();
  n.__session_project = "o/r";
  n["infra:yaadgaar-read"] = (p) => ({ status: "ok", reason: "read", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false, project: "O/r" })) });
  const o = await run(n, ARGS);
  assert.equal(o.result.status, "ok", o.result.reason);
  assert.equal(o.result.write_back.ledger[0].status, "written", o.result.write_back.ledger[0].reason);
});

test("7.0.0 review F5: with no args.project the write-back scope is the session project; with neither it fails and hands the section back", async () => {
  const s = happy();
  s.__session_project = "o/r";
  const out = await run(s, { ...ARGS, project: undefined });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(inputsOf(call(out, "infra:yaadgaar-read").prompt).project, "o/r");
  assert.equal(inputsOf(call(out, "infra:yaadgaar-writeback").prompt).project, "o/r");
  const n = happy();
  n.__session_project = null;
  const none = await run(n, { ...ARGS, project: undefined });
  assert.equal(none.result.status, "ok", none.result.reason);
  assert.ok(!none.labels.some((l) => /^infra:yaadgaar-/.test(l)), none.labels.join(", "));
  const e = none.result.write_back.ledger[0];
  assert.equal(e.status, "failed");
  assert.match(e.reason, /no <owner>\/<repo> project to write to \(args\.project null, session project null\)/);
  assert.match(e.section_text, /fleet:y42/);
});
