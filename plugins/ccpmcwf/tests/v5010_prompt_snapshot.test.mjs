// fleet 5.0.10 (ledger 2031): the prompts the workflow sends are pinned.
//
// 5.0.10 shrank build-engine.js (comments moved to docs/, repeated prompt
// fragments built once) with no change in what any agent receives. This test
// keeps it that way: for each main scenario it hashes every agent call the
// workflow makes (label, prompt and opts: schema, model, agent type) plus the
// run's final status. A refactor that changes one byte of one prompt fails
// here; a deliberate prompt change updates the pin in the same commit.
//
// The fleet version is masked (<V>), so a version bump alone keeps the pins
// (with it every sha256 and long base64 run: see mask).
// Print fresh pins: FLEET_SNAPSHOT_PRINT=1 node --test plugins/ccpmcwf/tests/v5010_prompt_snapshot.test.mjs

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
// 7.4.0 car 6: the role shas (#26, #45, #46, #60, #61, #72), the uv build vars (#73), touches_gate, test_conflict, target and parent in the schemas (no new call; probe unchanged)
// 8.0.0 car B1 (#62): each build-dir reset runs the PATH check of its step (repo, token, the path_check command and slot): 7 fewer build calls, no standalone infra:path-check at the paired sites (probe unchanged)
// 8.0.0 car B2 (#62): infra:surfaces:plan runs the hook_surface, ruleset_surface and pr_convention programs (one slot each) and infra:surfaces:r<n> the hook_surface and changed_defs programs: 2 fewer plan calls, 1 fewer build call (probe unchanged)
// 8.0.0 car G1: the preflight prompt and schema run gate_tools.py <repo> <AUDIT_IMAGE> in a gate_tools slot (no new call; the probe pin moves with the preflight prompt)
// 8.0.0 car G2: each code round runs infra:build-reset:gates:r<n> and infra:gates:r<n> (cover_diff.py) before the code judge's reset: 2 more build calls; the code judge's script_findings carries coverage, its schema exemptions, the code-judge and pr-opener role shas move (probe unchanged)
// 8.0.0 car G3: plan mode runs infra:held-out:write (held_out.py write, the examples as base64 chunks) after infra:stage-plan: 1 more plan call (the harness planner returns one held-out example); the sealed plan ref carries held_out; the scope-and-plan role sha moves (probe unchanged)
// 8.0.0 car G4: each code round with a sealed store runs infra:build-reset:held-out:r<n> and role:fleet-held-out-runner:r<n> (held_out_cmd, scratch_copy_cmd, the sealed held_out) before the code judge's reset: 2 more build calls; the code judge's held_out_results carries the runner's result, the role table gains fleet-held-out-runner, the code-judge role sha moves; the runner has its own database (fleet_hrun, in the verify-plan list) and a private HOME, TMPDIR and XDG_* (probe unchanged)
// 8.0.0 car G5: infra:gates:r<n> runs mutants.py as its 2nd slot (mutation), one Bash call per slot, one after the other (no new call); the code judge's script_findings carries mutation, its schema mutant_rulings, the code-judge role sha moves; the run state carries held_out_seen (step 0) (probe unchanged)
// 8.0.0 car G7: infra:gates:r<n> runs sec_scan.py as its 3rd slot (security_scan; no new call); the code judge's script_findings carries security, the code-judge role sha moves; AUDIT_IMAGE is the real digest and the preflight runs gate_tools.py with timeout 600000 ms (the preflight pull; the probe pin moves)
// 8.0.0 car G8: the code judge's script_findings top-level reason no longer says the gates are not run yet (SCRIPT_FINDINGS_GATES; no new call; probe unchanged)
// 8.0.0 car R (#38): the plugin is ccpmcwf: the preflight globs cache/*/ccpmcwf/<V>/scripts and every judge-type call runs on agent ccpmcwf:judge (was fleet:judge). Checked: with those two names mapped back to fleet the 8.0.0 G8 pins match, so the change is the name only (all four pins move)
// 8.0.0 car F (MEDIUM): infra:gates:r<n> runs security_scan first, then coverage, then mutation (A-M5; no new call); the gates have their own database (fleet_gates, A-M8); db_up asks for timeout 600000 ms (B-M3); the held-out runner's result schema allows store timeout and the scope-and-plan and held-out-runner role shas move (A-M6, B-M1); the program pins of cover_diff, mutants, scratch_copy, gate_tools and db_up move (probe unchanged)
// 8.0.1 (#76): each plan and build run claims the task lock (infra:run-lock, parked.py claim) and releases it in main's finally (infra:run-lock:release): 2 more calls per run, 2 under confirm auto (one claim, one release); format-plan's plan_dsn prints plan_sha256 (its keys move); the parked, plan_dsn and plan_ref_write program pins move (probe unchanged)
// 8.0.2 (#77): the preflight probe captures its stdout and stderr and prints probe_sha= last, and drops hash_lines= (the only change besides the version: checked with the probe command and FLEET_VERSION put back, every pin is 8.0.1's)
// 8.1.0 (#75): the held-out runner role file (sandbox-run, store sandbox) and its schema enum move, the cover_diff, mutants and scratch_copy program pins move, the program table gains sandbox, and the version moves (probe unchanged)
// 8.2.1 (#82): every relay checked against a program digest runs on sonnet first (the model is in the pin) and the version moves: all four pins move, no prompt text or call count changes
// 8.2.3 (#85): format_files gains the digested key base_red (the format prompts name it, the program-output schema types it): the three build pins move, probe unchanged
// 8.2.4 (#86): the held-out runner role file names the printed store_digest (not digest) and held_out.py show prints store_digest (the held_out schema and the show key list gain it); the version moves: the three build pins move, probe unchanged
// 8.2.5 (#89): the build env note ends with the paste-literally rule, the hook env starts with PYTHONDONTWRITEBYTECODE (the commit <git> prefix drops its own copy), every role prompt asks for timeout 600000 ms, the held-out runner role sha moves, and the version moves: the three build pins move, probe unchanged
// 8.3.0 (#87, #95, #98): infra:surfaces:plan's ruleset_surface prompt and schema gain checks (#95); the build env note says a nested $(...) needs its own prefix (#98), in all 7 build role prompts; the harness fixture tldr is "add thing" (#87, the PR title comes from the tldr), seen in the pr-opener and yaadgaar write-back inputs; the scope-and-plan, plan-audit and pr-opener role shas move (masked); same call counts: the three build pins move, probe unchanged
// 8.3.2 (#103): every build-mode hasher prompt passes the lock's task id and nonce to hasher.py (the per-gate heartbeat) and its read-only line names the lock heartbeat; #101 changes no prompt. Checked: with those two hasher edits stripped every pin is 8.3.1's; same call counts: the three build pins move, probe unchanged
// 8.3.3 (yaadgaar #97): the plan-ref chunks are PLAN_CHUNK_CHARS (2000) long, so the infra:plan-chunks writer prompt says "(2000 characters each at most)" and carries more, shorter chunks (each with its sha256), and commit-plan's plan_ref_write command carries a longer chunk sha256 list. Checked: with PLAN_CHUNK_CHARS put back to 4000 every pin is 8.3.2's (the #102 role-file edits only move masked role shas; the preflight PATH-check retry runs only on a bad relay); same call counts: the three build pins move, probe unchanged
// 8.3.4 (yaadgaar #79): the mutants program pin, the code-judge role sha and the version move; all three are masked, so no pin moves (probe unchanged)
// 8.4.0 (yaadgaar #25): no prompt changes; opts.agentType does: every call names a ccpmcwf type, and plan-audit, the plan-mode sweep, pr-view and ci-logs run as ccpmcwf:judge. Checked: with agentType put back to 8.3.5's (ccpmcwf:judge where it was, else absent) every pin is 8.3.5's; same call counts: the three plan/build pins move, probe unchanged
// 8.5.0 (yaadgaar #105): the intake prompt gains the relay rule and its return shape names relay, and INTAKE_SCHEMA requires the relay property; same call counts: the plan and build pins move, probe unchanged. Checked: with the prompt and schema edits reverted every pin is 8.4.0's
// 8.5.1 (yaadgaar #106): no prompt change; the gate_tools program pin and the version move, both masked; same call counts.
// 8.5.2 (yaadgaar #107): no prompt change; the intake requirement check and the version move (masked); same call counts, no pin moves.
// 8.5.3 (yaadgaar #111): no prompt change; the caller check reads auto (doc and lock) pages outside the read budget and the version moves (masked); same call counts, no pin moves.
// 8.5.4 (yaadgaar #108 step 1): no prompt change; stop_gate names, the legacy plan_ref refusal text, the hasher pin and the version move (masked); same call counts, no pin moves.
// 8.5.5 (yaadgaar #108 step 2): infra:surfaces:plan runs plan_dsn first (its prompt lists the command and its schema gains the plan_dsn slot); same call counts: the three plan/build pins move, probe unchanged.
const PINS = {
  "plan then build (confirm ask)": { calls: 89, sha256: "edef5fb1c0da10efd2ba68e2101529cd64ec003814eba0031cb75f8de74392f4" },
  "confirm auto (gates, then build in one run)": { calls: 89, sha256: "0fbb03e6fa7d85c1c874f8e37ab6205f395d7d7008ab122d71329109c6c29487" },
  "short path (one test writer)": { calls: 88, sha256: "82508b237fc0395c362f9c313c21c5cb7b371fd6640ecf8a95091f419ad260a0" },
  "probe": { calls: 2, sha256: "7805c6239ff4d5c7b006f48e4ed1a49481c9a56527caf363d57e125de37fb077" },
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
