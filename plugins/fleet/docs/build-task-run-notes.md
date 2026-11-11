# build-task-run.js: design notes and history

Fleet 5.0.10 (ledger 2031) moved these comments out of `workflows/build-task-run.js` to keep the
workflow under its size budget (ADR-1189: at most 480000 bytes; Claude Code skips a workflow over
524288 bytes). The code did not change: the workflow with and without these comments minifies to
the same bytes.

Each entry is one comment block of the 5.0.9 workflow, verbatim, in file order. The heading names
the declaration the block sat before (top level) or in (inside a function), and its line in 5.0.9
(`git show fleet/v5.0.9:plugins/fleet/workflows/build-task-run.js`). Where the rule is not
obvious from the code, the workflow keeps a one-line comment that states it. Section dividers and
the `*_BEGIN` / `*_END` markers stay in the workflow.

### `before ROLES` (5.0.9 line 26)

```text
5.0.0 (R1, ledger 1999): the role prompts ship as plugins/fleet/roles/<role>.md
```

### `before TIERS` (5.0.9 line 39)

```text
Model tiers come from each role file's first "DISPATCH: model=<tier>
(fallback=<tier> ...)" line, which gen.mjs copies into ROLE_DISPATCH next to
the file's ROLE_SHA256 pin. No hand-written role->model map and no default
tier: a role with no usable DISPATCH line stops the run in preflight.
```

### `before INFRA_TIER` (5.0.9 line 44)

```text
4.0.0 (1990): the model of each infra agent, by label prefix; the first
matching prefix wins. haiku: read-only steps whose output a program digest
checks. sonnet: long bodies or chunks (intake, hasher maps, plan-ref load
and commit, the park), the steps that write, push, classify a push or run
hooks, the workspace setup (its default_branch and base_ref are not
digest-checked and feed the IaC gate's diff base), the pre-commit hook ids
(they feed the auto gate G2), and every label the plan did not name. A
label with no entry stops the run (no default tier).
```

### `in INFRA_TIER` (5.0.9 line 54)

```text
5.0.0 (R1): probe mode's role-read check (one sha256sum and one Read)
```

### `in INFRA_TIER` (5.0.9 line 69)

```text
the plan's tier for S5's throwaway test DB steps (ledger 1981)
```

### `in INFRA_TIER` (5.0.9 line 92)

```text
4.0.0 (1987): the freeze ref write
```

### `in INFRA_TIER` (5.0.9 line 94)

```text
5.0.7 (ledger 2020): the changed keys of the on-disk hasher maps (it
routes, so the hasher's tier)
```

### `in INFRA_TIER` (5.0.9 line 97)

```text
5.0.6 (ledger 2019): the per-role build dirs (reset; clean at teardown)
```

### `in INFRA_TIER` (5.0.9 line 99)

```text
5.0.8 (ledger 2030): the GitHub command of a repo
```

### `before RELAY_RETRY_MODEL` (5.0.9 line 103)

```text
A haiku PATH check whose relay is broken runs once more on this tier.
```

### `before HASH_MAPS` (5.0.9 line 106)

```text
"ignored": ignored files outside tool caches (inside venvs only startup hooks,
egg-links and dist-info/egg-info entry_points.txt). 5.0.7 (ledger 2020): the
hasher writes every map to disk and relays {count, sha256, file}; the script
keeps MAP_ALL ("<sha256>/<count>") per map, plus the inline keys: the
ignored SETTINGS_LOCAL, the git core.hooksPath and fleetref:* entries.
```

### `before FLEET_VERSION` (5.0.9 line 112)

```text
The plugin version this script ships with (bumped every release; since
4.0.0, 1993, the shipped programs are read from its plugin cache directory
only; since 5.0.0, R1, the role files too).
```

### `before RELOAD_HINT` (5.0.9 line 117)

```text
A session keeps the plugin version it started with; a mismatch after an
update usually means this script is the stale one.
```

### `before REQUIRED_ON_OK` (5.0.9 line 121)

```text
Keys each role must return when status is "ok" (checked with `key in obj`;
null or empty values are allowed). A missing key is contract drift. A
required key whose role schema types it as array, object or boolean must
also have that JS type (null only where the schema allows it); a wrong type
is contract drift too ("contract drift: <role> <key> type").
```

### `before CHANGE_KINDS` (5.0.9 line 138)

```text
4.0.0 (1991): the planner's kind of change; confirm "default" builds without
Max only for bug_fix with new_behaviour false (both checked by the intent judge)
```

### `before OBLIGATION_KINDS` (5.0.9 line 151)

```text
Repo obligations (2.0.3): push and CI rules the plan names for the coder.
```

### `before CMD_TOKEN_RE` (5.0.9 line 153)

```text
Commands from the plan (test_cmd, check_cmd) come from a model that reads
untrusted ticket text. The workflow script never runs either one. They are
allowlisted here, shown to Max verbatim in the confirmation and sealed in
the plan ref; roles run test_cmd, and the code judge may run a check_cmd.
A command token is plain: no shell metacharacter, no quote, no glob, no
whitespace other than the single separating space or tab.
```

### `before FORBIDDEN_WORD_RE` (5.0.9 line 161)

```text
Checked anywhere in a command, case-insensitively.
```

### `before TEST_ENV_ALLOWED` (5.0.9 line 163)

```text
test_cmd.env: only these names, never anything the planner invents.
```

### `before SCRIPT_ROOTS` (5.0.9 line 167)

```text
A check_cmd script lives under one of these top-level dirs, never inside a
venv, dependency or VCS dir, and is never an interpreter or package manager.
```

### `before WORD_RE` (5.0.9 line 173)

```text
test_cmd arguments after the runner: deny by default. A plain word (for
-k/-m expressions, -run patterns and cargo test names).
```

### `before TEST_CMD_CHARS_RE` (5.0.9 line 176)

```text
Every character a test_cmd may hold, checked on the whole raw command before
any tokenizing: the shell splits on characters a regex \s does not match
(tab, \v, \f, \r, NBSP, ...), so nothing else is let through. Parens are
valid only inside a quoted -k/-m expression; the token checks enforce that.
```

### `before TEST_CMD_BAD_WORDS` (5.0.9 line 183)

```text
test_cmd tokens after the runner prefix: never one of these subcommands.
```

### `before SYMBOL_RE` (5.0.9 line 185)

```text
Caller coverage (2.1.6, ledger 1955): a changed symbol is a bare
identifier; it reaches a command line, so nothing else is let through.
```

### `before MAX_SYMBOL_HITS` (5.0.9 line 190)

```text
More grep hits than this for one symbol: the plan cannot model them all.
```

### `before PLAN_PATH_CHARS_RE` (5.0.9 line 201)

```text
The plan doc's path, character by character (2.1.6): it reaches git and shell commands.
```

### `before STOP_GATES` (5.0.9 line 203)

```text
stop_gate values: which gate ended a stopped run (null when none applies).
```

### `before RESUME_NEXT` (5.0.9 line 205)

```text
Run-state milestones, in order, and the step a resumed build runs next.
```

### `before CONFIRMS` (5.0.9 line 207)

```text
4.0.0 (1991, ADR-1186): "default" runs the auto gates only for an eligible
plan (declared bug_fix, no new behaviour, no IaC path, no relaxed re-plan,
a task id with project), else it asks as "ask" does
```

### `before MAX_REVIEWS` (5.0.9 line 211)

```text
Review (2.1.0): at most one review round after the first.
```

### `before GATE_PATH_RE` (5.0.9 line 215)

```text
A changed path that names a gate, hook, validator, policy, auth rule, check
or CI file triggers the non-weakening sweep (as does pr-review touches_gate).
```

### `before PRECOMMIT_CMD_RE` (5.0.9 line 218)

```text
confirm "auto" G2: the only check_cmd shape the auto gate accepts.
```

### `before FENCE_COMMAND_RE` (5.0.9 line 220)

```text
confirm "auto" G3 scope fence over every planned path and command.
```

### `before WRITER_AGENT` (5.0.9 line 223)

```text
The ledger body write (3.1.0): MCP only; no shell, no file tools, no yaadgaar writes.
```

### `before LEDGER_PROJECT_RE` (5.0.9 line 225)

```text
A yadgar project id the body slug is built from, and the ledger's title limit (D12).
```

### `before SHORT_PATH_MAX_DIFF` (5.0.9 line 231)

```text
4.0.0 (1991): a sealed est_diff_lines below this, with new_behaviour false,
takes the short path (one test writer for every criterion; every gate kept)
```

### `before MODES` (5.0.9 line 235)

```text
5.0.0: probe runs the preflight only (scripts and role files hashed, PATH
check) and one role-read check (PROBE_READ_ROLE)
```

### `before NONCE_RE` (5.0.9 line 240)

```text
args.run_nonce: a fresh value per invocation (the skill uses `date +%s%N`).
```

### `before PLAN_REF_NAME_RE` (5.0.9 line 245)

```text
The sealed plan ref is an annotated tag object at refs/fleet/<task id>/plan
(local only, never pushed); earlier ones are kept as plan-<n>.
```

### `before SOURCE_KINDS` (5.0.9 line 248)

```text
"ledger" is the yadgar task ledger (L<N>); "yaadgaar" is the yaadgaar
gateway ledger that projects whose id starts with yadgarhq/ use (ADR-0994).
```

### `before ID_KINDS` (5.0.9 line 252)

```text
Sources whose ref names the task, in priority order, for the task id.
```

### `before FORBIDDEN_COMMENT_RE` (5.0.9 line 256)

```text
A comment line that starts with one of these words triggers a terraform
bot on the PR or issue. The script never posts such a comment.
```

### `before HELD_OUT_NOT_RUN` (5.0.9 line 262)

```text
The fleet runs no held-out examples and no mutation/coverage/scanner gates
yet. Judges get these explicit not_run markers, never an empty list: a judge
must not read a missing gate as a passing one (fail-closed).
```

### `before HELD_OUT_KEY` (5.0.9 line 267)

```text
The planner may emit these. They must never reach another role.
```

### `before RUNNER_CONFIG_FILES` (5.0.9 line 270)

```text
Test-runner config the hasher freezes, in addition to every criterion test
file. Whole files, matched on basename anywhere in the tree (tracked, or
untracked and not ignored):
Found by walking the filesystem (not git ls-files), so a config file that an
ignore rule hides is still hashed. The walk skips .git, .claude/worktrees and
the dependency dirs in WALK_SKIP_DIRS, plus each tool cache dir in
CACHE_SKIP_DIRS that git ignores (by an outside rule or its own '*'
.gitignore). A skipped cache dir is still scanned: a runner-config file (or a
pyproject.toml/package.json) inside one goes on the suspicious list.
```

### `before SUSPICIOUS_PREFIXES` (5.0.9 line 301)

```text
The hasher's descriptive suspicious-list entries (other entries are odd path
names): runner config in a skipped cache dir, and bytecode (*.pyc/*.pyo)
named after a frozen test module or conftest, found anywhere the walk or a
cache scan reaches.
```

### `before SYMLINK_RULE` (5.0.9 line 307)

```text
Ignore rules are frozen too: hiding a new config file behind an ignore rule
changes one of these keys. A .gitignore is hashed in the files map when
git can read its rules: every one `git ls-files -z --cached --others
--exclude-standard -- ':(glob)**/.gitignore' .gitignore` lists (tracked, or
untracked and not ignored), plus every walked one whose directory no
outside rule ignores (so a .gitignore that ignores itself still counts). A
.gitignore inside an ignored dir is not hashed: git never reads it, and
tools rewrite them (.ruff_cache/.gitignore on every commit). Also hashed: the worktree's info/exclude (git rev-parse --git-path
info/exclude, the common dir for a linked worktree) and the global
core.excludesFile in the git map.
The hasher returns four separate maps (files, sections, git, symlinks), so
a real file name can never mask a synthetic key, plus a suspicious list of
walked paths with ':' or '#' in a component and runner config found inside a
skipped cache dir; a non-empty list is a violation.
Every symlink the walk meets (file or directory, outside the skipped dirs) is
frozen in the symlinks map as <path> = its readlink target. Links are never followed,
so adding or retargeting one is a change.
```

### `before RUNNER_CONFIG_SECTIONS` (5.0.9 line 332)

```text
Sections of files that are NOT hashed whole (dependencies stay editable).
Each section is canonicalised (sorted keys, compact JSON) and hashed under a
synthetic key "<path>#<section>". A section that does not exist hashes as
"ABSENT", so adding one later is a change.
```

### `before STR` (5.0.9 line 352)

```text
The hasher runs this program verbatim. It is deterministic, so two hasher
runs over the same tree return the same map. The comparison happens in this
script, never in an agent.
program: scripts/hasher.py (PROGRAM_SHA256 holds its sha256)
```

### `before STR` (5.0.9 line 358)

```text
The check_cmd script check. Args: worktree, paths JSON. A path is ok when
git tracks it, it is a regular file and not a symlink, and its realpath
stays under the same top-level script root inside the worktree. It reads
metadata only and never runs the script. Prints {<path>: {ok, reason}}.
program: scripts/script_check.py (PROGRAM_SHA256 holds its sha256)
```

### `before ANY_ITEM` (5.0.9 line 369)

```text
Array items whose shape the role files own: a path, a symbol name or a
finding object. Typed loosely; the array itself is what the gates rely on.
```

### `before AUDIT_FINDINGS` (5.0.9 line 380)

```text
plan-audit findings may name the changed symbol they are about (3.0.0): the
:audit-fix round must keep every named symbol in its caller map.
```

### `before ROLE_FILE_PROP` (5.0.9 line 408)

```text
5.0.0 (R1): the role file a role agent read: its name and the sha256sum
line's hex; the script checks both (roleFileProblem)
```

### `before withShared` (5.0.9 line 411)

```text
5.0.0 (R3): the role schema plus the shared file the role reads after its
role file (SHARED_FOR), {name, sha256}; sharedFileProblem checks it
```

### `before ROLE_READ_SCHEMA` (5.0.9 line 416)

```text
probe mode's role-read agent
```

### `in roleSchema` (5.0.9 line 426)

```text
5.0.0 (R1): role_file is required on every status; null fits the schema
(a failed agent may not have read the file) and fails roleFileProblem
```

### `in roleSchema` (5.0.9 line 435)

```text
5.0.0 (R2, R3): optional notes for a memory tool, if the caller has one;
never required, null accepted (PR #48: a null never stops a build)
```

### `in SCHEMAS` (5.0.9 line 451)

```text
4.0.0 (1980): test_args, cargo and go only; validated by the script
```

### `in SCHEMAS` (5.0.9 line 488)

```text
stripped on receipt (HELD_OUT_KEY); typed so the schema can require it
```

### `in SCHEMAS` (5.0.9 line 492)

```text
every occurrence of each existing function, guard or symbol the plan
changes: "<path>:<line>", mapped to a criterion id or a dont_care reason
```

### `in SCHEMAS` (5.0.9 line 523)

```text
4.0.3: the short path splits tests by covers (a string); the item stays a string or an object
```

### `in SCHEMAS` (5.0.9 line 540)

```text
5.0.0 (R3): optional work the coder saw and left; passed through to
the run result, never written to a ledger
```

### `in SCHEMAS` (5.0.9 line 587)

```text
4.0.0 (1991): the judge's check of the planner's change_kind and
new_behaviour, with a verbatim quote from the task
```

### `in SCHEMAS` (5.0.9 line 607)

```text
4.0.3: the weakening summary reads shipped_refuses/new_refuses with ===; null: no measured verdict (broken instrument)
```

### `before STRICT` (5.0.9 line 613)

```text
4.0.0 (1984): every REQUIRED_ON_OK key is in the role schema's `required`
on every status, its type (and enum) widened with null: a needs_human or
failed result sets each key it has no value for to null. STRICT keeps the
frozen property; on ok a value must match it (driftOf). Widened copies
only: the shared type constants stay as they are.
```

### `before PROGRAM_PROP` (5.0.9 line 636)

```text
4.0.0 (1993): the self-hash every shipped program prints
```

### `before PROGRAM_OUTPUT` (5.0.9 line 638)

```text
a shipped program's JSON output relayed whole under one key
```

### `before PREFLIGHT_SCHEMA` (5.0.9 line 641)

```text
5.0.0 (R1): the first agent of every run finds the scripts and roles
directories, hashes every file in them, and runs the PATH check
```

### `in PREFLIGHT_SCHEMA` (5.0.9 line 645)

