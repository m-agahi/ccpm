// fleet 8.2.5 (#89) AC1: the Bash tool shell is zsh, and zsh does not split an unquoted `$E`. A
// role that stored test_env_prefix in a variable and ran `$E cmd` got exit 127 and read it as a
// red test. The build env note now says to paste the prefix literally, never in a shell variable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf } from "./harness.mjs";

const RULE = "Paste it literally, never in a shell variable (zsh: exit 127, not a red test).";

test("8.2.5 #89 AC1: test_env_note of every role that gets test_env_prefix ends with the paste-literally rule", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  let seen = 0;
  for (const c of out.calls) {
    if (!/^role:/.test(c.label)) continue;
    let i = null;
    try {
      i = inputsOf(c.prompt);
    } catch (e) {
      continue;
    }
    if (!i || !("test_env_prefix" in i)) continue;
    assert.ok(typeof i.test_env_note === "string" && i.test_env_note.endsWith(" " + RULE), c.label + ": " + i.test_env_note);
    assert.equal(i.test_env_note.split(RULE).length, 2, c.label + " holds the rule once");
    seen++;
  }
  assert.ok(seen >= 3, "roles with test_env_prefix: " + seen);
});
