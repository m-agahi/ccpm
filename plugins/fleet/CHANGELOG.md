# Changelog

## [2.0.2] - 2026-11-04

### Fixed

- Freeze false positive: the hasher no longer freezes `.gitignore` files that git never reads. It
  hashes the `.gitignore` files listed by `git ls-files --cached --others --exclude-standard`, plus
  any walked `.gitignore` whose directory no outside rule ignores, so a `.gitignore` that ignores
  itself is still frozen. A tool rewriting `.ruff_cache/.gitignore` or
  `.import_linter_cache/.gitignore` on every commit no longer rejects coder rounds.
- The tool cache dirs `__pycache__`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`,
  `.import_linter_cache` and `.hypothesis` are skipped only when git ignores them (by an outside
  rule or their own `*` `.gitignore`). A skipped cache dir is still scanned: runner config, a
  `pyproject.toml` or a `package.json` inside one is suspicious, which rejects the round.
- Role outputs: array fields are typed in each role schema. On `ok`, every required key whose
  schema type is array, object or boolean must have that type; a wrong type is
  `contract drift: <role> <key> type` (a string `"[]"` is no longer accepted as an array).
- Push and fetch robustness: the workspace fetch, the push and the remote check retry up to 3
  times with backoff (5s, 15s, 45s). A non-fast-forward push is still `needs_human` at once.
  `remote_head` comes from `gh api repos/<owner>/<name>/branches/<branch>` (`gh-personal` for the
  personal account), with `git ls-remote` only when gh is not installed. An `ls-remote` error in
  the workspace step is no longer read as "branch absent".
- Bytecode poisoning: bytecode is not hashed, so a planted `__pycache__/test_x.cpython-3XX.pyc`
  could run instead of a frozen test. A new infra step `infra:purge-bytecode` deletes every
  `__pycache__`, `*.pyc`/`*.pyo` and `.pytest_cache` (sparing `.git` and venvs) before every freeze
  and every post-coder hash check, so before every code-judge run. The judge fingerprint is taken
  after the purge. The hasher also flags any pyc named after a frozen test module or `conftest` as
  suspicious. The coder and code judge get
  `test_env: {PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider"}`.
- Retry loops tell the infra agent to run them as one Bash call with a 600000 ms timeout.

### Changed

- Minimum role versions: `fleet-coder` 9 and `fleet-code-judge` 8 (both honour `test_env` and
  treat compiled bytecode as frozen-adjacent).

## [2.0.1] - 2026-11-04

### Changed

- The caller now carries a tiny `plan_ref`: `{branch, plan_commit, ref_path, ref_sha256, repo}`.
  The full sealed ref is written to `.fleet/<task id>/plan_ref.json` and committed in the same local
  plan commit. Build mode loads it from the plan commit, checks its sha256 and its inner seal, and
  stops with `needs_human` on any mismatch before any role runs. The ref file is frozen with the
  tests, so editing it rejects a coder round.
- Plan commits use the subject `plan(<task id>): <slug>`. The plan is staged and hashed before the
  ref is sealed; the committed plan must hash the same.

### Fixed

- Plan mode no longer commits a plan on top of code. A fleet branch with any commit beyond
  `origin/<default>` other than earlier plan commits of the task stops with "branch has build
  commits; run build, or delete branch".
  A plan commit must have the subject `plan(<task id>):` and touch only exactly the plan path
  named by the sealed ref file at that commit and `.fleet/<task id>/plan_ref.json`; any other file
  (another `.md`, an extra file under `.fleet/<task id>/`) makes it a build commit.

## [2.0.0] - 2026-11-04

### Changed (breaking)

- `fleet:build-task-run` takes `args.mode`: `"plan"` or `"build"`. A missing or other value returns
  `needs_human`. The v1 args `task` and `title` are gone.
- Role contract bumped to `CONTRACT: fleet-v2`. A page with the v1 marker halts the run. Minimum role
  versions: scope-and-plan 13, plan-audit 10, fleet-test-writer 6, fleet-test-judge 6, fleet-coder 7,
  fleet-code-judge 7, fleet-pr-opener 5. scope-and-plan now takes `brief` and `date`, and must return
  `tldr` and `plan_diff` (an array of strings); plan-audit gets `plan_diff`.
- `/build-task <anything>` is model-invocable. It triggers on non-trivial code changes and tells the
  model to skip the fleet for one-line or mechanical edits. It runs plan mode, asks the user to
  confirm, then runs build mode.

### Added

- Intake (read only): resolves a ledger id, Jira key, GitHub or Codeberg issue or PR URL, plan path
  or free text into a brief. An ambiguous repo or ticket stops before any other step.
- Plan mode: preflight, intake, workspace, scope-and-plan, plan-audit, local plan commit. Returns
  `awaiting_confirmation` with `tldr`, `plan_diff`, `fleet_size`, `plan_path` and a sealed
  `plan_ref`. No push, PR, ledger write or comment.
- Build mode: checks the `plan_ref` seal, re-hashes the plan at `plan_commit` and checks the branch
  position ("plan changed since approval"), then runs the test, freeze, code and judge pipeline,
  pushes the approved sha and opens the draft PR. Criterion branches are named by the plan commit.
  The verify step quotes the `<sha>^{commit}` ref, so a zsh agent shell does not glob it.
- `plan_wrong` re-plan: re-plans in a detached worktree at the approved plan, saves the old head as
  `--superseded-<n>`, resets the fleet branch to the new plan commit and returns
  `awaiting_confirmation` with `proposed_plan_change`. Caps reset per run; `cumulative` counts runs,
  re-plans and agents.
- Write-back after the PR: a section on each ledger task body, and one comment with a hidden
  `fleet:<task id>` marker on each Jira, GitHub and Codeberg source. Existing marked comments are
  skipped; comments with a line starting with `digger` or `atlantis` are refused in code; failures are
  reported as `comment_status: failed` with `comment_text` and never change the run status.

## [1.0.0] - 2026-11-04

### Added

- `/build-task <ledger id | plan path>` skill that runs the `fleet:build-task-run` workflow.
- `build-task-run` workflow: preflight, workspace, scope-and-plan, risk tier, plan-audit, one test
  writer per acceptance criterion, test judge with revise rounds, hash freeze, coder, code judge with
  fix rounds, draft PR. Role prompts load from yadgar at run time; the script embeds no role text.
- Script-side gates: disjoint test files, frozen-test and test-runner-config hashing (config found
  by filesystem walk, symlinks frozen by target, ignore-rule files frozen, `pyproject.toml#tool.pytest` and `package.json`
  jest/vitest/mocha/`scripts.test` sections), judge
  worktree fingerprint before and after every judge run, round caps, 60-agent cap.
- Held-out examples from the planner are withheld from every other role. Judges get explicit
  `not_run` markers for held-out, mutation, coverage and scanner gates; `gates_not_run` reaches the
  PR opener and the result.
- Per-role model tier from each role page's DISPATCH line (fallback tier retried once when an agent
  dies); infra agents on sonnet.
- Hasher returns separate files/sections/git/symlinks maps plus a suspicious-name list; the code
  judge gets a `hash_recheck` report.
- Role contract pinning: minimum role versions, `CONTRACT: fleet-v1` marker, required keys and
  verdict enums checked in code. The short path is disabled in v1.
- Guarded re-freeze after an approved `fix_tests` round, recorded in `refreeze_log`.
- `fleet:judge` read-only agent for judges, preflight and hasher.
- `node --test` scenario suite for the workflow logic and the hasher program.