```text
5.0.0 (R2): the ledger tool census. Advisory (a malformed or missing
census counts as []), so PR #48 makes it optional and nullable.
```

### `before PUSH_PROBE_SCHEMA` (5.0.9 line 657)

```text
4.0.0 (1985): the push-access probe relay
```

### `in INFRA_SCHEMA` (5.0.9 line 689)

```text
4.0.0 (1987, 1981)
```

### `in INFRA_SCHEMA` (5.0.9 line 695)

```text
5.0.2 (ledger 2004)
```

### `in INFRA_SCHEMA` (5.0.9 line 702)

```text
5.0.7 (ledger 2020): format_files.py
```

### `in INFRA_SCHEMA` (5.0.9 line 780)

```text
4.0.0 (1989): the caller grep's auto dont_care hits and doctest-collected docs
```

### `in INFRA_SCHEMA` (5.0.9 line 783)

```text
4.0.0 (1986): the branch scan's plan tip time and the parked-run reader
```

### `in INFRA_SCHEMA` (5.0.9 line 801)

```text
5.0.3 (ledger 2010): the DSN precheck of infra:format-plan
```

### `in INTAKE_SCHEMA` (5.0.9 line 827)

```text
3.1.3 (ledger 1979): every ledger tool call intake made, found or not
```

### `before FINGERPRINT` (5.0.9 line 845)

```text
head + the worktree's tree sha (see work_tree in the hasher program).
```

### `in HASHER_SCHEMA` (5.0.9 line 868)

```text
5.0.7 (ledger 2020): every map is in `file`, outside the worktree
```

### `before stripHeldOut` (5.0.9 line 899)

```text
Deep copy without any held_out_examples key, at any depth.
```

### `before gatesNotRun` (5.0.9 line 910)

```text
gates_not_run for the PR: the code-judge list when it gave one, else built
from the inputs this script marked not_run.
```

### `in gatesNotRun` (5.0.9 line 919)

```text
3.1.0: the union; the judge's list never drops a gate the script knows did not run
```

### `before parseDispatch` (5.0.9 line 924)

```text
Parse a role file's DISPATCH line. null when missing, unparseable or the
tier is unknown.
```

### `before keyName` (5.0.9 line 933)

```text
Display name of a hash key per map; used in findings and logs only.
```

### `before changedKeys` (5.0.9 line 959)

```text
Keys whose value differs, compared map by map, including keys only one side
has: [{map, key, name}]. wt (4.0.0, 1988): the hashed worktree; the
fleet's own settings file there is no change (fleetOwnFile), and any other
change of that file carries its before and after hashes for the stop text.
```

### `before SETTINGS_LOCAL` (5.0.9 line 984)

```text
4.0.0 (1988): the settings file the workspace step writes into a fleet
worktree. It is exempt from a fingerprint only at this exact path (the
ignored map), and only when its bytes after the step are exactly the
fleet's own (settingsFor of that worktree). The maps and digests keep it.
```

### `before FLEETREF` (5.0.9 line 1000)

```text
The violation text for a changed key.
```

### `before MAP_ALL` (5.0.9 line 1002)

```text
5.0.7 (ledger 2020): MAP_ALL is the key of a map's summary ("<sha256>/<count>";
for ignored, of every entry but SETTINGS_LOCAL). expandKeys replaces a
changed MAP_ALL row by the keys hash_diff.py lists. HASH_FILES: "<map>:<that
value>" -> the map's file, for every summary relayed.
```

### `in violationName` (5.0.9 line 1022)

```text
the ignored map keeps its 5.0.5 text
```

### `before diffHashes` (5.0.9 line 1030)

```text
changedKeys by violation text, plus every suspicious entry: a non-empty
suspicious list is always a violation. 5.0.7: a changed map's keys from
hash_diff.py; a comparison that fails stops (stop_gate hash).
```

### `before configView` (5.0.9 line 1040)

```text
5.0.7 (ledger 2020): the roles' frozen_config_sections: {<map>: the file
that holds the frozen map}. The workflow holds no per-key value; a role
reads the keys and hashes there (hash_diff.py checks each file's sha256).
```

### `before fileHex` (5.0.9 line 1048)

```text
a map file's name hex (the sha256 of its bytes)
```

### `before countOf` (5.0.9 line 1052)

```text
"<sha256>/<count>" of a map's summary -> count (NaN: none)
```

### `before mapsDigest` (5.0.9 line 1057)

```text
sha256 of every hasher map (canonical JSON): the run-state's frozen-maps digest.
```

### `in mapsDigest` (5.0.9 line 1061)

```text
the run-state ref moves with every state write; the digest leaves it out
```

### `before hashRecheck` (5.0.9 line 1066)

```text
For the code judge: {"<map>/<key>": {frozen, current, match}}, plus the
suspicious list when non-empty. Report only; diffHashes stays authoritative.
wt (4.0.0, 1988): a change diffHashes exempts (fleetOwnFile) is not listed.
```

### `before sameState` (5.0.9 line 1094)

```text
A worktree state is a hasher result: {fingerprint: {head, tree}, hashes}.
Two states match when HEAD, the tree (tracked plus untracked-not-ignored
files) and every hasher map (ignored runner config, ignore rules, symlinks)
match. The suspicious list is left out: a test run may leave bytecode, which
the purge removes before every freeze and post-coder check. wt: the hashed
worktree (see fleetOwnFile).
```

### `before planFactsProblem` (5.0.9 line 1112)

```text
test_cmd and repo_obligations from the planner (or a loaded ref).
Returns {msg, gate} or null. Types are checked by checkRole first; this
checks the shape the coder and the judges rely on.
```

### `before scriptPathProblem` (5.0.9 line 1137)

```text
A check_cmd script path: relative, under SCRIPT_ROOTS, no venv/dependency/
VCS segment, not an interpreter or package manager. Returns a reason or null.
```

### `before parseCheckCmd` (5.0.9 line 1158)

```text
The allowlist. A check_cmd must be exactly one of:
  pre-commit run <hook-id> [--all-files] [--hook-stage <stage>] [--from-ref <ref> --to-ref <ref>]
  make <target>
  [uv run [--extra <x>]] python[3] <relative/path.py> [plain args]
  <relative/path/to/script> [plain args]
Returns {ok: true, script?: <relative script path>} or {ok: false, reason}.
```

### `before testRunnerPrefix` (5.0.9 line 1214)

```text
The test runner a test_cmd starts with. Returns the number of prefix tokens,
or 0 when the command does not start with an allowed runner:
  pytest | python[3] -m pytest | uv run [--frozen] [--no-sync] [--extra <x>]... pytest
  npm test | npm run test[:<name>] | npx jest|vitest | pnpm test | yarn test
  cargo test | go test | make test
```

### `before testPathArg` (5.0.9 line 1240)

```text
A test path argument: <paths>, or a relative path that starts with a word
character (no `/`, `-`, `.` or `@` start: pytest reads `@file` as an args
file) and has no `..` segment.
```

### `before goPackageArg` (5.0.9 line 1248)

```text
go test package patterns: ./... or ./<path>/...
```

### `before CARGO_NAME_RE` (5.0.9 line 1255)

```text
a cargo --test target or -p/--package crate name (4.0.0, ledger 1980)
```

### `before testArgsProblem` (5.0.9 line 1260)

```text
Arguments after the runner, per runner kind. Returns the first refused
token, or null.
```

### `in testArgsProblem` (5.0.9 line 1273)

```text
4.0.0 (1980): one test target or one package, by plain name
```

### `in testArgsProblem` (5.0.9 line 1286)

```text
4.0.0 (1980): go targets a criterion with test_args, never <paths>
```

### `before splitTestCmd` (5.0.9 line 1316)

```text
Split a test_cmd into tokens on plain spaces (0x20) only. A double-quoted
token is allowed only as the expression right after -k or -m: words of
[A-Za-z0-9_()] separated by single spaces (so `"foo and not (bar or baz)"`),
standing alone between spaces. Returns {tokens} or {problem}.
```

### `in splitTestCmd` (5.0.9 line 1343)

```text
the expression is checked; the arg check sees one plain word for it
```

### `before testCmdProblem` (5.0.9 line 1350)

```text
test_cmd: an allowed test runner, then flags and paths only (plain tokens,
the <paths> placeholder; no URL, no install/add/pip, no -m other than
pytest), allowlisted env names with plain values; no forbidden word.
```

### `before criterionTestArgsProblem` (5.0.9 line 1384)

```text
4.0.0 (1980): why a criterion's test_args is unusable (null: ok or absent).
Only for a cargo or go test_cmd without <paths>; test_cmd.command + " " +
test_args must pass the whole test_cmd allowlist as one command.
```

### `before criterionCommand` (5.0.9 line 1402)

```text
The command a criterion's targeted runs use (test_args appended), or null.
```

### `before commandsOf` (5.0.9 line 1407)

```text
What Max confirms: every command, verbatim, with its source and who runs
it, and the test_cmd's env and tools. 4.0.0 (1980): one more test_cmd entry
per criterion with test_args, holding the whole command it runs.
```

### `before obligationFailures` (5.0.9 line 1451)

```text
The script gate on a code-judge approve: every obligation is met:true in
obligations_check. judged: the obligations as the judge got them this
round (a check_cmd the script check demoted carries none). Since 3.1.0
(ledger 1935b) every allowlisted check_cmd there needs check_exit 0, or a
gates_not_run entry "check_cmd:<id>" (the PR body states it). The script
never runs the command. Returns routed code findings.
```

### `in obligationFailures` (5.0.9 line 1472)

```text
an unmet obligation already has its finding above
```

### `in obligationFailures` (5.0.9 line 1483)

```text
3.1.0 review F2: the change may not edit what a check_cmd runs (its
script, a Makefile for `make`, the hook config for `pre-commit run`;
a local hook's entry file is refused by the fixer step) unless the
obligation lists the file. Every round, met or not.
```

### `in obligationFailures` (5.0.9 line 1495)

```text
make: the Makefiles, and the repo paths the target's recipe names
```

### `in settingsFor` (5.0.9 line 1513)

```text
a "//" prefix makes the path absolute in Claude Code permission rules
```

### `before codePointCompare` (5.0.9 line 1519)

```text
Compares two strings by Unicode code point, as Python's sort does
(JS .sort() compares UTF-16 units: astral characters sort before U+E000-U+FFFF).
```

### `before canonical` (5.0.9 line 1531)

```text
Canonical JSON: object keys sorted by code point at every depth (Python's
json.dumps sort_keys order), undefined values dropped.
```

### `before K256` (5.0.9 line 1548)

```text
SHA-256 in plain JS (workflow scripts have no crypto module). Used for the
plan_ref seal only; file hashes are computed by infra agents.
```

### `before sealOf` (5.0.9 line 1620)

```text
The plan_ref travels through the skill (a model) between the plan and the
build run. The seal detects any change to it in transit.
```

### `before namesFor` (5.0.9 line 1632)

```text
Task id for the branch name and the comment marker: the first ledger, Jira,
GitHub or Codeberg source names it; else p<sha256(plan path)[:8]> (an
ingested plan) or t<sha256(raw input)[:8]> (free text). The slug comes from
the brief title, for free text from the raw input.
```

### `in namesFor` (5.0.9 line 1641)

```text
yaadgaar tasks get their own prefix: #622 and L622 are different tasks
```

### `in namesFor` (5.0.9 line 1650)

```text
free text: id and slug from the text itself, never from the model-written
title, so a re-run of the same text reuses its branch and two texts never
share a plan ref
(the raw input, not intake's relayed copy of it)
```

### `before proposedChanges` (5.0.9 line 1665)

```text
Proposed plan changes from the code judge's plan findings: the text after
"Proposed plan change:", else the whole finding (logged; never dropped).
```

### `before planLinkFor` (5.0.9 line 1677)

```text
The plan doc on the pushed branch: a Codeberg origin gets a Codeberg link
(3.0.0, ledger 1928); anything else, github.com.
```

### `before planRefName` (5.0.9 line 1690)

```text
The plan file's sha256 as git stores it at a commit. Plan mode and build
mode run this exact program, so the two hashes are comparable.
program: scripts/plan_hash.py (PROGRAM_SHA256 holds its sha256)
```

### `before planRefsCmd` (5.0.9 line 1698)

```text
Writes the sealed plan ref: an annotated tag object (git mktag: no tag
name, index untouched) whose target is HEAD and whose message is the
sealed JSON, at refs/fleet/<task id>/plan. A different earlier value is
kept as refs/fleet/<task id>/plan-<n> first. No hook runs (hooksPath
/dev/null also stops reference-transaction). Local only, never pushed.
The chunks are the base64 of the sealed ref's tag message, written by the
agent one file each (<chunk dir>/<i>.b64). Exit 3 with {bad_chunks} when a
chunk file does not hash to its listed sha256; then nothing is written.
Prints {head, tag_sha, program, digest}.
program: scripts/plan_ref_write.py (PROGRAM_SHA256 holds its sha256)
```

### `before planRefsCmd` (5.0.9 line 1709)

```text
Lists every plan ref of a task (refs/fleet/<task id>/plan and plan-<n>):
{refs: [{name, tag_sha, type, target, target_type, sha256, content}]}.
sha256 is over the raw tag message bytes; content is those bytes as text.
A ref that is not an annotated tag has content null.
program: scripts/plan_ref.py (PROGRAM_SHA256 holds its sha256)
```

### `before planRefMetaProblem` (5.0.9 line 1719)

```text
Why a plan-ref entry read without content (meta or chunks mode) is not the
ref of commit `target` whose message hashes `sha` (null: ok).
```

### `before refMessage` (5.0.9 line 1729)

```text
The exact tag message plan_ref_write.py stores for a sealed ref (JSON + newline).
```

### `before planRefEntryProblem` (5.0.9 line 1734)

```text
Why a plan-ref entry is unusable as the ref of commit `target` (null: ok).
```

### `before relayDigestOk` (5.0.9 line 1744)

```text
The relayed keys of a program's output match the digest it printed (3.0.0,
ledger 1952). A key the relay dropped counts as null.
4.0.0 (1993): the digest covers the program's self-hash too, and that
self-hash must name the shipped program `name`.
```

### `before PROGRAM_SHA256` (5.0.9 line 1756)

```text

Every program ships as plugins/fleet/scripts/<name>.py; those files are the
source of truth (4.0.1, ledger 1996: the workflow file no longer embeds the
program text, which put it over Claude Code's 524288-byte workflow cap).
PROGRAM_SHA256 holds the sha256 of each file's exact bytes; scripts/gen.mjs
writes it between the markers below from the files, and `gen.mjs --check`
(run by a test) fails when the table and the files differ.
Agents run `python3 -I <scripts_dir>/<name>.py <args>`; no prompt pastes a
program. Each program prints program: {name, sha256} (the sha256 of its own
file) inside its digest, and the script compares both with the table entry:
a re-typed program, a stale plugin version or a wrong directory stops the
step. scripts_dir is resolved in the first agent of every run.
```

### `before ROLE_SHA256` (5.0.9 line 1809)

```text
5.0.0 (R1, ledger 1999): the role prompts ship as plugins/fleet/roles/<role>.md.
ROLE_SHA256 holds the sha256 of each file's exact bytes; gen.mjs writes it
between the markers below from the files, and `gen.mjs --check` fails when
the table and the files differ. The same trust model as the programs:
preflight pins the roles dir (its sha256sum lines must be exactly this
table), and every role agent runs `sha256sum -- <file> && cat <file>` as its
first action and returns role_file {name, sha256}, which the script checks
against the dispatched role and this table (roleFileProblem).
```

### `before ROLE_DISPATCH` (5.0.9 line 1831)

```text
The first DISPATCH line of each role file, written by gen.mjs from the same
files (`--check` fails when one differs): the role's tier is pinned with its text.
```

### `before SHARED_SHA256` (5.0.9 line 1847)

```text
5.0.0 (R3): the shared prompt files under roles/_shared/<name>.md, pinned
like the role files (gen.mjs writes the table, preflight checks the dir).
A role in SHARED_FOR hashes and reads its shared file after its role file
and returns shared_file {name, sha256}; sharedFileProblem checks it.
```

### `before programSha` (5.0.9 line 1858)

```text
sha256 of the shipped file of program `name`
```

### `before programProblem` (5.0.9 line 1864)

