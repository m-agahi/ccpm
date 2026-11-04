# fleet

Role fleet for one task. `/build-task <ledger id | plan path>` runs the `fleet:build-task-run`
workflow. The workflow plans the change, audits the plan, writes tests per acceptance criterion,
judges and freezes them, codes against them, judges the code and opens a **draft** PR. Max reviews
and merges.

## Install

```
/plugin marketplace add m-agahi/ccpm
/plugin install fleet@maxagahi-marketplace
```

## Requirements

- Claude Code with the Workflow tool (dynamic workflows) enabled.
- The `yadgar` MCP server, with the seven role prompts in project `m-agahi/yadgar`:
  `scope-and-plan`, `plan-audit`, `fleet-test-writer`, `fleet-test-judge`, `fleet-coder`,
  `fleet-code-judge`, `fleet-pr-opener`. The workflow embeds no role text. Each role agent loads its
  prompt with `mcp__yadgar__agent_prompt_get`. A missing role stops the run in preflight; there is no
  local fallback.
- `git`, `gh` (authenticated), and `python3` >= 3.11 (or `tomli`) in the target repo's environment.

## Flow

| Step | Agent             | Gate in script code                                                    |
| ---- | ----------------- | ---------------------------------------------------------------------- |
| 1    | preflight         | yadgar unreachable or any role missing -> `needs_human`                |
| 2    | workspace (infra) | creates or reuses branch `fleet/<task id>-<slug>` and its worktree     |
| 3    | scope-and-plan    | status; criterion ids; test files disjoint across criteria             |
| 4    | -                 | risk tier: `est_diff_lines < 20` and `new_behaviour == false` -> short |
| 5    | plan-audit        | verdict other than `approve` -> `needs_human`                          |
| 6    | prepare (infra)   | commits the plan doc; creates one worktree per testable criterion      |
| 7    | test writers      | one per criterion, in parallel, each on `<branch>--t-<id>`             |
| 8    | integrate (infra) | merges the writer branches into the fleet branch                       |
| 9    | test judge        | `revise` routes findings to the named writers only; 3 rounds max       |
| 10   | hasher (freeze)   | sha256 of test files and runner config; `freeze_ref` = HEAD            |
| 11   | coder             | status                                                                 |
| 12   | hasher            | any changed, new or removed hash key -> coder round rejected           |
| 13   | code judge        | `fix_code` -> coder; `fix_tests` -> test judge; `plan_wrong` -> stop   |
| 14   | pr-opener         | draft PR at `approved_sha` (HEAD after the approving judge run)        |

The short path skips steps 5 and 7-9. Its hash set is the runner config only.

Task id and slug: a plan path (ends in `.md` or contains `/`) gives task id `plan` and the
slugified file stem. A ledger id gives the slugified id and the slugified `title` arg (`task` when
absent). Worktrees live under `<repo>/.claude/worktrees/fleet-<task id>-<slug>/` (`main`,
`t-<criterion>`, `scratch`). The workspace step adds `.claude/worktrees/` and
`.claude/settings.local.json` to the repo's `info/exclude` when they are not already ignored.

### Frozen set

The hasher freezes every criterion test file, plus runner config found anywhere in the tree
(tracked, or untracked and not ignored):

- whole files: `conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `jest.config.*`,
  `vitest.config.*`, `.mocharc*`;
- sections, hashed under `<path>#<section>` after canonicalisation (sorted keys, compact JSON):
  `pyproject.toml#tool.pytest` (every `[tool.pytest.*]` table), `package.json#jest`,
  `package.json#vitest`, `package.json#mocha`, `package.json#scripts.test`. The rest of these files
  (dependencies) stays editable. A missing section hashes as `ABSENT`, so adding one is a change.

The comparison runs in the script, never in an agent. A key that appears (for example a new
`conftest.py`), disappears or changes rejects the coder round, whatever the code judge says.

### Judge separation

Judges, preflight and the hasher run as the `fleet:judge` agent, which has `Write`, `Edit` and
`NotebookEdit` disallowed. `Bash` stays, because the code judge must run the suite. The backstop is
a worktree fingerprint (HEAD, sha256 of `git status --porcelain`, sha256 of `git diff HEAD`) taken
before and after every judge run. Any difference discards the verdict and returns `needs_human`
with reason `judge mutated worktree`. This catches a suite that leaves tracked or unignored changes
too. It does not catch a change that a judge makes and reverts within its own run.

### Limits

- Agent cap 60. Test rounds: 3 per entry into the test loop. Code rounds: 3 in total; a `fix_tests`
  detour counts as one code round and opens a new test-loop entry.
- v1 runs no held-out examples and no mutation, coverage or scanner gates. Judges receive explicit
  `{status: "not_run"}` markers, and `gates_not_run` reaches the PR opener and the result. The
  planner's `held_out_examples` are deleted before any other role sees the plan. v1 cannot check
  that the planner kept them out of the plan doc itself.
- The hasher program travels in the hasher prompt and the agent runs it verbatim. A transcription
  error would show up as a hash mismatch (fail-closed), not as a silent pass.
- Whether workflow agents honour a worktree-local `.claude/settings.local.json` is not verified.
  The workspace and prepare steps write one (Edit/Write allowed for that worktree) as a
  precaution; it is excluded from git status.

## Result

```json
{
  "status": "ok | needs_human | failed",
  "reason": "...",
  "branch": "fleet/<task id>-<slug>",
  "pr_url": "...",
  "path": "short | full",
  "rounds": { "tests": 1, "code": 1 },
  "gates_not_run": [{ "gate": "held_out", "reason": "..." }],
  "gate_log": ["..."],
  "yadgar_findings": [{ "role": "fleet-coder", "findings": ["..."] }]
}
```

## Tests

The workflow logic is tested with Node's built-in runner. The harness stubs the workflow runtime
and drives scripted role responses by agent label. One test runs the embedded hasher program
against a scratch git repo.

```bash
node --test 'plugins/fleet/tests/*.test.mjs'
```

Node 22+ (the glob form is required; `node --test <dir>` does not work on Node 24).
