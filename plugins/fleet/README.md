# fleet

Role fleet for one non-trivial code change. `/build-task <anything>` runs the
`fleet:build-task-run` workflow twice:

1. **plan mode** reads the input, plans the change, audits the plan and commits it locally. It
   returns `awaiting_confirmation` with a short summary, the plan diff and the fleet size.
2. After Max confirms, **build mode** checks that the approved plan is unchanged, writes tests per
   acceptance criterion, judges and freezes them, codes against them, judges the code, pushes the
   branch and opens a **draft** PR. It then writes back to the sources. Max reviews and merges.

The input is any of: a yadgar ledger id, a Jira key, a GitHub or Codeberg issue or PR URL, a plan
path, or free text.

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
- For Jira input or write-back: the Atlassian MCP server. For GitHub write-back: `gh-personal`. For
  Codeberg write-back: `$CODEBERG_TOKEN`. A missing tool makes intake stop, or makes that comment
  fail (reported in the result, the run stays ok).

## Flow

`args.mode` is `"plan"` or `"build"`. A missing or other value returns `needs_human` before any
agent runs.

### Plan mode

args: `{mode: "plan", input, repo, date, project?}`.

| Step | Agent              | Gate in script code                                                       |
| ---- | ------------------ | ------------------------------------------------------------------------- |
| 1    | preflight          | yadgar unreachable, a role missing, a low version or a wrong marker       |
| 2    | intake (read only) | `needs_human` (ambiguous repo or ticket) stops before any other step      |
| 3    | workspace (infra)  | creates or reuses branch `fleet/<task id>-<slug>` and its worktree        |
| 4    | branch-scan (r/o)  | any commit beyond origin/<default> that is not a plan commit -> stop      |
| 5    | scope-and-plan     | criterion ids; disjoint test files; `tldr`; `plan_diff` is a string array |
| 6    | -                  | risk tier logged; short path disabled (always full)                       |
| 7    | plan-audit         | verdict other than `approve` -> `needs_human`                             |
| 8    | stage-plan         | stages the plan doc; returns the sha256 of the staged bytes               |
| 9    | commit-plan        | writes the sealed ref file; commits plan + ref LOCALLY in ONE commit      |

Branch-scan: a plan commit has the subject `plan(<task id>): <slug>`, and its file set is a
non-empty subset of exactly `{plan_path, .fleet/<task id>/plan_ref.json}`. The scan reads
`plan_path` from the sealed ref file at that same commit; paths are compared exactly after
normalisation, with no prefix or extension match. A commit with no readable ref file, a broken seal,
another task's ref, or any other file is a build commit. If the fleet branch carries any build
commit, plan mode stops with "branch has build commits; run build, or delete branch". It never commits a plan on top
of code. On a plan-only branch it adds a new plan commit.

Plan mode returns `awaiting_confirmation` with `tldr`, `plan_diff`, `fleet_size`
(`{criteria, est_agents, est_rounds}`), `plan_path` and `plan_ref`. It makes no push, no PR, no
ledger write and no comment. The planner's `held_out_examples` are dropped: never returned and
never forwarded.

Intake classifies the input and fetches its text: a ledger task through yadgar `task_get`, a Jira
ticket through the Atlassian MCP, an issue or PR through `gh-personal` or the Codeberg API, a plan
file, or free text. It returns `brief: {title, description, sources: [{kind, ref, url, body}],
repo, plan_path}`. Free text, a plan and a ledger task work in the caller's repo. A Jira ticket that
names no repo, or several, stops with `needs_human`. The task id comes from the first ledger, Jira,
GitHub or Codeberg source (`plan` for an ingested plan, `task` for free text). The slug comes from
the brief title.

The full plan ref is a file, `.fleet/<task id>/plan_ref.json`, committed in the plan commit. It
holds `branch`, `plan_path`, `plan_sha256`, `criteria`, `brief`, `task_id`, `slug`, `tldr`,
`plan_facts` (scope fence, estimate, `test_cmd` and `repo_obligations`), `history` (cumulative
runs, re-plans and agents) and
`seal`, the sha256 of the canonical JSON of the rest. It holds no held-out example. Commit-plan
reads the file back from the commit; the script checks that it parses to the sealed ref (a
formatter hook may change the bytes, not the content).

The caller gets only a tiny `plan_ref`: `{branch, plan_commit, ref_path, ref_sha256, repo}`, where
`ref_sha256` is the sha256 of the committed file bytes. The skill passes it back unchanged.

