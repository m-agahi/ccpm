# Changelog

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
