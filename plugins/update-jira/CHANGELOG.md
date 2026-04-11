# Changelog

## [1.1.0] - 2026-04-11

### Added

- Global config lookup at `~/.config/claude/update-jira-config.md` — shared across all
  projects, suitable for Nix/dotfile management or manual placement
- Project memory config still takes precedence (per-project overrides still work)
- On first-run setup, config is now saved globally so it works across all projects
  without repeating setup

## [1.0.0] - 2026-03-28

### Added

- Initial release
- Targeted mode: update a specific Jira ticket from session context and git state
- Scan mode: batch-scan active tickets and recent PRs, correlate, and update
- PR title/body auto-fix with ticket number prefix and Jira link
- Configurable via memory file: Jira project, GitHub org, repos, email, base URL
- Epic-aware: resolves child issues when PR matches an epic
