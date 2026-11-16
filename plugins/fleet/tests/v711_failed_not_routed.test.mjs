// fleet 7.1.1 (L2142, yaadgaar #35), AC10 (guards existing): a failed relay is
// never routed when its args differ from the sent args, its error is null or
// empty, or it has no digest. Such a relay halts '<label> returned failed' with
// no digest or args retry. A failed pr_state relay with a mis-copied digest also
// halts 'returned failed' with no digest retry (pr_state is a write step).
//
// dont_care: the reason text after 'returned failed: '; I/O failure paths
// (scripted relays only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, happy, run, runOne, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const RETRY = /:(args|digest)-retry$/;

test("7.1.1 L2142 AC10: a failed ci_watch relay on other args halts 'returned failed', with no retry", async () => {
  const s = happy();
  s["infra:ci-watch:w1"] = () => F("ci_watch", "ci_watch", { state: "error", checks: [], failed: [], required: null, head: null, elapsed_s: 10, error: "gh pr checks: HTTP 502" }, ["x"]);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:ci-watch:w1 returned failed"), out.result.reason);
  assert.ok(!out.build.labels.includes("infra:ci-watch:w1:args-retry") && !out.build.labels.includes("infra:ci-watch:w1:digest-retry"), out.build.labels.join(", "));
});

test("7.1.1 L2142 AC10: a failed precommit_ids relay on other args halts 'returned failed', with no retry", async () => {
  const s = happy();
  Object.assign(s, {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:scope-and-plan": Object.assign({}, happy()["role:scope-and-plan"], { repo_obligations: [{ id: "fmt", kind: "other", instruction: "format", check_cmd: "pre-commit run prettier --all-files" }] }),
  });
  s["infra:precommit-ids"] = () => F("precommit_ids", "precommit_ids", { present: true, ids: [], parser: null, error: "PyYAML unavailable" }, ["/x", "y"]);
  const out = await runOne(s, { ...ARGS, confirm: "auto" });
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:precommit-ids returned failed"), out.result.reason);
  assert.ok(!out.labels.some((l) => RETRY.test(l)), out.labels.join(", "));
});

test("7.1.1 L2142 AC10: a failed policy relay with a null error halts 'returned failed'", async () => {
  const s = happy();
  s["infra:policy"] = (p) => F("policy", "policy", { profile: null, file: null, policy_sha256: null, caps: null, matched: null, error: null, now: 1000 }, inputsOf(p).args);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:policy:plan returned failed"), out.result.reason);
});

test("7.1.1 L2142 AC10: a failed pr_state ready relay with an empty error halts 'returned failed'", async () => {
  const s = happy();
  s["infra:pr-ready"] = (p) => F("pr_state", "pr_state:ready", { mode: "ready", was_draft: true, is_draft: true, head: inputsOf(p).args[4], state: "OPEN", error: "" }, inputsOf(p).args);
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:pr-ready returned failed"), out.result.reason);
});

test("7.1.1 L2142 AC10 (boundary): a failed ruleset relay with no digest halts 'returned failed', with no digest retry", async () => {
  const s = happy();
  s["infra:ruleset-surface:plan"] = (p) => {
    const r = F("ruleset_surface", "ruleset_surface", { surface: [], sources: [], read: [], unreadable: [], error: "x" }, inputsOf(p).args);
    delete r.digest;
    return r;
  };
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:ruleset-surface:plan returned failed"), out.result.reason);
  assert.ok(!out.labels.includes("infra:ruleset-surface:plan:digest-retry"), out.labels.join(", "));
});

test("7.1.1 L2142 AC10: a failed pr_state relay with a mis-copied digest halts 'returned failed', with no digest retry (a write step)", async () => {
  const s = happy();
  s["infra:pr-ready"] = (p) => Object.assign(F("pr_state", "pr_state:ready", { mode: "ready", was_draft: true, is_draft: true, head: inputsOf(p).args[4], state: "OPEN", error: "gh pr ready: HTTP 502" }, inputsOf(p).args), { digest: "0".repeat(64) });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:pr-ready returned failed"), out.result.reason);
  assert.ok(!out.build.labels.includes("infra:pr-ready:digest-retry"), out.build.labels.join(", "));
});
