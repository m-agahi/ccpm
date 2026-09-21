#!/usr/bin/env python3
"""merge_gh.py — dedup + origin-tag the two GitHub search passes (SKILL.md §5/§6.0).

§5 runs `gh search prs` twice — authored (`--author`) and reviewed
(`--reviewed-by`) — with `--json number,title,url,state,createdAt,updatedAt,
closedAt,author,body,labels,repository,commentsCount`. This script is the
mechanical merge every sync used to hand-write in `/tmp`: dedup by `url`, tag
`origin: authored|reviewed|both`, drop rows already covered by the cursor
(`updatedAt <= cursor` — `gh search --updated=">=X"` re-returns the boundary
row), and write `gh_merged.json` for `merge_pr_detail.py` / `build_entities.py`.

Cursor: `--cursor ISO` wins; else, when a positional `workspace` is given,
`github_updated_after` for it from `$LEDGER_HOME/.ledger/last_sync.json`; else
no filter. ISO strings must be UTC `...Z` (what gh returns) — compared lexically.

The printed `max_updated_at` is the next GitHub cursor for `last_sync.json`.

Usage:
  merge_gh.py [workspace] [--tmp DIR] [--authored FILE] [--reviewed FILE]
              [--cursor ISO] [--out FILE]
"""
import os, sys, json, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import ledger_root


def load(path):
    if not path or not os.path.exists(path):
        return None
    return json.load(open(path))


def key(p):
    if p.get("url"):
        return p["url"]
    repo = (p.get("repository") or {}).get("nameWithOwner") or ""
    return f"{repo}#{p.get('number')}"


def cursor_from_last_sync(workspace):
    path = os.path.join(ledger_root(), ".ledger", "last_sync.json")
    if not os.path.exists(path):
        return None
    d = json.load(open(path))
    return ((d.get("workspaces") or {}).get(workspace) or {}).get("github_updated_after")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", nargs="?",
                    help="read the cursor from last_sync.json for this workspace")
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--authored", default=None, help="default: <tmp>/gh_authored.json")
    ap.add_argument("--reviewed", default=None, help="default: <tmp>/gh_reviewed.json")
    ap.add_argument("--cursor", default=None,
                    help="drop rows with updatedAt <= this (UTC ...Z ISO)")
    ap.add_argument("--out", default=None, help="default: <tmp>/gh_merged.json")
    a = ap.parse_args()

    cursor = a.cursor
    if cursor is None and a.workspace:
        cursor = cursor_from_last_sync(a.workspace)

    passes = [("authored", load(a.authored or f"{a.tmp}/gh_authored.json")),
              ("reviewed", load(a.reviewed or f"{a.tmp}/gh_reviewed.json"))]
    if all(rows is None for _, rows in passes):
        raise SystemExit("no gh_authored.json / gh_reviewed.json found under --tmp")

    merged, origins = {}, {}
    for origin, rows in passes:
        for p in rows or []:
            k = key(p)
            origins.setdefault(k, set()).add(origin)
            prev = merged.get(k)
            # keep the freshest copy of the row if the passes disagree
            if prev is None or (p.get("updatedAt") or "") > (prev.get("updatedAt") or ""):
                merged[k] = p

    out, counts = [], {"authored": 0, "reviewed": 0, "both": 0}
    for k, p in merged.items():
        if cursor and (p.get("updatedAt") or "") <= cursor:
            continue
        o = origins[k]
        p = dict(p, origin="both" if len(o) == 2 else next(iter(o)))
        counts[p["origin"]] += 1
        out.append(p)
    out.sort(key=lambda p: (p.get("updatedAt") or "", key(p)))

    out_path = a.out or f"{a.tmp}/gh_merged.json"
    json.dump(out, open(out_path, "w"))
    print(json.dumps({
        "total_unique": len(merged), "kept": len(out), "cursor": cursor,
        "origin_counts": counts,
        "max_updated_at": max((p.get("updatedAt") or "" for p in out), default=None) or cursor,
        "out": out_path,
    }, indent=1))


if __name__ == "__main__":
    main()