Since 2.0.3, `plan_facts` is
`{allowed_additions, est_diff_lines, test_cmd, repo_obligations, commands}`, covered by the seal.
Build mode refuses a ref without `test_cmd`, `repo_obligations` and `commands` (made by 2.0.2 or
earlier) with `needs_human` "plan_ref predates 2.0.3; re-run plan".

### Build mode

args: `{mode: "build", plan_ref, date, project?}`.

| Step | Agent              | Gate in script code                                                     |
| ---- | ------------------ | ----------------------------------------------------------------------- |
| 1    | -                  | tiny `plan_ref` shape wrong -> `needs_human` before any agent           |
| 2    | preflight          | as in plan mode                                                         |
| 3    | workspace (infra)  | reuses the fleet branch and worktree                                    |
| 4    | load-ref (r/o)     | ref file at `plan_commit`: sha256, seal, branch, repo (below)           |
| 5    | verify (read only) | plan hash at `plan_commit` and HEAD; HEAD position (below)              |
| 6    | prepare (infra)    | one worktree per testable criterion on `<branch>--p<sha8>-t-<id>`       |
| 7    | test writers       | one per criterion, in parallel                                          |
| 8    | integrate (infra)  | merges the writer branches into the fleet branch                        |
| 9    | test judge         | `revise` routes findings to the named writers only; 3 rounds max        |
| 10   | hasher (freeze)    | sha256 of test files and runner config; `freeze_ref` = HEAD             |
| 11   | coder              | status (checked after the hash check)                                   |
| 12   | hasher             | any changed, new or removed hash key -> coder round rejected            |
| 12a  | obligations (r/o)  | each `check_cmd` run in the worktree; fingerprint before and after      |
| 13   | code judge         | `fix_code` -> coder; `fix_tests` -> test judge; `plan_wrong` -> re-plan |
| 13a  | -                  | `approve` with an unmet obligation -> `fix_code` (counts as a round)    |
| 14   | push (infra)       | pushes `approved_sha`; origin must then be at that sha                  |
| 15   | pr-opener          | draft PR at `approved_sha` (HEAD after the approving judge run)         |
| 16   | write-back         | ledger section and one marked comment per external source               |

Load-ref: an infra step returns `git show <plan_commit>:<ref_path>` and its sha256. Both must
equal `ref_sha256`, the inner seal must hold, and the file's branch, repo and task id must match the
tiny ref. Any mismatch stops with `needs_human` before any role runs. The script then uses the
loaded ref. The ref file is also frozen: the hasher hashes it as a read-only config key, so a coder
or writer that edits it trips the freeze.

Verify: the sha256 of `plan_path` at `plan_commit` must equal `plan_sha256`, or the run stops with
"plan changed since approval". HEAD must equal `plan_commit`, or descend from it by fleet commits of
this build only (`test(<id>): ...`, `feat|fix(...): ...`, and the merges of this plan's criterion
branches), with `plan_path` and the ref file unchanged. Anything else stops with the same reason.
Stage-plan, commit-plan and verify run the same embedded hash program.

The risk tier is still computed and logged (short = `est_diff_lines < 20` AND `new_behaviour`
false), but the fleet always takes the full path: no role prompt supports a coder without frozen
criterion tests. A criterion with `test_files: []` is manual: it gets no writer, no frozen entry and
no disjointness check, and it still reaches the PR opener so a human sees it.

Worktrees live under `<repo>/.claude/worktrees/fleet-<task id>-<slug>/` (`main`,
`p<sha8>-t-<criterion>`, `scratch`, `replan-<n>`). The workspace step adds `.claude/worktrees/` and
`.claude/settings.local.json` to the repo's `info/exclude` when they are not already ignored.

### plan_wrong

A `plan_wrong` verdict stops the build. The script:

1. takes the code judge's `plan` findings and parses each `Proposed plan change: <line>` into
   `proposed_plan_change[]` (a finding without that line is used whole and logged);
2. creates a detached worktree at the old `plan_commit`, runs scope-and-plan (the findings are an
   extra `text` source) and plan-audit there, and commits the new plan there;
3. saves the old fleet-branch head as `fleet/<task id>-<slug>--superseded-<n>`, then resets the
   fleet branch to the new plan commit;
