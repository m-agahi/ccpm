# update-ledger helper scripts

Deterministic mechanics for a ledger sync. The skill (`SKILL.md`) calls these
instead of hand-deriving events, timezones, slugs, counts, chunk payloads, or
SQLite writes — the hand steps are where past runs silently corrupted data.
Prose composition (rollup Summary/Why/Impact, note bodies) stays with agents.
**Scripts = mechanics; agents = writing.** See `SKILL.md` §1.8.

## Requirements

- `python3` (3.9+)
- `PyYAML`
- `$LEDGER_HOME` pointing at the ledger repo

## Order in a sync

```
# 0. (Rovo-shaped Jira MCP only) flatten raw pages + split out comment sidecars
python3 scripts/flatten_jira.py --tmp /tmp/ledger-sync

# 0b. GitHub: merge gh_authored.json + gh_reviewed.json -> gh_merged.json
#     (dedup by url, origin tag, cursor filter; prints the next gh cursor)
python3 scripts/merge_gh.py <workspace> --tmp /tmp/ledger-sync

# 0c. per-PR detail + review comments, in parallel
#     (set-but-invalid GH_TOKEN? prefix GH_BIN="env -u GH_TOKEN gh")
bash scripts/fetch_pr_detail.sh --tmp /tmp/ledger-sync -P 8

# 0d. fold the gh pr view stats into gh_merged.json before build_entities
python3 scripts/merge_pr_detail.py --tmp /tmp/ledger-sync

# 1. after fetching, build per-entity JSON (events, UTC ts, slug stubs, enrichment)
python3 scripts/build_entities.py <workspace> --tmp /tmp/ledger-sync --last-synced <ISO8601>

# 2. write immutable entry files directly — no agent, entries are a fixed template
python3 scripts/write_entries.py <workspace> --tmp /tmp/ledger-sync

# 3. stage one chunk payload per rollup-composer agent (existing Notes/Timeline/
#    tags attached, GitHub stats/review comments folded in)
python3 scripts/build_chunks.py <workspace> --tmp /tmp/ledger-sync

# 4. dispatch composer agents (SKILL §7.1); each reads one chunks/chunk_NN.json
#    and writes N rollups straight to their live out_path

# 5. guard the rollups the agents wrote
python3 scripts/fix_frontmatter.py --ent-dir /tmp/ledger-sync/ent \
    "$LEDGER_HOME/workspaces/<workspace>/tickets/*.md" \
    "$LEDGER_HOME/workspaces/<workspace>/prs/*.md"

# 5b. verify what the composers wrote against the pre-sync commit; exit 1 = stop.
#     --fix-board-tags / --fix-titles repair those two classes in place.
python3 scripts/verify_rollups.py <workspace> --baseline <pre-sync-HEAD> --tmp /tmp/ledger-sync

# 6. refresh the SQLite index
python3 scripts/index_upsert.py <workspace> --tmp /tmp/ledger-sync --entries-minutes 60

# 7. regenerate summaries for every touched period (add --cross if cross_summaries.enabled)
python3 scripts/gen_summaries.py <workspace> --since <first-touched-date> --cross
```

## On-disk fetch contract

`build_entities.py` reads raw source data from files under `--tmp` (never inline
tool output). Dump every fetch with these names:

| File                                    | Contents                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `jira_rovo_raw*.json`                   | raw Rovo search pages `{issues:{nodes:[...]}}` — run `flatten_jira.py` to turn these into `jira_search_flat.json`                     |
| `jira_search*.json`                     | Jira search results `{issues:[...]}` (no board tag), flat shape                                                                       |
| `jira_board_<BoardName>.json`           | board results; filename `<BoardName>` → `board:<BoardName>` label                                                                     |
| `jira_comments_<KEY>.json`              | optional per-issue comment array (feeds complexity heuristic); `flatten_jira.py` writes these for you                                 |
| `gh_authored.json` / `gh_reviewed.json` | raw `gh search prs` authored / reviewed passes — `merge_gh.py` turns them into `gh_merged.json`                                       |
| `gh_merged.json`                        | deduped, origin-tagged GitHub PR list                                                                                                 |
| `cb_merged.json`                        | deduped, origin-tagged Codeberg/Forgejo PR list                                                                                       |
| `pr_detail/<owner>__<repo>__<n>.json`   | optional `gh pr view --json additions,deletions,changedFiles,mergedAt` dump (`fetch_pr_detail.sh`); fold in with `merge_pr_detail.py` |
| `pr_reviews/<owner>__<repo>__<n>.json`  | optional `gh api .../pulls/<n>/comments` dump; read directly by `build_chunks.py`                                                     |

If an MCP call returns results inline, re-dump them to the expected path before
running `build_entities.py`. Do not hand-transcribe.

## Tests

```
pip install pytest pyyaml
pytest plugins/update-ledger/skills/update-ledger/tests   # 52 cases, ~4s
```

The suite unit-tests the pure helpers (slug/UTC/status/heuristics) and drives
each script end-to-end against a throwaway `$LEDGER_HOME` sandbox — no network,
no real ledger touched.

## Notes

- All scripts are idempotent and safe to re-run.
- `fix_frontmatter.py` exits non-zero if any rollup frontmatter is still
  unparseable after the title fix — treat that as a hard failure.
- `verify_rollups.py` and `fetch_pr_detail.sh` exit non-zero on any failure —
  same rule. The test suite needs `git` (baseline repos) and `bash`.
- These scripts are the reference implementation of `SKILL.md` §6/§7/§9/§10/§12.
  Where a script and the prose disagree, the script wins (fix the prose).
