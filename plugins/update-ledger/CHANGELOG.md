# Changelog

## [1.0.0] - 2026-05-17

### Added

- Initial release of `update-ledger` skill.
- Multi-workspace structure: `workspaces/<name>/` with per-workspace `entries/`, `tickets/`,
  `prs/` (or `repos/` for solo), `notes/`, and `summaries/{daily,weekly,monthly,quarterly}/`.
- Cross-workspace rollups at `cross/summaries/{daily,weekly,monthly,quarterly,yearly}/`.
- Subcommands:
  - `/update-ledger` — sync default workspace
  - `/update-ledger <workspace>` — sync named workspace
  - `/update-ledger sync-all` — sync every enabled workspace
  - `/update-ledger init <name>` — bootstrap a new workspace interactively
  - `/update-ledger note [workspace]` — log one manual note (meeting, decision, incident,
    learning, investigation)
  - `/update-ledger note bulk <workspace>` — paste multiple notes, skill splits and formats
  - `/update-ledger enrich [workspace]` — retroactive complexity/impact/challenges enrichment
    in user-controlled chunks; resumable
  - `/update-ledger regen-summaries [workspace] [--period <p>]` — force-regenerate summaries
    after enrichment or template changes
  - `/update-ledger status` — print last_sync state per workspace
- Jira pull via Atlassian MCP (`mcp__atlassian__jira_search`, `jira_get_issue`); cloud_id
  auto-resolved on first run.
- GitHub pull via `gh` CLI; supports both authored and reviewed PRs across an org.
- Per-entity rollups preserve user-edited `## Notes` section verbatim across regenerations.
- Summaries preserve user-edited `## Narrative` and `## Notes` sections.
- Inline enrichment disabled by default; enrichment is decoupled to keep sync fast.
- Heavy per-item work delegated to haiku subagents (entry writing, rollup composition,
  summary aggregation, complexity/impact heuristics) — main-thread context stays small.
- SQLite index at `.ledger/index.sqlite` (gitignored) for fast queries.
- Cursor-based incremental sync via `.ledger/last_sync.json`.
- Auto-commit + push to repo's `master` (configurable via `.ledger/config.yaml`).
- Server-side slug sanitisation (no escape artifacts in filenames).
- Markdown-safe rendering: entity ids backtick-wrapped, titles quote-wrapped to prevent
  underscore-driven bold formatting.

### Known limitations

- Ledger root path is configurable via `.ledger/config.yaml`; first-time setup requires the
  user to create the directory and config manually. A future version will add
  `/update-ledger init-repo` for fully scripted bootstrap.
- Tested against Codeberg and Atlassian Cloud. GitLab / Bitbucket / self-hosted Jira not yet
  supported.