```text
Why a relayed program output did not come from the shipped program `name`
(null: it did). Two observations, both agent-relayed: the sha256sum line the
same Bash call printed before the program ran (file_sha256), and the
program's own self-hash (program). Both must be the table's sha256.
```

### `before printedProgram` (5.0.9 line 1879)

```text
5.0.1 (ledger 2003): `program` as the program printed it ({name, sha256}),
for a digest. A relay that also copied the sibling file_sha256 into program
(run wf_6b4383d3-b45) is read without that key, only when it equals the
sibling, which programProblem checks against the table. Any other extra
key or value stays, so the digest refuses it.
```

### `before requireProgram` (5.0.9 line 1892)

```text
Halts unless `r` came from the shipped program `name`.
```

### `before progCmd` (5.0.9 line 1898)

```text
The one command form a prompt uses to run a shipped program: the file's
sha256sum first, then the program, in one Bash call.
```

### `before EMITTED_CMDS` (5.0.9 line 1906)

```text
4.0.2 review: every program command this run built, command text -> program
name. infraCall counts a program as run by a prompt only when the prompt
holds a command recorded here, never text that merely looks like one (task
input, a tldr or a ticket body can quote `sha256sum -- .../<name>.py`).
```

### `before PROGRAM_SLOTS` (5.0.9 line 1915)

```text
4.0.2 (ledger 1997): where each step returns each shipped program's output
(null: the top level of the result; else that key), as programProblem reads
it. One table feeds the schema the agent gets (file_sha256 and program
required at every slot) and the rule text that names the slots, so a
prompt's explicit Return list can no longer leave file_sha256 out. A slot
applies when the prompt runs its program; a prompt that runs a program its
label's entry does not name stops the run (infraCall).
```

### `in PROGRAM_SLOTS` (5.0.9 line 1926)

```text
5.0.8 (ledger 2030): a repo the workspace step did not check (intake's
GitHub URL, a comment's repo); never run inside a step that holds task text
```

### `in PROGRAM_SLOTS` (5.0.9 line 1955)

```text
5.0.7 (ledger 2020)
```

### `in PROGRAM_SLOTS` (5.0.9 line 1957)

```text
5.0.6 (ledger 2019)
```

### `before PROGRAM_KEYS` (5.0.9 line 1960)

```text
5.0.2 (ledger 2006): the keys each shipped program prints, bar program and
digest, as "<name>" or "<name>:<mode>" where the printed keys depend on the
mode. Every digest check reads its keys here (progKeys), and every prompt's
"prints {...}" and "Return {...}" lists are built from the same entry
(printsKeys, returnKeys). Run wf_00e4b130-011 (5.0.1) stopped because the
callers prompt named two of the four lists its digest covers: the agent
followed the prompt and the other two read as null. PROGRAM_OUT types them.
```

### `in PROGRAM_KEYS` (5.0.9 line 1970)

```text
5.0.9 (ledger 2032)
```

### `in PROGRAM_KEYS` (5.0.9 line 1972)

```text
5.0.8 (ledger 2030)
```

### `in PROGRAM_KEYS` (5.0.9 line 2005)

```text
5.0.7 (ledger 2020)
```

### `in PROGRAM_KEYS` (5.0.9 line 2007)

```text
5.0.6 (ledger 2019)
```

### `before NO_DIGEST_PROGRAMS` (5.0.9 line 2011)

```text
plan_hash and plan_ref print no digest (the script checks them against the plan)
```

### `before printsKeys` (5.0.9 line 2019)

```text
"{k1, k2, program, digest}": what the program prints
```

### `before returnKeys` (5.0.9 line 2023)

```text
"k1, k2, program, file_sha256, digest": the relay of it in a Return line
```

### `before STRS` (5.0.9 line 2027)

```text
4.0.3 (ledger 1998): the JSON type of every key each shipped program prints
(the hasher's are in HASHER_SCHEMA). programSchema puts them at every slot
of the program, so the per-call schema types each value the script checks by
type or by digest: a relay that turns 1 into "1" is refused by the schema at
the tool call, not by a gate. test_db_decl's decl is the repo's own file,
checked by testDbDeclProblem: typed object only, so a wrong file still gets
that stop text.
```

### `in PROGRAM_OUT` (5.0.9 line 2064)

```text
5.0.2 (ledger 2004): park mode
```

### `in PROGRAM_OUT` (5.0.9 line 2093)

```text
5.0.8 (ledger 2030)
```

### `in PROGRAM_OUT` (5.0.9 line 2141)

```text
5.0.6 (ledger 2019)
```

### `before programSlots` (5.0.9 line 2145)

```text
{used: the label's [slot, program] pairs whose program the prompt runs,
missing: programs the prompt runs that no pair of the label names}. A
prompt runs a program when it holds a command `emitted` recorded for it.
```

### `in programSlots` (5.0.9 line 2150)

```text
a step with no entry runs no program: a command its prompt holds is quoted
text (the task input, a tldr), never a slot and never a stop
```

### `before FILE_SHA_HEX` (5.0.9 line 2158)

```text
A per-call copy of `schema` that requires program and file_sha256 at every
slot. Top level: nullable (a failed step may print no sha256sum line; null
fails programProblem). A slot key: required, null allowed (the step did not
run it), and an object there must hold both, file_sha256 a string.
programProblem compares the value with the table, so no pattern here.
```

### `before mergeProp` (5.0.9 line 2170)

```text
4.0.3 review: the program's type of a key merged into the base schema's
property: the program's type wins, the base's typed keys and item
requirements stay. A base requirement is kept only for a key the program
prints at that level (fleet_scan commits carry no subject).
```

### `in programSchema` (5.0.9 line 2197)

```text
4.0.3: a failed step may give a key null; any other value has the program's type
```

### `before fileShaRule` (5.0.9 line 2214)

```text
appended to every prompt that runs a shipped program (see infraCall)
```

### `before relayAs` (5.0.9 line 2222)

```text
the relay of a program's output under a result key (4.0.2)
```

### `before scriptsProbeOf` (5.0.9 line 2227)

```text
scripts_dir (4.0.0 security review): the preflight probe's lines, parsed.
The directory must be exactly $HOME/.claude/plugins/cache/<marketplace>/
fleet/<FLEET_VERSION>/scripts, its realpath must be itself (no symlink in
any component) and it must not be a symlink; every shipped program in it
must hash to its table entry, and it holds no other program.
5.0.0 (R1): the same rules for its sibling roles dir (.../fleet/<version>/
roles): its realpath is itself, it is no symlink, and it holds exactly the
role files, each hashing to its ROLE_SHA256 entry, and no other entry (no
extra file, no subdirectory, no symlink). Each role agent then hashes the
file it reads and returns role_file; roleFileProblem checks it.
Returns {problem} or {dir, rolesDir}.
```

### `in scriptsProbeOf` (5.0.9 line 2269)

```text
the sha256sum lines of <dir>/*.py: exactly the shipped programs, each its
table entry; of <roles dir>/*: exactly the role files, each its entry
```

### `before scriptsMapProblem` (5.0.9 line 2289)

```text
Why a map {<program name>: sha256} of a scripts dir is not exactly the
shipped programs (null: it is). Names every file that differs.
```

### `before scriptsSummaryProblem` (5.0.9 line 2300)

```text
5.0.7 (ledger 2020): the hasher relays {count, sha256} of that map; null when
it is this script's own table (the preflight probe names a changed file).
```

### `before rolesMapProblem` (5.0.9 line 2309)

```text
5.0.0 (R1): why a map {<file name>: sha256} of the roles dir is not exactly
the shipped role files (null: it is). Names every file that differs.
```

### `in rolesMapProblem` (5.0.9 line 2313)

```text
5.0.0 (R3): the role files, then the shared files as _shared/<name>.md
```

### `before B64_CHARS` (5.0.9 line 2325)

```text
base64 of the UTF-8 bytes of `str` (the script has no Buffer or btoa).
```

### `before CHUNK_CHARS` (5.0.9 line 2339)

```text
A message the agent writes to files in checked base64 chunks, and the
prompt text for it: write each chunk, then run `cmd` (a chunk writer
program), rewriting only the chunks it lists as bad, at most 2 times.
```

### `before fleetInternalPaths` (5.0.9 line 2363)

```text
The PR-diff check for fleet-internal paths: the paths of
`git diff origin/<default>...<sha>` and the files of every commit in
origin/<default>..<sha>. Read only.
program: scripts/fleet_scan.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2368)

```text
The branch scan (3.0.0, ledger 1952): the commits origin/<default>..HEAD
carries, newest first, each {sha, subject, files}, and every plan ref of
the task WITHOUT its message text: the program parses each message itself
and prints task_id, plan_path and ref_ok, the same checks as the script's
planRefProblem (seal over canonical JSON, required fields, brief shape,
branch = fleet/<task_id>-<slug>). digest: sha256 over {commits, refs}.
A message whose canonical form differs between Python and JS (a float the
two print differently) reads as not ok: a plan commit then counts as a
build commit and the run stops (fail-closed). Read only.
program: scripts/branch_scan.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2379)

```text
The paths base_ref..head_sha changes (review), with a digest. Read only.
program: scripts/review_paths.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2382)

```text
Verify (3.1.0, ledger 1959): what the branch did since the plan commit, from
git itself. Args: worktree, plan commit, plan path. Prints {head,
is_ancestor, commits_since: [{sha, subject}] newest first, plan_touched
(shas of commits after the plan commit that change the plan path),
changed_since (paths plan_commit..HEAD changes), digest}. The three lists
are empty when HEAD is the plan commit or does not descend from it.
digest: sha256 over every key but itself, in canonical JSON. Read only;
git runs from /, never from the worktree.
program: scripts/verify_since.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2392)

```text
Commit-plan (3.1.0, ledger 1959): HEAD and the paths the HEAD commit
changes. Arg: worktree. Prints {head, files, args, dsn_paths, program,
digest}; dsn_paths (4.0.0 review): the files among them whose HEAD blob
holds mysql://. Read only; git runs from /.
program: scripts/plan_files.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2398)

```text
The caller grep (2.1.6): every word-boundary occurrence of each changed
symbol in the tracked text files, as "<path>:<line>", the run's own plan doc
excluded. A symbol with more than <cap> hits is listed in capped, with an
empty list. digest: sha256 over {occurrences, capped} in canonical JSON, so
the script can tell when the relay dropped or changed a hit. Read only.
program: scripts/callers.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2405)

