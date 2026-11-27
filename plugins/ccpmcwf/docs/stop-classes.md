# Stop classes of build-engine.js (ccpmcwf 8.9.17)

yaadgaar #108 step 5, ADR-1397. Every stop site of `src/build-engine.js` names its stop class in
script code, as the first argument of `halt`, `stop` or `planFindingsStop`. No LLM sets or
changes a class at run time. The run result carries the class as `stop_class`, next to
`stop_gate` (null on `ok` and `awaiting_confirmation`).

This file is generated: run `node plugins/ccpmcwf/tests/stop_classes_doc.mjs` after a change to a
stop site. `tests/v880_stop_class.test.mjs` fails when the file is not the source's table.

<!-- prettier-ignore -->
| Code | Class | Meaning (ADR-1397) |
| --- | --- | --- |
| `"s"` | safety | Always stops. Never repaired or re-run automatically. |
| `"m"` | mechanical | A deterministic script repair with no judgment. No call site uses it in 8.8.0; `resume_with` is mechanical. |
| `"t"` | transient | One retry is reasonable. |
| `J_<NAME>` | judgment | One bounded repair round, then needs_human with the 2-3 options the const carries. |

Rules:

- When a site is not clearly mechanical, judgment or transient, it is safety.
- Safety covers: the hook surface, IaC, hash, freeze, fingerprint and ownership, the scope fence, the
  command allowlist, the DSN rule, secret paths, the work-owner merge rule, intent refusals, role,
  contract and program identity, relay digest or args mismatches, run-state, plan-ref and checkpoint
  trust, version and legacy refs, push access, the agent cap and the run budget.
- The run budget is safety, not its own class: safety is the only class that is never repaired or
  re-run, which is what a spent budget needs. Its stop still returns its options.
- A null agent result is transient only for a read-only (judge) step; a write step's null is safety
  (its first attempt may have written).
- A hook-surface stop is transient only for ruleset_surface.py's own error shape with no HTTP
  status; hook_surface.py makes no GitHub call, and its errors name repo files.
- 8.8.0 changes no behaviour except the hook_surface text above: no stop becomes a repair. Step 6
  (8.9.0: `recover` on every stop result and the skill re-run) keys on this class only.

Counts of the call sites (a two-class site counts in both): safety 323, judgment 31, transient 5, mechanical 0, per caller 2; 356 sites. The
three stops that return without `halt` are listed after the table.

