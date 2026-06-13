# Changelog

## v1.6.0 — Full-quality single run by default

- **[change]** New default: a single `/update-ledger <workspace>` run now produces full-prose,
  fully-enriched rollups and regenerated summaries — no follow-up `enrich` or `regen-summaries`
  needed. Promotes the existing §9.5 `--prose` haiku logic to the default sync path.
- **[new]** `enrichment.auto_prose` config knob (default `true`). Each sync runs the §9.1
  heuristic suggester per entity to infer complexity/impact/challenges non-interactively, feeds
  them into the §7.1 composer for full prose, and writes `enrichment_pending: false`. Set
  `false` to restore the old deferred behaviour (skeleton + `enrichment_pending: true`, fill
  later via `enrich --prose`).
- **[new]** `summaries.auto_regen` config knob (default `true`). Summaries regenerate after
  every run including backfill. Set `false` to defer summary regen on huge historical backfills.
- **[change]** Entity-count gate fixed (§1.5): runs with > 20 entities no longer silently drop
  to a python-skeleton rollup (the prior "poor quality" path). High counts now batch into
  haiku-per-chunk agents that still emit full prose per entity. Skeleton is opt-in only via
  `auto_prose: false`.
- **[change]** Backfill now produces full prose and regenerates summaries by default, matching
  forward sync. The `> 100 entities/month` `AskUserQuestion` is now a model-tier choice
  (haiku vs sonnet per chunk), not a prompt to skip prose.
- **[change]** Enrichment mode precedence documented: `ask_inline: true` (interactive) >
  `auto_prose: true` (non-interactive full prose, default) > both false (deferred skeleton).
- **[docs]** §0 now ships a complete annotated `.ledger/config.yaml` reference (all knobs with
  defaults) instead of the enrichment block alone. Removed the dead `ask_on_sync` alias.
- **[migration]** No action required for full-quality output — it is now automatic. Users who
  preferred fast non-blocking syncs add `enrichment.auto_prose: false` (and optionally
  `summaries.auto_regen: false`) to `.ledger/config.yaml`.

## v1.5.1 — Release sync

