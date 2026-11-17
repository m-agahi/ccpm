// fleet 7.1.1 (L2142, yaadgaar #35), AC2: when the digest retry of a failed
// relay also has a wrong digest, the run stops failed with the generic
// '<label> returned failed' halt, after exactly one retry.
//
// dont_care: the reason text after 'returned failed: '; I/O failure paths
// (scripted relays only, no I/O in the script).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGS, happy, run, inputsOf, programOf, programSha, relayDigestOf, K } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const BAD = "0".repeat(64);
const count = (L, l) => L.filter((x) => x === l).length;

test("7.1.1 L2142 AC2: a failed ruleset relay mis-copied twice halts 'returned failed' after exactly one digest retry", async () => {
  const s = happy();
  // the unscripted :digest-retry replays this script
  s["infra:ruleset-surface:plan"] = (p) => Object.assign(F("ruleset_surface", "ruleset_surface", { surface: [], sources: [], read: [], unreadable: [], error: "x" }, inputsOf(p).args), { digest: BAD });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:surfaces:plan returned failed: the program reported an error"), out.result.reason);
  assert.equal(count(out.labels, "infra:surfaces:plan:digest-retry"), 1, out.labels.join(", "));
  assert.ok(!out.labels.some((l) => l.endsWith(":digest-retry:digest-retry")), out.labels.join(", "));
});

test("7.1.1 L2142 AC2 (boundary): a failed ci-watch relay mis-copied twice halts 'returned failed' after exactly one digest retry", async () => {
  const s = happy();
  s["infra:ci-watch:w1"] = (p) =>
    Object.assign(
      F(
        "ci_watch",
        "ci_watch",
        { state: "error", checks: [{ name: "test", state: "PENDING", bucket: "pending", url: "https://github.com/o/r/actions/runs/77/job/88" }], failed: [], required: null, head: null, elapsed_s: 10, error: "gh pr checks: HTTP 502" },
        inputsOf(p).args,
      ),
      { digest: BAD },
    );
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "failed", out.result.reason);
  assert.ok(out.result.reason.startsWith("infra:ci-watch:w1 returned failed"), out.result.reason);
  assert.equal(count(out.build.labels, "infra:ci-watch:w1:digest-retry"), 1, out.build.labels.join(", "));
});
