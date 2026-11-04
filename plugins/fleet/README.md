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

| Step | Agent             | Gate in script code                                                  |
| ---- | ----------------- | -------------------------------------------------------------------- |
| 1    | preflight         | yadgar unreachable or any role missing -> `needs_human`              |
| 2    | workspace (infra) | creates or reuses branch `fleet/<task id>-<slug>` and its worktree   |
| 3    | scope-and-plan    | status; criterion ids; test files disjoint across criteria           |
| 4    | -                 | risk tier logged; short path disabled in v1 (always full)            |
| 5    | plan-audit        | verdict other than `approve` -> `needs_human`                        |
| 6    | prepare (infra)   | commits the plan doc; creates one worktree per testable criterion    |
| 7    | test writers      | one per criterion, in parallel, each on `<branch>--t-<id>`           |
| 8    | integrate (infra) | merges the writer branches into the fleet branch                     |
| 9    | test judge        | `revise` routes findings to the named writers only; 3 rounds max     |
| 10   | hasher (freeze)   | sha256 of test files and runner config; `freeze_ref` = HEAD          |
| 11   | coder             | status                                                               |
| 12   | hasher            | any changed, new or removed hash key -> coder round rejected         |
| 13   | code judge        | `fix_code` -> coder; `fix_tests` -> test judge; `plan_wrong` -> stop |
| 14   | pr-opener         | draft PR at `approved_sha` (HEAD after the approving judge run)      |

The risk tier is still computed and logged (short = `est_diff_lines < 20` AND `new_behaviour`
false), but v1 always takes the full path: no role prompt supports a coder without frozen criterion
tests. A criterion with `test_files: []` is manual: it gets no writer, no frozen entry and no
disjointness check, and it still reaches the PR opener so a human sees it. A ledger-id task needs a
`title` arg; the run stops without one.

Task id and slug: a plan path (ends in `.md` or contains `/`) gives task id `plan` and the
slugified file stem. A ledger id gives the slugified id and the slugified `title` arg (`task` when
absent). Worktrees live under `<repo>/.claude/worktrees/fleet-<task id>-<slug>/` (`main`,
`t-<criterion>`, `scratch`). The workspace step adds `.claude/worktrees/` and
`.claude/settings.local.json` to the repo's `info/exclude` when they are not already ignored.

### Frozen set

The hasher freezes every criterion test file, plus:

- runner config, whole files, found by walking the filesystem (so an ignore rule cannot hide
  one): `conftest.py`, `pytest.ini`, `.pytest.ini`, `pytest.toml`, `tox.ini`, `setup.cfg`,
  `noxfile.py`, `sitecustomize.py`, `usercustomize.py`, `jest.config.*`, `vitest.config.*`,
  `vitest.workspace*`, `karma.conf.*`, `.mocharc*`, `.babelrc*`, `babel.config.*`, and `*.pth` at
  the repo root. The walk skips `.git`, `.claude/worktrees`, `node_modules`, `__pycache__`, `.venv`,
  `venv`, `.tox`, `.nox`, `.mypy_cache` and `.pytest_cache`;
- symlinks: every symlink the walk meets, file or directory, outside the skipped dirs, under key
  `symlink:<path>` with its `readlink` target as the value. Links are never followed, so adding or
  retargeting a link (for example a linked directory holding a `conftest.py`) is a change;
- ignore rules: every `.gitignore` in the tree, the worktree's `info/exclude` (key
  `git:info/exclude`, resolved with `git rev-parse --git-path`) and the global
  `core.excludesFile` (key `git:core.excludesFile`). Editing an ignore rule is a change;
- sections, hashed under `<path>#<section>` after canonicalisation (sorted keys, compact JSON):
  `pyproject.toml#tool.pytest` (every `[tool.pytest.*]` table), `package.json#jest`,
  `package.json#vitest`, `package.json#mocha`, `package.json#scripts.test`. The rest of these files
  (dependencies) stays editable. A missing section hashes as `ABSENT`, so adding one is a change.

The comparison runs in the script, never in an agent. A key that appears (for example a new
`conftest.py`), disappears or changes rejects the coder round, whatever the code judge says. Roles
receive only the criterion test files in `frozen_tests`. Everything else (whole-file runner config,
`.gitignore` files, sections, ignore rules outside the worktree, symlinks) goes in
`frozen_config_sections`; `symlink:` values are link targets, not hashes. Judges
also receive `code_base_ref`, the commit before the first coder round, because a re-freeze after
`fix_tests` moves `freeze_ref` past earlier coder commits.

The hasher returns four separate maps (`files`, `sections`, `git`, `symlinks`), so a real file
named like a synthetic key (for example `symlink:conftest.py`) cannot mask one. Every walked path
with `:` or `#` in a name goes on a `suspicious` list. A non-empty list stops the run at freeze and
rejects a coder round after it. The code judge also gets `hash_recheck`
(`{"<map>/<key>": {frozen, current, match}}`) for its report; the script's own comparison decides.

### Role contract

The script pins the role contract, not the prose:

- `EXPECTED_VERSIONS` holds the minimum role-page versions. Preflight reads each page's version. A
  lower version (stale or rolled back) stops the run; a higher one is logged as "prose-only changes
  assumed" and returned as `role_versions`.
- Every role page carries `CONTRACT: fleet-v1` under its DISPATCH line. Preflight and every role
  runner report the marker; any other value stops the run.
- Each role runner reports the version and marker it loaded. A value that differs from preflight
  (the page changed mid-run) discards the result.
- `REQUIRED_ON_OK` lists the keys each role must return with `status: ok`, and verdicts are
  checked against the frozen enums. A missing key or an unknown verdict is contract drift and stops
  the run.

### Models

Each role runs on the tier named by the first `DISPATCH: model=<tier> (fallback=<tier>)` line of
its role page. Preflight returns those lines; the script parses them. Accepted tiers: `fable`,
`opus`, `sonnet`, `haiku`. A missing, unparseable or unknown line gives `sonnet`, and the run logs
it. A role agent that dies is retried once on its fallback tier, when one is set; the retry counts
toward the agent cap. Infra agents (preflight, workspace, prepare, integrate, hasher) run on
`sonnet`.

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
- Interpreter startup hooks inside an in-worktree virtualenv are not detected. The walk skips
  `.venv`, `venv`, `.tox` and `.nox`, because an editable install writes a `.pth` file there and
  would cause a false mismatch. So a coder can drop a `.pth` or `sitecustomize.py` into such a venv
  and v1 does not see it. A planned follow-up (v1.1) hashes the startup hooks in the site-packages of
  the judge's interpreter.
- New files outside `allowed_additions` are not denied by script in v1.
- A judge's test run that leaves untracked, unignored files (caches the repo does not ignore) flips
  the fingerprint and stops the run. The workspace step adds `__pycache__/`, `.pytest_cache/` and
  `.coverage` to `info/exclude` to cut this down.
- Not yet executed in the real Workflow runtime; the scenario suite stubs the runtime.
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
  "path": "full",
  "rounds": { "tests": 1, "code": 1 },
  "gates_not_run": [{ "gate": "held_out", "reason": "..." }],
  "role_versions": { "fleet-coder": 3 },
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
