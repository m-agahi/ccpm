// fleet 8.0.0 car R, yaadgaar #56 (L2191): the /build-task flag `--unattended`
// becomes `--auto`. Max's ruling (2026-11-16): flag only, the old name is dropped
// at once (no alias); the workflow arg `unattended`, the policy key, the result
// fields and the PR section keep their names. The docs say how `--auto` differs
// from `confirm: "auto"`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS_SRC } from "./harness.mjs";

const R = join(SCRIPTS_SRC, "..");
const read = (...p) => readFileSync(join(R, ...p), "utf8");
const SKILL = read("skills", "build-task", "SKILL.md");

test("8.0.0 R (#56): the build-task skill documents and parses --auto and passes unattended: true", () => {
  assert.match(SKILL, /^\/build-task --auto <task id \| Jira key \| issue or PR URL \| plan path \| description>$/m);
  assert.match(SKILL, /When it starts with the word `--auto`, drop that\s+word from `input` and pass `unattended: true`/);
  assert.match(SKILL, /It is on when the user ran `\/build-task --auto` \(pass `unattended: true`\)/);
});

test("8.0.0 R (#56): no shipped skill, role, doc or workflow names the old flag --unattended (no alias), except the skill's refusal", () => {
  const files = [
    ["skills", "build-task", "SKILL.md"],
    ["skills", "fleet-policy", "SKILL.md"],
    ["skills", "plan-task", "SKILL.md"],
    ["README.md"],
    ["src", readdirSync(join(R, "src")).find((f) => f.endsWith(".js"))],
    ["workflows", readdirSync(join(R, "workflows")).find((f) => f.endsWith(".js"))],
    ...readdirSync(join(R, "roles")).filter((f) => f.endsWith(".md")).map((f) => ["roles", f]),
    ...readdirSync(join(R, "agents")).map((f) => ["agents", f]),
  ];
  const REFUSAL = /When it\s+starts with the word `--unattended` \(the name before 8\.0\.0, no alias\), say "the flag is now --auto"\s+and stop\./;
  for (const f of files) assert.doesNotMatch(read(...f).replace(REFUSAL, ""), /--unattended/, f.join("/"));
});

test("8.0.0 R (#56): the skill refuses the old flag --unattended instead of building it as input", () => {
  assert.match(SKILL, /When it\s+starts with the word `--unattended` \(the name before 8\.0\.0, no alias\), say "the flag is now --auto"\s+and stop\./);
});

test("8.0.0 R (#56): the skill keeps --auto and confirm: \"auto\" apart", () => {
  assert.match(SKILL, /`--auto` is not `confirm: "auto"`/);
  assert.match(SKILL, /The `--auto`\s+flag names no confirm mode: it never sets `confirm` or `user_confirm`\./);
  assert.match(read("README.md"), /The `\/build-task --auto` flag is not\s+`confirm: "auto"`/);
  // the README and the policy skill name the new flag for the one-run switch
  assert.match(read("README.md"), /`\/build-task --auto` argument/);
  assert.match(read("skills", "fleet-policy", "SKILL.md"), /`\/build-task --auto` argument/);
});

test("8.0.0 R: the coder role no longer says the coverage, mutation and security-scan gates are not run", () => {
  const coder = read("roles", "fleet-coder.md");
  assert.doesNotMatch(coder, /not run in this release/);
  assert.match(coder, /coverage, mutation and security-scan gates run on every code round/i);
});
