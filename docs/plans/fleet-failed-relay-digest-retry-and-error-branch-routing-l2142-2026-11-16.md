# fleet: failed relay digest-retry and error-branch routing (L2142, yaadgaar #35)

Status: plan (fleet 7.1.1), re-plan round 1 after plan-audit `plan_defect`. Planner:
scope-and-plan, 2026-11-16. Base: master e72d456.

## Request

yaadgaar #35 (L2142), ruling by Max 2026-11-14: "Both a and b (Recommended)".

- (a) A relay that the agent marks `failed` and whose only defect is a mis-copied digest gets one
  digest retry, as a relay marked `ok` does. A second wrong digest stops the run with the generic
  "returned failed" halt.
- (b) When `pr_state`, `ci_watch`, `orch_scan`, `policy`, `precommit_ids` or `db_down` exit 0 with a
  non-null `error`, a relay marked `failed` reaches that program's own caller error branch. B4 of
  the brief: "each caller stops the run or reports the error as it does today for a status `ok`
  relay with that error".
- A `failed` relay whose args differ from the sent args still stops with "returned failed".
- No change to what any program prints.

## Premise check (HEAD e72d456)

Source references are `plugins/fleet/src/build-task-run.js` (src). The brief cites no file:line,
so no reference drifted.

- (a) reproduces. `digestOnlyMiss` (src:3467-3470) returns true only for `r.status === "ok"`.
  `digestRetry` (src:3482-3492) therefore never retries a `failed` relay, and `infra` (src:3768)
  halts `"<label> returned failed: ..."`.
- (b) reproduces for five of the six programs. `pr_state` has one more cause:
  - `ERROR_BRANCH_PROGRAMS` (src:3776) holds only `ruleset_surface` and `hook_surface`.
    `programErrorRelay` (src:3780-3784) returns false for all six programs.
  - `prState` (src:5784-5789) calls `infra(label, prompt, "PR")` with no `digest` and no `args`.
    So `programErrorRelay(r, undefined, undefined)` is false even with `pr_state` in the list, and
    no `pr_state` relay ever gets a digest retry. The digest id of `pr_state` is
    `pr_state:<mode>` (PROGRAM_KEYS, src:1761-1768). The list check must use the part before the
    first `:`.
  - `ci_watch` (src:6637), `orch_scan` (src:6850), `policy` (src:5649) and `precommit_ids`
    (src:5309-5316) already pass `digest` and `args` to `infra`.
- (b) does NOT reproduce for `db_down`. `dbTeardown` (src:8237-8254) calls neither `infra` nor
  `dispatch`. It calls `agentT` directly and reports `d.error` for every status: `"test database
<name> not confirmed removed (<error>); it ends by itself (...)"`. A `failed` relay with an error
  already gets the same report as an `ok` relay with that error. The teardown never stops the run
  (`tests/v4_s5.test.mjs:401`). Recommended: no code change for `db_down`; AC9 pins the
  behaviour (guards existing). See open decision D1.

## Design

One option per fork, with the reason:

1. `digestOnlyMiss(r, id)` accepts `r.status === "failed"` as well as `"ok"`. A `failed` relay also
   needs a digest that is a string (and, as for `ok`, of 64-hex form): a relay with no digest is a
   real program failure, not a mis-copy, and gets no retry. The other conditions stay
   (`programProblem` passes, `relayDigestOk` fails). Rejected: retry every `failed` relay that
   carries the shipped program block; that costs one agent on every real non-zero exit. This
   narrows B1 ("the same as for status ok") for one case: an `ok` relay with no digest gets the
   retry, a `failed` relay with no digest does not (AC10; listed under Non-goals).
2. The args retry (`am` in `digestRetry`) stays `ok`-only. A `failed` relay on other args halts
   "returned failed" (B5).
3. `ERROR_BRANCH_PROGRAMS` gains `pr_state`, `ci_watch`, `orch_scan`, `policy` and
   `precommit_ids`. `programErrorRelay` checks the list with the part of `digest` before the
   first `:`, keeps `progKeys(digest)` for the key list, and passes that base name to
   `relayDigestOk`. Its other conditions stay: status `failed`, a non-empty string `error`, a valid
   digest, args equal to the sent args.
4. `prState` routes without a retry. `pr_state` is a write step (merge, update, rerun, cleanup,
   fetch); `tests/v507_digest_relays.test.mjs:446` allows the digest retry on write steps only for
   `format_files` and `pr_test_block`, and a retried merge or rerun could act twice. So `prState`
   does NOT pass a digest to `infra`. It calls `dispatch(label, prompt, {schema: INFRA_SCHEMA,
phase: "PR"})` (no `digest`, so no retry), then applies the same two rules as `infra`:
   - status not `ok` and `programErrorRelay(r, "pr_state:" + args[0], args)` false: halt with the
     same text and status as `infra` (`<label> returned <status>: <reason>`);
   - a routed relay: the same gate line as `infra` (`<label>: the agent returned failed for the
program's own error; its error branch decides`), then `r` with status `ok`. Rejected: pass
     `digest` and `args` to `infra` (gives `pr_state` the write-step retry; the prototype failed
     the v507 test).
