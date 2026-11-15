// fleet 7.0.0 AC7 (yaadgaar #699), guard: Jira, URL, plan and text inputs are
// unchanged by the ledger routing.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, BRIEF, happy, run, runOne, call, noUnscripted } from "./harness.mjs";


test("7.0.0 AC7: the intake prompt keeps the Jira, GitHub, Codeberg, plan and text rules", async () => {
  const out = await runOne(happy(), { ...ARGS, confirm: "ask" });
  const p = call(out, "intake").prompt;
  for (const s of [
    "2. Jira key (`ABC-123`): kind jira.",
    "getJiraIssue(issueIdOrKey, responseContentFormat=\"markdown\")",
    "3. GitHub issue or PR URL",
    "4. Codeberg issue or PR URL (`https://codeberg.org/<o>/<r>/issues/<n>` or `/pulls/<n>`): kind codeberg. `curl -sf https://codeberg.org/api/v1/repos/<o>/<r>/issues/<n>`. ref = `<o>/<r>#<n>`.",
    "5. A path to an existing `.md` file inside <repo>: kind plan.",
    "6. Anything else: kind text; ref = \"text\"; body = `input` verbatim.",
  ])
    assert.ok(p.indexOf(s) >= 0, "intake prompt lost: " + s);
});

test("7.0.0 AC7: plan and text inputs build with no ledger step and adapter none", async () => {
  for (const [input, src] of [
    ["docs/plans/x.md", { kind: "plan", ref: "docs/plans/x.md", url: null, body: "plan text" }],
    ["add a thing", { kind: "text", ref: "text", url: null, body: "add a thing" }],
  ]) {
    const out = await run(happy({ brief: { ...BRIEF, sources: [src] } }), { ...ARGS, input, confirm: "ask" });
    noUnscripted(out);
    assert.equal(out.result.status, "ok", input + ": " + out.result.reason);
    assert.equal(out.result.ledger_adapter, "none");
    assert.equal(out.result.ledger_status, "none");
    assert.ok(!out.labels.some((l) => /^infra:(ledger|yaadgaar)-/.test(l)), out.labels.join(", "));
  }
});
