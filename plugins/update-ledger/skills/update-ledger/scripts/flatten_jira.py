#!/usr/bin/env python3
"""flatten_jira.py — flatten Rovo-shaped Jira search dumps for build_entities.py.

`mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql` (the only Jira MCP
available since the legacy `mcp__atlassian__` server was permanently disabled
2026-08-10) returns `{issues:{nodes:[{key,id,self,fields:{...}}],pageInfo}}`,
but `build_entities.py` reads issue fields FLAT (`iss["summary"]`,
`iss["created"]`, ...) per the on-disk fetch contract (SKILL.md §1.8). This
script bridges the two: it flattens every `fields.*` key up to the issue's
top level, merges duplicate keys across paginated dumps (first-seen wins),
and writes the per-issue comment sidecars `build_entities.py` looks for
(`jira_comments_<KEY>.json`) from `fields.comment.comments` when present —
fetch `comment` explicitly in the `fields` list passed to Rovo to populate it.

Usage:
  flatten_jira.py [--tmp DIR] [--in-glob GLOB]

Input:  <tmp>/<in-glob>            Rovo raw dumps, default "jira_rovo_raw*.json"
Output: <tmp>/jira_search_flat.json   {issues:[...]}  (matches jira_search*.json)
        <tmp>/jira_comments_<KEY>.json   one per issue with >=1 comment

Idempotent: safe to re-run: content is fully recomputed from the raw dumps
each time, not incrementally merged.
"""
import os, sys, json, glob, argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--in-glob", default="jira_rovo_raw*.json",
                    help="glob (relative to --tmp) matching the raw Rovo page dumps")
    a = ap.parse_args()

    issues = {}
    for f in sorted(glob.glob(f"{a.tmp}/{a.in_glob}")):
        raw = json.load(open(f))
        nodes = ((raw.get("issues") or {}).get("nodes")) or []
        for n in nodes:
            key = n["key"]
            flat = dict(n.get("fields") or {})
            flat["key"] = key
            flat["self"] = n.get("self")
            issues.setdefault(key, flat)

    json.dump({"issues": list(issues.values())}, open(f"{a.tmp}/jira_search_flat.json", "w"))

    n_comments = 0
    n_sidecars = 0
    for key, flat in issues.items():
        comments = ((flat.get("comment") or {}).get("comments")) or []
        bodies = [c.get("body", "") for c in comments]
        if bodies:
            json.dump(bodies, open(f"{a.tmp}/jira_comments_{key}.json", "w"))
            n_sidecars += 1
            n_comments += len(bodies)

    print(json.dumps({
        "issues": len(issues), "comment_sidecars": n_sidecars, "total_comments": n_comments,
    }))


if __name__ == "__main__":
    main()
