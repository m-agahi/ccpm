# update-ledger helper scripts

Deterministic mechanics for a ledger sync. The skill (`SKILL.md`) calls these
instead of hand-deriving events, timezones, slugs, counts, or SQLite writes —
the hand steps are where past runs silently corrupted data. Prose composition
(rollup Summary/Why/Impact, note bodies) stays with haiku agents. **Scripts =
mechanics; agents = writing.** See `SKILL.md` §1.8.

## Requirements

- `python3` (3.9+)
- `PyYAML`
- `$LEDGER_HOME` pointing at the ledger repo

## Order in a sync

```
# 1. after fetching, build per-entity JSON (events, UTC ts, slug stubs, enrichment)
python3 scripts/build_entities.py <workspace> --tmp /tmp/ledger-sync --last-synced <ISO8601>

# 2. dispatch haiku composer agents (SKILL §6.1/§7.1); each reads one ent/<id>.json

# 3. guard the rollups the agents wrote
python3 scripts/fix_frontmatter.py --ent-dir /tmp/ledger-sync/ent \
    "$LEDGER_HOME/workspaces/<workspace>/tickets/*.md" \
    "$LEDGER_HOME/workspaces/<workspace>/prs/*.md"

# 4. refresh the SQLite index
python3 scripts/index_upsert.py <workspace> --tmp /tmp/ledger-sync --entries-minutes 60

# 5. regenerate summaries for every touched period (add --cross if cross_summaries.enabled)
python3 scripts/gen_summaries.py <workspace> --since <first-touched-date> --cross
```

## On-disk fetch contract

`build_entities.py` reads raw source data from files under `--tmp` (never inline
tool output). Dump every fetch with these names:

| File                          | Contents                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| `jira_search*.json`           | Jira search results `{issues:[...]}` (no board tag)               |
| `jira_board_<BoardName>.json` | board results; filename `<BoardName>` → `board:<BoardName>` label |
| `jira_comments_<KEY>.json`    | optional per-issue comment array (feeds complexity heuristic)     |
| `gh_merged.json`              | deduped, origin-tagged GitHub PR list                             |
| `cb_merged.json`              | deduped, origin-tagged Codeberg/Forgejo PR list                   |

If an MCP call returns results inline, re-dump them to the expected path before
running `build_entities.py`. Do not hand-transcribe.

## Tests

```
pip install pytest pyyaml
pytest plugins/update-ledger/skills/update-ledger/tests   # 32 cases, ~1s
```

The suite unit-tests the pure helpers (slug/UTC/status/heuristics) and drives
each script end-to-end against a throwaway `$LEDGER_HOME` sandbox — no network,
no real ledger touched.

## Notes

- All scripts are idempotent and safe to re-run.
- `fix_frontmatter.py` exits non-zero if any rollup frontmatter is still
  unparseable after the title fix — treat that as a hard failure.
- These scripts are the reference implementation of `SKILL.md` §6/§7/§9/§10/§12.
  Where a script and the prose disagree, the script wins (fix the prose).
