# Changelog

## [1.1.2] - 2026-10-31

### Changed

- `repository` URL now points to https://github.com/m-agahi/ccpm (repo moved from Codeberg).

## [1.1.1] - 2026-05-16

### Fixed

- Prettier formatting

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
