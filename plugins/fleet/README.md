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

`confirm: "default"` (4.0.0, ADR-1186; the skill passes it unless the user names a mode) runs the
same three gates only for an eligible plan. A plan is eligible when the planner declared
`change_kind: bug_fix` and `new_behaviour: false`, no planned path is an IaC path, no re-plan
relaxed round 0, no parked prior was unreadable, and a task id input carries `project`. Any other
plan returns `awaiting_confirmation` with `confirm_reason`, as `ask` does. A failed gate is
`needs_human`, as under `auto`. With no `confirm` value the workflow asks.

The input is any of: a yadgar ledger id, a Jira key, a GitHub or Codeberg issue or PR URL, a plan
path, or free text.

## Install

```
/plugin marketplace add m-agahi/ccpm
/plugin install fleet@maxagahi-marketplace
```

## Requirements

- Claude Code with the Workflow tool (dynamic workflows) enabled.
- Nothing for the role prompts (5.0.0, R1): the ten role prompts ship in the plugin as
  `roles/<role>.md`: `scope-and-plan`, `plan-audit`, `fleet-test-writer`, `fleet-test-judge`,
  `fleet-coder`, `fleet-code-judge`, `fleet-pr-opener`, `fleet-intent-judge`, `pr-review` and
  `gate-change-nonweakening-sweep`. See "Role files" below. The memory and ledger steps still use
  the `yadgar` / `yaadgaar` MCP servers in this release (R2 makes them optional).
- `git`, `gh` (authenticated), and `python3` >= 3.11 (or `tomli`) in the target repo's environment.
- For Jira input or write-back: the Atlassian MCP server. For GitHub write-back: `gh-personal`. For
  Codeberg write-back: `$CODEBERG_TOKEN`. A missing tool makes intake stop, or makes that comment
  fail (reported in the result, the run stays ok).

## Flow

`args.mode` is `"plan"` or `"build"`. A missing or other value returns `needs_human` before any
agent runs.

### Plan mode

args: `{mode: "plan", input, repo, date, run_nonce, project?, confirm?}`. `confirm` is `"ask"` (the default:
return for confirmation) or `"auto"` (see below). Any other value returns `needs_human` before any
agent runs. `run_nonce` (2.1.5) is a fresh value per invocation (the skill passes `date +%s%N`);
every infra prompt carries it, so `resumeFromRunId` never replays a stale git or worktree check.
A missing nonce returns `needs_human` before any agent runs.

| Step | Agent              | Gate in script code                                                                                |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------- |
| 1    | preflight          | yadgar unreachable, a role missing, a low version or a wrong marker; an unshimmed IaC tool on PATH |
| 2    | intake (read only) | `needs_human` (ambiguous repo or ticket) stops before any other step                               |
| 3    | workspace (infra)  | creates or reuses branch `fleet/<task id>-<slug>` and its worktree                                 |
| 4    | branch-scan (r/o)  | any commit beyond origin/<default> that is not a plan commit -> stop                               |
| 5    | scope-and-plan     | criterion ids; disjoint test files; `tldr`; `plan_diff` is a string array                          |
| 5a   | callers (r/o)      | `changed_symbols` map well formed; `git grep -w` hits equal the map                                |
| 6    | -                  | short path when `est_diff_lines` < 20 and `new_behaviour` false: one test writer, every gate kept  |
| 7    | plan-audit         | verdict other than `approve` -> `needs_human`                                                      |
| 8    | stage-plan         | stages the plan doc; returns the sha256 of the staged bytes                                        |
| 9    | commit-plan        | commits the plan doc only, LOCALLY; writes the sealed ref as a git object                          |

Branch-scan: a plan commit has the subject `plan(<task id>): <slug>`, and its file set is exactly
`{plan_path}`. The scan reads `plan_path` from a sealed plan ref of the task
(`refs/fleet/<task id>/plan`, or an earlier one kept as `refs/fleet/<task id>/plan-<n>`) whose tag
target is that commit; paths are compared exactly after normalisation, with no prefix or extension
match. A commit with no such plan ref, a broken seal, another task's ref, or any other file (a
`.fleet/` path included) is a build commit. If the fleet branch carries any build
commit, plan mode stops with "branch has build commits; run build, or delete branch". It never commits a plan on top
of code. On a plan-only branch it adds a new plan commit.
Since 3.0.0 the scan is one program (`BRANCH_SCAN_PY`) and no plan-ref message text crosses the
relay: the program lists the commits (`{sha, subject, files}`, newest first) and, per plan ref,
the name, target, the sha256 of the message and its own reading of the message: `task_id`,
`plan_path` and `ref_ok` (the same checks as the script's `planRefProblem`: seal over canonical
JSON, required fields, brief shape, branch name). A test checks Python and JS agree on each
check. A message whose canonical form differs between the two (a float they print differently)
reads as not ok, so its commit counts as a build commit and the run stops (fail-closed).

**Program digests on relays (3.0.0).** Every read-only infra step whose output reaches a gate runs
one program and relays its output with the program's digest (sha256 over its canonical JSON);
the script recomputes it and stops on a difference: `infra:callers`, `infra:changed-defs`,
`infra:branch-scan` (failed), `infra:fleet-scan` (`stop_gate: scope`), `infra:read-state`
(`stop_gate: resume`), `infra:review-paths` (failed) and `infra:check-scripts` (a mismatch makes
every check_cmd script judge-only), plus the hasher. Since 3.1.0 also `infra:verify-plan`
(`VERIFY_SINCE_PY`, failed), `infra:commit-plan` (`PLAN_FILES_PY`, failed) and the push classifier
(`PUSH_CLASSIFY_PY`, a `hook_rejected` without it fails). The plan ref itself travels only as meta
entries or as sha256-checked chunks (`infra:load-ref`). The digest catches a relay that drops or
changes an entry; it is not a security boundary against a hostile relay (ADR-1152).

Plan mode returns `awaiting_confirmation` with `tldr`, `plan_diff`, `fleet_size`
(`{criteria, est_agents, est_rounds}`), `plan_path` and `plan_ref`. It makes no push, no PR, no
ledger write and no comment. The planner's `held_out_examples` are dropped: never returned and
never forwarded.

