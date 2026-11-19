// fleet 8.2.5 (#89) AC3: role Bash calls ran with the tool default of 120 s, so a slow test or
// hook run was killed mid-way. Every role prompt now asks for timeout 600000 ms, on its own line
// right before the StructuredOutput rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run } from "./harness.mjs";

const LINE = "Give every Bash call timeout 600000 ms.";
const NEXT = "Return the role's final JSON object through the StructuredOutput tool";

test("8.2.5 #89 AC3: every role:* prompt holds the timeout line once, right before the StructuredOutput rule", async () => {
  const out = await run(happy(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const roles = out.calls.filter((c) => /^role:/.test(c.label));
  assert.ok(roles.length >= 5, "role calls: " + roles.length);
  for (const c of roles) {
    assert.equal(c.prompt.split(LINE).length, 2, c.label + " holds the line once");
    assert.ok(c.prompt.includes("\n" + LINE + "\n" + NEXT), c.label + ": the line sits on its own right before the StructuredOutput rule");
  }
});
