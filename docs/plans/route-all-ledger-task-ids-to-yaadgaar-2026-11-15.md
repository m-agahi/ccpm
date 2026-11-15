# Route all ledger task ids to yaadgaar (fleet 7.0.0)

Status: built by hand in fleet 7.0.0 (the fleet plan run failed at its plan-commit step). Re-plan round 1: plan-audit findings
AC5 (yaadgaar prompt wording), OB1 (version literals), TASK_DATA/TITLE_MAX and OB5 (README pins)
are fixed below. Re-plan round 2: the `READS` and `ARRAY_SITES` test tables are mapped and named in
step 8, the AC2 write-back ref is `yaadgaar #622`, and the `AC-1992` test in `v4_s2.test.mjs` is
named in the list of tests the coder updates.

Context: yaadgaar #699 (migration of every yadgar ledger task to yaadgaar). Steps 1, 2, 3 and 5 of
that task are done: all 467 open yadgar ledger rows outside `yadgarhq/*` now live in yaadgaar, with
the title prefix `L<id>: ` and `legacy_ref` `urn:yadgar:ledger:<project>:<id>`. Step 6 is this plan.

## Request

> in /home/max/git/ccpm: fleet routes ledger task ids for every project to yaadgaar (read_task /
> edit_task), not only yadgarhq/\*; drop the yadgar-ledger intake and write-back path; retire
> ledger-writer if yadgar-only; update build-task and plan-task skill text. Jira/URL/plan/text
> inputs unchanged. Context yaadgaar #699.

## Premise check (current HEAD 8471ee7)

The defect still reproduces:

- `plugins/fleet/src/build-task-run.js:4031-4034` `ledgerFor` returns `"yadgar"` for every project
  that does not start with `yadgarhq/`, and `"either"` with no project. The #699 body cites
  `build-task-run.js:4033`: that is the source file (`src/`), line 4033 is the return line. The
  shipped dist (`workflows/build-task-run.js`) holds the same code at line 3704.
- `intakePrompt` (src:2399-2425) carries three ledger branches: `yaadgaar`, `yadgar`
  (`mcp__yadgar__task_get`, then `wiki_read` of a `body_slug`) and `either` (tries both).
- `ledgerProblem` (src:4081-4090) refuses a yaadgaar source on any non-`yadgarhq/` project.
- `writeBack` (src:7843-8000) part (a) reads and writes the yadgar ledger through
  `ledgerReadPrompt`, `ledgerWritebackPrompt`, `writeBodies` and `ledgerBodyPrompt`; part (b) writes
  yaadgaar only when `ledgerFor(project) === "yaadgaar"` (src:7922).
- `LEDGER_TOOLS` (src:4038) = `["mcp__yaadgaar__read_task", "mcp__yadgar__task_get"]`.
- `agents/ledger-writer.md:7` `tools:` lists only `ToolSearch`, `StructuredOutput` and five
  `mcp__yadgar__*` tools. It runs only for `infra:ledger-body` (src:7780, `WRITER_AGENT`). It is
  yadgar-only, so the request retires it.

## Design

One option per fork, with the reason.

1. **Ledger choice.** Every project uses the yaadgaar ledger. `ledgerFor` stops returning `yadgar`
   and `either`; intake gets `ledger: "yaadgaar"` for any `args.project`, and for none. The
   yaadgaar client is bound to the session's project, so the existing session-project proof
   (`session_project.py`, `yaadgaarScope`, src:4131-4143) keeps guarding a mismatch. It is already
   project-agnostic.
2. **Intake prompt.** Keep only the yaadgaar branch: `42`, `#42` and `yaadgaar #42` are yaadgaar
   tasks, read with `mcp__yaadgaar__read_task(number=...)`. An `L42` input stops `needs_human`: it is
   a legacy yadgar id, and the migrated task carries the title prefix `L42: ` in yaadgaar. Drop every
   `mcp__yadgar__task_get`, `wiki_read` and `body_slug` instruction, and `body_slug` from the prompt's
   Return line.
3. **No-project guard.** The task-id blocker in `defaultBlockers` and the confirm-auto stop in
   `planMode` keep their behaviour; they key on a missing `args.project` instead of
   `ledgerFor(...) === "either"`. Existing tests pin both (`v4_s4.test.mjs:617-618`,
   `v630_unattended.test.mjs:201-204`).
4. **`ledgerProblem`.** Drop the arm that refuses a yaadgaar source on a non-`yadgarhq/` project.
   Keep the arm that refuses a legacy `ledger` source on a `yadgarhq/` project, testing
   `YAADGAAR_PROJECT_RE` directly (the existing tests at `build_task_run.test.mjs:6165` and `:6235`
   stay green).
