# Changelog

## [2.1.5] - 2026-11-06

Fixes from the 2.1.4 live trial (yaadgaar #622, confirm auto).

### Fixed

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
  everything after preflight; build mode keeps its own run-state resume.
- **The judge fingerprint tolerates `.claude/settings.local.json`.** Claude Code may write this
  ignored file during a judge run. The judge fingerprint (only) skips exactly that root key and
  logs it; any other ignored path, and the writer, freeze and coder checks, are unchanged.

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
