# Changelog

## [1.1.0] - 2026-10-31

### Changed

- PR creation and merged-branch checks are forge-aware: the skill detects host, owner and repo from the `origin` remote. GitHub uses `gh`; Forgejo/Gitea/Codeberg use the REST API.
- PR template lookup covers `.github/`, `.gitea/`, `.forgejo/`, repo root and `docs/`, plus the GitHub org `.github` fallback.
- Removed hard-coded Codeberg owner/repo and 1Password reference. Forgejo tokens come from the user's env var or a user-supplied `op` reference.
- Snippets assign `TOKEN` from `CODEBERG_TOKEN`/`FORGEJO_TOKEN` and pass `--repo` to `gh` so SSH-alias remotes work.
- `repository` URL now points to https://github.com/m-agahi/ccpm.

## [1.0.3] - 2026-05-16

### Fixed

- CI build stability improvements

## [1.0.2] - 2026-05-16

### Fixed

- Prettier formatting

## [1.0.1] - 2026-04-11

### Fixed

- Replaced `gwta` shell alias references with vanilla `git worktree add` commands — `gwta` is not available to Claude

## [1.0.0] - 2026-04-11

### Added

- Initial release
- Branch context detection — reads current worktree/branch before any git operation
- Safety guards: blocks all write operations when on `master` or a merged branch
- `branch` subcommand — syncs master, creates worktree via `git worktree add`, confirms path
- `commit` subcommand — stages specific files, enforces conventional commit format, handles pre-commit hook failures (re-stage, new commit)
- `push` subcommand — first-push with `-u origin`, subsequent pushes without force
- `pr` subcommand — creates PRs via Codeberg/Forgejo REST API using 1Password PAT, fills `.gitea/pull_request_template.md`, infers issue number from branch name
- `cleanup` subcommand — removes worktree, deletes local and optional remote branch
- `status` subcommand — reports branch, worktree list, staged changes, and safety status
- Merged-branch detection via `git ls-remote` and optional Forgejo API check
- First-run hook setup detection — offers to configure `git-flow-guard` PreToolUse hook
- ccpm-specific rules: version bump reminders, CHANGELOG enforcement, prettier re-stage pattern
