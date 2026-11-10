// fleet 5.0.0 PR-2 (R2, ledger 1999): yadgar and yaadgaar are never required.
// Preflight reports which ledger read tools the session has (a tool census,
// ledger_tools); the script picks the write-back adapter from it and from the
// task's sources: yaadgaar | yadgar | tracker (the marked issue or Jira comment
// IS the whole write-back, Max's ruling) | none. A task id with no ledger tool
// stops before intake with one plain sentence; a present tool that fails at
// call time stays `failed` and never stops the run. The run result's memory
// notes key is memory_notes (was yadgar_findings), optional.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE, ARGS, BRIEF, happy, run, runOne, inputsOf, call, noUnscripted } from "./harness.mjs";

const YGET = "mcp__yadgar__task_get";
const YREAD = "mcp__yaadgaar__read_task";
const GH = { kind: "github", ref: "o/r#5", url: "https://github.com/o/r/issues/5", body: "issue" };
const YURN = "yadgar:task:0192";
const YBRIEF = { ...BRIEF, title: "Mark plain scalars", sources: [{ kind: "yaadgaar", ref: "622", url: null, body: "yaadgaar task body", id: YURN }] };
const NO_LEDGER = /no task ledger available; give a URL, Jira key or text/;

// a scenario whose preflight reports the given census
function withCensus(tools, over) {
  const s = happy(over);
  s.preflight = { ledger_tools: tools };
  return s;
}
const listing = (prompt) => ({ status: "ok", reason: "listed", results: inputsOf(prompt).sources.map((x) => ({ key: x.key, status: "ok", has_marker: false })) });
const posting = (prompt) => ({ status: "ok", reason: "posted", results: inputsOf(prompt).posts.map((x) => ({ key: x.key, status: "posted", url: "u" })) });
const LEDGER_LABEL = /^infra:(ledger-|yaadgaar-)/;

// the pure adapter function, with the constants it reads, from the source
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

test("5.0.0 R2: ledgerAdapter picks yaadgaar | yadgar | tracker | none from sources and the census", () => {
  const { ledgerAdapter, LEDGER_TOOLS } = loadAdapter();
  assert.deepEqual(LEDGER_TOOLS.slice().sort(), [YREAD, YGET].sort());
  const L = [{ kind: "ledger", ref: "42" }];
  const Y = [{ kind: "yaadgaar", ref: "622" }];
  assert.equal(ledgerAdapter("m-agahi/x", L, [YGET]).adapter, "yadgar");
  assert.equal(ledgerAdapter("yadgarhq/docs", Y, [YREAD]).adapter, "yaadgaar");
  // a yadgarhq/ project never falls through to the frozen yadgar ledger (ADR-0994)
  assert.notEqual(ledgerAdapter("yadgarhq/docs", L, [YGET]).adapter, "yadgar");
  assert.equal(ledgerAdapter("yadgarhq/docs", L.concat([GH]), [YGET]).adapter, "tracker");
  // review of 88eb9b0: the census is advisory: a ledger source keeps its
  // ledger path when the census misses the tool (the writer tries it); the
  // reason says the census did not list it
  assert.equal(ledgerAdapter("m-agahi/x", L, []).adapter, "yadgar");
  assert.match(ledgerAdapter("m-agahi/x", L, []).reason, /census did not list mcp__yadgar__task_get/);
  assert.equal(ledgerAdapter("yadgarhq/docs", Y, []).adapter, "yaadgaar");
  assert.equal(ledgerAdapter("m-agahi/x", L, [YGET]).reason, null);
  // a non-ledger source needs no tool: tracker or none, census or not
  assert.equal(ledgerAdapter("m-agahi/x", [GH], []).adapter, "tracker");
  assert.equal(ledgerAdapter("m-agahi/x", [{ kind: "jira", ref: "ABC-1" }], [YGET, YREAD]).adapter, "tracker");
  const none = ledgerAdapter("m-agahi/x", [{ kind: "text", ref: "text" }], [YGET, YREAD]);
  assert.equal(none.adapter, "none");
  assert.match(none.reason, /nothing to write back/);
  // pure: same answer twice, inputs untouched
  const src = [{ kind: "ledger", ref: "1" }];
  const tools = [YGET];
  assert.deepEqual(ledgerAdapter("o/r", src, tools), ledgerAdapter("o/r", src, tools));
  assert.deepEqual(src, [{ kind: "ledger", ref: "1" }]);
  assert.deepEqual(tools, [YGET]);
});