4. returns `awaiting_confirmation` with `proposed_plan_change`, `plan_findings`, `superseded_ref`
   and a fresh `plan_ref`.

The next build run starts fresh from the new plan: new criterion branches (named by the new plan
commit), a new freeze. Round and agent caps reset per run; `cumulative` counts runs, re-plans and
agents across runs.

### Write-back

After the PR opens, build mode writes back. A failure here never changes the run status.

- **Ledger:** for each `ledger` source, one `## Fleet build` section (tldr, plan path, PR URL,
  hidden `fleet:<task id>` marker) is appended to the task's body page (`body_slug`) in
  `args.project`. A body that already carries the marker is skipped. `ledger_status` is `ok`,
  `failed` or `none`.
- **Comments:** one comment on each `jira`, `github` and `codeberg` source: tldr, plan link, PR
  link and the marker `fleet:<task id>` (an HTML comment on GitHub and Codeberg, a plain last line
  on Jira). A read-only step lists the existing comments first; a source that already has the
  marker is skipped. The script refuses, in code, any comment with a line that starts with `digger`
  or `atlantis`. Ticket and issue bodies are never edited. `comment_status` is `posted`, `skipped`,
  `failed` or `none`; on `failed`, `comment_text` holds the text to post by hand.

### Frozen set

The hasher freezes every criterion test file, plus:

- runner config, whole files, found by walking the filesystem (so an ignore rule cannot hide
  one): `conftest.py`, `pytest.ini`, `.pytest.ini`, `pytest.toml`, `tox.ini`, `setup.cfg`,
  `noxfile.py`, `sitecustomize.py`, `usercustomize.py`, `jest.config.*`, `vitest.config.*`,
  `vitest.workspace*`, `karma.conf.*`, `.mocharc*`, `.babelrc*`, `babel.config.*`, and `*.pth` at
  the repo root. The walk skips `.git`, `.claude/worktrees`, `node_modules`, `.venv`, `venv`, `.tox`
  and `.nox`. It also skips the tool cache dirs `__pycache__`, `.mypy_cache`, `.pytest_cache`,
  `.ruff_cache`, `.import_linter_cache` and `.hypothesis`, but only when git ignores them (by an
  outside rule or their own `*` `.gitignore`). A skipped cache dir is still scanned: runner config,
  a `pyproject.toml` or a `package.json` inside one is suspicious;
- symlinks: every symlink the walk meets, file or directory, outside the skipped dirs, under key
  `symlink:<path>` with its `readlink` target as the value. Links are never followed, so adding or
  retargeting a link (for example a linked directory holding a `conftest.py`) is a change;
- ignore rules: every `.gitignore` git reads, that is every one `git ls-files -z --cached --others
--exclude-standard -- ':(glob)**/.gitignore' .gitignore` lists, plus every walked one whose
  directory no outside rule ignores (so a `.gitignore` that ignores itself still counts). A
  `.gitignore` inside an ignored dir is not frozen: git never reads it, and tools rewrite them on
  every commit (`.ruff_cache/.gitignore`). Also frozen: the worktree's `info/exclude` (key
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

