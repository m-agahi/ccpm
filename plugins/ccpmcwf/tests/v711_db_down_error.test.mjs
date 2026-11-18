// fleet 7.1.1 (L2142, yaadgaar #35), AC9 (guards existing): db_down needs no
// code change. dbTeardown calls the agent directly (not infra or dispatch) and
// reports d.error for every status. A failed infra:db-down relay whose down
// object has a valid program, args and digest and a non-null error gets the
// same teardown gate line as an ok relay with that down object, and the run
// result is not replaced.
//
// dont_care: the db-up gate lines; teardown timeout or a throwing agent
// (covered by v4_s5 '1981: a teardown agent that throws never replaces the result').

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const DECL = { version: 1, engine: "mariadb", major: "11.4", env: "YADGAR_TEST_DSN" };
// withDecl of v4_s5: the read steps relay a test-database declaration
function withDecl(s) {
  const td = (prompt) => ({ decl: DECL, error: null, args: [inputsOf(prompt).main_worktree, inputsOf(prompt).default_branch] });
  const bs = s["infra:branch-scan"];
  const vp = s["infra:verify-plan"];
  s["infra:branch-scan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(bs)), { test_db: td(prompt) });
  s["infra:verify-plan"] = (prompt) => Object.assign(JSON.parse(JSON.stringify(vp)), { test_db: td(prompt) });
  return s;
}

test("7.1.1 L2142 AC9: a failed db-down relay with the program's error is reported like the ok relay; the result stays", async () => {
  const outs = [];
  for (const status of ["failed", "ok"]) {
    const s = withDecl(happy());
    s["infra:db-down"] = (p) => {
      const d = F("db_down", "db_down", { removed: false, absent: false, error: "podman rm: no such container" }, [inputsOf(p).name, inputsOf(p).nonce]);
      delete d.status;
      delete d.reason;
      return { status, reason: "r", down: d };
    };
    outs.push(await run(s, ARGS));
  }
  const [out, ok] = outs;
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(out.result.reason, "PR ready for review; CI green, ready for human merge (no merge: policy merge never)");
  const line = "test database fleet-db-y42-n10000001 not confirmed removed (podman rm: no such container); it ends by itself (podman-timeout, fleet.expires 1700000000)";
  assert.ok(out.result.gate_log.includes(line), out.result.gate_log.join("\n"));
  assert.ok(ok.result.gate_log.includes(line), ok.result.gate_log.join("\n"));
  assert.deepEqual([ok.result.status, ok.result.reason], [out.result.status, out.result.reason]);
});