<!-- prettier-ignore -->
| # | Function | Gate | Class | Site | Reason |
| --- | --- | --- | --- | --- | --- |
| 1 | `requireProgram` | stopGate \|\| contract | safety | label + ": " + p | the program relay is missing or reports an error (program identity) |
| 2 | `formatFiles` | - | safety | label + " returned no ran/stable/files/changed/refused" | relay contract: a required field is missing or malformed |
| 3 | `formatFiles` | - | safety | label + " returned no hook_failed/hook_failures/hook_head/hook_sha256/hook_timeout/fix_timeout/unknown_hooks" | relay contract: a required field is missing or malformed |
| 4 | `formatFiles` | - | safety | label + ": the relayed result" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 5 | `formatFiles` | policy | safety | label + ": the policy's pre_freeze_hooks names hook id(s) the repo cannot run at the pre-commit stage: " + r.u | policy file error |
| 6 | `formatFiles` | hooks | safety | label + ": the fixer hook runs ran out of time (each run at most " + FIX_RUN_TIMEOUT + " s, at most 3 runs); n | hook surface or hook run (hook rule) |
| 7 | `formatFiles` | hooks | safety | label + ": the pre_freeze_hooks check phase ran out of time: " + r.hook_timeout.join(", ") + " (each run at mo | hook surface or hook run (hook rule) |
| 8 | `formatFiles` | hash | safety | label + ": the program read the frozen map " + JSON.stringify(r.frozen_map) + ", not " + frozenList.sha | a hash, freeze or refs check (hash rule) |
| 9 | `formatFiles` | contract | safety | label + " returned no purged/purged_paths" | a role, program or agent identity or contract mismatch |
| 10 | `formatFiles` | hash | safety | label + ": hook config, a hook entry or a symlinked path differs from HEAD: " + logPath(r.refused.join(", "))  | a hash, freeze or refs check (hash rule) |
| 11 | `formatFiles` | contract | safety | label + " returned no frozen_changed list" | a role, program or agent identity or contract mismatch |
| 12 | `formatFiles` | hash | safety | label + ": a fixer hook changed frozen path(s) " + logPath(frozenHit.join(", ")) + " after freeze; never accep | a hash, freeze or refs check (hash rule) |
| 13 | `formatFiles` | scope | safety | label + ": the fixer hooks changed path(s) outside the files they were given (" + logPath(allow.join(", ")) +  | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 14 | `formatFiles` | commit | safety | label + ": the fixer hooks still rewrite files after 3 runs: " + logPath(changed.join(", ")) | the commit or its tree is not the checked one |
| 15 | `chunkRounds` | stopGate | safety | lbl + ": the relay has status " + r.status + " and bad_chunks " + JSON.stringify(bad) + " (status ok and bad_c | chunk files do not hash to their sha256 (hash rule) |
| 16 | `chunkRounds` | stopGate | safety | lbl + ": the relayed bad_chunks " + JSON.stringify(bad) + " are not chunk numbers of the " + what + " (0.." +  | chunk files do not hash to their sha256 (hash rule) |
| 17 | `chunkRounds` | stopGate | safety | lbl + ": chunk(s) " + ids.join(", ") + " still do not match their sha256 after " + MAX_CHUNK_RETRIES + " rewri | chunk files do not hash to their sha256 (hash rule) |
| 18 | `ghEnsure` | contract | safety | label + ": gh check unusable: " + gp | a role, program or agent identity or contract mismatch |
| 19 | `resetBuild` | - | safety | label + " returned " + (r ? r.status + ": " + (r.reason \|\| "no reason") : "no result") + "; the build dirs w | not clearly mechanical, judgment or transient (conservative default) |
| 20 | `resetBuild` | - | safety | label + ": the relayed result" + NOT_DIGEST + " or its arguments; the build dirs were not emptied" | relay digest or args mismatch: the copy may be altered |
| 21 | `purgeBytecode` | - | safety | label + " returned no purged count" | relay contract: a required field is missing or malformed |
| 22 | `purgeBytecode` | contract | safety | label + ": the relayed purge result" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 23 | `pathCheck` | iac | safety | NOT_SHIMMED + " (" + what + rp + ")" | IaC rule: an IaC change or an unshimmed IaC tool |
| 24 | `pathCheck` | iac | safety | NOT_SHIMMED + " (" + at + "PATH has entries the agent shell resolves differently: " + pc.path_problems.map(Str | IaC rule: an IaC change or an unshimmed IaC tool |
| 25 | `pathCheck` | iac | safety | NOT_SHIMMED + " (" + at + real.join(", ") + ")" | IaC rule: an IaC change or an unshimmed IaC tool |
| 26 | `pathRecheckEnd` | iac | safety | NOT_SHIMMED + " (the PATH re-check " + label + " could not complete: it returned no result)" | IaC rule: an IaC change or an unshimmed IaC tool |
| 27 | `pathRecheckEnd` | iac | safety | NOT_SHIMMED + " (the PATH re-check " + label + " could not complete: it returned " + r.status + ": " + (r.reas | IaC rule: an IaC change or an unshimmed IaC tool |
| 28 | `halt` | (stop) | per caller | msg | passes its caller's class on (each caller names one) |
| 29 | `budgetStop` | budget | safety | "run budget: " + n + " output tokens of " + cap + " spent before " + at | run budget: never auto-repaired (ADR-1397 budget next to the cap) |
| 30 | `reserve` | cap | safety | "agent cap " + MAX_AGENTS + " reached: " + capped() + " dispatched, " + n + " more needed for " + what | agent cap |
| 31 | `infraCall` | contract | safety | label + ": the prompt runs shipped program(s) " + ps.missing.join(", ") + " that PROGRAM_SLOTS does not place  | a role, program or agent identity or contract mismatch |
| 32 | `infraModel` | - | safety | "no INFRA_TIER entry for agent label " + label | install or preflight identity |
| 33 | `agentT` | contract | safety | "agent " + (opts && opts.label) + " has no ccpmcwf agent type (" + JSON.stringify(opts && opts.agentType) + ") | a role, program or agent identity or contract mismatch |
| 34 | `dispatch` | - | transient / safety | "agent " + label + " returned no result" | a null result: transient for a read-only (judge) step, which 8.7.0 already retried once; safety for a write step, whose first attempt may have written |
| 35 | `roleAgent` | contract | safety | "role " + role + " (" + label + "): agent type " + opts.agentType + " is not its ROLE_AGENT type " + at | a role, program or agent identity or contract mismatch |
| 36 | `roleAgent` | contract | safety | "role " + role + " has no DISPATCH tier from preflight" | a role, program or agent identity or contract mismatch |
| 37 | `callRole` | - | transient / safety | "agent " + label + " returned no result" | a null role result: transient for a judge-type role (read only); safety for a writer or coder (its attempt may have written) |
| 38 | `retryOnDrift` | - | transient / safety | "agent " + rl + " returned no result" | a null role result: transient for a judge-type role (read only); safety for a writer or coder (its attempt may have written) |
| 39 | `checkRole` | role | safety | roleStatusText(role, r) + " (also: " + drift + ")" | a role or step reported a stop, or its output is unusable; cause unknown |
| 40 | `checkRole` | contract | safety | drift | a role, program or agent identity or contract mismatch |
| 41 | `requireOk` | role | safety | who + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a role or step reported a stop, or its output is unusable; cause unknown |
| 42 | `hasher` | relay-size | safety | "hasher " + label + ": the hasher output is over the 65536-byte relay cap" + (m ? " (largest: " + m[1] + ")" : | the hasher output is over the relay cap: paging needs a hasher.py change, and a re-run would overflow again |
| 43 | `hasher` | - | safety | "hasher " + label + " failed: " + (r.reason \|\| "incomplete output") | the hasher view is unusable (hash rule) |
| 44 | `hasher` | - | safety | "hasher " + label + " failed: the relayed maps do not match the program's digest (a key was dropped or changed | the hasher view is unusable (hash rule) |
| 45 | `hasher` | hash | safety | "hasher " + label + ": " + sm | the hasher view is unusable (hash rule) |
| 46 | `hasher` | - | safety | "hasher " + label + " failed: the " + m + " summary " + JSON.stringify(g) + " is not {count, sha256, file" + ( | the hasher view is unusable (hash rule) |
| 47 | `hasher` | refs | safety | "hasher " + label + ": " + rr[0].slice(FLEETREF.length) + " exists; replacement objects could change what a se | the hasher view is unusable (hash rule) |
| 48 | `expandKeys` | errGate | safety | "hasher maps " + tag + ": the " + maps.join(", ") + " map(s) changed and the key list is unavailable: " + why  | the hasher view is unusable (hash rule) |
| 49 | `infra` | - | safety | label + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 50 | `judged` | fingerprint | safety | "judge mutated worktree: " + role + " (" + label + ") changed " + logPath(what.join(", ")) + "; verdict discar | the worktree changed under a step (fingerprint rule) |
| 51 | `preflightStep` | contract | safety | "preflight: " + sp.problem + " (after one retry); the scripts on disk were not checked, so re-run /build-task" | a role, program or agent identity or contract mismatch |
| 52 | `preflightStep` | contract | safety | "preflight: scripts_dir unusable: " + sp.problem + "; install " + PLUGIN_NAME + " " + FLEET_VERSION + " from t | a role, program or agent identity or contract mismatch |
| 53 | `preflightStep` | contract | safety | "role " + role + " has no usable DISPATCH line (" + JSON.stringify(line \|\| null) + "); no tier is hardcoded" | a role, program or agent identity or contract mismatch |
| 54 | `runGate` | gates | safety | label + ": gate " + bad().join(", ") + " erred or relayed no digest-checked result twice" | a gate result is missing or refused |
| 55 | `runGate` | gates | safety | label + ": gate " + g + " " + x.status + " (" + x.reason + ")" + (p ? " after an earlier round's result" : "") | a gate result is missing or refused |
| 56 | `heldOutRun` | role | safety | label + " returned " + st | a role or step reported a stop, or its output is unusable; cause unknown |
| 57 | `heldOutRun` | contract | safety | label + ": contract drift" | a role, program or agent identity or contract mismatch |
| 58 | `heldOutRun` | gates | safety | label + ": " + why | a gate result is missing or refused |
| 59 | `pushProbe` | push | safety | "no push access to origin for " + lay.branch + ": " + JSON.stringify(r.auth_line \|\| r.result) + " (git push  | push access is not known or is refused |
| 60 | `workspaceStep` | - | safety | "workspace returned no default_branch/base_ref" | relay contract: a required field is missing or malformed |
| 61 | `workspaceStep` | - | safety | "workspace found no origin remote owner/name (remote_slug)" | repo or branch identity |
| 62 | `workspaceStep` | - | safety | "fleet branch equals the default branch " + ws.default_branch | repo or branch identity |
| 63 | `workspaceStep` | - | safety | "workspace: the digest-checked gh check read origin " + o + ", but the workspace relayed remote_slug " + ws.re | repo or branch identity |
| 64 | `lockClaim` | - | safety | "infra:run-lock: relay off its digest or args" | relay digest or args mismatch: the copy may be altered |
| 65 | `lockClaim` | - | safety | "task " + task + " is held by run " + h.nonce + " (" + h.mode + ", started " + h.started + "); a closed sessio | another run holds this task (ownership) |
| 66 | `branchSlug` | - | safety | "infra:fleet-branch: the relay" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 67 | `branchSlug` | - | safety | "several fleet branches of task " + names.taskId + " and none is " + br(d) + ": " + s.map(br).join(", ") + ";  | repo or branch identity |
| 68 | `normCriteria` | - | safety | m | a sealed plan's criteria break the contract (build mode; plan mode routes these to the planner) |
| 69 | `normCriteria` | commands | safety | "criterion " + id + " " + ta | a sealed plan's criteria break the contract (build mode; plan mode routes these to the planner) |
| 70 | `testableOf` | - | judgment | "full path but no testable criteria (all [manual])" | no criterion names a test file: the task or plan needs a human edit |
| 71 | `runtimeDocsSealed` | callers | safety | "plan ref " + refName + ": the sealed runtime-doc list is refused: " + p | plan-ref trust: the runtime-doc list sealed in the plan ref is not a valid list |
| 72 | `runtimeDocsSealed` | callers | safety | "plan ref " + refName + ": " + RUNTIME_DOCS_FILE + " at origin/" + defaultBranch + " no longer lists the seale | the default branch dropped a runtime-doc glob the plan sealed: the build would treat those files as docs (a human restores the glob or re-plans) |
| 73 | `runtimeDocsStep` | callers | safety | label + ": no runtime_docs relay (the " + RUNTIME_DOCS_FILE + " read)" | relay contract: the runtime-doc read (runtime_docs.py) is missing from the relay |
| 74 | `runtimeDocsStep` | callers | safety | label + ": the relayed " + RUNTIME_DOCS_FILE + " read" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 75 | `runtimeDocsStep` | callers | safety | at + " refused: " + t.error | the repo's .fleet-runtime-docs.json at origin is malformed or git cannot read it (the program's error): a human fixes the file or the repo |
| 76 | `runtimeDocsStep` | callers | safety | at + " refused: it lists " + cfg.length + " globs; at most " + room + " (64 with the default " + RUNTIME_DOCS_ | the repo's .fleet-runtime-docs.json lists more globs than callers.py takes with the default: a human trims the file |
| 77 | `runtimeDocsStep` | callers | safety | at + " refused: " + p | a glob in the repo's .fleet-runtime-docs.json breaks the glob rules: a human fixes the file |
| 78 | `callerGrep` | - | safety | lb + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 79 | `callerGrep` | - | safety | lb + " returned no occurrences map or capped list" | relay contract: a required field is missing or malformed |
| 80 | `callerGrep` | - | safety | lb + " returned no occurrence list for " + n | relay contract: a required field is missing or malformed |
| 81 | `callerGrep` | - | safety | lb + ": the relayed occurrences do not match the program's digest (a hit was dropped or changed in the copy)" | relay digest or args mismatch: the copy may be altered |
| 82 | `callerGrep` | - | safety | lb + ": " + OTHER_ARGS + " (" + JSON.stringify(r.args === undefined ? null : r.args) + ")" | relay digest or args mismatch: the copy may be altered |
| 83 | `callerDisk` | callers | judgment | fl + ": the caller summary of " + part[0] + " is over the " + CALLER_SUMMARY_CAP_ONE + "-byte summary cap; the | one symbol has too many callers to relay: a narrower name or scope is a human choice |
| 84 | `callerDisk` | - | safety | fl + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 85 | `callerDisk` | - | safety | fl + ": the relayed summary" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 86 | `callerDisk` | - | safety | fl + ": " + OTHER_ARGS + " (" + JSON.stringify(r.args === undefined ? null : r.args) + ")" | relay digest or args mismatch: the copy may be altered |
| 87 | `callerDisk` | - | safety | fl + ": the callers file " + JSON.stringify(r.file === undefined ? null : r.file) + " is not " + pre + "<64 lo | relay contract: a required field is missing or malformed |
| 88 | `callerDisk` | - | safety | fl + ": the summary has no valid entry for " + s | relay contract: a required field is missing or malformed |
| 89 | `callerDisk` | - | safety | fl + ": the summary has no capped or doctest_md string list" | relay contract: a required field is missing or malformed |
| 90 | `callerDisk` | - | safety | lb + ":read:paths: the read occurrences of " + s + " do not match the summary count or sha256" | relay digest or args mismatch: the copy may be altered |
| 91 | `callerDisk` | - | safety | lb + ":read:all: the read occurrences of " + s + " do not match the summary count or sha256" | relay digest or args mismatch: the copy may be altered |
| 92 | `callerDisk` | - | safety | lb + ":read:all: the auto hits of " + s + " do not match the summary auto_count" | relay digest or args mismatch: the copy may be altered |
| 93 | `callerReadParts` | - | safety | rl + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 94 | `callerReadParts` | - | safety | rl + ": the relayed page" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 95 | `callerReadParts` | - | safety | rl + ": " + OTHER_ARGS + " (" + JSON.stringify(r.args === undefined ? null : r.args) + ")" | relay digest or args mismatch: the copy may be altered |
| 96 | `callerReadParts` | - | safety | rl + ": the read page does not match the request (part " + part + ", page " + k + " of " + pages + ", symbols  | relay digest or args mismatch: the copy may be altered |
| 97 | `callerCheck` | - | safety | label + ": the program listed " + JSON.stringify(h) + " as auto dont_care for " + n + ", which the script's do | a program's output breaks the script's own rules (program contract) |
| 98 | `buildCallerCheck` | - | safety | label + " returned no defs, excluded, unclassified or unattributed list" | a program's output breaks the script's own rules (program contract) |
| 99 | `buildCallerCheck` | - | safety | label + " returned no generated list (an array of path strings)" | a program's output breaks the script's own rules (program contract) |
| 100 | `buildCallerCheck` | - | safety | label + ": the relayed lists do not match the program's digest (a definition was dropped or changed in the cop | a program's output breaks the script's own rules (program contract) |
| 101 | `buildCallerCheck` | - | safety | label + ": generated names " + p + ", not the fleet dist " + GENERATED_DIST | a program's output breaks the script's own rules (program contract) |
| 102 | `buildCallerCheck` | callers | safety | "build caller check " + label + ": the approved tree " + tree + " changes code the sealed changed_symbols does | a program's output breaks the script's own rules (program contract) |
| 103 | `hookReadStop` | hooks | transient / safety | "hook surface cannot be computed (" + err + "); " + (t ? "transient GitHub read failure; re-run" : "hook chang | only ruleset_surface.py reads GitHub: its own error shape with no HTTP status (gh crashed or timed out) is transient; a hook_surface error (it names repo files) and any other error are safety |
| 104 | `hookSurface` | - | safety | label + ": the relayed surface" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 105 | `hookSurface` | - | safety | label + ": " + OTHER_ARGS | relay digest or args mismatch: the copy may be altered |
| 106 | `surfaces` | - | safety | label + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 107 | `hookGate` | hooks | safety | "hook changes must be a separate PR (Max's rule): " + what + " touches " + hooks.map(why).join(", ") + " and " | hook surface or hook run (hook rule) |
| 108 | `hookGate` | hooks | safety | "hook change needs Max's confirmation: " + what + " touches " + hooks.map(why).join(", ") | hook surface or hook run (hook rule) |
| 109 | `rulesetSurface` | - | safety | label + ": the relayed surface" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 110 | `rulesetSurface` | - | safety | label + ": " + OTHER_ARGS | relay digest or args mismatch: the copy may be altered |
| 111 | `prConvention` | - | safety | label + ": the relayed convention" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 112 | `planFindingsStop` | stopGate \|\| plan | per caller | what + why + ": " + (shown.join("; ") \|\| fallback \|\| what) + (findings.length > shown.length ? "; and " +  | passes its caller's class on (each caller names one) |
| 113 | `planAndAudit` | contract | safety | "infra:unpark-plan: the relay" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 114 | `planAndAudit` | - | safety | "scope-and-plan returned no plan_path/criteria" | relay contract: a required field is missing or malformed |
| 115 | `planAndAudit` | - | safety | "scope-and-plan plan_path " + JSON.stringify(plan.plan_path) + " " + ppBad | plan path mismatch (contract) |
| 116 | `planAndAudit` | - | safety | "planner wrote " + planPath + " but the ingested plan is " + ctx.brief.plan_path + " (an existing plan is upda | plan path mismatch (contract) |
| 117 | `planAndAudit` | commands | safety | "test_cmd refused: " + tcProblem + ": " + JSON.stringify(tc0.command) | command allowlist |
| 118 | `planAndAudit` | commands | safety | "criterion " + String((c && c.id) \|\| "") + " " + ta | command allowlist |
| 119 | `planAndAudit` | contract | judgment | "role scope-and-plan contract drift" | the planner's output breaks its contract after the re-plan rounds (8.5.5 routes these to the planner first) |
| 120 | `planAndAudit` | - | judgment | "criteria refused" | criterion ids or test_files the planner did not fix in its rounds |
| 121 | `planAndAudit` | - | judgment | "criteria hold an invisible or confusable character" | a criterion holds a confusable character the planner did not fix |
| 122 | `planAndAudit` | - | judgment | "changed_symbols caller map refused" | the caller map is incomplete after the re-plan rounds (a narrower scope is a human choice) |
| 123 | `planAndAudit` | - | judgment | "changed_symbols dropped a symbol of an earlier round" | the caller map is incomplete after the re-plan rounds (a narrower scope is a human choice) |
| 124 | `planAndAudit` | scope | safety | "scope check failed: " + early.join("; ") | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 125 | `planAndAudit` | contract | safety | surfL + ": the relayed plan_dsn" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 126 | `planAndAudit` | db | safety | "plan doc holds a test DSN URL" | a DSN in the plan doc (DSN rule) |
| 127 | `planAndAudit` | - | safety | "npm test_cmd" | the test command would resolve outside the worktree (command rule) |
| 128 | `planAndAudit` | - | safety | "npx test_cmd" | the test command would resolve outside the worktree (command rule) |
| 129 | `planAndAudit` | - | judgment | "changed_symbols misses or misplaces occurrences" | the caller map is incomplete after the re-plan rounds (a narrower scope is a human choice) |
| 130 | `planAndAudit` | - | safety | fmtLabel + " returned no changed_paths list" | relay contract: a required field is missing or malformed |
| 131 | `planAndAudit` | contract | safety | fmtLabel + ": the relayed format result" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 132 | `planAndAudit` | hooks | safety | fmtLabel + ": hook config, a hook entry or a symlinked path differs from HEAD: " + logPath(ff.refused.join(",  | hook surface or hook run (hook rule) |
| 133 | `planAndAudit` | hooks | safety | fmtLabel + ": pre-commit is not installed; the plan doc cannot run the repo's hooks" | hook surface or hook run (hook rule) |
| 134 | `planAndAudit` | hooks | safety | fmtLabel + ": the repo's hooks " + (ff.fix_timeout ? "ran out of time" : !ff.stable ? "still rewrite the plan  | hook surface or hook run (hook rule) |
| 135 | `planAndAudit` | scope | safety | fmtLabel + ": the hooks changed paths other than the plan: " + logPath(fmtOther.join(", ")) + " (never committ | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 136 | `planAndAudit` | contract | safety | fmtLabel + ": the relayed dsn_check" + NOT_DIGEST | relay digest or args mismatch: the copy may be altered |
| 137 | `planAndAudit` | contract | safety | fmtLabel + ": plan_dsn ran on other arguments (" + JSON.stringify(dc.args === undefined ? null : dc.args) + ") | a role, program or agent identity or contract mismatch |
| 138 | `planAndAudit` | db | safety | "plan doc holds a test DSN URL" | a DSN in the plan doc (DSN rule) |
| 139 | `planAndAudit` | scope | safety | fmtLabel + ": the resumed plan doc hashes " + dc.plan_sha256 + ", audited " + rs.sha | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 140 | `planAndAudit` | audit | judgment | "plan-audit verdict " + audit.verdict | the plan audit refused the plan after the re-plan rounds |
| 141 | `planAndAudit` | audit | judgment / safety | "plan-audit verdict " + (audit.verdict \|\| "missing") + (first.length ? ": " + first.join("; ") : "") + after | the plan audit did not approve (a human reads its findings); a missing verdict is a relay contract break (safety) |
| 142 | `planAndAudit` | intent | safety | "plan sweep verdict weakening" | the plan sweep found a weakening (intent rule) |
| 143 | `commitPlanAndRef` | - | safety | stLabel + ": the relayed plan hash" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 144 | `commitPlanAndRef` | - | safety | stLabel + " returned no usable plan_sha256" | relay contract: a required field is missing or malformed |
| 145 | `commitPlanAndRef` | scope | safety | stLabel + ": plan doc changed after audit: " + stagedSha + ", audited " + ctx.auditedSha | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 146 | `commitPlanAndRef` | - | safety | label + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 147 | `commitPlanAndRef` | commit | safety | label + ": the relayed plan commit, base and tag object do not match the program's digest (" + JSON.stringify( | relay digest or args mismatch: the copy may be altered |
| 148 | `commitPlanAndRef` | scope | safety | label + ": the worktree is not clean after the plan doc left it: " + logPath(r.dirty.join(", ")) | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 149 | `verifyPlanCommit` | commit | safety | label + ": " + problem + "; the plan commit " + w.plan_commit + " and ref " + refName + " stay unverified (bui | plan-ref trust: the plan commit or ref is not the sealed one |
| 150 | `verifyPlanCommit` | commit | safety | label + ": plan commit " + pf.commit + " on " + pf.parent + " with HEAD " + pf.head + ", not " + w.plan_commit | plan-ref trust: the plan commit or ref is not the sealed one |
| 151 | `verifyPlanCommit` | - | safety | label + ": the committed plan hashes " + v.plan_hash.plan_sha256 + ", the staged plan " + stagedSha | plan-ref trust: the plan commit or ref is not the sealed one |
| 152 | `verifyPlanCommit` | scope | safety | label + ": the plan commit holds " + logPath(JSON.stringify(pf.files)) + ", not exactly " + full.plan_path + " | plan-ref trust: the plan commit or ref is not the sealed one |
| 153 | `verifyPlanCommit` | db | safety | label + ": the committed plan " + logPath(JSON.stringify(pf.dsn_paths)) + " holds mysql:// (a test DSN); fix t | plan-ref trust: the plan commit or ref is not the sealed one |
| 154 | `verifyPlanCommit` | - | safety | label + ": the plan ref " + refName + " differs from the sealed ref (" + ep + ")" | plan-ref trust: the plan commit or ref is not the sealed one |
| 155 | `autoGates` | contract | safety | "infra:precommit-ids" + sfx + ": the relayed hook ids do not match the program's digest" | relay digest or args mismatch: the copy may be altered |
| 156 | `autoGates` | contract | safety | "infra:precommit-ids" + sfx + ": " + OTHER_ARGS + " (" + JSON.stringify(cfg.args === undefined ? null : cfg.ar | relay digest or args mismatch: the copy may be altered |
| 157 | `relayDecision` | relaunch | safety | tag + ": missing or malformed relay field (want {kind: none \| names_input \| delegation \| request, text: <st | relay rulings: the relayed launch is not the build request |
| 158 | `relayDecision` | relaunch | safety | tag + ": relayed message is a request, not the build input: " + t + again | relay rulings: the relayed launch is not the build request |
| 159 | `relayDecision` | relaunch | safety | tag + ": relayed message is a general delegation, but this launch is attended (confirm ask, no unattended): "  | relay rulings: the relayed launch is not the build request |
| 160 | `planMode` | (stop) | safety | "args.input missing: run /build-task <ledger id \| Jira key \| issue or PR URL \| plan path \| text>" | an argument check (run-state, plan-ref or checkpoint trust) |
| 161 | `planMode` | (stop) | safety | "args.repo must be the absolute path of the caller's git toplevel" | an argument check (run-state, plan-ref or checkpoint trust) |
| 162 | `planMode` | (stop) | safety | "task id " + JSON.stringify(raw) + " is a legacy yadgar ledger id: " + RETIRED_REASON + "; its migrated yaadga | version or legacy ref |
| 163 | `planMode` | (stop) | safety | "task id " + JSON.stringify(raw) + " with no args.project under confirm \"auto\": pass project, or run with co | an argument check (run-state, plan-ref or checkpoint trust) |
| 164 | `planMode` | relaunch | safety | "intake: " + cutText(it.reason).slice(0, 300) + "; re-launch the workflow once in a turn whose latest human me | relay rulings: the relayed launch is not the build request |
| 165 | `planMode` | - | safety | "intake: task id " + JSON.stringify(raw) + ": " + nl | intake or ruling re-read: source, ledger or project identity |
| 166 | `planMode` | - | safety | "intake " + it.status + ": " + intakeHaltReason(it, raw) | a step reported failed or needs_human; cause unknown |
| 167 | `planMode` | - | safety | "intake: " + problem | intake or ruling re-read: source, ledger or project identity |
| 168 | `planMode` | - | safety | "intake: " + lp | intake or ruling re-read: source, ledger or project identity |
| 169 | `planMode` | gates | judgment | "intake: " + ug.reason | the task requires a gate the census reports unsupported: run unattended, or edit the task |
| 170 | `planMode` | - | safety | "task id derives to an empty slug from " + JSON.stringify(brief.sources[0].ref) | repo or branch identity |
| 171 | `planMode` | - | safety | oh | repo or branch identity |
| 172 | `planMode` | push | safety | noPushText(ws.remoteSlug).replace(SAME_PLAN_REF, "run plan again") | push access is not known or is refused |
| 173 | `planMode` | - | safety | "infra:branch-scan returned no commit or plan-ref list" | relay contract: a required field is missing or malformed |
| 174 | `planMode` | - | safety | "infra:branch-scan: the relayed lists do not match the program's digest (an entry was dropped or changed in th | relay digest or args mismatch: the copy may be altered |
| 175 | `planMode` | - | safety | "infra:branch-scan returned no usable head" | relay contract: a required field is missing or malformed |
| 176 | `planMode` | - | safety | "branch has build commits; run build, or delete branch " + lay.branch + " (first: " + built[0].sha + " " + JSO | a branch with build commits and no usable plan ref |
| 177 | `planMode` | - | safety | "branch " + lay.branch + " carries a plan commit of fleet 5.x (" + scan.commits[0].sha + "); since 6.0.0 the p | version or legacy ref |
| 178 | `fenceChanged` | scope | safety | where + ": changed path outside the scope fence: " + logPath(bad.join(", ")) | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 179 | `policyStep` | policy | safety | lb + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 180 | `policyStep` | policy | safety | "policy: " + r.error + "; fix or remove the file, then re-run the build" | policy file error |
| 181 | `prTestsStep` | stats | safety | label + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 182 | `prTestsStep` | role | safety | label + ": the PR body holds more test-count phrases than the program reports (16384 bytes); remove them from  | a truncated claims list fails closed (8.7.0 keeps it a stop) |
| 183 | `prTestsStep` | stats | safety | label + bad | PR body block or unattended disclosure check |
| 184 | `prState` | - | safety | label + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 185 | `prState` | stopGate | safety | label + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 186 | `buildMode` | (stop) | safety | LEGACY_REF | version or legacy ref |
| 187 | `buildMode` | (stop) | safety | "args.plan_ref " + tp + ": run /build-task again to re-plan" | an argument check (run-state, plan-ref or checkpoint trust) |
| 188 | `buildMode` | push | safety | "build start: " + noPushText(ws.remoteSlug) | push access is not known or is refused |
| 189 | `rereadBrief` | relaunch | safety | "intake:rulings: " + cutText(it.reason).slice(0, 300) + "; re-launch the workflow once in a turn whose latest  | relay rulings: the relayed launch is not the build request |
| 190 | `rereadBrief` | - | safety | "re-read of " + src.kind + ":" + src.ref + " for current rulings: " + nl + "; run build with confirm \"ask\"" | intake or ruling re-read: source, ledger or project identity |
| 191 | `rereadBrief` | - | safety | "re-read of " + src.kind + ":" + src.ref + " " + it.status + ": " + intakeHaltReason(it, input) | a step reported failed or needs_human; cause unknown |
| 192 | `rereadBrief` | - | safety | "re-read of " + src.kind + ":" + src.ref + ": " + problem | intake or ruling re-read: source, ledger or project identity |
| 193 | `rereadBrief` | - | safety | "re-read of " + src.kind + ":" + src.ref + ": " + legacy | version or legacy ref |
| 194 | `rereadBrief` | - | safety | "re-read of " + src.kind + ":" + src.ref + " resolved to " + fresh.sources.map((x) => x.kind + ":" + x.ref).jo | intake or ruling re-read: source, ledger or project identity |
| 195 | `buildFromRef` | - | safety | "plan ref missing or changed; re-run plan (" + tiny.plan_ref + " " + why + ")" | plan-ref trust: the approved plan is not what the branch holds |
| 196 | `buildFromRef` | - | safety | "load-ref: the relayed parts do not join to ref_sha256 " + tiny.ref_sha256 + " after the re-reads; the plan re | relay digest or args mismatch: the copy may be altered |
| 197 | `buildFromRef` | - | safety | "project mismatch: args.project " + JSON.stringify(input.project) + " but plan ref " + tiny.plan_ref + " seale | plan-ref trust: the approved plan is not what the branch holds |
| 198 | `buildFromRef` | - | safety | LEGACY_REF | version or legacy ref |
| 199 | `buildFromRef` | refFacts.gate | safety | "plan ref " + tiny.plan_ref + ": " + refFacts.msg | plan-ref trust: the sealed ref facts are refused |
| 200 | `buildFromRef` | commands | safety | "plan ref " + tiny.plan_ref + ": test_cmd refused: " + refTc | command allowlist |
| 201 | `buildFromRef` | commands | safety | "plan ref " + tiny.plan_ref + ": " + o.id + " check_cmd refused: " + pc.reason | command allowlist |
| 202 | `buildFromRef` | - | safety | "plan ref " + tiny.plan_ref + " was sealed before 6.0.0 (its plan commit is on the branch, so the plan doc wou | version or legacy ref |
| 203 | `buildFromRef` | - | safety | "plan ref " + tiny.plan_ref + ": commit prefix too long (" + subj.prefix.length + " characters; a subject is a | the sealed type(scope) prefix leaves no room for a summary under the subject cap (a long Jira key) |
| 204 | `buildFromRef` | - | safety | "plan ref " + tiny.plan_ref + ": unsafe commit subject " + JSON.stringify(x) + "; re-run plan" | plan-ref trust: the sealed ref facts are refused |
| 205 | `buildFromRef` | - | safety | "plan ref " + tiny.plan_ref + ": " + lpb + "; re-run plan" | plan-ref trust: the sealed ref facts are refused |
| 206 | `buildFromRef` | - | safety | "plan ref " + tiny.plan_ref + " holds no sealed origin URL (https or git@host: form); " + ORIGIN_FIX + ", then | repo or branch identity |
| 207 | `buildFromRef` | - | safety | "infra:verify-plan returned no usable head" | relay contract: a required field is missing or malformed |
| 208 | `buildFromRef` | - | safety | "infra:verify-plan: the relayed result has no is_ancestor, commits_since, plan_touched or changed_since list" | relay contract: a required field is missing or malformed |
| 209 | `buildFromRef` | - | safety | "infra:verify-plan: the relayed lists do not match the program's digest (an entry was dropped or changed in th | relay digest or args mismatch: the copy may be altered |
| 210 | `buildFromRef` | - | safety | "infra:verify-plan: " + OTHER_ARGS + " (" + JSON.stringify(v.args === undefined ? null : v.args) + ")" | relay digest or args mismatch: the copy may be altered |
| 211 | `buildFromRef` | - | safety | "infra:verify-plan: the relayed plan hash" + NOT_DIGEST + ", arguments or a full blob id" | relay digest or args mismatch: the copy may be altered |
| 212 | `buildFromRef` | - | safety | "infra:verify-plan: no replace_refs list" | relay contract: a required field is missing or malformed |
| 213 | `buildFromRef` | refs | safety | "verify: " + v.replace_refs[0] + " exists; replacement objects could change what a sealed object id reads as;  | refs/replace could change what a sealed object id reads as |
| 214 | `buildFromRef` | - | safety | "plan changed since approval: " + ref.plan_path + " at " + ref.plan_commit + " hashes " + v.plan_sha256 + ", a | plan-ref trust: the approved plan is not what the branch holds |
| 215 | `buildFromRef` | - | safety | "plan changed since approval: branch HEAD " + v.head + " does not descend from plan_base " + planBase | plan-ref trust: the approved plan is not what the branch holds |
| 216 | `buildFromRef` | - | safety | "plan changed since approval: a commit after " + planBase + " changed " + ref.plan_path + " (the plan doc neve | plan-ref trust: the approved plan is not what the branch holds |
| 217 | `buildFromRef` | - | safety | "a merge commit (possibly update-branch) is on the branch; this plan ref cannot be resumed or re-built — finis | plan-ref trust: the approved plan is not what the branch holds |
| 218 | `buildFromRef` | - | safety | "plan changed since approval: branch moved by a non-fleet commit " + c.sha + " " + JSON.stringify(c.subject) | plan-ref trust: the approved plan is not what the branch holds |
| 219 | `buildFromRef` | resume | safety | "run-state read did not complete: the relayed state" + NOT_DIGEST + " (" + stateRef + ")" | relay digest or args mismatch: the copy may be altered |
| 220 | `buildFromRef` | resume | safety | "run-state mismatch: " + what + " (" + stateRef + "); a committed fleet branch is never rebuilt from the write | run-state or resume trust |
| 221 | `buildFromRef` | resume | safety | "approved but unresumable: branch has build commits without run-state; push manually or delete branch" | run-state or resume trust |
| 222 | `buildFromRef` | resume | safety | "frozen resume refused: " + what + " (" + freezeRefName + "); clean or stash the worktree by hand and build wi | run-state or resume trust |
| 223 | `buildFromRef` | - | safety | LEGACY_REF | version or legacy ref |
| 224 | `buildFromRef` | iac | safety | "IaC pre-push check could not complete: the plan ref holds no sealed origin URL (https or git@host: form); " + | IaC rule: an IaC change or an unshimmed IaC tool |
| 225 | `buildFromRef` | iac | safety | "IaC pre-push check could not complete: origin's configured URL changed since the plan was sealed (" + remoteU | IaC rule: an IaC change or an unshimmed IaC tool |
| 226 | `buildFromRef` | iac | safety | "IaC pre-push check could not complete: " + label + " returned no usable result (the relayed result" + NOT_DIG | relay digest or args mismatch: the copy may be altered |
| 227 | `buildFromRef` | iac | safety | "IaC pre-push check stops: " + logPath(r.problems.join("; ")) + ". " + hints | IaC rule: an IaC change or an unshimmed IaC tool |
| 228 | `buildFromRef` | iac-push | safety | "IaC diffs never push automatically; the fleet hands the push to Max. Branch " + branch + ", commit " + approv | IaC diffs never push automatically |
| 229 | `buildFromRef` | scope | safety | "fleet internal files check did not complete: " + label + " returned no diff/commits lists" | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 230 | `buildFromRef` | scope | safety | "fleet internal files check did not complete: " + label + ": the relayed lists do not match the program's dige | relay digest or args mismatch: the copy may be altered |
| 231 | `buildFromRef` | scope | safety | "fleet internal files in PR diff: " + logPath(bad.join(", ")) | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 232 | `buildFromRef` | scope | safety | "the plan doc " + pp + " is in the PR diff or its commits; the plan doc never ships" | a path outside the scope fence, or the plan doc in the diff (scope rule) |
| 233 | `buildFromRef` | review | safety | wl + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 234 | `buildFromRef` | review | judgment | "review v" + k + ": PR body finding(s) " + [...new Set(holds.map((x) => x.id))].join(", ") + " count as resolv | the review counts a PR body finding resolved but the program finds its fact still holds after the one body update: a human edits the body |
| 235 | `buildFromRef` | role | safety | "pr-opener retry named " + r2.pr_url + " (#" + r2.pr_number + "), not " + r.pr_url + " (#" + r.pr_number + "); | the pr-opener's PR is not the expected one (identity) |
| 236 | `buildFromRef` | role | judgment | w2 | the pr-opener set a wrong title or left out gates_not_run after one scripted retry: a human edits the PR |
| 237 | `buildFromRef` | push | safety | "PR step: push access to " + remoteSlug + " still not known after a second probe (" + ghTried(remoteSlug) + ") | push access is not known or is refused |
| 238 | `buildFromRef` | push | safety | "PR step: " + noPushText(remoteSlug) + " (it resumes at the PR)" | push access is not known or is refused |
| 239 | `buildFromRef` | role | safety | "pr-opener returned ok with no PR (pr_url " + x.pr_url + ", pr_number " + x.pr_number + "); check the branch o | the pr-opener's PR is not the expected one (identity) |
| 240 | `buildFromRef` | role | safety | "pr-opener retry named " + r.pr_url + " (#" + r.pr_number + "), not " + first.pr_url + " (#" + first.pr_number | the pr-opener's PR is not the expected one (identity) |
| 241 | `buildFromRef` | role | judgment | w | the pr-opener set a wrong title or left out gates_not_run after one scripted retry: a human edits the PR |
| 242 | `buildFromRef` | - | judgment | w | the pr-opener set a wrong title or left out gates_not_run after one scripted retry: a human edits the PR |
| 243 | `buildFromRef` | role | safety | "pr-opener retry named " + r2.pr_url + " (#" + r2.pr_number + "), not " + first.pr_url + " (#" + first.pr_numb | the pr-opener's PR is not the expected one (identity) |
| 244 | `buildFromRef` | role | judgment | w2 | the pr-opener set a wrong title or left out gates_not_run after one scripted retry: a human edits the PR |
| 245 | `buildFromRef` | role | judgment | stillClaims(tl + ":counts", left, r.pr_url) | the PR body still states test counts after one scripted rewrite: a human edits the body |
| 246 | `buildFromRef` | - | safety | label + " returned " + r.status + ": " + (r.reason \|\| "no reason") | a step reported failed or needs_human; cause unknown |
| 247 | `buildFromRef` | - | safety | label + ": the relayed head and state object do not match the program's digest" | relay digest or args mismatch: the copy may be altered |
| 248 | `buildFromRef` | - | safety | label + ": the run-state landed on " + r.head + ", not " + approvedSha | run-state landed on another head (run-state trust) |
| 249 | `buildFromRef` | - | safety | label + " returned no usable state_sha" | relay contract: a required field is missing or malformed |
| 250 | `buildFromRef` | role | judgment | stillClaims("infra:pr-tests:resume", own, pr.pr_url) | the PR body still states test counts after one scripted rewrite: a human edits the body |
| 251 | `buildFromRef` | - | safety | pushLabel + ": the relayed push result" + NOT_DIGEST + " or arguments (push_result " + JSON.stringify(push.pus | relay digest or args mismatch: the copy may be altered |
| 252 | `buildFromRef` | - | safety | pushLabel + ": the relayed hook_rejected result is not the program's (exit_code " + JSON.stringify(push.exit_c | relay digest or args mismatch: the copy may be altered |
| 253 | `buildFromRef` | - | safety | pushLabel + ": push_result " + JSON.stringify(push.push_result \|\| null) + " after " + push.attempts + " atte | push did not land the approved commit |
| 254 | `buildFromRef` | - | safety | "push: origin/" + branch + " is at " + push.remote_head + ", not the approved " + approvedSha | repo or branch identity |
| 255 | `buildFromRef` | review | safety | "review: no PR to review (pr-opener returned no pr_url/pr_number)" | the review state does not match the pushed head, or a review role broke its contract |
| 256 | `buildFromRef` | review | judgment | "review v" + reviews + ": a finding targets the plan after update-branch: no re-plan runs on the forge's merge | a review finding targets the plan on the forge's merge: re-plan on the new base or fix by hand |
| 257 | `buildFromRef` | review | judgment | "review v" + reviews + ": PR body finding still flagged after one body update: " + bodyF.map((f) => (f.id \|\| | a PR body finding is still flagged after one body update: a human edits the body |
| 258 | `buildFromRef` | review | judgment | "re-review after update-branch requested changes: " + rv.blocking.map((f) => String(f.id \|\| "-")).join(", ") | the re-review after update-branch requests changes: no coder round runs on the forge's merge |
| 259 | `buildFromRef` | review | judgment | "review v" + reviews + ": PR title finding: the workflow builds the PR title and the commit subject from the p | a blocking review finding on the PR title or commit subject the workflow builds from the tldr: re-plan or a human edits both |
| 260 | `buildFromRef` | review | judgment | "review round " + reviews + " requested changes again: " + rv.blocking.map((f) => (f.id \|\| "-") + " " + (f.f | the review rounds are spent: a human fixes or re-plans |
| 261 | `buildFromRef` | stopGate | safety | where + ": " + noPushText(remoteSlug) | push access is not known or is refused |
| 262 | `buildFromRef` | merge | safety | "orchestrator PR: needs Max (" + pr.pr_url + "; CI " + ci.verdict + (ci.checks.length ? ": " + ci.checks.map(( | work-owner merge rule: a merge is Max's |
| 263 | `buildFromRef` | ci | safety | wl + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 264 | `buildFromRef` | ci | safety | wl + ": the head of " + pr.pr_url + " moved to " + w.head + " during the CI watch; nothing merged" | CI head or state is not the approved one |
| 265 | `buildFromRef` | ci | transient | t + "; nothing merged: " + pr.pr_url | CI checks still pending or unresolved at the watch deadline: the same watch later can resolve it |
| 266 | `buildFromRef` | merge | safety | "green, merge blocked: update-branch failed (" + (u.error \|\| "no new head") + "): " + pr.pr_url | work-owner merge rule: a merge is Max's |
| 267 | `buildFromRef` | merge | safety | "green, merge blocked: update-branch moved a head the review has not seen: " + pr.pr_url | work-owner merge rule: a merge is Max's |
| 268 | `buildFromRef` | merge | safety | "green, merge blocked: " + (m.error \|\| m.blocked \|\| "not merged") + " (" + pr.pr_url + ")" | work-owner merge rule: a merge is Max's |
| 269 | `buildFromRef` | ci | judgment | "CI red after update-branch, caused by the diff: " + rep + "; fix by hand: " + pr.pr_url | CI red caused by the diff after update-branch: no CI-fix round runs then |
| 270 | `buildFromRef` | ci | judgment | "CI still red after " + MAX_CI_FIX + " CI-fix rounds: " + rep | CI red caused by the diff after the CI-fix rounds |
| 271 | `buildFromRef` | ci | safety | "CI red, nothing merged: " + rep | CI head or state is not the approved one |
| 272 | `buildFromRef` | merge | safety | "green, merge blocked: the update-branch head " + f.head + " is not a plain forge merge of " + approvedSha + " | work-owner merge rule: a merge is Max's |
| 273 | `buildFromRef` | merge | safety | "update-branch: worktree HEAD " + h.fingerprint.head + " is not the fetched " + f.head | work-owner merge rule: a merge is Max's |
| 274 | `buildFromRef` | ci | safety | ol + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 275 | `buildFromRef` | iac | safety | "IaC PR: needs Max; the fleet watches no CI and merges nothing (" + pr.pr_url + ")" | IaC rule: an IaC change or an unshimmed IaC tool |
| 276 | `buildFromRef` | ci | safety | label + ": " + pr.pr_url + " is not ready at the approved " + approvedSha + " (" + (r.error \|\| "is_draft " + | CI head or state is not the approved one |
| 277 | `buildFromRef` | stats | safety | label + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 278 | `buildFromRef` | stats | safety | label + ": the PR body has no " + UNATT_HEAD + " section (the unattended run's automatic decisions); fix the b | PR body block or unattended disclosure check |
| 279 | `buildFromRef` | stats | safety | label + bad | PR body block or unattended disclosure check |
| 280 | `buildFromRef` | resume | safety | "run-state mismatch: update record " + JSON.stringify(o ? { head: uh, base: ub } : null) + " at " + approvedSh | run-state or resume trust |
| 281 | `buildFromRef` | resume | safety | "run-state mismatch: pr_number at " + resume.last_gate + " (" + stateRef + ")" | run-state or resume trust |
| 282 | `buildFromRef` | resume | safety | "resume at review refused: " + no | run-state or resume trust |
| 283 | `buildFromRef` | shipFix.gate === review ? review : resume | safety | "resumed run at " + next + ": the " + shipFix.gate + " gate needs a coder round, which a resumed run cannot st | a resumed run cannot start a coder round (run-state trust) |
| 284 | `buildFromRef` | - | safety | "test writer short r" + n + " returned no result" | a write step returned no result; its attempt may have written |
| 285 | `buildFromRef` | ownership | safety | "short-path writer touched " + logPath(nf) + " in test round " + n + " (not a test file of " + ids.join(", ")  | a role touched a path it does not own (ownership rule) |
| 286 | `buildFromRef` | ownership | safety | "short-path writer test " + JSON.stringify(t && t.name !== undefined ? t.name : null) + " in test round " + n  | a role touched a path it does not own (ownership rule) |
| 287 | `buildFromRef` | - | safety | "test writer " + cid + " r" + n + " returned no result" | a write step returned no result; its attempt may have written |
| 288 | `buildFromRef` | sg | safety | msg | per caller gate: ownership or hash (ownership rule) |
| 289 | `buildFromRef` | sg | safety | msg + (ok ? "; writers' output saved as " + ref + ", worktree reset to " + fp.head : "; save to " + ref + " an | per caller gate: ownership or hash (ownership rule) |
| 290 | `buildFromRef` | policy | safety | "infra:format-tests:r" + n + ": the policy's pre_freeze_hooks (" + pfh.join(", ") + ") did not run (" + fmt.no | policy file error |
| 291 | `buildFromRef` | ownership | safety | "writer committed: HEAD moved from " + pre.fingerprint.head + " to " + post.fingerprint.head + " in test round | a role touched a path it does not own (ownership rule) |
| 292 | `buildFromRef` | ownership | safety | logPath(violationName(k)) + " in test round " + n | a role touched a path it does not own (ownership rule) |
| 293 | `buildFromRef` | role | safety | "augmentation round (test round " + n + "): every test must report red_kind kills_mutant and the tests must na | a test writer broke the augmentation contract (role contract) |
| 294 | `buildFromRef` | rounds | judgment | "infra:format-tests:r" + n + ": pre_freeze_hooks still fail after " + maxTestRounds + " test round(s): " + lis | the writers' tests still fail the policy's format hooks after the test rounds |
| 295 | `buildFromRef` | ownership | safety | "infra:format-tests:r" + n + ": pre_freeze_hooks fail on " + listed + ", which no pending writer owns" | a role touched a path it does not own (ownership rule) |
| 296 | `buildFromRef` | - | safety | "test-judge returned no verdict" | relay contract: a required field is missing or malformed |
| 297 | `buildFromRef` | - | safety | w | the test judge broke its routing contract after one scripted retry |
| 298 | `buildFromRef` | rounds | judgment | "test rounds exhausted (" + maxTestRounds + ") without test-judge approval" | the test rounds are spent without test-judge approval |
| 299 | `buildFromRef` | fingerprint | safety | "worktree changed between test approval and freeze" | the worktree changed under a step (fingerprint rule) |
| 300 | `buildFromRef` | hash | safety | "suspicious paths in the worktree at freeze (':' or '#' in a name, or runner config in a skipped cache dir): " | a hash, freeze or refs check (hash rule) |
| 301 | `buildFromRef` | hash | safety | "re-freeze: " + MORE_OUTSIDE + " (" + k.more + " more)" | a hash, freeze or refs check (hash rule) |
| 302 | `buildFromRef` | hash | safety | "re-freeze touched unrouted path " + logPath(k.map === "ignored" && (k.expanded \|\| k.unavailable) ? keyNames | a hash, freeze or refs check (hash rule) |
| 303 | `buildFromRef` | - | safety | "infra:freeze-ref:f" + freezes + ": the freeze ref " + freezeRefName + " is at " + JSON.stringify(fr.ref_targe | a ref or head is not the expected one |
| 304 | `buildFromRef` | updRound ? review : rounds | judgment | "code rounds exhausted (" + MAX_CODE_ROUNDS + ") without code-judge approval" + (updRound ? " in the code roun | the code rounds are spent without code-judge approval |
| 305 | `buildFromRef` | - | safety | "agent " + rl + " returned no result" | a write step returned no result; its attempt may have written |
| 306 | `buildFromRef` | ownership | safety | "coder committed: HEAD moved from " + expectedHead + " to " + h.fingerprint.head + " in code round " + m + ";  | a role touched a path it does not own (ownership rule) |
| 307 | `buildFromRef` | hash | safety | "code round " + m + ": hash violation on " + logPath(viol.join(", ")) + " (frozen paths changed since freeze t | a hash, freeze or refs check (hash rule) |
| 308 | `buildFromRef` | coder.status !== ok && !coder.role_file ? role : contract | safety | "code round " + m + ": " + coderFile | the coder's result breaks its role contract |
| 309 | `buildFromRef` | gates | judgment | "code round " + m + ": the frozen tests are red at the start of the round after the augmentation round; its ne | the augmentation round's new tests fail on the approved tree |
| 310 | `buildFromRef` | review | judgment | "code judge returned " + cj.verdict + " in a code round after update-branch: no test writer, re-freeze or re-p | the code judge rejects after update-branch: no writer or re-plan runs on the forge's merge |
| 311 | `buildFromRef` | - | safety | "code-judge returned no verdict" | relay contract: a required field is missing or malformed |
| 312 | `buildFromRef` | updRound ? review : gates | judgment | "code round " + m + ": the code judge ruled surviving mutant(s) " + mutT.map((f) => f.mutant.id).join(", ") +  | the code judge ruled surviving mutants target tests after the one round a run may take |
| 313 | `buildFromRef` | gates | safety | "code round " + m + ": surviving mutant(s) ruled tests, but no criterion has a test file" | a gate result is missing or refused |
| 314 | `buildFromRef` | commit | safety | "commit step r" + m + ": staged tree " + cs.staged_tree + " != code tree " + codeTree + "; nothing committed" | the commit or its tree is not the checked one |
| 315 | `buildFromRef` | commit | safety | "commit step r" + m + ": hook modified files (worktree tree " + cs.worktree_tree + " != code tree " + codeTree | the commit or its tree is not the checked one |
| 316 | `buildFromRef` | - | safety | "commit step r" + m + " returned commit_result " + JSON.stringify(cs.commit_result \|\| null) + " and head " + | not clearly mechanical, judgment or transient (conservative default) |
| 317 | `buildFromRef` | commit | safety | "commit step r" + m + ": hook modified files (committed tree " + cs.head_tree + " != code tree " + codeTree +  | the commit or its tree is not the checked one |
| 318 | `buildFromRef` | commit | safety | "commit step r" + m + ": the commit's parent " + cs.parent + " is not the open PR's head " + prParent + "; the | the commit or its tree is not the checked one |
| 319 | `reviewStep` | review | safety | "review v" + k + ": no GitHub command can read " + ctx.remoteSlug + " (" + ghTried(ctx.remoteSlug) + ")" | the review state does not match the pushed head, or a review role broke its contract |
| 320 | `reviewStep` | - | safety | "infra:review-paths:v" + k + " returned no changed_paths" | relay contract: a required field is missing or malformed |
| 321 | `reviewStep` | - | safety | "infra:review-paths:v" + k + ": the relayed paths do not match the program's digest (a path was dropped or cha | relay digest or args mismatch: the copy may be altered |
| 322 | `reviewStep` | review | safety | "review v" + k + ": worktree HEAD " + pre.fingerprint.head + " is not the pushed " + ctx.approvedSha | the review state does not match the pushed head, or a review role broke its contract |
| 323 | `reviewStep` | review | safety | "sweep unit " + (um && um.unit != null ? um.unit : "?") + " not measured (" + (um && um.mutation != null ? um. | the review state does not match the pushed head, or a review role broke its contract |
| 324 | `replan` | - | safety | who + " verdict plan_wrong without a plan finding" | a judge broke its verdict contract |
| 325 | `replan` | - | safety | "infra:replan-worktree is at " + rw.head + ", not " + ref.plan_commit | a ref or head is not the expected one |
| 326 | `replan` | - | safety | "infra:replan-reset left " + lay.branch + " at " + rs.head + ", not " + ref.plan_base | a ref or head is not the expected one |
| 327 | `replan` | - | safety | "infra:replan-reset: superseded_head " + logPath(rs.superseded_head) + " is not " + ctx.expectedHead | a ref or head is not the expected one |
| 328 | `dbDsn` | db | safety | "internal: no test database " + db + " in " + state.db.name | test database or DSN rule |
| 329 | `dbDispatch` | db | safety | label + " returned " + r.status + ": " + (r.reason \|\| "no reason") | test database or DSN rule |
| 330 | `testDbStep` | db | safety | label + ": no test_db relay (the " + DB_DECL_FILE + " read)" | test database or DSN rule |
| 331 | `testDbStep` | db | safety | label + ": the relayed " + DB_DECL_FILE + " read" + NOT_DIGEST + " or arguments" | relay digest or args mismatch: the copy may be altered |
| 332 | `testDbStep` | db | safety | DB_DECL_FILE + " at origin/" + defaultBranch + " refused: " + t.error | test database or DSN rule |
| 333 | `testDbStep` | db | safety | DB_DECL_FILE + " at origin/" + defaultBranch + " is gone, but this run started a test database" | test database or DSN rule |
| 334 | `testDbStep` | db | safety | DB_DECL_FILE + " at origin/" + defaultBranch + " refused: " + dp | test database or DSN rule |
| 335 | `testDbStep` | db | safety | DB_DECL_FILE + ": no pinned image for " + t.decl.engine + " " + t.decl.major + " (known: " + Object.keys(DB_IM | test database or DSN rule |
| 336 | `testDbStep` | db | safety | DB_DECL_FILE + " changed during the run" | test database or DSN rule |
| 337 | `testDbStep` | db | safety | al + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 338 | `testDbStep` | db | safety | "internal: test database name " + JSON.stringify(name) + " refused" | test database or DSN rule |
| 339 | `testDbStep` | db | safety | "infra:db-up" + RELAY_MISMATCH | relay digest or args mismatch: the copy may be altered |
| 340 | `testDbStep` | db | safety | "infra:db-up: the program did not return one user per database" | test database or DSN rule |
| 341 | `testDbStep` | db | safety | "infra:db-up: the program started " + JSON.stringify(u.name) + ", not " + name | test database or DSN rule |
| 342 | `testDbStep` | db | safety | "infra:db-up: no usable port " + JSON.stringify(u.port === undefined ? null : u.port) | test database or DSN rule |
| 343 | `testDbStep` | db | safety | "infra:db-up: no self-expiry recorded" | test database or DSN rule |
| 344 | `probeMode` | (stop) | safety | "args.repo must be the absolute path of a git toplevel (probe runs the PATH check there)" | an argument check (run-state, plan-ref or checkpoint trust) |
| 345 | `probeMode` | contract | safety | "probe: the role-read agent (" + label + ") " + rp | a role, program or agent identity or contract mismatch |
| 346 | `main` | (stop) | safety | "args.mode must be \"plan\", \"build\" or \"probe\", got " + JSON.stringify(mode === undefined ? null : mode)  | an argument check (run-state, plan-ref or checkpoint trust) |
| 347 | `main` | (stop) | safety | "args.confirm must be \"ask\", \"auto\" or \"default\", got " + JSON.stringify(input.confirm) | an argument check (run-state, plan-ref or checkpoint trust) |
| 348 | `main` | (stop) | safety | "args.unattended must be true or absent, got " + JSON.stringify(input.unattended) | an argument check (run-state, plan-ref or checkpoint trust) |
| 349 | `main` | (stop) | safety | "args.user_confirm must be the mode the user named, got " + JSON.stringify(input.user_confirm) | an argument check (run-state, plan-ref or checkpoint trust) |
| 350 | `main` | (stop) | safety | "args.brief_marker must be true or false, got " + JSON.stringify(input.brief_marker) | an argument check (run-state, plan-ref or checkpoint trust) |
| 351 | `main` | (stop) | safety | "args.fresh_preflight must be true or false, got " + JSON.stringify(input.fresh_preflight) | an argument check (run-state, plan-ref or checkpoint trust) |
| 352 | `main` | (stop) | safety | "args.date must be YYYY-MM-DD (the skill supplies it; workflows cannot read the clock)" | an argument check (run-state, plan-ref or checkpoint trust) |
| 353 | `main` | (stop) | safety | "args.run_nonce missing or malformed: the skill passes a fresh value (date +%s%N) on every invocation; run /bu | an argument check (run-state, plan-ref or checkpoint trust) |
| 354 | `main` | (stop) | safety | "args.freeze_digest must be the 64-hex freeze_digest a build stop returned, and only in build mode; got " + JS | an argument check (run-state, plan-ref or checkpoint trust) |
| 355 | `main` | (stop) | safety | "args.checkpoint must be the {run, sha256} a plan stop returned, and only in plan mode; got " + JSON.stringify | an argument check (run-state, plan-ref or checkpoint trust) |
| 356 | `main` | (stop) | safety | "args.rerun_of must be the run_nonce of the stopped run that recover.args names (not this run's); got " + JSON | an argument check (run-state, plan-ref or checkpoint trust) |

## Stops that return without halt

These three stops return a result directly; each sets its class next to its stop gate.

<!-- prettier-ignore -->
| Function | Stop | Class | Reason |
| --- | --- | --- | --- |
| `autoFailResult` | auto-confirm: a check failed | safety | an auto-confirm gate (intent, scope, commands, hooks) failed: Max confirms the plan |
| `planMode` | branch has build commits; resume_with build | mechanical | the skill runs build with the sealed plan_ref: a deterministic hop with no judgment |
| `(top)` | build-engine was started without args | safety | an argument check |
