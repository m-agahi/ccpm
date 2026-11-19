// ccpmcwf 8.3.3 (yaadgaar #97):
// - next step 1: run wf_b025a832-dc0 stopped at preflight with "preflight returned no usable
//   path_check: the relayed output does not match the program's digest". That relay had no retry.
//   It now gets one standalone PATH check on a fresh agent one model tier above preflight's
//   (sonnet -> opus). A second relay that does not check out still stops at iac, and a relay that
//   checks out but names a real (non-shim) tool still stops at once, with no retry.
// - next step 2: the plan-ref chunk writers copy smaller chunks (PLAN_CHUNK_CHARS 2000, was 4000); the
//   per-chunk sha256 and the whole-payload seal stay. The run-state, park and held-out chunks keep
//   CHUNK_CHARS (4000): the held-out store's "too many chunks" cap counts chunks.
// - next step 3: infra:callers and infra:read-state already run on sonnet (8.2.1 #82) and retry on
//   opus; pinned here.
//
// dont_care: gate wording beyond the matched phrases; the order of unrelated labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, HERE, happy, runOne, sha256, canon, programSha, pathRecheckOut } from "./harness.mjs";

const NOT_SHIMMED = /terraform tooling on PATH is not shimmed/;
const RETRY = "infra:path-check:preflight:relay-retry";
const PROBE = { mode: "probe", repo: "/r", date: ARGS.date };
const SRC = readFileSync(join(HERE, "..", "src", "build-engine.js"), "utf8");

// a preflight path_check with the program's shape and a digest of another output
function badPreflight(s) {
  const pc = pathRecheckOut({}, ["/r"]);
  delete pc.status;
  delete pc.reason;
  pc.digest = "1".repeat(64);
  s.preflight = Object.assign({}, s.preflight, { path_check: pc, __raw_path_check: true });
  return s;
}
const modelOf = (out, l) => out.calls.filter((x) => x.label === l).map((x) => x.opts.model);

test("8.3.3 #97: a preflight path_check that misses its digest gets one PATH check on opus; a good one lets the run go on", async () => {
  for (const mode of [ARGS, PROBE]) {
    const out = await runOne(badPreflight(happy()), mode);
    assert.equal(out.result.status, mode.mode === "plan" ? "awaiting_confirmation" : "ok", mode.mode + ": " + out.result.reason);
    assert.deepEqual(modelOf(out, RETRY), ["opus"], out.labels.join(", "));
    assert.ok(out.logs.some((l) => /preflight: no usable path_check: the relayed output does not match the program's digest; checking once more on opus/.test(l)), out.logs.join("\n"));
    assert.ok(out.logs.some((l) => l.includes(RETRY + ": every IaC tool on the agent PATH is a nix shim, or absent")), out.logs.join("\n"));
  }
});

test("8.3.3 #97: a second relay that does not check out still stops at iac", async () => {
  const s = badPreflight(happy());
  s[RETRY] = (p) => Object.assign(pathRecheckOut({}, ["/r", JSON.parse(/Inputs: (\{.*\})/.exec(p)[1]).token]), { digest: "2".repeat(64) });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.stop_gate, "iac");
  assert.match(out.result.reason, NOT_SHIMMED);
  assert.match(out.result.reason, /could not complete/);
  assert.match(out.result.reason, /digest/);
  assert.equal(out.calls.filter((c) => c.label === RETRY).length, 1, "one retry only");
});

test("8.3.3 #97: a retry on other args, or with no result, stops too", async () => {
  for (const r of [() => pathRecheckOut({}, ["/r", "other-token"]), () => ({ status: "failed", reason: "boom" })]) {
    const s = badPreflight(happy());
    s[RETRY] = r;
    const out = await runOne(s, ARGS);
    assert.equal(out.result.status, "needs_human");
    assert.equal(out.result.stop_gate, "iac");
    assert.match(out.result.reason, NOT_SHIMMED);
  }
});

test("8.3.3 #97: a preflight path_check that checks out and names a real tool stops at once, with no retry", async () => {
  const s = happy();
  const tf = "terra" + "form";
  const pc = { tools: Object.assign(Object.fromEntries([tf, "to" + "fu", "t" + "fp", "terra" + "grunt", "dig" + "ger", "atlan" + "tis"].map((t) => [t, null])), { [tf]: { path: "/usr/bin/" + tf, shim: false } }), args: ["/r"], path_problems: [], program: { name: "path_check", sha256: programSha("path_check") } };
  pc.digest = sha256(canon(pc));
  pc.file_sha256 = programSha("path_check");
  s.preflight = Object.assign({}, s.preflight, { path_check: pc, __raw_path_check: true });
  const out = await runOne(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.match(out.result.reason, NOT_SHIMMED);
  assert.ok(out.result.reason.includes(tf + " at /usr/bin/" + tf), out.result.reason);
  assert.deepEqual(out.labels, ["preflight"]);
});

test("8.3.3 #97: the plan chunks are at most 2000 characters; per-chunk sha256 and the whole-payload seal stay", async () => {
  assert.match(SRC, /\nconst PLAN_CHUNK_CHARS = 2000;\n/);
  assert.match(SRC, /\nconst CHUNK_CHARS = 4000;\n/);
  assert.equal(SRC.match(/chunked\(refMessage\(full\), PLAN_CHUNK_CHARS\)/g).length, 3, "the seal loop, the plan ref and its comment");
  assert.doesNotMatch(SRC, /chunked\(refMessage\(full\)\)/);
  assert.match(SRC, /shas: chunks\.map\(\(c, i\) => \(\{ i, sha256: sha256Hex\(c\) \}\)\)/);
  assert.match(SRC, /return \{ expected: sha256Hex\(message\), chunks,/);
  // the plan writers' prompts carry chunks of at most 2000 characters, each with its sha256
  const out = await runOne(happy(), ARGS);
  const w = out.calls.filter((c) => /^infra:plan-chunks/.test(c.label));
  assert.ok(w.length, out.labels.join(", "));
  for (const c of w) {
    assert.match(c.prompt, /chunk\(s\) \(2000 characters each at most\)/);
    for (const m of c.prompt.matchAll(/chunk \d+ sha256 ([0-9a-f]{64}):\n([^\n]*)\n/g)) {
      assert.ok(m[2].length <= 2000, "chunk of " + m[2].length);
      assert.equal(sha256(m[2]), m[1]);
    }
  }
  const cp = out.calls.find((c) => /^infra:commit-plan/.test(c.label));
  assert.ok(cp && /plan_ref_write\.py/.test(cp.prompt), "the commit step runs plan_ref_write with the whole-payload sha256");
});

test("8.3.3 #97: infra:callers and infra:read-state run on sonnet; their retries step up to opus", () => {
  assert.match(SRC, /\["infra:callers", "sonnet"\]/);
  assert.match(SRC, /\["infra:read-state", "sonnet"\]/);
  assert.match(SRC, /const RETRY_UP = \{ haiku: "sonnet", sonnet: "opus",/);
});