5. `infra` (src:3762-3774), `dispatch` and `digestRetry` (src:3482-3492) stay byte-identical
   (`infra` has 2597 `-w` hits and cannot be mapped). All logic change is in `digestOnlyMiss`,
   `ERROR_BRANCH_PROGRAMS`, `programErrorRelay` and `prState`.
6. Every caller's error branch is unchanged. A routed relay becomes status `ok` with the error
   kept; then the caller's own checks run (`requireProgram`, digest and args, then its `error`
   branch). Non-weakening proof per program (the 6.3.2 method): a `failed` relay with error E gives
   the same outcome (status, stop gate, reason or gate line) as the `ok` relay with error E.

Prototype (scratch worktree, then removed): steps 1-4 (12 changed src lines), the 7.1.1 bump with
every mirror of OB1, and OB5, built with `build-workflow.mjs` (esbuild check passed). Full suite:
1631 of 1631 pass. Each example of AC1-AC8 was run against the prototype (holds) and base (fails);
each AC9 and AC10 example holds on both. The build-time definitions scan (`changed_defs.py`) on
the prototype diff lists `FLEET_VERSION`, `digestOnlyMiss`, `ERROR_BRANCH_PROGRAMS`,
`programErrorRelay`, `prState`, `SCRIPTS_DIR` (harness), `READS` (v403), `realProbe` (v5_roles)
and `TPL` (v600_s3); all are mapped. Its unattributed test lines are in files listed in the scope
fence.

Per caller, the handling of a non-null error on an `ok` relay today, which a routed `failed`
relay now gets:

| program          | caller                 | non-null error (today, `ok` relay)                                                                 |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| pr_state ready   | `readyStep` src:6865   | stop: needs_human, gate ci                                                                         |
| pr_state merge   | `ciStep` src:6662      | stop: needs_human, gate merge                                                                      |
| pr_state update  | `ciStep` src:6675      | stop: needs_human, gate merge                                                                      |
| pr_state fetch   | `adoptUpdate` src:6747 | stop: needs_human, gate merge                                                                      |
| pr_state cleanup | src:6584               | report: warning gate line and a follow-up; the run goes on                                         |
| pr_state logs    | src:6698               | report: warning gate line; the classifier gets no log tail                                         |
| pr_state rerun   | src:6733               | report: warning gate line; no rerun                                                                |
| pr_state view    | resume src:6962        | report: the resume goes on to `ship`                                                               |
| ci_watch         | `ciStep` src:6637      | `CI unresolved`: stop (needs_human, gate ci) when a merge was expected, else report                |
| orch_scan        | `orchScan` src:6850    | the program sets every flag (fail closed): the PR stays a draft; `orchestrator PR: needs Max` stop |
| policy           | `policyStep` src:5649  | caps null: stop (needs_human, gate policy); caps set: report, strict default                       |
| precommit_ids    | auto gate src:5309     | stop: auto-confirm commands check failed (needs_human, gate commands)                              |
| db_down          | `dbTeardown` src:8237  | report (unchanged, see premise check)                                                              |

## Acceptance criteria (summary; the structured criteria are the spec)

- AC1 [e2e] a `failed` relay whose only defect is a wrong 64-hex digest gets one digest retry; the
  retry's result decides (ruleset_surface, orch_scan examples).
- AC2 [e2e] a second wrong digest stops with `<label> returned failed`, after exactly one
  `:digest-retry` call.
- AC3 [e2e] `pr_state` stop paths (ready, merge, update, fetch): a routed `failed` relay stops
  with the caller's own gate and text.
- AC4 [e2e] `pr_state` report paths (cleanup, logs, rerun, view): a routed `failed` relay gets the
  caller's own report. The view example names its labels: `infra:pr-tests:resume` and
  `infra:pr-stats` follow `infra:pr-view:resume`, and `infra:state:shipped:resume` is absent.
- AC5 [e2e] `ci_watch`: a routed `failed` relay gives `CI unresolved` (report or stop by policy).
- AC6 [e2e] `orch_scan`: a routed `failed` relay keeps the draft and stops `orchestrator PR: needs
Max`; a twice mis-copied one gets exactly one `infra:orch-scan:digest-retry`, then halts.
- AC7 [e2e] `policy`: a routed `failed` relay stops at gate policy (caps null) or applies the
  strict default (caps set).