Caller coverage (2.1.6): the planner returns `changed_symbols`, every occurrence of each existing
function, guard or symbol the plan changes, as `{symbol, occurrences: [{at: "<path>:<line>",
criterion, dont_care}]}`; each occurrence maps to exactly one of an existing criterion id or a
`dont_care` reason. Step 5a greps each symbol (`git grep -n -I -w -F`, tracked text files, the plan
doc excluded; the relayed lists are checked against the program's digest). A malformed map, a hit
the map leaves out, a mapped line that is no hit, more than 100 hits for one symbol or more than 30
symbols stop the run with `needs_human`, or go to the one `:audit-fix` round under confirm auto.
The `:audit-fix` round must keep every symbol the refused round mapped and every symbol that one
of its findings names (narrower symbols only in addition); a dropped or swapped symbol stops the
run. A plan-audit routed finding may name its symbol in an optional `symbol` key (3.0.0); the
script carries it like a grep finding's. plan-audit gets
the map, `caller_check` (`{method, limits, occurrences}`) and, in the `:audit-fix` round,
`prior_round` (`{reason, findings, changed_symbols}`); the intent judge gets the map under confirm
auto. The grep reads the working tree content of the tracked files and is name-based: a call
through an alias, a re-export under another name, a name built at runtime, submodules, files git
treats as binary and other repos are not searched or not found. An empty `changed_symbols` is only
checked by the audit. A ref sealed before 2.1.6 builds without caller coverage (gate line).

Fixer hooks on build files (3.0.0, steps 6a and 10a): the one commit step must commit exactly the
approved tree (ADR-1151), so a pre-commit fixer that rewrote a file at commit time used to stop
the run. A program (`infra:format-tests:r<n>`, `infra:format-code:r<n>`, the default agent: it
writes) now runs `pre-commit run --files <paths>` in the fleet worktree until a run changes
nothing, at most 3 runs: on the round's test files before the ownership hash, the test judge and
the freeze, and on every path the worktree changes against HEAD, frozen files left out, before the
purge, the post-coder hash and the code judge. Judges and hashes then see the formatted bytes and
the commit-time hooks have nothing to rewrite. Exit codes are ignored (a check hook that fails,
such as a full-suite hook on RED tests, stays the commit step's business); only bytes count. The
program reports every path that differs between the worktree tree before the first run and after
the last, whatever hook changed it, with a digest. The run stops with `needs_human` when a hook
changed a frozen file (`stop_gate: hash`), a path outside the files it was given (`scope`), or
still rewrites after 3 runs (`commit`). No `.pre-commit-config.yaml`, no file to format or no
`pre-commit` binary: a gate line, and the commit step behaves as before. The commit step's
tree-equality check is unchanged.

Build-time caller check (3.0.0, step 12b): after the code judge approves a tree and before every
commit step, a read-only step (`infra:changed-defs:r<n>`, the `fleet:judge` agent) runs a program
over `git diff <plan_commit> <approved tree>` (`-U0`, renames off) for the files that existed at the
plan commit (modified, type-changed or deleted). For each hunk it reads the base blob: a removed
definition line, or a re-added one (then every base definition of that name), names that
definition; every added line is attributed on its own. A new definition at column 0 that opens a
block is an addition, and its deeper lines are its body. Any added line at indent > 0, a nested
definition and its decorators included, names the innermost base definition above it with a
smaller indent; the one exception is a new member of an existing class, struct, impl, interface or
trait (a new method), which records nothing (known limit: it may override an inherited method). A
decorator line belongs to the definition after it; a line that only closes a block names nothing.
Any other removed line names the innermost definition above it. A multi-line signature (`def f(`
... `) -> T:`, Go `func F(` ... `) T {`, a TS method) counts from its opening line, and an
Allman brace on its own line is stepped over to the signature above it. A decorated new member,
and a new nested class or struct, name the enclosing class. A rename onto an excluded path (a
criterion test, the plan doc) is checked as a deletion of the old file. JS
`X.y = function` and `X.y = (...) =>` are definitions. A renamed file is diffed old blob against
new blob at the base path, so only its real changes count. Each definition is printed as
`{name, at: "<path>:<line>", end}` (`end` = the last line of its body), every one of a name. The
program does this itself instead of reading git's hunk header: without a `diff=` attribute git
names the nearest column-0 line, the class rather than its method. It also prints `excluded`
(the criterion test files and the plan doc), `unclassified` (files no definition pattern covers,
and binary diffs) and `unattributed` (`<path>:<line>` of a change with no enclosing definition,
such as an added import). Path names are printed with non-printable characters escaped. The
relayed lists must match the program's digest.

The fixer program (3.0.0) runs the hooks in a scratch checkout of HEAD under `scratch_dir`
(`git worktree add --detach`, hooks off for that checkout only): only the selected files are
copied in, and only they are copied back. The hook surface is exact: the config, every path a hook
`entry` or `args` names, and the files of every `-m` module an entry runs (`a/b.py`,
`a/b/__init__.py`, `a/__init__.py`); a path that only appears in a `files:` or `exclude:` regex is
not hook code and is formatted. The config is read only with PyYAML (`yaml.safe_load`, in a
subprocess that prints JSON: `entry`, `args` and `language` of every hook of every repo, any YAML
form). The interpreter is pre-commit's own, which ships PyYAML: the program follows the
`pre-commit` executable's shebang, and a shell wrapper's `exec` target (pipx, nix), to that Python;
then it tries its own `python3`. A nix wrapped script adds its site-packages to `sys.path` itself;
the program reads those `/nix/store/.../site-packages` paths from the script and adds exactly
them, so the nix pre-commit's own Python finds PyYAML. The loader runs as `<python> -I -c` with
cwd `/`, so a `yaml.py` or `json.py` in the worktree is never imported. No interpreter with PyYAML:
the step is refused (the surface is unknown); there is no line parser. Every embedded program of
the workflow runs as `python3 -I` (no cwd on `sys.path`, no `PYTHON*` environment, no user site)
and takes the worktree as an argument; a test checks each invocation. When a surface path differs from HEAD, or a selected path goes
through a symlink (HEAD mode 120000, a symlinked parent at HEAD or in the worktree, or a realpath
outside either checkout), nothing runs (`refused`, `stop_gate: hash`). A helper that a hook entry
imports without the config naming it is a residual (ADR-1152). A scratch checkout a killed run left
behind is removed first. Each `pre-commit` run is capped at 180 s. A cache a hook leaves in the
scratch checkout is ignored.

The script then refuses, with `needs_human` and `stop_gate: "callers"` before anything is
committed:

- a definition whose name is no symbol of the sealed `changed_symbols`, or whose symbol has no
  occurrence in the same file inside the definition's lines (a same-named function in another file
  is not covered: "mapped only elsewhere");
- an unclassified file, an unattributed (module-level) change, or a definition whose name is no
  identifier (a hyphenated Makefile target, which `changed_symbols` cannot name), in a file the
  plan does not list explicitly: in `allowed_additions.files` or a repo obligation's `files`. An
  occurrence of a mapped symbol in that file does not count (a file that calls `foo` waives
  nothing else). A CHANGELOG or docs file an obligation lists passes; an added import needs its
  file in `allowed_additions.files`.

Every excluded and every unclassified path gets a gate line. The script cannot tell a coder's scope
creep from a planner's miss, so a human decides (re-plan with the symbol mapped, or narrow the
change); a `plan_wrong` re-plan would let the coder's edit widen the plan by itself.
Definitions are found by keyword (`def`, `class`, `function`, `fn`, `func`, ...), by JS arrow,
method and module-level `const`/`let`/`var` forms, by shell `name()`, by Makefile targets and
variables (`Makefile`, `*.mk`), by C-like signatures, and by module-level assignments (Python, JS,
shell, Go, Rust and Ruby constants). Extensionless files are classified by their shebang (python,
sh, bash, zsh, node). Limits: indentation-based and line-based; a decorator line counts as
module-level. A ref sealed before 2.1.6 (`changed_symbols: null`) skips the check with the gate
line "build caller check skipped".

