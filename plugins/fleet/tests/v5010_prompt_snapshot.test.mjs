// fleet 5.0.10 (ledger 2031): the prompts the workflow sends are pinned.
//
// 5.0.10 shrank build-task-run.js (comments moved to docs/, repeated prompt
// fragments built once) with no change in what any agent receives. This test
// keeps it that way: for each main scenario it hashes every agent call the
// workflow makes (label, prompt and opts: schema, model, agent type) plus the
// run's final status. A refactor that changes one byte of one prompt fails
// here; a deliberate prompt change updates the pin in the same commit.
//
// The fleet version is masked (<V>), so a version bump alone keeps the pins
// (with it every sha256 and long base64 run: see mask).
// Print fresh pins: FLEET_SNAPSHOT_PRINT=1 node --test plugins/fleet/tests/v5010_prompt_snapshot.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SOURCE, ARGS, PC, happy, run, runOne } from "./harness.mjs";

const VERSION = /^const FLEET_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(SOURCE)[1];
// The version also reaches the sealed plan ref and run-state, so the chunked
// base64 of their JSON and every sha256 over it differ per version: those are
// data, not prompt text, and are masked too.
const mask = (s) => s.split(VERSION).join("<V>").replace(/[0-9a-f]{64}/g, "<SHA>").replace(/[A-Za-z0-9+/]{100,}={0,2}/g, "<B64>");

function digest(out) {
  const h = createHash("sha256");
  for (const c of out.calls) h.update(mask(JSON.stringify([c.label, c.prompt, c.opts])) + "\n");
  h.update(mask(JSON.stringify(out.result && out.result.status)));
  return { calls: out.calls.length, sha256: h.digest("hex") };
}

// confirm "auto": the gates pass and the same run builds (build_task_run.test.mjs autoHappy)
function autoHappy() {
  return Object.assign(happy(), {
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PC, tree: "P0" } },
    "infra:precommit-ids": { status: "ok", reason: "read", present: true, ids: ["prettier", "check-json"], parser: "yaml" },
  });
}

function shortPath() {
  const s = happy();
  s["role:scope-and-plan"].est_diff_lines = 10;
  s["role:scope-and-plan"].new_behaviour = false;
  delete s["role:fleet-test-writer:AC1:r1"];
  delete s["role:fleet-test-writer:AC2:r1"];
  s["role:fleet-test-writer:short:r1"] = {
    status: "ok",
    reason: "red",
    criterion_id: "short",
    tests: [{ name: "test_a1", covers: "AC1: x" }, { name: "test_b1", covers: "AC2: y" }],
    files: ["tests/test_a.py", "tests/test_b.py"],
  };
  return s;
}

const SCENARIOS = {
  "plan then build (confirm ask)": () => run(happy(), ARGS),
  "confirm auto (gates, then build in one run)": () => runOne(autoHappy(), { ...ARGS, confirm: "auto" }),
  "short path (one test writer)": () => run(shortPath(), ARGS),
  "probe": () => {
    const s = happy();
    delete s.__dispatch;
    return runOne(s, { mode: "probe", repo: "/r", date: ARGS.date });
  },
};

// 6.0.0 stream 1: nested program slots require digest and keys (schemas of preflight, workspace,
// branch-scan, stage-plan, format-plan, verify-plan-commit, verify-plan), gh_identity's tried
// diagnostics (workspace schema), intake's relaunch rule (prompt), infra:ruleset-surface:plan (new call)
const PINS = {
  "plan then build (confirm ask)": { calls: 76, sha256: "fb2c698618ed464439ed537436fe44cba3b7eaf78dd6dd7ba304a896e608eab2" },
  "confirm auto (gates, then build in one run)": { calls: 78, sha256: "f44f0424a5656272a4ceb4a319075205ac0c5e7d9bb97dc5d519d98dd69bc95d" },
  "short path (one test writer)": { calls: 75, sha256: "393d1d3d0fc2e440f42758c0c614dcdd9b428c863cc7689e8b5351576cd9d3c4" },
  "probe": { calls: 2, sha256: "012d024fefbefe057a047d8b6822b07ea3152de9e7d322be0e6cf5d6273fc736" },
};

for (const [name, fn] of Object.entries(SCENARIOS)) {
  test("5.0.10 2031: the prompts of scenario '" + name + "' are unchanged", async () => {
    const out = await fn();
    const got = digest(out);
    if (process.env.FLEET_SNAPSHOT_PRINT) console.log("PIN " + JSON.stringify(name) + ": " + JSON.stringify(got) + ",");
    assert.ok(out.result && out.result.status === "ok", name + ": " + JSON.stringify(out.result && out.result.reason));
    assert.deepEqual(got, PINS[name], name + ": a prompt, schema or model the workflow sends changed");
  });
}
