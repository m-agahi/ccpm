---
name: update-ledger
description: "Maintains a multi-workspace chronological work ledger. Pulls Jira tickets, GitHub PRs, and Codeberg/Forgejo PRs per workspace (company, solo, client), writes immutable entries, regenerates per-entity rollups, and updates daily/weekly/monthly/quarterly summaries plus cross-workspace rollups. Auto-commits and pushes. Triggers on /update-ledger, update ledger, log to ledger, ledger sync, sync ledger. Subcommands include init for bootstrap, sync-all, note and note bulk for manual entries, enrich for retroactive complexity/impact rating, and regen-summaries to refresh after changes."
---

# update-ledger skill

Instructions for future Claude executing this skill. Read all sections before starting.
Caveman tone in prose; exact in queries, schemas, headings, frontmatter keys.

---

## 0. Repo layout reference

```
ledger/
  .ledger/config.yaml           # global config, sync_all_enabled, git settings
  .ledger/last_sync.json        # {workspaces: {<name>: {jira_updated_after, github_updated_after, last_run}}}
  .ledger/index.sqlite          # gitignored; SQLite entity + event index
  workspaces/
    <name>/
      workspace.yaml
      entries/YYYY/MM/DD/<file>.md
      tickets/<KEY>.md
      prs/<org>__<repo>__<n>.md
      repos/<owner>__<repo>.md  # solo workspaces only
      summaries/{daily,weekly,monthly,quarterly}/
  cross/summaries/{daily,weekly,monthly,quarterly,yearly}/
  cross/timeline/
```

Example `.ledger/config.yaml` enrichment block:

```yaml
enrichment:
  ask_inline: false # sync-time enrichment OFF by default (was true)
  ask_on_sync: false # alias
  default_chunk: 5 # for /update-ledger enrich
  default_max: 50 # for /update-ledger enrich
```

Note: `ask_inline: true` previously meant inline-at-sync. New default = `false` so syncs are non-blocking. Enrichment happens via §9.5 subcommand.

---

## 1. Modes / dispatch

Parse `$ARGUMENTS` (what follows the skill trigger word):

| Input                                                                                  | Action                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `` (empty)                                                                             | Sync `default_workspace` from `.ledger/config.yaml`                                                    |
| `sync-all`                                                                             | Sync every workspace where any source is `enabled: true`                                               |
| `init <name>`                                                                          | Bootstrap new workspace (see §11)                                                                      |
| `<workspace-name>`                                                                     | Sync only that workspace                                                                               |
| `status`                                                                               | Print last_sync state per workspace; no fetching                                                       |
| `note`                                                                                 | Interactive: prompt for one manual note in `default_workspace`                                         |
| `note <workspace>`                                                                     | Interactive: prompt for one manual note in named workspace                                             |
| `note bulk <workspace>`                                                                | Interactive: paste multiple notes (one per line or `---` separated), skill splits into N entries       |
| `enrich`                                                                               | Loop pending-enrichment rollups in `default_workspace`, ask in chunks                                  |
| `enrich <workspace>`                                                                   | Same, named workspace                                                                                  |
| `enrich --chunk N`                                                                     | Override chunk size (default 5)                                                                        |
| `enrich --max N`                                                                       | Stop after N items this run (resumable)                                                                |
| `regen-summaries [workspace] [--period <p>]`                                           | Force-regenerate summaries without syncing. Useful after enrich or template changes.                   |
| `backfill [workspace] --from YYYY-MM[-DD] --to YYYY-MM[-DD] [--chunk monthly\|weekly]` | Fill historical gaps; does NOT touch the forward cursor (see §1.6).                                    |
| `--since <date>`                                                                       | Override cursor for this run; don't update cursor unless `--save-cursor` also present                  |
| `--dry-run`                                                                            | Fetch + count only; print estimated files, cursor advance, summary periods — write nothing (see §1.7). |

Flags can combine with workspace name, e.g. `quinyx --since 2026-01-01 --save-cursor`.

---

## 1.5 Agent dispatch architecture

Skill = orchestrator. Heavy per-item work delegates to haiku subagents via the Agent tool
(`subagent_type="general-purpose"`, `model="haiku"`, `run_in_background=true` when parallel).

| Work                                   | Who          | Why                    |
| -------------------------------------- | ------------ | ---------------------- |
| Config + cursor read/write             | Skill (main) | small, stateful        |
| Jira MCP calls                         | Skill (main) | needs MCP perms        |
| `gh` CLI calls                         | Skill (main) | needs auth             |
| Forgejo/Codeberg API calls (curl)      | Skill (main) | needs PAT env var      |
| Inline enrichment AskUserQuestion      | Skill (main) | interactive            |
| Entry file writing (per item)          | Haiku agent  | structured transform   |
| Rollup composition (per entity)        | Haiku agent  | summarisation          |
| Summary regeneration (per period)      | Haiku agent  | aggregation            |
| Heuristic complexity/impact suggestion | Haiku agent  | classification         |
| Challenge-tag extraction from comments | Haiku agent  | NER-style              |
| Git commit + push                      | Skill (main) | sequential, idempotent |
| SQLite index upsert                    | Skill (main) | small batched writes   |

Batch granularity: one agent call per entity for entries+rollup when N ≤ 20 (small payload,
parallelisable). One agent call per summary period (daily/weekly/etc). Launch in parallel via
multiple Agent calls in a single message when independent.

Pass to each agent: the raw jira/gh JSON for that item, the existing rollup file contents
(if any — for `## Notes` preservation), and a strict output spec (markdown). Agent returns
the rendered file content. Skill writes it.

Never give a haiku agent: git access, network access beyond what the skill already fetched,
the full ledger state. Keep payloads small and self-contained.

Threshold rule — if N > 20 entities in a single sync, batch into agents of ~50 each with
python-deterministic body composition. Skip haiku prose generation; defer to
`/update-ledger enrich`. For backfill (where enrich is deferred anyway): skip haiku prose
generation entirely; use batched-deterministic Python body composition.

---

## 1.6 `backfill` subcommand

```
/update-ledger backfill [workspace] --from YYYY-MM[-DD] --to YYYY-MM[-DD] [--chunk monthly|weekly]
```

Fills historical gaps without touching the forward cursor. Use to hydrate periods before
the first sync, or to re-pull a range after cursor corruption.

### Rules

- Walk chunks oldest→newest by default. `--reverse` flag for newest→oldest.
- JQL filter for each chunk: `updated >= "<start>" AND updated < "<end>"` appended to the
  workspace's `jql_filter`.
- GitHub pass for each chunk: `--updated="<start>..<end>"`.
- Codeberg pass for each chunk: `since=<start>&until=<end>` query params.
- Does NOT touch `last_sync.json` cursor. Backfill is for gaps; the forward edge remains
  untouched so the next normal sync picks up correctly.