Intake classifies the input and fetches its text: a ledger task through yadgar `task_get`, a Jira
ticket through the Atlassian MCP, an issue or PR through `gh-personal` or the Codeberg API, a plan
file, or free text. It returns `brief: {title, description, sources: [{kind, ref, url, body, id,
project}], repo, plan_path}`. `kind` is one of `ledger`, `yaadgaar`, `jira`, `github`, `codeberg`,
`plan` and `text`. `id` and `project` are null except on a `yaadgaar` source. `url` and
`plan_path` may be null. Free text, a plan and a ledger task work in the caller's repo.

Since 3.1.3 (ledger 1979) intake resolves a task id only by calling the ledger tool, and the tool's
answer is the truth. `args.project` is the ledger scope and is independent of `repo`: a
`yadgarhq/` project reads `mcp__yaadgaar__read_task(number)`, another project reads yadgar
`task_get(project_id=<project>)`, and no project tries both (`ledger: "either"`). The repo's
`.yadgar` files and origin never decide the ledger. A yaadgaar source carries the `id` (URN) of the
answer (`yadgar:task:<uuid>`), and `tried` must hold the `read_task` call that returned it; else it
stops (`needs_human`), and so does an answer that names a project other than `args.project`.
Intake lists every ledger call it made in `tried`. On a task-id input that stops, the script
appends the ledgers tried, their projects and the error text intake reports for each call
(unfiltered, labelled `error (as reported by intake agent):`) to the reason. It drops the agent-written reason or call when it
advises changing the repo's project id. `confirm: "auto"` with no `args.project` and a
task-id input stops before intake. Under `confirm: "ask"` the result carries `ledger_source`
(`ledger`, `ref`, `id`, `project`), and the reason names it. A Jira ticket that
names no repo, or several, stops with `needs_human`. The task id comes from the first ledger, Jira,
GitHub or Codeberg source (`plan` for an ingested plan, `task` for free text). The slug comes from
the brief title.

Since 2.1.4 the full plan ref is a local git object, never a file and never pushed: an annotated
tag object (`git mktag`, no tag name, index untouched, `core.hooksPath=/dev/null` so no hook runs)
whose target is the plan commit and whose message is the sealed JSON, at
`refs/fleet/<task id>/plan`. A re-plan moves that ref to the new plan commit and keeps the earlier
value as `refs/fleet/<task id>/plan-<n>` when its target or message differs. When HEAD is a
plan-only commit of the task and the staged plan doc is byte-identical to HEAD's, commit-plan makes
no commit (never `--allow-empty`) and the new ref targets HEAD. The plan commit holds `plan_path` only; nothing under
`.fleet/` is written, staged or committed, so a global `.fleet/` gitignore changes nothing. It
holds `branch`, `plan_path`, `plan_sha256`, `criteria`, `brief`, `task_id`, `slug`, `tldr`,
`plan_diff` (2.1.0), `plan_facts` (scope fence, estimate, `test_cmd`, `repo_obligations` and,
since 4.0.0, `change_kind` and `new_behaviour`), `history` (cumulative runs, re-plans and agents,
and since 4.0.0 an optional `preflight` record), `project` (4.0.0, ledger 1992: the plan run's
`args.project`, or null) and `seal`, the sha256 of the canonical JSON of the rest. A build without
`args.project` uses the sealed `project`. A build whose `args.project` differs from it stops with
"project mismatch". It holds no held-out example. Commit-plan
reads the ref back with `git cat-file tag`; the script checks that the commit holds exactly
`plan_path`, that the tag targets the plan commit, and that the message parses to the sealed ref.

The caller gets only a tiny `plan_ref`: `{branch, plan_commit, plan_ref, ref_sha256, repo}`, where
`plan_ref` is `refs/fleet/<task id>/plan` and `ref_sha256` is the sha256 of the tag message bytes.
The skill passes it back unchanged. A tiny ref with `ref_path` (2.0.1 to 2.1.3) stops with
`needs_human` "plan_ref predates 2.1.4; re-run plan"; there is no compatibility path.

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
   Since 4.0.0 the step runs on sonnet, and its output carries args and a digest the script
   checks before the gate; a mismatch stops the run (`stop_gate: contract`).
