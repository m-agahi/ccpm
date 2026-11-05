# fleet

Role fleet for one non-trivial code change. `/build-task <anything>` runs the
`fleet:build-task-run` workflow twice:

1. **plan mode** reads the input, plans the change, audits the plan and commits it locally. It
   returns `awaiting_confirmation` with a short summary, the plan diff and the fleet size.
2. After Max confirms, **build mode** checks that the approved plan is unchanged, writes tests per
   acceptance criterion, judges and freezes them, codes against them and judges the code. Nothing is
   committed until the code judge approves: then ONE commit step commits tests and code together
   with the repo's hooks. It pushes the branch, opens a **draft** PR, has the PR reviewed
   independently, and writes back to the sources. Max reviews and merges.

With `confirm: "auto"` (opt-in, for goal or unattended runs) plan mode does not ask. It runs three
gates (intent, commands, scope) and, when they pass, builds in the same run. When one fails it
stops with `needs_human` and a ready `needs_max_section`.

The input is any of: a yadgar ledger id, a Jira key, a GitHub or Codeberg issue or PR URL, a plan
path, or free text.

## Install

```
/plugin marketplace add m-agahi/ccpm
/plugin install fleet@maxagahi-marketplace
```

## Requirements

- Claude Code with the Workflow tool (dynamic workflows) enabled.
- The `yadgar` MCP server, with the ten role prompts in project `m-agahi/yadgar`:
  `scope-and-plan`, `plan-audit`, `fleet-test-writer`, `fleet-test-judge`, `fleet-coder`,
  `fleet-code-judge`, `fleet-pr-opener`, `fleet-intent-judge`, `pr-review` and
  `gate-change-nonweakening-sweep`. Preflight checks all ten on every run, also when a run does not
  need the intent judge (`confirm: "ask"`) or the sweep (no gate change). The workflow embeds no
  role text. Each role agent loads its
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

