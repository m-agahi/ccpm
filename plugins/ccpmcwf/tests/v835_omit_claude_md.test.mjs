// ccpmcwf 8.3.5 (yaadgaar #25, step 1 canary, Max ruled 2026-11-19: A, omitClaudeMd): the judge agent type,
// which every probe-mode agent (preflight and the role read) runs under, starts without the user, project and
// local CLAUDE.md files. A misspelt field fails silently in Claude Code, so the exact key and value are pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("8.3.5 #25: agents/judge.md frontmatter sets omitClaudeMd: true", () => {
  const t = readFileSync(join(HERE, "..", "agents", "judge.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  assert.ok(m, "judge.md frontmatter");
  const lines = m[1].split("\n").filter((l) => /^omitClaudeMd\s*:/i.test(l));
  assert.deepEqual(lines, ["omitClaudeMd: true"]);
});

test("8.3.5 #25: the probe-mode preflight and role-read agents run under ccpmcwf:judge", () => {
  const src = readFileSync(join(HERE, "..", "src", "build-engine.js"), "utf8");
  assert.match(src, /const JUDGE_AGENT = "ccpmcwf:judge";/);
  assert.match(src, /const preOpts = \{ schema: PREFLIGHT_SCHEMA, agentType: JUDGE_AGENT, phase: "Preflight" \};/);
  const probe = src.slice(src.indexOf("async function probeMode("));
  assert.match(probe.slice(0, 2000), /infraCall\(label, roleReadPrompt\(role\), \{[^}]*agentType: JUDGE_AGENT/);
});
