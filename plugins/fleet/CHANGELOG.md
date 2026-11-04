# Changelog

## [2.0.3] - 2026-11-04

### Added

- Repo obligations: the planner scans the repo's push and CI gates (pre-commit and pre-push hooks,
  PR workflows, Makefile, AGENTS/CONTRIBUTING rules, version-bump checkers) and returns
  `repo_obligations: [{id, kind, rule_source, files, instruction, check_cmd?}]`, `[]` when none.
  `kind` is one of `version_bump`, `changelog`, `docs`, `generated`, `other`. The coder satisfies
  each one in its commits and reports `obligations_done`; the code judge reports
  `obligations_check: [{id, met, evidence}]`. `check_cmd` is informational: the code judge may run
  it; the workflow script never does.
- `test_cmd: {command, paths_placeholder, env, tools}`: the exact command that runs the repo's
  tests, verified by the planner and the auditor on one existing test. Writers, the test judge, the
  coder and the code judge run every test with it (`test_cmd.env`, then `test_env`).
- Obligations gate: a code-judge `approve` is converted to `fix_code` with routed findings when an
  obligation is not `met: true` in `obligations_check`; that round counts as a code round.
- Push hook rejection: the push step classifies `push_result` as `ok`, `hook_rejected`, `network`
  or `non_ff`. A push a repo pre-push hook rejects goes back to the coder as `fix_code` with the
  hook output tail; it counts as a code round, and the code judge must approve again before the
  next push. `non_ff` still stops with `needs_human`; `network` is retried and then fails.
- Command safety: `test_cmd` and `check_cmd` come from a planner that reads untrusted ticket text,
  so they pass an allowlist in script code (plain tokens only, no quote, glob, `; & | $ ( ) < >`,
  backquote or newline; a `check_cmd` must be `pre-commit run <hook> [...]`, `make <target>`,
  `[uv run [--extra x]] python[3] <rel/path.py> [args]` or `<rel/path/script> [args]`), and the
  words terraform, tofu, tfp, digger and atlantis refuse a command. `test_cmd.env` may hold only
  `DJANGO_SETTINGS_MODULE`, `PYTHONUNBUFFERED`, `TZ`, `LANG`, `LC_ALL`, `NO_COLOR`, `FORCE_COLOR`
  and `CI`. A refused `test_cmd` stops the plan; a refused `check_cmd` becomes
  `check_cmd_rejected` and is never offered to a role. Plan mode returns `commands`, every command
  verbatim with its env, tools, `rule_source` and `run_by`, sealed in `plan_facts`; the skill shows
  them verbatim in the confirmation question. Build mode re-checks the sealed commands.
- `stop_gate` in the result: `hash`, `fingerprint`, `commands`, `contract`, `role` or `cap` for the
  gate that stopped the run; `null` on `ok`, `awaiting_confirmation` and other stops.

### Changed

- The sealed plan ref gains `plan_facts.test_cmd`, `plan_facts.repo_obligations` and
  `plan_facts.commands`. Build mode refuses a ref without them with `needs_human`
  "plan_ref predates 2.0.3; re-run plan".
- `REQUIRED_ON_OK`: scope-and-plan adds `repo_obligations` (array) and `test_cmd` (object with a
  non-empty string `command`); the coder adds `obligations_done`; the code judge adds
  `obligations_check` (arrays).
- The push runs inside the code loop, right after an approve, so a hook rejection can route back.
  Its first attempt keeps the label `infra:push`; later ones are `infra:push:p<n>`.
- Honest stop reason. A script gate violation (hash, fingerprint) is reported first, then the
  role's own `needs_human`/`failed` reason, and contract drift only when neither applies. The
  coder's hash check now runs before its contract check: a coder output that is malformed or not
  ok AND changed a frozen hash stops with the hash violation. A judge that mutates the worktree
  reports the fingerprint even when its output also drifts. A cap stop names the gate that rejected
  the last round.
- Minimum role versions: scope-and-plan 17, plan-audit 11, fleet-test-writer 7, fleet-test-judge 7,
  fleet-coder 11, fleet-code-judge 10. The contract marker stays `fleet-v2`; the new keys are
  additive.

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