- Commit + push after each chunk so progress is durable. If interrupted, re-run: already-
  existing entry files are skipped (idempotent per §6 idempotency rule).
- Skip chunks where all entry files already exist (idempotent).
- After backfill completes: do NOT auto-regenerate summaries. Print:
  `Summaries stale for periods <range>. Run /update-ledger regen-summaries <workspace> to refresh.`

---

## 1.7 `--dry-run` flag

Append `--dry-run` to any sync or backfill invocation:

```
/update-ledger <workspace> --dry-run
/update-ledger backfill <workspace> --from 2025-01 --to 2026-01 --dry-run
```

Behaviour:

- Fetch data from all enabled sources for the target period (Jira, GitHub, Codeberg).
- Compute and print: estimated files to write, cursor advance value, summary periods affected.
- Writes nothing — no entry files, no rollups, no cursor update, no git commit.
- Critical for previewing a backfill before committing to it.

---

## 2. Preconditions

1. `cd /home/max/git/ledger`. Abort if directory missing.
2. Read `.ledger/config.yaml`. Abort if absent.
3. For each workspace to sync: read `workspaces/<name>/workspace.yaml`. If missing, skip that workspace and log — do NOT abort entire run.
4. Run `gh auth status`. Capture result. If failure, log — do NOT abort (may be jira-only or codeberg-only workspace).
5. Verify atlassian MCP tools reachable by checking that `mcp__atlassian__jira_search` and `mcp__atlassian__jira_get_issue` are available. If unavailable, log — do NOT abort.
6. For each workspace with `sources.codeberg.enabled: true`: resolve token env var name from `sources.codeberg.token_env` (default `CODEBERG_TOKEN`). If env var unset, log — do NOT abort. Probe API: `curl -fsS -H "Authorization: token $TOKEN" https://<host>/api/v1/user`. If non-200, log — do NOT abort. On 200, compare returned `login` to `sources.codeberg.user`; on mismatch, log warning (the boolean `created`/`reviewed` filters are PAT-scoped, so the configured user must equal the token owner — otherwise results will reflect the token owner, not the configured user).
7. If workspace needs jira but MCP unavailable → skip jira pass for that workspace, log it.
8. If workspace needs codeberg but token unset or probe failed → skip codeberg pass, log it.
9. If all enabled sources fail for a workspace → skip that workspace entirely, log it.
10. **Fetch output directory**: all raw fetch outputs go to `/tmp/ledger-sync/<workspace>_<source>_<period>.json`
    before any processing. Skill operates on disk paths, not inline strings. This prevents
    context blowout on large result sets. Apply to both `gh search` outputs and `jira_search`
    outputs. Clean up temp files after the sync run completes.
11. Catch MCP tool-not-available errors per fetch (not just at startup). On mid-run disconnect:
    log timestamp + which entity/source was being processed; continue with remaining sources.
    Surface a "partial sync" warning at the end so the user knows to re-run for missing data.

---

## 3. Cursor handling

1. Read `.ledger/last_sync.json`.
2. Per workspace, per source, find `<source>_updated_after`.
3. If `--since <date>` flag present: use that date as cursor for this run (override).
4. If cursor is `null` and no `--since` flag: STOP and tell user:

   ```
   No cursor for <workspace>/<source>.
   Run `/update-ledger init <name>` to bootstrap, or pass `--since YYYY-MM-DD --save-cursor` to start.
   ```

5. Use cursor as lower-bound filter: `updated >= <cursor>`.

---

## 4. Jira pull (per workspace, if `sources.jira.enabled: true`)

### 4a. Resolve cloud_id

If `sources.jira.cloud_id` is empty in `workspace.yaml`:

- Call atlassian MCP to list accessible Jira cloud resources.
- Pick the one whose domain matches user's email domain (`64974579+m-agahi@users.noreply.github.com` → `quinyx`).
- If multiple match or none match, ask user to pick.
- Write resolved `cloud_id` back to `workspace.yaml`.

### 4b. Build JQL

```
<jql_filter> AND updated >= "<cursor>" ORDER BY updated ASC
```

If `sources.jira.project_filter` is non-null, append:

```
AND project = <project_filter>
```

### 4c. Paginate

Call `mcp__atlassian__jira_search` with:

- `jql`: built query
- `fields`: `[summary, status, priority, labels, components, issuetype, assignee, reporter, created, updated, resolutiondate, description]`
- Paginate via `nextPageToken` until exhausted.
- Hard cap: 1000 items per run. If more seen, save cursor between batches and continue on next invocation — tell user at end.

Note: `mcp__atlassian__jira_search` does NOT accept a `cloudId` parameter — the server is
preconfigured globally. Do not pass `cloudId` in tool calls. The `cloud_id` field in
`workspace.yaml` is documentation only (used for the resolve step above, not passed to MCP).

### 4d. Fetch comments

For each issue returned: call `mcp__atlassian__jira_get_issue` with:

- `issue_key`: the issue key (e.g. `QUI-1234`)
- `comment_limit`: value from `sources.jira.comment_limit` (default 20)

Skip attachments entirely.

### 4e. Truncate descriptions before passing to agents

Before writing results to `/tmp/ledger-sync/` or passing to agents, trim description field:

```bash
jq '.[].fields.description = (.[].fields.description // "" | .[0:400])' results.json
```

Full description is available at `source_url`. Truncation is essential for backfill — full
descriptions can be 5KB+ per ticket and will blow agent context.

---

## 5. GitHub pull (per workspace, if `sources.github.enabled: true`)

Two passes. Dedup by PR URL across both passes.

### Pass 1 — authored PRs (if `include_authored: true` and `user` set)

Valid `--json` fields for `gh search prs`: `assignees, authorAssociation, body, closedAt,
commentsCount, createdAt, id, isDraft, isLocked, isPullRequest, labels, number, repository,
state, title, updatedAt, url, author`. Fields `reviewDecision`, `mergedAt`, `additions`,
`deletions`, `changedFiles` are NOT valid for `gh search prs --json` (only for `gh pr view`).

With org:

```bash
gh search prs \
  --author=<user> \
  --owner=<org> \
  --updated=">=<cursor>" \
  --limit 1000 \
  --json number,title,url,state,createdAt,updatedAt,closedAt,author,body,labels,repository,commentsCount
```

Without org (solo — `org: null`):

```bash
gh search prs \
  --author=<user> \
  --updated=">=<cursor>" \
  --limit 1000 \
  --json number,title,url,state,createdAt,updatedAt,closedAt,author,body,labels,repository,commentsCount
```

### Pass 2 — reviewed PRs (if `include_reviewed: true`)

```bash
gh search prs \
  --reviewed-by=<user> \
  [--owner=<org>] \
  --updated=">=<cursor>" \
  --limit 1000 \
  --json number,title,url,state,createdAt,updatedAt,closedAt,author,body,labels,repository,commentsCount
```

### Pagination detection