Frozen files stay byte-equal between freezes. The only exception is an approved `fix_tests`
round: its writers may revise frozen tests in place, and the script then re-freezes. In that
re-freeze, only the test files of the criteria named in the code judge's `fix_tests` findings may
change. Any other changed key (another criterion's tests, runner config, ignore rules, symlinks)
stops the run with "re-freeze touched unrouted path". Each re-freeze is recorded in
`refreeze_log` (`round`, `freeze_ref_before`, `freeze_ref_after`, `changed`). On a re-entry, the
fleet branch is first merged into every criterion branch, and each writer and every test-judge
round get the code judge's findings (writers: only those for their criterion) and the coder's
commits.

The hasher returns four separate maps (`files`, `sections`, `git`, `symlinks`), so a real file
named like a synthetic key (for example `symlink:conftest.py`) cannot mask one. The `suspicious`
list holds every walked path with `:` or `#` in a name, runner config found in a skipped cache
dir, and any `*.pyc`/`*.pyo` named after a frozen test module or `conftest`. A non-empty list stops
the run at freeze and rejects a coder round after it.

Bytecode is not hashed, so a planted `__pycache__/test_x.cpython-3XX.pyc` (or a pytest
assertion-rewrite pyc) whose header matches a frozen test's mtime and size would run instead of
the frozen source. Before every freeze and every post-coder hash check (so before every code-judge
run), an infra step `infra:purge-bytecode` deletes every `__pycache__` dir, `*.pyc`/`*.pyo` file and
`.pytest_cache` dir in the worktree (sparing `.git`, `.venv`, `venv`, `.tox`, `.nox`,
`node_modules`, `.claude/worktrees`) and returns the count. The judge's "before" fingerprint is
taken after the purge. The coder and the code judge get
`test_env: {PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider"}` for every run of
the frozen tests. The code judge also gets `hash_recheck`
(`{"<map>/<key>": {frozen, current, match}}`) for its report; the script's own comparison decides.

### Repo obligations and test_cmd

The planner scans the repo's push and CI gates: `.pre-commit-config.yaml` (every stage, `pre-push`
included, and the entry script of each local hook), the PR workflows, `Makefile`,
`AGENTS.md`/`CONTRIBUTING.md` rules and version-bump checkers. Each rule the change must satisfy
becomes one entry of `repo_obligations`:
`{id, kind: version_bump|changelog|docs|generated|other, rule_source: "<file>:<line or hook id>", files, instruction, check_cmd?}`.
`[]` means none apply. The planner also returns
`test_cmd: {command, paths_placeholder: "<paths>", env, tools}`, the exact command that runs the
repo's tests (for example `uv run --extra test pytest <paths> -n0`), and verifies it on one existing
test in a throwaway worktree. Plan-audit re-scans the gates independently (a missing obligation is
a `plan_defect`) and runs `test_cmd` itself.

The script checks the shape: `test_cmd.command` is a non-empty string; each obligation has a
unique `id`, a known `kind` and an `instruction`.

#### Command safety

`test_cmd` and every `check_cmd` come from the planner, and the planner reads untrusted ticket and
issue text. So the commands pass four layers before anything runs:

1. **Allowlist (script code, plan mode).** Every token must be plain: letters, digits and
   `_ . / : = @ % + , -`. No quote, glob, `; & | $ ( ) < >`, backquote or newline. A `check_cmd`
   must be exactly one of:

   - `pre-commit run <hook-id> [--all-files] [--hook-stage <stage>] [--from-ref <ref> --to-ref <ref>]`
   - `make <target>`
   - `[uv run [--extra <x>]] python[3] <relative/path.py> [plain args]`
   - `<relative/path/to/script> [plain args]`

   `test_cmd.command` gets the token rule (with `<paths>` allowed) and plain `env`. A `test_cmd`
   that fails stops the run with `needs_human` (`stop_gate: commands`). A `check_cmd` that fails is
   not run: the obligation keeps `check_cmd_rejected` and `check_rejected_reason`, the run logs
   `<id> check_cmd not auto-run (judge-only)`, and the code judge rules on it from the diff.

2. **Reference check (read-only infra step `infra:verify-commands`, plan mode).** An embedded
   Python program checks that the hook id exists in a tracked `.pre-commit-config.yaml`, the make
   target in a tracked makefile, or the path is a tracked regular file (not a symlink). A failure
   makes the obligation judge-only.
3. **Forbidden words.** The words terraform, tofu, tfp, digger and atlantis, anywhere and in any
   case, make a command judge-only (or stop the run, for `test_cmd`). The reference check also
   searches the referenced script, the hook block (and tracked files its entry names) and the make
   recipe (and tracked files it names).
4. **Human approval.** Plan mode returns `commands`: every `test_cmd` and `check_cmd`, verbatim,
   with `rule_source` and `run_by` (`roles`, `workflow`, or `nobody` for judge-only). The skill
   shows them verbatim in the confirmation question. They live in the sealed `plan_facts`, so the
   build runs only commands Max saw. Build mode re-applies the allowlist to the sealed commands.

Plan-audit, the coder and the code judge get `repo_obligations` and `test_cmd`; the writers and
the test judge get `test_cmd`. Every test run uses `test_cmd` with `test_cmd.env` first and
`test_env` on top. The coder satisfies every obligation in `feat|fix(...)` commits and reports
`obligations_done`.

