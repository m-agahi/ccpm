// fleet 6.0.1 (ledger 2050): the path after update-branch (ADR-1203). D1: a CI red caused by the
// diff after an overlap update stops with the CI stop code, never a CI-fix coder round on the
// forge's merge commit. D2: the re-review after the update diffs against the base tip the update
// relayed. D3: the run-state maps digest follows the merge's hashes. D4: a resume after an overlap
// update stops with its own message. D5: pr_updated and update {head, base} are in the run-state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, HASHES, H, HASHES_FLAT, PB, SCRIPTS_SRC, happy, run, call, inputsOf, stateJsonOf, spawnSync } from "./harness.mjs";

const D = "d".repeat(40);
const C = "c".repeat(40);
const DEFAULT_CAPS = { pr_ready: true, ci_watch: true, ci_watch_minutes: 60, stats: true, merge: "never", update_branch: "never", ci_trigger: false, review_post: "none" };
const PERSONAL = Object.assign({}, DEFAULT_CAPS, { merge: "auto", update_branch: "once", ci_trigger: true });
const polOut = (over) => (p) => Object.assign({ status: "ok", reason: "read", profile: null, file: "/h/p.json", policy_sha256: null, caps: Object.assign({}, DEFAULT_CAPS), matched: "x", error: null, now: 1000, args: inputsOf(p).args }, over);
const BEHIND = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "b", mode: "merge", merged: false, auto_enabled: false, method: "squash", merge_sha: null, blocked: "behind", merge_state: "BEHIND", head: a[4], branch_deleted: null, error: null, args: a };
};
const GREEN = (p) => {
  const a = inputsOf(p).args;
  return { status: "ok", reason: "w", state: "green", checks: [{ name: "test", state: "SUCCESS", bucket: "pass", url: null }], failed: [], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
};
const RED = (p) => {
  const a = inputsOf(p).args;
  const u = "https://github.com/o/r/actions/runs/77/job/88";
  return { status: "ok", reason: "w", state: "red", checks: [{ name: "test", state: "FAILURE", bucket: "fail", url: u }], failed: [{ name: "test", url: u, run_id: "77", verified: true }], required: true, head: a[3], elapsed_s: 60, error: null, args: a };
};
// the hashed maps of the forge's merge: the base changed a hashed key
const HASHES_U = H(Object.assign({}, HASHES_FLAT, { "pyproject.toml#tool.pytest": "hp-base" }));
const WRITTEN = (p) => ({ status: "ok", reason: "ok", results: inputsOf(p).tasks.map((x) => ({ key: x.key, status: "written" })) });

// personal profile; the green PR is behind; update-branch moves it to D, a merge of the old head and C,
// and the base change touches a PR file (overlap): the merge is fetched and reviewed again (v2)
function overlap(over) {
  const t = happy();
  t["infra:policy"] = polOut({ profile: "personal", caps: PERSONAL });
  t["infra:pr-merge"] = BEHIND;
  t["infra:pr-update"] = (p) => ({ status: "ok", reason: "u", mode: "update", updated: true, head: D, base: C, overlap: ["src/x.py"], error: null, args: inputsOf(p).args });
  Object.assign(t, {
    "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES },
    "infra:review-paths:v2": { status: "ok", reason: "listed", changed_paths: ["src/x.py"] },
    "hasher:pre-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "role:pr-review:v2": { status: "ok", reason: "clean", verdict: "approve", findings: [], touches_gate: false, checked: [] },
    "hasher:fp-post:pr-review:v2": { status: "ok", fingerprint: { head: D, tree: "KU" } },
    "infra:review-cleanup:v2": { status: "ok", reason: "clean" },
    "infra:ci-watch:w1": GREEN,
    "infra:ci-watch:w2": GREEN,
    "infra:ledger-writeback:ci": WRITTEN,
  });
  return Object.assign(t, over || {});
}
function capture(t, labels) {
  const got = {};
  for (const l of labels)
    t[l] = (prompt) => {
      got[l] = stateJsonOf(prompt);
      return { status: "ok", reason: "written", head: inputsOf(prompt).expected_head, state_sha: "f".repeat(40) };
    };
  return got;
}

test("6.0.1 D1: a CI red caused by the diff after an overlap update stops with ci_red and one CI write-back; no CI-fix coder round", async () => {
  const t = overlap({ "infra:ci-watch:w2": RED, "role:fleet-ci-classifier:w2": { status: "ok", reason: "c", checks: [{ name: "test", cause: "diff" }] } });
  // what the coder would do, if it ran
  t["role:fleet-coder:r2"] = { status: "ok", changed_paths: ["src/x.py"] };
  t["hasher:post-coder:r2"] = { status: "ok", fingerprint: { head: D, tree: "K2" }, hashes: HASHES };
  const out = await run(t, ARGS);
  const L = out.build.labels;
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "ci", out.result.reason);
  assert.match(out.result.reason, /^CI red after update-branch, caused by the diff: test \(diff/);
  assert.ok(!L.includes("role:fleet-coder:r2"), L.join(", "));
  assert.equal(L.filter((l) => l === "infra:ledger-writeback:ci").length, 1, L.join(", "));
  assert.match(inputsOf(call(out, "infra:ledger-writeback:ci").prompt).section_text.split("\n")[0], /; stopped: ci_red$/);
});

test("6.0.1 D2: the re-review after update-branch diffs against the base tip the update relayed; the first review keeps the plan base", async () => {
  const out = await run(overlap(), ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  assert.equal(inputsOf(call(out, "infra:review-paths:v1").prompt).base_ref, PB);
  assert.equal(inputsOf(call(out, "infra:review-paths:v2").prompt).base_ref, C);
  assert.equal(inputsOf(call(out, "role:pr-review:v2").prompt).base_ref, C);
});

test("6.0.1 D2: review_paths.py on the forge's merge: a base-only file is in plan_base..merge and absent from base_tip..merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-601-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (...a) => {
    const r = spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const planBase = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "fleet");
  writeFileSync(join(dir, "pr.txt"), "pr\n");
  g("add", "-A");
  g("commit", "-q", "-m", "pr");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "base_only.txt"), "b\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base moves");
  const tip = g("rev-parse", "HEAD");
  g("checkout", "-q", "fleet");
  g("merge", "-q", "--no-edit", "main");
  const merge = g("rev-parse", "HEAD");
  const paths = (base) => {
    const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "review_paths.py"), dir, base, merge], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).changed_paths;
  };
  assert.deepEqual(paths(planBase).sort(), ["base_only.txt", "pr.txt"]);
  assert.deepEqual(paths(tip), ["pr.txt"]);
});