`gh search prs --limit 1000` has an effective cap that may be as low as 100 despite the
`--limit` flag. If the result count equals `--limit`, assume truncation and either:

- Page via `gh api` with `since`/`until` query params for precise date-range control, or
- Warn the user: "Result count hit limit for <workspace> — some PRs may be missing."

Prefer `gh api /search/issues` with `q=` for pagination control on large sets (200+ PRs/month).

### Per PR: fetch detail (mergedAt, additions, deletions, changedFiles)

For any PR where merge/change data is needed, call:

```bash
gh pr view <number> --repo <owner>/<repo> \
  --json mergeCommit,mergedAt,additions,deletions,changedFiles
```

This is the only valid way to get those fields — they are not available in `gh search prs --json`.

### Per PR: fetch review comments (lightweight)

```bash
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  --jq '.[] | {user: .user.login, body: .body, created_at: .created_at}'
```

---

## 5.5 Codeberg / Forgejo pull (per workspace, if `sources.codeberg.enabled: true`)

Codeberg = managed Forgejo instance at `codeberg.org`. Same flow applies to any self-hosted
Forgejo or Gitea host — set `sources.codeberg.host` accordingly. No `gh`-equivalent CLI
is assumed; the skill calls the Forgejo REST API directly via `curl`.

### 5.5.1 Token

Read PAT from env var named by `sources.codeberg.token_env` (default `CODEBERG_TOKEN`).
NEVER echo, log, or commit the token. NEVER pass it to a subagent. Build curl auth header
in the skill only.

```bash
TOKEN="$CODEBERG_TOKEN"        # or whichever env var name
HOST="${codeberg_host:-codeberg.org}"
AUTH=(-H "Authorization: token $TOKEN" -H "Accept: application/json")
```

If token env var unset → skip codeberg for this workspace (already logged per §2.6).

### 5.5.2 Authored PRs (if `include_authored: true`)

`/repos/issues/search` filters are **scoped to the authenticated user** (the PAT owner) —
there is no `created_by=<other-user>` param. The boolean `created=true` filter returns
PRs authored by whoever owns the PAT. Cursor uses `since=<ISO8601>` (RFC3339) which
filters by `updated`.

```bash
PAGE=1
while :; do
  RES=$(curl -fsS "${AUTH[@]}" \
    "https://$HOST/api/v1/repos/issues/search?type=pulls&state=all&created=true&since=$CURSOR&page=$PAGE&limit=50&sort=newest")
  COUNT=$(jq 'length' <<<"$RES")
  [[ "$COUNT" -eq 0 ]] && break
  echo "$RES" >> codeberg_authored.jsonl
  PAGE=$((PAGE+1))
  [[ "$PAGE" -gt 20 ]] && break   # 1000-item hard cap, same as gh pass
done
```

`/repos/issues/search` returns issues; filter client-side to `pull_request != null` if
the server doesn't honour `type=pulls` (older Forgejo). Each result includes
`html_url`, `number`, `title`, `state`, `created_at`, `updated_at`, `closed_at`,
`pull_request.merged_at`, `user.login`, `body`, `labels`, `repository.full_name`.

`sources.codeberg.user` MUST equal the PAT owner. Skill verifies this during §2.6 probe
(`GET /api/v1/user` returns `login` — compare against configured `user`, log mismatch).

### 5.5.3 Reviewed PRs (if `include_reviewed: true`)

Same loop, swap the boolean filter:

```
?type=pulls&state=all&reviewed=true&since=$CURSOR&page=$PAGE&limit=50&sort=newest
```

Like `created=true`, this is scoped to the PAT owner — returns PRs the authenticated
user has reviewed.

### 5.5.4 Per-PR detail + comments

For each PR returned, fetch issue comments and review threads:

```bash
OWNER_REPO="${pr.repository.full_name}"   # e.g. maxagahi/myproj
N="${pr.number}"

curl -fsS "${AUTH[@]}" \
  "https://$HOST/api/v1/repos/$OWNER_REPO/issues/$N/comments?limit=50" \
  > comments_$N.json

curl -fsS "${AUTH[@]}" \
  "https://$HOST/api/v1/repos/$OWNER_REPO/pulls/$N/reviews?limit=50" \
  > reviews_$N.json
```

Also fetch the pull object itself to get `additions`, `deletions`, `changed_files`,
`mergeable`, `merged`:

```bash
curl -fsS "${AUTH[@]}" \
  "https://$HOST/api/v1/repos/$OWNER_REPO/pulls/$N" \
  > pr_$N.json
```

Three-call cost per PR is fine — sync is incremental.

### 5.5.5 Dedup

Dedup authored vs reviewed passes by `html_url`. Then dedup across sources by full id
(see §6) — never collides with GitHub since codeberg ids are prefixed with `codeberg__`.

### 5.5.6 Rate limits

Codeberg returns `429` with `Retry-After`. On 429: sleep that many seconds, retry once.
On second 429: stop codeberg pass for this workspace, log, continue with the rest.

---

## 6. Entry file generation (immutable)

### 6.0 Dedup all source lists BEFORE entry generation

Before spawning any agent or writing any entry file, merge and dedup all PR/issue fetches
into a single list keyed by URL:

- Jira issues: keyed by `self` URL (or `<cloud_id>/<issue_key>`)
- GitHub PRs: keyed by `url`
- Codeberg PRs: keyed by `html_url`

For PRs appearing in both authored and reviewed passes: tag with `origin: both`. Otherwise:
`origin: authored` or `origin: reviewed`. This prevents duplicate entries for PRs the user
both authored and reviewed.

Dedup MUST happen before any agent spawning. Agents receive the merged, deduplicated list.

---

Delegate writing to a haiku agent per entity batch. See §1.5.

Write one file per detected event (created, status-changed, commented, merged, closed, reviewed).

### Path

```
workspaces/<workspace>/entries/YYYY/MM/DD/YYYYMMDD_HHMM_<type>_<id>_<slug>.md
```

- `YYYY/MM/DD` from event timestamp (UTC)
- `<type>`: `ticket` | `pr` | `repo` | `note` | `incident`
- `<id>`:
  - Jira: `QUI-1234`
  - GitHub PR: `quinyx__core__456` (org**repo**number) or `maxagahi__myproject__7` for solo
  - Codeberg/Forgejo PR: `codeberg__maxagahi__myproject__7` (host**owner**repo\*\*number). For self-hosted Forgejo with non-default host: `forgejo-<short-host>__<owner>__<repo>__<n>` — the short-host is the hostname's first label (e.g. `git.example.org` → `git`).
- `<slug>`: derived from title by these rules, applied IN ORDER by the skill (not the agent):
  1. Lowercase ASCII only — transliterate or drop non-ASCII
  2. Replace any of `\\/:*?"<>|` with empty string
  3. Replace any whitespace, `_`, `.`, `,`, `;` with `-`
  4. Strip backslashes and asterisks anywhere (haiku output artifacts)
  5. Collapse runs of `-` into a single `-`
  6. Strip leading/trailing `-` and `_`
  7. Truncate to 40 chars (cut at last `-` boundary if possible)
  8. If empty after sanitisation, use `untitled`