After the coder, the bytecode purge and the hash check, the infra step `infra:obligations:r<n>`
(read-only, `fleet:judge`) first re-runs the reference check against `plan_commit`: a referenced
file, hook block or recipe that changed since the approved plan, or now contains a forbidden word,
is refused and counts as a failed check (exit code `null`), whatever the agent reports. It then runs
each allowed `check_cmd` as its plain argv (no `bash -c`) with no credentials:
`cd <worktree> && env -i HOME=<scratch>/obligations-home PATH="$PATH" XDG_CACHE_HOME=<caches> LANG=C.UTF-8 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 <test_env> [unshare -rn] timeout 300 <check_cmd>`.
No `SSH_AUTH_SOCK`, `GH_TOKEN`, `AWS_*`, `CODEBERG_TOKEN` or 1Password session reaches it. When
`unshare -rn true` works on the host, the command also runs with no network; otherwise the run logs
"network not isolated". The step returns `{prechecks, network_isolated, results: [{id, exit_code, tail}]}`.
The script takes the worktree fingerprint before and after it, as for a judge; a change stops the
run (`stop_gate: fingerprint`). It skips the step when no obligation has a `check_cmd`. The code
judge gets the results as `obligation_results` and returns `obligations_check: [{id, met, evidence}]`.
On `approve`, the script requires every `check_cmd` to have exit code 0 (a missing result or a
non-integer exit code fails) and every obligation to be `met: true`. Otherwise it converts the
verdict to `fix_code`, routes the failures to the coder as findings and logs it. That round counts
toward the 3 code rounds.

### Role contract

The script pins the role contract, not the prose:

- `EXPECTED_VERSIONS` holds the minimum role-page versions. Preflight reads each page's version. A
  lower version (stale or rolled back) stops the run; a higher one is logged as "prose-only changes
  assumed" and returned as `role_versions`.
- Every role page carries `CONTRACT: fleet-v2` under its DISPATCH line. Preflight and every role
  runner report the marker; any other value stops the run.
- Each role runner reports the version and marker it loaded. A value that differs from preflight
  (the page changed mid-run) discards the result.
- `REQUIRED_ON_OK` lists the keys each role must return with `status: ok`, and verdicts are
  checked against the frozen enums. A missing key or an unknown verdict is contract drift and stops
  the run.
- Stop reason precedence: (1) a script gate violation (hash, fingerprint, obligations) with that
  gate's own reason; (2) the role's own `needs_human`/`failed` reason; (3) contract drift, only when
  neither applies. The coder's hash check runs before its contract check, and a judge's fingerprint
  check before its contract check. The result's `stop_gate` names the gate: `hash`, `fingerprint`,
  `obligations`, `commands`, `contract`, `role` or `cap` (`null` when the run did not stop at one of
  them).

### Models

Each role runs on the tier named by the first `DISPATCH: model=<tier> (fallback=<tier>)` line of
its role page. Preflight returns those lines; the script parses them. Accepted tiers: `fable`,
`opus`, `sonnet`, `haiku`. A missing, unparseable or unknown line gives `sonnet`, and the run logs
it. A role agent that dies is retried once on its fallback tier, when one is set; the retry counts
toward the agent cap. Infra agents (preflight, intake, workspace, branch-scan, stage-plan,
commit-plan, load-ref, verify, prepare,
integrate, hasher, verify-commands, obligations, push, write-back) run on `sonnet`.

### Judge separation

Judges, preflight, intake, branch-scan, load-ref, verify, the comment listing and the hasher run as
the `fleet:judge` agent (as do verify-commands and obligations), which has `Write`, `Edit` and
`NotebookEdit` disallowed. `Bash` stays, because the code judge must run the suite. The backstop is
a worktree fingerprint (HEAD, sha256 of `git status --porcelain`, sha256 of `git diff HEAD`) taken
before and after every judge run. Any difference discards the verdict and returns `needs_human`
with reason `judge mutated worktree`. This catches a suite that leaves tracked or unignored changes
too. It does not catch a change that a judge makes and reverts within its own run.

### Limits

- Agent cap 60 per run. Test rounds: 3 per entry into the test loop. Code rounds: 3 per build run;
  a `fix_tests` detour counts as one code round and opens a new test-loop entry.
- The fleet runs no held-out examples and no mutation, coverage or scanner gates. Judges receive
  explicit `{status: "not_run"}` markers, and `gates_not_run` reaches the PR opener and the result.
  The planner's `held_out_examples` are dropped before any other role sees the plan. The script
  cannot check that the planner kept them out of the plan doc itself.
- Verify tells fleet commits apart by their subject lines only; git cannot prove who made a commit.
  The plan-file checks (hash at `plan_commit` and at HEAD, no commit touching it) do not depend on
  that.