5. **Legacy `ledger` source kind: inert, not removed.** Intake never produces it any more. A brief
   that still carries one (an old sealed plan ref, or the test harness default) is accepted on a
   non-`yadgarhq/` project but never read or written:
   - write-back: no agent step; one entry `{ref, status: "unavailable", reason: "...the yadgar ledger
is retired...", section_text}`; `ledger_status` `unavailable`; `ledger_adapter` `none` (or
     `tracker` with an external source); `ledger_reason` names the retired ledger, never "ledger
     tool absent". `section_text` lets Max paste the section into the migrated yaadgaar task.
   - confirm-auto build: `rereadBrief` does not re-read a `ledger` source (the yadgar ledger is
     frozen, so the sealed body is the current one); it returns the sealed brief. `autoGates` then
     passes `ledger_task: null` to the intent judge, as for any source without a ledger adapter.
     The brief's source bodies still reach the judge.
   - Why not remove the kind: see Non-goals (test-harness hit counts).
6. **`ledgerAdapter`** (between the `LEDGER_ADAPTER_BEGIN/END` markers): `yaadgaar` for a yaadgaar
   source on any project; `tracker` for an external source; else `none`. A `ledger` source never
   yields `yadgar`; its reason names the retired yadgar ledger. `LEDGER_TOOLS` =
   `["mcp__yaadgaar__read_task"]`, so the preflight census asks for that one tool.
7. **Write-back to yaadgaar for every project.** Part (b) of `writeBack` runs for any
   `<owner>/<repo>` `args.project`, with the same read-by-sealed-id, id/number/project checks,
   `expect_version` and append-only `edit_task` patch as today.
8. **Retire** `ledgerReadPrompt`, `ledgerWritebackPrompt`, `ledgerBodyPrompt`, `writeBodies`,
   `ledgerRead`, `WRITER_AGENT`, `bodyPageProblem`, `BODY_PAGE_REASON` and
   `plugins/fleet/agents/ledger-writer.md`. Also delete the two module constants this orphans:
   `TASK_DATA` (src:2220; its only readers are `ledgerReadPrompt` and `ledgerBodyPrompt`) and
   `TITLE_MAX` (src:204; its only other uses, src:7762-7763, are inside `writeBodies`).
   `BODY_DATA` stays (the yaadgaar prompts read it).
   **Reword three kept sentences** so no shipped prompt names a yadgar ledger tool (AC5):
   - `intakePrompt`, yaadgaar branch (src:2405): replace "never map them to the yadgar ledger or to
     L<N>, and never call `mcp__yadgar__task_get` (that ledger is frozen history for this
     project)." with "never map them to L<N>." (the rest of the sentence stays).
   - `yaadgaarReadPrompt` (src:3275): replace "Use the `mcp__yaadgaar__` tools only; never
     `mcp__yadgar__task_get` or any yadgar ledger tool (the yadgar ledger is frozen history for
     this project)." with "Use the `mcp__yaadgaar__` tools only; call no other task, memory or
     wiki tool."
   - `yaadgaarWritebackPrompt` (src:3285): replace "Use the `mcp__yaadgaar__` tools only; never
     `mcp__yadgar__task_get`, `mcp__yadgar__task_write` or any yadgar ledger or wiki tool." with
     "Use the `mcp__yaadgaar__` tools only; call no other task, memory or wiki tool."
     **Leave byte-identical** (unmapped definitions; an edit refuses the build): `autoGates` (its
     `ad === "yadgar"` test at src:5271 becomes dead and stays), `ledgerSourceOf`, `noLedgerStop`,
     `buildFromRef`, `INFRA_TIER` (its `["infra:ledger-", "sonnet"]` row stays), `INTAKE_SCHEMA`,
     `LEDGER_KINDS`, `ID_KINDS`, `SOURCE_KINDS`, `LEDGER_PROJECT_RE`, `BODY_DATA`. In test files,
     no top-level definition outside `changed_symbols` changes (an unused one such as `YGET` in
     `v5_adapters.test.mjs` stays); edits go inside `test(...)` blocks or comments. Two exceptions,
     both mapped in `changed_symbols`: the test tables `READS` (`v403_schema_types.test.mjs:173`)
     and `ARRAY_SITES` (`build_task_run.test.mjs:5584`). Their stale-entry checks (`v403:938`,
     `build_task_run:5742`) fail once a read site is gone, so the coder deletes exactly the entries
     of the retired reads and keeps every other entry:
     - `READS`: the `bodyPageProblem` entry (`:450`), the `writeBodies` entry (`:850`), the yadgar
       reads of `writeBack` (`:858-866`: `h.body_slug string`, `pre.results array`,
       `r.results array` with its count re-set to the reads left) and the `either` reads of
       `ledgerFor` / `ledgerToolNeeded` (`:437-439`) where the new code no longer has them; a new
       typed read the code adds gets an entry.
     - `ARRAY_SITES`: `it.tried @ bodyPageProblem` (`:5603`), `r.results @ writeBodies` (`:5682`),
       `pre.results @ writeBack` (`:5683`), `h.page_tags @ writeBodies` (`:5701`).
       The two checks themselves (`v403:920-938`, `build_task_run:5725-5744`) stay unchanged and green.