// PR #48 ruling 1: was "typed and required"; the census is advisory, so optional and nullable
test("5.0.0 R2: the preflight census is typed, optional and nullable; the prompt names the candidate tools and how an absent server shows", async () => {
  const out = await run(happy(), ARGS);
  const pre = call(out, "preflight");
  const sch = pre.opts.schema;
  assert.ok(!(sch.required || []).includes("ledger_tools"), "ledger_tools is not required");
  assert.deepEqual(sch.properties.ledger_tools, { type: ["array", "null"], items: { type: "string" } });
  assert.match(pre.prompt, /ToolSearch/);
  assert.match(pre.prompt, /select:mcp__yaadgaar__read_task,mcp__yadgar__task_get/);
  assert.match(pre.prompt, /absent|not configured|disconnected/);
  assert.match(pre.prompt, /Never call/);
});

test("5.0.0 R2: census [] + GitHub issue: build ok, adapter tracker, ledger_status none, exactly one marked comment, no ledger step", async () => {
  const s = withCensus([], { brief: { ...BRIEF, sources: [GH] }, script: { "infra:comments-list": listing, "infra:comments-post": posting } });
  const out = await run(s, { ...ARGS, input: GH.url, confirm: "ask" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.ledger_adapter, "tracker");
  assert.match(out.result.ledger_reason, /tracker comment/);
  assert.equal(out.result.ledger_status, "none");
  assert.equal(out.result.comment_status, "posted");
  assert.deepEqual(out.result.write_back.ledger, []);
  assert.equal(out.result.write_back.comments.length, 1);
  const posts = inputsOf(call(out, "infra:comments-post").prompt).posts;
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /fleet:/);
  assert.ok(!out.labels.some((l) => LEDGER_LABEL.test(l)), out.labels.join(", "));
  // intake gets the census as a hint (review of 88eb9b0: advisory, never "none")
  const it = inputsOf(call(out, "intake").prompt);
  assert.deepEqual(it.ledger_tools, []);
  assert.equal(it.ledger, "yadgar");
});