args: `{mode: "plan", input, repo, date, project?, confirm?}`. `confirm` is `"ask"` (the default:
return for confirmation) or `"auto"` (see below). Any other value returns `needs_human` before any
agent runs.

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
`plan_diff` (2.1.0), `plan_facts` (scope fence, estimate, `test_cmd` and `repo_obligations`),
`history` (cumulative
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

### confirm "auto"

After plan-audit approves and the plan is committed, `confirm: "auto"` runs these gates in order.
The first failure stops the run:

1. **G1 intent.** The role `fleet-intent-judge` (as `fleet:judge`, fingerprinted on the fleet
   worktree) gets the brief with the source bodies, the ledger task body with its rulings
   (`ledger_task`), `plan_path`, `criteria`, `plan_diff`, `allowed_additions`, `repo_obligations`
   and `commands`. It returns `verdict` (`approve` or `refuse`), `deviations` (each
   `{item, allowed_by, source_ref, fails_closed, verdict, reason}`) and `coverage`
   (`{covered, missing}`). The script passes the gate only when the verdict is `approve`, every deviation has verdict `approve`, a non-empty
   `allowed_by` and `fails_closed: true`, and `coverage.covered` is `true`. A `needs_human` or
   `failed` from the judge fails the gate too.
2. **G2 commands.** Every entry of `commands` must be the `test_cmd`, or a `check_cmd` of exactly
   `pre-commit run <id> [--all-files] [--hook-stage <stage>]` whose hook id appears exactly once in
   `.pre-commit-config.yaml` at `plan_commit`. A read-only infra step (`infra:precommit-ids`) runs a
   fixed program: `git show <plan_commit>:.pre-commit-config.yaml`, parsed with PyYAML. No config,
   no PyYAML or a parse error fails the gate. A refused command (`run_by: nobody`) fails it.
3. **G3 scope fence**, pure script code over every planned path (criteria `test_files`,
   `allowed_additions.files`, obligation `files`) and every command. It refuses `*.tf`, `*.tfvars`,
   a `terraform/` or `.terraform` dir, `kustomization.y*ml`, YAML under `k8s/` or `manifests/`,
   `charts/*/templates/`, anything under `.github/`, `rulesets`, secret-like paths (`.env*`,
   `*secret*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`), a command that names kubectl, helm or
   an IaC tool, the default branch as the target, and a work repo other than the caller's.

On a failure the result is `needs_human` with `failed_check` (`intent`, `commands` or `scope`),
`intent` (the judge output), `plan_ref`, `plan_path` and `needs_max_section`: ready markdown with
the failed check, the reasons, the judge's quotes and the plan path. It never asks. Max rules in the
task, then the run is repeated in build mode with the same `plan_ref` and `confirm: "auto"`.

When all gates pass, the same run continues into build mode with the `plan_ref` it just made. It
skips preflight and workspace (already done in this run) and runs the shared verify path
(load-ref, verify). The result carries `auto_confirmed: true` and `intent`.

Build mode with `confirm: "auto"` re-runs G1-G3 before any writer: intake re-reads the sealed task
(`intake:rulings`, so new ledger rulings count), the script checks that it resolves to the same
source and repo, and the intent judge runs again (`:rerun` labels). A failure returns the same
`needs_human` shape. A ref made before 2.1.0 has no `plan_diff` and stops with "re-run plan".

### Build mode

args: `{mode: "build", plan_ref, date, project?, confirm?}`.

| Step | Agent              | Gate in script code                                                        |
| ---- | ------------------ | -------------------------------------------------------------------------- |
| 1    | -                  | tiny `plan_ref` shape wrong -> `needs_human` before any agent              |
| 2    | preflight          | as in plan mode                                                            |
| 3    | workspace (infra)  | reuses the fleet branch and worktree                                       |
| 4    | load-ref (r/o)     | ref file at `plan_commit`: sha256, seal, branch, repo (below)              |
| 5    | verify (read only) | plan hash at `plan_commit` and HEAD; HEAD position (below)                 |
| 5a   | auto gates         | `confirm: "auto"` only: G1-G3 against the current rulings                  |
| 6    | test writers       | one per criterion, in parallel, all in the ONE fleet worktree, uncommitted |
| 7    | hasher (ownership) | HEAD unchanged; changed paths = the pending criteria's reported files      |
| 8    | test judge         | `revise` routes findings to the named writers only; 3 rounds max           |
| 9    | hasher (freeze)    | test files and runner config; `freeze_tree` = the worktree tree            |
| 10   | coder              | works uncommitted; status checked after the hash check                     |
| 11   | hasher             | HEAD moved -> stop; any changed, new or removed hash key -> round rejected |
| 12   | code judge         | `fix_code` -> coder; `fix_tests` -> test judge; `plan_wrong` -> re-plan    |
| 12a  | -                  | `approve` with an unmet obligation -> `fix_code` (counts as a round)       |
| 13   | commit (infra)     | `git add -A`, staged tree = `code_tree`, ONE commit WITH hooks (below)     |
| 14   | push (infra)       | pushes the commit; a hook rejection -> coder (`fix_code`)                  |
| 15   | pr-opener          | draft PR at `approved_sha` (the commit step's HEAD)                        |
| 16   | review             | pr-review, plus the non-weakening sweep for gate changes (below)           |
| 17   | write-back         | ledger section and one marked comment per external source                  |

### No commit before approval

Many repos run the full test suite in a pre-commit hook, so a commit of RED tests always fails, and
hooks are never bypassed. So nothing commits until the code judge approves.

- **Writers** all work in the one fleet worktree (`main_worktree`), concurrently, on disjoint
  `test_files`. They never commit. After each writer round the hasher lists the changed paths: the
  tree delta from the state at the round start (`git diff --name-only <base_tree> <tree>`) plus
  every changed hasher-map key (an ignored conftest, an ignore rule). The script checks that HEAD
  did not move ("writer committed"), that every writer's `files` holds only its own criterion's
  test files ("writer AC1 touched <p>"), that every changed path is a test file of a criterion
  pending this round ("writer touched <p>"), and that every changed path was reported in a
  writer's `files`.
- **The coder** works uncommitted too. The post-coder hasher stops the run when HEAD moved
  ("coder committed"). The hash and fingerprint gates work on the files, as before.
- **Tree fingerprint.** A worktree state is `{head, tree}` plus the hasher maps. `tree` is built in
  a temporary index outside the worktree: `GIT_INDEX_FILE=<tmp> git read-tree HEAD`, `git add -A`,
  `git write-tree`. The real index is not touched and no hook runs. A judge's before and after
  states must match in HEAD, tree and every hasher map (the maps cover ignored runner config, which
  the tree does not). `freeze_tree` is the tree at freeze; `code_tree` is the tree the code judge
  judged. Test judge and code judge get `freeze_tree`, `code_tree` and `plan_commit`; diff
  production changes with `git diff <freeze_tree>`.
- **Scope fence on the real changes** (every mode, not only `confirm: "auto"`). The post-coder
  hasher lists every path this build changed (`git diff --name-only <plan_commit> <tree>`, the
  tree holding untracked files too), and the writer-round listing does the same per round. Verify
  fences the commits already on the branch (`git diff --name-only <plan_commit>..HEAD`) before any
  role runs. The review paths and the sweep trigger also diff from `plan_commit`. Any
  path the fence refuses (IaC files, Kubernetes and Helm manifests, `.github/`, rulesets,
  secret-like paths; see G3) stops the run with `needs_human` naming the path
  (`stop_gate: scope`), before anything is committed.
- **Commit step** (`infra:commit:r<n>`), after the code judge approves and the obligations gate
  passes: `git add -A`; the staged tree (`git write-tree`) must equal `code_tree` ("staged tree X
  != code tree Y", nothing committed); then ONE `git commit` WITH the hooks, never `--no-verify`,
  never `--amend`. The step then builds the worktree tree again.

  - The commit fails and the worktree tree still equals `code_tree`: a hook rejected it. The hook
    output tail goes to the coder as `fix_code`; the changes stay staged; this counts as a code
    round.
  - The worktree tree differs from `code_tree` (an auto-formatting hook rewrote files), or the
    committed `HEAD^{tree}` differs: `needs_human` "hook modified files". Never auto-accepted.
  - Success: `approved_sha` = the new HEAD.

  The first commit's subject is `feat(<task id>): <slug words>`; each later one (a review or hook
  fix) is a NEW commit `fix(<task id>): code round <n>` (the PR squash-merges).

Load-ref: an infra step returns `git show <plan_commit>:<ref_path>` and its sha256. Both must
equal `ref_sha256`, the inner seal must hold, and the file's branch, repo and task id must match the
tiny ref. Any mismatch stops with `needs_human` before any role runs. The script then uses the
loaded ref. The ref file is also frozen: the hasher hashes it as a read-only config key, so a coder
or writer that edits it trips the freeze.

Verify: the sha256 of `plan_path` at `plan_commit` must equal `plan_sha256`, or the run stops with
"plan changed since approval". HEAD must equal `plan_commit`, or descend from it by commit-step
commits of this plan only (`feat(<task id>): <slug words>` and `fix(<task id>): code round <n>`),
with `plan_path` and the ref file unchanged. Anything else stops with the same reason.
Stage-plan, commit-plan and verify run the same embedded hash program.

The risk tier is still computed and logged (short = `est_diff_lines < 20` AND `new_behaviour`
false), but the fleet always takes the full path: no role prompt supports a coder without frozen
criterion tests. A criterion with `test_files: []` is manual: it gets no writer, no frozen entry and
no disjointness check, and it still reaches the PR opener so a human sees it.

Worktrees live under `<repo>/.claude/worktrees/fleet-<task id>-<slug>/` (`main`, `scratch`,
`replan-<n>`). The workspace step adds `.claude/worktrees/` and
`.claude/settings.local.json` to the repo's `info/exclude` when they are not already ignored.

### plan_wrong

A `plan_wrong` verdict stops the build. The script:

1. takes the code judge's `plan` findings and parses each `Proposed plan change: <line>` into
   `proposed_plan_change[]` (a finding without that line is used whole and logged);
2. creates a detached worktree at the old `plan_commit`, runs scope-and-plan (the findings are an
   extra `text` source) and plan-audit there, and commits the new plan there;
3. saves the old head as branch `fleet/<task id>-<slug>--superseded-<n>` and the uncommitted work
   (the judged tree) under `refs/fleet/<task id>-<slug>/superseded-<n>-tree` (`git update-ref` to
   the tree object; no commit is created, nothing is pushed), then resets the fleet branch to the
   new plan commit and runs `git clean -fd` (never `-x`);
4. returns `awaiting_confirmation` with `proposed_plan_change`, `plan_findings`, `superseded_ref`,
   `superseded_tree_ref` and a fresh `plan_ref`.

The next build run starts fresh from the new plan, with a new freeze. Round and agent caps reset per run; `cumulative` counts runs, re-plans and
agents across runs.

### Write-back

After the review, build mode writes back once. A failure here never changes the run status.

### Resume (run-state)

A build re-run with the same `plan_ref` resumes at the last completed gate.

After each milestone an infra step records the run-state: `refs/fleet/<task id>/state` points at an
annotated tag object made with `git mktag` (no tag name, no hook, index untouched, never pushed).
Its target is HEAD (the approved commit). Its message is JSON: `plan_commit`, `ref_sha256`,
`seal`, `last_gate`, `approved_sha`, `code_tree`, `maps_digest` (sha256 of every hasher map at the
approving code-judge run), PR number and URL, review, rounds, `suite_result`, `gates_not_run`,
the intent result and, at the end, the write-back result. The milestones, in order:

| `last_gate`    | recorded after    | a re-run resumes at                  |
| -------------- | ----------------- | ------------------------------------ |
| `committed`    | the commit step   | push                                 |
| `pushed`       | the push          | the pr-opener                        |
| `pr_open`      | the PR opens      | the review                           |
| `reviewed`     | the review passes | write-back                           |
| `written_back` | write-back        | nothing: returns the recorded result |

Every ref under `refs/fleet/` (name and target) is in the frozen git map, at freeze and around
every writer, coder and judge step. A role that creates, moves or deletes one is a violation ("run-state ref
touched by role"). Only the workflow's own state write moves it; the snapshot follows that write,
and the resume digest leaves the ref out.

Right after verify, build mode reads the run-state (`infra:read-state`). It resumes only when the
state's `plan_commit`, `ref_sha256` and `seal` match the plan ref, its target and HEAD equal
`approved_sha`, `HEAD^{tree}` equals `code_tree`, the worktree is clean, and a fresh hasher run
(`hasher:resume`) gives the same `maps_digest`. It logs `resuming at <step>` and runs no writer,
coder or judge. Any failed check stops with `needs_human` "run-state mismatch: <which>"
(`stop_gate: resume`). A resumed step that would need a coder round (a pre-push hook rejection, a
blocking review) stops with `needs_human`: a resumed run has no freeze to code against.

With no run-state but build commits on the branch past `plan_commit` (a branch from 2.0.x, or a
run that stopped before its first state write), the build stops with "approved but unresumable:
branch has build commits without run-state; push manually or delete branch". It never re-runs the
writers on a committed fleet branch. A run-state of another plan is ignored (and logged) when HEAD
is the plan commit, for example after a re-plan.

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

### Threat model

The freeze guards against **reward hacking**: a writer or coder that weakens tests or gates to get
green. It is **not** a security boundary against a hostile agent. Every role already has a shell
with the user's credentials and runs repo code through the tests, so no hashing can contain a
hostile coder.

Defended (each by a gate in script code):

- test and gate weakening: frozen test files, runner config and sections, ignore rules, symlinks,
  bytecode purge, the code judge's checks;
- edits to frozen files, including the plan ref;
- edits to the hook and git-config surface the commit step relies on (`.pre-commit-config.yaml`,
  local hook scripts and their dirs, the hooks dir, local git config, `.gitattributes`);
- scope escapes: the scope fence on the planned paths (`confirm: "auto"`) and on the real changed
  paths (every mode), writer ownership, the ignored-path listing;
- planner-command injection: `test_cmd` and `check_cmd` pass a script allowlist and Max approves
  them verbatim (or G2 checks them), and the workflow script runs none of them.

Not defended:

- a hostile agent with a shell: it can run anything the user can, outside the worktree too;
- in-environment exec vectors: git filter drivers that act during the hasher's own `git add`,
  interpreter flag clusters (for example `-xc` in a hook entry), nested git config includes,
  the transport git config left unfrozen for resume (for example `credential.helper=!<command>`,
  `core.sshCommand`), virtualenv and `node_modules` internals beyond the startup hooks, and
  anything else that runs code without changing a frozen key.

#### IaC hooks

The user rule forbids any agent to cause terraform, tofu or tfp to run. The one exemption is a
pre-existing pre-commit hook that runs fmt, validate, tflint or docs at `git commit`, with the
backend off. Pre-push hooks are not exempt. The fleet runs the repo's hooks at its commit step and
at its push step, so the script checks the hooks first.

- An infra step (`infra:iac-hooks`, read-only, `fleet:judge`) reads `.pre-commit-config.yaml` at
  the plan commit with `git show` and PyYAML. It runs once per build, after verify, and a resumed
  build reads it too. The script decides in code which hooks are IaC hooks.
- An IaC hook is a hook whose id, name, entry, args or repo URL matches
  `terraform|tofu|\btfp\b|tflint|terragrunt|tfsec|infracost|checkov.*terraform`, or a hook from
  `antonbabenko/pre-commit-terraform` or `tofuutils/pre-commit-opentofu`.
- Effective stages: the hook's `stages`, else `default_stages`, else `pre-commit` and `pre-push`
  (pre-commit's default includes pre-push). `commit` and `push` count as `pre-commit` and
  `pre-push`.
- Any IaC hook at `pre-push`: the build commits, records run-state `committed`, and stops before
  the push with `needs_human`, `stop_gate: "iac"` and "pre-push hooks run IaC tooling (<ids>);
  push by hand". A resumed run stops at the same place.
- An IaC hook at a commit-time stage (`pre-commit`, `commit-msg`, `prepare-commit-msg`,
  `pre-merge-commit`, `post-commit`) stops the build before the commit step, unless its id is
  `terraform_`/`tofu_` + `fmt`, `validate`, `tflint` or `docs` at the `pre-commit` stage.
- The plan commit (plan mode and re-plan) runs the repo's commit hooks too. Before it, an infra
  step (`infra:iac-hooks:commit-plan`) reads the config at `HEAD`, and the same commit-stage rule
  stops the run with nothing committed.
- The commit step re-checks the rule. The frozen `.pre-commit-config.yaml` must hash to the copy
  that was checked; a mismatch stops with `stop_gate: "iac"`.
- An unreadable config (no PyYAML, a parse error, a bad revision) stops before the commit. An
  absent config means no IaC hooks.
- `confirm: "auto"` refuses at G3 (`failed_check: "scope"`) any repo with an IaC hook at any stage:
  "repo hooks run IaC tooling".
- `tflint` and `terragrunt` are forbidden words in `test_cmd`/`check_cmd` and in the G3 command
  fence.

Not covered: hooks outside the root `.pre-commit-config.yaml` (husky, lefthook, a hand-written
script in the hooks dir, a `pre-commit -c <other config>` entry), stages other than the commit-time
stages and pre-push (for example `post-checkout` during worktree creation), and whether an
exempt `terraform_validate` hook really runs with the backend off. The script cannot verify these.

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
- the hook surface: the whole `.pre-commit-config.yaml` (anywhere), `git:core.hooksPath` (its
  value, `UNSET` when not set) and every file under the hooks dir git uses (`git:hooks/<file>`).
  For each `repo: local` hook of the root config, the `entry` and every `args` item are
  shell-split; `-m <mod>` resolves to `<mod>.py` or `<mod>/__init__.py`. A launcher as the first
  word (`uv`, `uvx`, `poetry`, `pipx`, `npx`, `pnpm`, `yarn`, `npm`, `hatch`, `pdm`) and its
  subcommand words (`run`, `exec`, `--`) are accepted, and resolving goes on from the next token.
  When any local hook uses a launcher, the script tables are frozen as sections:
  `package.json#scripts`, `pyproject.toml#project.scripts`, `#tool.poetry.scripts`,
  `#tool.pdm.scripts` and `#tool.hatch.envs.*.scripts`. `npm|pnpm|yarn run <name>` needs `<name>`
  in `package.json` `scripts`; `npx`/`uvx`/`pnpm exec <tool>` needs the tool in `node_modules/.bin`
  or `.venv/bin` inside the repo, or declared in `devDependencies` or a pyproject dependency table
  (a PATH lookup alone is not enough). The words after such a script or tool are its arguments:
  repo files among them are frozen, other words are accepted. The whole dir tree of
  every repo file named this way is frozen (tracked and untracked-not-ignored). A `-c` payload, or
  a token that is neither a repo file nor a binary on PATH, is suspicious and stops the run at
  freeze ("unresolvable local hook <id>"). The commit step runs these hooks, and G2 checked the
  hook ids at the plan commit, so the coder may not change them;
- git config exec vectors: `git config --local --list` (sorted, with values; `branch.*` is left
  out because the workflow's own push sets it, and the transport settings `remote.*`, `url.*`,
  `credential.*`, `http.*` and `core.sshCommand` because a human may fix them before a resumed
  run; none of them weakens a test or a gate), the worktree
  config when `extensions.worktreeConfig` is on, every `include.path`/`includeIf.*.path` target,
  every `.gitattributes` and `info/attributes`. So a coder cannot add an fsmonitor, a filter
  driver or an include. The hasher's own git calls and the commit step run with
  `GIT_CONFIG_NOSYSTEM=1` and `-c core.fsmonitor=false`; the commit step also pins
  `-c core.hooksPath` to the frozen value (or git's default hooks dir);
- ignored files (map `ignored`): `git ls-files --others --ignored --exclude-standard`, minus the
  tool caches (`__pycache__`, `.pytest_cache`, `.hypothesis`, `.ruff_cache`, `.mypy_cache`,
  `.import_linter_cache`, `node_modules/.cache`) and build or coverage output: the dirs `build/`,
  `dist/`, `htmlcov/` and `.eggs/` at the top level only, and `coverage.xml`, `.coverage`,
  `.coverage.*` and `junit*.xml` at the repo root only. `*.egg-info` and `EGG-INFO` stay frozen
  anywhere (their `entry_points` can register pytest plugins); they and the venv startup-hook rule
  are checked before these exclusions. Inside `.venv`, `venv`, `.tox`,
  `.nox` and `node_modules` only `*.pth`, `sitecustomize.py` and `usercustomize.py` count. A new or
  changed ignored path after a writer round or a coder round is a violation ("ignored path
  written: <p>");
- sections, hashed under `<path>#<section>` after canonicalisation (sorted keys, compact JSON):
  `pyproject.toml#tool.pytest` (every `[tool.pytest.*]` table), `package.json#jest`,
  `package.json#vitest`, `package.json#mocha`, `package.json#scripts.test`. The rest of these files
  (dependencies) stays editable. A missing section hashes as `ABSENT`, so adding one is a change.

The comparison runs in the script, never in an agent. A key that appears (for example a new
`conftest.py`), disappears or changes rejects the coder round, whatever the code judge says. Roles
receive only the criterion test files in `frozen_tests`. Everything else (whole-file runner config,
`.gitignore` files, sections, ignore rules outside the worktree, symlinks) goes in
`frozen_config_sections`; `symlink:` values are link targets, not hashes. Roles also receive
`freeze_ref` (HEAD at the latest freeze), `freeze_tree` and `code_base_ref` (HEAD at the first
freeze).

Frozen files stay byte-equal between freezes. The only exception is an approved `fix_tests`
round: its writers may revise frozen tests in place, and the script then re-freezes. In that
re-freeze, only the test files of the criteria named in the code judge's `fix_tests` findings may
change. Any other changed key (another criterion's tests, runner config, ignore rules, symlinks)
stops the run with "re-freeze touched unrouted path" (the ownership check after each writer round
catches most of these first). Each re-freeze is recorded in `refreeze_log` (`round`,
`freeze_tree_before`, `freeze_tree_after`, `changed`). On a re-entry, the writers work in the fleet
worktree on top of the coder's uncommitted code; each writer and every test-judge round get the
code judge's findings (writers: only those for their criterion), and the test judge gets
`code_tree`.

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
`node_modules`, `.claude/worktrees`) and returns the count. The judge's "before" state is taken
after the purge. The judge fingerprint leaves the `suspicious` list out (a test run may leave
bytecode); the freeze and post-coder checks act on it. The writers, both judges and the coder get
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
unique `id`, a known `kind` and an `instruction`. Plan-audit, the coder and the code judge get
`repo_obligations` and `test_cmd`; the writers and the test judge get `test_cmd`. Every test run
uses `test_cmd` with `test_cmd.env` first and `test_env` on top. The coder satisfies every
obligation in its uncommitted changes and reports `obligations_done`.

**The workflow script runs no planner-supplied command.** Obligations are enforced three ways:

1. **The repo's own hooks.** Pre-commit hooks fire on the commit step (`infra:commit:r<n>`).
   Pre-push hooks fire on the workflow's push (`infra:push`). Neither bypasses them.
2. **The code judge.** It returns `obligations_check: [{id, met, evidence}]`, judged from the diff;
   it may run an obligation's `check_cmd` at its own judgement. On `approve`, the script requires
   every obligation to be `met: true`; otherwise it converts the verdict to `fix_code`, routes the
   unmet obligations to the coder and logs "obligations gate". That round counts toward the 3 code
   rounds.
3. **Push hook rejection goes back to the coder.** The push step classifies its result as
   `push_result: ok | hook_rejected | network | non_ff | remote_rejected`, on git's own lines only
   (lines that start with `error:`, `fatal:` or ` ! [`), never on the hook's output or the remote
   URL. Checked against real git output: a failing local pre-push hook gives exit code 1 and only
   `error: failed to push some refs`; a non-fast-forward gives ` ! [rejected] ... (fetch first)` or
   `(non-fast-forward)`; a network error gives exit code 128 and a `fatal:` line. `hook_rejected`
   is not a stop: the script routes the hook output tail (`hook_tail`) to the coder as a `fix_code`
   finding. The round counts as a code round, and the code judge must approve again before the next
   push (`infra:push:p<n>`). `non_ff` and `remote_rejected` (` ! [remote rejected]`: a server hook
   or branch protection) stop with `needs_human`; `network` is retried 3 times with backoff and
   then fails.

#### Command safety

`test_cmd` and every `check_cmd` come from the planner, and the planner reads untrusted ticket and
issue text. So:

1. **Allowlist (script code, plan mode and again in build mode).** Every token must be plain:
   letters, digits and `_ . / : = @ % + , -`. No quote, glob, `; & | $ ( ) < >`, backquote or
   newline. `test_cmd.command` may also hold the `<paths>` token, and must start with a test
   runner: `pytest`, `python[3] -m pytest`, `uv run [--frozen] [--no-sync] [--extra <x>]... pytest`,
   `npm test`, `npm run test[:<name>]`, `npx jest`, `npx vitest`, `pnpm test`, `yarn test`,
   `cargo test`, `go test` or `make test`. Every argument after the runner is denied by default
   ("test*cmd arg <x> not allowed"). The whole raw command may hold only `[A-Za-z0-9*./:=<>"() -]`with plain spaces (0x20), checked before tokenizing, because the shell also splits on tab,`\v`,
`\f`, `\r`and unicode spaces; it is split on plain spaces only. Allowed: the`<paths>`token;
relative paths that match`^[A-Za-z0-9\_][A-Za-z0-9_./-]\*$`with no`..`segment (so no`@file`,
   which pytest reads as an args file); and flags on a per-runner list:

   - pytest: `-q -v -vv -x -s -n<N> -n0 --maxfail=<N> -k <expr> -m <expr> -p no:<name> --tb=short|line|no|long -ra -rA --no-header --durations=<N> --timeout=<N>`.
     A `-k`/`-m` expression is one plain word, or words of `[A-Za-z0-9_()]` in double quotes
     (`-k "foo and not (bar or baz)"`); no other quoting anywhere.
   - go test: `-run <word> -count=<N> -v -race -short`, plus paths and `./...` or `./<path>/...`.
   - cargo test: `--lib --tests --all-features --workspace -q`, then optionally `--` and test
     names (`word` or `mod::word`).
   - npm, pnpm and yarn test: nothing, or `--` followed by paths.
   - jest and vitest: `--run --silent --passWithNoTests` (and `vitest run`), plus paths.
   - make test: no arguments.

   A URL (`://`) and the words `install`, `add` and `pip` are refused as well. A `check_cmd` must
   be exactly one of:

   - `pre-commit run <hook-id> [--all-files] [--hook-stage <stage>] [--from-ref <ref> --to-ref <ref>]`
   - `make <target>`
   - `[uv run [--extra <x>]] python[3] <dir>/<path.py> [plain args]`
   - `<dir>/<path/to/script> [plain args]`

   where `<dir>` is `scripts`, `bin`, `tools`, `hack` or `ci`; the path has no `.venv`, `venv`,
   `node_modules`, `.git`, `__pycache__` or `.tox` segment in any letter case; its extension is
   `.py`, `.sh`, `.bash` or none; and its file name is not an interpreter or package manager
   (`python*`, `pip*`, `node`, `npm`, `npx`, `sh`, `bash`, `zsh`, `uv`, `make`). In plan mode a
   read-only infra step (`infra:check-scripts`, `fleet:judge`) runs a fixed program that checks
   each script path is a tracked regular file, not a symlink, whose realpath stays under the same
   root. A failure, or a missing result, makes the obligation judge-only. The build runs the same
   check again (`infra:check-scripts:r<n>`) in the main worktree right before every code-judge
   run, at the commit the judge sees; an obligation that fails reaches the judge without its
   `check_cmd` (as `check_cmd_rejected`) for that round.

2. **Forbidden words.** The words terraform, tofu, tfp, digger and atlantis, anywhere in a command
   and in any case, refuse it.
3. **Env allowlist.** `test_cmd.env` may hold only `DJANGO_SETTINGS_MODULE`, `PYTHONUNBUFFERED`,
   `TZ`, `LANG`, `LC_ALL`, `NO_COLOR`, `FORCE_COLOR` and `CI`, with plain values. Any other name
   stops the plan ("test_cmd env <NAME> not allowed").
4. **Human approval.** Plan mode returns `commands`: the `test_cmd` (with its `env` and `tools`)
   and every `check_cmd`, verbatim, each with `rule_source` and `run_by` (`roles`,
   `code-judge (optional)`, or `nobody` for a refused one, with its `note`). The skill shows them
   verbatim in the confirmation question. They live in the sealed `plan_facts`, so roles run only
   commands Max saw.

A `test_cmd` that fails any check stops the run with `needs_human` (`stop_gate: commands`). A
`check_cmd` that fails is never offered to a role: the obligation keeps `check_cmd_rejected` and
`check_rejected_reason`, the run logs `<id> check_cmd refused (judge-only)`, and the code judge
rules on it from the diff.

### Role contract

The script pins the role contract, not the prose:

- `EXPECTED_VERSIONS` holds the minimum role-page versions. Preflight reads each page's version. A
  lower version (stale or rolled back) stops the run; a higher one is logged as "prose-only changes
  assumed" and returned as `role_versions`.
- Every role page carries `CONTRACT: fleet-v3` under its DISPATCH line. Preflight and every role
  runner report the marker; any other value stops the run. `agent_prompt_save` strips a page's
  final newline, so the parsing never needs one: the last line counts like any other.
- 2.1.1 pins: scope-and-plan 24, plan-audit 13, fleet-test-writer 9, fleet-test-judge 9,
  fleet-coder 16, fleet-code-judge 13, fleet-pr-opener 10, fleet-intent-judge 2, pr-review 17,
  gate-change-nonweakening-sweep 4.
- Each role runner reports the version and marker it loaded. A value that differs from preflight
  (the page changed mid-run) discards the result.
- `REQUIRED_ON_OK` lists the keys each role must return with `status: ok`, and verdicts are
  checked against the frozen enums. fleet-v3: the writer returns `criterion_id, tests, files`; the
  coder `changed_paths, suite_result, added_symbols, frozen_tests_red_at_start, obligations_done`
  (no `commit`/`commits` key any more); the intent judge `verdict, deviations, coverage`;
  pr-review `verdict, findings, touches_gate, checked`; the sweep `verdict, units, findings`. A missing key or an unknown verdict is contract drift and stops
  the run.
- Stop reason precedence: (1) a script gate violation (hash, fingerprint) with that gate's own
  reason; (2) the role's own `needs_human`/`failed` reason; (3) contract drift, only when
  neither applies. The coder's hash check runs before its contract check, and a judge's fingerprint
  check before its contract check. The result's `stop_gate` names the gate: `hash`, `fingerprint`,
  `commands`, `contract`, `role`, `cap`, `ownership`, `commit`, `review`, `intent`, `scope`,
  `resume` or `iac` (`null` when the run did not stop at one of them). A cap stop names the gate that rejected the
  last round (hash, obligations gate, commit hook, push hook or review).

### Models

Each role, the reviewer and the sweep included, runs on the tier named by the first
`DISPATCH: model=<tier> (fallback=<tier> ...)` line of its role page. Preflight returns those
lines; the script parses them. Accepted tiers: `fable`, `opus`, `sonnet`, `haiku`. No tier is
hardcoded: a missing, unparseable or unknown line stops the run in preflight (`stop_gate:
contract`). A role agent that dies is retried once on the page's fallback tier, when one is set,
never on any other; the retry counts toward the agent cap. Every role dispatch logs
`model used: <label> -> <tier>`. Infra agents (preflight, intake, workspace, branch-scan,
stage-plan, commit-plan, load-ref, verify, hasher, commit, push, review paths and cleanup,
write-back) run on `sonnet`.

### Independent review

After the commit step, the push and the pr-opener (draft PR open):

1. `infra:review-paths:v<n>` (read only) lists `changed_paths` =
   `git diff --name-only <plan_commit>..<approved_sha>`.
2. `pr-review` (library pattern, `fleet:judge`, fingerprinted on the fleet worktree) gets
   `pr_url`, `pr_number`, `repo`, `base_ref`, `head_sha`, `worktree`, `scratch_dir`, `criteria`
   (`[{id, text}]`), `repo_obligations`, `changed_paths`, `mode: "self-authored"` and
   `fleet: true`, and no tldr or plan reasoning. It returns `verdict`, `findings` (each
   `{id, severity, category, file, line, summary, evidence}`, severity `blocking` or `nit`),
   `touches_gate` and `checked`. Any blocking finding makes it `changes_requested`, whatever the
   stated verdict.
3. The non-weakening sweep (`gate-change-nonweakening-sweep`, same inputs) runs when
   `touches_gate` is true or a changed path names a hook, gate, guard, validator, policy, auth rule,
   check or CI file, `.github/`, `.pre-commit-config*` or a `Makefile`. A `weakening` verdict is a
   blocking finding.
4. Probes run in detached worktrees under `scratch_dir`. `infra:review-cleanup:v<n>` always runs
   afterwards, even when the review stops the run (`git worktree remove --force` for every
   worktree under `scratch_dir`, then `git worktree prune`).

Blocking findings go to the coder as `fix_code`, then hasher, code judge, a NEW commit, push, the
pr-opener updates the PR body, and the review runs again. A review fix counts as a code round. At
most one extra review round: a second blocking review stops with `needs_human` and the findings
(`stop_gate: review`). Nits go to the pr-opener as `review_notes`. The result carries
`review: {verdict, blocking, nits, rounds, sweep, model}`. Without a PR the review is skipped and
listed in `gates_not_run`.

### Judge separation

Judges (test, code, intent, pr-review, sweep), preflight, intake, branch-scan, load-ref, verify,
the pre-commit id read, the review path listing, the comment listing and the hasher run as the
`fleet:judge` agent, which has `Write`, `Edit` and `NotebookEdit` disallowed. `Bash` stays, because
the code judge must run the suite. The backstop is a worktree state (HEAD, the temp-index tree and
every hasher map) taken before and after every judge run. Any difference discards the verdict and
returns `needs_human` with reason `judge mutated worktree` and the changed parts. This catches a
suite that leaves tracked or unignored changes, and ignored runner config, too. It does not catch a
change that a judge makes and reverts within its own run.

### Limits

- Agent cap 100 per run (60 before 2.1.0). With `confirm: "auto"` one run holds the plan, the
  gates, the build and the review: a two-criterion happy run uses about 35 agents, and one review
  fix round adds about 13. Every cap hit is logged. Test rounds: 3 per entry into the test loop. Code rounds: 3 per build
  run; a `fix_tests` detour, a commit-hook rejection, a push-hook rejection and a review fix each
  count as one code round.
- Nothing is committed before the code judge approves, so a build interrupted before its commit
  step leaves uncommitted tests and code in the fleet worktree. The workspace and verify steps
  require a clean worktree, so a re-run stops with `needs_human` until a human commits, stashes or
  cleans that work. After the commit step, a re-run resumes from the run-state instead.
- The ownership check sees what the writers left in the tree; it cannot tell which concurrent
  writer wrote a file beyond each writer's own `files` report.
- G2 needs PyYAML in the `python3 -I` interpreter; without it every `check_cmd` fails the gate.
- The intent judge reads rulings from the ledger task body; a ruling kept elsewhere is not seen.
- A test run that leaves ignored output outside the cache and build-output lists (for example a
  new `*.egg-info`) changes the `ignored` map: after a judge it reads as "judge mutated worktree",
  after a writer or the coder as "ignored path written".
- The hook surface is frozen, so a change that must edit `.pre-commit-config.yaml`, a local hook
  script (or anything in its dir) or the hooks dir cannot pass the fleet. A local hook whose
  command uses a word that is neither a repo file, a binary on PATH nor a launcher subcommand
  stops every run at freeze. The real-change scope fence likewise stops any
  change to `.github/`, IaC, Kubernetes, rulesets or secret-like paths, in every mode.
- A re-plan after `plan_wrong` saves the uncommitted work with `git commit-tree` (a plumbing commit
  object on a side branch, no hooks). That is not a `git commit`, and it is never pushed.
- The fleet runs no held-out examples and no mutation, coverage or scanner gates. Judges receive
  explicit `{status: "not_run"}` markers, and `gates_not_run` reaches the PR opener and the result.
  The planner's `held_out_examples` are dropped before any other role sees the plan. The script
  cannot check that the planner kept them out of the plan doc itself.
- Verify tells fleet commits apart by their subject lines only; git cannot prove who made a commit.
  The plan-file checks (hash at `plan_commit` and at HEAD, no commit touching it) do not depend on
  that.
- The pr-opener role pushes the branch too. The script pushes first, so the role's push is a no-op.
- Each push attempt follows an approve, so a hook rejection costs a full coder and judge round.
- The plan link in comments assumes a GitHub origin (`https://github.com/<owner>/<repo>/blob/...`).
- Interpreter startup hooks inside an in-worktree virtualenv are not detected. The walk skips
  `.venv`, `venv`, `.tox` and `.nox`, because an editable install writes a `.pth` file there and
  would cause a false mismatch. So a coder can drop a `.pth` or `sitecustomize.py` into such a venv
  and v1 does not see it. A planned follow-up (v1.1) hashes the startup hooks in the site-packages of
  the judge's interpreter.
- New files outside `allowed_additions` are not denied by script in v1 (the auto-mode scope fence
  checks the planned paths, not the coder's).
- A judge's test run that leaves untracked, unignored files (caches the repo does not ignore)
  changes the tree and stops the run. The workspace step adds `__pycache__/`, `.pytest_cache/` and
  `.coverage` to `info/exclude` to cut this down.
- Bytecode inside `.venv`, `venv`, `.tox` and `.nox` is not purged or checked. A pyc planted there
  for an installed module is not detected. A frozen test's pyc is caught only by name (its module
  stem); the purge, not the name check, is the main defence.
- A `.pyc` outside `__pycache__` that git does not ignore shows in `git status`. Purging it between
  the test judge and the freeze trips "worktree changed between test approval and freeze".
- Not yet executed in the real Workflow runtime; the scenario suite stubs the runtime.
- Command safety covers the commands the plan names, not the code they run. The test writers, the
  test judge, the coder and the code judge run `test_cmd` (and the coder or code judge an approved
  `check_cmd`) with the agent's normal environment, credentials included: running tests executes
  repo code, and that is inherent. What 2.0.3 adds is that the commands themselves are allowlisted,
  carry only allowlisted env names, and are approved by Max verbatim. The workflow script itself
  runs none of them.
- An approved `make` target, hook or script can still do anything its code does, and the coder can
  change that code. The allowlist only fixes the command line.
- The tracked-file and realpath checks on a `check_cmd` script are not verified by the script
  itself: an infra agent runs the fixed check program and the script trusts its report. They are
  re-run before every code-judge run, but the script's content is not judged; the code judge
  decides whether to run it.
- Obligations without a pre-push or pre-commit hook rest on the code judge's `obligations_check`
  alone. CI-only rules are caught by CI after the PR opens, not by the fleet.

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
  "review": {
    "verdict": "approve",
    "blocking": [],
    "nits": [],
    "rounds": 1,
    "sweep": null,
    "model": "opus"
  },
  "auto_confirmed": false,
  "intent": null,
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

`status: "needs_human"` from a failed auto gate adds `failed_check`, `intent`, `plan_ref`,
`plan_path` and `needs_max_section`.

## Tests

The workflow logic is tested with Node's built-in runner. The harness stubs the workflow runtime
and drives scripted role responses by agent label. One test runs the embedded hasher program
against a scratch git repo.

```bash
node --test 'plugins/fleet/tests/*.test.mjs'
```

Node 22+ (the glob form is required; `node --test <dir>` does not work on Node 24).
