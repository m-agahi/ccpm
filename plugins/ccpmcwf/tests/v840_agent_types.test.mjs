// ccpmcwf 8.4.0 (yaadgaar #25 steps 2-5, ADR-1348): every agent() call of the engine runs under a ccpmcwf agent
// type, and every agent type starts without the user, project and local CLAUDE.md files (omitClaudeMd). The
// user's safety HARD RULES come back in each agent file's body (its system prompt), word for word.
//
// The types, by the tools each role really needs:
//   ccpmcwf:judge           read-only steps and roles (plan-audit too: it reports, never edits the plan)
//   ccpmcwf:builder         scope-and-plan (the plan doc), fleet-test-writer (tests), fleet-coder (code): Write, Edit
//   ccpmcwf:infra-writer    write steps (git, gh, shipped programs, chunk files with Write) and fleet-pr-opener
//                           (gh, and its body file with Write): no Edit
//   ccpmcwf:yaadgaar-writer the yaadgaar write-back: mcp__yaadgaar__edit_task, no Bash, no file writes
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { ARGS, HERE, SOURCE, DIST, ROLE_NAMES, ROLE_TEXT, WANT_AGENT, wantAgent, happy, run, noUnscripted } from "./harness.mjs";

const AGENTS_DIR = join(HERE, "..", "agents");
const FILES = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
const TEXT = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(AGENTS_DIR, f), "utf8")]));
const TYPES = ["ccpmcwf:builder", "ccpmcwf:infra-writer", "ccpmcwf:judge", "ccpmcwf:yaadgaar-writer"];
const fileOf = (type) => type.split(":")[1] + ".md";

function front(t) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  assert.ok(m, "frontmatter");
  return m[1];
}
function denied(type) {
  const fm = front(TEXT[fileOf(type)]);
  assert.doesNotMatch(fm, /^tools:/m, type + ": a deny list only (an allow list drops StructuredOutput)");
  const m = /^disallowedTools: (.*)$/m.exec(fm);
  assert.ok(m, type + ": disallowedTools");
  return m[1].split(",").map((x) => x.trim());
}

// ------------------------------------------------------------------ agent files

test("8.4.0 #25: the agent files are exactly the four ccpmcwf types", () => {
  assert.deepEqual(FILES, TYPES.map(fileOf).sort());
  for (const t of TYPES) assert.match(front(TEXT[fileOf(t)]), new RegExp("^name: " + t.split(":")[1] + "$", "m"));
});

test("8.4.0 #25: every agents/*.md sets omitClaudeMd: true and model: inherit", () => {
  for (const f of FILES) {
    const fm = front(TEXT[f]);
    assert.deepEqual(fm.split("\n").filter((l) => /^omitClaudeMd\s*:/i.test(l)), ["omitClaudeMd: true"], f);
    assert.deepEqual(fm.split("\n").filter((l) => /^model\s*:/.test(l)), ["model: inherit"], f);
  }
});

// ------------------------------------------------------------------ the safety block