- **[chore]** Bump `marketplace.json` version (was stuck at 1.3.0) so the previously merged v1.4.0 (Jira boards, #116) and v1.5.0 (portable skill, #117) actually publish to the marketplace. No functional changes.

## v1.5.0 — Portable skill (no hardcoded paths or orgs)

- **[fix]** Ledger root no longer hardcoded. Skill resolves path via `$LEDGER_HOME` env var at startup (§2 preconditions). Init flow (§11 step 0) asks user for path when `$LEDGER_HOME` is unset, verifies it's an existing git repo, and halts with a clear message if not — never auto-`git init`.
- **[fix]** Jira cloud_id resolution (§4a) no longer contains a hardcoded email-to-domain mapping. Detection is purely runtime: derive domain from current user's email, match against `getAccessibleAtlassianResources` results, prompt user if ambiguous.
- **[fix]** All example org/user names replaced with generic placeholders: `acme__core__456`, `acme__platform__18`, `alice__myproject__7`, `PROJ-1234`. No Quinyx-specific strings remain.
- **[fix]** SQLite example (§12) and git commit example (§14) use `$LEDGER_HOME` instead of hardcoded path.
- **[migration]** Existing users: set `export LEDGER_HOME=<your-ledger-path>` in your shell profile (e.g. `export LEDGER_HOME=/home/max/git/ledger`), or run `/update-ledger init <name>` to be prompted.

## v1.4.0 — Jira board pull pass

- **[new]** `sources.jira.boards`: optional list of `{ id, name }` agile boards. Spec §4f
  adds a per-board fetch via `mcp__atlassian__jira_get_board_issues` on top of the
  workspace `jql_filter`. Dedups by issue key against the JQL pass, tags entries
  `board:<name>` for rollup attribution, fails-soft per board, backfill-aware (chunk
  date range appended to board JQL). Use for team/support/epic boards where the user
  isn't necessarily assignee or reporter but still wants the work tracked.
- **[spec]** Init template (§init) gains `boards: []` placeholder under `sources.jira`.

## v1.3.0 — Backfill hardening (addendum 16-25)

- **[spec]** Model picker: codified haiku/sonnet/skeleton decision table; `AskUserQuestion` required at backfill kickoff when N > 100 entities/month — no silent model choice
- **[new]** `enrich --prose`: full prose rewrite of Summary/Why/Complexity/Challenges/Impact for `enrichment_pending: true` rollups; skeleton pass + `enrich --prose` is cheapest path to full-prose (~$5–10 vs $30+ via sonnet-per-chunk)
- **[spec]** Agent output robustness: ship JSON schema or literal example in prompt; parallel agents drift without it; prefer JSONL; merge step uses rollup frontmatter as ground truth, not manifest
- **[spec]** Staging hard rule: backfill agents write rollups ONLY to `/tmp/ledger-stage/`; skill owns live write; prompt must include explicit DO/DON'T — "for safety" dual-writes cause diff drift
- **[spec]** Owning-chunk rule: parallel backfill assigns each entity to `chunk(max(updated_at))`; only that chunk-agent writes the rollup; all chunks write entries for events in their range — no write collision
- **[spec]** Parallel chunked dispatch is the default for backfill ranges > 2 months; `--sequential` to opt out; rationale: gh fetches free in parallel, jira MCP is per-agent bottleneck
- **[spec]** Split rollup commit: > 1000 rollup files → separate commits by entity-type (tickets then prs) to bound pre-commit hook latency; single 2200-file commit pegged hooks for minutes
- **[fix]** SSH agent flakiness: `Permission denied (publickey)` + empty `ssh-add -l` → print actionable hint (`ssh-add ~/.ssh/<key>`), abort; only treat as real auth failure when agent has keys loaded
- **[spec]** Entries-per-entity ratio: final report includes `R rollups, E entries (E/R events/entity)` per chunk; flag ratio > 5 as anomaly
- **[fix]** GitHub auth fallback: inspect `gh auth status` for active vs default account; if default invalid but `GH_TOKEN` account valid, use that explicitly; fail at preconditions with clear message if no valid account

## v1.2.0 — Skill spec overhaul

- **[new]** `backfill` subcommand spec: chunked historical fill, does not touch forward cursor
- **[new]** `--dry-run` flag: fetch + count without writing
- **[fix]** GitHub: removed invalid `gh search prs --json` fields (`reviewDecision`, `mergedAt`, `additions`, `deletions`, `changedFiles`); added follow-up `gh pr view` for per-PR detail
- **[fix]** GitHub: pagination detection — detect result count == limit, recommend `gh api` for large sets
- **[fix]** Jira: removed non-existent `cloudId` parameter from `mcp__atlassian__jira_search` call
- **[fix]** Jira: description truncation to 400 chars before agent context
- **[fix]** Pre-commit hook: first-commit retry vs subsequent-commit amend distinction
- **[fix]** Dedup: explicit that all source PR lists merge and dedup by URL before entry generation; origin tagged as authored/reviewed/both
- **[spec]** Agent batching: threshold rule — N>20 entities → batch ~50 per agent; defer prose to `enrich`
- **[spec]** Slug computation: skill-side only; agent returns title only
- **[spec]** MCP disconnect handling: per-fetch catch, partial-sync warning, continue on source failure
- **[spec]** Summary regen: backfill suppresses auto-regen, prints notice to run `regen-summaries`
- **[spec]** All fetch outputs go to disk (`/tmp/ledger-sync/`); skill operates on paths not inline strings
- **[spec]** SQLite verifier: post-sync count check with stale-index warning
- **[spec]** Cursor schema versioning: per-workspace `schema_version` field

## [1.1.0] - 2026-05-17

### Added

- Codeberg / Forgejo support as a third source alongside Jira and GitHub. Pulls authored
  and reviewed PRs per workspace via the Forgejo REST API (`/repos/issues/search` with
  boolean `created=true` / `reviewed=true` filters, scoped to the PAT owner).
- New `sources.codeberg` block in `workspace.yaml` with `enabled`, `host` (default
  `codeberg.org`), `user`, `token_env` (default `CODEBERG_TOKEN`), `include_authored`,
  `include_reviewed`.
- New cursor field `codeberg_updated_after` in `.ledger/last_sync.json`.
- New entity id namespace: `codeberg__<owner>__<repo>__<n>` for PRs and
  `codeberg__<owner>__<repo>` for solo repo rollups (no collision with GitHub ids).
- Self-hosted Forgejo/Gitea hosts supported via `forgejo-<short-host>__...` id prefix.
- `init <name>` flow now prompts for Codeberg/Forgejo configuration after GitHub.

### Security

- PAT read only from env var. Skill never echoes, logs, commits, or forwards the token
  value to subagents. `workspace.yaml` stores only the env var name.

### Known limitations

- The `created` / `reviewed` filters on `/repos/issues/search` are scoped to the
  authenticated user (the PAT owner). `sources.codeberg.user` must equal the token
  owner — pulling PRs for a different user requires their PAT.
- GitLab / Bitbucket / self-hosted Jira still not supported.

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
