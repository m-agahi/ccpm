# Changelog

## [1.2.3] - 2026-10-31

### Changed

- `repository` URL now points to https://github.com/m-agahi/ccpm (repo moved from Codeberg).

## [1.2.2] - 2026-04-11

### Fixed

- Added missing `.claude-plugin/plugin.json` manifest

## [1.2.1] - 2026-04-11

### Fixed

- Replaced company-specific space names (PP, APIM) in the config example with generic
  placeholders (ENG, PROD) — skill is now fully company-agnostic

## [1.2.0] - 2026-04-11

### Added

- Config file system — all hardcoded IDs removed from the skill body
- Config lookup order: project memory `confluence-rfc-config.md` first, then
  `~/.config/claude/confluence-rfc-config.md` (global, Nix/dotfile-manageable)
- First-run setup wizard: prompts for base URL, template page ID, spaces (key, name,
  description, RFC root ID, year folder IDs), and optional Jira project prefix; saves
  to global config automatically
- `year_folders` in config is a `YEAR=PAGE_ID` map — new years are discovered at runtime
  and written back to config to avoid repeated Confluence API calls
- `reconfigure confluence-rfc` command to re-run setup
- Space `description` field drives auto-suggest logic instead of hardcoded keywords

### Changed

- All page IDs, space keys, and base URL are now read from config — skill is fully
  company-agnostic
- Jira ticket pre-fill now skipped gracefully when no `{JIRA_PREFIX}` is configured

## [1.1.0] - 2026-04-11

### Changed

- Fixed MCP tool names throughout — now use the full qualified prefix
  (`mcp__plugin_claude-code-home-manager_atlassian__confluence_*` and `jira_*`)
  instead of short names that don't match the actual tool registry
- Reordered workflow: content preparation (Step 4) now happens before page creation
  (Step 7), fixing a sequencing bug where pages would be created with placeholder text
- Added explicit user confirmation gate (Step 6) before page creation — previously
  only documented in Rules, not enforced in the workflow steps
- Removed `comment` from Jira `fields` parameter (not a valid field name); comments
  are already returned via the separate `comment_limit` parameter
- Added duplicate detection (Step 5) via `confluence_search` before creating
- Added label application after page creation (Step 8) for discoverability
- Added year folder discovery for years beyond 2026 — uses `get_page_children` to
  find or create the current year folder dynamically
- Added error handling guidance for template fetch failure and page creation errors
- Added MCP tool name section to document the prefix and how to adapt for other setups
- Added Configuration table documenting hardcoded IDs and how to override them
- Expanded trigger description to cover more phrasing variants
- Clarified placeholder identification — only replace unambiguously bracketed text

## [1.0.0] - 2026-04-11

### Added

- Initial release
- Create RFC pages in Confluence following the team's established template
- Supports Product - Platform (PP) and API Management Group (APIM) spaces
- Jira ticket integration — pre-fill RFC from ticket context if referenced
- Auto-detects space from topic (infra/platform → PP, API → APIM)
- Pre-fills Background and Solution sections from conversation context
- Storage-format HTML output to preserve Confluence macros (TOC, status tags, time)
- Places pages under the current year folder automatically
