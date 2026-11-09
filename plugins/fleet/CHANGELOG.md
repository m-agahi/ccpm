# Changelog

## [Unreleased]

Fleet 4.0.0 work in progress (integration branch `feat/fleet-4.0.0`). Stream S2 folds these notes
into the 4.0.0 entry.

### S1: test harness

- The shared scenario-test harness moves to `tests/harness.mjs`. Test files import it. No test
  behaviour changes.

## [3.1.3] - 2026-11-09

Ledger task 1979. No role page changes; install 3.1.3, then `/reload-plugins`. The contract marker
stays `fleet-v3`.

### Intake resolves a task id through the ledger tool

- The fault was in the workflow's own intake prompt, not in a role page. It told intake to check
  the yaadgaar project from the repo's `.yadgar/project-id` or origin. A docs session that built
  `yaadgaar #671` in repo iam-db stopped there, never called `read_task`, and advised writing
  `yadgarhq/docs` into iam-db.
- Intake now resolves a task id only by calling the ledger tool and takes the answer as the truth.
  `args.project` is the ledger scope, independent of `repo`. `yadgarhq/` projects use yaadgaar,
  others yadgar `task_get(project_id=<project>)`; no project gives `ledger: "either"` (try both).
- A yaadgaar source carries the `id` (URN) of the `read_task` answer, in the form
  `yadgar:task:<uuid>`, and `tried` must hold a `read_task` call with `error: null`. Otherwise plan
  mode stops with `needs_human`: intake did not call the tool. The intent re-read must return the
  same id.
- `confirm: "auto"` with no `args.project` and a task-id input stops before intake: the id would
  resolve in whatever project the session is bound to, and nobody confirms it. Under `confirm:
"ask"` the result carries `ledger_source` (`ledger`, `ref`, `id`, `project`) and the reason names
  the ledger, task and project, so Max sees what the id resolved to.
- Intake returns `tried` (ledger, project, call, error). On a task-id input that stops, the script
  appends the ledgers tried and the error text intake reports for each call to the reason, or
  "ledgers tried: none". That error text is relayed unfiltered as `error (as reported by intake
agent): ...`, cut to 4 KiB, and never dropped: it carries clues such as "unknown project_id",
  but the script cannot prove it is the tool's own text. The other agent-written parts (the reason, a call) are dropped
  when they mention `.yadgar` or a project id. Only a quoted ledger tool call (`task_get`, `task_list`, `read_task` or
  `find_tasks` with plain `key=value` arguments and no `.yadgar` path) is exempt, so
  `task_get(project_id=o/r, id=42)` passes and a bare "set project_id=..." is dropped. Each part is
  cut to 4 KiB before the test, and the call grammar is unambiguous (no `=` in a value, a comma
  between arguments), so hostile text fails the match in linear time. Reasons for other inputs
  (Jira, issues, plans, text) are relayed as they are.
- Build mode checks the sealed sources against `args.project`, not the origin slug. With no
  `args.project`, a legacy yadgar ledger source stops the build ("re-run plan with project").

### yaadgaar write-back reads by the sealed id

- `infra:yaadgaar-read` reads each task by the sealed URN. It no longer resolves a project from the
  repo (`read_task` answers carry no project). The script requires the sealed id and number before
  any edit, and a project the answer names (a `project_id` or `project` field) must be
  `args.project`. No `args.project`, or a non-`yadgarhq/` one, writes nothing. A ref sealed before
  3.1.3 has no id: write-back edits nothing, hands the section back and says "re-run plan".
- Intake and the intent re-read stop when a yaadgaar answer names a project other than
  `args.project`, with both projects in the reason. The named project is checked, never sealed.
- Scope: the yaadgaar client is bound to the session's project. A `read_task` answer has the keys
  `body, id, links, number, status, tags, title, version` and never names a project. A
  well-formed URN outside the session's scope is refused with "no such task in this scope" (gRPC
  NOT_FOUND), the same answer as for a missing task. So a sealed URN resolves only in that scope,
  and the write-back cannot edit another project's task. The project checks above are defensive
  and do not fire today. `args.project` must be the session's project (the skill takes it from the
  session banner).

## [3.1.2] - 2026-11-09

Ledger task 1974. No role page changes; install 3.1.2, then `/reload-plugins`. The contract marker
stays `fleet-v3`.

### More PATH re-check sites

- `infra:path-check:<site>` now also runs right before the plan audit (`plan-audit`, with the
  `:replan` and `:audit-fix` forms; the audit runs the planner's `test_cmd` in a scratch
  worktree), the intent judge under `confirm: "auto"` (`intent`, `intent:rerun`), and each review
  round's `pr-review:v<k>` and gate sweep `sweep:v<k>` (both run repo tests after the push). A
  tool planted right before one of them stops the run at `iac`; the guarded step never runs.
  Tests cover `plan-audit`, `intent`, `intent:rerun`, `pr-review:v1` and `sweep:v1`.
- The plan ref's cumulative agent count with `confirm: "auto"` includes the intent re-check. The
  agent cap is unchanged: re-checks do not count against it.

### Mutant tests

- R6: a re-check that returns `failed` or `needs_human` together with a digest-valid, well-shaped
  program output. The 3.1.1 code already stopped the run; no test killed the mutant that drops the
  status check. A test now does. No code change.
- R7: the token without the counter. A test calls the workflow's `pathRecheck` twice at the same
  site: the tokens differ, and the first result replayed at the second check is refused. No code
  change.

### Docs

- README and SKILL.md: a `resumeFromRunId` call with the same args replays the earlier re-check
  results, the same as every infra check. Never resume with the same args; call the workflow
  again with a new `run_nonce` and let build mode continue from its run-state ref.

## [3.1.1] - 2026-11-09

Ledger tasks 1969 and 1970. No role page changes; install 3.1.1, then `/reload-plugins`. The
contract marker stays `fleet-v3`.

### PATH re-checks (task 1969)

- The preflight PATH check (`PATH_CHECK_PY`, unchanged) now runs again as
  `infra:path-check:<site>` right before every step that runs repo code: `format-plan` and
  `commit-plan` (and their `:replan` forms), the test writers, test fixers and test judge of each
  test round, and the coder, code fixers, code judge and commit of each code round, and each push.
  A tool planted after preflight (for example in a writable `~/.local/bin`) stops the run there
  with `needs_human`, `stop_gate: "iac"`, before the guarded step.
- Each re-check passes the program a token of its own (a counter, the run nonce and the site),
  which it echoes in `args`; the script accepts only `[repo, token]`. The preflight's result,
  another site's result or a result recorded in an earlier run never passes. A failed, missing or
  tampered re-check stops at `iac` as well.
