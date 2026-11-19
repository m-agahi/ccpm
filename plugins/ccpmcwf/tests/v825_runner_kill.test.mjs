// fleet 8.2.5 (#89) AC4: the Bash tool can kill a held-out sandbox-run call (its 120 s default)
// before the sandbox's own 540 s deadline. The held-out runner now treats such a kill as
// `timed_out` true, so it returns store "timeout", a stop for the human (ruling D2), never not_run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_TEXT } from "./harness.mjs";

const RULE = "If the Bash tool stops the sandbox-run call itself (it reports a timeout and no JSON is printed), treat that as `timed_out` true.";

test("8.2.5 #89 AC4: the held-out runner's step 4 treats a Bash tool kill of sandbox-run as timed_out", () => {
  const text = ROLE_TEXT["fleet-held-out-runner"];
  assert.equal(text.split(RULE).length, 2, "the rule is in the role file once");
  const line = text.split("\n").find((l) => l.includes(RULE));
  assert.ok(line.includes("sandbox-run <worktree> <tmp>"), "the rule is on the sandbox-run line");
  assert.ok(line.indexOf(RULE) < line.indexOf("If `timed_out` is true"), "the rule comes before the timed_out branch");
  const step4 = text.indexOf("4. **One throwaway test per example.**");
  const step5 = text.indexOf("5. **Remove the copy:**");
  assert.ok(step4 >= 0 && step4 < text.indexOf(RULE) && text.indexOf(RULE) < step5, "the rule is in step 4");
});
