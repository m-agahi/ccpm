# fleet 7.3.0: combined workflow-reliability batch (2026-11-17)

Status: plan only (scope-and-plan, no code). Base: `origin/master` a330420 (fleet 7.2.0).
Branch: `fleet/reliability-batch`. One PR, one release: fleet 7.2.0 -> 7.3.0.
Component: `plugins/fleet`.

## tldr

- Max ruled one PR and one release for every open fleet workflow-reliability task.
- 19 tasks were checked against a330420, plus L2197 (#58, dropped and merged into #40).
- 15 tasks are IN (some only in part). 3 tasks are PARK: #53, #52, #40. 1 task is SPLIT-OUT: #61.
  Parts of #60, #9 and #39 are SPLIT-OUT too, and one part of #9 is PARK.
- The build runs as 4 sequential cars on one branch. Car 1 bumps the version and opens the
  7.3.0 CHANGELOG entry. Cars 2-4 append to that entry.
- No fix touches the hook surface (`.pre-commit-config.yaml`, `.github/scripts/*`,
  `.github/workflows/**`, `.git/hooks/*`). No part of the batch has to go into a separate hook PR.

Line references are `src` = `plugins/fleet/src/build-task-run.js` at a330420, unless stated.
Edit `src` only. Regenerate the dist `plugins/fleet/workflows/build-task-run.js` with
`node plugins/fleet/scripts/build-workflow.mjs` (it also runs `gen.mjs`). Tests run the dist.

## Per-task table

| Task                      | Premise on a330420                                                                                                                                                                                                                                                                                                                                                                 | Class                                                                                       | Fix (short)                                                                                                                                 | ACs           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| #67                       | real: `dispatch`/`softDispatch` use `infraModel(label)` (src:3498, :3546). `label + ":digest-retry"` prefix-matches the same `INFRA_TIER` row (src:3475-3478). `RELAY_RETRY_MODEL` is read only at src:3267-3268                                                                                                                                                                   | IN                                                                                          | one model step up for every `:digest-retry`/`:args-retry` dispatch                                                                          | A1, A2        |
| #59                       | real, cause unproven: one refusal in r0w0; the rewrite round recovered. A writer that never writes leaves bad chunks, so `writeChunks` already retries (src:5196-5222). Both rewrite rounds run on the same model (sonnet)                                                                                                                                                         | IN (option 3 only)                                                                          | rewrite-round writers run one model step up. Option 1 cannot work for writes (ADR-1267 alt. (a)): only the script holds the payload         | A3            |
| #47 (L2187)               | (a) real: `writeStatePrompt` (src:3276-3286) and the park findings write (src:2505-2508) put every chunk in one agent. (b) real: an intact ref with a bad part relay ends in `changed()` "plan ref missing or changed" (src:6113, :6186). (c) real: after a first part-0 re-read (`reread = true`), the count re-read is skipped (src:6179). A null count stops at once (src:6177) | IN                                                                                          | (a) the parallel chunk writers of commit-plan, for state_write and park. (b) a relay-failure stop text. (c) one count re-read in every path | A4, A5, A6    |
| #42 (L2175)               | real: `loadParked` runs `softDispatch` with no `opts.digest` (src:2534), so `digestRetry` returns at once (src:3535). One haiku agent copies the whole draft (src:2515-2523). Any mismatch -> `ignore` (src:2542)                                                                                                                                                                  | IN                                                                                          | parked read in parts (meta + parts of 32000 code points with per-part sha256), with the load-ref part reader and digest ids                 | A7, A8        |
| #53 (L2188)               | real: unattended keeps `PARKED_UNREADABLE` as a blocker (src:5731-5733). The comment says "never an IaC path or a parked prior". The task title asks to relax a fail-closed blocker. A title is not a ruling                                                                                                                                                                       | IN (Max ruled Q1 (a), "Decide + log", 2026-11-17)                                           | unattended: an unreadable parked prior is decided and logged when plan-audit and the intent judge pass                                      | A26           |
| #52 (L2185)               | half real. The coder's dirty work blocks a re-run: workspace step 6 (src:2396) and the frozen-resume tree check (src:6391). The load-ref 87 KB mis-copy does NOT reproduce: 6.3.4 part reads (src:6127-6185, ADR-1267) fixed it                                                                                                                                                    | IN (Max ruled Q2 (b), 2026-11-17)                                                           | a frozen resume accepts a dirty tree when every frozen map still matches; the coder continues from it                                       | A27           |
| #9 (L2008)                | real, every form named is still there: chunk `printf > file` (src:2223, :2672). Exclude append with `$(...)` (src:2393). `cd && pre-commit` (src:2653). `mkdir && mv` (src:2691). Purge pipeline `n=$(find ...) && find ... \| xargs` (src:2959-2963). Push output redirect (src:3079)                                                                                             | IN (exclude, retire, purge, plan-doc pre-commit). PARK (chunk printf, Q4). SPLIT-OUT (push) | move four forms into programs                                                                                                               | A20, A21, A22 |
| #54 (L2189)               | real: seven roles tell the agent to build a throwaway copy with `mktemp -d`, `worktree add`, copy and delete loops (fleet-test-judge.md:44, plus code-judge, test-writer, plan-audit, sweep, scope-and-plan, pr-review)                                                                                                                                                            | IN                                                                                          | a `scratch_copy.py` program (make, run, remove). Role text names it                                                                         | A23           |
| #40 (L2166) + #58 (L2197) | real: `callers.py:141-153` counts raw `git grep -w -F` hits against `MAX_SYMBOL_HITS = 100` (src:173). A capped symbol is a finding that only a human clears (src:4708-4714)                                                                                                                                                                                                       | PARK                                                                                        | Q3 (options 1-4 of #58)                                                                                                                     | none          |
| #43 (L2177)               | real: `namesFor` takes the slug from `brief.title` (src:1505). The intake agent writes that title, so it varies from run to run. The layout key and parked dir hold the slug (src:3929)                                                                                                                                                                                            | IN                                                                                          | adopt the slug of an existing `fleet/<task_id>-*` branch (read-only program)                                                                | A11, A12      |
| #39 (L2162)               | (1) real: workspace step 5 reuses the worktree as it is and never fast-forwards (src:2395). (2) npm prefix walk-up: worktrees sit under the main checkout (`.claude/worktrees`). A worktree with no `package.json` finds the parent one                                                                                                                                            | IN (1). SPLIT-OUT (2)                                                                       | fast-forward a reused branch that has 0 own commits                                                                                         | A13           |
| #49 (L2182)               | real: an ok pr-opener with `pr_url`/`pr_number` null is allowed by the schema (src:480-481). The review step then skips (src:6728-6731). The body-v path loops into the same skip (`i--`, src:6779). The run can end ok while `state.review` still holds a `changes_requested` verdict                                                                                             | IN                                                                                          | ok opener with no PR -> needs_human. Review step with no PR -> needs_human, never a skip                                                    | A14           |
| #50 (L2183)               | real in code. Whether it fires is not shown: the guard reads `typeof sr.failed === "number"` (src:3865), so `"2"` counts as passing. `driftOf` checks top-level types only (src:3632-3646). A string arrives only if the runtime does not enforce the nested `JUDGE_SUITE` types (src:320); not verified                                                                           | IN (defense in depth)                                                                       | non-null non-0 = failing. `driftOf` checks the nested typed properties one level down                                                       | A15           |
| #41 (L2174)               | real: the update-branch path returns every blocking finding to the coder (src:6758-6767). The judge guard is off when `state.update` is set (src:3859)                                                                                                                                                                                                                             | IN                                                                                          | split pr_body_claim out on the update path (same routing as the main path). Guard on in update rounds                                       | A16, A17      |
| #32 (L2139)               | real: `readyStep` keeps the PR a draft on `o.error !== null` (src:7108-7109). The run ends ok with only a gate line. Brief B1-B4 (rulings 2026-11-14)                                                                                                                                                                                                                              | IN                                                                                          | one retry. Still an error: mark ready, no merge, no CI rerun, warning in the result and the PR body                                         | A18, A19      |
| #60                       | real: plan-audit has no shipped-vs-planned rule (roles/plan-audit.md:33, :45). The sweep runs only after the PR (src reviewStep)                                                                                                                                                                                                                                                   | IN (steps 1-2, role text). SPLIT-OUT (step 3, a pre-freeze sweep)                           | role rules only. The task's own acceptance needs step 3, so #60 stays open after 7.3.0                                                      | A25           |
| #61                       | real: blocking review findings always go to the coder (src:6766, :6792). The coder's needs_human halts through `roleFileProblem`/`requireOk` (src:7674-7681) before the code judge can return plan_wrong                                                                                                                                                                           | SPLIT-OUT                                                                                   | new role output (`test_conflict`, review `target: "plan"`) and a new route. Also open: `autoDecide("plan_wrong","ask")` with a PR open      | none          |
| #63                       | real: `briefProblem` refuses only absolute paths and `..` (src:4058-4062). Intake rule src:2451 says "a plan path that exists in the repo". The plan_path mismatch halts after the full planner call (src:4997-4998)                                                                                                                                                               | IN                                                                                          | refuse a dot-segment / `scratch` / `parked` plan_path before the planner. Intake rule says "tracked by git"                                 | A9, A10       |
| #65                       | real: fleet-intent-judge.md:50 lists "every entry of `plan_diff`" as a deviation. The process-item exemption (:40-44) covers only repo_obligations. G1 (src:5456) refuses an approved deviation with an empty `allowed_by`; keep G1                                                                                                                                                | IN                                                                                          | role text: intent judge, scope-and-plan.md:147, plan-audit.md:73                                                                            | A24           |
| L2197 (#58)               | dropped 2026-11-16, merged into #40                                                                                                                                                                                                                                                                                                                                                | none                                                                                        | see #40                                                                                                                                     | none          |

Counts: IN 15 (#67, #59, #47, #42, #9 part, #54, #43, #39 part, #49, #50, #41, #32, #60 part,
#63, #65). PARK 3 (#53, #52, #40), plus #9's chunk part (Q4). SPLIT-OUT 1 whole (#61), plus parts
of #60 (step 3), #9 (push) and #39 (npm prefix).

## Fix designs (IN)

### #67: retry model step-up

- Add `RETRY_UP = { haiku: "sonnet", sonnet: "opus", opus: "opus", fable: "fable" }` next to
  `RELAY_RETRY_MODEL` (src:115). Add `relayModel(label)`: `RETRY_RE.test(label)` (src:3527)
  -> `RETRY_UP[infraModel(label)]`, else `infraModel(label)`.
- `dispatch` (src:3498) and `softDispatch` (src:3546) call `relayModel(label)`.
- The `digestRetry` gate line (src:3542) names the retry model.
- The path-check relay retry (src:3267-3268) stays as it is.
- Advisory for Max (non-blocking): a sonnet relay's retry runs on opus. That costs more per
  retry. Retries are rare.

### #59: rewrite-round writers step up

- The `writeChunks` writers (src:5196-5204) of round >= 1 run on `RETRY_UP["sonnet"]`. Use a
  label rule in `relayModel`: `/:r[1-9][0-9]*w[0-9]+$/` on a chunk-writer label.
- The gate line names the model.
- No detection of `stop_reason: refusal`. Nothing read shows that the runtime exposes it.

### #47: bounded writes for state and park; load-ref relay text and count re-read

- (a) Lift `writeChunks` out of `commitPlanAndRef` (src:5195-5204) into a top-level
  `writeChunksParallel(prefix, chunkDir, c, ids, phaseName)`. Commit-plan keeps its labels
  (`infra:plan-chunks...`).
  - ADR-1267 bounds an agent at `CHUNKS_PER_WRITER` chunks (8 of 4000 characters). A payload of
    at most that many chunks stays inline, as today: no extra agent per save (see #62, cost).
    Only a payload of more chunks takes the parallel writers.
  - `saveState` (around src:6630) and `writeStatePrompt` (src:3276), over the bound: writers
    first (label `infra:state-chunks:<state label>:r<k>w<b>`). The state step then runs the
    program only, with no chunk text in its prompt (the shape of `commitPlanPrompt`, src:2679).
  - `state_write.py` exit 3 already prints `bad_chunks` (scripts/state_write.py:76-77). Rewrite
    rounds and the cap are the same as commit-plan (`MAX_CHUNK_RETRIES`).
  - Park findings (src:2505-2508, `parked.py write` exit 3 at scripts/parked.py:148-149): same,
    with labels `infra:park-chunks:r<k>w<b>`, and the same inline bound. `parkOnStop` must not
    halt inside `parallel()` thunks (ADR-1267). The park writers run inside `parkOnStop`'s
    try/catch, so a `reserve()` cap halt there would be swallowed as "park failed". Use the
    soft cap check of `softDispatch` (src:3548) for the park writers, and log a skipped writer.
  - Add new `INFRA_TIER` rows (sonnet).
- (b) In `buildFromRef`: when every relay's metadata check passed (`checked`, src:6120-6125),
  the ref itself is intact. A final join mismatch (src:6186) then stops `failed` with this text:
  "load-ref: the relayed parts do not join to ref_sha256 <sha> after the re-reads; the plan ref
  <name> is intact; re-run build with the same plan_ref". "plan ref missing or changed" stays
  only for `planRefMetaProblem` and the parse and shape checks (src:6187-6193).
- (c) A null `countOf(p0)` (src:6177) gets one part-0 re-read before it stops. The count re-read
  (src:6179-6185) runs once in every path, also after a first `reread`.
- Move the part reader (`partOk`, `countOf`, `readParts`, src:6129-6162) into one top-level
  helper. #42 uses the same helper.

### #42: parked read in parts

- `parked.py read` gets two modes (as built, car 2: the meta mode keeps the name `read` and its
  digest id `parked:read`; its `parked` object changed shape):
  - `read <scratch> <tip>` prints `{parked: {run, plan_path, payload_sha256, part_count} | null,
args}`.
  - `read-part <scratch> <run> <k>` prints `{part: {index, count, sha256}, chunks}` with
    32000-code-point parts.
- Payload = canonical JSON `{draft, findings}`, built at read time from the files that
  `parked.py read` already reads (`parked/<run>/<plan_path>` and `findings.json`). The on-disk
  park layout does not change, so a draft parked by 7.2.0 loads in 7.3.0.
- `loadParked` reads the meta with digest id `parked:meta`, so `digestRetry` runs, and with
  `args`. It reads the parts with the shared part reader. It checks the joined payload against
  `payload_sha256` from the digest-checked meta relay.
- Update `PROGRAM_SLOTS` (src:1692) and `PROGRAM_KEYS` (src:1742).
- Fail-closed stays: a payload that still mismatches after the re-reads -> `ignore(...)` ->
  `unreadable` -> the existing blocker.
- Related, not in the batch: #22 (L2029) asked for a digest retry on load-parked. This change
  covers it. Report it to Max to close.

### #63: no gitignored plan path in the brief

- `briefProblem` (src:4058-4062): refuse a `plan_path` that has any segment that starts with `.`,
  or a segment equal to `scratch` or `parked`.
  Reason text: `brief.plan_path <p> is not a tracked repo path (under a dot dir, scratch or parked)`.
- `briefProblem` already runs before the planner (src:5619). The stop is needs_human.
- Intake prompt rule (src:2451) and rule 5 (src:2457): "exists in the repo" becomes
  "is tracked by git (`git -C <repo> ls-files --error-unmatch <path>` exits 0) and is not under
  `.claude/` or a `scratch/` dir".

### #43: stable branch slug

- New read-only program `scripts/fleet_branch.py <repo> <task_id>`. It lists the slugs of
  `refs/heads/fleet/<task_id>-*`, with program and digest.
- The program reads local heads only (`refs/heads/fleet/<task_id>-*`). It runs before the
  workspace `fetch`, so remote-tracking refs can be stale. A remote-only branch of the task is
  not seen; the workspace step 5 still finds it by its full name.
- Plan mode, after intake and before `layout(names, repo)` (src:3929, call near src:5625):
  dispatch `infra:fleet-branch` (haiku, digest id `fleet_branch`, args).
  - Exactly one distinct slug: `names.slug` = that slug. Gate: "branch slug <s> adopted from
    existing fleet/<id>-<s> (intake gave <d>)".
  - None: the derived slug.
  - Several, and the derived slug is one of them: the derived slug.
  - Several, and the derived slug is not one of them: needs_human, with the branch list.
- Only for task ids that do not start with `t` (text input already hashes its raw text).
- The saved ref check `r.branch === "fleet/" + task_id + "-" + slug` (src:5843) still holds.

### #39 (1): fast-forward a reused branch with no own commits

- Plan mode only. `workspaceStep` also runs in build mode (src:6072), where the reused worktree
  sits clean at the audited `plan_base` with 0 own commits (the plan commit is off-branch). A
  fast-forward there would move HEAD off `plan_base`. So the plan path alone passes a new input
  `ff_reused: true`; build mode never passes it.
- Workspace step 5 (src:2395): after a reuse or an `add` of an existing local branch, and only
  when `ff_reused` is true, add this rule. When
  `git -C <main_worktree> merge-base --is-ancestor HEAD origin/<default_branch>` exits 0 and
  `git -C <main_worktree> status --porcelain` is empty, run
  `git -C <main_worktree> -c core.hooksPath=/dev/null merge --ff-only origin/<default_branch>`.
  Return `fast_forwarded: true|false`.
- Step 8 (base_ref) already runs after step 5.
- `workspaceStep` (src:4028) logs "fast-forwarded to origin/<default>" when the flag is true.

### #53: unattended decides an unreadable parked prior (Max ruled Q1 (a), "Decide + log")

- Under unattended (`ua`), `PARKED_UNREADABLE` is no longer kept out of `decided` (src:5773). It is
  logged with `autoDecide("default-blocker", "decided", ...)`, and its reason names that plan-audit
  passed and that the intent judge rules on it.
- The early `autoFailResult` for `parkedBad` (src:5813) runs only without unattended.
- The auto gates (intent judge included) still run. An intent judge that refuses still stops.
- Without unattended, nothing changes (confirm "default" asks; confirm "auto" fails closed).

### #52: a frozen resume accepts the coder's dirty tree (Max ruled Q2 (b))

- The frozen-resume check (src:6432-6451) computes `freeze_digest` over the freeze ref's tree
  (`refTree`), not the worktree tree. The digest holds the frozen maps (`mapsDigest`, the fleet
  refs left out), so a match proves every frozen file (tests and frozen config) still has its frozen
  hash.
- A worktree tree that differs from `refTree` no longer refuses on its own. The gate line names the
  dirty tree. The coder round runs with `freeze_tree` = `refTree` and continues from the dirty
  worktree.
- Still refused: HEAD off `plan_base`, no freeze ref, suspicious paths, a re-frozen digest, and any
  frozen-map mismatch (the digest differs). A stop before the freeze returns no `freeze_digest`, so
  a dirty tree there is refused as today.

### Car-1 follow-up: post-PR state chunk writers skip the agent cap (Max ruled "Exempt writers")

- The chunk writers of a run-state that `saveState` writes after the PR is open are tail agents,
  as `infra:state:shipped` is (`TAIL_RE`). "After the PR is open" is the PR state at `saveState`
  (`pr` with a `pr_number`, also on a resume from the run-state), not the state label: a
  review-fix round's `committed` and `pushed` states are post-PR too. `saveState` sets
  `state.tailWriters` around its writers and rewrite rounds; `tailWriter(label)` is true for an
  `infra:state-chunks:` label while it is set. `writeChunksParallel` reserves no slot for such a
  writer, and `softDispatch` counts it in `state.tail` and runs it past the cap.
- The pre-PR state writers keep the cap. The `infra:state:<label>` program steps keep their own
  rule (only `infra:state:shipped` is tail): open for Max, since the ruling exempted the writers.

### #49: no silent skip of the review

- `openPr`, after `requireOk` (src:6524): an ok result with `pr_url` or `pr_number` null ->
  `halt("needs_human", "pr-opener returned ok with no PR (pr_url <x>, pr_number <y>); check the
branch on the forge", "role")`.
- Review step (src:6727-6731): no PR -> `halt("needs_human", ..., "review")`, not `continue`.
- The builder updates every existing test that pins "review skipped: no PR" and says so in the
  CHANGELOG.

### #50: judge guard counts any non-0 as failing

- src:3865: `failing = !(Number.isInteger(sr.exit_code) && sr.exit_code === 0) ||
(sr.failed != null && sr.failed !== 0) || (sr.errors != null && sr.errors !== 0)`.
- `driftOf` (src:3632): for a required key whose `STRICT` prop has `properties`, and a value that
  is an object, check each typed nested property with `typeMatches`. Drift detail:
  `<key>.<sub> type: got <t>`.

### #41: update-branch path routes pr_body_claim like the main path

- src:6758-6767: in the update branch, split `bodyF`/`codeF` as at src:6769-6770. The split runs
  before `updRefusal()` (src:6761). A body-only update review runs no code round, so the R1-R5
  checks do not stop it. `updRefusal()` still runs when `codeF` is not empty.
  - `codeF` empty: take the body-only branch (src:6773-6781). The `MAX_BODY_FIXES` cap and the
    own slot stay the same.
  - Else return only `codeF` with `update: true`, and set `state.bodyPending = bodyF`.
- `judged` guard (src:3859): drop `&& !state.update`.
- Known edge from 6.3.3: a guard-made approve with no coder change finds nothing to commit. With
  the split, tagged findings no longer reach an update round's coder. Add one test that pins the
  edge result. The commit step's "nothing to commit" must stop loudly, never end ok silently.

### #32: orch_scan error -> one retry, then ready + warn

- `orchScan` (in shipSteps, near src:7090): on `o.error !== null`, re-run once (tag `retry`).
  Use the second result.
- Still an error:
  - Push `{gate: "orch_scan", error}` to `state.warnings`.
  - `readyStep` (src:7108): `keptDraft` = orchestrator || iac_repo || apply_on_merge. An error
    alone no longer keeps the draft, so the PR is marked ready.
  - Merge stays blocked: `judge()` already counts `o.error !== null` as IaC (src:6852). The CI
    rerun stays blocked by the same IaC sign (src:6971).
  - The PR body: rewrite the script-written test block once
    (`prTestsStep("infra:pr-tests:scan-warning", ...)`) with one more line:
    "Orchestrator/IaC scan error: <error>. Next step: re-run the scan with /build-task <plan_ref>
    or check the PR by hand before merge."
- `finish()` (src:3873) gets `warnings: state.warnings || []`.
- Dependency: the brief says #33 (L2140, PRs open ready) ships in the same release. Max added #33
  to 7.3.0 (Q6). With #33 an error no longer has a draft to keep: the PR opened ready.
- The retry runs inside `orchScan` (every scan: ready, merge, u1). Only the `readyStep` scan
  writes the warning to `state.warnings` and the PR body. The warning line lives in
  `testsBlock`, so a later test-block rewrite (a CI-fix round) keeps it.

### #33 (L2140): the PR opens ready; draft only with `merge_after` or policy `pr_ready: false`

- Planner output `merge_after` (string or null, optional: not in `REQUIRED_ON_OK`). The planner
  sets it only when the task, brief or ticket text says the change must not merge before a
  condition or another PR. The script seals it in `plan_facts.merge_after`. An older plan_ref
  has none: null, the PR opens ready.
- The script decides `draft = merge_after != null || policy pr_ready false` and sends `draft`
  and `merge_after` to the pr-opener. The role creates with `--draft` only when `draft` is true,
  verifies `isDraft == draft`, and names `merge_after` verbatim in the body.
- `readyStep`: a draft run keeps the draft (gate line, finish reason names the condition). Else
  `pr_state ready` runs as the check that the PR is ready at the approved sha (an already-ready
  PR gives `was_draft: false`). Orchestrator, IaC and scan-error signs no longer keep a draft;
  they still block the merge and the CI rerun (`judge()` in `ciStep`, unchanged).
- A branch Max pushed himself (`iacTouched`, ADR-1175) still stops at the ready step; the reason
  no longer says "Max marks it ready" (the PR is already ready).
- SKILL.md, README and the pr-opener role say the PR opens ready.

### Car-3 follow-up: post-PR `infra:state:*` program steps skip the agent cap

- `tailWriter(label)` is also true for `infra:state:{pr_open,reviewed,written_back,committed,
pushed}` labels (inline writer, rewrite and digest-retry labels included) while
  `state.tailWriters` is set. `saveState` sets the flag from `pr && pr.pr_number != null` before
  its first writer (inline or chunked) and clears it in a `finally`. `dispatch` counts such a
  label in `state.tail` once (`TAIL_RE || tailWriter`) before `reserve`. `infra:state:shipped`
  stays on `TAIL_RE` only. Pre-PR state writes keep the cap.

### #65: intent judge and bookkeeping plan_diff items

- fleet-intent-judge.md, Deviations: a `plan_diff` entry is not a deviation when it only
  restates a verified process obligation (OBn), a `changed_symbols` update, `est_diff_lines`, or
  a test-example refinement of a criterion that is already allowed. Leave such items out.
  `approve` always has a non-empty verbatim `allowed_by`. A repo rule is never an allowance.
- scope-and-plan.md:147 and plan-audit.md:73: in a re-plan round, `plan_diff` stays relative to
  the ingested plan (or `"new plan"` plus the intended narrowings against the brief). It never
  lists round-to-round changes.
- G1 at src:5456 does not change.

### #60 (steps 1-2): gate differential rules

- plan-audit.md "Hunt specifically for": when the plan changes a gate, validator or exemption,
  build a shipped-vs-planned table. Its rows are the criteria examples plus 2-3 known-bad inputs.
  A row where the shipped gate refuses, the planned gate accepts, and no Open decision cites the
  brief -> `plan_defect`.
- scope-and-plan.md: a boundary example that makes a gate accept an input the shipped gate
  refuses must be an Open decision.

### #54: a program for the throwaway copy

- New `scripts/scratch_copy.py`:
  - `make <worktree> <scratch_dir>`: `worktree add --detach` with hooks off. Then copy every
    changed and untracked path, and delete every deleted path. Prints `{tmp, copied, deleted}`.
  - `run <tmp> <argv json>`: runs argv with `cwd=<tmp>`. The rlimit is lifted for children, as
    in format_files.py:79-80. Prints `{exit_code, tail}`.
  - `remove <worktree> <tmp>`: `worktree remove --force`, then `prune`.
  - It refuses a `<tmp>` outside `<scratch_dir>`.
- The seven roles that build copies (fleet-test-judge.md:44, fleet-code-judge, fleet-test-writer,
  plan-audit, gate-change-nonweakening-sweep, scope-and-plan, pr-review): replace the shell steps
  with the three program commands. The workflow passes the command prefix as a role input
  (`scratch_copy_cmd`).
- Stub edits stay Edit-tool edits inside `<tmp>`.

### #9 (IN part): four shell forms into programs

- Exclude append (src:2393): new `scripts/exclude_add.py <repo> <pattern>...`. It finds the
  common git dir itself and appends only the missing lines.
- Retire (src:2691): `parked.py retire <dir> <used>` (an `mkdir -p` and a no-clobber move in
  Python).
- Purge (src:2959-2963): new `scripts/purge.py <worktree>`. It uses `os.walk` with the same prune
  list and prints `{purged}` with program and digest.
- Plan-doc pre-commit (src:2653): a `format_files.py` call on the plan doc when its contract fits
  (fixer reruns, rlimit lift for children). Else a `plan` mode in format_files.py. The builder
  checks this against format_files.py before the change.
- Each new command has the same `progCmd` shape as the shipped programs, so the same permission
  allow rules match. Check this in the A20 test.

## Acceptance criteria

New tests go in `plugins/fleet/tests/v730_<topic>.test.mjs` and use `harness.mjs`. The template
for scripted relays is `v711_failed_digest_retry.test.mjs`. The harness records each call's
`opts.model` (harness.mjs:320).

- **A1** (#67, `v730_retry_model.test.mjs`). Given an `infra:callers` relay (tier haiku) whose
  digest does not match, When `digestRetry` dispatches the retry, Then the call
  `infra:callers:digest-retry` has `opts.model === "sonnet"`, the first call has `"haiku"`, and
  the gate line names "sonnet".
- **A2** (#67, same file). Given an `infra:pr-tests` relay (tier sonnet) with an args mismatch,
  When the args retry runs, Then `infra:pr-tests:args-retry` has `opts.model === "opus"`. Given
  an `infra:path-check:<site>:relay-retry`, Then its model is still `RELAY_RETRY_MODEL`.
- **A3** (#59, `v730_chunk_rewrite_model.test.mjs`). Given commit-plan returns
  `{status:"failed", bad_chunks:[0]}` once (writer r0w0 returned null), When round 1 runs, Then
  `infra:plan-chunks:r1w0` has `opts.model === "opus"`, `r0w0` has `"sonnet"`, and the plan
  commit then seals.
- **A4** (#47a, `v730_state_chunks.test.mjs`). Given a run-state JSON of 3 chunks, When
  `saveState` runs, Then no `infra:state-chunks` call runs and the state prompt holds the chunks
  (as today). Given a run-state JSON of 9 or more chunks, Then `infra:state-chunks:...:r0w0` and
  `...:r0w1` write the chunks, the `infra:state:<label>` prompt holds no chunk text, and a
  `state_write` exit-3 result `bad_chunks:[1]` sends only chunk 1 to `...:r1w0`. A third bad
  round halts `failed`. Same for park findings of 9 or more chunks: `infra:park-chunks:r0w0`; a
  park writer skipped by the agent cap logs a gate line and never halts.
- **A5** (#47b, `v730_load_ref_relay.test.mjs`). Given an intact ref whose metadata relays pass
  but whose part 1 is mis-copied on every read, When build loads it, Then status `failed`, the
  reason contains "the plan ref" and "is intact; re-run build with the same plan_ref", and the
  reason does not contain "missing or changed". Control: a meta relay whose `ref_sha256` differs
  -> needs_human "plan ref missing or changed".
- **A6** (#47c, same file). Given a part-0 relay with `count` 1 (true count 2) after a first
  part-0 re-read, When the joined content mismatches, Then one more part-0 read runs
  (`infra:load-ref:retry` label count 2), and with the true count the ref loads. Given a part-0
  relay with `count` null once, Then one re-read runs before any stop.
- **A7** (#42, `v730_parked_parts.test.mjs`). Given a parked draft of 70000 code points, When plan
  mode loads it, Then 3 part reads run (`infra:load-parked:p0..p2`), the planner input
  `prior_draft.text` equals the draft, and no "parked draft ignored" gate is logged.
- **A8** (#42, same file). Given a `parked:meta` relay with a bad digest first, Then
  `infra:load-parked:digest-retry` runs and the draft loads. Given part 1 mis-copied twice, Then
  "parked draft ignored" is logged and the unreadable blocker is set (fail closed, no change).
  Given a draft parked by 7.2.0 (the same on-disk files), Then it loads.
- **A9** (#63, `v730_intake_parked_path.test.mjs`). Given an intake brief with `plan_path`
  `.claude/worktrees/fleet-x/scratch/parked/123/docs/plans/p.md`, When plan mode runs, Then
  status `needs_human`, the reason matches `/plan_path/`, and no `role:scope-and-plan` call ran.
- **A10** (#63, same file). Given `plan_path` `docs/plans/x.md`, Then the planner runs with that
  plan. Given `docs/scratch/p.md`, Then needs_human. Given `.github/p.md`, Then needs_human.
- **A11** (#43, `v730_branch_slug.test.mjs`). Given `fleet_branch` reports one slug
  `intake-branch-slug-drifts` for `y43`, and intake gives a title that slugs to
  `intake-slug-drift`, When plan mode runs, Then the workspace input `branch` is
  `fleet/y43-intake-branch-slug-drifts` and the gate log contains "adopted".
- **A12** (#43, same file). Given slugs `a` and `b`, and the derived slug `c`, Then needs_human
  listing both branches. Given no slug, Then the derived slug. Given a text input (`t...` id),
  Then no `infra:fleet-branch` call.
- **A13** (#39, `v730_workspace_ff.test.mjs`). Given the workspace prompt, Then it contains
  `merge-base --is-ancestor HEAD origin/<default_branch>` and
  `merge --ff-only origin/<default_branch>` in plan mode. Given the build-mode workspace prompt
  (plain build and `freeze_digest` resume), Then it contains neither.
  Given a workspace relay with `fast_forwarded: true`, Then the gate log contains
  "fast-forwarded".
- **A14** (#49, `v730_review_no_pr.test.mjs`). Given the second pr-opener call (`:p2`) returns ok
  with `pr_url` null and `pr_number` null, When ship runs, Then status `needs_human`, stop_gate
  `role`, and no `role:pr-review` call follows. Given the body-v opener returns the same, Then
  needs_human. Given a review step reached with no PR, Then needs_human with stop_gate `review`.
- **A15** (#50, `v730_judge_guard_types.test.mjs`). Given a code judge `fix_code` whose only
  finding is a tagged pr_body_claim and `suite_result {exit_code:0, failed:"2", errors:0}`, When
  `judged` runs, Then the verdict is not changed to approve, and the gate log has "contract drift
  (suite_result.failed type: got string); retried once". Given `failed: 0` and `errors: null`,
  Then the guard converts to approve, as today.
- **A16** (#41, `v730_update_body_claim.test.mjs`). Given an update-branch re-review with blocking
  `[R1 pr_body_claim, R2 code]`, When it is routed, Then the coder's `routed_findings` hold R2
  only, and the next pr-opener call has `body_findings` `[R1]`.
- **A17** (#41, same file). Given an update-branch re-review with only R1 pr_body_claim, Then no
  coder round runs, one pr-opener body update and one re-review run, and the code-round count
  does not change. Given an update round where the judge returns `fix_code` with only a tagged
  finding and a suite with exit 0, Then the verdict becomes approve.
- **A18** (#32, `v730_orch_scan_warn.test.mjs`). Brief B1: given `orch_scan` returns an error once,
  then a clean result, Then the clean result is used and `result.warnings` is `[]`.
- **A19** (#32, same file). Brief B2-B4: given `orch_scan` returns "truncated tree" twice, Then
  `infra:pr-ready` runs (the PR is not left a draft), no `infra:pr-merge` and no
  `infra:ci-rerun` call runs, `result.warnings` holds one entry whose error contains
  "truncated tree", and the `infra:pr-tests:scan-warning` block text contains the error and the
  "Next step:" line.
- **A20** (#9, `v730_shell_programs.test.mjs`). Given the workspace, commit-plan, purge and
  plan-format prompts, Then none contains `$(`, `&&`, `| xargs` or `cd `. Each names
  `exclude_add.py`, `parked.py retire`, `purge.py` or `format_files.py` through `progCmd`.
- **A21** (#9, same file). Given `purge.py` run on a temp tree with `a/__pycache__/x.pyc`,
  `b.pyc`, `.venv/c.pyc` and `.claude/worktrees/d/__pycache__`, Then it deletes the first two,
  keeps the other two, and prints `purged` 2.
- **A22** (#9, same file). Given `exclude_add.py` run twice with `.claude/worktrees/`, Then
  `info/exclude` holds the line once.
- **A23** (#54, `v730_scratch_copy.test.mjs`). Given a temp repo with one modified, one untracked
  and one deleted file, When `scratch_copy.py make` runs, Then `<tmp>` shows the same three
  states, and `<tmp>` is under `<scratch_dir>`. `run` returns the exit code of `false` as 1.
  `remove` leaves `git worktree list` without `<tmp>`. The test-judge role text contains
  "scratch_copy" and not "mktemp".
- **A24** (#65, `v730_role_text.test.mjs`). Given the intent-judge role file, Then it contains the
  bookkeeping exemption sentence, and scope-and-plan.md and plan-audit.md contain the
  "relative to the ingested plan" re-plan rule. Given a judge result with an approved deviation
  and `allowed_by: ""`, When the auto gates run, Then G1 still refuses with "has no allowed_by".
- **A25** (#60, same file). Given plan-audit.md, Then it contains the shipped-vs-planned table
  rule with `plan_defect`. Given scope-and-plan.md, Then it contains the gate-boundary Open
  decision rule.

- **A26** (#53, `v730_parked_unattended.test.mjs`). Given unattended (policy `unattended`) and a
  parked prior whose findings are unparseable, When plan-audit passes and the intent judge
  approves, Then the run builds (status `ok`), no "unattended: asking Max" gate is logged, and
  `auto_decisions` holds one entry `{gate: "default-blocker", decision: "decided"}` whose reason
  starts with "parked prior unreadable (fail closed)". Given the same with the intent judge
  refusing, Then the run stops with `failed_check` "intent" and builds nothing. Given no unattended
  and confirm "auto", Then the result is the `autoFailResult` with "parked prior unreadable", as
  before.
- **A27** (#52, `v730_frozen_dirty.test.mjs`). Given a coder stop after the freeze and a re-run
  with its `freeze_digest`, When the worktree tree is `K1` (not the freeze tree `T1`) and every
  frozen map is unchanged, Then the build resumes at the coder (`resumed_at` "frozen"), the coder's
  `freeze_tree` is `T1`, and the gate log names the dirty tree. Given the tree `T9` and one frozen
  test file changed, Then needs_human with stop_gate `resume` and no role call.
- **A28** (car-1 follow-up, `v730_tail_writers.test.mjs`). Given `state.tailWriters` true, Then
  `tailWriter` is true for `infra:state-chunks:shipped:r0w0`, `:committed:r2:r1w0`,
  `:pushed:p2:r0w0` and `:reviewed:v1:r0w0`, and false for `infra:plan-chunks:r0w0`,
  `infra:park-chunks:r0w0`, `infra:yaadgaar-writeback:ci` and `infra:state:shipped`. Given it
  false, Then false for every state writer. Given `saveState`, Then it sets the flag from
  `pr && pr.pr_number != null` before the writers and clears it in a `finally` after the rewrite
  rounds. Given `softDispatch`, Then it counts a tail writer in `state.tail` before its cap check,
  and `writeChunksParallel` reserves no slot for one.

- **A29** (#33, `v730_pr_ready.test.mjs`). Given a plan with no `merge_after` and the default
  policy, When ship runs, Then the first pr-opener call has `draft: false` and `merge_after: null`,
  `infra:pr-ready` runs, and the result reason starts with "PR ready for review". Given an
  orchestrator scan sign (`orchestrator: true`), Then `draft: false`, `infra:pr-ready` runs, and
  no `infra:pr-merge` call runs. Given `merge_after` "after yadgarhq/flux#12 merges" in the plan,
  Then the pr-opener gets `draft: true` and that `merge_after`, no `infra:pr-ready` call runs, the
  gate log has "merge_after: after yadgarhq/flux#12 merges", and the result reason contains
  "after yadgarhq/flux#12 merges". Given policy `pr_ready: false`, Then `draft: true` and no
  `infra:pr-ready` call runs.
- **A30** (#33, same file). Given the pr-opener role file, Then the create command reads
  `--draft` only when `draft` is true and the verify line checks `isDraft` against `draft`; the
  scope-and-plan role names `merge_after`. Given SKILL.md, Then it does not contain "Never mark it
  ready" and states that the PR opens ready unless `merge_after` or policy `pr_ready: false`.
- **A31** (car-3 follow-up, `v730_tail_writers.test.mjs`). Given `state.tailWriters` true, Then
  `tailWriter` is true for `infra:state:pr_open:p1`, `infra:state:reviewed:v2`,
  `infra:state:written_back`, `infra:state:committed:r2`, `infra:state:pushed:p2` and
  `infra:state:committed:r2:rewrite-1`, and false for `infra:state:shipped`; false for all of them
  with the flag false. Given `dispatch`, Then it counts `TAIL_RE || tailWriter` once in
  `state.tail` before `reserve`. Given `saveState`, Then the flag is set before the inline
  writer's `infra(` call.
- **A32** (#41 edge, `v730_update_body_claim.test.mjs`). Given an update round whose commit step
  returns `commit_result` "nothing_to_commit", Then the run status is `failed` (never `ok`). A
  resumed update record (no adopted update this run) with only pr_body_claim findings takes the
  body-only route too: a body update runs no code round, so the earlier-run refusal does not
  apply.

Test command: `node --test 'plugins/fleet/tests/*.test.mjs'` (README:1777). Dist and tables:
`node plugins/fleet/scripts/build-workflow.mjs`, then `node plugins/fleet/scripts/gen.mjs --check`.
No python test suite exists in `plugins/fleet/tests` (all `.test.mjs`). Python programs are
tested through the harness.

## Overlap map

| Function or file                                                                                   | Tasks                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `dispatch`, `softDispatch`, `digestRetry`, `relayModel` (src:3497-3555)                            | #67, #59, #42 (digest ids), #43 (new label) |
| `writeChunks` -> `writeChunksParallel` (src:5195-5222)                                             | #59, #47a                                   |
| `saveState`, `writeStatePrompt` (src:3276, ~6630)                                                  | #47a                                        |
| `parkPlanPrompt`, `parkOnStop` (src:2497-2512, 5679-5715)                                          | #47a, #42                                   |
| load-ref part reader (src:6127-6186) -> shared helper                                              | #47b/c, #42                                 |
| `loadParked`, `parked.py`                                                                          | #42, #9 (retire mode), #53 if ruled         |
| `briefProblem`, intake prompt (src:4049, :2451-2457)                                               | #63                                         |
| `namesFor`, `layout` (src:1483, :3928)                                                             | #43                                         |
| `workspacePrompt`, `workspaceStep` (src:2382, :4013)                                               | #39, #9 (exclude)                           |
| `commitPlanPrompt` retire (src:2691), `formatPlanPrompt` (src:2648), `purgePrompt` (src:3038)      | #9                                          |
| `openPr` (src:~6490)                                                                               | #49, #32 (test-block warning)               |
| shipSteps review branch (src:6727-6795)                                                            | #49, #41                                    |
| `judged` guard (src:3859-3870), `driftOf` (src:3632)                                               | #50, #41                                    |
| `orchScan`, `readyStep`, `ciStep`, `finish` (src:7090-7115, 6842, 3873)                            | #32                                         |
| roles: intent-judge, scope-and-plan, plan-audit + 4 copy roles; `ROLE_SHA256`                      | #65, #60, #54                               |
| `INFRA_TIER`, `PROGRAM_KEYS`, `PROGRAM_SLOTS`, program sha table (src:45-114, 1555+, 1692+, 1742+) | every car                                   |

## Car order

One builder per car, sequential, same branch. Each car: red tests first, then code, then regenerate
the dist and the tables, then the full suite green, then one commit with `CHANGELOG.md` staged.

1. **Car 1: relay core.** #67, #59, #47 (a, b, c). Car 1 also does the version bump to 7.3.0
   (pins below) and opens the `7.3.0` CHANGELOG entry. It extracts `writeChunksParallel` and the
   shared part reader that car 2 uses.
2. **Car 2: plan intake, parked, workspace.** #42, #63, #43, #39 (1). It uses car 1's part reader.
   It adds the `fleet_branch.py` and `parked.py` changes. (#53 joins here only if Max rules Q1.)
3. **Car 3: ship and judge.** #50, #49, #41, #32, #33 (Max added it, Q6), and the car-2 cap
   follow-up for the post-PR `infra:state:*` steps. All touch `judged` or shipSteps.
4. **Car 4: roles and shell programs.** #65, #60 (1-2), #54, #9 (IN part). Every role edit is in
   this car, so `ROLE_SHA256` changes once. It adds `scratch_copy.py`, `exclude_add.py` and
   `purge.py`.

Every car appends to the one 7.3.0 CHANGELOG entry. No car changes the version again.

## Version-bump pins (7.2.0 -> 7.3.0, car 1)

Change only these real pins. Test titles that start with "7.2.0 AC..." are history: leave them.

- `plugins/fleet/src/build-task-run.js:119` `FLEET_VERSION`.
- `.claude-plugin/marketplace.json:134` `"version"`. Then re-stage what the
  `update-plugin-versions` hook writes into root `README.md:160`. Do not hand-edit that line.
- `plugins/fleet/tests/harness.mjs:1085` `SCRIPTS_DIR`.
- `plugins/fleet/tests/v4_s1.test.mjs:127`, `:331-347`, `:368`, `:683-699`.
- `plugins/fleet/tests/v4_s3.test.mjs:555`.
- `plugins/fleet/tests/v5_roles.test.mjs:25`, `:250`.
- `plugins/fleet/tests/v600_s3.test.mjs:36`, `:112`.
- `plugins/fleet/CHANGELOG.md`: new `7.3.0` entry at the top.
- `plugins/fleet/.claude-plugin/plugin.json` has no version field at a330420; nothing to bump
  there.
- Run `git grep -n "7\.2\.0" -- ':!*CHANGELOG.md' ':!docs/plans'` after the bump. Any hit that is
  not a test title is a missed pin.

## PARK questions (for Max)

- **Q1 (#53).** The workflow keeps an unreadable parked prior as a blocker under unattended
  (src:5731-5733: "never an IaC path or a parked prior"). Under unattended, may an unreadable
  parked prior be auto-decided and logged in `auto_decisions` when plan-audit and the intent
  judge both pass? Options: (a) yes, decide and log it. (b) no, keep asking. Note: #42 makes an
  unreadable prior much rarer.
- **Q2 (#52).** A coder `needs_human` leaves uncommitted code. A re-run refuses the dirty worktree,
  and a frozen resume refuses a tree that is not the freeze tree. Which recovery?
  (a) On a coder stop, the script saves the coder's diff and untracked files to scratch and
  restores the freeze tree, so `freeze_digest` resumes at the coder. The saved work is kept, not
  applied.
  (b) A frozen resume accepts a dirty tree when every frozen path still matches the freeze, and
  the coder round restarts on the kept edits.
  (c) No change in flow; the stop text prints the exact manual clean-up commands.
- **Q3 (#40 + #58).** `MAX_SYMBOL_HITS = 100` counts bare `git grep -w` hits. Since 7.2.0 the file
  mode removed relay size as its reason. `CALLER_READ_BUDGET` is now the real limit, so any raise
  interacts with it. Which option? (1) Raise the cap, or make it per path class (tests vs
  code). (2) Map callers by glob or class (for example "tests/\*\*: dont_care, keyword-compatible")
  with a script check. (3) Skip per-caller mapping for a proven backward-compatible change.
  (4) Keep the stop with a clear next step (do it by hand, or split).
- **Q4 (#9, chunk writes).** Chunk writers use `printf '%s' '<chunk>' > <scratch>/<i>.b64`
  (src:2223, :2672). The scratch dir is outside the worktree, so the `settings.local.json` allow
  rules (src:1378-1381, Edit/Write in the worktree only) do not cover it. (a) Add
  `Write(<scratch>/**)` to the allow rules and have writers use the Write tool. (b) Keep printf
  and add a Bash allow rule for that shape in the user settings. (c) Leave it.
- **Q5 (advisory, #67/#59).** A retry of a sonnet relay runs on opus. Accept the cost, or cap
  retries at sonnet (then #59 still repeats on the same model)? The plan assumes "accept".
- **Q6 (#32).** The brief says #33 (L2140, PRs open ready) ships in the same release. #32's design
  works on today's draft-then-ready flow. Add #33 to 7.3.0, or ship #32 alone?

## SPLIT-OUT

- **#61 whole.** It needs new role output (`test_conflict` on the coder, `target: "plan"` on
  pr-review and the sweep). It needs a new route from a coder stop to the code judge. It also
  needs a Max decision: with a PR open under unattended, `plan_wrong` ends at
  `autoDecide("plan_wrong","ask")`. That is a route design with its own plan audit, not a
  bounded fix.
- **#60 step 3.** A pre-freeze run of gate-change-nonweakening-sweep in `planAndAudit` is a new
  gate. #60 stays open after 7.3.0, because its acceptance ("refused before the freeze") needs
  this step.
- **#9 push.** Moving `git push` (pre-push hooks, credential helper) into a program puts it under
  the program rlimit. #34 (L2141) records `gh auth git-credential` crashing under that cap. A
  plan of its own, after #34.
- **#39 (2) npm prefix walk-up.** The worktrees sit inside the main checkout. A real fix moves
  them, or pins the npm/node prefix per worktree. That is a layout change.

## Hook surface check

`.pre-commit-config.yaml` names `.github/scripts/check_versions.py`, `update_plugin_count.py`,
`update_plugin_versions.py`, `check_skill_frontmatter.py`, `check_changelog_staged.py` and
`check_audit_lab_version.py`. No fix edits these files, `.pre-commit-config.yaml`,
`.git/hooks/*` or `.github/workflows/**`. The `marketplace.json` bump triggers
`validate-plugin-versions` and the two README hooks, which run and are not changed.

## Out-of-batch relations (report only)

- #22 (L2029): its load-parked digest retry is covered by #42. Close it after merge.
- #43 also removes one cause of #63 (orphaned parked drafts under an old key).
- #40 relates to #68 (7.2.0 callers follow-ups).
- #33 (L2140): see Q6.

## Risks

- Car 1 changes the model of every retry. A test that pins a retry's model to its tier fails and
  must be updated on purpose. List every such test in the CHANGELOG.
- `writeChunksParallel` adds agents to a `saveState` only over the 8-chunk bound. The agent cap
  (`MAX_AGENTS`) and `reserve` must count them, as commit-plan does.
- #39's fast-forward must never run in build mode. A13 pins that.
- #49 turns a skip into a stop. A forge that is slow to show a new PR now stops the run.
