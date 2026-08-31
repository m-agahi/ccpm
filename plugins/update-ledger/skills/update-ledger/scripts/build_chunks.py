#!/usr/bin/env python3
"""build_chunks.py — stage rollup-composer chunk payloads (SKILL.md §7.1 step 4).

Reads every entity from `<tmp>/ent/<id>.json` (per `manifest_ids.json`),
attaches the pre-existing `## Notes` / `## Timeline` sections extracted from
each entity's live rollup file (SKILL.md §8, gotcha #14 — composers MUST get
`existing_timeline`, not just `existing_notes`, or a pre-existing rollup with
zero new events this run loses its history), folds in per-PR stats from
`gh_merged.json` (additions/deletions/changedFiles — populate these first via
`merge_pr_detail.py`) and optional review comments from `pr_reviews/`, then
round-robins everything into `<tmp>/chunks/chunk_NN.json` files sized for one
sonnet composer agent each (pattern: `agent-prompt-ledger-rollup-compose-chunk`
in the yadgar wiki).

Chunk count auto-sizes to keep each chunk around `--target-size` records
(default 15) while never exceeding `--max-chunks` (default 18, safely under
the 20-concurrent-subagent harness cap from SKILL.md gotcha #15) — a run
larger than target_size * max_chunks needs a relaunch wave, same as any
other oversized sync.

Usage:
  build_chunks.py <workspace> [--tmp DIR] [--target-size N] [--max-chunks N]
"""
import os, sys, json, math, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import ledger_root, extract_sections


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--target-size", type=int, default=15,
                    help="target records per chunk")
    ap.add_argument("--max-chunks", type=int, default=18,
                    help="hard cap on chunk count (harness concurrency limit is 20)")
    a = ap.parse_args()
    ledger_root()  # validate $LEDGER_HOME, unused otherwise (out_path is absolute)

    manifest = json.load(open(f"{a.tmp}/manifest_ids.json"))

    gh_stats = {}
    gh_path = f"{a.tmp}/gh_merged.json"
    if os.path.exists(gh_path):
        for p in json.load(open(gh_path)):
            repo_full = (p.get("repository") or {}).get("nameWithOwner") or (p.get("repository") or {}).get("full_name")
            if not repo_full:
                continue
            owner, repo = repo_full.split("/")
            eid = f"{owner}__{repo}__{p['number']}"
            gh_stats[eid] = {
                "additions": p.get("additions"),
                "deletions": p.get("deletions"),
                "changed_files": p.get("changedFiles"),
            }

    records = []
    for eid in manifest:
        e = json.load(open(f"{a.tmp}/ent/{eid}.json"))
        path = e["path"]
        sec = extract_sections(path, ["Notes", "Timeline"])
        rec = {
            "id": e["id"], "kind": e["kind"], "title": e["title"], "status": e["status"],
            "opened": e["opened"], "closed": e.get("closed"),
            "complexity": e["complexity"], "impact": e["impact"], "source_url": e["source_url"],
            "labels": e.get("labels", []), "events": e["events"], "out_path": path,
            "existing_notes": sec["Notes"], "existing_timeline": sec["Timeline"],
            "last_synced": e["last_synced"],
        }
        if e["kind"] == "ticket":
            rec["priority"] = e.get("priority", "")
            rec["issuetype"] = e.get("issuetype", "")
            rec["description"] = e.get("description", "")
            rec["comments"] = (e.get("comments") or [])[:14]
        else:
            rec["origin"] = e.get("origin", "authored")
            rec["repo"] = e.get("repo", "")
            rec["number"] = e.get("number")
            rec["body"] = e.get("body", "")
            gs = gh_stats.get(e["id"], {})
            rec["additions"] = gs.get("additions")
            rec["deletions"] = gs.get("deletions")
            rec["changed_files"] = gs.get("changed_files")
            review_comments = []
            if rec.get("repo") and rec.get("number") is not None:
                rv_path = f"{a.tmp}/pr_reviews/{rec['repo'].replace('/', '__')}__{rec['number']}.json"
                if os.path.exists(rv_path):
                    try:
                        review_comments = json.load(open(rv_path))
                    except Exception:
                        pass
            rec["review_comments"] = review_comments[:10]
        records.append(rec)

    n_chunks = max(1, min(a.max_chunks, math.ceil(len(records) / a.target_size))) if records else 0

    os.makedirs(f"{a.tmp}/chunks", exist_ok=True)
    sizes = {}
    for i in range(n_chunks):
        chunk = records[i::n_chunks]
        if not chunk:
            continue
        json.dump(chunk, open(f"{a.tmp}/chunks/chunk_{i:02d}.json", "w"), indent=1)
        sizes[f"chunk_{i:02d}"] = len(chunk)

    print(json.dumps({"total_records": len(records), "n_chunks": len(sizes), "sizes": sizes}, indent=1))


if __name__ == "__main__":
    main()
