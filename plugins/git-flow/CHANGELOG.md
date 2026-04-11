# Changelog

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
