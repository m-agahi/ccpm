# Command allowlist: `test_cmd`, `test_args` and `check_cmd`

The workflow script checks every `test_cmd`, every criterion's `test_args` and every `check_cmd` against these rules, at plan time and again at build time. A command that breaks a rule stops the plan with `needs_human` and costs a re-plan. This file states the rules the script enforces. The examples at the end are run through the script's own validators by the plugin's tests.

The repo's real test command may need something outside these rules. Then pick the closest allowed form and record the gap in the plan's notes and risks. Never emit a denied form, even with the gap recorded.

## `test_cmd`

`test_cmd` is `{command, paths_placeholder, env, tools}`. `paths_placeholder` is `"<paths>"`.

### Characters and tokens

- `command` uses only letters, digits, `_ . / : = < > " ( ) -` and plain spaces (0x20). No tab, newline or other separator.
- The script splits `command` on plain spaces. Every token except `<paths>` uses only letters, digits and `_ . / : = -`.
- Double quotes are allowed only around the expression right after `-k` or `-m` (see pytest below).
- No token contains `://` (a URL). No token is `install`, `add` or `pip`.
- `command` never contains `terraform`, `tofu`, `tfp`, `tflint`, `terragrunt`, `digger` or `atlantis`, in any letter case, also not inside a longer word.

### Runner

`command` starts with exactly one of these runners:

- `pytest`;
- `python -m pytest` or `python3 -m pytest`;
- `uv run`, then any number of `--frozen`, `--no-sync` and `--extra <name>` in any order (each may repeat; `<name>` does not start with `-`), then `pytest`;
- `npm test`, `npm run test` or `npm run test:<name>`;
- `npx jest` or `npx vitest`;
- `pnpm test` or `yarn test`;
- `cargo test`, `go test` or `make test` (the target named exactly `test`).

### Arguments after the runner

Every argument is denied unless this list allows it for that runner.

- **A path:** the `<paths>` token, or a relative path that starts with a letter, digit or `_` and then holds only letters, digits and `_ . / -`, with no `..` segment. So `./tests`, `@file`, `../x`, `a:b` and `a=b` are denied.
- **pytest:** paths; `-q -v -vv -x -s -ra -rA --no-header -n0`; `-n<N>` (digits only, for example `-n4`); `--maxfail=<N>`, `--durations=<N>`, `--timeout=<N>` (digits only); `--tb=short`, `--tb=line`, `--tb=no`, `--tb=long`; `-p no:<name>`; `-k <word>` and `-m <word>` (a word is letters, digits and `_`); `-k "<words>"` and `-m "<words>"` (words of letters, digits, `_`, `(` and `)`, separated by single spaces). Denied, for example: `-n auto`, `-c`, `-p <plugin>`, `--rootdir`, `-o`, `--confcutdir`.
- **npm test, npm run test, pnpm test, yarn test:** nothing, or `--` followed by paths only.
- **npx jest, npx vitest:** paths, `run`, `--run`, `--silent`, `--passWithNoTests`.
- **cargo test:** never `<paths>` and never a path. Before an optional `--`: `--lib`, `--tests`, `--all-features`, `--workspace`, `-q`, `--test <name>`, `-p <name>`, `--package <name>` (a name is a letter, then letters, digits, `_` or `-`; 64 characters at most). After `--`: test names (`name` or `a::b::c`, of letters, digits and `_`) and `--exact`. Denied, for example: `--manifest-path`, `--config`, `-Z`, `--target-dir`.
- **go test:** never `<paths>`. `-v`, `-race`, `-short`, `-count=<N>`, `-run <word>`, package paths `./...` and `./<path>/...`, and plain relative paths.
- **make test:** no arguments.

### `<paths>`

- For a path-taking runner (pytest, jest, vitest, and npm, pnpm or yarn test with `--`), `command` holds the literal token `<paths>`. A targeted run replaces it with space-separated test file paths. A full-suite run removes it.
- `cargo test`, `go test` and `make test` never hold `<paths>`: `command` is the full-suite form.

### Criterion `test_args`

- Allowed only when `command` is `cargo test` or `go test` and holds no `<paths>`. `make test` is full-suite only and takes no `test_args`.
- The targeted run of that criterion is `command` + one space + `test_args`. That whole command must pass every rule above as one command.

### `env`

- Names: only `DJANGO_SETTINGS_MODULE`, `PYTHONUNBUFFERED`, `TZ`, `LANG`, `LC_ALL`, `NO_COLOR`, `FORCE_COLOR`, `CI`. Leave `env` as `{}` unless the tests truly need one of them.
- Values: letters, digits, spaces and `_ . / : = @ % + , -`, with no forbidden word.
- Never a secret, token, key, password or credential. Never `PYTHONPATH` or `PYTEST_ADDOPTS`.
- The workflow's own `test_env` is applied after `env` and wins on a clash.

