// fleet 7.3.0 (#49, L2182) A14: no silent review skip. A pr-opener that
// returns ok with no pr_url or no pr_number stops the run (needs_human, stop
// gate role) before any review; so does the body-update call. A review step
// reached with no PR stops with stop gate review, never "review skipped".
//
// dont_care: the stop reason's wording past its first words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, SOURCE, happy, run } from "./harness.mjs";

const NOPR = { status: "ok", reason: "x", pr_url: null, pr_number: null, created: false, template_used: null, gates_not_run_stated: true };
const BODY = { id: "R1", severity: "blocking", category: "pr_body_claim", file: "PR body", line: null, summary: "body says 147 passed", evidence: "npm test: 133 pass" };

test("7.3.0 A14: an ok pr-opener with no PR stops needs_human (role); no review runs", async () => {
  const out = await run(happy({ script: { "role:fleet-pr-opener": NOPR } }), ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "role");
  assert.match(out.result.reason, /^pr-opener returned ok with no PR \(pr_url null, pr_number null\)/);
  assert.ok(!out.labels.some((l) => /^role:pr-review/.test(l)), out.labels.join(", "));
});

test("7.3.0 A14: the no-PR check sits in the opener wrapper, so :p2, :again, :counts and body-v calls all get it", () => {
  const i = SOURCE.indexOf("const opener = async (lb, more) =>");
  assert.ok(i >= 0);
  const body = SOURCE.slice(i, SOURCE.indexOf("const why = ", i));
  assert.match(body, /pr_url == null \|\| \w+\.pr_number == null/);
});

test("7.3.0 A14: the body-update pr-opener with no PR stops needs_human (role)", async () => {
  const F = happy();
  const rs = F["hasher:pre-review:v1"];
  Object.assign(F, {
    "role:pr-review:v1": { status: "ok", reason: "x", verdict: "changes_requested", findings: [BODY], touches_gate: false, checked: [] },
    "role:fleet-pr-opener:body-v1": NOPR,
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": rs,
    "hasher:fp-post:pr-review:v2": rs,
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
  });
  const out = await run(F, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "role");
  assert.ok(!out.labels.includes("role:pr-review:v2"), out.labels.join(", "));
});

test("7.3.0 A14: a review step with no PR stops (stop gate review), never a skip", () => {
  const i = SOURCE.indexOf('} else if (step === "review") {');
  assert.ok(i >= 0);
  const head = SOURCE.slice(i, SOURCE.indexOf("reviews++;", i));
  assert.match(head, /halt\("s", "needs_human", [^\n]*"review"\)/);
  assert.ok(!SOURCE.includes("review skipped: no PR"));
});