Skill performs this sanitisation AFTER receiving the agent's proposed slug. Never trust agent slug verbatim.

### Frontmatter

```yaml
---
id: <id>
workspace: <name>
type: <type>
event: <event>
status: <current-status>
timestamp: <ISO8601 of event>
source_url: <link>
---
```

### Body

2–5 lines describing event. Don't duplicate full ticket/PR content — that lives in rollup.

### Idempotency

If file with same timestamp + id + event already exists → skip, don't overwrite.

### 6.1 Agent prompt template (entry writer)

For each entity touched in this sync, call:

Agent(
subagent_type="general-purpose",
model="haiku",
description="Write ledger entries for <id>",
run_in_background=true,
prompt=<<<
Write immutable entry markdown files for <type> <id> in workspace <workspace>.

Raw source data (JSON):
<paste jira issue JSON or gh PR JSON + comments>

Events to write (one file per event):
<list of events detected since cursor: opened, status-changed, commented, merged, closed>

For each event, output a fenced block with the destination path and full file content:

## PATH: workspaces/<workspace>/entries/YYYY/MM/DD/YYYYMMDD*HHMM*<type>_<id>_<slug>.md

id: <id>
workspace: <workspace>
type: <type>
event: <event>
status: <current-status>
timestamp: <ISO8601>
source_url: <link>

---

<2-5 line body describing this event. No filler. Reference rollup for full history.>
END

No prose outside the fenced blocks. No markdown headers in the body. Body is plain text.

- Output the entity title as-is in the PATH placeholder — do NOT compute or format a slug.
  The skill derives and sanitises the slug from the title server-side. Including slug format
  rules in agent prompts causes drift; the skill is the single source of truth for slug logic.
  > > > )

Skill parses the agent's response, writes each PATH/content block to disk (idempotent: skip
if file already exists with same timestamp+id+event).

---

## 7. Rollup generation (regenerated each sync)

Delegate composition to a haiku agent per entity. See §1.5 and §7.1.

Write one rollup per touched entity. Regenerate from scratch each run EXCEPT `## Notes` (see §8).

### Paths

| Entity type          | Path                                                           |
| -------------------- | -------------------------------------------------------------- |
| Jira ticket          | `workspaces/<workspace>/tickets/<KEY>.md`                      |
| GitHub PR            | `workspaces/<workspace>/prs/<org>__<repo>__<n>.md`             |
| GitHub repo (solo)   | `workspaces/<workspace>/repos/<owner>__<repo>.md`              |
| Codeberg/Forgejo PR  | `workspaces/<workspace>/prs/codeberg__<owner>__<repo>__<n>.md` |
| Codeberg repo (solo) | `workspaces/<workspace>/repos/codeberg__<owner>__<repo>.md`    |

For self-hosted Forgejo, swap `codeberg` for `forgejo-<short-host>` per §6.

### Frontmatter

```yaml
---
id: <id>
workspace: <name>
type: <type>
title: <title>
status: <current>
opened: <date>
closed: <date|null>
complexity: S|M|L|XL|?
impact: low|med|high|critical|?
challenges: [<tag>, ...]
tags: [<from-labels>, ...]
links:
  source: <url>
  related: [<other-ids>]
last_synced: <ISO8601>
enrichment_pending: <bool>
---
```

### Body sections (exact headings, exact order)

```markdown
## Summary

≤3 sentences from title + description.

## Why it mattered

From ticket description first paragraph or PR body, lightly edited.

## Complexity

Rating (S/M/L/XL) + 1–2 sentences justifying it.

## Challenges

- <bullet>
- <bullet>

## Impact

1 sentence per audience: users / system / team / $.

## Timeline

- <date>: <event> — <1-line description>
  (sorted by timestamp, sourced from entries/ for this id)

## Notes

<preserved from prior version, or empty>
```

### 7.1 Agent prompt template (rollup composer)

For each entity with new events this sync, call ONE haiku agent. Include existing rollup
contents (specifically `## Notes` section) so the agent can preserve it verbatim.

Agent(
subagent_type="general-purpose",
model="haiku",
description="Compose rollup for <id>",
run_in_background=true,
prompt=<<<
Compose the rollup markdown for <type> <id> in workspace <workspace>.

Raw source data:
<paste jira issue JSON + comments OR gh PR JSON + review comments>

Existing rollup file (or "NONE" if first time):
<paste existing file contents>

Inline enrichment values from user (or "PENDING" if user skipped):

- complexity: <S|M|L|XL|PENDING>
- impact: <low|med|high|critical|PENDING>
- challenges: <comma-separated tags or PENDING>

Output exactly this structure — frontmatter then body:

---

id: <id>
workspace: <workspace>
type: <type>
title: <title>
status: <current>
opened: <date>
closed: <date|null>
complexity: <value>
impact: <value>
challenges: [<tags>]
tags: [<from-labels>]
links:
source: <url>
related: [<other-ids>]
last_synced: <ISO8601>
enrichment_pending: <bool>

---

## Summary

<≤3 sentences>

## Why it mattered

<motivation; user-facing or system context>

## Complexity

<rating + 1-2 sentences justifying>

## Challenges

- <bullet per challenge>

## Impact

- Users: <1 sentence>
- System: <1 sentence>
- Team: <1 sentence>

## Timeline

- <YYYY-MM-DD>: <event> — <1-line>
- <YYYY-MM-DD>: <event> — <1-line>

## Notes

<COPY VERBATIM from existing file's ## Notes section. If NONE or empty, leave one blank line.>
END

Rules:

- Preserve ## Notes section verbatim. Never edit or summarise it.
- No prose outside the fenced output.
- Timeline sorted ascending by date.
- If a section has no content, write one line "_(none)_" — never delete the heading.
- Wrap entity ids in backticks. Wrap referenced titles in double quotes.
  > > > )

Skill writes the agent's full response to workspaces/<workspace>/<tickets|prs|repos>/<id>.md.

---

## 8. Manual-notes preservation (CRITICAL)

Before regenerating any rollup:

1. If file exists, read it.
2. Extract everything from `## Notes` heading to end of file (Notes is always last section).
3. After writing all other sections, append:

   ```
   ## Notes

   <extracted content, or empty placeholder>
   ```

4. NEVER overwrite without preserving Notes. Notes is the only mutable part of a rollup.

Same rule applies to summary files: preserve `## Notes`, `## Narrative`, and any other manual sections at the bottom.

---

## 9. Inline enrichment (per workspace setting `enrichment.ask_inline`)

**Default: disabled.** With `enrichment.ask_inline: false` (default), skill writes rollups
with `enrichment_pending: true` and skips the asking flow. User runs `/update-ledger enrich`
later (§9.5) to fill in complexity/impact/challenges in batches.

