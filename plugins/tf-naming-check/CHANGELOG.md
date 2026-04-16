# Changelog

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
