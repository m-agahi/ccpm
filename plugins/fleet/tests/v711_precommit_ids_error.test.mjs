// fleet 7.1.1 (L2142, yaadgaar #35), AC8: precommit_ids. In confirm auto, a
// routed failed precommit_ids relay with a non-null error fails the
// auto-confirm commands check, the same as the ok relay.
//
// dont_care: needs_max_section wording beyond the plan path; I/O failure paths
// (scripted relays only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, PB, happy, runOne, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
// autoHappy of build_task_run.test.mjs, with the planner's `pre-commit run prettier --all-files` obligation
function autoCheck() {
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
    "role:fleet-code-judge:r1": Object.assign({}, happy()["role:fleet-code-judge:r1"], { obligations_check: [{ id: "fmt", met: true, evidence: "ran", check_exit: 0 }] }),
  });
  return s;
}

test("7.1.1 L2142 AC8: a routed failed precommit_ids relay fails the auto-confirm commands check, as the ok relay does", async () => {
  const outs = [];
  for (const status of ["failed", "ok"]) {
    const s = autoCheck();
    s["infra:precommit-ids"] = (p) => Object.assign(F("precommit_ids", "precommit_ids", { present: true, ids: [], parser: null, error: "PyYAML unavailable" }, [inputsOf(p).main_worktree, inputsOf(p).plan_commit]), { status });
    outs.push(await runOne(s, { ...ARGS, confirm: "auto" }));
  }
  const [out, ok] = outs;
  const pick = (o) => [o.result.status, o.result.stop_gate, o.result.failed_check, o.result.reason];
  assert.deepEqual(pick(out), pick(ok));
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "commands");
  assert.equal(out.result.failed_check, "commands");
  assert.equal(out.result.reason, "auto-confirm: commands check failed: .pre-commit-config.yaml unreadable: PyYAML unavailable");
  assert.ok(!out.labels.some((l) => l.startsWith("role:fleet-test-writer")), out.labels.join(", "));
});
