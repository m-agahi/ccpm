// fleet 7.4.0 car 5 (#66).
// - E1: pr_test_block and pr_body_block are in ERROR_BRANCH_PROGRAMS. A relay the agent marked
//   failed (the program exited 0 with a valid digest and its own `error`) reaches the caller's
//   own stop (stop_gate stats, "<label>: <error>; check the body of <url>"), not the generic
//   "returned failed". Mutation: with the two names removed the stop is "returned failed".
// - E2: pr_state.py merge whose branch delete raises prints merged true and a non-null error; the
//   run records the merge ("merged as <sha>").
//
// dont_care: the order of unrelated labels; the forge's other calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, SOURCE, SCRIPTS_SRC, happy, run, inputsOf, programOf, programSha, relayDigestOf, K, sha256, spawnSync } from "./harness.mjs";

function F(name, id, fields, args) {
  const r = Object.assign({ status: "failed", reason: "the program reported an error" }, fields, { args, program: programOf(name), file_sha256: programSha(name) });
  r.digest = relayDigestOf(r, K(id));
  return r;
}
const URL7 = "https://github.com/o/r/pull/7";
const testsRelay = (p) => {
  const a = inputsOf(p).args;
  return F("pr_test_block", "pr_test_block", { replaced: null, edited: false, block_sha256: sha256(Buffer.from(a[3], "base64").toString("utf8")), claims: [], claims_truncated: false, body_sha256_before: null, body_sha256_after: null, headers_missing: [], error: "body over cap" }, a);
};
const statsRelay = (p) => {
  const a = inputsOf(p).args;
  return F("pr_body_block", "pr_body_block", { replaced: null, wall_s: 5, block_sha256: sha256(Buffer.from(a[3], "base64").toString("utf8").replace("@@WALL@@", "5s")), body_sha256_before: null, body_sha256_after: null, headers_missing: [], error: "body over cap" }, a);
};
const LIST = 'const ERROR_BRANCH_PROGRAMS = ["ruleset_surface", "hook_surface", "pr_state", "ci_watch", "orch_scan", "policy", "precommit_ids", "pr_body_block", "pr_test_block"];';

test("7.4.0 #66 E1: a failed pr_test_block relay for its own error stops at the caller's stats gate", async () => {
  const s = happy();
  s["infra:pr-tests"] = testsRelay;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "stats");
  assert.match(out.result.reason, /^infra:pr-tests: body over cap; check the body of /);
});

test("7.4.0 #66 E1: a failed pr_body_block relay for its own error stops at the caller's stats gate", async () => {
  const s = happy();
  s["infra:pr-stats"] = statsRelay;
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "stats");
  assert.match(out.result.reason, /^infra:pr-stats: body over cap; check the body of /);
});

test("7.4.0 #66 E1 mutation: without the two names the stop is the generic 'returned failed'", async () => {
  assert.equal(SOURCE.split(LIST).length - 1, 1, "the list holds both names");
  const mut = SOURCE.replace(LIST, LIST.replace(', "pr_body_block", "pr_test_block"', ""));
  for (const [label, relay] of [["infra:pr-tests", testsRelay], ["infra:pr-stats", statsRelay]]) {
    const s = happy();
    s[label] = relay;
    s.__source = mut;
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "failed", out.result.reason);
    assert.match(out.result.reason, new RegExp("^" + label + " returned failed"));
  }
});

// ---------------------------------------------------------------- E2: pr_state.py merge
const PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const SHA1 = "a".repeat(40);
const MC = "e".repeat(40);

test("7.4.0 #66 E2: pr_state.py merge whose branch delete raises prints merged true and the error", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-740e-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ state: "OPEN", headRefOid: SHA1, headRefName: "fleet/y42-add-thing", mergeStateStatus: "CLEAN" }));
    // a fake gh; the branch read removes the gh binary, so the delete call raises (OSError)
    const gh =
      "#!" + PY + "\nimport json, os, sys\nD = " + JSON.stringify(dir) + "\na = sys.argv[1:]\n" +
      "pr = json.load(open(D + '/pr.json'))\n" +
      "if a[:2] == ['repo', 'view']:\n    print(json.dumps({'nameWithOwner': 'o/r', 'owner': {'login': 'o'}, 'squashMergeAllowed': True, 'mergeCommitAllowed': True, 'rebaseMergeAllowed': False, 'autoMergeAllowed': False}))\n    sys.exit(0)\n" +
      "if a[:2] == ['pr', 'checks']:\n    print(json.dumps([{'name': 'test', 'state': 'SUCCESS', 'bucket': 'pass', 'link': None}]))\n    sys.exit(0)\n" +
      "if a[:2] == ['pr', 'merge']:\n    pr.update(state='MERGED', mergeCommit={'oid': " + JSON.stringify(MC) + "})\n    json.dump(pr, open(D + '/pr.json', 'w'))\n    sys.exit(0)\n" +
      "if a[:2] == ['pr', 'view'] and '--json' in a:\n    print(json.dumps({k: pr.get(k) for k in a[a.index('--json') + 1].split(',')}))\n    sys.exit(0)\n" +
      "if a[:1] == ['api'] and '/branches/' in a[-1]:\n    os.unlink(sys.argv[0])\n    sys.stderr.write('HTTP 500')\n    sys.exit(1)\n" +
      "sys.exit('unexpected ' + json.dumps(a))\n";
    writeFileSync(join(dir, "bin", "gh"), gh);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const r = spawnSync(PY, ["-I", join(SCRIPTS_SRC, "pr_state.py"), "merge", "gh", "o/r", "7", SHA1], { encoding: "utf8", env: { PATH: join(dir, "bin"), HOME: dir } });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.merged, true);
    assert.equal(o.merge_sha, MC);
    assert.equal(typeof o.error, "string");
    assert.ok(o.error.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });

test("7.4.0 #66 E2: the run records the merge when the merge relay carries the branch-delete error", async () => {
  for (const status of ["failed", "ok"]) {
    const s = happy();
    s["infra:policy"] = (p) => ({ status: "ok", reason: "read", profile: "personal", file: "/h/.config/fleet/policy.json", policy_sha256: null, caps: PERSONAL, matched: "profile personal", error: null, now: 1000, args: inputsOf(p).args });
    s["infra:pr-merge"] = (p) => {
      const a = inputsOf(p).args;
      return Object.assign(F("pr_state", "pr_state:merge", { mode: "merge", merged: true, auto_enabled: false, method: "squash", merge_sha: MC, blocked: null, merge_state: "UNKNOWN", head: a[4], branch_deleted: null, error: "[Errno 2] No such file or directory: 'gh'" }, a), { status });
    };
    const out = await run(s, ARGS);
    assert.equal(out.result.status, "ok", status + ": " + out.result.reason);
    assert.match(out.result.reason, new RegExp("merged as " + MC + ", remote branch not deleted"), status);
  }
});