```text
4.0.0 (1986): the parked draft and findings of a plan run that stopped
before its plan commit. `read <scratch> <plan tip time|null>` prints the
newest parked/<run>/ folder newer than the last plan commit: {parked: null
| {run, plan_path, draft_chunks, findings_chunks} (<= 1000 characters
each), args, program, digest}. `write <scratch> <run> <chunk dir> <n>
<expected> <shas>` writes parked/<run>/findings.json from checked base64
chunks (exit 3 with {bad_chunks} and nothing written on a bad one) and
prints {written, sha256, args, program, digest}. `park <worktree> <plan
path> <scratch> <run>` (5.0.2, ledger 2004) moves a stopped run's draft plan
to <scratch>/parked/<run>/<plan path> and leaves the worktree as HEAD has
it, with fixed git arguments: {target (null: no file), clean, dirty (other
dirty paths: nothing changed), args, program, digest}.
program: scripts/parked.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2419)

```text
The build-time caller check (3.0.0, ledger 1956): the EXISTING definitions
that `git diff <base> <tree>` modifies, in the files that existed at base
(status M, T or D; renames off, so a moved file is a delete and an add).
For every hunk (-U0) the program reads the base blob itself: a removed
definition line, or a re-added one (every base definition of that name),
names its definition; any other removed line, and an insertion that does
not start with a definition line, names the innermost definition above it
with a smaller indent. A def is {name, at: "<path>:<line>", end: <last line
of its body>}. git's own hunk header is not used: without a diff=
attribute it names the nearest column-0 line (a class, not its method).
excluded: the frozen tests and the plan doc. unclassified: files no
definition pattern covers (by extension, Makefile name or shebang) and
binary diffs. unattributed: "<path>:<line>" of a change in a classified
file with no definition above it (module-level code). Path names are
printed with non-printable characters escaped. digest: sha256 over
{defs, excluded, unclassified, unattributed}. Read only.
program: scripts/changed_defs.py (PROGRAM_SHA256 holds its sha256)
```

### `before fleetInternalPaths` (5.0.9 line 2437)

```text
Paths with a .fleet/ directory segment: fleet-internal, never in a PR.
```

### `before planHashCmd` (5.0.9 line 2442)

```text
It prints {plan_sha256, program} (4.0.0: JSON, so the script sees which program ran).
```

### `before SCRIPTS_GLOB` (5.0.9 line 2447)

```text
4.0.0 (1993): the search for this version's scripts directory in the plugin cache
```

### `before SCRIPTS_PROBE` (5.0.9 line 2449)

```text
5.0.0 (R1): and its sibling roles dir, with every file in it; (R3) its one
subdir _shared (a real dir, no symlink) and every file in that
```

### `before roleFilePath` (5.0.9 line 2460)

```text
The ONLY prompt text a role gets (5.0.0, R1): hash and read the pinned role
file, the inputs, and the output rule. No role text is in the prompt. The
file is read with the Read tool, never `cat`: the Bash tool cuts output near
30000 characters, and a cut file still matches its sha256sum line (review of
d8df90b). gen.mjs keeps every role file within what Read returns by default
(2000 lines, no line over 2000 characters, 40000 characters in all). Every
role runs as fleet:judge or the default agent; both can use Read.
```

### `before sharedFilePath` (5.0.9 line 2488)

```text
5.0.0 (R3): a role in SHARED_FOR also hashes and reads its shared file
```

### `before roleReadPrompt` (5.0.9 line 2521)

```text
5.0.0 (R1): probe mode's check of the role read path on the real runtime: a
cheap agent hashes and reads one role file the way a role does, follows
nothing in it, and returns role_file only.
PR #48 (ruling 3): a role in SHARED_FOR also has its shared file read
(steps 3 and 4, as the role does) and returns shared_file.
```

### `before preflightPrompt` (5.0.9 line 2543)

```text
5.0.0 (R1): a run's first agent finds the scripts and roles directories,
hashes their files and runs the PATH check.
```

### `in preflightPrompt` (5.0.9 line 2553)

```text
5.0.9 (ledger 2032): the yaadgaar client's project, from the session's start dir
```

### `before censusText` (5.0.9 line 2561)

```text
5.0.0 (R2): the ledger tool census. A ToolSearch select returns only the
names the session has; an absent MCP server (not configured, or not
connected) returns none of its names.
```

### `in hasherPrompt` (5.0.9 line 2638)

```text
5.0.2 (ledger 2006): scripts (the shipped programs' sha256s) is digested too
```

### `before parkPlanPrompt` (5.0.9 line 2717)

```text
Moves the stopped run's own draft plan out of the fleet worktree, so the
next plan run's workspace step finds a clean tree.
findings (4.0.0, 1986): {scratch, run, chunk_dir, c: chunked(findings JSON)}
for parked/<run>/findings.json, or null.
```

### `in parkPlanPrompt` (5.0.9 line 2722)

```text
5.0.2 (ledger 2004): the move is the program's; the agent runs only the
commands below (a compound Bash call defeats the allow rules: a prompt)
```

### `before loadParkedPrompt` (5.0.9 line 2741)

```text
4.0.0 (1986): read the newest parked draft and findings. Read only.
```

### `before PARKED_UNREADABLE` (5.0.9 line 2755)

```text
4.0.0 (1986): the parked draft and findings as planner inputs, or null (no
parked folder). Any relay or shape problem ignores the parked data with a
gate line and returns {unreadable: <why>}: the read cannot prove there is no
parked prior, so the caller fails closed (4.0.0 review): confirm "default"
asks Max, "auto" stops after the plan commit, "ask" goes on (Max is asked
anyway). Returns {run, priorDraft, priorRound, unreadable?}.
```

### `in loadParked` (5.0.9 line 2800)

```text
findings that do not parse (or hold no rounds list) lose round 0: the
draft is still a planner input, but the prior is unreadable (fail closed)
```

### `in loadParked` (5.0.9 line 2815)

```text
no round 0 in the parked rounds: relaxed (fail closed)
```

### `before formatFilesPrompt` (5.0.9 line 2826)

```text
The repo's fixer hooks on build-phase files (3.0.0, ledger 1951): runs
`pre-commit run --files <paths>` in the worktree until a run changes
nothing (at most 3 runs), so the judges and the hashes see the bytes the
commit-time hooks leave and the one commit step has nothing to rewrite.
sel: {"paths": [...]} (the writers' files) or {"dirty": true} (every path
the worktree changes against HEAD, frozen ones left out). The hooks run in
a scratch checkout of HEAD under scratch_dir: only the selected files are
copied in and back. The hook surface (the config, every path a hook entry
or args names, the files of every -m module) must equal HEAD, else nothing
runs; a helper such a file imports is a residual (ADR-1152). A selected
path through a symlink (HEAD mode 120000, a symlinked parent at HEAD or in
the worktree, a realpath outside either checkout) is refused. Exit codes are
ignored: a check hook that fails (a full-suite hook on RED tests) is the
commit step's business; only bytes count. changed: every path that differs
between the worktree tree before the first run and after the last (a temp
index, so the real index is untouched), whatever hook changed it. Prints
{ran, note, runs, stable, files, changed, refused, purged, purged_paths,
digest}. Before the comparison (5.0.4, ledger 2013) it deletes the untracked
or ignored __pycache__/.pytest_cache/*.pyc/*.pyo under the directory hook
paths (never tracked, never through a symlink): purged, purged_paths (first
50). A directory hook path differs when a path under it is not HEAD's,
selected paths included. refused: hook
surface paths that differ from HEAD and selected paths through a symlink;
then nothing runs. Each run is capped at FIX_RUN_TIMEOUT seconds.
program: scripts/format_files.py (PROGRAM_SHA256 holds its sha256)
```

### `before FIX_RUN_TIMEOUT` (5.0.9 line 2866)

```text
Runs the fixer hooks and stops on what the script must not accept: a
frozen file changed (stop_gate hash), a path outside `allowed` changed
(scope), or hooks that still rewrite after 3 runs (commit).
```

### `in formatFiles` (5.0.9 line 2871)

```text
frozenList: paths, or (5.0.7) {sha}: the frozen files map, passed as a 12-hex handle
```

### `in formatFiles` (5.0.9 line 2878)

```text
5.0.4 (ledger 2013): the cache purge before the comparison
```

### `in formatFiles` (5.0.9 line 2889)

```text
the program lists the frozen paths a hook changed
```

### `in formatFiles` (5.0.9 line 2894)

```text
allowed null: the files the program passed to the hooks
```

### `before formatPlanPrompt` (5.0.9 line 2904)

```text
Runs the repo's pre-commit hooks on the plan doc before the audit, so the
audit approves, and the plan commit holds, the bytes the fixers leave.
```

### `in formatPlanPrompt` (5.0.9 line 2915)

```text
5.0.3 (ledger 2010): the DSN precheck on the bytes the plan commit will hold
```

### `before commitPlanPrompt` (5.0.9 line 2924)

```text
message: the exact tag message, refMessage(full).
```

### `before verifyPlanCommitPrompt` (5.0.9 line 2952)

```text
4.0.0 (1993): the read-only check of the commit-plan step. It runs the
three programs; only this step retries (once) when a relay or a digest is wrong.
```

### `before GH_CMDS` (5.0.9 line 2993)

```text
The IaC push gate (3.1.0, ADR-1172 and ADR-1175). The
fleet may change IaC code, but IaC diffs never push automatically: any IaC
file in the PR diff (merge-base..<sha>) stops the run before the push, and
Max pushes himself. The program prints {touched, iac_files, problems, hints,
args, digest}. iac_files: every changed IaC file (names spelled in pieces:
the agent's Bash guard blocks them). problems stop the run at iac: a provider
plugin dir segment, a symlink at an IaC path or into a plugin dir, and a
change to code an existing exec stack runs at plan time. hints: the content
checks, shown to Max and never deciding anything. Read only.
program: scripts/tf_gate.py (PROGRAM_SHA256 holds its sha256)
```

### `before GH_CMDS` (5.0.9 line 3004)

```text
The remote head read (3.1.0, ADR-1175): after Max pushed an IaC diff
himself, a build run of the same plan goes on to the PR without pushing,
only when origin's branch head is exactly the approved sha. The program
prints {head, args, digest}; head is null when the remote branch is absent.
A network or auth error exits non-zero (never read as absent). Read only.
program: scripts/remote_head.py (PROGRAM_SHA256 holds its sha256)
```

### `before GH_CMDS` (5.0.9 line 3011)

```text
The origin URL read (3.1.1, ledger 1970b): the workspace step relays this
program's output, so the URL the plan seals and the build compares comes
with a digest the script recomputes. It prints {url, args, digest}: url is
`git config --get remote.origin.url` (the configured URL, before any
insteadOf rewrite), null when origin has none. Read only.
program: scripts/remote_url.py (PROGRAM_SHA256 holds its sha256)
```

### `before GH_CMDS` (5.0.9 line 3018)

```text
5.0.8 (ledger 2030): the GitHub command for each repo, picked by a program
and checked here, never by an agent (5.0.7 asked each agent to compare
`gh-personal api user` with the owner, which fails for an org repo: run
wf_aea3186a-4e1 opened its PR with the work login and stopped). For each
repo, gh runs `api repos/<o>/<n> --jq .permissions.push`, and gh-personal (if
installed) only when gh has no push: the first with push, else the first that reads, else
none. Args: <repo|-> [<o>/<n> ...]. Not sealed and not in any digest of the
plan or run-state: every run computes it again (a resume too).
program: scripts/gh_identity.py (PROGRAM_SHA256 holds its sha256)
review of #56: gh first; gh-personal only when gh has no push
```

### `before ghCheckProblem` (5.0.9 line 3033)

```text
why a relayed gh_check is unusable (null: usable)
```

### `before ghUrlSlug` (5.0.9 line 3053)

```text
the <o>/<r> of a GitHub issue or PR URL input (else null)
```

### `before intakeGh` (5.0.9 line 3058)

```text
intake's {gh_cmd} for a GitHub URL input ({} otherwise)
```

### `before ghEnsure` (5.0.9 line 3068)

```text
Checks the repos in `slugs` that no earlier check covered, in one step
(soft: write-back; an unusable relay leaves them unchecked). Returns the
checked {gh_cmd, push, tried} per slug that has one.
```

### `before ghFor` (5.0.9 line 3088)

```text
the checked {gh_cmd, push, tried} of a repo, or null
```

### `before ghNoPush` (5.0.9 line 3092)

```text
a definite no-push: every installed candidate answered false (none unknown)
```

### `before freezeRefPrompt` (5.0.9 line 3215)

```text
4.0.0 (1987): a ref to the freeze tree object, hooks off, no commit object.
```

### `before RETRY_SHELL` (5.0.9 line 3246)

```text
One inline shell retry loop: the first attempt, then up to 3 retries after
5, 15 and 45 seconds. With fatalRe, a matching stderr stops the loop at once.
The loop prints the last stderr and rc=<0|1>.
```

### `before PURGE_FIND` (5.0.9 line 3260)

```text
Deletes every __pycache__ dir, *.pyc/*.pyo file and .pytest_cache dir in the
worktree (sparing .git, venvs, node_modules and nested fleet worktrees), and
prints purged=<count>. Bytecode is not hashed, so a planted pyc whose header
matches a frozen test's mtime and size would run instead of the test.
```

### `before TEST_ENV` (5.0.9 line 3269)

```text
The env every suite run of the frozen tests uses: no bytecode written, no
pytest cache (so no stale or planted cache is read either).
frozen (4.0.0, 1981): a role DSN goes into a copy, never into this object
```

### `before BUILD_ENV_ROWS` (5.0.9 line 3276)

```text
5.0.6 (ledger 2019): build output and caches outside the worktree. One row
per tool that writes ignored build output or a cache into the repo by
default: [env var, path under the role's own build dir]. Every role that
builds, tests or runs hooks in the worktree gets these vars (in test_env, or
in the hook env of the commit step and the push), each role and round its
own dir <scratch>/build/<nonce>/<key>, emptied by build_dir.py right before
it runs (with every earlier step's dir: one step's output at a time). The hasher check is unchanged: a command run without them writes
in the worktree and stops the run as in 5.0.5. Adding a tool is one row.
```

### `before BUILD_ENV_NOTE` (5.0.9 line 3292)

```text
Not TMPDIR: the scratch dir is inside the user's checkout, so a temp dir
there would make git, cargo, pytest and node find that checkout from a
test's temp files; /tmp is outside the worktree already.
```

### `before envPrefix` (5.0.9 line 3306)

```text
the exact prefix a role puts in front of every command: env K='v' ... + space
```

### `before roleEnv` (5.0.9 line 3310)

```text
a role's test_env, its prefix and the note: TEST_ENV, the build vars of
`key` (its own dir), the DSN of its database when the run has one
```

### `before resetBuild` (5.0.9 line 3328)

```text
Empty the build dirs of `keys` right before their role runs. Counted in
state.agents, never against the cap (bounded by the role dispatches). Any
failure stops the run: a dir that may hold old output is never handed out.
```

### `before buildTeardown` (5.0.9 line 3343)

```text
At the end of every run that reset a build dir: delete <scratch>/build
(all runs' dirs of this worktree). Soft: a failure is logged, never a stop.
```

### `before pushPrompt` (5.0.9 line 3396)

```text
The push classifier (3.1.0, ledger 1935c). Args: the file holding the
first push attempt's stdout and stderr, and its exit code; it prints them
back in args. It reads line-start prefixes only (`error:`, `fatal:`,
` ! [`), never words inside a line or the remote URL. A pre-push hook can
print the same prefixes, so its words and git's cannot always be told
apart; the rules never retry what may be a hook's verdict (a retry re-runs
the hook). In order: exit 0 -> ok; ` ! [rejected]` -> non_ff;
` ! [remote rejected]` -> remote_rejected; `error: failed to push some
refs` (git prints it when a pre-push hook declines) with exit 1 and no
` ! [`: with a `fatal:` or `error: RPC failed` line -> ambiguous (a stop
for a human), else hook_rejected, hook_tail = the last 60 lines; that line
with any other exit code -> ambiguous; anything else (no hook verdict:
auth, network, 5xx before the hook ran) -> network. Prints
{push_result, exit_code, hook_tail, args, digest}. Runs nothing.
program: scripts/push_classify.py (PROGRAM_SHA256 holds its sha256)
```

### `before pushPrompt` (5.0.9 line 3412)

```text
4.0.0 (1985): the push-access probe's classifier. Args: <file> <exit>, the
output file and exit code of `git push --dry-run --porcelain` (timeout
120 s). In order: exit 0 -> ok; exit 124 -> timeout; a porcelain
`!<TAB>..<TAB>[rejected] (non-fast-forward|fetch first)` line -> non_ff or
fetch_first (the remote branch exists; access ok); an auth line
(Permission to .. denied, Authentication failed, Could not read from remote
repository, Repository not found) -> denied; `error: failed to push some
refs` with exit 1 and no `fatal:` line -> hook_rejected (git reached the
remote before the pre-push hook ran; access ok); else unknown. Prints
{access, result, exit_code, auth_line, args, program, digest}. Runs nothing.
program: scripts/push_probe.py (PROGRAM_SHA256 holds its sha256)
```

### `before pushPrompt` (5.0.9 line 3424)

```text
The hook surface (3.1.0, Max's rule): .pre-commit-config.yaml (at <rev> and
in the worktree), read with the fixer's isolated PyYAML loader; every name
a hook entry or args holds, and the files of every -m module. Args:
worktree, rev. Prints {surface, error, args, digest}; error (no PyYAML, a
parse error, a capped value) makes the script refuse. Read only.
program: scripts/hook_surface.py (PROGRAM_SHA256 holds its sha256)
```

### `in pushPrompt` (5.0.9 line 3433)

```text
4.0.0 (1981): the repo's pre-push hooks see the run's test database
```

### `before pushProbePrompt` (5.0.9 line 3460)

```text
4.0.0 (1985): the push-access probe (plan mode only). The dry run sends no
objects and creates no ref, but it runs the repo's pre-push hook: a PATH
re-check runs right before it.
```

### `before treeCmd` (5.0.9 line 3479)

```text
The worktree's tree as `git add -A` would stage it, built in a temporary
index outside the worktree: the real index is untouched and no hook runs.
```

### `before hashDiffPrompt` (5.0.9 line 3520)

```text
5.0.5 (ledger 2018)
```

### `before precommitIdsPrompt` (5.0.9 line 3544)

```text
G2 (confirm auto): the hook ids in .pre-commit-config.yaml as git stores it
at the plan commit. Fails closed: no file, no PyYAML or a parse error give
no ids. Prints {present, ids, parser, error?}.
program: scripts/precommit_ids.py (PROGRAM_SHA256 holds its sha256)
```

### `before FLEET_SHIM_MARKER` (5.0.9 line 3563)

```text
The PATH check (3.1.0, Max's ruling of 2026-11-09). The fleet may change IaC
code like any other code; what keeps IaC tooling from running is Max's
hard rules, the settings.json denies and the agent PATH shims nix
installs. This program resolves each IaC tool name on the agent's PATH and
says whether it is such a shim: its real path is under /nix/store/ (which
no role can write) and its first 64 KiB hold FLEET_SHIM_MARKER. It prints
{tools: {<name>: null | {path, real, shim}}, args, digest}. The names are
spelled in pieces because the agent's Bash guard blocks them. argv
--store-prefix=<dir> is for tests only; the script refuses any argument.
```

### `before PATH_TOOLS` (5.0.9 line 3573)

```text
program: scripts/path_check.py (PROGRAM_SHA256 holds its sha256)
```

### `before pathRelayProblem` (5.0.9 line 3577)

```text
Stops the run unless every IaC tool on the agent PATH is a nix shim.
recheck: {label, args} for a re-check (3.1.1); preflight passes none and
its program got [repo] only.
4.0.0 (1990): why a PATH check output is not the program's own output for
these args (a relay problem: no program, a wrong shape or args, a digest
mismatch); "" when it is. A finding in a sound output is not a relay problem.
```

### `in pathRelayProblem` (5.0.9 line 3595)

```text
5.0.1 (ledger 2003): name the check that failed
```

### `before PATH_RECHECK_SCHEMA` (5.0.9 line 3622)

```text
3.1.1 (ledger 1969): the PATH check again, right before every step that
runs repo code (writers, fixers, judges, coder, commits, push). A tool
planted after preflight in a writable PATH dir is caught at the next one.
Each check passes the program a token of its own (a counter, the run nonce
and the site), which it echoes in args: a result recorded for another
check, another run or the preflight never passes. Nothing is cached.
```

### `in pathRecheck` (5.0.9 line 3662)

```text
its own dispatch: re-checks are counted in state.agents but never against
the agent cap (bounded by the sites and rounds), so the cap refuses
exactly the runs it refused in 3.1.0
```

### `in pathRecheck` (5.0.9 line 3670)

```text
4.0.0 (1990): the check runs on haiku; a broken relay (no result, not ok,
or not the program's output for its token) runs once more on sonnet with
a fresh token. A finding in a sound output stops at once, as before.
```

### `before writeStatePrompt` (5.0.9 line 3684)

```text
The run-state ref: refs/fleet/<task id>/state points at an annotated tag
object (git mktag, no tag name, no hook, index untouched) whose target is
HEAD and whose message is the state JSON. Local only, never pushed.
The chunks are the base64 of the state JSON (see PLAN_REF_WRITE_PY). Prints
{head, state_sha, program, digest}.
program: scripts/state_write.py (PROGRAM_SHA256 holds its sha256)
```

### `before readStatePrompt` (5.0.9 line 3705)

```text
Reads the run-state ref: {exists, target, message, head, head_tree, clean}.
program: scripts/read_state.py (PROGRAM_SHA256 holds its sha256)
```

### `before ledgerReadPrompt` (5.0.9 line 3737)

```text
The body-page write-back for a yadgar ledger task with no body_slug (3.1.0,
ledger 1958). A judge read before and after the write; the script compares
the titles and checks the slug it computed itself.
```

### `before yaadgaarReadPrompt` (5.0.9 line 3770)

```text
The yaadgaar write-back (3.0.0, ledger 1928). The yaadgaar client takes its
project from the session's start directory, never from the repo. 3.1.3
(ledger 1979): the step reads by the id intake sealed (a URN names one task
in every project), the script checks id and number, then edits by id. A
non-empty body is never re-sent: a literal patch on a unique tail of it
appends the section (bug #10 class: a model copy of a long body is cut).
```

### `before yaadgaarWritebackPrompt` (5.0.9 line 3789)

```text
The yaadgaar edit (3.0.0, ledger 1928), run only after the script checked
the project the read step resolved. It edits by id: a non-empty body is
never re-sent; a literal patch on a unique tail of it appends the section
(bug #10 class: a model copy of a long body is cut).
```

### `in state` (5.0.9 line 3860)

```text
5.0.0 (R3): the coder's follow_ups (followUpsOf)
```

### `in state` (5.0.9 line 3868)

```text
5.0.0 (R1): the ROLE_SHA256 entries preflight found in the roles dir
```

### `in state` (5.0.9 line 3873)

```text
3.1.1: the repo the PATH re-checks name, and their count
```

### `in state` (5.0.9 line 3876)

```text
5.0.6 (ledger 2019): build-dir resets, outside the cap like path checks
```

### `in state` (5.0.9 line 3878)

```text
the run's scratch dir once the layout is known (its build dirs; teardown)
```

### `in state` (5.0.9 line 3880)

```text
4.0.0 (1993): the shipped programs' directory, resolved in this run's first agent
```

### `in state` (5.0.9 line 3882)

```text
5.0.0 (R1): its sibling roles dir
```

### `in state` (5.0.9 line 3884)

```text
5.0.0 (R2): the ledger read tools preflight found in this run's session
```

### `in state` (5.0.9 line 3886)

```text
5.0.9 (ledger 2032): the yaadgaar project session_project.py derived, or null
```

### `in state` (5.0.9 line 3888)

```text
4.0.0 (1993): a plan ref committed but not verified (returned on a halt)
```

### `in state` (5.0.9 line 3890)

```text
5.0.0 (R1): the role files are pinned (models set); the log-only record a
plan run seals: {fleet_version, role_sha256}
```

### `in state` (5.0.9 line 3894)

```text
4.0.0 (1987): the digest of the last freeze and its plan_ref (returned on a stop)
```

### `in state` (5.0.9 line 3896)

```text
5.0.8 (ledger 2030): the workspace step's checked gh_check
```

### `in state` (5.0.9 line 3899)

```text
4.0.0 (1981): the run's test database {name, users, port, env, image, dbs, expires, mechanism}
```

### `in state` (5.0.9 line 3901)

```text
the container main's finally removes (set before db-up starts it)
```

### `before halt` (5.0.9 line 3910)

```text
stopGate: the gate that ended the run (one of STOP_GATES), or omitted.
```

### `before capped` (5.0.9 line 3917)

```text
the agents the cap counts: every dispatch but the PATH re-checks (3.1.1)
```

### `before nonced` (5.0.9 line 3931)

```text
The caller's run_nonce, appended to every infra prompt. The workflow
runtime replays a cached result for an unchanged prompt on resume
(resumeFromRunId); a stateful check (workspace, hasher, branch-scan, ...)
must never return the verdict of an earlier worktree. A new invocation has
a new nonce, so no infra call replays, and no role call after one does.
```

### `before infraCall` (5.0.9 line 3940)

```text
4.0.2 (ledger 1997): an infra agent's prompt and opts. A prompt that runs
shipped programs gets the file_sha256 rule for its slots and a schema copy
that requires file_sha256 there; one that runs a program its label has no
slot for stops the run.
```

### `before infraModel` (5.0.9 line 3951)

```text
4.0.0 (1990): the INFRA_TIER model of an infra label; none stops the run.
```

### `before dispatch` (5.0.9 line 3958)

```text
Infra agents: the INFRA_TIER model of their label.
```

### `before agentOpts` (5.0.9 line 3969)

```text
the runtime's agent options: opts.digest is the script's own
```

### `before DIGEST_RETRY` (5.0.9 line 3977)

```text
5.0.7 (ledger 2020): opts.digest names the PROGRAM_KEYS entry of a read-only
program a step relays at its top level. A relay that fails ONLY on the
digest (status ok, the shipped program, a digest of the right form that the
relayed keys do not hash to: a value mis-copied) is dispatched once more to
a fresh agent, label <label>:digest-retry, on the agent cap; the gate log
names it. Any other failure, or a second mismatch, goes on to the step's
own check, as before.
```

### `before ARGS_RETRY` (5.0.9 line 3989)

```text
5.0.7 review: opts.args (the args the step sent): a relay whose ONLY fault
is that its program ran on other args (a value mis-typed) gets the same one
retry, label <label>:args-retry.
```

### `before softDispatch` (5.0.9 line 4005)

```text
Infra agents whose failure must not stop the run (write-back). Returns null
when the cap is reached or the agent dies.
```

### `before roleAgent` (5.0.9 line 4020)

```text
Role agents: the tier from the role file's DISPATCH line. The caller has already counted
the first attempt. A dead agent (null) is retried once on the fallback tier;
the retry counts toward the agent cap.
```

### `before collect` (5.0.9 line 4039)

```text
5.0.0 (R2, R3): optional memory notes; never required, never written by the workflow
```

### `before followUpsOf` (5.0.9 line 4045)

```text
5.0.0 (R3): the coder's optional follow_ups ({summary, path}), whole-build
values like its other keys, so the last accepted coder result wins. Passed
through to the run result; the workflow writes them nowhere.
```

### `before callRole` (5.0.9 line 4055)

```text
deferCheck: the caller runs its script gates (hash, fingerprint) first and
calls checkRole after them, so a gate violation is reported before drift.
noRetry: the caller handles drift itself (the coder: drift is a finding).
```

### `before contractProblem` (5.0.9 line 4073)

```text
Contract checks on a role result, as a message (null when clean): the
result came from the shipped role file (any status, 5.0.0), and an ok result
carries every required key and a known verdict.
```

### `before roleFileProblem` (5.0.9 line 4083)

```text
5.0.0 (R1): why a role result did not come from the shipped role file of
`role` (null: it did). The agent relays the sha256sum line it printed before
reading the file; as with programProblem, a wrong or missing value stops.
```

### `before sharedFileProblem` (5.0.9 line 4099)

```text
5.0.0 (R3): why an ok result of a role in SHARED_FOR did not read its
shipped shared file (null: it did, or the role has none, or the result is
not ok: a role's own failure is reported as itself).
```

### `before driftOf` (5.0.9 line 4116)

```text
Drift in an ok result, against the frozen (STRICT) types: {msg, detail}
or null. 4.0.0 (1984): null passes only where the frozen type allows it,
and every type is checked (est_diff_lines: null must never reach a gate).
```

### `before retryOnDrift` (5.0.9 line 4135)

```text
4.0.0 (1984): an ok result that drifts (a missing key, a wrong type or
value, an unknown verdict) is re-dispatched once with the drift quoted,
after a fresh PATH re-check. A second drift stops the run at checkRole as
before. The retry counts toward the agent cap.
```

### `in retryOnDrift` (5.0.9 line 4141)

```text
5.0.0 (R1): a role_file problem on an ok result takes the same one retry
5.0.0 (R3): and a shared_file problem
```

### `before roleStatusText` (5.0.9 line 4157)

```text
A role's own needs_human/failed reason wins over contract drift; drift is
reported only when the role says ok.
```

### `before typeMatches` (5.0.9 line 4175)

```text
4.0.0 (1984): every JSON type is checked against the frozen schema type;
null only where that type lists it.
```

### `before hasher` (5.0.9 line 4190)

```text
A worktree state: {fingerprint: {head, tree}, hashes, changed}. baseTree:
also list the paths that differ from that tree (the ownership check).
```

### `in hasher` (5.0.9 line 4202)

```text
every map is required: a map the relay dropped (2.1.4: ignored) must not read as empty
```

### `in hasher` (5.0.9 line 4206)

```text
5.0.5 (review S2): hasher.py's fixed relay-cap marker; the stop text is the
script's own, with the sizes only when they have the program's exact form
```

### `in hasher` (5.0.9 line 4215)

```text
the maps travel through a model: recompute the program's digest over them
```

### `in hasher` (5.0.9 line 4218)

```text
4.0.0 (security review): every fingerprint also hashes the shipped
programs; a change by any role shows up at the next one. 5.0.7: as
{count, sha256} of the map, against this script's own table
```

### `in hasher` (5.0.9 line 4223)

```text
5.0.7 (ledger 2020): every map is a summary; its file is in this run's
scratch dir, named by the sha256 of its bytes (= the summary's sha256,
but for ignored, whose summary leaves the settings file out)
```

### `before BUILD_ENV_HINT` (5.0.9 line 4241)

```text
5.0.6 (ledger 2019): the likely cause, after the last ignored path named.
Text only: the stop and its gate are the 5.0.5 ones.
```

### `before expandKeys` (5.0.9 line 4245)

```text
5.0.7 (ledger 2020): `keys` (changedKeys rows) with every changed MAP_ALL
row replaced by the rows hash_diff.py lists for that map between the states
a and b ({map, key, name, kind}), and an overflow row ({more}) past its cap.
A comparison that fails keeps the MAP_ALL row with `unavailable`: no site
routes a MAP_ALL row, so it stops there as an unrouted key (fail closed);
errGate (a site that routes any change to the coder): stop at once instead.
```

### `in expandKeys` (5.0.9 line 4254)

```text
5.0.7 review: the program gets <scratch> and 12-hex handles, never a
64-hex value; it prints the full shas, checked here against the files held
```

### `in expandKeys` (5.0.9 line 4270)

```text
a comparison the cap cannot fit stops at cap, never as a routed key
```

### `in expandKeys` (5.0.9 line 4283)

```text
review SF2: every changed map has a row, unless the overflow row covers it
```

### `in expandKeys` (5.0.9 line 4294)

```text
the cap is over all maps: the rest is counted on the last map listed
```

### `before keyNames` (5.0.9 line 4301)

```text
Violation texts of expanded rows; the build-env hint after the last
ignored row that came from the files (5.0.6 text).
```

### `before infra` (5.0.9 line 4313)

```text
digest (5.0.7): the read-only program's PROGRAM_KEYS id; args: the args
its output echoes (digestRetry)
```

### `before judged` (5.0.9 line 4325)

```text
Fingerprint the worktree around a judge run: HEAD, the tree and the hasher
maps. Any change discards the verdict, whatever it was. pre: the state
taken right before (a hasher result); preLabel: take it now instead.
opts.allowNotOk: return a needs_human/failed result instead of stopping.
```

### `in finish` (5.0.9 line 4360)

```text
5.0.0 (R1): the ROLE_SHA256 pins preflight found the role files at
```

### `before finishStop` (5.0.9 line 4369)

```text
4.0.0 (1993): a stop after the plan commit and before its check passed
returns that plan_ref, marked unverified (build mode re-verifies everything
at load-ref).
```

### `in finishStop` (5.0.9 line 4379)

```text
4.0.0 (1987): a stop after a freeze returns its digest; a build re-run
with it resumes at the coder while the worktree is still the freeze tree
```

### `before freezeDigestOf` (5.0.9 line 4388)

```text
4.0.0 (1987): sha256 over the plan ref's sha256, the freeze tree and the
frozen maps' digest. The caller holds it; the script recomputes it from git
(the freeze ref, the worktree tree) and the hasher maps.
4.0.0 review: a freeze after a fix_tests re-freeze binds `refrozen: true`
(absent otherwise, so an untouched freeze keeps its digest). A frozen resume
restarts the round and re-freeze counts, so it is refused for a re-frozen
state.
```

### `before preflightStep` (5.0.9 line 4417)

```text
The first step of every run (5.0.0, R1): the scripts and roles directories,
their files' hashes and the PATH check, in one agent; then the role tiers
from ROLE_DISPATCH. Nothing is cached: a build checks the roles again.
```

### `in preflightStep` (5.0.9 line 4427)

```text
4.0.0 (1993): the shipped programs' directory, found by this run's first
agent (never cached, never sealed); the PATH check below ran from it, and
its self-hash proves the directory holds this version's programs.
5.0.0 (R1): its sibling roles dir, every file at its ROLE_SHA256 pin.
```

### `in preflightStep` (5.0.9 line 4437)

```text
Max's ruling (2026-11-09): IaC tooling may only be reachable through the nix shims
```

### `in preflightStep` (5.0.9 line 4439)

```text
5.0.0 (R2): the ledger tools census, advisory (review of 88eb9b0): a
malformed census counts as [] and blocks nothing; the steps try the tools
```

### `in preflightStep` (5.0.9 line 4444)

```text
5.0.9 (ledger 2032): only a digest-checked relay names the session project
```

### `before pushProbe` (5.0.9 line 4463)

```text
4.0.0 (1985): plan mode only, before the planner. A fresh PATH re-check,
then the dry run (it runs the repo's pre-push hook). Access ok: ok,
hook_rejected, non_ff, fetch_first. An auth line stops the run before any
role; anything else (a timeout, no usable relay) logs "push access
unknown" and the run goes on: the real push is still gated later.
```

### `in workspaceStep` (5.0.9 line 4504)

```text
remote_slug (owner/name of origin) is the GitHub repo for the planner and
the PR; project is only the recall scope
```

### `in workspaceStep` (5.0.9 line 4509)

```text
3.1.1: origin's URL only from the program's digest-checked output; an
unusable relay leaves it empty, which the IaC push gate refuses
```

### `in workspaceStep` (5.0.9 line 4515)

```text
5.0.8 (ledger 2030)
(review of #56) an unusable or non-GitHub check never halts: gh_cmd is
null and the steps that need gh stop or fail softly where they run
```

### `before briefProblem` (5.0.9 line 4532)

```text
Brief from intake, or from a plan_ref: shape checked in code.
```

### `before ledgerFor` (5.0.9 line 4550)

```text
Which task ledger a project uses: yaadgaar for yadgarhq/*, else yadgar.
3.1.3 (ledger 1979): no project -> "either": intake tries both.
```

### `before LEDGER_TOOLS` (5.0.9 line 4557)

```text
5.0.0 (R2): yadgar and yaadgaar are optional. Preflight reports which of
these read tools the session has (fleet:judge cannot see the write tools);
a read tool stands for its server. The census is ADVISORY (review of
88eb9b0): a haiku relay of ToolSearch can miss a tool, so it never blocks a
ledger path. Intake and the write-back steps try the tool themselves and
report "absent" / "unavailable" when ToolSearch truly finds none.
```

### `before ledgerAdapter` (5.0.9 line 4565)

```text
The write-back adapter for a task's sources (pure): "yaadgaar" or "yadgar"
for a ledger source (the census only adds a note to the reason: the steps
try the tool); else "tracker" when a GitHub, Codeberg or Jira source exists
(the marked comment is the whole write-back, Max's ruling 2026-11-10); else
"none". A yadgarhq/ project never uses the yadgar ledger (ADR-0994).
Project problems of a ledger stay the write-back's own `failed` entries.
```

### `before ledgerToolNeeded` (5.0.9 line 4585)

```text
The ledger tool a project's ledger needs (5.0.0, R2), for the stop reason.
```

### `before noLedgerStop` (5.0.9 line 4591)

```text
Intake stopped because no ledger tool exists: every ledger call it made was
"absent" (ToolSearch found no tool). Null: another stop.
```

### `before ledgerProblem` (5.0.9 line 4599)

```text
A source from the wrong ledger for the project (null: ok).
```

### `before TASK_ID_INPUT_RE` (5.0.9 line 4611)

```text
3.1.3 (ledger 1979): a task-id input, and the reason intake halts with.
The script composes it: the agent's reason (dropped when it advises a
repo's project-id file: the ledger scope is args.project, never the
repo), then every ledger call intake made with the tool's error text.
```

### `before PROJECT_ADVICE_RE` (5.0.9 line 4616)

```text
Advice to change a repo's project identity. A tool call's own
`project_id=<project>` argument is not advice: it is removed before the test.
```

### `before LEDGER_CALL_RE` (5.0.9 line 4620)

```text
A quoted ledger tool call, e.g. task_get(project_id=o/r, id=42): plain
key=value arguments only, none naming a .yadgar path. Only such a call is
exempt; a bare project_id= anywhere else is tested like any other text.
The grammar is unambiguous (no "=" in a value, a comma between arguments),
so a match fails in linear time on agent text; the text is cut to
ADVICE_MAX first.
```

### `before noAdvice` (5.0.9 line 4631)

```text
Agent-written prose (the reason, a call) only. tried[].error is the error
text intake reports for a tool call; the script cannot prove it is the
tool's own text, so it is relayed unfiltered, cut and labelled as intake's.
```

### `in intakeHaltReason` (5.0.9 line 4640)

```text
a Jira, issue, plan or text input: the reason is relayed as is
```

### `before yaadgaarScope` (5.0.9 line 4663)

```text
3.1.3: the project a yaadgaar answer names must be args.project (null: ok).
The gateway names one only for a task outside the client's project; the
sources are checked raw, before cleanBrief, and the project is never sealed.
5.0.9 (ledger 2032): "" names none; then the client's project must be
proven: session_project.py's derivation (state.sessionProject) = want.
```

### `before YAADGAAR_URN_RE` (5.0.9 line 4682)

```text
3.1.3: a yaadgaar source carries the URN from the read_task answer, and
intake reports the read_task call that returned it; else intake never
called the tool (null: ok).
```

### `before ledgerSourceOf` (5.0.9 line 4697)

```text
3.1.3: the ledger task the plan was made from, with its ledger and project,
for the confirmation (null: no ledger source).
```

### `before CONFUSABLE_CAT_RE` (5.0.9 line 4727)

```text
Code points a model's JSON can silently turn into another character, or
that cannot be seen: every control (Cc, CR included), format character (Cf:
zero-width, bidi, soft hyphen, BOM, tags), space (Zs: NBSP and the other
spaces) and line or paragraph separator (Zl, Zp) except the plain space, tab
and newline; plus the variation selectors U+FE00-U+FE0F, the tag block
U+E0000-U+E007F, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0, the
combining grapheme joiner U+034F, U+180E and U+00AD. Emoji built with a
zero-width joiner or U+FE0F are refused too.
```

### `before confusableIn` (5.0.9 line 4747)

```text
The first confusable code point in any string of v, as "U+XXXX at <path>", or null.
```

### `before confusableFindings` (5.0.9 line 4772)

```text
Criteria whose text, examples, dont_care or property hold a confusable
character, as findings {criterion, finding}. Test writers get the whole
criterion (2.1.6). spec_quote, a verbatim copy of the spec, is not checked;
visible non-ASCII is fine.
```

### `before normCriteria` (5.0.9 line 4794)

```text
testCmd: the plan's test_cmd; every criterion's test_args is checked
against it (4.0.0, ledger 1980) and kept only when it passes.
```

### `before screenCheckCmds` (5.0.9 line 4827)

```text
scope-and-plan then plan-audit. ctx: {common, brief, date, baseRef,
remoteSlug, suffix}. Returns the plan facts; held-out examples stay behind.
A check_cmd outside the allowlist is never offered to any role: it is kept
as check_cmd_rejected (with the reason) and the code judge rules on the
obligation from the diff alone.
```

### `before checkScripts` (5.0.9 line 4856)

```text
A check_cmd script must be a tracked regular file whose realpath stays
under its root, in `worktree` as it is now. Run at plan time and again
before every code-judge run (the coder may have changed it). A failure, or
a missing result, demotes the obligation to judge-only.
```

### `in checkScripts` (5.0.9 line 4870)

```text
a relay that changed a verdict: every script stays judge-only
```

### `before planPathProblem` (5.0.9 line 4885)

```text
Why a planner plan_path is unusable (null: ok): it must be a relative .md
path inside the repo, in [A-Za-z0-9._/-] only. The park step moves it, the
commit stages it and the caller grep excludes it.
```

### `before MAX_AUDIT_ROUNDS` (5.0.9 line 4897)

```text
4.0.0 (1983): up to MAX_AUDIT_ROUNDS re-plan rounds in every confirm mode;
the script-side refusals (confusables, the caller map, the grep diff) and
the plan-audit refusals count toward the same rounds.
```

### `before roundSuffix` (5.0.9 line 4902)

```text
The suffix of re-plan round n of a planAndAudit call whose round 0 has
suffix `base`: "", ":audit-fix", ":audit-fix-2", ...
```

### `before roundSnapshot` (5.0.9 line 4908)

```text
What a planner round declared: {change_kind, new_behaviour, criteria:
[{id, text}]}; a value of another type reads as null.
```

### `before relaxedReasons` (5.0.9 line 4919)

```text
4.0.0 (1983, ADR-1186): how a re-plan round relaxed round 0 (empty: it did
not). A prior round with no usable round0 counts as relaxed (fail closed).
```

### `before priorRoundView` (5.0.9 line 4938)

```text
The prior_round a planner or plan-audit sees: every finding of every earlier
round, the last map, round 0 and every earlier round's criteria.
```

### `before replanWithFindings` (5.0.9 line 4952)

```text
A re-plan round (4.0.0: any confirm mode, up to MAX_AUDIT_ROUNDS). The
planner gets the findings as a text source and as prior_round, and updates
its draft in place. rawMap: the refused round's changed_symbols as returned
(2.1.6). Every symbol any earlier round mapped, and every symbol a finding
named, is carried: the next round must keep each one in its map (narrower
symbols only in addition), and its audit gets the accumulated prior_round.
plan: the refused round's planner output (its snapshot joins the rounds).
```

### `in replanWithFindings` (5.0.9 line 4978)

```text
a seeded prior keeps its own round 0 (or none: relaxed, fail closed)
```

### `before noteRound` (5.0.9 line 4997)

```text
4.0.0 (1986): the refused rounds of this run, for the park step's
findings.json ({reason, rounds, symbols}).
```

### `before occurrenceKey` (5.0.9 line 5005)

```text
"<path>:<line>" with the path normalised (no ./, no empty or . segments),
or null when it is not a relative path inside the repo and a line >= 1.
```

### `before changedSymbolFindings` (5.0.9 line 5016)

```text
Caller coverage (2.1.6, ledger 1955). The planner's changed_symbols as
{findings, clean}: each symbol a bare identifier listed once, with a
non-empty occurrences list; each occurrence a "<path>:<line>" listed once
and mapped to exactly one of an existing criterion id or a dont_care reason.
```

### `before AUTO_DONT_CARE` (5.0.9 line 5061)

```text
4.0.0 (1989, ADR-1185): the doc and lock files whose grep hits the caller
check maps itself as dont_care. The JS mirror of CALLERS_PY's doc_or_lock();
config, manifest, .txt, .csv and .svg files stay planner-mapped.
```

### `before callerCheck` (5.0.9 line 5073)

```text
The caller grep and its diff against the planner's map: a hit the map does
not list, a mapped line that is no hit, and a symbol over the cap are
findings. Returns {findings, occurrences}. The relayed lists must match the
program's digest.
```

### `in callerCheck` (5.0.9 line 5095)

```text
4.0.0 (1989, ADR-1185): a hit is auto dont_care only when the program
lists it AND the script's own file list agrees (a doc or lock file that
is not collected as a doctest); a missing list maps nothing
```

### `before buildCallerFindings` (5.0.9 line 5133)

```text
The build-time caller check (3.0.0, ledger 1956). The approved tree
(base: the plan commit) may modify an existing definition only where the
sealed changed_symbols maps it: a symbol of that name with an occurrence in
the same file inside the definition's lines (a same-named function in
another file is not covered). A change in a file no definition pattern
covers, a module-level change in a classified file, and a definition whose
name is no identifier (changed_symbols cannot name it) pass only when the
plan lists that file explicitly (allowed_additions.files or a repo
obligation's files; an occurrence of a mapped symbol there does not
count). Anything else stops the run before the commit:
the script cannot tell a coder's scope creep from a planner's miss, and the
actions#211 B1 weakening was exactly such an unmodelled definition.
```

### `in buildCallerFindings` (5.0.9 line 5151)

```text
only a file the plan lists explicitly waives (an occurrence of some
symbol in that file does not: a caller of foo waives nothing else)
```

### `in buildCallerFindings` (5.0.9 line 5161)

```text
changed_symbols cannot name it (SYMBOL_RE): covered only by a listed file
```

### `in buildCallerCheck` (5.0.9 line 5190)

```text
5.0.2 (ledger 2006): the digested keys are the table's; defs as {name, at, end}
```

### `before HOOK_PATH_RE` (5.0.9 line 5210)

```text
Hook-surface separation (3.1.0, Max's rule): a change to the hook surface is
never built with other changes, and never without Max. The surface is every
hook-manager and CI path (HOOK_PATH_RE, any case) and every repo path the
program HOOK_SURFACE_PY finds: hook entry and args files, -m modules, the
Makefiles of a `make` hook, symlink targets, one level of Python imports and
shell `source`/`.`, the scripts CI files name, the core.hooksPath dir. An
entry ending "/" is a directory prefix. targets: make targets whose recipe
paths the program also returns (make_paths, for F2).
```

### `before hookGate` (5.0.9 line 5255)

```text
Stops (needs_human, stop_gate hooks) when paths touch the hook surface:
together with other paths, or alone. There is no automatic path.
```

### `before planScopePaths` (5.0.9 line 5267)

```text
A plan's scope: the files it names, its criteria's test files and the paths
of the caller occurrences it maps to a criterion (the callers it alters).
```

### `before makeTargets` (5.0.9 line 5281)

```text
The make targets of the allowlisted `make <target>` check_cmds (F2).
```

### `before planScopeFiles` (5.0.9 line 5291)

```text
The files a plan names outside changed_symbols: allowed_additions.files and
every repo obligation's files.
```

### `before afterRounds` (5.0.9 line 5301)

```text
" (after <n> re-plan rounds)" once a round ran, else "".
```

### `before planFindingsStop` (5.0.9 line 5307)

```text
A re-plan round for plan findings while rounds are left, else a stop.
```

### `before planAndAudit` (5.0.9 line 5315)

```text
ctx: {common, brief, date, baseRef, remoteSlug, remoteUrl, suffix,
maxRounds, auditRound, baseSuffix, priorRound, priorDraft, onPlanPath}.
priorRound and priorDraft (4.0.0, 1983 and 1986) are planner inputs only:
never in common, never in brief.sources, never sealed; plan-audit alone
also gets prior_round.
```

### `in planAndAudit` (5.0.9 line 5338)

```text
from here on a stop leaves a draft plan in the worktree
```

### `in planAndAudit` (5.0.9 line 5353)

```text
4.0.0 (1983): a round after a refusal (this run's or a parked run's) that
relaxed round 0 is never auto-eligible; carried into every later round
```

### `in planAndAudit` (5.0.9 line 5362)

```text
2.1.4 #7: an invisible or confusable character in examples or property
```

### `in planAndAudit` (5.0.9 line 5365)

```text
2.1.6 (ledger 1955): every occurrence of each changed symbol is mapped,
and a word-boundary grep finds no occurrence the map leaves out
```

### `in planAndAudit` (5.0.9 line 5371)

```text
a re-plan round keeps every symbol any earlier round mapped or a finding
named (2.1.6 review): dropping or swapping one stops the run
```

### `in planAndAudit` (5.0.9 line 5390)

```text
4.0.0 (1989): the unmapped doc and lock hits join the sealed map as dont_care
```

### `in planAndAudit` (5.0.9 line 5402)

```text
4.0.0 (1991): sealed so a build-mode :rerun of the auto gates sees the
values the plan run judged
```

### `in planAndAudit` (5.0.9 line 5410)

```text
3.1.0: origin's configured URL at plan time, before any role ran; the
IaC push gate's network reads use it, never the repo config
```

### `in planAndAudit` (5.0.9 line 5422)

```text
risk tier: computed and logged. 4.0.0 (1991): isShortPath decides it from
the sealed plan facts; the build re-decides it from the sealed ref
```

### `in planAndAudit` (5.0.9 line 5435)

```text
Max's rule (3.1.0): a plan that touches the hook surface stops here
```

### `in planAndAudit` (5.0.9 line 5438)

```text
the repo's fixers run on the plan now, so the audit sees the bytes the
plan commit will hold (2.1.4: prettier rewrote the plan in the commit)
```

### `in planAndAudit` (5.0.9 line 5448)

```text
5.0.3 (ledger 2010): the plan commit gate refuses any mysql:// text, any
case (verify-plan-commit, plan_files.py); a hit here is a re-plan finding
```

### `in planAndAudit` (5.0.9 line 5458)

```text
the finding never quotes the scheme: the planner may copy it into the plan
```

### `in planAndAudit` (5.0.9 line 5463)

```text
3.1.2: the audit runs the planner's test_cmd in a scratch worktree
```

### `in planAndAudit` (5.0.9 line 5471)

```text
release review of #48: the task's own text, for the omission and source_quote checks
```

### `in planAndAudit` (5.0.9 line 5479)

```text
every refused round before this one (4.0.0: accumulated), or null
```

### `in planAndAudit` (5.0.9 line 5485)

```text
4.0.0 (1983): a re-plan round with the audit findings while rounds are left
```

### `in planAndAudit` (5.0.9 line 5499)

```text
release review of #48: an approve may carry advisory findings (Non-goals,
STRIDE, failure paths, source_quote); they never refuse, and go to the log
```

### `in planAndAudit` (5.0.9 line 5519)

```text
4.0.0 (1983): how a re-plan round relaxed round 0 (empty: none)
```

### `before MAX_SHORT_TEST_ROUNDS` (5.0.9 line 5524)

```text
4.0.0 (1991): the short path (one test writer for every criterion, at most
MAX_SHORT_TEST_ROUNDS test rounds; every gate still runs) applies when the
sealed plan facts say est_diff_lines < 20 and new_behaviour false.
```

### `before commitPlanAndRef` (5.0.9 line 5534)

```text
Stage the plan, seal the full ref with the staged plan hash, commit the
plan doc alone in ONE local commit, then write the sealed ref as a tag
object at refs/fleet/<task id>/plan (never a file, never pushed).
4.0.0 (1993): the commit step writes the ref from checked base64 chunks and
is never retried; a separate read-only step verifies the commit and the ref,
and only that step retries, once, when a relay or a digest is wrong.
ctx.after: agents this run still dispatches after the ref is sealed
(counted into its history). ctx.onRefs: called with the plan refs the
step wrote (the build's frozen snapshot follows the script's own write).
```

### `in commitPlanAndRef` (5.0.9 line 5552)

```text
+ 2: the PATH re-check before the commit (3.1.1) and the verify step (4.0.0)
```

### `in commitPlanAndRef` (5.0.9 line 5564)

```text
the ref write comes from the shipped program (head and tag object, digest-checked)
```

### `in commitPlanAndRef` (5.0.9 line 5568)

```text
identical re-plan: an unchanged plan doc on a plan-only HEAD reuses that commit
```

### `before verifyPlanCommit` (5.0.9 line 5581)

```text
The read-only check of the plan commit and its ref. A relay problem (a
program that is not the shipped one, a digest, an argument or a shape that
does not match) is asked once more; two -> stop_gate commit, with the plan
ref returned as unverified. A wrong fact (other files, another plan hash,
another ref) stops at once.
```

### `in verifyPlanCommit` (5.0.9 line 5619)

```text
only this stop returns the plan_ref, marked unverified; a wrong fact below returns none
```

### `in verifyPlanCommit` (5.0.9 line 5630)

```text
4.0.0 review: a test DSN never reaches a commit (a wrong fact: no plan_ref returned)
```

### `in verifyPlanCommit` (5.0.9 line 5633)

```text
the script wrote these bytes itself: it hashes them, the step relays no content
```

### `before scratchOf` (5.0.9 line 5640)

```text
4.0.0 (1993): the run's scratch dir, a sibling of its worktrees
```

### `before makePlanRef` (5.0.9 line 5649)

```text
The full ref, sealed. It has no plan_commit: it is committed in that commit.
```

### `in makePlanRef` (5.0.9 line 5662)

```text
4.0.0: history.preflight (optional, see preflightRecordProblem) rides
in history; S3 fills it in plan mode and reads it in build mode
```

### `in makePlanRef` (5.0.9 line 5665)

```text
4.0.0 (1992): the ledger scope of the plan run (args.project), or null
```

### `before preflightRecordProblem` (5.0.9 line 5672)

```text
The preflight record a plan run seals in history.preflight, log only (5.0.0,
R1): {fleet_version, role_sha256}. A build never reads a role table from it:
it hashes the role files again. A 4.x ref's record ({fleet_version,
versions, dispatch, contract}) passes too, its maps ignored, so a plan made
on 4.x builds on 5.0.0 with the shipped role files. Optional (absent or null
in older refs).
```

### `before countsOf` (5.0.9 line 5686)

```text
4.0.0 (1990): the history counts the caller sees (not the sealed role table)
```

### `before isPlanCommit` (5.0.9 line 5707)

```text
A plan commit of this task: subject plan(<task id>):, and a file set that
is exactly {plan_path}, where plan_path comes from a sealed plan ref of
this task (refs/fleet/<task id>/plan or plan-<n>) whose target is that
commit. No such ref, or any other path: a build commit. 3.0.0: the scan
program reads each message and reports task_id, plan_path and ref_ok (the
planRefProblem checks); no message text crosses the relay.
```

### `before validRemoteUrl` (5.0.9 line 5733)

```text
A sealed origin URL: https or git@host: form only (no local path, no
transport helper, no option-like value).
```

### `before IAC_TF` (5.0.9 line 5739)

```text
The JS mirror of TF_GATE_PY's iac(): an IaC file, a provider plugin dir at
any segment, or an IaC tool's config (words spelled in pieces: the agent's
Bash guard blocks them).
```

### `before FENCED_FILES` (5.0.9 line 5754)

```text
4.0.0: repo files only the fleet's own config may hold (exact repo paths,
compared case-insensitively); a change to one is fenced in every mode.
Stream S5 adds the throwaway-DB declaration here.
```

### `before fencePathProblem` (5.0.9 line 5759)

```text
G3: why a planned path is outside the scope fence (null when inside).
```

### `in fencePathProblem` (5.0.9 line 5767)

```text
(ADR-1172: IaC, Kubernetes and Helm files are fleet work like any other
code; IaC diffs never push automatically: the IaC push gate stops them)
provider plugin dirs (a local .terraform/ or terraform.d/) never belong in a change
```

### `before scopeProblems` (5.0.9 line 5779)

```text
G3: the scope fence over every planned path (criteria test_files,
allowed_additions.files, obligation files) and every command, plus the
branch and repo. Pure: no agent.
```

### `before commandShapeProblems` (5.0.9 line 5800)

```text
G2, the shape part: test_cmd (allowlisted at plan time), or a check_cmd of
the exact form `pre-commit run <id> [--all-files] [--hook-stage <s>]`.
Returns {problems, hookIds}.
```

### `before hookIdProblems` (5.0.9 line 5822)

```text
G2, the config part: each hook id exists exactly once in the config at
plan_commit; a missing or unreadable config fails closed.
```

### `before intentProblems` (5.0.9 line 5838)

```text
G1: the script's own check of the intent judge's output.
```

### `in intentProblems` (5.0.9 line 5851)

```text
4.0.0 (1991): the judge's check of the planner's change_kind and
new_behaviour, in every confirm mode
```

### `before autoGates` (5.0.9 line 5881)

```text
G1-G3 in order; the first failure stops. ctx: {sfx, common, mainWt,
planCommit, brief, callerRepo, branch, defaultBranch, criteria, planPath,
planDiff, planFacts, files}. Returns {ok, failedCheck, reasons, intent}.
```

### `in autoGates` (5.0.9 line 5886)

```text
5.0.0 (R2): the ledger task only through a ledger adapter; tracker
comments are never rulings (Max default, 2026-11-10). The project is not
passed: intake already refused a ledger source of the wrong ledger, and
common.project may be the remote slug, not the ledger scope.
```

### `in autoGates` (5.0.9 line 5908)

```text
4.0.0 (1991): the planner's claims, checked by the judge (null in an older ref)
```

### `in autoGates` (5.0.9 line 5946)

```text
4.0.0 review: the ids feed G2, so the relay is digest-checked (fail closed)
```

### `before autoGateAgents` (5.0.9 line 5961)

```text
How many agents autoGates dispatches after the plan ref is sealed (all
gates pass): intent pre-hasher, judge, post-hasher, and the config read.
```

### `in autoGateAgents` (5.0.9 line 5964)

```text
+ 1: the PATH re-check before the intent judge (3.1.2)
```

### `before defaultBlockers` (5.0.9 line 5981)

```text
4.0.0 (1991, ADR-1186): why confirm "default" must ask Max for this plan
(empty: the auto gates run). change_kind and new_behaviour are planner
claims from untrusted task text, not a boundary: they only narrow which runs
skip the human yes; G1-G3, the IaC push stop and the hook gate still hold.
```

### `in planMode` (5.0.9 line 6001)

```text
3.1.3: with no project a task id resolves in whatever project the
session's ledger client is bound to; never build that unconfirmed
```

### `in planMode` (5.0.9 line 6008)

```text
5.0.0 (R2): the census is a hint; intake tries the ledger tool itself
```

### `in planMode` (5.0.9 line 6038)

```text
never commit a plan on top of code: only earlier plan commits may be there
```

### `in planMode` (5.0.9 line 6057)

```text
newest first: HEAD, a plan-only commit of this task (no build commit is there)
```

### `in planMode` (5.0.9 line 6059)

```text
4.0.0 (1986): the draft and findings of a stopped run newer than the last
plan commit, as planner-only inputs; the tip time is the scan program's
```

### `in planMode` (5.0.9 line 6064)

```text
4.0.0 (1981): the throwaway test database, up through plan-audit
```

### `in planMode` (5.0.9 line 6068)

```text
a stop between the planner and the plan commit parks the draft (2.1.4: the
next run's workspace step refused the untracked plan)
```

### `in planMode` (5.0.9 line 6074)

```text
4.0.0 (1986): the refused rounds go with the draft, for the next run's planner
```

### `in planMode` (5.0.9 line 6091)

```text
5.0.2 (ledger 2004): the outcome is the park program's, digest-checked
```

### `in planMode` (5.0.9 line 6102)

```text
any other error (a crash, a dead runtime call) is rethrown unchanged,
after the park outcome is logged (2.1.6)
```

### `in planMode` (5.0.9 line 6120)

```text
4.0.0 (1991): decided before the seal (the gate agents count into it)
```

### `in planMode` (5.0.9 line 6122)

```text
4.0.0 review: a parked prior the read could not use fails closed
```

### `in planMode` (5.0.9 line 6129)

```text
the commit-plan step itself, and when the auto gates run their agents
```

### `in planMode` (5.0.9 line 6132)

```text
4.0.0 (1986): the used parked folder moves to parked/used/ after the commit
```

### `in planMode` (5.0.9 line 6144)

```text
4.0.0 (1990): the role table this run loaded, for the build
```

### `in planMode` (5.0.9 line 6153)

```text
4.0.0 (1983): a relaxed re-plan never reaches the auto gates; under an
explicit "auto" it stops for Max (the plan stays committed for a ruling)
```

### `in planMode` (5.0.9 line 6157)

```text
4.0.0 review: so does a parked prior the read could not use (fail closed)
```

### `in planMode` (5.0.9 line 6170)

```text
confirm "auto", or an eligible "default": G1-G3 instead of the question; never ask
```

### `before tinyRefProblem` (5.0.9 line 6194)

```text
The tiny ref the caller carries.
```

### `before planRefProblem` (5.0.9 line 6207)

```text
The full ref loaded from the ref file.
```

### `in planRefProblem` (5.0.9 line 6221)

```text
4.0.0 (1992): absent in a ref sealed before 4.0.0
```

### `before fenceChanged` (5.0.9 line 6226)

```text
The scope fence on the REAL changed paths (every mode): a path the fence
refuses (IaC, Kubernetes, .github/, rulesets, secret-like) stops the run
before anything is committed.
```

### `before commitSubject` (5.0.9 line 6238)

```text
The commit step's subjects, derived from the sealed task id and slug only:
the first commit of a build, and each later one (a review or push-hook fix).
```

### `before isFleetCommit` (5.0.9 line 6247)

```text
A commit after plan_commit that the commit step of a build of this plan
made. Subject patterns only: git cannot prove authorship.
```

### `in buildMode` (5.0.9 line 6254)

```text
2.0.1-2.1.3 refs named a committed file; no compatibility path
```

### `in buildMode` (5.0.9 line 6264)

```text
5.0.0 (R1): every build checks the role files again
(fresh_preflight is accepted and changes nothing)
```

### `in buildMode` (5.0.9 line 6268)

```text
review of #56 (N6): a checked repo with no push stops before any build step
delta D1: only a definite no-push stops; an unknown answer goes on
```

### `before rereadBrief` (5.0.9 line 6275)

```text
Re-read the sealed task through intake (confirm "auto" in build mode), so
the intent judge sees the current ledger rulings. Plan and text sources
have no rulings: the sealed brief is used as is.
```

### `in rereadBrief` (5.0.9 line 6287)

```text
5.0.0 (R2; Max's ruling on #47): a sealed ledger task whose tool is gone
cannot be re-read: the current rulings are unknown, so confirm auto stops
```

### `before buildFromRef` (5.0.9 line 6304)

```text
The build from an approved plan ref: build mode, and plan mode with
confirm "auto" once its gates passed (opt.intent). Both run the same verify
path. opt.rerunGates: build mode with confirm "auto" re-runs G1-G3.
```

### `in buildFromRef` (5.0.9 line 6310)

```text
load the sealed ref from its local tag object; nothing else is trusted
```

### `in buildFromRef` (5.0.9 line 6314)

```text
2.1.4: a model relaying the whole ref shortened it. With the sealed ref in
memory (confirm auto, same run) only names and hashes are read; else the
message comes in short chunks, checked against ref_sha256, asked for once more
```

### `in buildFromRef` (5.0.9 line 6348)

```text
5.0.0 (R1): the sealed preflight record is log only; preflight checked the roles
```

### `in buildFromRef` (5.0.9 line 6351)

```text
review item 5: log only; the build runs this install's role files
```

### `in buildFromRef` (5.0.9 line 6357)

```text
4.0.0 (1992): the ledger scope sealed at plan time. A build without
args.project uses it; a different args.project stops. A ref sealed
before 4.0.0 (or by a plan run without project) has none: args.project
alone, as in 3.1.3.
```

### `in buildFromRef` (5.0.9 line 6390)

```text
a ref sealed before 2.1.5 may hold a legacy ledger source of a yaadgaar
project; 3.1.3: the ledger scope is args.project, never the origin slug
```

### `in buildFromRef` (5.0.9 line 6400)

```text
the origin URL sealed in the plan ref (3.1.0); null in an older ref
```

### `in buildFromRef` (5.0.9 line 6405)

```text
verify the approved plan
```

### `in buildFromRef` (5.0.9 line 6415)

```text
the branch facts come from a program (3.1.0, ledger 1959): every list
present, and all of them equal to what the program printed
```

### `in buildFromRef` (5.0.9 line 6438)

```text
earlier fleet commits are fenced too, before any role runs
```

### `in buildFromRef` (5.0.9 line 6444)

```text
5.0.6 (ledger 2019): the per-role build dirs live under this scratch dir
```

### `in buildFromRef` (5.0.9 line 6450)

```text
4.0.0 (1991): null in a ref sealed before 4.0.0
```

### `in buildFromRef` (5.0.9 line 6455)

```text
the approved caller map (2.1.6); null in a ref sealed before 2.1.6
```

### `in buildFromRef` (5.0.9 line 6462)

```text
4.0.0 (1991): the short path from the sealed plan facts: one test writer
for every criterion, split per criterion by the covers prefix; at most
MAX_SHORT_TEST_ROUNDS test rounds. Every gate still runs.
```

### `in buildFromRef` (5.0.9 line 6469)

```text
4.0.0 (1981): the throwaway test database, one database per consumer
```

### `in buildFromRef` (5.0.9 line 6474)

```text
the plan ref is a git object: the hasher's refs/fleet/* snapshot freezes it
```

### `in buildFromRef` (5.0.9 line 6476)

```text
the frozen maps (set at freeze; the run-state write keeps its ref current)
```

### `in buildFromRef` (5.0.9 line 6479)

```text
run-state: a build whose approved commit exists resumes at the step after
its last completed milestone, or stops; it never re-runs the writers on a
committed fleet branch
```

### `in buildFromRef` (5.0.9 line 6516)

```text
4.0.0 (1987): a frozen resume. The caller passes the freeze_digest a stop
after the freeze returned; the script recomputes it from git (HEAD, the
worktree tree, refs/fleet/<task>/freeze) and the hasher maps. Only an
untouched freeze tree resumes, at the coder; anything else stops.
```

### `in buildFromRef` (5.0.9 line 6545)

```text
confirm "auto" in build mode: re-run G1-G3 against the current rulings
(a resumed build was approved already)
```

### `in buildFromRef` (5.0.9 line 6552)

```text
4.0.0 review: G1's classification checks the planner's change_kind and
new_behaviour; a ref sealed before 4.0.0 has neither, so the script
refuses it here (fail closed) instead of trusting the judge with nulls
```

### `in buildFromRef` (5.0.9 line 6588)

```text
what the run-state records next to the approved sha
```

### `in buildFromRef` (5.0.9 line 6596)

```text
No fleet-internal path may reach the PR: the diff against the default
branch and every commit on the branch are checked before each push and
each PR-opener call (fail-closed).
ADR-1172 and ADR-1175: IaC diffs never push automatically.
Any IaC file in the PR diff stops the run before the push, in every confirm
mode; Max pushes himself. The content checks are hints in the stop message
and decide nothing. scanDiff: the fleet scan's digest-checked PR diff, a
second source the relay must agree with.
```

### `in buildFromRef` (5.0.9 line 6624)

```text
ADR-1175: the fleet never pushes an IaC diff. When Max has pushed it
himself (origin's head is exactly the approved sha), the run goes on
without a push; any other remote state stops here.
```

### `in buildFromRef` (5.0.9 line 6659)

```text
5.0.8 (ledger 2030): no agent call without a gh command that can push
```

### `in buildFromRef` (5.0.9 line 6691)

```text
Records a milestone on the run-state ref (HEAD = the approved commit).
```

### `in buildFromRef` (5.0.9 line 6727)

```text
the script's own write: the next comparison starts from the new value
```

### `in buildFromRef` (5.0.9 line 6732)

```text
The steps after the commit, from `from` (push, pr, review, writeback),
each followed by its run-state milestone. Returns null when done, or
{gate, findings} when a coder round is needed.
```

### `in buildFromRef` (5.0.9 line 6740)

```text
the repo's own pre-push hooks run here
```

### `in buildFromRef` (5.0.9 line 6745)

```text
ADR-1175: Max pushed this IaC diff himself; no push here
```

### `in buildFromRef` (5.0.9 line 6759)

```text
the only push result that does not stop the run: it must be the
classifier program's own (3.1.0, ledger 1935c)
```

### `in buildFromRef` (5.0.9 line 6790)

```text
draft PR at the pushed, approved sha (later rounds update its body)
```

### `in buildFromRef` (5.0.9 line 6804)

```text
5.0.0 (R3): the previous review round's blocking findings
```

### `in buildFromRef` (5.0.9 line 6863)

```text
5.0.0 (R2): null in a run-state written before 5.0.0
```

### `in buildFromRef` (5.0.9 line 6887)

```text
tests: every writer works in the ONE fleet worktree, uncommitted, on
disjoint test files. Nothing is committed until the code judge approves.
```

### `in buildFromRef` (5.0.9 line 6895)

```text
the last worktree state a gate saw (a hasher result); the next writer
round's ownership delta starts from it
```

### `in buildFromRef` (5.0.9 line 6901)

```text
5.0.6 (ledger 2019): a writer's build-dir key (null: the short path's one
writer); parallel writers never share one
```

### `in buildFromRef` (5.0.9 line 6907)

```text
One writer round, then the ownership check: HEAD did not move, every
changed path (tree delta from the round start, plus any hasher-map key)
is a test file of a criterion pending this round and was reported in its
writer's `files`, and no writer reports another criterion's file.
```

### `in buildFromRef` (5.0.9 line 6913)

```text
5.0.6 (ledger 2019): each writer's own build dir, emptied first; every
reset comes before its role's PATH re-check, which stays right before it
```

### `in buildFromRef` (5.0.9 line 6922)

```text
4.0.0 (1991): the short path's one writer for every pending criterion.
The script splits its tests per criterion by the covers prefix "<cid>:";
a prefix that names no pending criterion, or a reported file outside
every pending criterion's test files, stops the run.
```

### `in buildFromRef` (5.0.9 line 6945)

```text
the same order as the full path: the round, then a retry on drift. A
direct call: parallel() would swallow a halt and lose its stop_gate.
```

### `in buildFromRef` (5.0.9 line 7010)

```text
4.0.0 (1984): only a drifting writer retries, after the parallel
round, so a stop in its PATH re-check is not lost in parallel()
```

### `in buildFromRef` (5.0.9 line 7020)

```text
After the writers: the fixers, the ownership hash and the checks.
```

### `in buildFromRef` (5.0.9 line 7023)

```text
the repo's fixers on this round's test files, before the ownership hash,
the test judge and the freeze (3.0.0, ledger 1951)
```

### `in buildFromRef` (5.0.9 line 7049)

```text
5.0.7 (ledger 2020): a changed map is routed by the keys hash_diff.py lists
```

### `in buildFromRef` (5.0.9 line 7066)

```text
pending: [{criterion, findings}] to (re)write this round.
codeFindings: set on a fix_tests re-entry; the judge then runs first.
```

### `in buildFromRef` (5.0.9 line 7075)

```text
(pre-hasher), writers, fixers, post-hasher, hash-diff (5.0.7: the
writers change the files map), judge, post-judge hasher
```

### `in buildFromRef` (5.0.9 line 7082)

```text
writer_outputs: this round's writer results; a judge-first re-entry
round ran no writer, so it gets the latest result per criterion
```

### `in buildFromRef` (5.0.9 line 7094)

```text
every round of a fix_tests re-entry carries the code-judge context
```

### `in buildFromRef` (5.0.9 line 7124)

```text
freeze
```

### `in buildFromRef` (5.0.9 line 7127)

```text
HEAD at the first freeze: the base every diff of this build starts from
```

### `in buildFromRef` (5.0.9 line 7130)

```text
refreeze: {round, criteria} after an approved fix_tests round. Only the
test files of those criteria may change; any other key -> needs_human.
```

### `in buildFromRef` (5.0.9 line 7133)

```text
5.0.7: purge, hasher and the hash-diff of the changed test files
```

### `in buildFromRef` (5.0.9 line 7155)

```text
5.0.7: no hash value; the kind of change only
```

### `in buildFromRef` (5.0.9 line 7172)

```text
4.0.0 (1987): the freeze tree under refs/fleet/<task>/freeze (no commit)
```

### `in buildFromRef` (5.0.9 line 7175)

```text
the script's own write: the next comparison starts from the new value
```

### `in buildFromRef` (5.0.9 line 7186)

```text
4.0.0 (1987): the tests were approved and frozen in an earlier run
```

### `in buildFromRef` (5.0.9 line 7205)

```text
code
```

### `in buildFromRef` (5.0.9 line 7210)

```text
release review of #48: the code judge's prior_findings. A judge, review,
obligations or hook finding replaces it; a drift or hash rejection (no
judge ran) appends its message to the findings still pending.
```

### `in buildFromRef` (5.0.9 line 7214)

```text
the script gate that rejected the last code round, for the cap message
```

### `in buildFromRef` (5.0.9 line 7216)

```text
HEAD the coder must leave alone; it moves only at the commit step
```

### `in buildFromRef` (5.0.9 line 7230)

```text
coder, fixers, purge, hasher, script check, judge, fingerprint, caller check, commit, push
```

### `in buildFromRef` (5.0.9 line 7244)

```text
the role check runs after the hash check: a hash violation is reported
even when the coder's output is also malformed or not ok
```

### `in buildFromRef` (5.0.9 line 7250)

```text
5.0.0 (review of d8df90b): an ok coder whose ONLY problem is role_file
is asked once more for its report, before the post-coder hash (so any
change the retry makes is checked like the first one). Any other
problem keeps its path below.
```

### `in buildFromRef` (5.0.9 line 7269)

```text
the repo's fixers on every non-frozen path the worktree changes, before
the hash check and the judge (3.0.0, ledger 1951); a hook that touches
a frozen file or another path stops the run
```

### `in buildFromRef` (5.0.9 line 7273)

```text
5.0.7: the frozen paths are the keys of the frozen files map, on disk
```

### `in buildFromRef` (5.0.9 line 7275)

```text
purge before the check and the judge; the judge's "before" state is the
post-purge hasher state
```

### `in buildFromRef` (5.0.9 line 7278)

```text
changed: every path of this build (tracked and untracked), from the plan commit
```

### `in buildFromRef` (5.0.9 line 7292)

```text
4.0.0 (1984): the coder is never re-run on drift; drift on an ok result
is a fix_code finding for the next round (bounded by MAX_CODE_ROUNDS).
A not-ok status still stops here; so does a result not from the shipped
role file (5.0.0, R1: a contract stop, never a finding)
```

### `in buildFromRef` (5.0.9 line 7297)

```text
review item 6: a not-ok coder that names no role file stops at "role"
```

### `in buildFromRef` (5.0.9 line 7338)

```text
re-check check_cmd scripts in the tree the judge sees; a failure is
judge-only for this round. The check is read-only: the judge's
fingerprint (taken at the post-coder hash) catches any change.
```

### `in buildFromRef` (5.0.9 line 7352)

```text
5.0.0 (R3): the findings still pending for this judge ([] in round 1)
```

### `in buildFromRef` (5.0.9 line 7375)

```text
the script's own plan-ref write: the frozen snapshot follows it
```

### `in buildFromRef` (5.0.9 line 7397)

```text
a fix_tests verdict may also carry code findings: keep them
```

### `in buildFromRef` (5.0.9 line 7403)

```text
the hook surface and the recipe paths of make check_cmds (3.1.0), read once per approve
```

### `in buildFromRef` (5.0.9 line 7418)

```text
Max's rule (3.1.0): the approved diff never touches the hook surface
```

### `in buildFromRef` (5.0.9 line 7421)

```text
the build-time caller check, on every tree before it is committed
```

### `in buildFromRef` (5.0.9 line 7439)

```text
the commit step: the first commit of this build, with the repo's hooks
```

### `in buildFromRef` (5.0.9 line 7451)

```text
the hooks path frozen at freeze (null: git's default hooks dir)
```

### `in buildFromRef` (5.0.9 line 7453)

```text
5.0.6 (ledger 2019): the build vars of this commit's own dir (and the DSN)
```

### `in buildFromRef` (5.0.9 line 7494)

```text
push, PR, review, write-back; a hook or review finding returns to the coder
```

### `before reviewStep` (5.0.9 line 7513)

```text
The independent review (pr-review, and the non-weakening sweep for gate
changes), each fingerprinted on the fleet worktree. Probes run in detached
worktrees under scratch_dir; the cleanup step always runs, even when the
review stops the run. Returns {verdict, blocking, nits, sweep, model}.
```

### `in reviewStep` (5.0.9 line 7518)

```text
5.0.8 (ledger 2030): pr-review reads the PR with the checked gh command
```

### `in reviewStep` (5.0.9 line 7521)

```text
paths, pre-hasher, review, post-hasher, sweep, post-hasher, cleanup
```

### `in reviewStep` (5.0.9 line 7551)

```text
4.0.0 (1981): the review runs repo tests against its own database;
5.0.6 (ledger 2019): the review and the sweep each get their own build
dir (test_env and its prefix), with or without a database
```

### `in reviewStep` (5.0.9 line 7557)

```text
3.1.2: the review and the sweep run repo tests
```

### `in reviewStep` (5.0.9 line 7560)

```text
5.0.0 (R3): pr-review only (the sweep keeps the shared inputs)
```

### `in reviewStep` (5.0.9 line 7589)

```text
release review of #48 (fail closed; a gap since 4.0.3): an unmeasured
unit (a null or missing verdict on either side) never proves non_weakening
```

### `before replan` (5.0.9 line 7629)

```text
plan_wrong: re-plan from the approved plan in a detached worktree, commit
the new plan there, save the old head, then move the branch to the new plan.
```

### `in replan` (5.0.9 line 7640)

```text
worktree, planner, audit, commit, reset: reserve all before any step
```

### `in replan` (5.0.9 line 7667)

```text
a plan_wrong re-plan always ends at awaiting_confirmation: no extra rounds
```

### `in replan` (5.0.9 line 7677)

```text
the re-plan worktree sits at the approved plan commit (plan-only)
```

### `before writeBodies` (5.0.9 line 7723)

```text
A yadgar ledger task with no body page (3.1.0, ledger 1958). The title
comes from the judge read writeBack makes first (infra:ledger-read:pre);
the narrow writer re-reads the task and writes nothing when its title
differs, creates the page at the slug this script computes,
{project with / as _}_task-<id>, and links it with task_write (which writes
the title on every call, so the title read goes back unchanged); then a
judge reads the task again: the title must be unchanged, body_slug the
computed slug and the page must carry the marker. The title check works at
the relay level only: task_write cannot leave the title out. Returns
{key: {status, reason}} for every task given.
```

### `in writeBodies` (5.0.9 line 7769)

```text
5.0.0 (R3): the step found no write tool: nothing written, not a failure
```

### `in writeBodies` (5.0.9 line 7783)

```text
the page at the slug must be this project's page of this task (a_b/c and a/b_c share a slug)
```

### `before ledgerRead` (5.0.9 line 7792)

```text
A read-only judge read of yadgar ledger tasks: title, body_slug, marker.
```

### `before writeBack` (5.0.9 line 7801)

```text
Never stops the run: every failure is reported in the result.
```

### `in writeBack` (5.0.9 line 7806)

```text
5.0.0 (R2): the adapter picks the path; the census never skips a ledger
step (review of 88eb9b0). A read step that finds no tool reports
unavailable: nothing written, the section handed back.
```

### `in writeBack` (5.0.9 line 7810)

```text
5.0.9: a yaadgaar entry unavailable for want of the session proof (the tool is there)
```

### `in writeBack` (5.0.9 line 7821)

```text
(a) ledger. 3.1.0: a judge reads every task first; a task with a body
page goes to the append step, one without to writeBodies.
```

### `in writeBack` (5.0.9 line 7829)

```text
a yadgarhq/ project never writes the yadgar ledger (failed, as before 5.0.0; intake refuses that source first)
```

### `in writeBack` (5.0.9 line 7863)

```text
a no_body here means the body page went away between the reads: never written
```

### `in writeBack` (5.0.9 line 7878)

```text
yaadgaar tasks (3.0.0, ledger 1928): an agent step with the
mcp__yaadgaar__ tools; never the yadgar ledger (its L<N> is another,
frozen task). A failed entry hands section_text back.
```

### `in writeBack` (5.0.9 line 7887)

```text
3.1.3 (ledger 1979): args.project is the ledger scope; no project writes nothing
```

### `in writeBack` (5.0.9 line 7892)

```text
read by the sealed id first; the script checks id and number before any edit step runs
```

### `in writeBack` (5.0.9 line 7907)

```text
the answer must be the sealed task: same id, same number
```

### `in writeBack` (5.0.9 line 7912)

```text
5.0.9 (ledger 2032): a named project must be args.project; none: the proven session's
```

### `in writeBack` (5.0.9 line 7929)

```text
the whole body for a task whose body is empty: heading + section
```

### `in writeBack` (5.0.9 line 7954)

```text
5.0.0 (R2): none (no ledger entry), failed, unavailable, else ok
```

### `in writeBack` (5.0.9 line 7957)

```text
every ledger entry unavailable: the steps found no tool; the adapter falls back
```

### `in writeBack` (5.0.9 line 7966)

```text
(b) one marked comment per external source
```

### `in writeBack` (5.0.9 line 7978)

```text
5.0.8 (ledger 2030): the GitHub command per source repo, from the
program the list step runs; a post needs one with push access
```

### `before DB_IMAGES` (5.0.9 line 8031)

```text

A repo opts in with .fleet-test-db.json, read at origin/<default branch>.
One podman container per run, bound to 127.0.0.1, with resource caps and
self-expiry; one database per role; the role gets the DSN in its test_env.
The name is fleet-db-*; every program refuses any other name and any
tf-local name itself (on a host with no podman shim it is the only guard).
```

### `before DB_IMAGES` (5.0.9 line 8038)

```text
Reads and checks .fleet-test-db.json at origin/<default branch>: {decl, error, args}.
program: scripts/test_db_decl.py (PROGRAM_SHA256 holds its sha256)
```

### `before DB_IMAGES` (5.0.9 line 8041)

```text
Removes expired fleet test database containers only: {podman, removed, kept, errors}.
program: scripts/db_sweep.py (PROGRAM_SHA256 holds its sha256)
```

### `before DB_IMAGES` (5.0.9 line 8044)

```text
Starts the run's test database, or adds databases to it, with one user per
database (random passwords; the root password never leaves the container):
{name, port, dbs, users, expiry, args}.
program: scripts/db_up.py (PROGRAM_SHA256 holds its sha256)
```

### `before DB_IMAGES` (5.0.9 line 8049)

```text
Removes the run's test database container: {removed, absent, error, args}.
program: scripts/db_down.py (PROGRAM_SHA256 holds its sha256)
```

### `before DB_IMAGES` (5.0.9 line 8052)

```text
engine:major -> the image, pinned by digest (an index digest, checked with
skopeo inspect --raw | sha256sum on 2026-11-09: mariadb 11.4.13)
```

### `before DB_TTL_SECONDS` (5.0.9 line 8058)

```text
the podman --timeout (or the systemd-run timer): a crashed workflow's container ends
```

### `before testDbDeclProblem` (5.0.9 line 8065)

```text
Why a declaration is refused (null: it is fine). The program checks the same.
```

### `before DB_SYSTEM_SCHEMAS` (5.0.9 line 8076)

```text
5.0.3 (2011): the optional test_db_prefix. db_up grants each role user ALL
on `<prefix, _ escaped>%`.* in the run's container. test_db_decl.py and
db_up.py check the same: not fleet_*, and no system schema it could reach.
```

### `before dbOf` (5.0.9 line 8093)

```text
the database of a consumer (a role, or a writer per criterion)
```

### `before dbDsn` (5.0.9 line 8097)

```text
a consumer's DSN: its own user, granted on its own database only (never root)
```

### `before dbUsersOk` (5.0.9 line 8103)

```text
the relayed users: exactly one per database, each a 32-hex password
```

### `before testEnvFor` (5.0.9 line 8109)

```text
test_env for one consumer: TEST_ENV, plus the DSN of its own database when
the run has a test database. Never the shared object (one DSN per role).
5.0.6 (ledger 2019): with `key`, the build vars of that role's own dir too
```

### `before dbInputs` (5.0.9 line 8123)

```text
for roles that get test_env only when the run has a test database
```

### `before hookEnv` (5.0.9 line 8127)

```text
the env the repo's hooks get in the commit step and the push: the build
vars of `key` (5.0.6; never PYTEST_ADDOPTS, see 5.0.4) and the run's DSN
```

### `before testDbStep` (5.0.9 line 8172)

```text
The declaration relay of a read step (`test_db`), then the database:
started on the first call, extended with the missing databases later.
consumers: the roles (and writers) that get a DSN in this mode.
```

### `in testDbStep` (5.0.9 line 8188)

```text
5.0.3 (2011): db_up's optional last argument; none -> the 5.0.2 command
```

### `in testDbStep` (5.0.9 line 8214)

```text
the passwords are random, made by the program: one user per database; the
root password never leaves the container (it is in no prompt and no DSN)
```

### `in testDbStep` (5.0.9 line 8218)

```text
from here main's finally removes the container, even when a relay check below stops the run
```

### `before dbTeardown` (5.0.9 line 8240)

```text
main's finally: remove the run's test database. Outside the agent cap;
never throws (a stop here would replace the run's own result).
```

### `before probeMode` (5.0.9 line 8261)

```text
5.0.0 (R1): preflight only, on a given repo: the scripts and roles
directories, the hash of every program and role file, and the PATH check.
Returns the table and stops; no worktree, no role agent, no write.
```

### `in probeMode` (5.0.9 line 8268)

```text
review item 3: the role read path on the real runtime, once, on haiku
```

### `in probeMode` (5.0.9 line 8273)

```text
PR #48 (ruling 3): and its shared file, checked like a role's shared_file
```

### `in main` (5.0.9 line 8296)

```text
4.0.0 (1990, S3); 5.0.0 (R1): accepted, a no-op (every build checks the role files)
```

### `in main` (5.0.9 line 8307)

```text
4.0.0 (1987): the caller-held digest of a freeze, for a frozen resume
```

### `in main` (5.0.9 line 8310)

```text
4.0.0 (1981): the run's test database goes, whatever the result
```

### `in main` (5.0.9 line 8314)

```text
5.0.6 (ledger 2019): the per-role build dirs (only when one was reset)
```