3. **G3 scope fence**, pure script code over every planned path (criteria `test_files`,
   `allowed_additions.files`, obligation `files`) and every command. It refuses `*.tf`, `*.tfvars`,
   a `terraform/` or `.terraform` dir, `kustomization.y*ml`, YAML under `k8s/` or `manifests/`,
   `charts/*/templates/`, anything under `.github/` or `.fleet/`, `rulesets`, secret-like paths (`.env*`,
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

args: `{mode: "build", plan_ref, date, run_nonce, project?, confirm?}`.

| Step | Agent              | Gate in script code                                                        |
| ---- | ------------------ | -------------------------------------------------------------------------- |
| 1    | -                  | tiny `plan_ref` shape wrong -> `needs_human` before any agent              |
| 2    | preflight          | as in plan mode                                                            |
| 3    | workspace (infra)  | reuses the fleet branch and worktree                                       |
| 4    | load-ref (r/o)     | ref file at `plan_commit`: sha256, seal, branch, repo (below)              |
| 5    | verify (read only) | plan hash at `plan_commit` and HEAD; HEAD position (below)                 |
| 5a   | auto gates         | `confirm: "auto"` only: G1-G3 against the current rulings                  |
| 6    | test writers       | one per criterion, in parallel, all in the ONE fleet worktree, uncommitted |
| 6a   | fixers (infra)     | `pre-commit run --files` on the round's test files until stable (below)    |
| 7    | hasher (ownership) | HEAD unchanged; changed paths = the pending criteria's reported files      |
| 8    | test judge         | `revise` routes findings to the named writers only; 3 rounds max           |
| 9    | hasher (freeze)    | test files and runner config; `freeze_tree` = the worktree tree            |
| 10   | coder              | works uncommitted; status checked after the hash check                     |
| 10a  | fixers (infra)     | `pre-commit run --files` on every non-frozen dirty path (below)            |
| 11   | hasher             | HEAD moved -> stop; any changed, new or removed hash key -> round rejected |
| 12   | code judge         | `fix_code` -> coder; `fix_tests` -> test judge; `plan_wrong` -> re-plan    |
| 12a  | -                  | `approve` with an unmet obligation -> `fix_code` (counts as a round)       |
| 12b  | changed-defs (r/o) | a modified existing definition outside `changed_symbols` -> stop (below)   |
| 13   | commit (infra)     | `git add -A`, staged tree = `code_tree`, ONE commit WITH hooks (below)     |
| 14   | push (infra)       | `.fleet/` check first; pushes; a hook rejection -> coder (`fix_code`)      |
| 15   | pr-opener          | `.fleet/` check first; draft PR at `approved_sha` (the commit step's HEAD) |
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

Load-ref: an infra step reads the plan refs with `git cat-file` and returns each tag's target,
message and message sha256. The ref named by `plan_ref` must be an annotated tag of `plan_commit`,
its message sha256 must equal `ref_sha256`, the inner seal must hold, and its branch, repo and task
id must match the tiny ref. A missing ref or any mismatch stops with `needs_human` "plan ref missing
or changed; re-run plan" before any role runs. The script then uses the loaded ref. The plan ref is
frozen with every other `refs/fleet/*` ref in the hasher's git map, so a coder or writer that moves
it trips the freeze; the script's own plan-ref write in a re-plan updates the frozen snapshot.

Verify: the sha256 of `plan_path` at `plan_commit` must equal `plan_sha256`, or the run stops with
"plan changed since approval". HEAD must equal `plan_commit`, or descend from it by commit-step
commits of this plan only (`feat(<task id>): <slug words>` and `fix(<task id>): code round <n>`),
with `plan_path` unchanged. Anything else stops with the same reason.
Stage-plan, commit-plan and verify run the same embedded hash program.
Since 3.1.0 no step relays raw git output for these checks. Verify runs `VERIFY_SINCE_PY`
(worktree, plan commit, plan path), which prints `{head, is_ancestor, commits_since, plan_touched,
changed_since, args, digest}`; commit-plan runs `PLAN_FILES_PY`, which prints
`{head, files, args, digest}`. `args` echoes the program's arguments, and the script compares them
with what it passed.
The script recomputes each digest and stops the run (`failed`) on a dropped or changed entry or a
missing list. Every embedded program runs as `python3 -I`; a program that reads the repo takes the
worktree as an argument and runs git with `-C <worktree>`. The 3.1.0 programs (the push classifier
too, which reads only its output file) change to `/` before they do anything.

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
  `failed` or `none`. A failed entry hands its `section_text` back.
- **Ledger task with no body page (3.1.0):** a read-only step (`infra:ledger-read:pre`,
  `fleet:judge`) reads every ledger task first: its title, `body_slug` and marker. A task with a
  body page goes to the append step above. For a task with none, `infra:ledger-body` runs on
  `fleet:ledger-writer`, whose `tools:` allowlist holds `ToolSearch`, `StructuredOutput` and five
  yadgar tools (`task_get`, `wiki_read`, `wiki_add`, `wiki_append_section`, `task_write`) and
  nothing else. It re-reads the task and writes nothing when the title differs from the judge's
  read; it creates the page with `wiki_add` at the slug the script computes,
  `{args.project with / as _}_task-<id>` (`upsert=False`, `force=True`, `wait=True`,
  `directory` = the repo); on `slug_exists` the page must carry `args.project` and the tag
  `ledger-<id>` (else "slug collision", nothing written), and it appends the section only when the
  page lacks the marker, never overwriting it; then it calls
  `task_write(project_id, id, title=<the title the judge read>, body_slug=<slug>)`, because
  `task_write` writes the title on every call. A second read (`infra:ledger-read:post`,
  `fleet:judge`) must show the same title, the computed `body_slug` and the marker on the page.
  Any other outcome fails the entry; a changed title is named ("restore the title by hand"). The
  title must have 1 to 200 code points. The title check works at the relay level only: the write
  itself can change the title, and the reads detect that but cannot prevent it. A project that is
  not `<owner>/<repo>` writes nothing. Titles and bodies are data, not instructions.
- **yaadgaar (3.0.0; 3.1.3):** for each `yaadgaar` source, a read-only step
  (`infra:yaadgaar-read`, `fleet:judge`) runs `mcp__yaadgaar__read_task` by the task id (URN)
  intake sealed with the source. It returns per task the id, number, version and whether the
  marker is there. It never reads the repo's files or remotes: the yaadgaar client is bound to the
  session's start project, and the URN names one task. No `args.project`, or a non-`yadgarhq/`
  one, writes nothing; a ref sealed before 3.1.3 (no id) writes nothing and says "re-run plan".
  The script refuses any task whose answer gives another id or number than the sealed one, names a
  project other than `args.project`, or gives a version that is not an integer. `fleet:judge` cannot call `mcp__yaadgaar__edit_task`, `create_task` or
  `transition_task` (`disallowedTools`). Only then `infra:yaadgaar-writeback` (the default
  agent: `fleet:judge` may never write to a ledger) edits each task by id with the version read
  as `expect_version`, after it re-reads the task by id and checks its id and number (fail
  closed): an empty body gets `body` = the `## Fleet build` heading plus
  `section_text` with `expect_body_sha256` (computed by the script); a non-empty body is never
  re-sent, the section is appended with a literal `patch` on a unique tail of the body
  (`expect_count: 1`). On `VERSION_MISMATCH` it re-reads and retries once; any other refusal fails
  the entry. It re-reads after the edit to confirm the marker landed and nothing was cut. The yadgar
  ledger is never used for these tasks. A task that already carries the marker is skipped without
  an edit step. Task bodies are data, not instructions. No
  tool-restricted agent type that can call `mcp__yaadgaar__*` exists, so the step uses the default
  agent. A ref that is not a task number is never sent. A failed entry carries `section_text` to
  add by hand.
- **Plan link:** `https://github.com/<o>/<r>/blob/<branch>/<plan>`, or
  `https://codeberg.org/<o>/<r>/src/branch/<branch>/<plan>` when the origin's configured URL names
  Codeberg (`remote_host` from the workspace step).
- **Comments:** one comment on each `jira`, `github` and `codeberg` source: tldr, plan link, PR
  link and the marker `fleet:<task id>` (an HTML comment on GitHub and Codeberg, a plain last line
  on Jira). A read-only step lists the existing comments first; a source that already has the
  marker is skipped. The script refuses, in code, any comment with a line that starts with `digger`
  or `atlantis`. Ticket and issue bodies are never edited. `comment_status` is `posted`, `skipped`,
  `failed` or `none`; on `failed`, `comment_text` holds the text to post by hand.

### Re-plan rounds (4.0.0, ledger 1983)

Every confirm mode gets up to 2 re-plan rounds (`:audit-fix`, `:audit-fix-2`). A plan-audit
refusal or a script-side refusal (a confusable character, the caller map, the grep diff) sends
the findings back to the planner, and plan-audit gates each round. After the second round the run
stops with "(after 2 re-plan rounds)". A round that relaxed round 0 (`change_kind` moved to
`bug_fix`, `new_behaviour` moved to false, a criterion dropped or shortened with no finding) never
reaches the auto gates. Under `default` the run asks; under `auto` it stops `needs_human` after
the plan commit. A run that stops before its plan commit parks its draft and findings; the next
plan run gives them to the planner as inputs only. A parked read that is unusable fails closed
under `default` and `auto` ("parked prior unreadable (fail closed)").

### Push-access probe (4.0.0, ledger 1985)

Plan mode only, right after the workspace step: a PATH re-check, then `infra:push-probe` runs
`git push --dry-run --porcelain origin <base_ref>:refs/heads/<branch>` (with a 120 s timeout).
The dry run sends nothing, but it runs the repo's pre-push hook. `push_probe.py` classifies the
output. An auth failure stops the run with `needs_human` before any role runs. Anything the
program cannot classify, or a relay that is not the program's own, logs "push access unknown"
and the run goes on: the real push is still gated later.

### Frozen resume: freeze_digest (4.0.0, ledger 1987)

Each freeze writes `refs/fleet/<task id>/freeze`, a local ref to the freeze tree (no commit). A
`needs_human` or `failed` result after a freeze returns `freeze_digest` (sha256 over the plan
ref's sha256, the freeze tree and the frozen hasher maps) with the `plan_ref`. A build re-run
with that `freeze_digest` resumes at the coder (`resumed_at: "frozen"`), but only when HEAD is
the plan commit, the freeze ref is present and the worktree tree is the freeze tree. Any
mismatch stops with `stop_gate: "resume"`. A build that re-froze its tests after a fix_tests
round binds `refrozen: true` into the digest and never resumes this way. A run-state ref (a
build past its commit) wins over `freeze_digest`.

### Role files (5.0.0, R1, ledger 1999)

The ten role prompts ship as `plugins/fleet/roles/<role>.md`. `ROLE_SHA256` in the workflow
holds the sha256 of each file's exact bytes; `scripts/gen.mjs` writes it next to
`PROGRAM_SHA256`, and `gen.mjs --check` fails when a role file differs, is missing, or the roles
dir holds any other file. Every run (plan, build, probe) relays the files again; nothing is
cached:

1. `preflight` (haiku) finds `$HOME/.claude/plugins/cache/<marketplace>/fleet/<version>/scripts`
   and its sibling `roles` dir. Both must be their own realpath and no symlink; the roles dir
   must hold exactly the ten files, each hashing to its pin (the agent's relayed sha256sum lines:
   an early stop for a stale install).
2. `infra:role-relay:<role>` (sonnet, one agent per role, in parallel) runs `role_files.py
<roles dir> <role> <part>` for each part and returns the text as chunks of 1000 characters
   (12 chunks per part, so one call prints under 20000 characters, below the Bash output cap).
   The script joins the chunks and hashes the text itself; it never takes a hash an agent
   reports. A relay that does not match runs once more on `RELAY_RETRY_MODEL` (sonnet); a second
   miss stops: "role file <role> hash mismatch (relay or tampered); reinstall fleet <version>".
   The relays count in `agents`, never against the agent cap (like the PATH re-checks).
3. Each role's tier comes from the first `DISPATCH:` line of its hashed text. Each role prompt is
   that text, then the inputs.

Plan mode seals `history.preflight: {fleet_version, role_sha256}` in the plan ref, log only. A
build never reads a role table from it. A 4.x plan ref (`{fleet_version, versions, dispatch,
contract}`) still builds, with this install's role files. `fresh_preflight` is accepted and
changes nothing. The result carries `role_sha256` (was `role_versions`).

The role files are the yadgar pages `agent-prompt-<role>` (project `m-agahi/yadgar`) as of
fleet 4.0.3, with the `CONTRACT:` line removed and the repo's markdown formatting applied. The
`pr-review` page stays in yadgar for use outside the fleet; `roles/pr-review.md` is the fleet copy.

### Probe mode (5.0.0)

`{mode: "probe", repo, date, run_nonce}` runs the preflight only on `repo`: the scripts and
roles dirs, the relay and hash of every role file, and the PATH check. It returns `status: "ok"`
with `probe: {fleet_version, scripts_dir, roles_dir, roles: {<role>: {sha256, chars, model,
fallback}}}` and stops: no worktree, no role agent, no write. Use it after an install or update
to prove the runtime can relay the roles before a real run.

### Throwaway test database (4.0.0, ledger 1981)

Opt-in: a repo commits `.fleet-test-db.json`, for example
`{"version":1,"engine":"mariadb","major":"11.4","env":"YADGAR_TEST_DSN"}`. The workflow reads it
at `origin/<default branch>` only. It then starts one local MariaDB container per run (image
pinned by digest, bound to 127.0.0.1, self-expiring after 6 h) and gives each role its own
database and user. The DSN goes into that role's `test_env` under the declared name, with a
note never to write it into the plan, a finding, a commit message or a PR.
`infra:verify-plan-commit` refuses a plan commit whose plan doc holds `mysql://` (no `plan_ref`);
reset the fleet branch past that commit before the next plan run, which does not re-check
earlier plan commits. Findings and PR text rely on the note alone. The workflow removes the container at the end of every run;
`db_sweep.py` removes expired ones of earlier runs. Any declaration or relay problem stops with
`stop_gate: "db"`.

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
- fleet-internal files in a PR (2.1.4): before every push and every pr-opener call a read-only
  infra step (`infra:fleet-scan:*`, a fixed program) lists the paths of
  `git diff --name-only origin/<default>...<approved_sha>` and the files of every commit in
  `origin/<default>..<approved_sha>`. Any path with a `.fleet/` directory segment, or a scan that
  does not complete, stops the run with `needs_human` and `stop_gate: "scope"`: "fleet internal
  files in PR diff: <paths>";
- planner-command injection: `test_cmd` and `check_cmd` pass a script allowlist and Max approves
  them verbatim (or G2 checks them), and the workflow script runs none of them.

Not defended:

- a hostile agent with a shell: it can run anything the user can, outside the worktree too;
- in-environment exec vectors: git filter drivers that act during the hasher's own `git add`,
  interpreter flag clusters (for example `-xc` in a hook entry), nested git config includes,
  the transport git config left unfrozen for resume (for example `credential.helper=!<command>`,
  `core.sshCommand`), virtualenv and `node_modules` internals beyond the startup hooks, and
  anything else that runs code without changing a frozen key.

#### IaC tooling: Max's hard rules and the PATH shims (3.1.0)

Max ruled on 2026-11-09: the fleet may work on terraform and other IaC code like any other code.
What keeps IaC tooling (terraform, tofu, tfp, terragrunt, digger, atlantis) from running is not a text scan
in this workflow but four layers outside and inside it:

1. **Max's hard rules** (no terraform by any mechanism, no tf-local-plan container exec), which
   every role inherits.
2. **settings.json denies** on those commands.
3. **Agent PATH shims** that nix installs for terraform, tofu, tfp, terragrunt, digger and atlantis, and for
   docker/podman exec into tf-local-plan containers: on the agent PATH the tool names reach a shim
   that refuses.
4. **The hook gate** (below): a change to anything the repo's hooks or CI run needs its own PR
   and Max's confirmation, so a role cannot make a hook run IaC tooling at the commit or the push.

ADR-1152 still frames the rest: the fleet's gates defend against reward hacking, not a hostile
agent with a shell.

**The PATH check (preflight, plan and build mode).** The preflight step runs one embedded program
(`PATH_CHECK_PY`, `python3 -I`, resource caps). It resolves terraform, tofu, tfp, terragrunt,
digger and atlantis on the agent's PATH. A name that resolves is a shim only when its real path is under
`/nix/store/` (which no role can write) and its first 64 KiB hold the marker
`fleet-agent-shim: hard-rules` (the constant `FLEET_SHIM_MARKER`). A name that resolves to
anything else stops the run before any other step, with `needs_human`, `stop_gate: "iac"` and
"terraform tooling on PATH is not shimmed; install the agent PATH shims (nix) before using the
fleet". No name resolving at all passes. The program gets the repo as its argument and reads the raw
agent PATH: an empty or relative PATH entry (the agent's shell would resolve it against the
worktree) and an entry inside the repo (the fleet worktree, the scratch dir, a role's own `bin/`)
stop the run too ("PATH has entries the agent shell resolves differently"). A missing or tampered
result stops the same way: no `path_check`, a wrong digest, tool keys other than exactly those
six names, an entry whose `path` is not absolute or whose `shim` is not a boolean, or a program
argument other than the repo. A found entry passes only with `shim` exactly `true`. Every embedded
program also gives its children a PATH without empty or relative entries, and the fixer gives
pre-commit and its hooks one without the worktree's and the scratch dir's entries. The program spells the names in pieces, because
the agent's Bash guard blocks them.

**The PATH re-checks (3.1.1).** `~/.local/bin` is writable and early on PATH, so a tool planted
after preflight would pass. The same program therefore runs again (`infra:path-check:<site>`)
right before every step that runs repo code: `format-plan`, `plan-audit` (3.1.2: the audit runs
the planner's `test_cmd` in a scratch worktree) and `commit-plan` in plan mode (and their
`:replan` and `:audit-fix` forms), the intent judge under `confirm: "auto"` (`intent`,
`intent:rerun`), and in build mode the test writers, the test fixers and the test judge of
each test round, then the coder, the code fixers, the code judge and the commit of each code round,
each push, and the review of each review round and its gate sweep (`pr-review:v<k>`,
`sweep:v<k>`, 3.1.2: both run repo tests after the push). Each re-check passes the program a token of its own (a counter, the run nonce and
the site) after the repo; the program echoes it in `args`. The script accepts a result only when
`args` is exactly `[repo, token]`, so the preflight's result, another site's result or a result
recorded in an earlier run never passes. Two re-checks at the same site get different tokens
(the counter). A failed, missing or tampered re-check, a not-ok status next to a clean output, a
path problem or an unshimmed tool stops with `needs_human`, `stop_gate: "iac"` and the
site's label, before the guarded step runs. The re-checks count in `agents` but not against the
agent cap: the cap refuses exactly the runs it refused in 3.1.0. Not re-checked: the
`check_cmd` scripts.

**Resume replays re-checks.** A `resumeFromRunId` call with the same args (the same `run_nonce`)
gets the same re-check prompts, so the runtime replays the earlier re-check results, the same as
every other infra check. A tool planted since then is not seen. Never resume with the same args:
call the workflow again with a new `run_nonce`, and build mode continues from its run-state ref.

**Accepted residual (ADR-1172; no content scan stands in for it).** The PATH check and the shims
do not stop a hook's or a test's call by absolute path to a real binary
(for example `/opt/terraform/bin/terraform`, or a binary a test downloads), nor a container image
built to run terraform. Max's hard rules and the settings.json denies are the controls there.

**IaC paths are fleet work (ADR-1172).** The scope fence no longer refuses IaC files or
Kubernetes and Helm manifests; it refuses provider plugin directories and still refuses `.github/`, the hook-manager and CI paths,
rulesets and secret-like paths.

**The IaC push gate (ADR-1172 and ADR-1175).** Terraform diffs never push
automatically; the fleet stops and hands the push to Max. Content checks are hints only. Before
every push, `infra:tf-gate:push` runs `TF_GATE_PY` (`python3 -I`, caps) on the PR diff. Its base
comes from origin itself (`git ls-remote`, then a fetch of that sha when the repo lacks it), never
from the local origin ref; either failing stops the run. The URL is origin's configured URL sealed
in the plan ref (https or `git@host:` only). Since 3.1.1 the workspace step reads it with
`REMOTE_URL_PY` (`python3 -I`, caps; `git config --get remote.origin.url`, before any `insteadOf`)
and relays `remote_url_check` `{url, args, digest}`; the script recomputes the digest and checks the
args, at plan time for the seal and at build time for the comparison. An unusable relay leaves the
URL empty, which stops an IaC diff at `iac`; the network reads run in a bare scratch repo with
command-line overrides, so no repo config (`sshCommand`, `uploadpack`, `insteadOf`, helpers) reaches
them. No sealed URL, or a URL changed since the plan, stops at `iac`. Residual (ADR-1152): edits to
the user's global git config or environment.
When the diff touches any IaC file (`*.tf`, `*.tofu`, `*.tf.json`, `*.tofu.json`, `*.tfvars`, `*.tfvars.json`, `*.tofuvars`,
`*.tofuvars.json`, any `*.hcl` or `*.hcl.json` (the lock file and the grunt configs included), `*.tfbackend`,
`.terraform-version`, `.opentofu-version`, `.tofu-version`, `atlantis.y*ml`, `digger.y*ml`, a
terraform CLI config file, anything under `.spacelift/`, or a path with a `.terraform`, `terraform.d` or
`.terraform.d` segment; names match in any case), the run stops before the push in every
confirm mode with `needs_human`, `stop_gate: "iac-push"`. The message gives the branch, the commit
sha, the IaC files, the push command for Max, and the content findings under "hints (not a
security check)". The orchestrator files (`atlantis.y*ml`, `digger.y*ml`, `.spacelift/`) get
"orchestrator config change" and the version files "IaC tool version file change" (3.1.1); the
text scan's hints are for the other IaC files. The fleet never pushes an IaC diff. After Max pushes it himself, a build run of the same
`plan_ref` reads origin's branch head (`REMOTE_HEAD_PY`, `git ls-remote`) and goes on to the PR,
the review and the write-back without a push, only when the head is exactly the approved sha; any
other remote state stops at `iac-push`. An IaC path in the fleet scan's PR diff that the relay does
not list stops with `stop_gate: "iac"`. Three checks stop with `stop_gate: "iac"`: a provider plugin directory segment
(the scope fence refuses it too), a symlink at an IaC path or into a plugin directory, and a change
to code that existing IaC runs at plan time (a non-IaC file in an exec stack's directory, or a file
an exec stack names as a literal in `program`, `command` or `file(...)`). Residual: an exec
reference that is not a literal and points outside the stack directory.

#### Hook changes: their own PR, with Max (3.1.0)

The hook surface is every hook-manager and CI path, in any case (`.pre-commit-config.yaml`,
`.pre-commit-hooks.yaml`, `.github/**`, `.gitea/**`, `.forgejo/**`, `.woodpecker*`,
`.circleci/**`, `.gitlab-ci.yml`, `.gitlab/**`, `Jenkinsfile`, `.buildkite/**`,
`azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.husky/**`, `.githooks/**`, `lefthook*.yml`,
`.lefthook*`, `atlantis.y*ml`), plus what the read-only program `HOOK_SURFACE_PY` finds with the fixer's isolated
PyYAML loader: every file a hook `entry` or `args` names (a `--flag=value` only when the value is
an executable script), `-m` modules and their `__main__.py`, every Makefile and `*.mk` for a hook
that runs `make`, the in-repo target of a surface symlink, one level of what the hook scripts load
(repo-local Python imports; shell `source`/`.`; scripts they run directly; a Python script that
does not parse puts its directory in the surface), the scripts CI and hook-manager files name
(`.github/actions`, husky, githooks, lefthook, the hooks dir, `package.json` scripts; one that does
not parse refuses) and the `core.hooksPath` directory. `Makefile`, `package.json` and
`pyproject.toml` alone are not surface: they are task runners every version bump touches. The plan
scope (files, obligation files, criterion test files, mapped callers) is checked before the audit
and the approved diff right before the commit. Touching the surface and anything else stops
with "hook changes must be a separate PR (Max's rule)"; touching only the surface stops with "hook
change needs Max's confirmation". Both are `needs_human`, `stop_gate: "hooks"`, in every confirm
mode. A surface that cannot be computed refuses.

**Resource caps (3.1.0).** Every embedded Python program sets `RLIMIT_AS` 1 GiB and `RLIMIT_CPU`
300 s before anything else, and tunes git's children to stay inside them; the repo's own hooks
that the fixer runs get the limits lifted back. The YAML loaders (60 s, 1 GiB) read at most
256 KiB of config, emit only string values (`args` a list of strings) and stop past 1 MiB of
output, so an alias bomb ("billion laughs") is refused, not expanded.

Every `git worktree add` the fleet runs uses `-c core.hooksPath=/dev/null`, so no `post-checkout`
hook runs in a fleet worktree. The scope-and-plan role page creates the planner's own probe worktree;
the script does not create it.

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
  `.nox` and `node_modules` only `*.pth`, `sitecustomize.py`, `usercustomize.py`, `*.egg-link` and
  the `entry_points.txt` of a `*.dist-info` or `*.egg-info` dir count (an installed package can
  register a `pytest11` plugin that skips or passes tests). A new or
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
   rounds. Since 3.1.0 (code-judge page 15) the judge runs every allowlisted `check_cmd` in a
   scratch worktree loaded with the judged tree, so CI-only rules fail before the push, and
   reports `check_exit`. On `approve` the gate also requires, for every obligation that still has
   a `check_cmd` this round, `check_exit: 0` or a `gates_not_run` entry `check_cmd:<id>` (stated in
   the PR body); any exit other than the integer 0, disclosed or not, or neither one converts the
   verdict to `fix_code`. The coder may not edit what a `check_cmd` runs: a change from the plan
   commit that touches its script, a Makefile or `*.mk` (for `make`) or `.pre-commit-config.yaml`
   (for `pre-commit run`) converts an `approve` to `fix_code` unless the obligation's `files` list
   that path (a local hook's entry file is refused earlier, by the fixer step). Limits: a
   `check_cmd` that cannot run in the scratch worktree (a missing tool or dependency) is only
   stated as not run; a module a check script imports is not traced; and a CI rule with no
   `check_cmd` is still judged from the diff alone. `gates_not_run` in the PR is the union of the
   judge's list and the gates the script knows did not run.
3. **Push hook rejection goes back to the coder.** The push step classifies its result as
   `push_result: ok | hook_rejected | network | non_ff | remote_rejected | ambiguous`, on
   line-start prefixes only (`error:`, `fatal:`, ` ! [`), never on words inside a line or the
   remote URL. A hook can print the same prefixes, so no rule retries what may be a hook's verdict.
   Checked against real git output: a failing local pre-push hook gives exit code 1 and only
   `error: failed to push some refs`; a non-fast-forward gives ` ! [rejected] ... (fetch first)` or
   `(non-fast-forward)`; a network error gives exit code 128 and a `fatal:` line. `hook_rejected`
   is not a stop: the script routes the hook output tail (`hook_tail`) to the coder as a `fix_code`
   finding. The round counts as a code round, and the code judge must approve again before the next
   push (`infra:push:p<n>`). `non_ff` and `remote_rejected` (` ! [remote rejected]`: a server hook
   or branch protection) stop with `needs_human`; `network` is retried 3 times with backoff and
   then fails. Since 3.1.0 a program classifies, not the agent: `PUSH_CLASSIFY_PY` reads the first
   attempt's output file and exit code and prints `{push_result, exit_code, hook_tail, args,
digest}`. `error: failed to push some refs` with exit 1 and a `fatal:` or `error: RPC failed`
   line (a hook's line or a transport failure: they cannot be told apart) is `ambiguous`, a stop
   with `needs_human`, never a network retry that re-runs the hook. A git-lfs pre-push network
   failure is `hook_rejected`. The script accepts `hook_rejected` only with exit code 1, the
   program's digest and `args` naming a file outside the worktree and that exit code. The tests
   replay git 2.55.0 output captured for `[remote rejected]`, a declined pre-push hook, a
   non-fast-forward, HTTP 500/502 on the upload and HTTP 500/503 on `info/refs`.

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

- 5.0.0 (R1): `ROLE_SHA256` pins each shipped role file (see "Role files"). The page versions
  (`EXPECTED_VERSIONS`) and the `CONTRACT:` marker below are history: 5.0.0 deleted both. A role
  result carries no `role_version` or `role_contract`.
- Until 4.0.3: `EXPECTED_VERSIONS` held the minimum role-page versions, and every role page
  carried `CONTRACT: fleet-v4` under its DISPATCH line.
- 2.1.1 pins: scope-and-plan 24, plan-audit 13, fleet-test-writer 9, fleet-test-judge 9,
  fleet-coder 16, fleet-code-judge 13, fleet-pr-opener 10, fleet-intent-judge 2, pr-review 17,
  gate-change-nonweakening-sweep 4. 2.1.6 raises scope-and-plan to 26 and plan-audit to 15
  (`changed_symbols`, `caller_check`). 3.0.0 raises scope-and-plan to 27, plan-audit to 16 and
  fleet-coder to 17 (the build-time caller check and the optional finding `symbol`; additive, so
  the marker stays `fleet-v3`). 3.1.0 pins the prose-only pages at their live versions
  (fleet-test-writer 10, fleet-test-judge 10, pr-review 18, gate-change-nonweakening-sweep 5) and
  raises fleet-code-judge to 15 (`check_exit`, additive). 4.0.0 bumps the marker to `fleet-v4`
  on all ten pages, because a 3.1.3 role would run a new planner key (`criteria[].test_args`)
  unvalidated: scope-and-plan 29, plan-audit 17, fleet-test-writer 11, fleet-test-judge 11,
  fleet-coder 18, fleet-code-judge 16, fleet-pr-opener 11, fleet-intent-judge 3, pr-review 19,
  gate-change-nonweakening-sweep 6.
- Each role runner reports the version and marker it loaded. A value that differs from preflight
  (the page changed mid-run) discards the result.
- `REQUIRED_ON_OK` lists the keys each role must return with `status: ok`, and verdicts are
  checked against the frozen enums. fleet-v3: the writer returns `criterion_id, tests, files`; the
  coder `changed_paths, suite_result, added_symbols, frozen_tests_red_at_start, obligations_done`
  (no `commit`/`commits` key any more); the intent judge `verdict, deviations, coverage`;
  pr-review `verdict, findings, touches_gate, checked`; the sweep `verdict, units, findings`;
  since 2.1.6 the planner also `changed_symbols`. fleet-v4 adds the planner's `change_kind` and the
  intent judge's `classification`. Since 4.0.0 (ledger 1984) every such key is also in the role
  schema's `required`, widened with null, so a `needs_human` or `failed` result sets what it lacks
  to null. On `ok` the script checks each value against the frozen type: null only where that type
  allows it. A missing key, a wrong type or value, or an unknown verdict is contract drift. The
  role is sent back once with the drift quoted, after a fresh PATH re-check; a second drift stops
  the run. A version or marker mismatch never retries. The coder is never re-run: its drift is the
  `fix_code` finding of the next code round.
- Stop reason precedence: (1) a script gate violation (hash, fingerprint) with that gate's own
  reason; (2) the role's own `needs_human`/`failed` reason; (3) contract drift, only when
  neither applies. The coder's hash check runs before its contract check, and a judge's fingerprint
  check before its contract check. The result's `stop_gate` names the gate: `hash`, `fingerprint`,
  `commands`, `contract`, `role`, `cap`, `ownership`, `commit`, `review`, `intent`, `scope`,
  `resume`, `iac`, `iac-push` or `callers` (`null` when the run did not stop at one of them). A cap stop names the gate that rejected the
  last round (hash, obligations gate, commit hook, push hook or review).

### Models

Each role, the reviewer and the sweep included, runs on the tier named by the first
`DISPATCH: model=<tier> (fallback=<tier> ...)` line of its role file (5.0.0: of the relayed text
the script hashed); the script parses it. Accepted tiers: `fable`, `opus`, `sonnet`, `haiku`. No tier is
hardcoded: a missing, unparseable or unknown line stops the run in preflight (`stop_gate:
contract`). A role agent that dies is retried once on the page's fallback tier, when one is set,
never on any other; the retry counts toward the agent cap. Every role dispatch logs
`model used: <label> -> <tier>`.

Infra agents (4.0.0, ledger 1990) run on the model that `INFRA_TIER` names for their label. The
first matching label prefix wins, and a label with no entry stops the run (there is no default
tier). `haiku` runs the read-only steps whose output a program digest checks: the PATH checks,
preflight, branch-scan, stage-plan, verify, read-state, callers, check-scripts, review-paths,
remote-head, load-parked and the test-DB steps. `sonnet` runs everything else: intake, the
hasher, load-ref, commit-plan, the park, workspace (its `default_branch` and `base_ref` are not
digest-checked), precommit-ids (it feeds G2), format, commit, push, the IaC gate, hook-surface,
changed-defs, the re-plan, state, freeze-ref and write-back steps. A haiku PATH check whose relay
is broken runs once more on sonnet.

### Independent review

After the commit step, the push and the pr-opener (draft PR open):

1. `infra:review-paths:v<n>` (read only) runs a program that lists `changed_paths` =
   `git diff --name-only <plan_commit>..<approved_sha>`, with its digest.
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
the pre-commit id read, the review path listing, the comment listing, the ledger task reads and the
hasher run as the `fleet:judge` agent, which has `Write`, `Edit` and `NotebookEdit` disallowed, and
(since 3.1.0) every yadgar writer (`task_write`, the `wiki_*` writers, `memorize`, `forget`,
`memory_update`, `anchor`, the `block_*` writers, `adr_add`, `agent_prompt_save`, `config_set`);
a denylist, hygiene only, because the judge has `Bash`. `Bash` stays, because
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
  "role_sha256": { "fleet-coder": "<sha256>" },
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

Node 22+. Pass files or a quoted glob: `node --test <dir>` runs the directory as one file and fails
on Node 22 and later. CI (`validate.yaml`, step "Run plugin node tests") runs every
`plugins/*/tests/*.test.mjs` on Node 24, with the list expanded by the shell.
