// fleet 7.0.0 AC4 (yaadgaar #699): ledgerAdapter never picks the retired yadgar
// ledger, and the preflight census and the no-ledger stop name only
// mcp__yaadgaar__read_task.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, happy, runOne, inputsOf, call } from "./harness.mjs";

const YREAD = "mcp__yaadgaar__read_task";
const GH = { kind: "github", ref: "o/r#5", url: "https://github.com/o/r/issues/5", body: "issue" };

function loadAdapter() {
  const line = (name) => {
    const m = new RegExp("\\nconst " + name + " = [^\\n]*\\n").exec(SOURCE);
    assert.ok(m, name);
    return m[0];
  };
  const m = /\/\/ LEDGER_ADAPTER_BEGIN\n([\s\S]*?)\/\/ LEDGER_ADAPTER_END/.exec(SOURCE);
  assert.ok(m, "LEDGER_ADAPTER markers");
  return new Function(line("EXTERNAL_KINDS") + line("YAADGAAR_PROJECT_RE") + m[1] + "\nreturn { ledgerAdapter, LEDGER_TOOLS };")();
}

test("7.0.0 AC4: ledgerAdapter table: yaadgaar on any project, never yadgar", () => {
  const { ledgerAdapter, LEDGER_TOOLS } = loadAdapter();
  assert.deepEqual(LEDGER_TOOLS, [YREAD]);
  const L = [{ kind: "ledger", ref: "42" }];
  const Y = [{ kind: "yaadgaar", ref: "622" }];
  for (const p of ["o/r", "m-agahi/x", "yadgarhq/docs", null]) {
    assert.equal(ledgerAdapter(p, Y, [YREAD]).adapter, "yaadgaar", String(p));
    assert.equal(ledgerAdapter(p, Y, [YREAD]).reason, null);
    assert.match(ledgerAdapter(p, Y, []).reason, /census did not list mcp__yaadgaar__read_task/);
    const l = ledgerAdapter(p, L, [YREAD]);
    assert.equal(l.adapter, "none", String(p));
    assert.match(l.reason, /yadgar ledger is retired/);
    assert.equal(ledgerAdapter(p, L.concat([GH]), [YREAD]).adapter, "tracker");
    assert.equal(ledgerAdapter(p, [{ kind: "text", ref: "text" }], [YREAD]).adapter, "none");
  }
});

test("7.0.0 AC4: the preflight census asks for mcp__yaadgaar__read_task only", async () => {
  const out = await runOne(happy(), { ...ARGS, confirm: "ask" });
  const pre = call(out, "preflight");
  assert.match(pre.prompt, /select:mcp__yaadgaar__read_task` \(max_results 1\)/);
  assert.doesNotMatch(pre.prompt, /mcp__yadgar__/);
  assert.deepEqual(inputsOf(call(out, "intake").prompt).ledger_tools, [YREAD]);
});

test("7.0.0 AC4: a task id with no ledger tool stops naming mcp__yaadgaar__read_task only", async () => {
  for (const project of ["o/r", "yadgarhq/docs"]) {
    const s = happy();
    s.preflight = { ledger_tools: [] };
    s.intake = (prompt) => ({
      status: "needs_human",
      reason: "no task ledger available; give a URL, Jira key or text",
      tried: [{ ledger: "yaadgaar", project: inputsOf(prompt).project, call: YREAD, error: "absent" }],
    });
    const out = await runOne(s, { ...ARGS, input: "123", project, confirm: "ask" });
    assert.equal(out.result.status, "needs_human");
    assert.match(out.result.reason, /this project's ledger needs mcp__yaadgaar__read_task\)/);
    assert.doesNotMatch(out.result.reason, /mcp__yadgar__/);
  }
});
