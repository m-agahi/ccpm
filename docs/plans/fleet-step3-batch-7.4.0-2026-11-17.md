# fleet 7.4.0: combined step-3 batch (2026-11-17)

Status: plan only (scope-and-plan, no code). Base: `origin/master` 2dffadb (fleet 7.3.0, PR #77).
Branch: `fleet/step3-batch`. One PR, one release: fleet 7.3.0 -> 7.4.0. Component: `plugins/fleet`.

## tldr

- Max ruled one PR and one release for every remaining step-3 fleet task, the same way as 7.3.0.
- 41 tasks were checked (first at adda09c, then re-based on master 2dffadb): the 37 listed tasks,
  #70 (added by the coordinator) and the 7.3.0 split-outs (#60 step 3, #39 part 2, #9 push).
- IN 26 (some only in part; #20 after Q1). CLOSE 5. PARK 10 (questions below). SPLIT-OUT 3 (#1, #6, #7: the
  v1.1 gates). MANUAL 4 (#19, #25, #31 manual part, #17 tool check).
- 6 sequential cars on one branch. Car 1 is #34 (Max: #34 first; #33 already shipped in 7.3.0),
  with the push program (#9) that needs it. Then oldest first, grouped by file overlap.
- Cars 1-5 can start at once. Car 6 (#60 step 3, #61) takes the PARK defaults Q3 and Q4 unless Max
  picks another option. Car 2 builds #20 only after Q1.
- Dist budget: 454,118 bytes at 2dffadb, guard 480,000, so 25,882 bytes of headroom. The IN items
  add about 10 KB. It fits. No guard raise is requested.
- No fix touches this repo's hook surface. No task causes terraform to run.

Line references: `src` = `plugins/fleet/src/build-task-run.js` (read at adda09c; 2dffadb differs by
the last 7.3.0 review commits only). Find a site by its symbol first, then by its line. Edit `src` only.
Regenerate the dist with `node plugins/fleet/scripts/build-workflow.mjs`. Tests run the dist.

## Per-task table

Class: IN = build now. CLOSE = done or obsolete. PARK = needs a Max decision (question below).
SPLIT-OUT = too big for this release. MANUAL = only a human-run test can settle it.

| Task            | Premise at 2dffadb                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Class                                      | Fix (short)                                                                                                                                       | ACs    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| #34 (L2141)     | real: no git spawn in a program lifts the cap. Network calls: `remote_head.py:55` ls-remote (no `lift()` in the file), `tf_gate.py:112` ls-remote and `:123` fetch, `pr_state.py:340` `g('fetch')` (`run(..., cmd='git')` passes `preexec_fn=None`, `:127`). The infra-agent shell prompts (src workspace fetch, push, push probe) run under no program cap                                                                                                                                                                                                                                                                                                                     | IN                                         | copy `lift()` into `remote_head.py` and `tf_gate.py`; `preexec_fn=lift` on the 4 network calls; local git stays capped                            | B1-B3  |
| #9 push (L2008) | real: `pushPrompt` (src ~3216) "Push ONCE ... stdout and stderr redirected to a temp file ..., then `echo $?`", and `RETRY_SHELL` (src ~3088) is a `for ... sleep; if cmd 2>"$e"` loop. `pushProbePrompt` (src ~3241) has the same redirect shape                                                                                                                                                                                                                                                                                                                                                                                                                               | IN (after #34, same car)                   | new program `push.py` (push once, bounded retry, classify, lift for the git child, hooks ON on purpose)                                           | P1-P4  |
| #36 (L2143)     | B1 real (src:5034, :5083 say "hook change needs Max's confirmation" for any error). B2, B3 routing exists, tests missing. B4 done by 7.1.1 (L2142). B5 real (`v632_gh_rlimit.test.mjs` has no host guard). B6 real (`TOKEN` in `ruleset_surface.py:125`, `pr_convention.py:82`, `gh_identity.py:125` misses `Bearer abc123`). B7 wording only                                                                                                                                                                                                                                                                                                                                   | IN (B1-B3, B5-B7). CLOSE B4                | HTTP None text; tests; skip guard; Bearer redaction; CHANGELOG reword                                                                             | H1-H5  |
| #2 (L1973)      | obsolete: 7.0.0 retired the yadgar ledger writer (CHANGELOG 7.0.0 "retired"; `RETIRED_REASON` src ~4256; no `task_write` in src, roles or skills). The blocker L1961 is a yadgar task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | CLOSE                                      | none                                                                                                                                              | none   |
| #3 (L1994)      | done by 6.0.0 (ledger 2042a, ADR-1213): the plan commit is a dangling `commit-tree` tagged at `refs/fleet/<task>/plan`, never on the branch; `verifyPlanCommit` stops with stop_gate `db` on `dsn_paths` (src ~5471)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | CLOSE                                      | none                                                                                                                                              | none   |
| #4 (L1995)      | real: README.md:1559-1562 lists 15 stop gates; `STOP_GATES` (src:207) has 22. Missing: `hooks`, `db`, `relaunch`, `policy`, `stats`, `ci`, `merge`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | IN                                         | README list matches `STOP_GATES`; a test pins it                                                                                                  | D1     |
| #6 (L2001)      | real: no 5.1.0 release exists; held-out examples are stripped (src ~4423, ~5242), the code judge gets `HELD_OUT_NOT_RUN`. No coverage gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | SPLIT-OUT (Q5)                             | see SPLIT-OUT                                                                                                                                     | none   |
| #7 (L2002)      | real: no mutation gate; the test-writer augmentation section is inactive (roles/fleet-test-writer.md:101)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | SPLIT-OUT (Q5)                             | see SPLIT-OUT                                                                                                                                     | none   |
| #1 (L1925)      | real in part. Gate diff (Max asked for it): shipped 1 (prompt + schema), 4 (stubs + fingerprint), 8 (script fence + prompt); prompt-only 6, 7, 9; NOT shipped 2 (mutation), 3 (held-out), 5 (coverage), 10 (security tools), the tool census and the "unsupported" matrix of ruling (b)+(c)                                                                                                                                                                                                                                                                                                                                                                                     | SPLIT-OUT (Q5)                             | a 7.5.0 plan of its own                                                                                                                           | none   |
| #11 (L2012)     | partly: `"iam_db_\n"` is missing from BAD (`v503_db_prefix.test.mjs:30-54`); `re.match` accepts it, `fullmatch` refuses. The title's "mutant survives" is wrong: `"iam_db"` in BAD already kills it. GOOD lacks `f_`, `fl_`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | IN (tests only)                            | add the BAD and GOOD cases                                                                                                                        | T1     |
| #12 (L2014)     | real as filed: dir hook tokens have no trailing slash (`hook_surface.py:117-130`), `isHookPath` (src ~5041) treats only `/`-ended entries as prefixes. Superseded by #15: under Max's ruling, files under a dir hook path are not hook surface, so the exact match is the consistent rule                                                                                                                                                                                                                                                                                                                                                                                       | CLOSE (superseded by #15 ruling)           | none; a comment at `isHookPath` names the ruling                                                                                                  | none   |
| #13 (L2015)     | real: no `--ignore-submodules=none` in `scripts/` (tree diffs: `hasher.py:577`, `review_paths.py:40`, `fleet_scan.py:58`, `verify_since.py:60`, `format_files.py` `differs()`); `hook_surface.py` sets no `GIT_CONFIG_NOSYSTEM` and no `core.fsmonitor=false`; `gate()` (src ~3562) logs raw paths, so a path with a newline can forge a log line                                                                                                                                                                                                                                                                                                                               | IN                                         | the flag on 5 diffs; env and `-c` in hook_surface; `gate()` maps control characters to `?`                                                        | G1-G3  |
| #14 (L2016)     | real, low: `format_files.py:88-95` and `hasher.py:113-126` snapshot with `read-tree` + `add -A`, which runs repo clean filters. Turning filters off changes tree hashes for LFS and eol repos (false dirty files, a tree that no longer equals the commit step's)                                                                                                                                                                                                                                                                                                                                                                                                               | PARK (Q6)                                  | default: no change; close                                                                                                                         | none   |
| #15 (L2017)     | real, Max ruled "Allow, hooks run at commit": `format_files.py` `dir_offenders()` (:181) returns selected paths under a dir hook path; `done(refused=...)` then halts (src format-tests, format-code, format-plan)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | IN                                         | `dir_offenders` drops paths in `sel_set` (:156); every other refusal stays                                                                        | F1-F3  |
| #16 (L2021)     | (a) real: `hasher.py:470` skips every `-` token, so `--config=scripts/x.toml` is never frozen. (b) dir policy: a non-lenient hook freezes every dir argument; lenient hooks freeze none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | IN (a). PARK (b, Q2)                       | (a) freeze the repo file of a `--opt=value` token                                                                                                 | K1     |
| #17 (L2023)     | real, needs tools: `BUILD_ENV_ROWS` (src ~3103) vars are not verified on real turbo, mypy, coverage. Node leftovers (`.next/`, `tsbuildinfo`, coverage dir, `.eslintcache`) have no env var; Max ruled in 5.0.6 "no exemption". No cold-build timing data                                                                                                                                                                                                                                                                                                                                                                                                                       | MANUAL + PARK (Q7)                         | default: keep strict, add a README limitation line in car 3                                                                                       | D3     |
| #18 (L2024)     | partly: `retryOnDrift` (src ~3806) re-runs a role in the same build dir with no reset (real, low). Concurrent runs on one worktree: `build_dir.py:97-100` `reset` deletes the whole build root (an unsupported setup). Sibling writes: not enforceable by script                                                                                                                                                                                                                                                                                                                                                                                                                | IN (drift reset + README). Rest documented | `retryOnDrift` calls `resetBuild` for the role's keys; README states one run per worktree                                                         | R1     |
| #19 (L2025)     | cannot be read from code: role and push commands carry `env K='v' ...` prefixes (src `envPrefix` ~3121, `hookEnvPrefix` ~8643). Whether the permission matcher strips `env K=v` depends on the Claude Code version                                                                                                                                                                                                                                                                                                                                                                                                                                                              | MANUAL                                     | Max runs the check below                                                                                                                          | none   |
| #20 (L2026)     | real: `cargo metadata --locked --offline --format-version 1` -> `metadata` and `1` hit the final else of `hook_refs` (`hasher.py` ~484) -> "unresolvable local hook". Field hit: reachgraph L2083 build stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PARK (Q1), then IN in car 2                | default (a): digits and a per-tool subcommand table pass; the command token stays strict                                                          | K2, K3 |
| #21 (L2028)     | partly: `hasher.py:603-606` puts every `refs/fleet/*` in the git map, kept inline (`INLINE_GIT`, :706); 6.2.2 filters foreign refs after the relay (src ~3891). The 65536-byte cap halts loudly at roughly 150+ tasks. Path lists each have their own cap halt                                                                                                                                                                                                                                                                                                                                                                                                                  | PARK (Q8)                                  | default: defer                                                                                                                                    | none   |
| #22 (L2029)     | load-parked digest retry done by 7.3.0 (#42, CHANGELOG 7.3.0 "Covers #22"); `test_db_decl` nested digest retry exists (`nestedMiss`, src ~3677). Real: `hash_diff.py:57` `CAP = 50`; past 50 changed keys a `more` row turns into a violation name in the writer-round check (src ~7644-7652) and the refreeze loop (~7793)                                                                                                                                                                                                                                                                                                                                                     | IN (cap part)                              | `hash_diff.py` takes the round's allowed keys and prints only the keys outside them                                                               | W1, W2 |
| #23 (L2035)     | real, 3 parts: no warning when `session_project.py`'s `cwd` (digest-checked, src ~4132-4135) is the repo or a worktree under it; the no-proof stop (src ~4346, ~8455) gives no next step; no comment on the derive-rule divergences in `session_project.py`                                                                                                                                                                                                                                                                                                                                                                                                                     | IN                                         | gate warning; stop text with the next step; program comment                                                                                       | S1, S2 |
| #25 (L2053)     | unknown from the repo: README Threat model (~1094) says nothing about CLAUDE.md or AGENTS.md auto-load in Workflow agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | MANUAL                                     | canary run, then one README paragraph (a later patch)                                                                                             | none   |
| #26 (L2054)     | real: roles/plan-audit.md has no paraphrase-first rule (only the `source_quote` advisory, ~:56)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | IN (role text)                             | advisory bullet: paraphrase the brief before reading the plan; a mismatch is a routed finding, never a verdict change                             | X1     |
| #27 (L2055)     | real as a feature, low value: `memory_notes` are only offered (skills/build-task/SKILL.md ~266)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | PARK (Q9)                                  | default: close as won't-do                                                                                                                        | none   |
| #28 (L2056)     | real: README.md:40 and :984 say "ten" role prompts; `roles/` has 11 (`fleet-ci-classifier`, src:40); harness.mjs:81 comment says "ten"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | IN                                         | "eleven", list adds `fleet-ci-classifier`                                                                                                         | D2     |
| #29 (L2084)     | real (6.1.0 CHANGELOG lists them as known gaps): `TEST_INPUTS` (src ~1342) has no jest/vitest setup files; no pytest `-p` resolution; `hook_surface.py` npm branch does not follow nested `npm run`; a dir in a script (`node --test test/`) is never `tracked`; `testCmdRuns` does not follow `source`d shell libs                                                                                                                                                                                                                                                                                                                                                             | IN                                         | five stricter matches; all refuse more, none accepts more                                                                                         | N1-N5  |
| #30 (L2098)     | N1 real: no `fleet-brief` text in src outside the unattended auto-decide line (src:5961). L3 real: `skills/plan-task/brief_check.py:273` strips only token ends and `IAC_EXT` (:48) anchors at `\Z`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | IN                                         | N1: a marker body with a caller confirm not `ask` stops, except under unattended. L3: strip `:<digits>` and `'s`/`’s`                             | M1-M3  |
| #31 (L2103)     | leak real: `skills/fleet-policy/policy_init.py:101-110` `temp_copy` leaves the `mkstemp` file on a write error. P7, P8, T5, T6 are manual (CHANGELOG 6.2.x) and no entry reports them run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | IN (leak). MANUAL (P7, P8, T5, T6)         | `unlink` the temp file on any exception, then raise                                                                                               | L1     |
| #39 part 2      | real: worktrees sit at `<repo>/.claude/worktrees/...`; a worktree with no root `package.json` makes npm walk up into the main checkout. npm 11.19 checked: `npm_config_prefix` and `npm_config_local_prefix` do not change it; only `--prefix` does                                                                                                                                                                                                                                                                                                                                                                                                                             | IN (plan-time guard)                       | plan mode refuses an npm/pnpm/yarn `test_cmd` when `package.json` (and the script) is not tracked at the worktree root at HEAD                    | J1     |
| #45 (L2179)     | real: plan-audit.md:47 accepts a brief requirement "listed in Non-goals or Open decisions with a reason", so a narrowing passes the audit and the intent judge refuses it after a full run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | IN (role text)                             | a Non-goal covers a brief requirement only when the brief puts it out of scope or an Open decision cites the brief line                           | X2     |
| #46 (L2180)     | the field case (STRICT null-widening in another repo) cannot be re-run here; the rule gap is real: plan-audit.md (criteria gate ~:78-86) has no "trace the example through the loader the test uses" rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | IN (role text)                             | plan-audit traces each example through the test's real loader; the test writer stops needs_human on an unreachable example, never works around it | X3     |
| #57 (L2196)     | obsolete: since 7.0.0 (ADR-0992, ADR-0994, yaadgaar #699) every project keeps tasks in yaadgaar; intake (src ~2522) sends bare ids to `mcp__yaadgaar__read_task`, `L<n>` stops with a hint (src ~5790). The task's AC1 contradicts that design                                                                                                                                                                                                                                                                                                                                                                                                                                  | CLOSE                                      | none                                                                                                                                              | none   |
| #60 step 3      | real: the sweep runs only in `reviewStep` (src ~8205-8241), after the PR. `GATE_PATH_RE` (src:218)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | IN (car 6, Q3 default)                     | plan-mode sweep after an approving plan-audit, on the shipped gate at `base_ref`; `weakening` -> `replanWithFindings`                             | Z1-Z3  |
| #61             | real: blocking review findings go to the coder; a coder `needs_human` halts at `coderFile` (src ~7938-7939) before the code judge, the only role that returns `plan_wrong` (src ~8010 -> `planWrong` ~7662)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | IN (car 6, Q4 default)                     | coder `test_conflict` goes to the code judge; review and sweep findings with `target: "plan"` go to `planWrong`                                   | Y1-Y4  |
| #62             | partly, needs measurement: 19 `pathRecheck` sites, 8 `resetBuild` sites (8 of them back to back with a `pathRecheck`), 9 hasher sites. The 14-run max is 92 of `MAX_AGENTS` 100                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | SPLIT-OUT + PARK (Q10)                     | see SPLIT-OUT                                                                                                                                     | none   |
| #64             | all 7 real: `pr_test_block.py:75-76` regexes miss the listed forms and match "test 2 of AC3"; ROUNDS skip at :96 applies anywhere; `ownClaims` (src ~6185) is a substring match; `testsBlock` (src ~6151) prints "0 errors" for null; `pr_body_block.py` region starts at the first opener-writable `<details><summary>Built with ccpm fleet`                                                                                                                                                                                                                                                                                                                                   | IN                                         | per item below                                                                                                                                    | V1-V7  |
| #66             | 1: `pr_body_block`, `pr_test_block` are not in `ERROR_BRANCH_PROGRAMS` (src:3988); both callers already stop on an error (src ~7402, ~6203). `hash_diff` uses `softDispatch` (src ~3934), so it needs no routing. 2: `pr_state.py:242-248` merged + error has no test. 3: no idempotence note                                                                                                                                                                                                                                                                                                                                                                                   | IN                                         | route the two programs; pin merged + error; one CHANGELOG line                                                                                    | E1, E2 |
| #68             | 1 real (no memo; up to 18 plan-mode agents, fails closed). 2 real: `callers.py:43` `SUMMARY_CAP = 4096` with `doctest_md` in a one-symbol summary. 3 real: the over-200 auto-hit finding gives a count only (src ~4914). 4: CHANGELOG 7.2.0 overclaim. 5: dead `RELAY_CAP` branch                                                                                                                                                                                                                                                                                                                                                                                               | IN (1 docs, 2, 3, 4). 5 left               | docs; one-symbol summary may reach 16384 bytes; name the scratch file; reword                                                                     | C1, C2 |
| #69             | real: any role with a shell can write `refs/fleet/<tid>/plan` with a self-computed `sha256` seal (`sealOf` src:1495; readers src ~6033, `fleet_branch.py:60-77`, `branch_scan.py:79-83`). No key can sit outside a role's read scope: `settingsFor` emits allow rules only, and a `Read` deny does not stop `cat` (README Threat model, ADR-1152)                                                                                                                                                                                                                                                                                                                               | PARK (Q11)                                 | default: decline, document in README Threat model (car 3)                                                                                         | D4     |
| #70             | real, 4 items: (1) `scratch_copy.py` run option scan (:166) treats only `-` tokens as options, so shell `+O`/`+o` end the scan, and value-taking options are not all listed (bash `--rcfile`, ruby/perl `-I`/`-r`, node `-C`/`--conditions`, python `--check-hash-based-pycs`); the PATH shim stays the primary guard. (2) `commandShapeProblems` (src ~5612) skips `test_cmd`, so `sh -c ...` passes the auto gates and `scratch_copy run` refuses it later. (3) short task ids can collide (`slugify` is lossy, the forge is not in the id; `idSlug` src ~1505 hashes only ids over 24 characters). (4) no test pins the run-state `chunkRounds` halt with stop_gate `resume` | IN (1, 2, 4). PARK (3, Q12)                | (1) `+` tokens are options for shells; per-interpreter value-option lists. (2) refuse inline-code forms of `test_cmd`. (4) test                   | U1-U3  |

Counts:

- IN 26: #34, #9 push, #36 (B1-B3, B5-B7), #4, #11, #13, #15, #16 (a), #18 (part), #20 (after Q1),
  #22 (cap part), #23, #26, #28, #29, #30, #31 (leak), #39 part 2, #45, #46, #60 step 3, #61, #64,
  #66, #68 (1-4), #70 (1, 2, 4). Plus the README line for #17.
- CLOSE 5: #2, #3, #12, #57, #36 B4 (part). #22 closes after 7.4.0 merges.
- PARK 10: #20 (Q1), #16 (b) (Q2), #60 step 3 trigger (Q3), #61 PR-open route (Q4), #14 (Q6),
  #17 (Q7), #21 (Q8), #27 (Q9), #69 (Q11), #70 item 3 (Q12). Q5 and Q10 go with the SPLIT-OUT items.
- SPLIT-OUT 3 whole: #1, #6, #7. Plus #62 (needs a measurement first).
- MANUAL 4: #19, #25, #31 (P7, P8, T5, T6), #17 (real tools).

## Fix designs (IN)

### #34: lift the cap for git network calls (Max ruling 2026-11-14 "Lift caps on git network calls")

- `remote_head.py`: copy the 4-line `lift()` from `pr_state.py:89`; `preexec_fn=lift` on the
  ls-remote call (:55).
- `tf_gate.py`: same copy; `preexec_fn=lift` on ls-remote (:112) and fetch (~:123).
- `pr_state.py`: `run()` gets `net=False`; `preexec_fn=lift if (not cmd or net) else None` (:127).
  `g('fetch', ...)` (:340) passes `net=True`.
- Every other git call keeps the cap (non-goal: no cap value changes).
- `tests/v632_gh_rlimit.test.mjs:118` asserts "no git spawn passes preexec_fn". Change it on purpose
  to "only the network calls do", and say so in the CHANGELOG.

### #9 push: a push program (after #34)

- New `scripts/push.py <main_worktree> <branch> <approved_sha> <default_branch> <hook_env json>`.
  1. Checks: branch is not the default; HEAD is `approved_sha`; `status --porcelain` is empty.
  2. Push once: `git -C <wt> push -u origin <branch>` with `env` = the hook env, `preexec_fn=lift`,
     output captured by the program. **The target repo's pre-push hooks run on purpose.** This is
     the one fleet git call that does not set `core.hooksPath=/dev/null`. A code comment and test P2
     say so.
  3. Network retry 5/15/45 s on the classes `push_classify.py` names as transient. The whole ladder
     has a 540 s deadline (under the agent's 600 s Bash limit): no retry starts when the remaining
     time is less than the last attempt took.
  4. Prints `{push_result, exit_code, hook_tail, attempts, args, program, digest}`. The
     classification of `push_classify.py` moves into it; `push_classify.py` stays for the resume check
     (src ~6933-6952) in this release.
- `pushPrompt` (src ~3216): step 2 becomes one `progCmd("push", ...)` call. `RETRY_SHELL` is no
  longer used by the push. Keep it if another prompt uses it (the builder greps).
- `pushProbePrompt` (src ~3241): same shape, `push.py --dry-run` (no retry, 120 s).
- New `PROGRAM_SLOTS`, `PROGRAM_KEYS`, `INFRA_TIER` rows; `PROGRAM_COUNT` 45 -> 46.
- #34's source scan (AC B3 below) includes `push.py`: its push is a network call and must lift.

### #36: 6.3.2 review lows (brief B1-B7, Max ruled "All five")

- B1: one helper `hookReadStop(err)` used at src:5034 and :5083. When `/HTTP None/` matches:
  "hook surface cannot be computed (<err>): transient GitHub read failure; re-run". Else the text is
  unchanged.
- B2, B3: tests only (routing exists in `programErrorRelay`, src ~3993).
- B4: done in 7.1.1; no test needed beyond the existing v711 files.
- B5: `v632_gh_rlimit.test.mjs` reads the hard `RLIMIT_AS`; at or under 1 GiB the lift tests skip
  with a message that names the hard limit.
- B6: the `TOKEN` regex in `ruleset_surface.py`, `pr_convention.py`, `gh_identity.py` adds
  `Bearer\s+\S+` (redacted as `Bearer ***`).
- B7: CHANGELOG 6.3.2 line "a 6.3.1 plan ref stays valid: nothing sealed changed" becomes "a 6.3.1
  plan ref stays valid: the sealed preflight record differs, and resume only logs that".

### #4, #28, #17 line, #18 line, #69 line: README

- #4: README Result section (~1559) lists all 22 `STOP_GATES` in src order.
- #28: README:40 and :984 "eleven"; the role list names `fleet-ci-classifier`; harness.mjs:81 comment.
- #17 (Q7 default): one "Known limits" line: Node build leftovers (`.next/`, `tsconfig.tsbuildinfo`,
  coverage dir, `.eslintcache`) in the worktree stop the hash check; set them outside the worktree in
  the repo config. TURBO, MYPY and COVERAGE env vars are not verified on real tools.
- #18: one line: one fleet run per worktree at a time; a second run's build reset deletes the first
  run's build dirs.
- #69 (Q11 default): Threat model paragraph: a role with a shell can forge a sealed plan ref in
  another task's namespace; branch adoption (7.3.0 #43) trusts it; not defended (ADR-1152).

### #11: db prefix test gaps

- `tests/v503_db_prefix.test.mjs` BAD adds `["trailing newline", "iam_db_\n"]`. GOOD adds `"f_"` and
  `"fl_"` (the existing loops assert the escaped grant pattern).

### #13: hook-surface git hardening

- `--ignore-submodules=none` on the tree diffs in `hasher.py:577`, `review_paths.py:40`,
  `fleet_scan.py:58`, `verify_since.py:60`, `format_files.py` `differs()`.
- `hook_surface.py`: `os.environ['GIT_CONFIG_NOSYSTEM'] = '1'` and `-c core.fsmonitor=false` on its
  git argv (as `hasher.py:59`).
- `hookGate` and its `why()` (src ~5041-5066): every interpolated path goes through
  `logPath(p) = String(p).replace(/[\x00-\x1f]/g, "?")`. `gate()` itself does not change: some gate
  messages are multi-line on purpose.

Gate-change table (#13 only tightens):

| input                                            | shipped            | planned |
| ------------------------------------------------ | ------------------ | ------- |
| gitlink change, repo `diff.ignoreSubmodules=all` | not seen (accepts) | seen    |
| gitlink change, no repo config                   | seen               | seen    |
| path `a\nGATE fake` in the hook gate line        | two log lines      | one     |

### #15: format steps allow selected files under a dir hook path (Max ruled "Allow, hooks run at commit")

- `format_files.py` `dir_offenders()` (:181): drop the paths in `sel_set` (:156) from the result.
- Still refused: a symlinked or replaced hook dir, a gitlink, a non-selected untracked or ignored
  file (a planted `conftest.py`), a non-selected tracked edit.
- Dirty mode (format-code): `cand` (= `sel_set`) is every dirty path, so a modified or untracked
  `conftest.py` under the dir passes `format_files`. The backstop is the hasher: `hook_refs` freezes
  the dir tree that a hook executes, and the post-coder hash check refuses a change to it. F3 proves
  that backstop. **F3 is a hard precondition: if F3 is not green after the change, the car stops and
  #15 does not ship.**
- Tests changed on purpose (named in the CHANGELOG, test names cite the ruling):
  `v504_pycache.test.mjs` ~:125, ~:140 (non-dirty selected case), ~:250.

| input                                                                           | shipped          | planned                                       |
| ------------------------------------------------------------------------------- | ---------------- | --------------------------------------------- |
| selected `scripts/tests/test_x.py` under dir hook `scripts/tests`, format-tests | refused          | accepted (ruling)                             |
| non-selected untracked `scripts/tests/conftest.py`, format-tests                | refused          | refused                                       |
| ignored `scripts/tests/conftest.py`, any mode                                   | refused          | refused                                       |
| `scripts/tests` replaced by a symlink                                           | refused          | refused                                       |
| coder edits frozen-hook-dir `scripts/tests/conftest.py`, format-code            | refused (format) | accepted by format, refused by the hash check |

### #16 (a): freeze `--opt=path` values

- `hasher.py` `hook_refs` flag branch (:470): for a token `--x=v` with `v` a repo file, add it to
  `refs`. A pure tightening (more files frozen).

| input                               | shipped        | planned          |
| ----------------------------------- | -------------- | ---------------- |
| `ruff check --config=ruff.toml src` | ruff.toml free | ruff.toml frozen |
| `--max-line-length=100`             | skipped        | skipped          |

### #20 (after Q1, default (a)): subcommand tokens

- `hasher.py` before the final else (~:484), for `i != cmd_at`: pass a token that matches `^[0-9]+$`,
  or a token directly after the command token when `(basename(cmd), token)` is in
  `SUBCOMMANDS = {'cargo': {metadata, fmt, clippy, check, test, build, doc, tree, audit, deny,
nextest}, 'go': {vet, test, build, fmt, mod}, 'git': {diff, status, log, ls-files}}`.
- The command token stays strict (`which` or a repo path). Unknown plain tokens stay unresolvable.

| input                                                  | shipped | planned  |
| ------------------------------------------------------ | ------- | -------- |
| `cargo metadata --locked --offline --format-version 1` | refused | accepted |
| `pytest -p myplug` (no such file)                      | refused | refused  |
| `python check_x` (no such file)                        | refused | refused  |
| `cargo frobnicate`                                     | refused | refused  |
| `nosuch/`, `.`, `../` (v505 cases)                     | refused | refused  |

### #18: drift retry resets its build dir

- `retryOnDrift` (src ~3806) takes `opts.buildKeys`; when set, it calls
  `resetBuild(label + ":drift", opts.buildKeys, phase)` before the retry. The callers that own a build
  dir pass their keys (writers, test judge, coder, code judge). One more infra agent per drift retry;
  drift retries are rare.

### #22 (cap part): writer rounds past 50 changed keys

- `hash_diff.py` gets an optional `--allow <map>:<key>` list (the round's own test files, which the
  script already knows). It prints `changed` only for keys outside the allow list (still capped at 50) and `allowed_changed: <count>`. No row holds a hash (rows are `[map, key, kind]`); the full
  hashes stay in `resolved` as today.
- The writer-round check (src ~7644-7652) and the refreeze loop (~7793) pass the allow list. A `more`
  row now means more than 50 keys outside the allow list: it stops with the named reason "more than
  50 changed files outside the round's test files (<n> more)", never a mangled violation name.
- The `args` echo check (src ~3935) covers the new args.

| input                                   | shipped             | planned                         |
| --------------------------------------- | ------------------- | ------------------------------- |
| 60 writer test files changed, all owned | halt (mangled name) | accepted                        |
| 3 non-test files changed among 60       | halt (mangled name) | halt naming the 3               |
| 55 non-test files changed               | halt (mangled name) | halt "more than 50 ... outside" |

### #23: session_project follow-ups

- After the digest check (src ~4135): when `sj.cwd === repo` or `sj.cwd` starts with
  `repo + "/.claude/worktrees/"`, `gate("WARN session_project ran in <cwd> (the repo or a fleet
worktree): a cd there is ignored; start the session in the directory you mean")`. No stop.
- The no-proof stop text (src ~4346, ~8455) adds: "; pass args.project, or start the session in a
  directory under the repo (a .yadgar/project-id or an origin remote)".
- `session_project.py` header comment lists where its derive rule differs from the SessionStart
  hook's (the builder reads both and writes only observed differences). Sha pin moves.

### #26, #45, #46: plan-audit role text (one role edit, one sha move)

- #26 plan-audit.md, Planner-quality findings: before reading the plan, write a two-sentence
  paraphrase of the brief's outcome. After the audit, compare. A gap is a routed finding
  (`advisory: paraphrase gap`). It never changes the verdict.
- #45 plan-audit.md:47: a Non-goal covers a brief requirement only when the brief itself puts it out
  of scope, or an Open decision cites the brief line. Else `plan_defect` with a routed finding.
  scope-and-plan.md (~109-110): any narrowing of the brief goes in Open decisions with the brief
  line, never in Non-goals alone.
- #46 plan-audit.md, criteria gate (~86): trace each criterion example through the same loader,
  schema or validator its test will use; an example that path rejects or changes is unreachable ->
  `untestable_criteria`. fleet-test-writer.md: a writer that cannot reach an example stops
  needs_human naming the criterion; it never works around it.

### #29: R4 gaps (each refuses more; none accepts more)

- N1 nested `npm|pnpm|yarn run X`: `hook_surface.py` npm branch follows script X inside script text,
  depth 3, visited set.
- N2 a directory in a script or recipe: `hook_surface.py` emits `dir/`; `testCmdRuns`/`cmdRuns`
  (src ~1358-1389) match `p.startsWith(dir)`.
- N3 pytest `-p mod`: resolve like `-m` (`mod.py`, `mod/__init__.py`), a new target kind.
- N4 jest/vitest setup files: `TEST_INPUTS.jest` adds the basename regex
  `^(jest|vitest)\.(setup|config)\.|^setupTests\.|\.setup\.[cm]?[jt]sx?$`.
- N5 `source`d shell libs: `testCmdRuns` of `bash x.sh` adds the files `x.sh` sources (depth 1),
  as the hook-script scan does.

### #30: fleet-brief marker backstop; brief_check suffix

- N1, plan mode, after `briefProblem` (src ~5810): when any `brief.sources[].body` holds
  `<!-- fleet-brief:v1 -->`, the caller's `confirm` (`confirm0`, before any unattended change) is not
  `"ask"`, and the run is NOT unattended: stop needs_human, "the brief holds the fleet-brief marker:
  re-run with confirm ask (a briefed task is confirmed by Max)". Under unattended the marker stays a
  ruling, as src:5961 logs today.
- The builder first checks (v620_body_page) that a body_slug page body arrives in `source.body`. If
  it does not, the check also scans the page text field the intake relays; M2 pins the result.
- L3 `brief_check.py:273`: after the strip, cut `:\d+(:\d+)?$` and `('s|’s)$`, then strip again.

### #31: policy_init temp file

- `policy_init.py` `temp_copy` (:101-110): `except BaseException: os.unlink(tmp); raise` around the
  fchmod, write and fsync.

### #39 part 2: npm walk-up guard (plan time)

- At the plan hook-surface call (src ~5259), pass the npm target of `planFacts.test_cmd.command`
  (`npmTargetOf`). When `make_paths[target]` is null (no tracked `package.json`, or no such script,
  at HEAD; `hook_surface.py:299-303` already returns none), add a plan finding: "package.json (with
  scripts.<name>) is not tracked at the worktree root; npm would walk up into the main checkout". It
  goes through `planFindingsStop` like the DSN finding.
- Non-goal: moving the worktrees out of the repo.

### #60 step 3: plan-mode sweep (Q3 default (a)+(c))

- Planner output `touches_gate` (boolean, optional, sealed in `plan_facts`).
- `planAndAudit`, after plan-audit approves (after src ~5320, before the plan doc commit): planned
  paths = criteria `test_files` + `allowed_additions.files` + `repo_obligations[].files` +
  `changed_symbols[].file` (the paths `scopeProblems`, src ~5587, reads). When `touches_gate === true`
  or any planned path matches `GATE_PATH_RE`:
  - `resetBuild("sweep:plan", ["sweep-plan"], "Plan")`, `pathRecheck("sweep:plan", "Plan")`.
  - `callRole("gate-change-nonweakening-sweep", "role:gate-change-nonweakening-sweep:plan", {mode:
"plan", base_ref, criteria, plan_path, brief})`.
  - `weakening`: the loose units become routed findings `{criterion, finding: "planned gate accepts
<unit> that the shipped gate refuses; make it an Open decision citing the brief, or keep the
refusal"}`. Under `auditRound < maxRounds` -> `replanWithFindings`; else `halt("needs_human",
..., "intent")`.
  - `non_weakening` with an unmeasured unit -> needs_human (as `reviewStep` does).
- The sweep role gets a `mode: "plan"` section: no head copy exists; measure each criterion example
  and 2-3 known-bad inputs against the shipped gate at `base_ref` (`scratch_copy.py make` on
  `base_ref`), and read the planned behaviour from the plan doc. The post-PR sweep in `reviewStep`
  stays.
- Cost: one opus agent + 2 infra agents, only for gate plans.

### #61: test conflicts and plan-target review findings (Q4 default (a))

- fleet-coder schema: optional `test_conflict: {test, findings: [ids], why}`. Role text
  (fleet-coder.md ~74): on a wrong-looking frozen test, return `needs_human` with `test_conflict`.
- src ~7938: when `coder.status === "needs_human"` and `test_conflict` is a well-formed object, do not
  halt. Run the code judge for this round with input `test_conflict` and the routed findings. The
  judge returns `plan_wrong` (-> `planWrong("code-judge", ...)`, src ~8010) or `fix_tests` (existing
  route). Any other verdict -> the halt as today. In an update round (`updRound`, src ~8008),
  `plan_wrong` stays refused: the halt as today.
- pr-review and sweep schemas: finding `target` gains `"plan"` (pr-review.md ~94: a fix that
  contradicts a frozen test or criterion). The review routing in `shipSteps` (src ~7022 main path, ~6997 update
  path; both build `target: "code"` findings from `codeF`): findings with `target === "plan"` go to
  `planWrong("pr-review", ...)`, not to the coder. `planWrong` (src ~7662) is a function of the same
  `buildMode` scope as `shipSteps` (src ~6894), so no new plumbing. On the update path a plan target
  halts as an update round's `plan_wrong` does today (src ~8008).
- With a PR open under unattended, `autoDecide("plan_wrong","ask")` (src ~8341) stays (Q4 (a)): the
  run stops needs_human with the re-plan ready.

### #64: pr_test_block follow-ups

1. `pr_test_block.py` P1/P2 (:75-76): allow `[*_\x60~]*` after the number, one optional word before
   the noun, `pass|fail` in P1, `passing` in P2, `\d+\s*/\s*\d+` and `\d+ of \d+` near "test", NBSP and
   newline between number and word, `\d+\+`.
2. A claim needs the number before a test noun (`147 tests`, `147 passed`); "test 2 of AC3" and
   "Step 2 tests the parser" no longer match. "AC1 has 3 tests" still matches (a real claim form).
3. ROUNDS skip (:96) only on a line that starts with `| tests written |` inside the stats region.
4. `ownClaims` (src ~6185): whole-phrase match with word bounds.
5. `testsBlock` (src ~6151): null `errors` -> "errors not reported", not added to the total.
6. `pr_body_block.py`: a matched stats region that holds `<!-- ccpm-fleet-tests -->` -> `error`
   ("stats region overlaps the test block"), no write.
7. Test: halt-then-resume in `v710_claims_resume`'s style (notes-check stop, then re-run).

Gate-change table for item 2 (the claim check is a fail-closed backstop):

| input                     | shipped | planned  |
| ------------------------- | ------- | -------- |
| `**147** passed`          | missed  | claim    |
| `147 unit tests`          | missed  | claim    |
| `147/147`                 | missed  | claim    |
| `test 2 of AC3`           | claim   | no claim |
| `Step 2 tests the parser` | claim   | no claim |
| `147 tests` (no supplied) | claim   | claim    |

### #66: error routing and notes

1. `ERROR_BRANCH_PROGRAMS` (src:3988) adds `pr_body_block`, `pr_test_block`. Their callers' own stop
   (`halt("needs_human", ..., "stats")`, src ~7402, ~6203) then runs instead of the generic
   "returned failed". `hash_diff` stays out (it runs through `softDispatch`).
2. Test: `pr_state.py` merge mode prints `merged: true` with an error when the branch delete raises;
   the run records the merge (src ~6677).
3. CHANGELOG line: the failed-relay digest retry re-runs `format_files` and `pr_test_block`; both are
   idempotent.

### #68: callers follow-ups

1. CHANGELOG and README: the on-disk callers path adds up to 18 plan-mode agents (36 with retries);
   a heavy run can reach "agent cap 100 reached" (fails closed). No memo in this release.
2. `callers.py`: a summary of one symbol may reach 16384 bytes (`SUMMARY_CAP_ONE`); more symbols keep 4096.
3. src ~4914: the over-200 auto-hit finding names the scratch file (`r.file`).
4. CHANGELOG 7.2.0 line "every joined list is checked against the summary count and hash" becomes
   "the auto part is checked by count; completeness comes from the union hash and the per-entry
   re-check".

### #70: 7.3.0 review follow-ups (items 1, 2, 4)

1. `scratch_copy.py` run: for a shell interpreter (`sh`, `bash`, `dash`, `zsh`), a token that starts
   with `+` is an option too. A per-interpreter table of value-taking options (bash `--rcfile`,
   `--init-file`; ruby and perl `-I`, `-r`; node `-C`, `--conditions`, `--title`, `--input-type`;
   python `--check-hash-based-pycs`) skips the value. For a shell, the inline-code check scans the
   whole argv. Defense in depth: the PATH shim stays the primary guard.
2. `commandShapeProblems` (src ~5612): a `test_cmd` whose argv has an inline-code form
   (`sh|bash -c`, `python -c`, `node -e|--eval`, `perl|ruby -e`) is a problem: "test_cmd runs inline
   code; scratch_copy run refuses it, so the judges' copy check cannot run". Same form list as
   `scratch_copy.py`'s refusal, so the two agree.
3. Test only: a run-state write whose rewrite rounds run out halts with stop_gate `resume`.

## Acceptance criteria

Tests go in `plugins/fleet/tests/v740_<topic>.test.mjs` and use `harness.mjs`. Python programs are
run by the tests through `spawnSync("python3", ["-I", <script>, ...])`, as the v730 program tests do.

- **B1** (#34 brief B1, `v740_git_net_lift.test.mjs`). Given a fleet program that runs
  `git ls-remote` against an https remote with a stub credential helper that exits 2 when its
  `RLIMIT_AS` soft limit is below 2 GiB, When the program runs, Then the stub helper sees a soft limit
  equal to the hard limit and the git call succeeds. Same for `tf_gate.py` (ls-remote, fetch) and
  `pr_state.py fetch`.
- **B2** (#34 brief B2, same file). Given a fleet program that runs `git status` (no remote), When the
  child's limits are read (a stub `git` on PATH logs them), Then the soft `RLIMIT_AS` equals the
  program's 1 GiB cap.
- **B3** (#34 brief B3, same file). Given every `scripts/*.py`, When the source is searched for git argv
  holding `fetch`, `push`, `ls-remote` or `remote update`, Then each such call passes `lift` (the
  scan includes `push.py`).
- **P1** (#9, `v740_push_program.test.mjs`). Given a temp repo with a bare origin, When `push.py`
  runs, Then the branch is on origin at `approved_sha` and the output has `push_result: "ok"`, a
  digest and `args`.
- **P2** (#9, same file). Given the temp repo with a `pre-push` hook that exits 1, When `push.py`
  runs, Then `push_result` is the hook-refused class, `hook_tail` holds the hook's output, and no
  retry runs. (Hooks run on purpose.)
- **P3** (#9, same file). Given a stub `git` that fails with a transient network error twice, Then
  `attempts` is 3 and the result is ok. Given a deadline already spent, Then no retry starts.
- **P4** (#9, same file). Given the push and push-probe prompts, Then neither holds `$?`, `2>` or
  `for `, and each names `push.py` through `progCmd`.
- **H1** (#36 B1, `v740_review_lows.test.mjs`). Given a `hook_surface` result with error
  "HTTP None", When the caller stops, Then the reason contains "transient GitHub read failure;
  re-run" and not "hook change needs Max's confirmation". Given error "HTTP 404", Then the reason is
  unchanged.
- **H2** (#36 B2, same file). Given a `hook_surface` relay `failed`, exit 0, a valid digest and a
  non-null error, When `infra()` routes it, Then stop_gate is `hooks`.
- **H3** (#36 B3, same file). Given a `ruleset_surface` relay `failed` whose `args` differ from the
  request, Then the reason contains "returned failed".
- **H4** (#36 B5, `v740_review_lows.test.mjs`; the guard itself is in `v632_gh_rlimit.test.mjs`). Given a hard `RLIMIT_AS` of at most 1 GiB (forced
  through an env override in the test), Then the lift tests skip with a message naming the hard limit.
- **H5** (#36 B6, `v740_review_lows.test.mjs`). Given gh stderr "Authorization: Bearer abc123", When
  each of the three programs redacts it, Then the text does not contain "abc123".
- **T1** (#11, `v740_db_prefix.test.mjs`; the BAD and GOOD entries also go into the v503 lists). Given prefix `"iam_db_\n"`, Then db*up refuses it. Given
  `"f*"`, Then it is accepted and the grant pattern is `f\_%`.
- **G1** (#13, `v740_hook_git.test.mjs`). Given a temp repo with a submodule gitlink changed and
  `diff.ignoreSubmodules=all` in its config, When `hasher.py` diffs the trees, Then the gitlink path
  is in `changed`.
- **G2** (#13, same file). Given `hook_surface.py` run with `GIT_CONFIG_SYSTEM` pointing at a file that
  sets an alias, Then the alias is not used (`GIT_CONFIG_NOSYSTEM`).
- **G3** (#13, same file). Given a hook gate on a path `a\nGATE fake`, Then the gate log has one line
  that holds `a?GATE fake`.
- **F1** (#15, `v740_hook_dir_allow.test.mjs`, names cite "Max ruling L2017"). Given dir hook path
  `scripts/tests` and a selected new `scripts/tests/test_x.py`, When format-tests runs, Then
  `refused` is empty.
- **F2** (#15, same file). Given a non-selected untracked `scripts/tests/conftest.py`, Then refused.
  Given an ignored one, Then refused. Given `scripts/tests` as a symlink, Then refused.
- **F3** (#15, same file). Given a frozen hook dir `scripts/tests` and a coder edit to
  `scripts/tests/conftest.py`, When the build runs format-code then the post-coder hash check, Then
  format-code passes and the run stops at stop_gate `hash`.
- **K1** (#16 a, `v740_hasher_hook_refs.test.mjs`). Given a local hook `ruff check
--config=ruff.toml src`, Then `hook_refs` lists `ruff.toml`. Given `--max-line-length=100`, Then
  nothing is added and nothing is bad.
- **K2** (#20, same file, after Q1 (a)). Given a local hook `cargo metadata --locked --offline
--format-version 1`, Then `bad` is empty.
- **K3** (#20, same file). Given `pytest -p myplug`, `python check_x` and `cargo frobnicate` (no such
  files), Then each is "unresolvable local hook". The v505 `nosuch/`, `.`, `../` cases stay bad.
- **R1** (#18, `v740_drift_reset.test.mjs`). Given a test-writer result with contract drift once,
  When `retryOnDrift` retries, Then an `infra:build-reset:...:drift` call runs before the retry call.
- **W1** (#22, `v740_hash_diff_allow.test.mjs`). Given 60 changed writer test files, all in the
  round's test files, When the writer-round check runs, Then no violation and no halt.
- **W2** (#22, same file). Given 3 changed non-test files among 60, Then the halt names those 3.
  Given 55 non-test files, Then the reason contains "more than 50 changed files outside the round's
  test files".
- **S1** (#23, `v740_session_project.test.mjs`). Given `session_project` relays `cwd` equal to the
  repo, Then the gate log contains "WARN session_project ran in" and the run continues.
- **S2** (#23, same file). Given `session_project` resolves no project and no `args.project`, Then the
  stop reason contains "pass args.project".
- **D1** (#4, `v740_readme.test.mjs`). Given README.md and `STOP_GATES`, Then every gate name appears
  in the README Result section.
- **D2** (#28, same file). Given README.md, Then it contains "eleven role prompts" and
  `fleet-ci-classifier`, and not "ten role prompts".
- **D3** (#17, #18, same file). Given README.md, Then it states the Node leftovers limit and the
  one-run-per-worktree limit.
- **D4** (#69, same file). Given README.md Threat model, Then it names forged sealed plan refs as not
  defended.
- **X1** (#26, `v740_role_text.test.mjs`). Given plan-audit.md, Then it holds the paraphrase-first
  rule and says it never changes the verdict.
- **X2** (#45, same file). Given plan-audit.md and scope-and-plan.md, Then both hold the
  "Open decision cites the brief line" narrowing rule.
- **X3** (#46, same file). Given plan-audit.md, Then it holds the "same loader as the test" rule with
  `untestable_criteria`; fleet-test-writer.md holds the stop rule for an unreachable example.
- **N1-N5** (#29, `v740_r4_gaps.test.mjs`). Given each form (a nested `npm run`, `node --test test/`,
  `pytest -p mod`, a `jest.setup.js`, a `bash x.sh` that sources `lib.sh`), When the file it reaches
  changes in an update-branch merge, Then the R4 refusal names it. Control: an unrelated file change
  is not refused.
- **M1** (#30, `v740_brief_marker.test.mjs`). Given a source body with `<!-- fleet-brief:v1 -->` and
  confirm `auto` (no unattended), When plan mode runs, Then needs_human with "fleet-brief marker" and
  no build. Same with confirm `default`.
- **M2** (#30, same file). Given the marker and confirm `ask`, Then the run ends
  awaiting_confirmation as today. Given the marker in a body_slug page, Then M1 holds. Given the
  marker under unattended (policy `unattended`, `brief_marker: true`), Then no marker stop, and
  `auto_decisions` logs the confirm as today.
- **M3** (#30, `v740_brief_marker.test.mjs`). Given input "touch infra/main.tf:12 and stacks/x.tf, and
  env.tfvars’s", When `brief_check.py` runs, Then all three IaC paths are flagged.
- **L1** (#31, `v740_policy_init.test.mjs`). Given a write that raises inside `temp_copy`, Then no
  temp file is left in the fleet dir.
- **J1** (#39 part 2, `v740_npm_walkup.test.mjs`). Given `test_cmd` `npm test` and a hook-surface
  result with no `package.json` at the worktree root, When plan mode runs, Then the plan stops with a
  finding that contains "npm would walk up". Given `package.json` with `scripts.test`, Then no finding.
- **Z1** (#60 step 3, `v740_plan_sweep.test.mjs`). Given a plan whose `allowed_additions.files`
  holds `plugins/x/hooks/check.py`, When plan-audit approves, Then
  `role:gate-change-nonweakening-sweep:plan` runs with `mode: "plan"` before the plan doc commit.
- **Z2** (#60 step 3, same file). Given that sweep returns `weakening` with unit
  "stale base dist" `shipped_refuses: true, new_refuses: false` (the L2190 case), Then a re-plan runs
  with a routed finding naming "stale base dist", and no freeze runs. At the last audit round, Then
  needs_human.
- **Z3** (#60 step 3, same file). Given a plan with no gate path and `touches_gate` false, Then no
  sweep call runs (no change for such plans).
- **Y1** (#61, `v740_test_conflict.test.mjs`). Given the coder returns needs_human with
  `test_conflict {test: "v701_x.test.mjs", findings: ["S1"], why}`, When the round runs, Then the code
  judge runs with input `test_conflict`, and its `plan_wrong` starts a re-plan (no role halt).
- **Y2** (#61, same file). Given the coder returns needs_human with no `test_conflict`, Then the halt
  is as today (stop_gate `role`).
- **Y3** (#61, same file). Given pr-review returns a blocking finding with `target: "plan"`, Then no
  coder round runs and `planWrong("pr-review", ...)` runs. Under unattended with a PR open, Then
  needs_human with the re-plan ready (`auto_decisions` holds `plan_wrong: ask`).
- **Y4** (#61, same file). Given an update round where the judge answers a test conflict with
  `plan_wrong`, Then the halt is as today.
- **V1-V7** (#64, `v740_pr_test_block.test.mjs`). V1-V4: one case per row of the item-2 table, per
  item-1 form, for the item-3 ROUNDS line and for the item-4 word bounds ("13 tests" supplied does
  not exempt "3 tests"); V5: a judge with `errors: null` -> the block holds "errors not reported";
  V6: an opener-written `<details><summary>Built with ccpm fleet` above the test block ->
  `pr_body_block` error, the body unchanged; V7: halt-then-resume keeps one test block.
- **E1** (#66, `v740_error_routing.test.mjs`). Given a `pr_test_block` relay `failed`, exit 0, a valid
  digest and error "body over cap", Then the stop is the caller's (stop_gate `stats`), not "returned
  failed". Same for `pr_body_block`. Mutation: with the names removed from `ERROR_BRANCH_PROGRAMS`,
  the test fails.
- **E2** (#66, same file). Given `pr_state.py merge` whose branch delete raises, Then it prints
  `merged: true` and a non-null error, and the run result reason starts with "merged".
- **C1** (#68, `v740_callers_followups.test.mjs`). Given one symbol with 90 `.md` doctest hits and a
  summary of about 9 KB, Then the callers step does not stop needs_human. Given two symbols over 4096
  bytes, Then the stop is as today.
- **C2** (#68, same file). Given more than 200 auto hits, Then the finding names the scratch file.

- **U1** (#70 item 1, `v740_scratch_copy_guard.test.mjs`). Given `scratch_copy.py run` with argv
  `["bash", "+O", "extglob", "-c", "<a denylisted tool>"]`, Then it refuses. Given
  `["bash", "--rcfile", "x", "-c", "<a denylisted tool>"]`, `["ruby", "-I", "lib", "-e", "x"]`,
  `["node", "-C", "dev", "-e", "x"]`, Then each refuses. Given `["pytest", "-q"]`, Then it runs.
  (The test names the denylisted tool literally, as `v730_review_scratch_guard` does.)
- **U2** (#70 item 2, same file). Given a plan whose `test_cmd` is `sh -c 'pytest'`, When the auto
  gates run, Then the command gate refuses it with "runs inline code". Given `pytest -q`, Then no
  problem.
- **U3** (#70 item 4, `v740_state_chunks_resume.test.mjs`). Given a run-state write whose chunk 1 is
  bad on every rewrite round, When the rounds run out, Then the run stops with stop_gate `resume`.

Test command: `node --test 'plugins/fleet/tests/*.test.mjs'`. Dist and tables:
`node plugins/fleet/scripts/build-workflow.mjs`, then `node plugins/fleet/scripts/gen.mjs --check`.

## Overlap map

| Function or file                                                                                   | Tasks                       |
| -------------------------------------------------------------------------------------------------- | --------------------------- |
| `lift()` copies, `pr_state.py run()`, `v632_gh_rlimit.test.mjs`                                    | #34, #9, #36 B5             |
| `pushPrompt`, `pushProbePrompt`, `push_classify.py`, new `push.py`                                 | #9                          |
| hook stop text src ~5034/5083, `programErrorRelay`, `ERROR_BRANCH_PROGRAMS`                        | #36, #66                    |
| `format_files.py` (`dir_offenders`, `differs`)                                                     | #15, #13 (#14 if ruled)     |
| `hasher.py` `hook_refs`, tree diff                                                                 | #16 a, #20, #13             |
| `hook_surface.py`                                                                                  | #13, #29, #39 p2            |
| `hash_diff.py`, writer-round check src ~7644, refreeze ~7793                                       | #22                         |
| `retryOnDrift`, `resetBuild`                                                                       | #18, #60 s3                 |
| `hookGate`, `why()` (path text only)                                                               | #13                         |
| `briefProblem` neighbourhood src ~5810, `confirm0`                                                 | #30                         |
| `sessionProject` src ~4132-4135, ~4346                                                             | #23                         |
| `testCmdRuns`, `cmdRuns`, `TEST_INPUTS`                                                            | #29                         |
| plan hook-surface call src ~5259, `planFindingsStop`                                               | #39 p2, #60 s3              |
| `pr_test_block.py`, `pr_body_block.py`, `testsBlock`, `ownClaims`                                  | #64, #66                    |
| `callers.py`, callers on-disk path src ~4547-4914                                                  | #68                         |
| `scratch_copy.py` run, `commandShapeProblems`, state-chunk tests                                   | #70                         |
| `planAndAudit`, `replanWithFindings`, `planWrong`, `reviewStep`, coder halt src ~7938              | #60 s3, #61                 |
| roles: plan-audit, scope-and-plan, fleet-test-writer, fleet-coder, pr-review, sweep; `ROLE_SHA256` | #26, #45, #46, #60 s3, #61  |
| README.md                                                                                          | #4, #28, #17, #18, #69, #68 |
| `INFRA_TIER`, `PROGRAM_KEYS`, `PROGRAM_SLOTS`, program sha table                                   | every car                   |

## Car order

One builder per car, sequential, same branch. Each car: red tests first (shown by a test run, not a
red commit: the check-changelog hook refuses a test-only commit), then code, then regenerate the dist
and tables, then the full suite green, then one commit with `CHANGELOG.md` staged.

1. **Car 1: network cap and push.** #34, #9 push, #36. Max put #34 first. #9 needs #34's lift; #36
   shares `v632_gh_rlimit.test.mjs` and the error routing. Car 1 bumps the version to 7.4.0 (pins
   below) and opens the 7.4.0 CHANGELOG entry.
2. **Car 2: hook, format and hash scripts (L2012-L2029).** #11, #13, #15, #16 (a), #18, #22, and #20
   when Q1 is answered (else #20 waits for a later car or a patch).
3. **Car 3: docs, intake and session text (L1995-L2103).** #4, #23, #28, #30, #31 (leak), and the
   README lines for #17, #18, #69.
4. **Car 4: R4 and npm (L2084, L2162).** #29, #39 part 2. Both touch `hook_surface.py` and the plan
   hook-surface call.
5. **Car 5: release follow-ups (#64, #66, #68, #70).** `pr_test_block`, `pr_body_block`, callers,
   `scratch_copy.py`, `commandShapeProblems`, a state-chunk test.
6. **Car 6: roles and re-plan routes (L2179, L2180, L2054, #60, #61).** #45, #46, #26, #60 step 3,
   #61. Every role edit is in this car, so `ROLE_SHA256` moves once. Takes Q3 and Q4 defaults unless
   Max answers otherwise.

Order note: Max's rule is #34 first, then oldest first. Car 1 pulls #36 (L2143) forward because it
shares `v632_gh_rlimit.test.mjs` and the hook stop text with #34. Car 2 (from L2012) runs before car 3
(from L1995) to keep the script-only gate changes together; the two cars share no file, so a swap is
safe if Max wants strict age order. #70 is new and sits in car 5 with the other release follow-ups.

Every car appends to the one 7.4.0 CHANGELOG entry. No car changes the version again.

## Dist budget

Measured: 454,118 bytes at 2dffadb (7.3.0 on master). Guard: 480,000 (`tests/size_guard.test.mjs:21`).
Headroom 25,882 bytes.

| Car | Items                                                 | Est. dist bytes |
| --- | ----------------------------------------------------- | --------------- |
| 1   | #34 (0), #9 (+1000 worst), #36 (+170)                 | ~1,200          |
| 2   | #13 (+100), #18 (+150), #22 (+450), rest scripts only | ~700            |
| 3   | #23 (+350), #30 (+350), rest docs                     | ~700            |
| 4   | #29 (+1,300), #39 p2 (+300)                           | ~1,600          |
| 5   | #64 (+200), #66 (+40), #68 (+100), #70 (+150)         | ~500            |
| 6   | #60 s3 (+2,200), #61 (+3,000), roles (sha only)       | ~5,200          |
| all | plus new table rows (~400)                            | ~10,000         |

It fits: about 10 KB of 25.9 KB, with about 15 KB left. No guard raise is requested.
If a car goes over its estimate by more than 2x, the builder stops and reports before the next car.
The split-out v1.1 gates (#6 + #7, about 12-17 KB) would not fit with this batch: that is one more
reason they are split out.

## Version-bump pins (7.3.0 -> 7.4.0, car 1)

Find each pin by text, not by line (the branch rebases after 7.3.0 merges). Test titles that start
with "7.3.0 ..." and `// 7.3.0` comments are history: leave them.

- `plugins/fleet/src/build-task-run.js` `const FLEET_VERSION = "7.3.0"`.
- `.claude-plugin/marketplace.json` the fleet entry `"version": "7.3.0"`. Re-stage what the
  `update-plugin-versions` hook writes into root `README.md` (`### fleet (v7.3.0)`); never hand-edit it.
- `plugins/fleet/tests/harness.mjs` `export const SCRIPTS_DIR = ".../fleet/7.3.0/scripts"`.
- `plugins/fleet/tests/v4_s1.test.mjs`: `assert.equal(m[1], "7.3.0")`, the `fleet/7.3.0/scripts`
  path table, the `for d in "$HOME"/.claude/plugins/cache/*/fleet/7.3.0/scripts;` assertion, the
  `/fleet\/7\.3\.0\/scripts/` regex, and the `"fleet", "7.3.0"` path joins.
- `plugins/fleet/tests/v5_roles.test.mjs`: the `"fleet", "7.3.0"` join and
  `assert.equal(p.fleet_version, "7.3.0")`.
- `plugins/fleet/tests/v4_s3.test.mjs`: `assert.equal(p.fleet_version, "7.3.0")` and the regex
  `/...install fleet 7\.3\.0/`.
- `plugins/fleet/tests/v600_s3.test.mjs`: `Built with ccpm fleet 7.3.0` (TPL and the `startsWith`).
- Regex-escaped pins (`git grep -F '7\.3\.0'`): `build_task_run.test.mjs` (4 asserts: "install fleet
  7\.3\.0", "this fleet workflow is fleet 7\.3\.0", the role-files path, "fleet-code-judge\.md hashes
  .\*install fleet 7\.3\.0"), `v403_schema_types.test.mjs` (the sha256sum path), `v622_fixes.test.mjs`
  ("install fleet 7\.3\.0").
- `plugins/fleet/CHANGELOG.md`: new `[7.4.0]` entry at the top.
- After the bump run both `git grep -n "7\.3\.0" -- ':!*CHANGELOG.md' ':!docs/plans'` and
  `git grep -n -F '7\.3\.0'`. A hit that is not a history comment or test title is a missed pin.

## PARK questions (for Max)

Each has the default the build takes if Max picks the recommendation, and the car it blocks.

- **Q1 (#20, blocks #20 in car 2).** A local hook like `cargo metadata --locked --offline
--format-version 1` stops the build ("unresolvable local hook: metadata, 1"). How should plain
  subcommand tokens be treated? (a) Digits plus a per-tool subcommand table (cargo, go, git); unknown
  plain tokens stay refused. (b) Any plain token with no `/` that is not a repo path passes (opens a
  not-yet-created module or script, for example `pytest -p myplug`). (c) No change. Recommend (a).
  Default if Max takes it: K2, K3 as written.
- **Q2 (#16 (b), blocks nothing).** Which dirs does the hasher freeze? (1) Keep today's rule: every
  dir argument of a non-lenient hook. (2) Only dirs a test runner executes (pytest, jest, vitest,
  mocha, node --test), lenient hooks included; other tools' dir arguments are no longer frozen (a
  weakening; needs the sweep). Recommend (1). Default: no change in 7.4.0.
- **Q3 (#60 step 3, car 6).** When does the plan-mode sweep run? (a) A planned path matches
  `GATE_PATH_RE`. (b) Widen `GATE_PATH_RE` (for example `src/build-task-run.js` is no gate path
  today). (c) The planner sets `touches_gate`. Recommend (a)+(c). Default: (a)+(c) as designed.
- **Q4 (#61, car 6).** With a PR open under unattended, a re-plan ends at
  `autoDecide("plan_wrong","ask")`. Keep that? (a) Yes: needs_human with the re-plan ready. (b) Auto
  re-plan and push new commits to the open PR. (c) Close the PR and open a new one. Recommend (a).
  Default: (a).
- **Q5 (#1, #6, #7; split out).** The v1.1 gates: 2 (mutation), 3 (held-out), 5 (coverage),
  10 (security tools), and the tool census with an "unsupported" matrix are not shipped. Which first,
  as a 7.5.0 plan? (a) The tool census plus coverage (#6 half), then held-out, then mutation (#7).
  (b) The census plus gate 10 first (no storage question). (c) Script versions of 6, 7, 9 only.
  Recommend (a). Sub-question: held-out examples cannot sit in the plan ref or plan doc (roles read
  both), and plan and build are separate runs unless confirm is auto. Store them (i) only in a
  confirm-auto single run, (ii) in an orchestrator-only file under the fleet config dir (readable by
  a role with a shell; ADR-1152 accepts that), or (iii) drop the held-out gate. Recommend (ii).
- **Q6 (#14, blocks nothing).** Harden the snapshot against repo clean filters? (a) `format_files`
  only, filters off (false "dirty" files in LFS and eol repos). (b) No change: the filter definitions
  in `.git/config` are already frozen by the hasher's `config:local` map. (c) Hasher too (its tree
  then differs from the commit's). Recommend (b) and close. Default: close.
- **Q7 (#17, blocks nothing).** Node build leftovers (`.next/`, `tsbuildinfo`, coverage dir,
  `.eslintcache`) stop the hash check. (a) Keep strict (5.0.6 ruling) and document it. (b) Exempt
  these names in the hasher. Recommend (a). Default: the README line in car 3. The env-var check needs
  real tools (MANUAL).
- **Q8 (#21, blocks nothing).** The hasher relays every `refs/fleet/*` inline; the relay cap halts
  loudly at roughly 150+ tasks. (a) Defer. (b) Filter to the task's own refs in `hasher.py` (map hash
  and foreign-ref logging change; about one car). (c) Raise the cap. Recommend (a). Default: defer.
- **Q9 (#27, blocks nothing).** A human-gated reflect step after a run: (a) close as won't-do,
  (b) a SKILL.md paragraph that offers role or skill edit proposals, (c) a new `/fleet-reflect`
  skill. Recommend (a). Default: close.
- **Q10 (#62; split out).** Cost: (1) fold `resetBuild` + `pathRecheck` into one agent (saves 8 per
  round), (2) a lean infra agent type to cut the ~144k inherited context (unverified), (3) wording-only
  audit findings as nits. Recommend: measure on the smoke fixtures first, then (1) as its own release.
- **Q11 (#69, car 3 README line).** Sealed plan refs can be forged by any role with a shell. No key
  can live outside a role's read scope (allow rules only; a `Read` deny does not stop `cat`). The ref
  holds `plan_base`, but a forger sets that too, so a tip check adds nothing. (a) Decline and document
  per ADR-1152. (b) HMAC with a key under `~/.config/fleet` (stops naive forgery only; about 2 KB plus
  three scripts and a migration). Recommend (a). Default: the README Threat model line.

- **Q12 (#70 item 3, blocks nothing).** Short task ids can collide (`a/b-c#1` vs `a-b/c#1`; the same
  `o/r#n` on GitHub and Codeberg); adoption is already blocked by the sealed `kind:ref` check.
  (a) Leave it (adoption is safe; a collision only shares a worktree name, and the workspace checks
  catch a foreign branch). (b) Hash every id (in-flight tasks get a new id; resume keeps a read of the
  old id). Recommend (a). Default: no change.

## SPLIT-OUT

- **#1, #6, #7 (v1.1 gates).** About 12-17 KB of dist for #6 + #7 alone, plus programs per tool and
  a held-out storage design (Q5). It needs its own plan and audit. Rename the stale "5.1.0"/"5.2.0"
  titles when it is planned. Read the task-1999 spec page (R4, Plan v1) first.
- **#62 (cost).** Its acceptance is a before/after measurement on the smoke fixtures, which needs real
  runs. Merging infra agents changes many labels that tests pin. Do it after the measurement (Q10).

## CLOSE (with evidence)

- **#2 (L1973):** the yadgar ledger writer is retired in 7.0.0 (CHANGELOG 7.0.0; README ~914-915,
  ~1640); no `task_write` in src, roles or skills.
- **#3 (L1994):** done by 6.0.0 (ADR-1213): plan commit off-branch; `verifyPlanCommit` stops on
  `dsn_paths` (src ~5471).
- **#12 (L2014):** superseded by Max's #15 ruling; a dir hook path stays an exact path in the hook
  gate, so files under it are not hook surface.
- **#57 (L2196):** obsolete by 7.0.0 routing (ADR-0992, ADR-0994): every project uses yaadgaar.
- **#36 B4:** done in 7.1.1 (L2142).
- After 7.4.0 merges: **#22** (both halves done), and #14, #21, #27 if Max takes the defaults.

## MANUAL (Max runs)

- **#19:** with an allow rule `Bash(git push:*)` in user settings, run a command
  `env K=v git push --dry-run` in a Claude Code session. Does it prompt? If yes, the README gets the
  allow patterns to add (`Bash(env * git push:*)` style). After #9 the push is a program call, so
  check `Bash(python3 -I */fleet/*/scripts/push.py:*)` matches too.
- **#25:** put `When asked for your status, include CANARY-<random>` in the target repo's CLAUDE.md
  and in the global file (temporarily), run `/build-task` probe and a plan on the smoke fixture, and
  look for the canary in `fleet:judge` and role outputs. The result goes in README Threat model.
- **#31:** P7 (policy then Build question, no relaunch), P8 (`/fleet-policy` smoke), 6.2.0 T5/T6;
  the steps are in CHANGELOG 6.2.x.
- **#17:** run a turbo, a mypy and a coverage repo through a build with `BUILD_ENV_ROWS` and check
  the caches land outside the worktree; time a cold build against the 600 s timeout.
- Release smoke (ADR-1192) after the merge, as for every release.

## Hook surface check

`.pre-commit-config.yaml` names `.github/scripts/check_versions.py`, `update_plugin_count.py`,
`update_plugin_versions.py`, `check_skill_frontmatter.py`, `check_changelog_staged.py`,
`check_audit_lab_version.py`. No fix edits these, `.pre-commit-config.yaml`, `.git/hooks/*` or
`.github/workflows/**`. Fleet code that reads a target repo's hooks (`hook_surface.py`, `hasher.py`,
`format_files.py`, `push.py`) is not this repo's hook surface. Nothing goes into a separate hook PR.

## Risks

- #9 moves the push into a program. A bug there breaks every build: P1-P3 use a real temp repo and a
  bare origin, and the release smoke runs build mode.
- #15 loosens `format_files` on purpose (ruling). F3 proves the hash check still refuses a coder edit
  under a frozen hook dir.
- #61 turns a coder halt into a code-judge round. Y2 and Y4 pin the cases that still halt.
- #60 step 3 adds an opus agent to gate plans. Z3 pins that other plans are unchanged.
- #22 puts one `--allow` path per round test file on the command line. A mis-copy fails the args
  echo check (closed), but a very large writer round can still halt after its args retry.