test("6.0.1 D3 and D5: the run-state after the update carries the merge's maps digest, pr_updated and update {head, base}", async () => {
  const t = overlap({ "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES_U } });
  const got = capture(t, ["infra:state:reviewed:v1", "infra:state:reviewed:v2"]);
  const out = await run(t, ARGS);
  assert.equal(out.result.status, "ok", out.result.reason);
  const v1 = got["infra:state:reviewed:v1"];
  const v2 = got["infra:state:reviewed:v2"];
  assert.equal(v1.pr_updated, false);
  assert.equal(v1.update, null);
  assert.equal(v2.approved_sha, D);
  assert.equal(v2.code_tree, "KU");
  assert.match(v2.maps_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(v2.maps_digest, v1.maps_digest, "the base changed a hashed key: the digest follows the merge");
  assert.equal(v2.pr_updated, true);
  assert.deepEqual(v2.update, { head: D, base: C });
  // the same hashes give the same digest
  const s = overlap();
  const same = capture(s, ["infra:state:reviewed:v1", "infra:state:reviewed:v2"]);
  await run(s, ARGS);
  assert.equal(same["infra:state:reviewed:v2"].maps_digest, same["infra:state:reviewed:v1"].maps_digest);
});

test("6.0.1 D5: a resumed run-state with pr_updated true never runs update-branch again", async () => {
  const t = overlap({ "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES_U } });
  const got = capture(t, ["infra:state:reviewed:v2"]);
  const first = await run(t, ARGS);
  assert.equal(first.result.status, "ok", first.result.reason);
  const st = got["infra:state:reviewed:v2"];
  // the first run's plan store and stubs
  const r = Object.assign(overlap(), t);
  // NOTE: this verify stub (HEAD at the forge merge, fleet-only commits) is a state the real
  // verify_since cannot produce today: the merge commit and the base commits are in commits_since,
  // so a real resume after an overlap update stops in verify (D4). It tests the run-state round trip.
  r["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { head: D, commits_since: [{ sha: D, subject: "feat(thing): add thing" }], changed_since: ["src/x.py"] });
  r["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: D, message: JSON.stringify(st), head: D, head_tree: "KU", clean: true };
  r["hasher:resume"] = { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: JSON.parse(JSON.stringify(HASHES_U)) };
  // still behind: a second update-branch would run here, if the run-state lost pr_updated
  r["infra:pr-merge"] = BEHIND;
  r["infra:pr-merge:u1"] = BEHIND;
  const out = await run(r, { mode: "build", plan_ref: first.plan.result.plan_ref, date: ARGS.date, project: "o/r" });
  const L = out.labels;
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.match(out.result.reason, /^green, merge blocked: behind/);
  assert.ok(L.includes("infra:pr-merge:u1"), L.join(", "));
  assert.ok(!L.includes("infra:pr-update"), L.join(", "));
});

const D4_TEXT = "a merge commit (possibly update-branch) is on the branch; this plan ref cannot be resumed or re-built — finish the PR by hand or re-plan on the new base";
test("6.0.1 D4: a resume after an overlap update stops with the update-branch message, not the non-fleet commit message", async () => {
  const s = happy();
  const fleet = "1".repeat(40);
  const base = C;
  s["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], {
    head: D,
    commits_since: [
      { sha: base, subject: "fix(other): a base commit", parents: [PB.padEnd(40, "0")] },
      { sha: D, subject: "Merge branch 'main' into fleet/x", parents: [fleet, base] },
      { sha: fleet, subject: "feat(thing): add thing", parents: [PB.padEnd(40, "0")] },
    ],
    changed_since: ["src/x.py"],
  });
  const out = await run(s, ARGS);
  assert.equal(out.result.status, "needs_human");
  assert.equal(out.result.reason, D4_TEXT);
  assert.ok(!/re-run build/.test(out.result.reason));
  // a non-fleet commit with no forge merge keeps the old message
  const o = happy();
  o["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { head: D, commits_since: [{ sha: D, subject: "chore: hand edit", parents: [fleet] }, { sha: fleet, subject: "feat(thing): add thing", parents: [PB.padEnd(40, "0")] }], changed_since: ["src/x.py"] });
  const q = await run(o, ARGS);
  assert.match(q.result.reason, /^plan changed since approval: branch moved by a non-fleet commit /);
});

test("6.0.1 D4: verify_since.py lists the parents of each commit since the plan base", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-601v-"));
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  const g = (...a) => {
    const r = spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const pb = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "fleet");
  writeFileSync(join(dir, "pr.txt"), "pr\n");
  g("add", "-A");
  g("commit", "-q", "-m", "feat: pr");
  const f1 = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), "b\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base moves");
  const tip = g("rev-parse", "HEAD");
  g("checkout", "-q", "fleet");
  g("merge", "-q", "--no-edit", "main");
  const m = g("rev-parse", "HEAD");
  const r = spawnSync("python3", ["-I", join(SCRIPTS_SRC, "verify_since.py"), dir, pb, "docs/plans/x.md"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  const by = Object.fromEntries(o.commits_since.map((c) => [c.sha, c]));
  assert.deepEqual(by[m].parents, [f1, tip]);
  assert.equal(by[m].subject, "Merge branch 'main' into fleet");
  assert.deepEqual(by[f1].parents, [pb]);
  assert.equal(by[f1].subject, "feat: pr");
});

test("6.0.1 (review S2/S3): review changes on the update-branch head stop with the findings in the run result only; no pr-opener call before the halt", async () => {
  const t = overlap({
    "role:pr-review:v2": { status: "ok", reason: "broken", verdict: "changes_requested", findings: [{ id: "F1", severity: "blocking", category: "correctness", file: "src/x.py", line: 1, summary: "the merge broke x", evidence: "e" }, { id: "N1", severity: "nit", category: "style", file: "src/x.py", line: 2, summary: "nit", evidence: "e" }], touches_gate: false, checked: [] },
  });
  const out = await run(t, ARGS);
  const L = out.build.labels;
  assert.equal(out.result.status, "needs_human", out.result.reason);
  assert.equal(out.result.stop_gate, "review");
  assert.equal(out.result.reason, "re-review after update-branch requested changes: F1 (1 blocking, 1 nit); findings are in the run result; re-plan on the new base or fix by hand");
  assert.deepEqual(out.result.review.blocking.map((f) => f.id), ["F1"]);
  assert.deepEqual(out.result.review.nits.map((f) => f.id), ["N1"]);
  // no pr-opener call between the re-review and the halt
  const after = L.slice(L.indexOf("role:pr-review:v2"));
  assert.ok(!after.some((l) => /^role:fleet-pr-opener/.test(l)), L.join(", "));
  assert.ok(!L.some((l) => /^role:fleet-coder:r2|^infra:pr-merge:u1/.test(l)), L.join(", "));
  assert.equal(L.filter((l) => l === "infra:ledger-writeback:ci").length, 1, L.join(", "));
});

// review N1: a resume restores update only with pr_updated true and two 40-hex shas; a corrupt record stops
async function resumeWith(mod, extra) {
  const t = overlap({ "hasher:update:u1": { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: HASHES_U } });
  const got = capture(t, ["infra:state:reviewed:v2"]);
  const first = await run(t, ARGS);
  assert.equal(first.result.status, "ok", first.result.reason);
  const st = Object.assign({}, got["infra:state:reviewed:v2"], mod);
  const r = Object.assign(overlap(), t, extra || {});
  // a state real verify cannot produce today (see the D5 test)
  r["infra:verify-plan"] = Object.assign({}, happy()["infra:verify-plan"], { head: D, commits_since: [{ sha: D, subject: "feat(thing): add thing" }], changed_since: ["src/x.py"] });
  r["infra:read-state"] = { status: "ok", reason: "read", exists: true, target: D, message: JSON.stringify(st), head: D, head_tree: "KU", clean: true };
  r["hasher:resume"] = { status: "ok", fingerprint: { head: D, tree: "KU" }, hashes: JSON.parse(JSON.stringify(HASHES_U)) };
  return run(r, { mode: "build", plan_ref: first.plan.result.plan_ref, date: ARGS.date, project: "o/r" });
}
test("6.0.1 (review N1): a resumed update record with base == head == approved_sha, or a base that is not 40 hex, stops (fail closed)", async () => {
  for (const u of [{ head: D, base: D }, { head: D, base: "c0ffee" }, { head: D, base: null }]) {
    const out = await resumeWith({ pr_updated: true, update: u });
    assert.equal(out.result.status, "needs_human", JSON.stringify(u) + ": " + out.result.reason);
    assert.equal(out.result.stop_gate, "resume", out.result.reason);
    assert.match(out.result.reason, /^run-state mismatch: update record /);
    assert.ok(!out.labels.some((l) => /^infra:(ci-watch|ledger-writeback)/.test(l)), out.labels.join(", "));
  }
});
test("6.0.1 (review N1): an update record with pr_updated not true is not restored (the classifier keeps the plan base)", async () => {
  const extra = { "infra:ci-watch:w1": RED, "role:fleet-ci-classifier:w1": { status: "ok", reason: "c", checks: [{ name: "test", cause: "flaky" }] } };
  const off = await resumeWith({ pr_updated: false, update: { head: D, base: C } }, extra);
  assert.equal(inputsOf(call(off, "role:fleet-ci-classifier:w1").prompt).base_ref, PB);
  const on = await resumeWith({ pr_updated: true, update: { head: D, base: C } }, extra);
  assert.equal(inputsOf(call(on, "role:fleet-ci-classifier:w1").prompt).base_ref, C);
});