- AC8 [e2e] `precommit_ids`: a routed `failed` relay fails the auto-confirm commands check.
- AC9 [e2e] (guards existing) `db_down`: a `failed` relay with an error is reported like an `ok` one.
- AC10 [e2e] (guards existing) a `failed` relay with other args, a null or empty error, or no
  digest, and a mis-copied `pr_state` relay, still halt `returned failed`, with no retry. The
  round-0 guard examples of AC3, AC5, AC7 and AC8 moved here (audit round 0).

Test files: one new file per criterion, `plugins/fleet/tests/v711_*.test.mjs`. They use
`tests/harness.mjs` (`happy`, `run`, `runOne`, `programOf`, `programSha`, `relayDigestOf`, `K`,
`inputsOf`). The harness fills `args` and `digest` only for `ok` relays, so each `failed` relay
carries its own `program`, `file_sha256`, `args` and `digest`, as `failedRsRelay` does in
`tests/v632_gh_rlimit.test.mjs:206-212`. Scenario templates: `tests/v600_s3.test.mjs` (CI, merge,
ready, orch scan, `watchOut`, `PERSONAL`), `tests/v600_s4.test.mjs:734` (`personal()`, resume
view), `tests/v600_s2.test.mjs:150` (policy), `tests/build_task_run.test.mjs:4371-4442`
(`AUTO`, `autoHappy`, `autoFail`), `tests/v4_s5.test.mjs:314-401` (`withDecl`, db down).

## STRIDE (trust boundary: the agent relay of a program's output)

No new input. The change widens what the script accepts from an existing relay.

- Tampering, spoofing: a `failed` relay is routed only when `programProblem` passes, the digest
  over the copied keys holds and the args equal the sent args (AC10). Unchanged from 6.3.2.
- Elevation of privilege (a gate weakened): each routed caller stops or reports exactly as for an
  `ok` relay with the same error (AC3-AC8).
- Denial of service: one extra agent per mis-copied `failed` relay, on the agent cap, never a
  second retry (AC2). A `failed` relay with no digest gets no retry (AC10).
- Repudiation, information disclosure: not applicable; no new log text or output channel.

## Repo obligations (coder steps)

- OB1 version bump 7.1.0 -> 7.1.1 (rule: `tests/v4_s2.test.mjs:419`, and the pre-commit hook
  `validate-plugin-versions`). Production: `FLEET_VERSION` (src:119), then the dist via OB3;
  `.claude-plugin/marketplace.json:134` (fleet `version`); root `README.md:160`
  (`### fleet (v7.1.1)`). Test mirrors (each `7.1.0` literal on these lines becomes `7.1.1`; the
  regex forms `7\.1\.0` become `7\.1\.1`):
  - `plugins/fleet/tests/harness.mjs:1085` (`SCRIPTS_DIR`; every harness run builds the preflight
    from it);
  - `plugins/fleet/tests/v4_s1.test.mjs:127, 331, 333-335, 337-341, 343, 347, 368, 377, 683,
697-699`;
  - `plugins/fleet/tests/v4_s3.test.mjs:555, 616`;
  - `plugins/fleet/tests/v5_roles.test.mjs:25` (inside `realProbe`), `:250`;
  - `plugins/fleet/tests/v600_s3.test.mjs:36` (`TPL`), `:112`;
  - `plugins/fleet/tests/build_task_run.test.mjs:211, 6285, 6983, 8693`;
  - `plugins/fleet/tests/v403_schema_types.test.mjs:1128`;
  - `plugins/fleet/tests/v622_fixes.test.mjs:617`.
    Comment lines that name 7.1.0 as the release of L2145 stay. The prototype found the last five
    files beyond the audit's list; with all of them the full suite passes.
- OB2 changelog: `plugins/fleet/CHANGELOG.md`, a new top `## [7.1.1] - 2026-11-16` entry (no
  `[Unreleased]`), with a Deploy note (update the plugin to 7.1.1, start a new session) and Fixed
  items for (a) and (b). Rule: pre-commit hook `check-changelog`, `tests/v4_s2.test.mjs:430`.
- OB3 generated dist: run `node plugins/fleet/scripts/build-workflow.mjs` after the src edit and
  commit `plugins/fleet/workflows/build-task-run.js` as built; `--check` must pass (ADR-1259,
  `tests/v701_build_parity.test.mjs`).
- OB4 docs: `plugins/fleet/README.md`, the digest-retry paragraph (lines 572-574): a relay marked
  failed whose only defect is its digest (a 64-hex string the relayed keys do not hash to) is
  retried too; a relay marked failed for its program's own `error` goes to the caller's error
  branch for `ruleset_surface`, `hook_surface`, `pr_state`, `ci_watch`, `orch_scan`, `policy` and
  `precommit_ids`; `pr_state` gets no retry (a write step).