// prettier keeps one blank line inside each marker
const BEGIN = "<!-- ccpmcwf-safety-rules:begin -->\n\n";
const END = "\n<!-- ccpmcwf-safety-rules:end -->";
// the sections of ~/.claude/agent-instructions.md, in its order (ADR-1348)
const SECTIONS = [
  "No Terraform",
  "No `tf-local-*` Container Exec",
  "Apply / Import (Shared Infra)",
  "1Password MCP Is Read-Only",
  "Branch First",
  "Merging by Repo Owner",
  "No Hook Bypass",
  "No Co-Author Attribution",
];
// sha256 of the block, copied 2026-11-20 from ~/.claude/agent-instructions.md
const SAFETY_SHA256 = "766e7ba93cf8f0bb4d9b3db5034e8d876e1e869bbce9e198d14ce20e7dd8aede";
function blockOf(t, f) {
  const i = t.indexOf(BEGIN);
  const j = t.indexOf(END);
  assert.ok(i >= 0 && j > i, f + ": safety block markers");
  assert.equal(t.indexOf(BEGIN, i + 1), -1, f + ": one safety block");
  return t.slice(i + BEGIN.length, j);
}
// the named sections of a rules file, joined as the agent files hold them
function extract(src) {
  const parts = src.split(/^(?=## )/m);
  const by = {};
  for (const p of parts) {
    const m = /^## HARD RULE — (.*)\n/.exec(p);
    if (m) by[m[1]] = p;
  }
  return SECTIONS.map((s) => {
    assert.ok(by[s], "source section " + s);
    return by[s].replace(/\n+$/, "") + "\n";
  }).join("\n");
}

test("8.4.0 #25: every agent body carries the same safety block, its sections and its pinned sha256", () => {
  const blocks = FILES.map((f) => blockOf(TEXT[f], f));
  for (const b of blocks) assert.equal(b, blocks[0]);
  const heads = [...blocks[0].matchAll(/^## HARD RULE — (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, SECTIONS);
  assert.equal(createHash("sha256").update(blocks[0]).digest("hex"), SAFETY_SHA256);
  // the block sits in the body, after the frontmatter
  for (const f of FILES) assert.ok(TEXT[f].indexOf(BEGIN) > TEXT[f].indexOf("\n---\n", 4), f);
});

const LIVE = join(homedir(), ".claude", "agent-instructions.md");
test("8.4.0 #25: the safety block is byte-equal to the live sections of ~/.claude/agent-instructions.md", { skip: !existsSync(LIVE) && "no " + LIVE + " here (CI): the sha256 pin above holds the copy" }, () => {
  const blocks = FILES.map((f) => blockOf(TEXT[f], f));
  assert.equal(blocks[0], extract(readFileSync(LIVE, "utf8")), "the global rules changed: copy the sections again and re-pin SAFETY_SHA256");
});

// ------------------------------------------------------------------ tool lists

const MUTATING_MCP = (() => {
  const d = denied("ccpmcwf:judge");
  return d.filter((x) => x.startsWith("mcp__"));
})();

test("8.4.0 #25: every type keeps the judge's mutating yadgar/yaadgaar MCP denies; only the yaadgaar writer gets edit_task", () => {
  assert.ok(MUTATING_MCP.length > 50 && MUTATING_MCP.includes("mcp__yaadgaar__edit_task") && MUTATING_MCP.includes("mcp__yadgar__memorize"));
  for (const t of TYPES) {
    const d = denied(t);
    const want = t === "ccpmcwf:yaadgaar-writer" ? MUTATING_MCP.filter((x) => x !== "mcp__yaadgaar__edit_task") : MUTATING_MCP;
    assert.deepEqual(d.filter((x) => x.startsWith("mcp__")), want, t);
  }
});

test("8.4.0 #25: each type's built-in denies are exactly the tools its roles never use", () => {
  const builtIn = (t) => denied(t).filter((x) => !x.startsWith("mcp__"));
  assert.deepEqual(builtIn("ccpmcwf:judge"), ["Write", "Edit", "NotebookEdit"]);
  assert.deepEqual(builtIn("ccpmcwf:builder"), ["NotebookEdit"]);
  assert.deepEqual(builtIn("ccpmcwf:infra-writer"), ["Edit", "NotebookEdit"]);
  assert.deepEqual(builtIn("ccpmcwf:yaadgaar-writer"), ["Bash", "Write", "Edit", "NotebookEdit"]);
  for (const t of TYPES) for (const x of ["Read", "ToolSearch", "StructuredOutput", "mcp__yaadgaar__read_task"]) assert.ok(!denied(t).includes(x), t + " keeps " + x);
});

// ------------------------------------------------------------------ the engine's tables

function constOf(name) {
  const m = new RegExp("\\nconst " + name + " = ([^;]*);").exec(SOURCE);
  assert.ok(m, name);
  return m[1];
}
const AGENT_CONSTS = 'const JUDGE_AGENT = "ccpmcwf:judge";\nconst BUILDER_AGENT = "ccpmcwf:builder";\nconst INFRA_AGENT = "ccpmcwf:infra-writer";\nconst YAADGAAR_AGENT = "ccpmcwf:yaadgaar-writer";\n';
const ROLE_WANT = {
  "scope-and-plan": "ccpmcwf:builder",
  "fleet-test-writer": "ccpmcwf:builder",
  "fleet-coder": "ccpmcwf:builder",
  "fleet-pr-opener": "ccpmcwf:infra-writer",
  "plan-audit": "ccpmcwf:judge",
  "fleet-test-judge": "ccpmcwf:judge",
  "fleet-code-judge": "ccpmcwf:judge",
  "fleet-intent-judge": "ccpmcwf:judge",
  "pr-review": "ccpmcwf:judge",
  "gate-change-nonweakening-sweep": "ccpmcwf:judge",
  "fleet-ci-classifier": "ccpmcwf:judge",
  "fleet-held-out-runner": "ccpmcwf:judge",
};

test("8.4.0 #25: the engine names the four types once, and ROLE_AGENT maps every role to its type", () => {
  for (const line of AGENT_CONSTS.trim().split("\n")) assert.ok(SOURCE.includes("\n" + line), line);
  const types = Function(AGENT_CONSTS + "return " + constOf("AGENT_TYPES") + ";")();
  assert.deepEqual([...types].sort(), TYPES);
  const roles = Function(AGENT_CONSTS + "return " + constOf("ROLE_AGENT") + ";")();
  assert.deepEqual(roles, ROLE_WANT);
  assert.deepEqual(Object.keys(roles).sort(), [...ROLE_NAMES].sort());
  for (const name of ["BUILDER_AGENT", "INFRA_AGENT", "YAADGAAR_AGENT"]) assert.ok(DIST.includes(name), "dist holds " + name);
});

test("8.4.0 #25: each role gets the tools its role file tells it to use", () => {
  for (const [role, type] of Object.entries(ROLE_WANT)) {
    const t = ROLE_TEXT[role];
    const d = denied(type);
    // every role runs commands (git, the test command, the scratch copy program, gh)
    assert.ok(!d.includes("Bash"), role + " needs Bash");
    if (/\b(Edit and Write|Edit|Write) tools?\b/.test(t)) for (const x of ["Write", "Edit"]) assert.ok(!d.includes(x), role + " names the " + x + " tool");
    // a role that writes files in the worktree (the plan doc, tests, code) needs Write and Edit
    if (["scope-and-plan", "fleet-test-writer", "fleet-coder"].includes(role)) for (const x of ["Write", "Edit"]) assert.ok(!d.includes(x), role + " writes files");
    // the opener writes its body to a file
    if (/Write the body to a file/.test(t)) assert.ok(!d.includes("Write"), role + " writes the body file");
    // a judge type never edits: its role file must not ask for an edit
    if (d.includes("Write")) assert.doesNotMatch(t, /\b(Edit|Write|NotebookEdit) tool\b/, role);
  }
});

// ------------------------------------------------------------------ the call sites


test("8.4.0 #25: WANT_AGENT has no catch-all, and the happy plan+build run dispatches every agent under its expected ccpmcwf type", async () => {
  for (const [re, t] of WANT_AGENT) {
    assert.ok(TYPES.includes(t), String(re));
    assert.ok(!re.test("") && !re.test("x") && !re.test("infra:") && !re.test("role:"), "no catch-all: " + re);
  }
  const out = await run(happy(), ARGS);
  noUnscripted(out);
  assert.equal(out.result.status, "ok", out.result.reason);
  const seen = new Set();
  for (const c of out.calls) {
    const w = wantAgent(c.label);
    assert.ok(w, "no expected type for " + c.label);
    assert.equal(c.opts.agentType, w, c.label);
    seen.add(w);
    // a prompt's tools are in its type
    const d = denied(c.opts.agentType);
    if (/with the Write tool/.test(c.prompt)) assert.ok(!d.includes("Write"), c.label + " writes with the Write tool");
    if (/Run (this|each) /.test(c.prompt)) assert.ok(!d.includes("Bash"), c.label + " runs a command");
    if (/mcp__yaadgaar__edit_task/.test(c.prompt) && !/never edit/i.test(c.prompt)) assert.ok(!d.includes("mcp__yaadgaar__edit_task"), c.label + " edits a yaadgaar task");
  }
  assert.deepEqual([...seen].sort(), TYPES, "the happy run uses every type");
});

test("8.4.0 #25: agentT, the one agent() call, refuses a missing or unknown agent type", async () => {
  const calls = [...SOURCE.matchAll(/[^A-Za-z_.]agent\(/g)];
  assert.equal(calls.length, 1, "one agent() call in the engine");
  const i = SOURCE.indexOf("\nasync function agentT(");
  assert.ok(i >= 0 && calls[0].index > i && calls[0].index < SOURCE.indexOf("\n}\n", i), "the agent() call is in agentT");
  const body = SOURCE.slice(i, SOURCE.indexOf("\n}\n", i) + 3);
  const halt = (status, msg, g) => {
    const e = new Error(msg);
    e.status = status;
    e.gate = g;
    throw e;
  };
  const got = [];
  const agentT = Function(
    "halt",
    "agent",
    AGENT_CONSTS + "const AGENT_TYPES = " + constOf("AGENT_TYPES") + ";\nconst TOK = {};\nlet tokAt = null;\nconst tokOn = () => false;\n" + body + "\nreturn agentT;",
  )(halt, async (p, o) => {
    got.push(o);
    return { status: "ok" };
  });
  for (const t of TYPES) assert.deepEqual(await agentT("p", { label: "l", agentType: t }), { status: "ok" });
  for (const bad of [undefined, null, "", "general-purpose", "ccpmcwf:writer", "ccpmcwf:ledger-writer", "judge"])
    await assert.rejects(agentT("p", { label: "infra:x", agentType: bad }), (e) => e.status === "failed" && e.gate === "contract" && /no ccpmcwf agent type/.test(e.message), String(bad));
  assert.equal(got.length, TYPES.length, "a refused call never reaches agent()");
});