When `ask_inline: true`: original flow below applies.

### For NEW entities (not seen in prior rollup)

First, call a haiku agent to suggest values. Use those as defaults shown to the user.

Show user one-line summary, then use AskUserQuestion (batch up to 3 per call):

1. **Complexity** (S/M/L/XL)

   - Show heuristic guess:
     - PR: start S; +1 step per 300 LOC; +1 per 5 files changed
     - Ticket: start S; +1 per 10 comments; +1 per 14 days open
   - User can accept or override.

2. **Impact** (low/med/high/critical)

   - Inferred from labels: `priority: critical` → critical; `blocker` → critical; `breaking` → high; default → med
   - User can accept or override.

3. **Challenges** (free text, comma-split → tags)
   - User can type "none" for empty list.

If user skips or aborts enrichment:

- Write placeholders: `?` for complexity/impact, `[]` for challenges
- Set `enrichment_pending: true` in frontmatter

### For UPDATED entities

Don't re-ask unless status transitions to `done` / `closed` / `merged` / `won't-fix`. On those transitions, ask one retrospective:

```
Final impact assessment for <id>? (low/med/high/critical)
```

### 9.1 Agent prompt template (heuristic suggester)

Before asking the user, call one haiku agent per new entity:

Agent(
subagent_type="general-purpose",
model="haiku",
description="Suggest complexity/impact for <id>",
prompt=<<<
Classify this <type> on two dimensions: complexity and impact.

Raw data: <paste JSON>

Complexity scale (S/M/L/XL):

- S: trivial change, well-understood, <100 LOC or <5 comments
- M: standard change, some unknowns, 100-500 LOC or 5-15 comments
- L: significant change, novel work, 500-2000 LOC or 15+ comments or >14 days open
- XL: major undertaking, cross-system, >2000 LOC or >30 days open

Impact scale (low/med/high/critical):

- critical: production outage, security, blocker, breaking change
- high: feature shipped, customer-visible improvement, perf gain ≥20%
- med: internal improvement, refactor with measurable benefit
- low: doc, comment, cleanup, dev-ergonomics

Also extract up to 5 challenge tags (kebab-case, ≤2 words each) from comments/body.

Output JSON only:
{"complexity": "S|M|L|XL", "impact": "low|med|high|critical", "challenges": ["tag1","tag2"], "reasoning": "<1 sentence>"}

> > > )

Show user the suggestion as the default in the AskUserQuestion options. User can accept
or override per the existing flow.

---

## 9.5 `enrich [workspace]` subcommand

Retroactive enrichment for rollups with `enrichment_pending: true`. Decoupled from sync so
forward syncs stay fast and non-interactive.

### 9.5.1 Flow

1. Resolve workspace: arg → `default_workspace` → abort if neither.
2. Find pending rollups. Two methods, prefer first:
   - **SQLite query** (preferred): `SELECT id, type FROM entities WHERE workspace = ? AND (complexity = '?' OR impact = '?')` — or query enrichment_pending column if you've added it.
   - **File scan fallback**: glob `workspaces/<workspace>/{tickets,prs,repos,notes}/*.md`, grep for `enrichment_pending: true` in frontmatter.
3. Count pending. Show user: `<N> rollups pending in <workspace>. Process in chunks of <chunk> (max <max>). Continue?`
4. For each chunk:
   a. For each item in chunk, call haiku heuristic suggester per §9.1 (parallel via single Agent message with multiple calls).
   b. Show user one AskUserQuestion message per item with suggested defaults pre-selected as first option, e.g.:
   - Complexity: [M (suggested), S, L, XL]
   - Impact: [med (suggested), low, high, critical]
   - Challenges: free text (suggested tags shown)
     c. User can pick suggestion or override. "Skip" option also offered — leaves item pending for later.
     d. After chunk: regenerate each touched rollup via §7.1 with new enrichment values. Preserve `## Notes` section verbatim (§8).
     e. Update SQLite index entity rows with new complexity/impact/tags.
     f. If `git.auto_commit: true`: commit after each chunk with msg `ledger: enrich <workspace> <date> (<N> items)`. Push if `auto_push: true`.
5. After all chunks (or `--max` hit):
   a. Print summary: `<N> enriched, <M> still pending, <K> skipped`.
   b. Suggest user run `/update-ledger regen-summaries <workspace>` to refresh summary metrics now that impact/complexity are real.

### 9.5.2 Resumability

The skill is naturally resumable: pending state is the rollup frontmatter itself. Stop anytime
(Ctrl-C, --max, user "skip all"). Next run picks up remaining `enrichment_pending: true`.

### 9.5.3 Order of processing

Process pending items in this priority order:

1. closed/merged items first (impact known)
2. status=in-progress
3. status=open
4. By recency (newest first within each status)

Reason: closed items have full data; user can rate them quickly. Open items may shift before
they're worth enriching.

### 9.5.4 Failure modes specific to enrich

- User aborts mid-chunk → save progress for completed items, leave rest pending.
- Rollup file missing (deleted manually) → log, skip, decrement count.
- Haiku suggester fails for an item → show options without suggestion, keep going.

---

## 10. Summary regeneration

Delegate per-period composition to haiku agents. See §10.1.

After all entries and rollups written, regenerate summaries for each touched date range.

### Backfill: suppress auto-regen

After a `backfill` run: do NOT auto-regenerate summaries. Backfill of 38 months touches 38
monthly summaries, 4 quarterly, 1+ yearly — unbounded and slow. Instead, print:

```
Summaries stale for periods <from>–<to>. Run /update-ledger regen-summaries <workspace> to refresh.
```

After a normal (forward) sync: auto-regenerate as usual.

### Per-workspace summaries

Paths:

- `workspaces/<name>/summaries/daily/YYYY-MM-DD.md`
- `workspaces/<name>/summaries/weekly/YYYY-Www.md`
- `workspaces/<name>/summaries/monthly/YYYY-MM.md`
- `workspaces/<name>/summaries/quarterly/YYYY-Qn.md`

### Cross-workspace summaries (if `cross_summaries.enabled` in config)

Paths:

- `cross/summaries/daily/YYYY-MM-DD.md`
- `cross/summaries/weekly/YYYY-Www.md`
- `cross/summaries/monthly/YYYY-MM.md`
- `cross/summaries/quarterly/YYYY-Qn.md`
- `cross/summaries/yearly/YYYY.md`

### Daily summary format

```markdown
## <YYYY-MM-DD>

### <workspace>

- <id> [<type>] <event> — <1-line> (timestamp)
  (sorted by timestamp)

### <workspace2>

...

## Tag distribution

<top 10 tags with counts>

## Notes

<preserved>
```

### Weekly summary format

```markdown
## Week <YYYY-Www>

### <workspace>

| Complexity | Count |
| ---------- | ----- |
| S          | n     |
| M          | n     |
| L          | n     |
| XL         | n     |

| Impact | Count |
| ------ | ----- |
| low    | n     |

...

**Top 5 by impact:**

- <id>: <title> (<impact>)

**Top 5 tags (themes):**

- <tag>: <count>

### Cross-workspace totals

...

## Notes

<preserved>
```

### Monthly / Quarterly format

Aggregate weekly data. Append at bottom:

```markdown
## Narrative

<empty slot for user retrospective — preserve if exists>

## Notes

<preserved>
```

### Yearly format (cross only)

Aggregate quarterly. Preserve both `## Narrative` and `## Notes`.

### ISO week format

Use `YYYY-Www` (e.g. `2026-W20`) for weekly files.

### Preservation rule

Before regenerating any summary, extract and re-append:

- `## Notes` section (all summaries)
- `## Narrative` section (monthly, quarterly, yearly only)

### 10.1 Agent prompt template (summary composer)

For each touched period (daily/weekly/monthly/quarterly/yearly, per-workspace and cross),
call one haiku agent:

Agent(
subagent_type="general-purpose",
model="haiku",
description="Compose <granularity> summary <period>",
run_in_background=true,
prompt=<<<
Compose the <granularity> summary for <period> in <workspace-or-cross>.

Entity data (touched in this period):
<paste rollup frontmatter for each entity: id, type, status, complexity, impact, challenges, tags, title, closed>

Events in this period (chronological):
<paste entries' frontmatter only — id, type, event, status, timestamp>

Existing summary file (for ## Notes / ## Narrative preservation, or "NONE"):
<paste>

Output the summary in this format:

---

period: <period>
workspace: <name-or-cross>
granularity: <granularity>
generated_at: <ISO8601>

---

## Activity

<For daily: bullet list "- HH:MM `<id>` [<type>] <event> — <1-line>" sorted by time.>
<For weekly+: per-workspace section "### <workspace>" then bullets aggregated.>

## Metrics (weekly+)

- Entities touched: <N>
- New: <N> | Closed/Merged: <N>
- Complexity: S=<n> M=<n> L=<n> XL=<n>
- Impact: low=<n> med=<n> high=<n> critical=<n>

## Top items (weekly+)

- `<id>` [<impact>] "<title>"
- ... (top 5 by impact)

## Themes (weekly+)

- <tag> (<count>)
- ... (top 5)

## Narrative (monthly+ only)

<COPY VERBATIM from existing file. If NONE, leave one blank line for user to fill later.>

## Notes

<COPY VERBATIM from existing file. If NONE, leave one blank line.>
END

Rules:

- Preserve ## Narrative and ## Notes verbatim. Never edit.
- Skip "Metrics" and "Top items" and "Themes" sections for daily granularity — only "Activity".
- Skip "Narrative" for daily and weekly.
- "Cross" summaries: aggregate across all workspaces, label each section by workspace.

Format rules:

- Wrap all entity ids in backticks: `quinyx__meridian__18`, `QRND-1234`. Never bare.
- Wrap all PR/ticket titles in double quotes when included in a line. Never bare.
- This prevents markdown interpretation of underscores in ids/titles.
- Within fenced code blocks, you may omit backticks.
  > > > )

Skill writes agent output to the appropriate summary file.

---

## 10.5 `regen-summaries [workspace] [--period <p>]` subcommand

Force-regenerate summary files without pulling new data. Use after:

- `enrich` populated impact/complexity → metrics need refresh
- Skill template changed → existing summaries have stale formatting
- Manual rollup edits → daily/weekly need to reflect them

### Flow

1. Resolve workspace: arg → all workspaces if `--all` → `default_workspace` otherwise.
2. Resolve periods to regenerate:
   - No `--period`: every period that has any rollup with a date in it
   - `--period daily` / `weekly` / `monthly` / `quarterly` / `yearly`: only that granularity
   - `--period 2026-05`: regenerate only that specific period (monthly here)
3. For each (workspace, granularity, period) tuple:
   - Gather rollups touched in period (from rollups' opened/closed dates and entries' timestamps)
   - Call haiku summary composer per §10.1
   - Preserve `## Notes` and `## Narrative` sections verbatim
   - Write file
4. Also regen `cross/` summaries for same periods.
5. Commit + push per §14.

### Notes

- Idempotent: safe to run repeatedly.
- Does not touch entries/ or rollups/ — read-only on those.
- If a summary file doesn't yet exist for a period that has data, this creates it.

---

## 11. `init <name>` subcommand

Bootstrap new workspace interactively.

### Steps

1. Ask (AskUserQuestion): workspace type → `company` | `solo` | `client`
2. Ask: display_name (free text)
3. Ask: active_from (date, or "today" → substitute today's date, or "skip" → null)
4. Ask: enable Jira?
   - If yes:
     - List available cloud instances via atlassian MCP
     - User picks one (or types raw cloud_id if none match)
     - Ask: JQL filter (default: `(assignee = currentUser() OR reporter = currentUser())`)
     - Ask: project filter (default: null → all projects)
5. Ask: enable GitHub?
   - If yes:
     - Ask: GitHub username (default: `gh api user --jq .login`)
     - Ask: org (or "none" for solo / no org filter)
     - Ask: include authored PRs? (yes/no)
     - Ask: include reviewed PRs? (yes/no)
6. Ask: enable Codeberg / Forgejo? (recommended for solo personal projects)
   - If yes:
     - Ask: host (default `codeberg.org`; user can enter a self-hosted Forgejo/Gitea host)
     - Ask: token env var name (default `CODEBERG_TOKEN`). Skill does NOT read or store the token value — only the env var name.
     - If the env var is set in the current shell: probe `GET https://<host>/api/v1/user` with the token and auto-fill `user` from the returned `login`. Confirm with user.
     - If the env var is unset: ask username manually and warn that probe will run on first sync.
     - Ask: include authored PRs? (yes/no, default yes)
     - Ask: include reviewed PRs? (yes/no, default no)
7. Ask: tags (comma-split free text, or "none")
8. Write `workspaces/<name>/workspace.yaml`:

```yaml
name: <name>
type: <type>
display_name: <display_name>
active_from: <date|null>
active_to: null
tags: [<tags>]
sources:
  jira:
    enabled: <bool>
    cloud_id: "<cloud_id or empty>"
    jql_filter: "<filter>"
    project_filter: <null|key>
    comment_limit: 20
  github:
    enabled: <bool>
    user: "<username>"
    org: <null|org>
    include_authored: <bool>
    include_reviewed: <bool>
  codeberg:
    enabled: <bool>
    host: "codeberg.org"
    user: "<username>"
    token_env: "CODEBERG_TOKEN"
    include_authored: <bool>
    include_reviewed: <bool>
paths:
  entries: entries
  tickets: tickets
  prs: prs
  summaries: summaries
```

For solo workspaces: set `paths.prs: repos` instead of `prs`.

9. Create `.gitkeep` in all subdirs:

   - `workspaces/<name>/entries/`
   - `workspaces/<name>/tickets/` (or `repos/` for solo)
   - `workspaces/<name>/prs/` (company/client)
   - `workspaces/<name>/notes/`
   - `workspaces/<name>/summaries/daily/`
   - `workspaces/<name>/summaries/weekly/`
   - `workspaces/<name>/summaries/monthly/`
   - `workspaces/<name>/summaries/quarterly/`

10. Update `.ledger/last_sync.json` — add entry for new workspace with null cursors:

```json
{
  "schema_version": 2,
  "workspaces": {
    "<name>": {
      "schema_version": 1,
      "jira_updated_after": null,
      "github_updated_after": null,
      "codeberg_updated_after": null,
      "last_run": null
    }
  }
}
```

Preserve all existing workspace entries.

11. Do NOT modify `.ledger/config.yaml` automatically. Print:

```
Workspace '<name>' ready.
To make default: set default_workspace: <name> in .ledger/config.yaml

Run: /update-ledger <name> --since <YYYY-MM-DD> --save-cursor
to backfill from a start date.
```

Do NOT run sync automatically after init.

---

## 11.5 `note [workspace]` and `note bulk [workspace]` subcommands

Manual entry for work not tracked in Jira or GitHub: meetings, decisions, incidents handled,
learning, investigations, ops fixes, conversations that mattered.

### 11.5.1 Single note flow

1. Resolve workspace: arg → else `default_workspace` → else abort.
2. Ensure `workspaces/<workspace>/notes/` exists. If not, create + write `.gitkeep`.
3. Batch-ask via AskUserQuestion (group related questions per message):
   - **Title** (free text, becomes filename slug)
   - **Type**: `note | meeting | decision | incident | learning | investigation`
   - **Date** (default today; allow YYYY-MM-DD or "yesterday")
   - **Complexity**: S | M | L | XL | n/a
   - **Impact**: low | med | high | critical | n/a
4. Free-text prompt for body. Tell user to write up to 4 short sections (Summary, Why it mattered, Challenges, Impact). User can write less; skill keeps headings that have content.
5. Ask: **tags** (comma-split free text, optional)
6. Ask: **challenges** (comma-split free text, optional)
7. Ask: **links** (free text, one per line; optional — Jira/PR/Confluence/Slack URLs for related context)
8. Generate slug from title: kebab-case, ≤40 chars, strip non-alphanumeric.
9. Compose entry file (via haiku agent per §11.5.3 if body needs cleanup, else skill writes directly).
10. Compose rollup file at `workspaces/<workspace>/notes/YYYYMMDD-<slug>.md` (one file per note; no per-entity history because notes are point-in-time).
11. Regenerate affected daily/weekly/monthly/quarterly summaries for the note's date.
12. Update SQLite index: insert one entity (type=note), one event (event=created).
13. Commit + push per §14.

### 11.5.2 Bulk note flow

1. Resolve workspace.
2. Ask user to paste content. Accept two formats:
   - One note per line (short notes)
   - `---` separator between multi-line notes
3. For each note: skill calls one haiku agent (§11.5.3) to extract title + type + body from the raw text. Use today's date for all unless line starts with `[YYYY-MM-DD]`.
4. Single batch-ask for complexity/impact PER note (skill loops, batches up to 5 per AskUserQuestion message). Or: ask once "apply defaults to all? (S, med)" and skip per-note prompts.
5. Generate all entry + rollup files.
6. One commit covering all notes: `ledger: add <N> notes to <workspace> YYYY-MM-DD`.

### 11.5.3 Agent prompt template (note formatter)

Use when bulk-parsing user input, or when single-note body needs structure cleanup.

Agent(
subagent_type="general-purpose",
model="haiku",
description="Format manual note <title>",
prompt=<<<
Format a manual ledger note from user-supplied raw text. Output strict markdown.

Workspace: <workspace>
Date: <YYYY-MM-DD>
Type: <note|meeting|decision|incident|learning|investigation>
Title: <title>
Tags: <comma-list>
Challenges: <comma-list>
Links: <one per line>
Complexity: <S|M|L|XL|n/a>
Impact: <low|med|high|critical|n/a>

Raw user body:
<paste user input>

Output exactly:

---

id: note-<YYYYMMDD>-<slug>
workspace: <workspace>
type: <type>
title: <title>
date: <YYYY-MM-DD>
complexity: <value>
impact: <value>
challenges: [<tags>]
tags: [<tags>]
links:

- <url>
- <url>
  last_synced: <ISO8601-now>
  manual: true

---

## Summary

<≤3 sentences capturing what happened>

## Why it mattered

<motivation; can be 1 sentence; omit "_(none)_" if user gave nothing>

## Details

<the user's body, cleaned of obvious typos but preserved in intent; bullet list if user used bullets>

## Challenges

- <bullet per challenge>
  <if none, write "_(none)_">

## Impact

- <1 sentence per audience that applies; skip audiences user didn't address>

## Notes

<blank line for future manual edits>
END

Rules:

- Preserve user's voice. Don't editorialise. Don't add content the user didn't write.
- If user wrote less than 3 sections, still emit all headings; use "_(none)_" for empty ones.
- Output the title as-is; do NOT format or compute a slug — skill derives slug server-side.
- Frontmatter `manual: true` distinguishes from synced ticket/PR rollups.
  > > > )

### 11.5.4 Entry file for the note

In addition to the rollup at `notes/YYYYMMDD-<slug>.md`, write one immutable entry at:
`workspaces/<workspace>/entries/YYYY/MM/DD/YYYYMMDD_HHMM_note_note-<YYYYMMDD>-<slug>_<slug>.md`

## Frontmatter:

id: note-<YYYYMMDD>-<slug>
workspace: <workspace>
type: note
event: created
status: logged
timestamp: <ISO8601>
source_url: null
manual: true

---

Body: one-line title reference. Full content lives in the rollup.

### 11.5.5 Notes dir for non-solo workspaces

Quinyx (and other `company` workspaces) didn't get a `notes/` dir at scaffold. Skill creates
`workspaces/<workspace>/notes/.gitkeep` lazily on first note. Same for any new workspace
that lacks one.

---

## 12. SQLite index

File: `.ledger/index.sqlite` (must be in `.gitignore`).

### Schema

```sql
CREATE TABLE IF NOT EXISTS entities (
  id TEXT,
  workspace TEXT,
  type TEXT,
  title TEXT,
  status TEXT,
  opened TEXT,
  closed TEXT,
  complexity TEXT,
  impact TEXT,
  tags TEXT,
  last_synced TEXT,
  PRIMARY KEY (workspace, id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT,
  workspace TEXT,
  event TEXT,
  ts TEXT,
  file TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(workspace, status);
```

### Operations

- Upsert entities by `(workspace, id)` on each rollup write.
- Insert events on each new entry file written.
- Use `python3` or `sqlite3` CLI via Bash within the skill.

### Post-sync verifier

After each sync, run:

```sql
SELECT COUNT(*) FROM entities WHERE workspace=? AND last_synced > ?
```

where `?` is the workspace name and the sync start time. Report the count in the final report.
If count = 0, surface a warning:

```
Warning: SQLite index may be stale — no entities updated for <workspace>. Check upsert logic.
```

Example upsert (python):

```python
import sqlite3, json
conn = sqlite3.connect('/home/max/git/ledger/.ledger/index.sqlite')
conn.execute("""
  INSERT INTO entities (id, workspace, type, title, status, opened, closed, complexity, impact, tags, last_synced)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace, id) DO UPDATE SET
    title=excluded.title, status=excluded.status, closed=excluded.closed,
    complexity=excluded.complexity, impact=excluded.impact,
    tags=excluded.tags, last_synced=excluded.last_synced
""", (id, workspace, type_, title, status, opened, closed, complexity, impact, json.dumps(tags), last_synced))
conn.commit()
conn.close()
```

---

## 13. Cursor update

After successful sync of workspace, update `.ledger/last_sync.json`:

```json
{
  "schema_version": 2,
  "workspaces": {
    "<name>": {
      "schema_version": 1,
      "jira_updated_after": "<latest jira updated ts seen, ISO8601>",
      "github_updated_after": "<latest gh updated ts seen, ISO8601>",
      "codeberg_updated_after": "<latest forgejo updated_at seen, ISO8601>",
      "last_run": "<now ISO8601>"
    }
  }
}
```

Schema versioning: the top-level `schema_version: 2` covers the file format. Each workspace
block also carries `schema_version: 1` (introduced v1.2.0). The `codeberg_updated_after`
field was added in v1.1.0. Future cursor fields increment the per-workspace schema_version.

Rules:

- Preserve other workspaces' cursors verbatim.
- If `--since` was used WITHOUT `--save-cursor` → do NOT update cursor.
- If `--since` WITH `--save-cursor` → update cursor to the `--since` date (used as starting point).
- Don't update cursor for source that wasn't synced this run (e.g. jira skipped → don't touch `jira_updated_after`; codeberg skipped → don't touch `codeberg_updated_after`).
- `<latest ts seen>` = max `updated`/`updated_at` field across all items returned from that source.
- Backfill runs MUST NOT update any cursor field.

---

## 14. Commit + push

Read `git` block from `.ledger/config.yaml`.

### If `auto_commit: true`

```bash
cd /home/max/git/ledger
git add -A
git diff --cached --quiet && echo "nothing to commit" && exit 0
git commit -m "<commit_prefix> sync <workspace-or-all> YYYY-MM-DD (<N> entries, <M> entities)"
```

- `<commit_prefix>`: value from `config.yaml` git block (e.g. `ledger:`)
- NEVER add Co-Authored-By trailer
- NEVER use `--no-verify`

If pre-commit hook reformats files on the FIRST commit attempt (i.e. no prior commit exists
to amend): re-stage the reformatted files and retry with a new commit — do NOT amend:

```bash
git add -A
git commit -m "<same message>"
```

If this is a SUBSEQUENT commit in a multi-commit run (e.g. backfill chunked commits) and the
hook reformats: amend is correct since the commit was already created before the hook ran:

```bash
git add -A
git commit --amend --no-edit
```

If pre-commit hook fails for another reason: stop, report error, do NOT use `--no-verify`.

### If `auto_push: true`

```bash
git push origin <branch>
```

If push rejected:

```bash
git pull --rebase origin <branch>
git push origin <branch>
```

If second push fails: stop and report. NEVER force push.

---

## 15. Failure modes

| Failure                            | Action                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atlassian MCP unavailable          | Skip jira pass for affected workspaces, log, continue                                                                                                   |
| `gh` not authed                    | Skip gh pass for affected workspaces, log, continue                                                                                                     |
| Codeberg token env var unset       | Skip codeberg pass for affected workspaces, log, continue                                                                                               |
| Codeberg API 401/403               | Skip codeberg pass, log "token rejected or expired", continue                                                                                           |
| Codeberg API 429 twice in a row    | Skip remainder of codeberg pass for that workspace, log, continue                                                                                       |
| Codeberg host unreachable          | Skip codeberg pass, log connection error, continue                                                                                                      |
| All enabled sources fail for a ws  | Skip workspace entirely, log, continue with others                                                                                                      |
| Cursor null                        | Abort with instructions for `--since ... --save-cursor` or `init`                                                                                       |
| User aborts enrichment             | Write placeholders, `enrichment_pending: true`                                                                                                          |
| Pre-commit hook fails              | Fix root cause; don't `--no-verify`. Report and stop.                                                                                                   |
| Git push rejected                  | Rebase once, retry, then stop. Never force push.                                                                                                        |
| `workspace.yaml` missing           | Skip workspace, log                                                                                                                                     |
| Duplicate entry (same id+ts+event) | Skip (idempotent)                                                                                                                                       |
| MCP disconnect mid-run             | Log timestamp + entity being processed; continue with remaining sources; surface "partial sync" warning at end — user must re-run to fill missing data. |

---

## 16. Final report

After run, print terse per-workspace summary:

```
<workspace>: jira <N> issues (<M> new), gh <N> PRs (<M> new), codeberg <N> PRs (<M> new), entries <N>, rollups <M>, summaries <K>
<workspace>: notes <N> added
```

Omit any source's segment if that source is disabled or skipped for the workspace.

Second line emitted only if manual notes written this run.

Then global:

```
commit <hash>, push <ok|skipped|failed>
cursors updated for: <workspace-list>
skipped: <workspace-list with reason>
```

---

## Hard rules (enforced always)

- NEVER add `Co-Authored-By:` trailer to any commit.
- NEVER use `--no-verify` on any git command.
- NEVER touch terraform / tofu / tfp in any form.
- ALWAYS `cd /home/max/git/ledger` before file operations.
- NEVER force-push.
- NEVER overwrite rollup `## Notes` section.
- NEVER auto-apply infrastructure changes.
- Skill MUST NOT do per-entity composition work inline — delegate to haiku agents per §1.5.
- Skill MUST NOT give subagents git, MCP, or gh access. Subagents receive only the data the skill already fetched.
- Manual notes (type=note) MUST have `manual: true` in frontmatter so they can be distinguished from synced ticket/PR rollups in queries and exports.
- Skill MUST sanitise slugs server-side per §6. Never trust agent output verbatim for filename components.
- Skill MUST backtick-wrap entity ids and quote-wrap titles in all summary markdown. Required for `__` and `_` characters to render correctly.
- Codeberg/Forgejo PAT MUST be read only from the env var named by `sources.codeberg.token_env`. Skill MUST NOT echo, log, write to disk, commit, or pass the token value to any subagent. Workspace.yaml stores the env var NAME, never the token value.