- OB5 tests: the READS table of `tests/v403_schema_types.test.mjs` (`READS`, line 173). With the
  prototype the v403 check reported two lines: `r.digest string @ digestOnlyMiss: 2
occurrence(s), READS says 1` (set the entry to `[<its text>, 2]`) and `digest string @
programErrorRelay: no READS entry` (add `"digest string": "parsed: the script's own
PROGRAM_KEYS id, never an agent value"`). Map exactly what the check reports for the final code.
- OB6 docs: `plugins/fleet/docs/build-task-run-notes.md`, after the `before DIGEST_RETRY` block
  (lines 2142-2149, verbatim 5.0.9 history that says "status ok"): add one line below the closing
  fence, outside the quoted block, "7.1.1 (L2142): a relay marked failed whose only defect is a
  64-hex digest the relayed keys do not hash to gets the same one retry; a failed relay with no
  digest does not." The quoted 5.0.9 text stays verbatim (the file's own rule).

Test command: `npm test -- <paths>` (package.json `"test": "node --test"`; CI runs
`node --test plugins/*/tests/*.test.mjs`). Probe on `tests/v632_gh_rlimit.test.mjs`: exit 0.

## Non-goals

- No change to what any program prints, and no change to the program prompts. The prompts of
  `ruleset_surface` and `hook_surface` say "A non-null error with exit 0 is still status ok"; the
  other prompts keep their text.
- No change to any caller's error branch: a caller that reports today keeps reporting (D3).
- No code change for `db_down` (premise check; D1).
- `pr_body_block`, `pr_test_block` and `hash_diff` also print `error`; they are not in the
  ruling's list (D2).
- The orch_scan error stays a silent draft (L2139, yaadgaar #32, its own task).
- B1 narrowing: a `failed` relay with no digest gets no digest retry, unlike an `ok` relay with no
  digest (design step 1). A real non-zero exit prints no digest; retrying it costs an agent for
  nothing.
- No digest retry for `pr_state` (a write step, design step 4): a mis-copied `failed` `pr_state`
  relay still halts "returned failed", as today (AC10).
- The quoted 5.0.9 entries of `docs/build-task-run-notes.md` are not rewritten (OB6 adds a line
  after the entry instead).

## Open decisions

- D1 `db_down`: recommended no code change. It never goes through `infra`, and a `failed` relay
  already gets the error report. Alternative: add `db_down` to `ERROR_BRANCH_PROGRAMS` anyway; that
  entry is dead code. Max to confirm.
- D2 `pr_body_block` and `pr_test_block` (through `infra`) and `hash_diff` (through
  `softDispatch`) print an `error` key but are outside the ruling. Recommended: a follow-up task.
  Max to confirm.
- D3 "still stops the run" versus B4 "stops the run or reports". Some callers report a non-null
  error and do not stop: `pr_state` cleanup, logs, rerun and view; `ci_watch` when no merge was
  expected (policy merge never, a work repo, an IaC or orchestrator sign); `policy` when the caps
  are set (the strict default); `db_down`. Today a `failed` relay for those halts "returned
  failed"; after this plan it gets the caller's report, and the run can end `ok`. Recommended:
  follow B4 and keep each caller's branch as it is (the per-program proof is equality with the
  `ok` relay). Alternative: halt on a routed `failed` relay at the report-only callers; that makes
  a `failed` relay stricter than an `ok` relay with the same error. Max to confirm.

## Risks

- Existing tests that script a `failed` relay with a wrong digest now see one extra
  `:digest-retry` label. The harness replays the step's script, so the final halt is the same (the
  prototype full suite showed no such failure).
- `prState` repeats the two routing rules of `infra` (about 6 lines). A later change to `infra`'s
  halt text must be made in both places.
- A missed version mirror fails the whole suite (the harness `SCRIPTS_DIR` feeds every run). OB1
  lists every line the prototype had to change.

## Changes in this round (plan-audit round 0 findings)

- OB1: the test mirrors added (the audit's four files plus `build_task_run.test.mjs`,
  `v403_schema_types.test.mjs:1128`, `v622_fixes.test.mjs` and `v4_s3.test.mjs:616`,
  `v4_s1.test.mjs:377` found by the prototype); `SCRIPTS_DIR`, `READS`, `realProbe` and `TPL`
  mapped; the v4_s1 `dont_care` reasons corrected.
- AC3 ex 6, AC5 ex 3, AC7 ex 3, AC8 ex 2 moved to AC10 (guards existing, B5 quote). AC6 ex 3
  asserts exactly one `infra:orch-scan:digest-retry` label (fails at base).
- AC4 view example names its labels.
- OB6 for the notes doc; the B1 narrowing in Non-goals and plan_diff.