test("5.0.0 R2: census [] + plain text: adapter none, ledger_status none, the reason in the result, run ok", async () => {
  const s = withCensus([], { brief: { ...BRIEF, sources: [{ kind: "text", ref: "text", url: null, body: "add a thing" }] } });
  const out = await run(s, { ...ARGS, input: "add a thing", confirm: "ask" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.ledger_adapter, "none");
  assert.match(out.result.ledger_reason, /nothing to write back/);
  assert.equal(out.result.ledger_status, "none");
  assert.equal(out.result.comment_status, "none");
});

// intake's answer when ToolSearch finds no ledger tool: every call absent
function absentIntake(prompt) {
  const i = inputsOf(prompt);
  const tools = i.ledger === "yaadgaar" ? [YREAD] : i.ledger === "yadgar" ? [YGET] : [YREAD, YGET];
  return {
    status: "needs_human",
    reason: "no task ledger available; give a URL, Jira key or text",
    tried: tools.map((t) => ({ ledger: t === YREAD ? "yaadgaar" : "yadgar", project: i.project, call: t, error: "absent" })),
  };
}

test("5.0.0 R2 (review of 88eb9b0): census [] + a task id still dispatches intake; intake reporting absent stops with the plain sentence", async () => {
  for (const input of ["L123", "123", "#123", "yaadgaar #123"]) {
    for (const project of ["m-agahi/x", "yadgarhq/docs", undefined]) {
      const a = { ...ARGS, input, confirm: "ask" };
      if (project === undefined) delete a.project;
      else a.project = project;
      const s = withCensus([]);
      s.intake = absentIntake;
      const out = await runOne(s, a);
      assert.ok(out.labels.includes("intake"), "intake is dispatched: " + out.labels.join(", "));
      // the census is a hint only: intake is told to try the ledger tool
      const it = call(out, "intake");
      assert.notEqual(inputsOf(it.prompt).ledger, "none", input + " " + project);
      assert.match(it.prompt, /advisory/);
      assert.equal(out.result.status, "needs_human", input + " " + project);
      assert.match(out.result.reason, NO_LEDGER, input);
      // the real census and the tool this project's ledger needs
      assert.match(out.result.reason, /census: \[\]/);
      const need = project === "m-agahi/x" ? /needs mcp__yadgar__task_get/ : project === "yadgarhq/docs" ? /needs mcp__yaadgaar__read_task/ : /needs mcp__yaadgaar__read_task or mcp__yadgar__task_get/;
      assert.match(out.result.reason, need, input + " " + project);
    }
  }
  // the census that preflight reported is printed as it is
  const s = withCensus([YGET]);
  s.intake = absentIntake;
  const y = await runOne(s, { ...ARGS, input: "#622", project: "yadgarhq/docs", confirm: "ask" });
  assert.equal(y.result.status, "needs_human");
  assert.match(y.result.reason, NO_LEDGER);
  assert.match(y.result.reason, /census: \["mcp__yadgar__task_get"\]/);
});

test("5.0.0 R2 (review of 88eb9b0): a wrong census [] for a yadgar user: intake finds the tool, the build ends ok on today's path", async () => {
  const s = withCensus([]);
  const out = await run(s, { ...ARGS, input: "L123", confirm: "ask" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(inputsOf(call(out, "intake").prompt).ledger, "yadgar");
  // the write-back still dispatches the read and the writer, which find the tool
  assert.ok(out.labels.includes("infra:ledger-read:pre"), out.labels.join(", "));
  assert.ok(out.labels.includes("infra:ledger-writeback"), out.labels.join(", "));
  assert.equal(out.result.ledger_status, "ok");
  assert.equal(out.result.ledger_adapter, "yadgar");
  assert.deepEqual(out.result.write_back.ledger.map((e) => e.status), ["written"]);
});

test("5.0.0 R2 (review of 88eb9b0): an intake stop that is not all-absent keeps today's reason", async () => {
  const s = withCensus([]);
  s.intake = { status: "needs_human", reason: "task 123 not found", tried: [{ ledger: "yadgar", project: "o/r", call: "task_get(project_id=o/r, id=123)", error: "not found" }] };
  const out = await runOne(s, { ...ARGS, input: "L123", confirm: "ask" });
  assert.equal(out.result.status, "needs_human");
  assert.doesNotMatch(out.result.reason, NO_LEDGER);
  assert.match(out.result.reason, /not found/);
});

test("5.0.0 R2: census with mcp__yadgar__task_get, project m-agahi/x: today's ledger path, adapter yadgar", async () => {
  const s = withCensus([YGET]);
  s.workspace = { ...s.workspace, remote_slug: "m-agahi/x" };
  const out = await run(s, { ...ARGS, project: "m-agahi/x", confirm: "ask" });
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const it = inputsOf(call(out, "intake").prompt);
  assert.equal(it.ledger, "yadgar");
  assert.deepEqual(it.ledger_tools, [YGET]);
  assert.equal(inputsOf(call(out, "infra:ledger-writeback").prompt).project, "m-agahi/x");
  assert.equal(out.result.ledger_adapter, "yadgar");
  assert.equal(out.result.ledger_reason, null);
  assert.equal(out.result.ledger_status, "ok");
});

test("5.0.0 R2: no project and only one ledger tool: intake tries that ledger and records the other as absent", async () => {
  const a = { ...ARGS, input: "#622", confirm: "ask" };
  delete a.project;
  const out = await runOne(withCensus([YREAD], { brief: YBRIEF }), a);
  const it = call(out, "intake");
  assert.equal(inputsOf(it.prompt).ledger, "either");
  assert.deepEqual(inputsOf(it.prompt).ledger_tools, [YREAD]);
  assert.match(it.prompt, /error "absent"/);
});

test("5.0.0 R2: yadgarhq/ project + yaadgaar tool: adapter yaadgaar, the yaadgaar write-back runs", async () => {
  const s = withCensus([YREAD], { brief: YBRIEF });
  const plan = await runOne(s, { ...ARGS, input: "yaadgaar #622", project: "yadgarhq/docs", confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  assert.equal(inputsOf(call(plan, "intake").prompt).ledger, "yaadgaar");
  s["infra:yaadgaar-read"] = (p) => ({ status: "ok", reason: "read", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "ok", id: t.id, number: t.number, version: 3, has_marker: false })) });
  s["infra:yaadgaar-writeback"] = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "written" })) });
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.ledger_adapter, "yaadgaar");
  assert.equal(out.result.ledger_status, "ok");
  assert.ok(!out.labels.some((l) => /^infra:ledger-/.test(l)), "never the yadgar ledger");
});

test("5.0.0 R2: a present ledger tool failing at call time stays failed; the run is ok", async () => {
  const s = withCensus([YGET], {
    script: { "infra:ledger-writeback": (p) => ({ status: "ok", reason: "x", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "failed", reason: "MCP error -32000: connection closed" })) }) },
  });
  const out = await run(s, { ...ARGS, confirm: "ask" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.ledger_adapter, "yadgar");
  assert.equal(out.result.ledger_status, "failed");
  assert.match(out.result.write_back.ledger[0].reason, /connection closed/);
  assert.match(out.result.write_back.ledger[0].section_text, /fleet:l42/);
});