- **Agent cap:** the re-checks count in `agents` (and in the plan ref's cumulative history) but
  not against the 100-agent cap. The cap counts the same agents as in 3.1.0, so it refuses
  exactly the runs it refused before (checked against 3.1.0 on the 15-criteria cap run: same
  stop, same reason, same non-re-check steps).
- Not re-checked: the `check_cmd` scripts and the review probes.

### Smaller fixes (task 1970)

- IaC push gate hints: `atlantis.y*ml` and `.spacelift/` files get "orchestrator config change",
  the version files (`.terraform-version`, `.opentofu-version`, `.tofu-version`) get "IaC tool
  version file change". Before, a `version:` line in an orchestrator file was hinted as a
  "provider source or version change". Hints only: `touched`, `iac_files` and `problems` are
  unchanged.
- Origin URL: the workspace step runs `REMOTE_URL_PY` (`python3 -I`, caps,
  `git config --get remote.origin.url`) and relays `remote_url_check` `{url, args, digest}`. The script recomputes
  the digest and checks the args, at plan time for the seal and at build time for the
  comparison; a free-text `remote_url` is no longer read. An unusable relay leaves the URL empty,
  which the IaC push gate refuses as before.
- Mutants P7 (remote-head args check dropped), P8 (remote-head digest check dropped) and P10
  (`isIacPath` without the provider lock file) were applied and run: the 3.1.0 suite kills each
  one. No test was added for them.

## [3.1.0] - 2026-11-09

Ledger tasks 1959, 1958, 1935 and 1941, the review rounds of PR #38, and Max's ruling of
2026-11-09 on IaC tooling (task 1960 is moot: the IaC text scan it tuned is removed).

**Deploy order:**

1. Install the nix agent PATH shims for terraform, tofu, tfp, terragrunt, digger and atlantis (and the
   docker/podman exec shims for tf-local-plan) FIRST. Each shim must live under `/nix/store/` and
   hold the marker `fleet-agent-shim: hard-rules`. Without them, any of these tools that is on the
   agent PATH stops every 3.1.0 run at preflight ("terraform tooling on PATH is not shimmed;
   install the agent PATH shims (nix) before using the fleet").
2. Update the role page `fleet-code-judge` in place to version 15. Version 15 makes the
   `check_cmd` run required and adds the optional `check_exit` key to `obligations_check` entries;
   no key is renamed or removed, so 3.0.0 keeps running on it and logs "prose-only changes
   assumed". 3.1.0 pins `fleet-code-judge` 15: an older page stops the run in preflight ("... must
   be >= 15; update that page in place; see CHANGELOG 3.1.0 deploy order").
3. Optionally write `scope-and-plan` v28 (the hook-rule sentence; the pin stays 27).
4. Install 3.1.0, then `/reload-plugins`.

The contract marker stays `fleet-v3`.

### IaC tooling: a new trust model (Max, 2026-11-09)

The fleet may work on terraform and other IaC code like any other code. **Removed:** the IaC
refusal scan of 2.1.2–3.0.0 (`IAC_SCAN_PY`, `iacRefuse`, `infra:iac-scan:plan`,
`infra:iac-scan:verify`, the `IAC_RE` text match over hooks, task runners and the files they name)
and everything this release had added to it (the remote hook manifest read from the pre-commit
cache, the shallow fetch with its host allowlist and caps, the follow and leaf rules). A repo with
IaC files or IaC tooling in its hooks no longer stops the run.

What keeps IaC tooling from running now:

- Max's hard rules (no terraform by any mechanism, no tf-local-plan container exec), which every
  role inherits, and the settings.json denies on those commands;
- the agent PATH shims nix installs: on the agent PATH, terraform, tofu, tfp, terragrunt, digger
  and atlantis reach a shim that refuses (each shim holds the line
  `# fleet-agent-shim: hard-rules`; the check matches the substring, comment prefix optional);
- the hook gate (below): a change to anything the repo's hooks or CI run needs its own PR and
  Max's confirmation;
- ADR-1152 still frames the gates: they defend against reward hacking, not a hostile agent.

**New: the PATH check (preflight, plan and build mode).** Preflight runs `PATH_CHECK_PY`
(`python3 -I`, resource caps), which resolves terraform, tofu, tfp, terragrunt, digger and atlantis on the
agent PATH. A name that resolves passes only when its real path is under `/nix/store/` (which no
role can write) and its first 64 KiB hold `FLEET_SHIM_MARKER` = `fleet-agent-shim: hard-rules`.
Anything else stops the run before any other step: `needs_human`, `stop_gate: "iac"`, "terraform
tooling on PATH is not shimmed; install the agent PATH shims (nix) before using the fleet". No name
resolving at all passes. The program gets the repo as its argument and reads the raw agent PATH:
an empty or relative entry (the agent's shell resolves it against the worktree, the program would
against `/`) or an entry inside the repo (the worktree, the scratch dir) stops the run as well
("PATH has entries the agent shell resolves differently"). A missing or tampered result stops the
same way: no `path_check`, a wrong digest, tool keys other than exactly the six names, an entry
whose `path` is not absolute or whose `shim` is not a boolean, or a program argument other than
the repo; a found entry passes only with `shim` exactly `true`. The relay trust model stays
ADR-1152 (an unkeyed digest). Every embedded program gives its children a PATH without empty or
relative entries, and the fixer gives pre-commit and its hooks one without the worktree's and the
scratch dir's entries.

**Accepted residual (ADR-1172):** a hook's or a test's call by absolute path to a real binary,
and a container image built to run terraform. Max's hard rules and the settings.json denies are the
controls there; no content scan stands in for them.

**IaC paths are fleet work (ADR-1172).** The scope fence no longer refuses IaC paths (`*.tf`,
`*.tfvars`, `terraform/`, Kubernetes and Helm manifests), at plan time or in a coder's changes. It
still refuses `.github/`, the hook-manager and CI paths, rulesets and secret-like paths.

**New: the IaC push gate (ADR-1172 and ADR-1175).** Terraform diffs never
push automatically; the fleet stops and hands the push to Max. Content checks are hints only.
Before every push, `infra:tf-gate:push` (`TF_GATE_PY`, read only, `python3 -I`, caps, digest and
argument checked) reads the PR diff (`merge-base..<approved sha>`). The base comes from origin
itself: the program reads `refs/heads/<default>` with `git ls-remote` (never the local
`refs/remotes/origin/<default>`, which a role's shell can move) and fetches that one sha when the
repo lacks it (a full fetch: `--depth` would mark a full clone shallow once origin is further
ahead). Either failing stops the run.

The network reads never go through the repo's own config, which a role can edit (`core.sshCommand`,
`remote.origin.uploadpack`, `insteadOf`, credential helpers). The plan seals origin's configured URL
(`plan_facts.remote_url`, https or `git@host:` form only) before any role runs; the programs pass
that URL straight to `ls-remote` and `fetch`, read in a fresh bare scratch repo that borrows the
repo's objects (alternates), and override `core.sshCommand` (`ssh -o BatchMode=yes`),
`core.askPass`, `core.fsmonitor`, `core.hooksPath`, the upload-pack and the allowed protocols (https
and ssh only) on the command line, with `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_NOSYSTEM=1`. A plan
ref without a sealed URL, a URL in another form (a local path, an ssh alias without `git@`), or a
configured URL that changed since the plan stops the push gate (`stop_gate: "iac"`; re-run plan).
Residual (ADR-1152): a role that edits the user's global git config or environment stays outside
the threat model. When it touches any IaC file
(`*.tf`, `*.tofu`, `*.tf.json`, `*.tofu.json`, `*.tfvars`, `*.tfvars.json`, `*.tofuvars`,
`*.tofuvars.json`, any `*.hcl` or `*.hcl.json` (the lock file and the grunt configs included), `*.tfbackend`,
`.terraform-version`, `.opentofu-version`, `.tofu-version`, `atlantis.y*ml`, `digger.y*ml`, a
terraform CLI config file, anything under `.spacelift/`, or a path with a `.terraform`, `terraform.d` or
`.terraform.d` segment; names match in any case), the run stops before the push in every confirm mode, `auto` included:
`needs_human`, `stop_gate: "iac-push"`. The message names the branch, the commit sha, the IaC files
and the exact push command (`git -C <worktree> push -u origin <branch>`) for Max to run himself.
The fleet never pushes an IaC diff, in any path. After Max pushes it himself, a build run of the
same `plan_ref` reads the remote branch head (`REMOTE_HEAD_PY`, `git ls-remote`, read only,
digest and argument checked) and goes on to the draft PR, the review and the write-back without a
push, only when that head is exactly the approved sha. A missing branch, another sha, or a head
ahead of or behind the approved sha stops at `iac-push` as before. No argument opts into a push:
an agent could pass one, so it would not prove that Max confirmed.
The workflow also checks the relay against the fleet scan's digest-checked PR diff: an IaC path
there that the relay does not list stops the run (`stop_gate: "iac"`).

The content checks stay only as hints in that message, under "hints (not a security check)": an
external data source, a provisioner, `local-exec` or `remote-exec`, `dev_overrides` or
`provider_installation`, a CLI config, provider `source`/`version` or lock file change, the
external, local or null provider or a `local_*`/`null_*` resource, a `digger.y*ml` change, a CI
file in the same diff, and a `.tf.json` that does not parse. They decide nothing.

Three checks still stop the run (`stop_gate: "iac"`), fail-closed:

1. a path with a `.terraform`, `terraform.d` or `.terraform.d` segment, the final segment included
   (provider plugin directories; the scope fence refuses them too, `stop_gate: "scope"`);
2. a symlink (mode 120000 in `git diff --raw`) at an IaC path, or whose target lies in such a
   directory;
3. a change to code that existing IaC runs at plan time: at the base, every directory with a
   `.tf`, `.tofu`, `.tf.json` or `.tofu.json` file that holds `data "external"`, a provisioner,
   `local-exec`, `remote-exec` or the local, null or external provider is an exec stack; a changed
   non-IaC file under such a directory, or a repo file an exec stack names as a literal in
   `program = [...]`, `command = "..."` or `file(...)`, stops ("changes code that existing IaC runs
   at plan time"). Accepted over-reach: an exec stack at the repo root stops every non-IaC change,
   and a base IaC file over 1 MiB stops every push. Accepted residual: an exec reference that is not
   a literal (a variable, a `local`, an interpolation) and points outside the stack directory.

### New stops (fail-closed additions; no key renamed or removed)

- **The PATH check** above.
- **Hook changes are their own PR, and need Max (Max's rule).** The hook surface is every
  hook-manager and CI path, in any case: `.pre-commit-config.yaml`, `.pre-commit-hooks.yaml`,
  `.github/**`, `.gitea/**`, `.forgejo/**`, `.woodpecker*`, `.circleci/**`, `.gitlab-ci.yml`,
  `.gitlab/**`, `Jenkinsfile`, `.buildkite/**`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`,
  `.husky/**`, `.githooks/**`, `lefthook*.yml`, `.lefthook*`, `atlantis.y*ml` (the scope fence refuses the same set
  in a coder's changes). The read-only program `HOOK_SURFACE_PY` (the fixer's isolated PyYAML
  loader, at the base and in the worktree) adds every file a hook `entry` or `args` names (a
  `--flag=value` only when the value is an executable script, so `--config=pyproject.toml` is not
  surface), `-m pkg.mod` as `pkg/mod.py` and `pkg/mod/__main__.py` (any `-m` form, `-Im`
  included), every Makefile and `*.mk` for a hook that runs `make`, the in-repo target of every
  surface symlink, one level of what the hook scripts load (repo-local Python imports, from the
  repo root and the script's directory; shell `source`/`.`; scripts they run directly with
  `bash`/`sh`/`python`/`node` or `./X`; a Python script that does not parse puts its directory in
  the surface), the scripts CI and hook-manager files name (`.github/actions`, husky, githooks,
  lefthook, the hooks dir, `package.json` scripts; one that does not parse or is over 1 MiB
  refuses), and the `core.hooksPath` directory. `Makefile`, `package.json` and `pyproject.toml`
  alone are not surface: they are task runners every version bump touches. The plan scope
  (`allowed_additions.files`, obligation files, criterion test files, caller occurrences mapped to
  a criterion) is checked before the audit (`infra:hook-surface:plan`), and the approved tree's
  diff from the plan commit right before the commit (`infra:hook-surface:r<n>`). Surface and
  anything else stop with "hook changes must be a separate PR (Max's rule)"; surface only stops
  with "hook change needs Max's confirmation". Both are `needs_human`, `stop_gate: "hooks"`, in
  every confirm mode. A surface that cannot be computed (no PyYAML, a parse error, a capped value)
  refuses. The `scope-and-plan` page gets one sentence telling the planner so (prepared, not
  written; the pin stays 27, because the rule lives in script code).
- The fixer step refuses a hook config over 256 KiB, a non-string `entry` or `language`, or `args`
  that is not a list of strings (pre-commit's own schema requires a list).
- A code-judge `approve` becomes a `fix_code` round when an allowlisted `check_cmd` exited with
  anything but the integer 0, has no `check_exit` and no `gates_not_run` entry `check_cmd:<id>`,
  or when the change edits what that `check_cmd` runs and the obligation does not list the file.
- A push whose output mixes the hook's lines with git's (`ambiguous`) stops for a human.
- A verify, commit-plan or `hook_rejected` push relay that does not match its program's digest,
  or whose program ran on other arguments, fails the run.

### Changed

- **Role-page pins at the live versions** (ledger 1941a). `fleet-test-writer` 10,
  `fleet-test-judge` 10, `pr-review` 18 and `gate-change-nonweakening-sweep` 5 (each read with
  `agent_prompt_get(<role>, project="m-agahi/yadgar")` on 2026-11-07), and `fleet-code-judge` 15
  (the 3.1.0 page write). `scope-and-plan` 27, `plan-audit` 16, `fleet-coder` 17, `fleet-pr-opener`
  10 and `fleet-intent-judge` 2 are unchanged.
- **verify-plan and commit-plan relay programs, not git output** (ledger 1959). `infra:verify-plan`
  runs `VERIFY_SINCE_PY`, which prints
  `{head, is_ancestor, commits_since, plan_touched, changed_since, args, digest}`;
  `infra:commit-plan` runs `PLAN_FILES_PY`, which prints `{head, files, args, digest}`. `args`
  echoes the program's arguments. The script recomputes each digest, compares `args` with what it
  passed, and stops the run (`failed`) on any difference or a missing list. Both programs run with
  `python3 -I`, take the worktree as an argument and change to `/` before they run git.
- **The push classifier is a program** (ledger 1935c). `infra:push` runs `PUSH_CLASSIFY_PY` on the
  first attempt's output (its last 1 MiB) and exit code; it prints
  `{push_result, exit_code, hook_tail, args, digest}`. It reads line-start prefixes only, and a
  pre-push hook can print the same prefixes, so no rule retries what may be a hook's verdict (a
  retry re-runs the hook): `error: failed to push some refs` (git's line for a declined pre-push
  hook) with exit 1 and no ` ! [` is `hook_rejected`; with another exit code, or with a `fatal:`,
  `error: RPC failed` or git-lfs line (`batch request:`, `batch response:`, `LFS:`), it is the new
  `ambiguous` (a stop for a human). Only an output with no hook verdict is `network` and retried.
  The script accepts `hook_rejected` only with exit code 1, the program's digest and `args` that
  name a file outside the worktree and that exit code.
- **CI-only obligations are checked before the push** (ledger 1935b). The code judge (page 15)
  runs every allowlisted `check_cmd` in a scratch worktree loaded with the judged tree and reports
  `check_exit`. On `approve`, the obligations gate converts the verdict to `fix_code` for an
  obligation whose `check_cmd` exited with anything but the integer 0 (disclosed or not), or that
  has neither `check_exit: 0` nor a `gates_not_run` entry `check_cmd:<id>` (stated in the PR
  body). An obligation whose `check_cmd` the script check demoted that round needs no exit. The
  workflow script still runs no planner command. In `commands`, a check_cmd shows
  `code-judge (required)` as its `run_by`.
- **The coder may not edit what a check_cmd runs** (review F2). On `approve`, a change from the
  plan commit to the judged tree that touches the check_cmd's script, a Makefile or `*.mk` or a
  repo path the `make <target>` recipe names (for `make`), or `.pre-commit-config.yaml` (for
  `pre-commit run <id>`) is a `fix_code` round, unless the obligation's `files` list that path. A
  local hook's entry file was already refused by the fixer step. Limit: a module that a check
  script imports is not traced.
- **`gates_not_run` is a union** (review). The PR states every gate the code judge lists plus every
  gate the script knows did not run.
- **Write-back to a yadgar ledger task without a body page** (ledger 1958). A read-only judge step
  (`infra:ledger-read:pre`, `fleet:judge`) reads every ledger task first. A task with a body page
  goes to the append step (`infra:ledger-writeback`, as in 3.0.0). For a task with none,
  `infra:ledger-body` runs on the new `fleet:ledger-writer` agent: it re-reads the task (title byte
  for byte, else it writes nothing), creates the page with `wiki_add` at the slug the script
  computes, `{project with / as _}_task-<id>` (`upsert=False`, `wait=True`; it never overwrites an
  existing page and appends to one only when it lacks the marker), and links it with
  `task_write(project_id, id, title=<the title the judge read>, body_slug=<slug>)`. Any status
  other than `written` fails the entry before any further read. A second judge read
  (`infra:ledger-read:post`) must show the same title, the computed `body_slug`, the marker, and the
  page's `page_project` and `page_tags` must be this project and include `ledger-<id>` (a slug
  collision check in code: `a_b/c` and `a/b_c` share a slug); otherwise the entry fails and hands
  `section_text` back, and a changed title is named ("restore the title by hand"). The title must
  have 1 to 200 code points. **The title check works at the relay level only:** `task_write`
  requires a title on every update, so the write itself can change it; the reads before and after
  detect that, they cannot prevent it. A project that is not `<owner>/<repo>` writes nothing. The
  yaadgaar path is unchanged.
- **Agent tools** (review F1). `fleet:ledger-writer` has a `tools:` allowlist: `ToolSearch`,
  `StructuredOutput` and `mcp__yadgar__task_get`, `wiki_read`, `wiki_add`, `wiki_append_section`
  and `task_write`; nothing else. Not verified: whether the allowlist also governs MCP tools loaded
  later through ToolSearch. `fleet:judge` keeps its denylist (it needs `Bash` and many read
  tools), extended to every yadgar writer; for the judge this is hygiene only, because it has
  `Bash`.
- **Resource caps on every embedded program** (security review). Every embedded Python program
  (and both YAML loaders) sets `RLIMIT_AS` (1 GiB) and `RLIMIT_CPU` (300 s; the loaders 60 s)
  before it does anything, and tunes git's children to stay inside them (`core.packedGitWindowSize`,
  `core.packedGitLimit`, `core.bigFileThreshold`, `pack.threads`, `MALLOC_ARENA_MAX`, through
  `GIT_CONFIG_COUNT`). The repo's own hooks, which the fixer program runs through pre-commit, get
  the soft limits lifted back. Both YAML loaders read at most 256 KiB, emit only string values
  (`entry`, `language`; `args` must be a list of strings), have no `default=str`, and stop past
  1 MiB of output; a timeout, a non-string value or an oversized config is a refusal. The hasher
  reads only strings from the config too, and hashes files 1 MiB at a time. A 2026-11-07 test of a
  billion-laughs config against a draft loader without these caps grew without bound on the
  development machine (`json.dumps` walked the shared alias references); the same test now refuses
  in about a second.
- **Writers and the test judge get the plan's env** (ledger 1935a): already true in 3.0.0 (they get
  the whole `test_cmd`, `env` included, plus `test_env`); a regression test now pins it.

### Tests

- Push fixtures captured from git 2.55.0: `[remote rejected]` from a pre-receive hook, a declined
  local pre-push hook, a non-fast-forward, HTTP 500 and 502 on the receive-pack POST, and HTTP 500
  and 503 on `info/refs`. Derived (not observed): an RPC failure without its `fatal:` line, a hook
  that prints a line-start `fatal:`, a git-lfs pre-push network failure, and a gh 5xx error string
  in `remote_head`.
- Every `python3` a test starts is bounded by a timeout and an output cap; the suite is run under
  `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0`.
- Survivor tests M11c (exit code other than 1 is never `hook_rejected`), M20 (a ledger-writer
  status other than `written` fails before the post-read) and N7 (a script a hook's args name is
  hook surface).

## [3.0.0] - 2026-11-07

Ledger tasks 1926, 1957, 1956, 1952, 1951 and 1928.

**Deploy order:** update the role pages `scope-and-plan` (to version 27 or later), `plan-audit`
(16 or later) and `fleet-coder` (17 or later) BEFORE installing 3.0.0. The page changes are
additive, so 2.1.6 keeps running on them (it logs "prose-only changes assumed"). 3.0.0 pins those
minimums: an older page stops the run in preflight with "the agent_prompt_get(<role>, project
m-agahi/yadgar) wiki version <N> must be >= <M>; update that page in place; see CHANGELOG 3.0.0
deploy order". The contract marker stays `fleet-v3`: no key was renamed or removed and no meaning
changed; the new page text and the optional `symbol` key are additions, guarded by the pins.

### Breaking changes

- **Higher role-page pins:** scope-and-plan 27, plan-audit 16, fleet-coder 17 (see the deploy
  order above).

- **Build-time caller check** (ledger 1956). After the code judge approves a tree and before
  every commit, the run stops (`needs_human`, new `stop_gate: "callers"`) on a modified existing
  definition that `changed_symbols` does not map in the same file and line range, and on a change
  in an unclassified file or at module level in a file the plan does not name. Builds that 2.1.6
  committed can now stop here.
- **yaadgaar write-back writes** (ledger 1928). A build of a yaadgaar task now edits that task's
  body; 2.1.6 only returned the section text.
- **Branch-scan output shape** (ledger 1952). `infra:branch-scan` returns `{commits, refs, digest}`;
  each ref entry carries `task_id`, `plan_path` and `ref_ok` instead of `content`. The plan-ref
  reader has no full-content mode any more (`meta` or `chunks:<ref>` only).

### Added

- **CI runs the node suite** (ledger 1926). `validate.yaml` sets up Node 24 (`actions/setup-node`
  pinned by SHA) and runs every `plugins/*/tests/*.test.mjs`, with the file list expanded by the
  shell. `node --test <dir>` runs a directory as one file on Node 22 and later and fails; the test
  header and the README now name the file form.
- **`infra:changed-defs:r<n>`** (ledger 1956), a read-only step (`fleet:judge`) that runs a program
  over `git diff <plan_commit> <approved tree>` for the files that existed at the plan commit and
  lists every existing definition the tree modifies (`{name, at, end}`, every definition of a
  name): removed or re-added definition lines, and the innermost enclosing definition of every
  other change, read from the base blob (git's hunk header names the nearest column-0 line without
  a `diff=` attribute, the class rather than its method). It also lists `excluded` (criterion test
  files, the plan doc), `unclassified` (no definition pattern, binary) and `unattributed`
  (module-level changes); path names are printed with non-printable characters escaped. Makefile
  targets and variables, shell functions and shebang scripts are classified. Every added line is
  attributed on its own (a line inside a new definition to it, a decorator to the definition after
  it, any other line to its enclosing base definition). A definition counts as mapped only when
  its symbol has an occurrence in the same file inside its lines; an unclassified file, an
  unattributed change or a definition whose name is no identifier passes only in a file the plan
  lists explicitly (`allowed_additions.files` or a repo obligation's `files`; an occurrence of a
  mapped symbol there does not count). Every excluded or unclassified path
  gets a gate line. The relayed lists are checked against the program's digest. A ref sealed before
  2.1.6 skips the check with a gate line. Tests: the actions#211 B1 PoC (the coder changes
  `prestop_sleep`, which the plan never mapped) stops before the commit; a same-named function in
  another file is not covered by the mapped one (security review).
- **Caller-check attribution (PR #36 review 3).** A definition nested in an existing function (a
  shadowing `def`, a decorated nested def, `class _K: z = sabotage()`, `def _h(a=sabotage())`, a
  JS one-line arrow, a Rust `fn _h() {}`) and its decorators now name the enclosing function; only
  a new column-0 definition that opens a block is an addition. Multi-line signatures (black-style
  Python, Go, TS methods) count from their opening line. JS `X.y = function` and `X.y = (...) =>`
  are definitions. Lines that only close a block, appended brace-language functions and renamed
  files give no needless stop. **Known limit:** a new method in an existing class records nothing,
  even when it overrides an inherited method.
- **Caller-check attribution (PR #36 review 4).** An Allman brace on its own line is stepped over
  to the signature above it (C, Java, C#). A decorated new member, and a new nested class or
  struct (`class _K: z = sabotage()`), name the enclosing class. A rename onto an excluded path is
  checked as a deletion of the old file. **Accepted under ADR-1152:** a JS statement misindented to
  member level inside a class body is read as part of the class, not attributed separately.
- **Fixer hooks on build files** (ledger 1951). `infra:format-tests:r<n>` (before the ownership
  hash, the test judge and the freeze) and `infra:format-code:r<n>` (before the purge, the
  post-coder hash and the code judge) run `pre-commit run --files <paths>` until a run changes
  nothing, at most 3 runs, so the judges and the hashes see the bytes the commit-time hooks leave.
  A pre-commit fixer no longer stops the build at the commit step. A hook that changes a frozen
  file (`stop_gate: hash`), a path outside the files it was given (`scope`), or still rewrites
  after 3 runs (`commit`) stops the run. The hooks run in a scratch checkout of HEAD: only the
  selected files are copied in and back, and files under the top-level directory of a hook entry
  or `-m` module the config names are never selected, so a coder's edit to hook code never runs
  (real pre-commit 4.6.2 ran an edited `-m` module from the worktree). A changed
  `.pre-commit-config.yaml` stops the run (`stop_gate: hash`) before any hook runs; each run is
  capped at 180 s. The commit step's tree-equality check (ADR-1151) is unchanged.
- **Fixer hook surface is exact** (PR #36 review 5). The surface is the config, every path a hook
  `entry` or `args` names, and the files of every `-m` module; a path that only appears in a
  `files:`/`exclude:` regex is formatted (the top-level-directory rule of review 4 left most files
  of a repo unformatted). A surface path that differs from HEAD stops the run before any hook runs.
  A selected path through a symlink (HEAD mode 120000, a symlinked parent at HEAD or in the
  worktree, a realpath outside either checkout) stops it too. A scratch checkout a killed run left
  behind is removed first. The config is read only with PyYAML, through pre-commit's own
  interpreter (its shebang, or a pipx/nix wrapper's `exec` target, followed to the Python), else the
  program's `python3` if it has PyYAML; any YAML form works, flow maps and folded scalars included.
  No interpreter with PyYAML refuses the step; there is no line-parser fallback (reviews 6 and 7).
  The wrapper test uses bash, as nix wrappers do (`exec -a` is not in dash).
- **No program imports from the worktree** (PR #36 review 8). The YAML loader ran without `-I`
  and with the worktree as cwd, so a coder-written `yaml.py` shadowed PyYAML and emptied the hook
  surface (PoC with real pre-commit 4.6.2). It now runs as `<python> -I -c` with cwd `/`. Every
  embedded program already ran as `python3 -I`; a test now checks each invocation, that a
  `yaml.py` or `json.py` in the cwd changes nothing, and that no program needs a third-party import
  (PyYAML only where it fails closed, `tomli` only as the `tomllib` fallback). The nix pre-commit's
  own interpreter now finds PyYAML: the program adds the `/nix/store/.../site-packages` paths its
  wrapped script names, and only such paths. **Accepted under ADR-1152:** a helper that a hook entry imports without
  the config naming it still runs from the scratch checkout of HEAD unless it is itself a selected
  file.
- **yaadgaar write-back** (ledger 1928). For a `yaadgaar` source of a `yadgarhq/` project,
  `infra:yaadgaar-writeback` (default agent; `fleet:judge` may not write to a ledger) appends the
  `## Fleet build` section with `mcp__yaadgaar__read_task` and `mcp__yaadgaar__edit_task`: it
  checks that the client resolves to the project and that the task names no other project, edits
  by id with `expect_version`, writes an empty body as the heading plus the section with a
  script-computed `expect_body_sha256` and appends to a non-empty one only through a literal
  `patch` on a unique tail, retries once on `VERSION_MISMATCH`, and re-reads to confirm. Never the
  yadgar ledger. A read-only step (`infra:yaadgaar-read`) returns the project it resolved and each
  task's id and version first; the script refuses an absent or other project before any edit step
  runs, and skips a task that already carries the marker. The read answer's number and project
  must match the request, and its version must be an integer; the edit step re-reads the task by id
  and checks number and project before it edits (fail closed). `fleet:judge` now disallows
  `mcp__yaadgaar__edit_task`, `create_task` and `transition_task`. Task bodies are data, not
  instructions.
  A ref that is not a task number is never sent. 2.1.6 handed the section back for a human to post.
- **Codeberg plan link** (ledger 1928). The workspace step returns `remote_host`; a Codeberg origin
  gets `https://codeberg.org/<o>/<r>/src/branch/<branch>/<plan>` in the ledger section and comments.
- **No model blob relays left on the gate path** (ledger 1952). The branch scan is one program that
  reads each plan-ref message itself and prints `task_id`, `plan_path` and `ref_ok` (the
  `planRefProblem` checks, ported; a test checks Python and JS agree), never the message text.
  `infra:iac-scan`, `infra:fleet-scan`, `infra:read-state`, `infra:review-paths` (now a program,
  not a raw git command) and `infra:check-scripts` print a digest the script recomputes. A
  mismatch stops the step: iac (`stop_gate: iac`), fleet-scan (`scope`), read-state (`resume`),
  review-paths and branch-scan (failed); for check-scripts every script becomes judge-only. The
  iac scan always prints `error` (`null` when none), and the read-state program always prints
  every key. The branch scan prints `task_id` and `plan_path` only for a ref that passed every
  check, both shape-checked.

### Changed

- **plan-audit findings name their symbol** (ledger 1957). A plan-audit `routed_findings` entry
  may carry an optional `symbol`. The `:audit-fix` round must keep every symbol a finding names in
  its caller map, as it already does for grep findings. The shared test-judge and code-judge
  findings schema is unchanged.
- **Preflight pin message.** A page below its pin now reads "the agent_prompt_get(<role>, project
  m-agahi/yadgar) wiki version <N> must be >= <M>; update that page in place; see CHANGELOG 3.0.0
  deploy order". The old text implied the page lives in project m-agahi/yadgar; it lives in the
  shared wiki and that call resolves it.
- README: "or a finding named" now reads "and every symbol that one of its findings names".

### Fixed

- **Tests for two mutants of the `:audit-fix` carry** (ledger 1957): H6, a round refused only
  for a confusable character must carry its caller map; H8, a map with a malformed entry must
  carry its valid entries. Each test fails on its mutant.

## [2.1.6] - 2026-11-07

Caller coverage for changed symbols (ledger 1955) and the minor findings of the PR #33 re-review
(ledger 1954).

**Deploy order:** update the role pages `scope-and-plan` (to version 26 or later) and `plan-audit`
(to version 15 or later) BEFORE installing 2.1.6. This release pins those minimums, so an older
page stops the run in preflight with "update agent-prompt-<role> (project m-agahi/yadgar) to >= v<N>;
see CHANGELOG 2.1.6 deploy order". The contract marker stays `fleet-v3`.

### Added

- **Caller map for every changed symbol.** A build from an audited plan shipped a guard weakening
  (yadgarhq/actions#211 B1): the plan changed `guard_verdict` but modelled one of its two call
  sites. The planner now returns `changed_symbols` (required on `ok`): for each existing function,
  guard or symbol the plan changes, every occurrence as `"<path>:<line>"`, mapped to exactly one of
  an existing criterion id or a `dont_care` reason. The script refuses a symbol that is not a bare
  identifier or is listed twice, a missing or empty occurrences list, an occurrence that is not
  `path:line` or is listed twice, one mapped to neither or to both, an unknown criterion id, and
  more than 30 symbols.
- **Independent grep check.** A read-only step (`infra:callers`, the read-only judge agent) runs
  `git grep -n -I -w -F` for each symbol over the tracked text files, the run's own plan doc
  excluded. The script diffs the hits against the map: a hit the map leaves out, a mapped line that
  is no hit, and a symbol with more than 100 hits are refused. The program prints a digest over its
  lists, and the script recomputes it, so a hit the relay drops fails the step. Limits: the grep is
  name-based: a call through an alias, a re-export under another name, a name built at runtime
  and callers in other repos are missed (a literal string holding the name is a hit). Submodules
  are not searched, and files git treats as binary (`-I`, `.gitattributes` included) are skipped.
  It reads the working tree content of the tracked files. It over-matches comments, docs and
  same-named symbols (the planner maps those as `dont_care`). An occurrence's `criterion` and
  `dont_care` must hold no invisible or confusable character.
- These refusals stop the run with `needs_human`; under confirm auto they go to the one
  `:audit-fix` re-plan round (the one-round total is unchanged). That round must keep every symbol
  the refused round mapped or a finding named; a dropped or swapped symbol stops the run (narrower
  symbols only in addition). A symbol over the grep cap therefore always ends with a human.
- **The audit gets the map.** plan-audit receives `changed_symbols` and `caller_check`
  (`{method, limits, occurrences}`) to judge whether each mapping is right. The map is sealed in
  `plan_facts` and reaches the coder, the code judge and, under confirm auto, the intent judge. In
  the `:audit-fix` round the audit also gets `prior_round` (`{reason, findings, changed_symbols}`
  of the refused round; `null` otherwise).
- A ref sealed before 2.1.6 still builds, with `changed_symbols: null` and the gate line "this
  build runs without caller coverage".

### Changed

- **Confusable check covers text and dont_care.** Test writers get the whole criterion, so a
  criterion's `text` and `dont_care` are now checked as well as `examples` and `property`. Only
  `spec_quote` stays unchecked.
- **Wider confusable set.** Every Unicode control (Cc, CR included), format character (Cf), space
  (Zs) and line or paragraph separator (Zl, Zp) is refused except the plain space, tab and newline;
  also U+FE00-U+FE0F, U+E0000-U+E007F, U+115F, U+1160, U+3164, U+FFA0, U+034F, U+180E and U+00AD.
  Visible typography (em dash, smart quotes, arrows) still passes. Emoji built with U+200D or
  U+FE0F are now refused. A test checks every code point: all that 2.1.5 refused are still
  refused.
- The `fleet:judge` agent description names the caller grep step.
- **plan_path characters.** A planner `plan_path` must use only `[A-Za-z0-9._/-]`.

### Fixed

- **A crash after the planner logs the park outcome** (moved to the scratch dir, or left in the
  worktree) before it rethrows the original error.
- **load-ref retry:** a test now covers a retry whose chunks match but whose ref targets another
  commit; the run stops (the re-check of the retried ref was untested).

## [2.1.5] - 2026-11-06

Fixes from the 2.1.4 live trial (yaadgaar #622, confirm auto).

### Fixed

- **Contract-mismatch stops say how to recover.** Both contract stops (preflight and a role
  runner) now end with "run /reload-plugins or start a new session, then run /build-task again":
  a session started before a plugin update keeps the old workflow.
- **No invisible or confusable characters in criteria examples.** A criterion about NBSP lost its
  NBSP on the JSON path and became a duplicate of the plain-space case. A string in a criterion's
  `examples` or `property` that holds NBSP, U+2000-U+200F, U+2028-U+202F (separators, bidi
  embeddings, narrow NBSP), U+205F, U+2066-U+2069, U+061C, U+3000, U+FEFF, a C0 control other
  than tab and newline, DEL or a C1 control now stops the run before format and audit, naming the
  code point; the planner must write a named constant such as `NBSP = chr(0xA0)`. Visible
  non-ASCII (em dash, smart quotes, arrows) is fine, and `text`, `dont_care` and `spec_quote` are
  not checked.
- **confirm auto: one re-plan round after a plan refusal.** A `plan_defect` or
  `untestable_criteria` verdict, or a confusable character in the criteria, now sends the findings
  to the planner once (labels `:audit-fix`; the draft is updated in place, then checked, formatted
  and audited again). A second refusal stops as before. The sealed brief does not carry the
  findings. confirm ask is unchanged: the refusal stops the run.
- **Stable task ids for free text and ingested plans.** The slug came from the title intake
  writes, so a re-plan of the same text could open a new branch and worktree. Every free-text task
  also shared the task id `task`, and every ingested plan the id `plan`, so each shared one plan
  ref. A free-text task id is now `t` + the first 8 hex of the sha256 of the raw input, with the
  slug from that input; an ingested plan's id is `p` + the first 8 hex of the sha256 of its plan
  path. Ledger, Jira and issue ids were already stable.
- **The planner's `plan_path` is checked before anything touches it.** An absolute path, a `..`
  segment or a name that does not end in `.md` stops the run before the park or format steps.
- **A crash after the planner still parks the draft.** Any error, not only a gate stop, moves the
  run's own draft out of the worktree; the original error is rethrown unchanged.
- **Canonical JSON sorts keys by code point.** It now matches Python's `sort_keys`, so the hasher
  digest holds for paths with astral characters (JS `.sort()` put them before U+E000-U+FFFF).
- **Undeclared array fields in result schemas.** `INFRA_SCHEMA` now declares `iac_files`,
  `iac_text`, `files`, `diff`, `refs` (with an item shape) and `reused`; scope-and-plan declares
  `allowed_additions` (object or null, with `files`, `symbols`, `deps`, `settings` arrays). An
  undeclared field came back as the string `"[]"` and stopped the run with a false IaC refusal or
  a false "no plan-ref list". A test maps every `Array.isArray(<result>.<field>)` site to the
  schema its object came from and fails on an unmapped site or an undeclared field.
- **The hasher's `ignored` map is declared and required.** The schema and the prompt left it out,
  the relay dropped it, and the script read the missing map as empty: the next fingerprint then
  saw `.claude/settings.local.json` as "ignored path written" by the intent judge. A hasher result
  without the map now fails.
- **No replayed worktree checks on resume.** The workflow runtime replays the cached result of an
  unchanged prompt on `resumeFromRunId`, so a resumed run got the workspace step's earlier "dirty"
  verdict for a worktree that was already clean, and could equally get a stale "clean" or a stale
  hasher map. `args.run_nonce` is now required in both modes (the skill passes `date +%s%N`) and is
  appended to every infra and hasher prompt, so a new invocation never replays one. The script
  cannot read git state itself; the nonce is the only lever. A runtime resume therefore re-runs
  everything after preflight; build mode keeps its own run-state resume. The skill and the README
  document the new argument.
- **No exemption for `.claude/settings.local.json`.** The trial's "judge mutated worktree ...
  settings.local.json" stop came from the dropped `ignored` map above, not from the judge. With the
  map required, the file is in both states and the judge fingerprint is unchanged from 2.1.4: any
  change to the file during a judge run (a `hooks` key, a new permission, its removal) still
  discards the verdict.
- **The plan runs through the repo's hooks before the audit.** A prettier hook rewrote the plan in
  the plan commit, so the committed plan no longer hashed as the staged one. A new
  `infra:format-plan` step (after the planner and the IaC refusal, before plan-audit) runs
  `pre-commit run --files <plan_path>` until the fixers are done (at most 3 runs); the audit then
  approves, and the commit holds, the fixed bytes. A hook that fails without a rewrite, or touches
  any other path (listed with `--untracked-files=all`, so a new plans dir shows its file), stops the run. Commit-plan no longer re-adds a plan a hook rewrote: it stops
  instead. Repos with hooks outside pre-commit (husky, lefthook) are not covered yet.
- **A stopped plan run parks its draft.** A stop between the planner and the plan commit (a
  plan-audit refusal, a refused command, a failed commit) left the untracked plan in the fleet
  worktree, and the next plan run's workspace step refused the dirty tree. Plan mode now moves the
  run's own `plan_path` (nothing else; any other dirty path leaves the worktree untouched) to
  `scratch/parked/<run_nonce>/` and appends the path to the stop reason. A park failure never
  replaces the stop reason.
- **Less plan-ref text through a model.** `infra:load-ref` asked a model to copy the whole sealed
  plan JSON, and it wrote `[truncated: ...]`. The workflow script has no file access, so a model
  must carry any bytes the script needs; the relay is now kept small and checked:
  - commit-plan reads the refs in `meta` mode (names, targets, hashes; no message text). The
    script hashes the bytes it sealed itself (`sha256(JSON + "\n")`) and compares.
  - confirm auto builds from the sealed ref it holds in memory; load-ref reads `meta` only.
  - a standalone build reads the message as `chunks` of at most 1000 characters, joins them and
    checks the sha256 against `ref_sha256`. A mismatch is read once more
    (`infra:load-ref:retry`), then stops as before. This is a mitigation: a model still copies the
    chunks.
- **Hasher maps are checked after the relay.** The hasher program prints a `digest` (sha256 of
  the canonical fingerprint, maps and changed list); the script recomputes it over the relayed
  values and fails the step on a dropped or changed key.
- **yaadgaar tasks.** On a `yadgarhq/*` project, intake turned "yaadgaar #622" into the frozen
  legacy task L622. The script now tells intake which ledger the project uses (`ledger:
"yaadgaar"` for `yadgarhq/*`, else `"yadgar"`). There a `#N` is read with
  `mcp__yaadgaar__read_task` after a check that yaadgaar resolves to the same project; the source
  kind is `yaadgaar`, the task id `y<N>` (so `#622` and `L622` never share a branch or a plan
  ref), and the sealed brief names the ledger. A legacy ledger source on a `yadgarhq/*` project,
  or a yaadgaar source elsewhere, stops in plan mode and in build mode (a 2.1.4 ref: "re-run
  plan"). The confirm-auto re-read asks for `yaadgaar #N`. Write-back to yaadgaar is not wired
  yet (ccpm task 1928): the section is handed back as `section_text` and never written to the
  yadgar ledger.

## [2.1.4] - 2026-11-05

### Changed

- **The sealed plan ref is a local git object, not a committed file.** Plan mode no longer writes
  or commits `.fleet/<task id>/plan_ref.json`: that file leaked into a real PR with the pushed
  branch, and a global `.fleet/` gitignore would have dropped it silently. The plan commit now
  holds `plan_path` only (checked in code). The sealed JSON is the message of an annotated tag
  object (`git mktag`, no tag name, no index change, `core.hooksPath=/dev/null`) that targets the
  plan commit, at `refs/fleet/<task id>/plan`. The ref is local and never pushed. A re-plan keeps
  the earlier value as `refs/fleet/<task id>/plan-<n>`.
- **The tiny `plan_ref` is `{branch, plan_commit, plan_ref, ref_sha256, repo}`.** `ref_sha256` is
  the sha256 of the tag message bytes. Build mode loads the ref with `git cat-file` and checks the
  tag target, the message sha256, the seal and the branch, repo and task id. A missing ref or any
  mismatch stops with `needs_human` "plan ref missing or changed; re-run plan". A `plan_ref` with
  `ref_path` (2.0.1 to 2.1.3) stops with "plan_ref predates 2.1.4; re-run plan".
- **Identical re-plan reuses the plan commit.** When HEAD is a plan-only commit of the task and
  the staged plan doc is byte-identical to HEAD's, commit-plan makes no commit (never
  `--allow-empty`) and points the new plan ref at HEAD. The old ref moves to `plan-<n>` only when
  its target or message differs.
- The run-state write's `update-ref` runs with `core.hooksPath=/dev/null` too, so no
  `reference-transaction` hook runs.
- **Plan-commit classifier.** A plan commit is `plan(<task id>):` with a file set of exactly
  `{plan_path}`, where `plan_path` comes from a plan ref of the task whose target is that commit.
- The plan ref is frozen through the hasher's `refs/fleet/*` snapshot, not as a hashed file; the
  coder and writers no longer see a `.fleet/` path. A re-plan's own plan-ref write updates the
  frozen snapshot.

### Added

- **No `.fleet/` path reaches a PR.** Before every push and every pr-opener call, a read-only
  `infra:fleet-scan:*` step lists `git diff --name-only origin/<default>...<approved_sha>` and the
  files of every commit on the branch. A path with a `.fleet/` segment, or an incomplete scan,
  stops with `needs_human`, `stop_gate: "scope"`, "fleet internal files in PR diff: <paths>".
- The scope fence refuses `.fleet/` paths, so a writer or coder that creates one stops the round.

## [2.1.3] - 2026-11-05

### Fixed

- **`tofu` matches without word boundaries.** In 2.1.2, `\btofu\b` missed `tofu_fmt` and
  `opentofu`. `IAC_RE` now matches `tofu` anywhere.
- **The `.tofu` extensions are IaC files:** `.tofu`, `.tofuvars`, `.tofu.json` and
  `.tofuvars.json` are now in the scan and in the G3 / real-change scope fence.
- **The scan follows referenced files.** A tracked file is scanned when a scanned source names it:
  a local hook entry or args, a husky or lefthook command, a hooks-dir shim's `--config=<path>`, or
  a task-runner script. The scan follows these names up to 4 levels deep and stops with an error
  past 2000 referenced files.

## [2.1.2] - 2026-11-05

### Changed

- **IaC repos are refused.** The 2.1.1 hook classifier is removed: stage parsing, the per-id
  commit-stage exemption, shim detection and file-filter matching. A security review found
  fail-open gaps in all four. In its place is one blunt, fail-closed scan,
  `infra:iac-scan:plan` (plan mode, right after the workspace step) and `infra:iac-scan:verify`
  (build mode, after verify, on every build and resume). Any IaC file, any IaC pattern match in the
  repo's hook and task-runner files or in any file of the hooks dir, or an incomplete scan stops the
  run with `stop_gate: "iac"`: "repo contains IaC files or IaC tooling in hooks; the fleet does not
  run here". The confirm auto G3 IaC read is gone too, because plan mode refuses such repos first.
- Every `git worktree add` the fleet runs uses `-c core.hooksPath=/dev/null`, so no
  `post-checkout` hook runs.

## [2.1.1] - 2026-11-05

### Fixed

- **Role pins match the live fleet-v3 pages.** `EXPECTED_VERSIONS`: scope-and-plan 24, plan-audit
  13, fleet-test-writer 9, fleet-test-judge 9, fleet-coder 16, fleet-code-judge 13, fleet-pr-opener
  10, fleet-intent-judge 2, pr-review 17, gate-change-nonweakening-sweep 4. The placeholder pins
  are gone. Preflight states that a page's last line counts with no trailing newline
  (`agent_prompt_save` strips it); a test covers a page that ends on its CONTRACT line.

### Added

- **IaC hook guard.** A new read-only infra step, `infra:iac-hooks`, reads `.pre-commit-config.yaml`
  at the plan commit once per build, after verify (a resumed build too). The script finds IaC hooks
  in code and computes their effective stages (`stages`, else `default_stages`, else pre-commit and
  pre-push). An IaC hook at pre-push stops the build before the push with `stop_gate: "iac"`,
  after the commit and its `committed` run-state. An IaC hook at a commit-time stage, other than
  a fmt/validate/tflint/docs hook at pre-commit, stops it before the commit step. The commit step
  re-checks the rule against the frozen config's hash. An unreadable config fails closed.
- The IaC check also reads the installed hook files git runs (hooks dir or `core.hooksPath`,
  `*.legacy` chains) and scans `repo: local` entry scripts and `files`/`types` filters.
- The plan commit runs the repo's commit hooks too: `infra:iac-hooks:commit-plan` reads the config
  at `HEAD` first, and the commit-stage rule stops plan mode and re-plan before the plan commit.
- `confirm: "auto"` G3 refuses any repo with an IaC hook ("repo hooks run IaC tooling").
- `tflint` and `terragrunt` join the forbidden command words and the G3 command fence.
- README: "IaC hooks" under Threat model, with what the check does not cover.
- **Venv entry points are frozen.** Inside `.venv`, `venv`, `.tox`, `.nox` (and `node_modules`)
  the hasher's ignored-files scan now also hashes every `*.dist-info/entry_points.txt`,
  `*.egg-info/entry_points.txt` and `*.egg-link`. A coder that installs a package registering a
  `pytest11` plugin is stopped as "ignored path written".

## [2.1.0] - 2026-11-04

### Changed

- **No RED commit.** Many repos run the full suite in a pre-commit hook, so a commit of RED tests
  always fails, and hooks are never bypassed. Writers now work in the ONE fleet worktree,
  concurrently, on disjoint test files, and never commit. The per-criterion worktrees and branches,
  the prepare, integrate and sync steps are gone. The coder works uncommitted too.
- **Ownership check** after each writer round: HEAD unchanged ("writer committed"); each writer's
  `files` holds only its own criterion's test files; every changed path (tree delta from the round
  start plus changed hasher-map keys) is a test file of a criterion pending this round and was
  reported by a writer. The post-coder check stops a run whose HEAD moved ("coder committed").
- **Tree fingerprint.** The hasher returns `{head, tree}`: the tree is built in a temporary index
  (`GIT_INDEX_FILE=<tmp> git read-tree HEAD && git add -A && git write-tree`), so the real index is
  untouched and no hook runs. Judge before/after states compare HEAD, tree and every hasher map
  (ignored runner config included). The status and diff hashes are gone. `freeze_tree` and
  `code_tree` replace the commit-based refs; test judge and code judge get both plus `plan_commit`.
  `refreeze_log` records `freeze_tree_before`/`freeze_tree_after`.
- **Commit step** (`infra:commit:r<n>`) after the code judge approves and the obligations gate
  passes: `git add -A`, staged tree must equal `code_tree`, then ONE commit WITH hooks. A hook
  rejection goes to the coder as `fix_code` (a code round); hook-modified files, a staged-tree
  mismatch or a committed-tree mismatch stop with `needs_human`. `approved_sha` is the new HEAD.
  Later fixes are new commits `fix(<task id>): code round <n>`; verify accepts only these and the
  first `feat(<task id>): <slug words>` subject.
- **Contract fleet-v3.** Writer: `criterion_id, tests, files`. Coder: `changed_paths, suite_result,
added_symbols, frozen_tests_red_at_start, obligations_done`. The `commit`/`commits` keys are
  gone. Preflight checks ten roles: `fleet-intent-judge`, `pr-review` and
  `gate-change-nonweakening-sweep` are new.
- **Models.** A role page with no usable DISPATCH line now stops the run in preflight; no tier is
  hardcoded (2.0.x fell back to sonnet). Every role dispatch logs `model used: <label> -> <tier>`.
  The DISPATCH parser accepts text after the fallback tier (`(fallback=sonnet for small PRs)`).
- A re-plan after `plan_wrong` keeps the old head on `superseded_ref` and the uncommitted work
  under `superseded_tree_ref` (`git update-ref` to the tree; no commit is created), then resets the
  branch and runs `git clean -fd`.
- Minimum role versions for the three new roles are PLACEHOLDERS (intent judge 1, pr-review 16,
  sweep 2) until the fleet-v3 pages are published.

### Security

- The scope fence runs on the REAL changed paths in every mode: the post-coder listing
  (`git diff --name-only <code_base_ref> <tree>`, untracked files included) and each writer round. A path in
  `.github/`, IaC, Kubernetes or Helm manifests, rulesets or a secret-like path stops the run with
  `stop_gate: scope` before the commit step.
- The hook surface is frozen: `.pre-commit-config.yaml`, `git:core.hooksPath`, every file under
  the hooks dir, and the whole dir tree of every repo file a `repo: local` hook names in its
  shell-split `entry` or `args` (`-m <mod>` resolved). A `-c` payload or an unresolvable token
  stops the run at freeze. A coder change to any of them is a hash violation, so the commit step
  runs the hooks G2 checked.
- Git config exec vectors are frozen: local (and worktree) config with values, include targets,
  `.gitattributes` and `info/attributes`. The hasher and the commit step run git with
  `GIT_CONFIG_NOSYSTEM=1` and `-c core.fsmonitor=false`; the commit step pins `core.hooksPath`.
- Ignored files outside the tool caches are hashed (map `ignored`; inside venvs only startup
  hooks). A writer or coder that writes one is stopped ("ignored path written").
- The fence, the review paths and the sweep trigger diff from `plan_commit`; verify fences the
  commits already on the branch before any role runs.
- The per-run agent cap is 100 (was 60): an auto run with a review fix round can pass 60.
- Local hooks behind a launcher (`uv run`, `poetry run`, `npx`, `pnpm exec`, ...) resolve from the
  word after the launcher's subcommand. Ignored build and coverage output (`build/`, `dist/`,
  `htmlcov/`, `.eggs/`, `coverage.xml`, `.coverage.*`, `junit*.xml`) is not frozen; `*.egg-info`
  still is.
- Launcher hooks freeze the script tables (`package.json` `scripts`, pyproject `project.scripts`,
  `tool.poetry.scripts`, `tool.pdm.scripts`, `tool.hatch.envs.*.scripts`). `npm run <name>` needs
  the script; `npx`/`uvx` need a repo-local or declared tool. Build-output exclusions apply at the
  top level (dirs) and the repo root (files) only; `*.egg-info` is checked first.
- **Run-state resume.** After the commit, push, PR, review and write-back milestones the build
  records `refs/fleet/<task id>/state`, a `git mktag` tag object on the approved commit with the
  state as JSON (local, no hooks, index untouched). A build re-run with the same `plan_ref`
  resumes at the step after the last milestone when the plan ref, HEAD, tree, clean worktree and
  frozen-maps digest all match; it runs no writer, coder or judge. A mismatch stops with
  "run-state mismatch: <which>"; build commits without a run-state stop with "approved but
  unresumable". Fixes a re-run after a failed push that re-ran the writers on the approved commit.
- Every `refs/fleet/*` ref is snapshotted into the frozen git map; a role that creates, moves or
  deletes one is a violation ("run-state ref touched by role"), so a forged run-state cannot make
  a later re-run skip the judge. Only the workflow's own state write moves it.
- Write-back follows the review again (the milestone order). Transport git config (`remote.*`,
  `url.*`, `credential.*`, `http.*`, `core.sshCommand`) is no longer frozen, so a fixed remote
  does not block a resume.
- README: a "Threat model" section. The freeze guards against reward hacking, not against a hostile
  agent with a shell.

### Added

- **`confirm: "auto"`** (opt-in; the default `"ask"` is unchanged). After plan-audit approves, G1
  intent judge (`fleet-intent-judge`: verdict, deviations with `allowed_by` and `fails_closed`,
  coverage), G2 commands (`test_cmd`, or `pre-commit run <id> [--all-files] [--hook-stage <s>]`
  whose id appears once in `.pre-commit-config.yaml` at `plan_commit`), G3 scope fence (IaC,
  Kubernetes and Helm files, `.github/`, rulesets, secret-like paths, kubectl/helm/IaC commands,
  default branch, foreign repo). A failure returns `needs_human` with `failed_check`, `intent`,
  `plan_ref`, `plan_path` and `needs_max_section`; a pass builds in the same run
  (`auto_confirmed: true`). Build mode with `confirm: "auto"` re-reads the task and re-runs the
  gates against the current rulings. The sealed plan ref now holds `plan_diff`.
- **Independent review** after the draft PR: `pr-review` (self-authored mode, fleet inputs, no plan
  reasoning) and, for gate changes, `gate-change-nonweakening-sweep`, both fingerprinted on the
  fleet worktree, probes in `scratch_dir`, cleanup always run. A blocking finding (or a weakening
  sweep) goes to the coder; a new commit, push and PR-body update follow, then one more review at
  most. Nits reach the pr-opener as `review_notes`. The result carries
  `review: {verdict, blocking, nits, rounds, sweep, model}`.

## [2.0.5] - 2026-11-04

### Fixed

- `test_cmd` tokenizing matched the shell only on plain spaces: a regex `\s`/`\S` split
  disagreed with the shell on tab, `\v`, `\f`, `\r` and unicode spaces. The whole raw command
  must now hold only `[A-Za-z0-9_./:=<>"() -]` with plain spaces, and it is split on plain spaces
  only. A quoted `-k`/`-m` expression holds only words of `[A-Za-z0-9_()]`.
- `test_cmd` path arguments must match `^[A-Za-z0-9_][A-Za-z0-9_./-]*$` with no `..` segment, so
  `@file` (a pytest args file) and dot-prefixed paths are refused; go test keeps `./...` and
  `./<path>/...`.
- check_cmd scripts are re-checked (`infra:check-scripts:r<n>`, tracked regular file, realpath
  under its root) in the main worktree before every code-judge run, not only at plan time. An
  obligation that fails reaches the judge as judge-only (`check_cmd_rejected`) for that round.

## [2.0.4] - 2026-11-04

### Changed

- `test_cmd` arguments after the runner are deny-by-default: only `<paths>`, relative paths (no
  leading `/`, no `..`, no `:` or `=`) and a per-runner flag list (pytest, go test, cargo test,
  npm/pnpm/yarn test, jest/vitest; `make test` takes no arguments). A pytest `-k`/`-m` expression
  is one word or double-quoted plain words. Anything else stops the plan with
  "test_cmd arg <x> not allowed" (`-p <plugin>`, `-c`, `--rootdir`, `--basetemp`, `--config`,
  `-exec`, `-toolexec`, `--manifest-path`, `make -f`, `make -C`, `make VAR=x`, ...).
- `check_cmd` script paths: segments are lower-cased before the bad-segment check; the extension
  must be `.py`, `.sh`, `.bash` or none. A plan-time read-only infra step `infra:check-scripts`
  checks that each script is a tracked regular file, not a symlink, whose realpath stays under its
  root. Any failure makes the obligation judge-only and is logged.
- Minimum role version: scope-and-plan 19 (the argument and script-path rules).

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
- Push hook rejection: the push step classifies `push_result` as `ok`, `hook_rejected`, `network`,
  `non_ff` or `remote_rejected`, on git's own `error:`/`fatal:`/` ! [` lines only (never on the
  hook's output or the URL). A push a repo pre-push hook rejects goes back to the coder as
  `fix_code` with the hook output tail; it counts as a code round, and the code judge must approve
  again before the next push. `non_ff` and `remote_rejected` stop with `needs_human`; `network` is
  retried and then fails.
- Command safety: `test_cmd` and `check_cmd` come from a planner that reads untrusted ticket text,
  so they pass an allowlist in script code (plain tokens only, no quote, glob, `; & | $ ( ) < >`,
  backquote or newline). `test_cmd` must start with a test runner (`pytest`,
  `python[3] -m pytest`, `uv run [...] pytest`, `npm test`, `npm run test[:x]`, `npx jest|vitest`,
  `pnpm test`, `yarn test`, `cargo test`, `go test`, `make test`) followed by flags and paths only
  (no URL, no `install`/`add`/`pip`, no `-m` but `-m pytest`). A `check_cmd` must be
  `pre-commit run <hook> [...]`, `make <target>`, `[uv run [--extra x]] python[3] <dir>/<x.py>
[args]` or `<dir>/<script> [args]` with `<dir>` one of `scripts`, `bin`, `tools`, `hack`, `ci`,
  no venv/dependency/VCS segment and no interpreter or package-manager file name. The
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
- Minimum role versions: scope-and-plan 18, plan-audit 11, fleet-test-writer 7, fleet-test-judge 7,
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
