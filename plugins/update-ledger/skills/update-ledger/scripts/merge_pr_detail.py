#!/usr/bin/env python3
"""merge_pr_detail.py — fold per-PR `gh pr view` / review-comment dumps into gh_merged.json.

SKILL.md §5 fetches, per PR, the stats `gh search prs` cannot return
(mergedAt/additions/deletions/changedFiles via `gh pr view --json ...`) and
the review comments (`gh api repos/{o}/{r}/pulls/{n}/comments`). This script
is the mechanical fold-in step: it reads those per-PR dumps from disk and
merges the stats onto the matching `gh_merged.json` records in place, so
`build_entities.py` and `build_chunks.py` see real LOC/file counts instead of
falling back to the "S" complexity default.

Expected on-disk layout (populate via `gh pr view` / `gh api` per PR, one file
each, filenames own-choice as long as they match `--detail-glob` /
`--reviews-glob`):
  <tmp>/pr_detail/<owner>__<repo>__<number>.json   {additions,deletions,changedFiles,mergedAt,...}
  <tmp>/pr_reviews/<owner>__<repo>__<number>.json  [{user,body},...]  (optional)

Usage:
  merge_pr_detail.py [--tmp DIR] [--gh-merged FILE]

Idempotent: re-running re-applies the same merge; safe to re-run after adding
more per-PR dumps.
"""
import os, sys, json, glob, argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--gh-merged", default=None,
                    help="default: <tmp>/gh_merged.json")
    ap.add_argument("--detail-glob", default="pr_detail/*.json")
    a = ap.parse_args()
    gh_path = a.gh_merged or f"{a.tmp}/gh_merged.json"
    if not os.path.exists(gh_path):
        print(json.dumps({"matched": 0, "total": 0, "skipped": "no gh_merged.json"}))
        return

    gh = json.load(open(gh_path))

    detail = {}
    for f in glob.glob(f"{a.tmp}/{a.detail_glob}"):
        base = os.path.basename(f)[:-5]  # strip .json
        parts = base.rsplit("__", 2)
        if len(parts) != 3:
            continue
        owner, repo, num = parts
        try:
            d = json.load(open(f))
        except Exception:
            continue
        detail[f"{owner}/{repo}#{num}"] = d

    n = 0
    for p in gh:
        repo_full = (p.get("repository") or {}).get("nameWithOwner") or (p.get("repository") or {}).get("full_name")
        key = f"{repo_full}#{p['number']}"
        d = detail.get(key)
        if d:
            p["additions"] = d.get("additions")
            p["deletions"] = d.get("deletions")
            p["changedFiles"] = d.get("changedFiles")
            p["mergedAt"] = d.get("mergedAt") or p.get("mergedAt")
            n += 1

    json.dump(gh, open(gh_path, "w"))
    print(json.dumps({"matched": n, "total": len(gh)}))


if __name__ == "__main__":
    main()