9. **Skills.** `build-task/SKILL.md` and `plan-task/SKILL.md` describe one ledger, yaadgaar, for every
   project: intake reads with `read_task`, plan-task writes the brief with `edit_task` (patch append,
   `expect_version`) and files a new task with `create_task`. No `task_get`, `task_write`,
   `wiki_add`, `wiki_append_section`, `body_slug`, `task_list` or "yadgar ledger" path remains. The
   duplicate check in the plan-task triage table uses `find_tasks` only.
10. **Version 7.0.0** (MAJOR). An `L<N>` id no longer builds and no yadgar write-back happens: a
    breaking change per `CONTRIBUTING.md` "Versioning Guidelines".

## Acceptance criteria (summary; the workflow carries the full examples)

- AC1 `[unit]` intake routes every project to yaadgaar; the prompt holds no yadgar ledger branch.
- AC2 `[unit]` a yaadgaar source on a non-`yadgarhq/` project plans, builds and is written back
  through `infra:yaadgaar-read` / `infra:yaadgaar-writeback`; a read answer naming another project
  is refused. The write-back entry keeps today's ref format, `yaadgaar #<N>` (src:7979, unchanged).
- AC3 `[unit]` a legacy `ledger` source is inert: no `infra:ledger-*` step, entry `unavailable`
  with the section text, no rulings re-read under confirm auto.
- AC4 `[unit]` `ledgerAdapter` and `LEDGER_TOOLS` table.
- AC5 `[unit]` retired yadgar machinery is gone from src and dist (the banned strings are exactly
  `mcp__yadgar__task_get`, `mcp__yadgar__task_write`, `mcp__yadgar__wiki_read`,
  `mcp__yadgar__wiki_add`, `mcp__yadgar__wiki_append_section`, `infra:ledger-read`,
  `infra:ledger-writeback`, `infra:ledger-body`, `fleet:ledger-writer`, and the constants
  `TASK_DATA`, `TITLE_MAX`, `WRITER_AGENT`, `BODY_PAGE_REASON`); `ledger-writer.md` is deleted;
  the census and the no-ledger stop name only `mcp__yaadgaar__read_task`. The bare `INFRA_TIER`
  prefix `infra:ledger-` is not banned.
- AC6 `[unit]` the two skill texts route to yaadgaar only.
- AC7 `[unit]` (guard) Jira, URL, plan and text inputs are unchanged.

Behaviour that already holds on HEAD (the pure adapter picks `yaadgaar` for a yaadgaar source on any
project; intake keeps its `read_task` branch and the `L<N>` -> needs_human rule; the no-project
task-id blocker) is not a red example: existing tests pin it (`v5_adapters.test.mjs`,
`v4_s4.test.mjs:617-618`, `v630_unattended.test.mjs:201-204`) and the new tests may assert it only
beside an example that fails on HEAD.

Test files: one new file per criterion, `plugins/fleet/tests/v700_*.test.mjs`.

## STRIDE at the touched trust boundary

The boundary is the yaadgaar task answer (task body, id, number, project), now trusted for every
project instead of `yadgarhq/*` only.

