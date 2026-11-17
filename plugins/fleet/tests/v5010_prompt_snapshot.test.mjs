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
import { SOURCE, ARGS, PC, PB, happy, run, runOne } from "./harness.mjs";

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
    "hasher:pre-intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
    "role:fleet-intent-judge": {
      status: "ok",
      reason: "matches the task",
      verdict: "approve",
      deviations: [{ item: "adds f()", allowed_by: "task body: 'add f'", source_ref: "L42", fails_closed: true, verdict: "approve", reason: "asked for" }],
      coverage: { covered: true, missing: [] },
    },
    "hasher:fp-post:intent": { status: "ok", fingerprint: { head: PB, tree: "P0" } },
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
// 6.0.0 stream 2: infra:policy (new build call)
// 6.0.0 stream 2: plan doc off the branch (stage-plan, commit-plan, verify-plan-commit, verify-plan prompts; pr-opener tldr; branch-scan head)
// 6.0.0 stream 2 (security review): roles read the plan at plan_blob; verify no longer writes a copy
// 6.0.0 stream 2: infra:pr-convention:plan (new plan call); convention subjects; pr-opener title and body_convention; planner component
// 6.0.0 stream 2 (security review): plan_blob is the blob id; verify-plan reads replace_refs
// 6.0.0 stream 2 (security review): plan_hash prints args and a digest
// 6.0.0 stream 3 (2044): infra:pr-stats and infra:state:shipped (new build calls)
// 6.0.0 stream 3 (2045): infra:pr-ready (new build call)
// 6.0.0 stream 3 (2034): infra:orch-scan and infra:ci-watch:w1 (new build calls)
// 6.0.0 security review (2034): ci_watch failed[].verified in the schema
// 6.0.0 (2034, advisor): the orchestrator scan before ready; ci in the run-state
// 6.0.0 security review (S6): the CI write-back line has fixed fields only
// 6.0.0 review (REQUEST CHANGES): ci_watch prints no log text; orch_scan args; pr_state modes; the CI write-back (:ci) and infra:pr-stats:final (new build calls)
// 6.0.1 (2050): verify_since commits_since[].parents in the schema
// 6.1.0 review B2 (2051): fleet_scan base in the schema (the only change: checked with base removed)
// 6.1.0 delta review: treeCmd, the re-plan reset branch/update-ref and the code-judge role's scratch read-tree run git with hooks off (the only changes: checked with the three reverted)
// 6.2.0 (2058): the intake prompt's body_slug page read and body_slug in the source schema (the only changes: checked with both reverted)
// 6.2.0 review (M1, L2): body_slug in the intake return shape, the MUST-carry rule and the exact wiki_read call format (the only changes: checked with both prompt edits reverted)
// 6.2.2 (2104, 2107): the preflight probe prints hash_lines= before its hash lines (probe: the only change, checked with it reverted); format_files hook_failed, hook_output and unknown_hooks, and the policy caps pre_freeze_hooks, in the schemas (ADR-1237)
// 6.2.2 review (M2, L1-L3): the format_files pre-freeze keys (hook_failures, hook_head, hook_sha256, hook_timeout) in the schemas (the probe pin is unchanged)
// 6.2.2 re-review (D-L1): format_files fix_timeout in the schema (the probe pin is unchanged)
// 6.3.0 (ADR-1239): infra:policy:plan (new plan call) and unattended in the policy caps schema (the only changes: with both reverted every pin is 6.2.2's; probe unchanged)
// 6.3.2 (2130): the ruleset-surface and hook-surface prompts say a non-null error with exit 0 is still status ok (the only change: with that sentence removed every pin is 6.3.1's; probe unchanged)
// 6.3.3 (2144): the code judge's suite_result schema is JUDGE_SUITE (the only change: with the judge entry put back to SUITE every pin is 6.3.2's; probe unchanged)
// 6.3.4 (2176): infra:plan-chunks:r0w0 (new plan call) carries the chunks; commit-plan carries none and relays bad_chunks; load-ref reads in part mode; bad_chunks, written and part in INFRA_SCHEMA (probe unchanged)
// 7.0.0 (yaadgaar #699): the intake prompt has one ledger branch (yaadgaar) and no body page read; the preflight census asks for mcp__yaadgaar__read_task only (the probe pin moves); the reworded yaadgaar read and write-back prompts; no infra:ledger-read:pre, infra:ledger-writeback or their :ci calls (4 fewer build calls on the default legacy ledger fixture)
// 7.0.0 review F2, F4: the default fixture is yaadgaar task #42 (input #42; + infra:yaadgaar-read, infra:yaadgaar-writeback and their :ci calls: 4 more build calls), and title, body_slug, page_project and page_tags leave INFRA_SCHEMA results and body_slug leaves SOURCE_SCHEMA (both move the pins: with the schema fields put back the plan-then-build pin is 9b97deb7..., not the one below; probe unchanged)
// 7.1.0 (L2145): + infra:pr-tests after the pr-opener (one more build call), the code judge suite_result types passed, the pr-opener role sha moves (probe unchanged)
// 7.3.0 car 2: + infra:fleet-branch in plan mode (#43, one more call each), the intake plan-path rule (#63), the plan-mode workspace fast-forward rule (#39), the parked meta prompt and its digest/args opts (#42), fast_forwarded and the parked part keys in the schemas (probe unchanged)
// 7.3.0 car 4: the workspace exclude_add program and settings rewrite (#9), format-plan via format_files plan mode (#9), commit-plan retire via parked.py (#9), purge.py (#9), the chunk Write-tool steps (Q4 (a)), scratch_copy_cmd role inputs and role shas (#54, #60, #65), the call-shaped caller cap text (#40) (probe unchanged)
// 7.4.0 car 1: the push and push-probe prompts run push.py (#9), the hook stop text (#36 B1) (probe unchanged)
const PINS = {
  "plan then build (confirm ask)": { calls: 90, sha256: "65e595607fadd6e370a4b1b6cbfebc44f8fdf877bf16315dc67375295fa088b5" },
  "confirm auto (gates, then build in one run)": { calls: 92, sha256: "1d5aaab45205573d2c6a4a4b10baf3b3f82617b2e017b172dae5c909a7cbda20" },
  "short path (one test writer)": { calls: 89, sha256: "36d6a5ed97c7487871f4c3c4842aae8d3a1f2a4f633627226a3b212434f859fe" },
  "probe": { calls: 2, sha256: "a8ceccc781cf8954f6b925f6d96462387d40cede1db8d318d28eb0441753e8de" },
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
