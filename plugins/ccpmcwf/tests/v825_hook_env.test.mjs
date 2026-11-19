// fleet 8.2.5 (#89) AC2: hookEnv() was buildEnv() plus the DSN only. The commit step named
// PYTHONDONTWRITEBYTECODE=1 by hand in its <git> prefix; the push hooks got nothing. The hook env
// now starts from PYTHONDONTWRITEBYTECODE "1", then the build vars, then the DSN, and the commit
// prefix names it once, from the hook env. PYTEST_ADDOPTS stays out (5.0.4; ruling D1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, call, inputsOf, buildEnvOf, buildAssignsRe } from "./harness.mjs";

test("8.2.5 #89 AC2: the commit and push hook env hold PYTHONDONTWRITEBYTECODE next to the build vars", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const c = inputsOf(call(out, "infra:commit:r1").prompt);
  assert.deepEqual(c.hook_env, Object.assign({ PYTHONDONTWRITEBYTECODE: "1" }, buildEnvOf("commit-r1")));
  const p = inputsOf(call(out, "infra:push").prompt);
  assert.deepEqual(p.hook_env, Object.assign({ PYTHONDONTWRITEBYTECODE: "1" }, buildEnvOf("push")));
  assert.equal(p.args[5], JSON.stringify(p.hook_env));
  for (const e of [c.hook_env, p.hook_env]) assert.ok(!("PYTEST_ADDOPTS" in e), "D1: no PYTEST_ADDOPTS in the hook env");
});

test("8.2.5 #89 AC2: the commit <git> prefix names PYTHONDONTWRITEBYTECODE once, from the hook env", async () => {
  const out = await run(happy(), ARGS);
  const prompt = call(out, "infra:commit:r1").prompt;
  const line = prompt.split("\n").find((l) => l.startsWith("Every git command below runs as <git> = "));
  assert.ok(line, prompt);
  assert.match(line, new RegExp("`env GIT_CONFIG_NOSYSTEM=1 PYTHONDONTWRITEBYTECODE='1' " + buildAssignsRe("commit-r1") + " git "));
  assert.equal(line.split("PYTHONDONTWRITEBYTECODE").length, 2, line);
});
