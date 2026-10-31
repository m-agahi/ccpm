# Changelog

## [1.1.1] - 2026-10-31

### Changed

- `repository` URL now points to https://github.com/m-agahi/ccpm (repo moved from Codeberg).

## [1.1.0] - 2026-04-17

### Added

- Block structure checks for `resource`, `module`, and `data` blocks:
  - Meta-arguments (`count`, `for_each`, `provider`, `providers`, `source`) must appear at the top of the block (ERROR)
  - Exactly one blank line required after the last meta-argument (WARNING)
  - All argument keys within a block must be sorted alphabetically (ERROR)
  - Map literal keys must be sorted alphabetically (WARNING)
  - List literal string elements must be sorted alphabetically (WARNING)
  - All checks apply recursively to nested blocks

## [1.0.1] - 2026-04-16

### Changed

- Scan root defaults to current working directory (`pwd`) instead of git project root
- `$ARGUMENTS` now sets the scan root path rather than acting as a path-prefix filter

## [1.0.0] - 2026-04-16

### Added

- Initial release
- Config-file-driven rulebook — team editable, ships with opinionated defaults based on HashiCorp style guide
- Project-level config override: `<project-root>/tf-naming-config.md` takes precedence over installed default
- Haiku agent for analysis — lightweight pattern matching, no heavy reasoning required
- Scans all `**/*.tf` files, skipping `.terraform/`, `vendor/`, `.terragrunt-cache/`
- Optional path-prefix scoping via `$ARGUMENTS`
- Three-tier severity reporting: ERROR (wrong format), WARNING (anti-pattern), INFO (suggestion)
- Default rulebook covers: resources, variables, outputs, locals, modules, data sources, tags
- Tag rule enforcement: required keys (`Name`, `Environment`, `ManagedBy`), Title case keys, lowercase values
- AWS subnet and security group Name tag pattern enforcement (`<env|vpc>-<func>.<az>`, `<env|vpc>:<func>`)
- Region-dash exception: identifiers like `vpc_eu-central-1` correctly allowed