test("5.0.0 R2 (review of 88eb9b0): the ledger tool gone at build time: the read is still dispatched; it reports unavailable -> section handed back, run ok", async () => {
  const s = withCensus([YGET]);
  const plan = await runOne(s, { ...ARGS, confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s.preflight = { ledger_tools: [] };
  s["infra:ledger-read:pre"] = (p) => ({ status: "ok", reason: "absent", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "unavailable", reason: "ToolSearch found no mcp__yadgar__task_get" })) });
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: ARGS.project });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:ledger-read:pre"), "the census never skips the read");
  assert.match(call(out, "infra:ledger-read:pre").prompt, /status unavailable/);
  assert.ok(!out.labels.includes("infra:ledger-writeback"));
  assert.equal(out.result.ledger_status, "unavailable");
  assert.equal(out.result.ledger_adapter, "none");
  const e = out.result.write_back.ledger[0];
  assert.equal(e.status, "unavailable");
  assert.match(e.reason, /ToolSearch found no mcp__yadgar__task_get/);
  assert.match(e.section_text, /fleet:l42/);
});

test("5.0.0 R2 (review of 88eb9b0): the yaadgaar read reports unavailable -> unavailable, run ok", async () => {
  const s = withCensus([YREAD], { brief: YBRIEF });
  const plan = await runOne(s, { ...ARGS, input: "yaadgaar #622", project: "yadgarhq/docs", confirm: "ask" });
  assert.equal(plan.result.status, "awaiting_confirmation", plan.result.reason);
  s.preflight = { ledger_tools: [] };
  s["infra:yaadgaar-read"] = (p) => ({ status: "ok", reason: "absent", results: inputsOf(p).tasks.map((t) => ({ key: t.key, status: "unavailable", reason: "no read_task tool" })) });
  const out = await runOne(s, { mode: "build", plan_ref: plan.result.plan_ref, date: ARGS.date, project: "yadgarhq/docs" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.labels.includes("infra:yaadgaar-read"));
  assert.match(call(out, "infra:yaadgaar-read").prompt, /status unavailable/);
  assert.equal(out.result.ledger_status, "unavailable");
  assert.equal(out.result.write_back.ledger[0].status, "unavailable");
  assert.match(out.result.write_back.ledger[0].section_text, /fleet:y622/);
});

test("5.0.0 R2 (review of 88eb9b0): a malformed census counts as [] and never blocks: the ledger path still runs", async () => {
  const s = happy();
  s.preflight = { ledger_tools: "mcp__yadgar__task_get" };
  const out = await run(s, { ...ARGS, confirm: "ask" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(out.logs.some((l) => /ledger tools: none \(census not a list/.test(l)), "logged");
  assert.equal(out.result.ledger_status, "ok");
});

test("5.0.0 R2: memory_notes replaces yadgar_findings in the result; optional on every role", async () => {
  // 5.0.0 R3: the harness's happy roles return memory_notes (yadgar_findings is gone)
  const s = happy();
  s["role:fleet-coder:r1"] = Object.assign({}, s["role:fleet-coder:r1"], { memory_notes: ["coder note"] });
  const out = await run(s, { ...ARGS, confirm: "ask" });
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.ok(!("yadgar_findings" in out.result), "no yadgar_findings key");
  assert.ok(Array.isArray(out.result.memory_notes));
  const roles = out.result.memory_notes.map((x) => x.role);
  assert.ok(roles.includes("fleet-coder"));
  assert.ok(roles.includes("fleet-pr-opener"));
  assert.deepEqual(out.result.memory_notes.find((x) => x.role === "fleet-coder").notes, ["coder note"]);
  // absent everywhere: an empty list, run ok
  const bare = happy();
  for (const k of Object.keys(bare)) if (k.startsWith("role:") && bare[k] && typeof bare[k] === "object") delete bare[k].memory_notes;
  const o2 = await run(bare, { ...ARGS, confirm: "ask" });
  assert.equal(o2.result.status, "ok", o2.result.reason);
  assert.deepEqual(o2.result.memory_notes, []);
  // never required by any role schema
  for (const c of out.calls.filter((x) => x.label.startsWith("role:"))) {
    assert.ok(!c.opts.schema.required.includes("memory_notes"), c.label);
    assert.deepEqual(c.opts.schema.properties.memory_notes.type, ["array", "null"], c.label); // PR #48 ruling 1: nullable
  }
});

test("5.0.0 R2: the intent judge gets ledger_task only from a ledger adapter, and never tracker comments", () => {
  const i = SOURCE.indexOf("async function autoGates(");
  const body = SOURCE.slice(i, SOURCE.indexOf("\n}\n", i)).replace(/^\s*\/\/.*$/gm, "");
  assert.match(body, /ledgerAdapter\(/);
  assert.match(body, /ledger_task: ledger \?/);
  // no tracker comment listing feeds the judge (code only; comments stripped)
  assert.doesNotMatch(body, /comments/);
});