- The pr-opener role pushes the branch too. The script pushes first, so the role's push is a no-op.
- The plan link in comments assumes a GitHub origin (`https://github.com/<owner>/<repo>/blob/...`).
- Interpreter startup hooks inside an in-worktree virtualenv are not detected. The walk skips
  `.venv`, `venv`, `.tox` and `.nox`, because an editable install writes a `.pth` file there and
  would cause a false mismatch. So a coder can drop a `.pth` or `sitecustomize.py` into such a venv
  and v1 does not see it. A planned follow-up (v1.1) hashes the startup hooks in the site-packages of
  the judge's interpreter.
- New files outside `allowed_additions` are not denied by script in v1.
- A judge's test run that leaves untracked, unignored files (caches the repo does not ignore) flips
  the fingerprint and stops the run. The workspace step adds `__pycache__/`, `.pytest_cache/` and
  `.coverage` to `info/exclude` to cut this down.
- Bytecode inside `.venv`, `venv`, `.tox` and `.nox` is not purged or checked. A pyc planted there
  for an installed module is not detected. A frozen test's pyc is caught only by name (its module
  stem); the purge, not the name check, is the main defence.
- A `.pyc` outside `__pycache__` that git does not ignore shows in `git status`. Purging it between
  the test judge and the freeze trips "worktree changed between test approval and freeze".
- Not yet executed in the real Workflow runtime; the scenario suite stubs the runtime.
- Command safety covers the commands the plan names, not the code they run. The test writers, the
  test judge, the coder and the code judge run `test_cmd` (and the coder an approved `check_cmd`)
  with the agent's normal environment, credentials included: running tests executes repo code, and
  that is inherent. What changed in 2.0.3 is that the commands themselves are allowlisted and
  approved by Max verbatim; only the workflow's own `infra:obligations` step runs a `check_cmd`
  with no credentials.
- An approved `make` target, hook or script can still do anything its code does. The reference
  check only refuses a missing reference, a symlink, a forbidden word, or (at build time) a change
  since the approved plan.
- `infra:obligations` keeps `XDG_CACHE_HOME` so pre-commit and uv reuse their caches. With network
  isolation, a check that must download hooks or packages fails and counts as unmet.
- The isolation probe (`unshare -rn true`) and the precheck run by an infra agent, as the hasher
  does. The script enforces the precheck result it is given; it cannot prove the agent ran the
  command it reports.
- The hasher program travels in the hasher prompt and the agent runs it verbatim. A transcription
  error would show up as a hash mismatch (fail-closed), not as a silent pass.
- Whether workflow agents honour a worktree-local `.claude/settings.local.json` is not verified.
  The workspace and prepare steps write one (Edit/Write allowed for that worktree) as a
  precaution; it is excluded from git status.

## Result

Build mode, `status: "ok"`:

```json
{
  "status": "ok",
  "mode": "build",
  "reason": "...",
  "branch": "fleet/<task id>-<slug>",
  "pr_url": "...",
  "path": "full",
  "rounds": { "tests": 1, "code": 1 },
  "agents": 14,
  "cumulative": { "runs": 2, "replans": 0, "agents": 20 },
  "gates_not_run": [{ "gate": "held_out", "reason": "..." }],
  "stop_gate": null,
  "role_versions": { "fleet-coder": 10 },
  "refreeze_log": [],
  "write_back": {
    "ledger": [{ "ref": "42", "status": "written" }],
    "comments": []
  },
  "ledger_status": "ok",
  "comment_status": "none",
  "comment_text": null,
  "gate_log": ["..."],
  "yadgar_findings": [{ "role": "fleet-coder", "findings": ["..."] }]
}
```

`status: "awaiting_confirmation"` (plan mode, or build mode after `plan_wrong`) adds `tldr`,
`plan_diff`, `fleet_size`, `plan_path`, `commands`, `plan_ref` and `cumulative`; after `plan_wrong` also
`proposed_plan_change`, `plan_findings`, `superseded_ref` and `superseded_head`.

## Tests

The workflow logic is tested with Node's built-in runner. The harness stubs the workflow runtime
and drives scripted role responses by agent label. One test runs the embedded hasher program
against a scratch git repo.

```bash
node --test 'plugins/fleet/tests/*.test.mjs'
```

Node 22+ (the glob form is required; `node --test <dir>` does not work on Node 24).