- Spoofing (an answer for another project's task): refused. A named project other than
  `args.project`, or a session project other than `args.project`, stops intake and fails the
  write-back entry (existing `yaadgaarScope`; AC2 refusal example at build).
- Tampering (a lost or clobbered body edit): `edit_task` keeps `expect_version`, the append-only
  patch with `expect_count: 1`, and the read-after-write check. Unchanged code; existing tests in
  `build_task_run.test.mjs` (3.0.0 yaadgaar write-back) pin it.
- Repudiation: not applicable; the write-back marker `fleet:<task>` and the PR link stay in the
  section as today.
- Information disclosure: the section text holds the tldr, plan path and PR URL only, as today.
- Denial of service: not applicable; a failed or absent yaadgaar tool never stops the run (soft
  dispatch, unchanged).
- Elevation of privilege: the read step still runs on `fleet:judge`, whose `disallowedTools` denies
  `mcp__yaadgaar__edit_task`; only the write-back step edits. Unchanged.

## Repo obligations (coder steps)

- OB1 version bump to 7.0.0. Production: `FLEET_VERSION` (src:117, then dist via OB3),
  `.claude-plugin/marketplace.json:134` fleet `version`. Test literals that pin `6.3.4` (every one,
  from `git grep -n '6\.3\.4\|6\\\.3\\\.4' plugins/fleet/tests` at 8471ee7; comments that
  only cite the 6.3.4 release stay):
  - `harness.mjs:1080` `SCRIPTS_DIR`;
  - `v4_s1.test.mjs:126, 330, 332-334, 336-340, 342, 346, 367, 376, 682, 696, 697, 698`;
  - `v4_s3.test.mjs:551` (`p.fleet_version`), `:611` (`install fleet 6\.3\.4` regex);
  - `v5_roles.test.mjs:25` (inside `realProbe`), `:248` (`p.fleet_version`);
  - `v600_s3.test.mjs:36` (`TPL`), `:112` ("Built with ccpm fleet 6.3.4");
  - `build_task_run.test.mjs:209, 6256, 6954, 8661` (the `fleet 6\.3\.4` regexes);
  - `v403_schema_types.test.mjs:1129` (the `fleet\/6\.3\.4\/roles` regex);
  - `v622_fixes.test.mjs:617` (`install fleet 6\.3\.4`).
    `v4_s2.test.mjs:411` checks the constant, the marketplace, the root README and the CHANGELOG
    agree.
- OB2 CHANGELOG: a `## [7.0.0] - 2026-11-15` entry in `plugins/fleet/CHANGELOG.md` with Deploy,
  Changed and Removed sections (hook `check-changelog`).
- OB3 generated dist: run `node plugins/fleet/scripts/build-workflow.mjs` after the src edits; the
  dist must match (`build-workflow.mjs --check`, test `v631_dist.test.mjs`) and stay under the size
  guard.
- OB4 root README: `README.md:160` `### fleet (v7.0.0)` (hook `update-plugin-versions`; run
  `python3 .github/scripts/update_plugin_versions.py`).
- OB5 docs: `plugins/fleet/README.md` and `plugins/fleet/docs/build-task-run-notes.md` lose the
  yadgar ledger, body page and ledger-writer descriptions and say every project uses yaadgaar.
  The two README lines that `v4_s2.test.mjs:405-406` pins stay verbatim: the intake shape
  `sources: [{kind, ref, url, body, id, project, body_slug}]` and the kind list `` `ledger`,
`yaadgaar`, `jira`, `github`, `codeberg`, `plan` and `text` `` (the `ledger` kind and the
  `body_slug` schema property stay, see Non-goals). The notes keep their `before yaadgaarReadPrompt`
  and `before yaadgaarWritebackPrompt` sections.
- OB6 formatting: every changed `.md` and `.json` passes prettier 3.1.0 (hook `prettier`, CI
  "Check formatting").
- OB7 prompt snapshot: re-print `PINS` in `v5010_prompt_snapshot.test.mjs` with
  `FLEET_SNAPSHOT_PRINT=1` after the src change, and add a `// 7.0.0 (#699): ...` line to the
  comment list above it naming the changes (intake prompt, removed `infra:ledger-*` steps, the
  reworded yaadgaar prompts). Check that only these changes move the pins: with them reverted,
  every pin is 6.3.4's.

Test command: `npm test -- <paths>` (root `package.json` `"test": "node --test"`). Probe in a scratch
worktree on `plugins/fleet/tests/v5_adapters.test.mjs`: exit 0, 16 tests passed. CI runs
`node --test plugins/*/tests/*.test.mjs`.

## Existing tests the coder updates (plan step 6)

The default harness fixture (`ARGS.input` `L42`, `BRIEF` source kind `ledger`, project `o/r`) stays.
Tests that pin the retired yadgar path change to the new behaviour or are deleted inside their
`test(...)` blocks; no top-level test definition outside `changed_symbols` changes. Files (all in
`allowed_additions.files`):

- `build_task_run.test.mjs`: write-back, 1958 body page, 3.1.0 ledger-writer (`:9053`, `:9163-9165`,
  `:9804`), 3.1.3 routing, `:4406` (default fixture `ledger_task.body` is now null under auto),
  `:5603`, `:5646-5705` source-text pins, the OB1 regexes.
- `v5_adapters.test.mjs` (adapter table, census, no-ledger stop), `v620_body_page.test.mjs` (its
  `test(...)` blocks; its top-level helpers stay), `v600_s4.test.mjs`, `v601_update.test.mjs`,
  `v610_update_coder.test.mjs`, `v402_file_sha.test.mjs`, `v600_s1.test.mjs:251` (asserts
  `infra:ledger-writeback` ran), `v600_s2.test.mjs`, `v403_schema_types.test.mjs`.
- `v620_plan_task.test.mjs:476`: pins the string `body_slug` in the plan-task text, which AC6
  removes; drop that one entry.
- `v4_s2.test.mjs`: the README pins (`:405-406`) stay green by OB5. The test `AC-1992: a build
without project uses the sealed project for the ledger and write-back` (`:304-312`) asserts an
  `infra:ledger-writeback` call on the default `ledger` fixture, which AC3 makes inert: re-pin it to
  no `infra:ledger-*` step, one write-back entry with status `unavailable`, and the gate log line
  `project o/r from the sealed plan ref` (kept).
- `build_task_run.test.mjs:7860` matches `/never mcp__yadgar__task_/i` on the yaadgaar write-back
  prompt; the reworded sentence (step 8) removes it, so that one regex goes.
- `v4_s1.test.mjs`, `v4_s3.test.mjs`,
  `v5_roles.test.mjs`, `v600_s3.test.mjs`, `v622_fixes.test.mjs` (OB1),
  `v5010_prompt_snapshot.test.mjs` (OB7), `harness.mjs` (`LEDGER_TOOLS_ALL`, `SCRIPTS_DIR`).
- Expected unchanged, fenced in case a pin moves: `v509_ledger_project.test.mjs` (yadgarhq/docs
  only), `v630_unattended.test.mjs`, `v4_s4.test.mjs`, `v5_prompts.test.mjs`,
  `v502_relay_keys.test.mjs`, `v504_pycache.test.mjs`, `v600_s1.test.mjs`,
  `v621_policy_init.test.mjs`.

## Non-goals

- Removing the `ledger` source kind from `SOURCE_KINDS` / `ID_KINDS` / `LEDGER_KINDS`, and switching
  the harness default fixture to a yaadgaar source. Both need the harness `ARGS` (1098 hits),
  `happy` (934), `runOne` with its `agent` stub closure (610) or `buildFromRef` (102) to change, and
  the fleet's caller check refuses a symbol with more than 100 hits. See Open decisions.
- The `body_slug`, `page_project` and `page_tags` schema properties (src:716, src:725), the
  `infra:ledger-` row of `INFRA_TIER` (src:101) and the `yadgar L<N>` wording of
  `ledgerSourceText`: dead for new runs, harmless, left for the follow-up.
- Role files (`roles/scope-and-plan.md:12`, `roles/fleet-intent-judge.md:14` still list kind
  `ledger`): editing a role changes its pinned sha256 (`ROLE_SHA256`, src:1599) and is left for the
  follow-up.
- `agents/judge.md` wording ("ledger task read") and its `disallowedTools` list.
- Resolving an `L<N>` id to its migrated yaadgaar task (`find_tasks` by `legacy_ref` or title
  prefix). See Open decisions.
- `buildFromRef`'s no-project check text "needs args.project (the yadgar ledger scope)"
  (src:5936-5938): it only fires for a legacy `ledger` source with no project, and `buildFromRef`
  has 102 hits.
- Yadgar memory, wiki, ADR and recall use elsewhere: the fleet script calls none of them.

## Open decisions

1. `L<N>` input: stop `needs_human` and tell Max to pass the yaadgaar number (recommended; the
   migrated task's title starts `L<N>: `), or resolve it through `find_tasks` / `legacy_ref`
   (new tool, new trust surface, not in this plan).
2. Version: 7.0.0 (recommended, breaking per CONTRIBUTING) or 6.4.0.
3. Follow-up, outside the fleet (a test-only change no gate can accept under the 100-hit cap): flip
   the harness default to a yaadgaar source with default `infra:yaadgaar-read` / `-writeback` stubs,
   then delete the `ledger` kind, the dead schema properties, the `INFRA_TIER` row and the role
   text, re-pinning the role sha256 table with `scripts/gen.mjs`.

## Risks

- Large test churn in `build_task_run.test.mjs`: the coder must keep every unrelated assertion.
  The full suite runs in the code judge.
- The default happy build now reports `ledger_status: "unavailable"`; tests that pinned `"ok"` for
  the default fixture change with it.
- A session started in another project's directory cannot write back for `args.project`: the
  session-project proof fails closed (`unavailable` or `failed`), as it does today for
  `yadgarhq/*`.