### `tools`

- Binaries the repo's commit and push hooks need on PATH. Each is one token of letters, digits and `_ . / : = @ % + , -`.

## `check_cmd`

`check_cmd` is optional and informational. The workflow script never runs it. Max sees it verbatim before the build, and the code judge may run it in a scratch worktree. No such command exists → omit `check_cmd`.

- The script splits it on spaces and tabs. Every token uses only letters, digits and `_ . / : = @ % + , -`: no quote, no shell metacharacter (`; & | $ ( ) < >` or a backquote), no glob, one line.
- It never contains a forbidden word (the list under `test_cmd`).
- It is exactly one of these shapes:
  - `pre-commit run <hook-id>`, then, each at most once and in any order: `--all-files`, `--hook-stage <stage>`, `--from-ref <ref> --to-ref <ref>`;
  - `make <target>` and nothing else (a target starts with a letter, digit or `_`, then letters, digits and `_ . -`);
  - `python <script>.py [args]` or `python3 <script>.py [args]`, optionally after `uv run` or `uv run --extra <name>` (one `--extra` at most; no `--frozen` or `--no-sync`);
  - `<script> [args]`, where `<script>` holds a `/`.
- The script path: relative (a leading `./` is dropped), no empty, `.` or `..` segment. Its first segment is `scripts`, `bin`, `tools`, `hack` or `ci`. No segment is `.venv`, `venv`, `node_modules`, `.git`, `__pycache__` or `.tox`, in any letter case. Its file name is not an interpreter or package manager (`python*`, `pip*`, `node`, `npm`, `npx`, `sh`, `bash`, `zsh`, `uv`, `make`). Its extension is `.py`, `.sh`, `.bash` or none; the `python` shape needs `.py`.
- At build time the script must also be a tracked regular file (not a symlink) whose real path stays under that first segment.
- With confirm `auto` or `default`, the command gate accepts only `pre-commit run <hook-id> [--all-files] [--hook-stage <stage>]`. Any other `check_cmd` makes the run ask Max.
- Prefer the repo's own checker. A `check_cmd` that can change the worktree, push, write to a network service, or run a forbidden tool is a plan defect even when its shape passes.

## Examples

Each line is `allow` or `deny`, the kind, a colon and the command, exactly as the script sees it.

```text
allow test_cmd: pytest <paths> -q
allow test_cmd: python3 -m pytest <paths> -n4 --tb=short --maxfail=1
allow test_cmd: uv run --extra test pytest <paths> -n0
allow test_cmd: uv run --frozen --extra test --extra dev --no-sync pytest <paths> -n0
allow test_cmd: pytest <paths> -k "rotate and not (slow or flaky)" -p no:cacheprovider
allow test_cmd: npm test -- <paths>
allow test_cmd: npm run test:unit -- <paths>
allow test_cmd: npx vitest run <paths>
allow test_cmd: npx jest --silent <paths>
allow test_cmd: cargo test --all-features
allow test_cmd: cargo test --all-features --test token_store -- rotate::expired --exact
allow test_cmd: cargo test -p iam-db --test migrations
allow test_cmd: go test ./...
allow test_cmd: go test -run TestRotate ./store/...
allow test_cmd: make test
deny test_cmd: pytest <paths> -n auto
deny test_cmd: pytest <paths> -c pytest.ini
deny test_cmd: pytest <paths> -p xdist
deny test_cmd: pytest <paths> --tb=auto
deny test_cmd: pytest ./tests
deny test_cmd: pytest ../tests
deny test_cmd: uv run --extra pytest
deny test_cmd: uv pip install pytest
deny test_cmd: cargo test <paths>
deny test_cmd: cargo test --manifest-path x/Cargo.toml
deny test_cmd: go test <paths>
deny test_cmd: make test V=1
deny test_cmd: make check
deny test_cmd: npm test <paths>
deny test_cmd: bash -c pytest
deny test_cmd: tfplan-check <paths>
allow check_cmd: pre-commit run ruff --all-files
allow check_cmd: pre-commit run check-versions --hook-stage pre-push
allow check_cmd: pre-commit run mypy --from-ref origin/master --to-ref HEAD
allow check_cmd: make lint
allow check_cmd: uv run --extra dev python scripts/check_version_bump.py
allow check_cmd: python3 ./scripts/check.py --strict
allow check_cmd: scripts/check-docs.sh
deny check_cmd: pre-commit run --all-files
deny check_cmd: pre-commit run ruff --all-files --all-files
deny check_cmd: make lint V=1
deny check_cmd: uv run --frozen python scripts/x.py
deny check_cmd: python3 src/x.py
deny check_cmd: scripts/.venv/bin/x.py
deny check_cmd: bash scripts/x.sh
deny check_cmd: scripts/x.sh; rm -rf .
deny check_cmd: scripts/terraform-check.sh
```
