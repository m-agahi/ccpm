#!/usr/bin/env python3
"""write_entries.py — deterministic immutable entry-file writer (SKILL.md §6).

Entries are a trivial, fully-derivable rendering of one `ent/<id>.json`
event: frontmatter (id/workspace/type/event/status/timestamp/source_url) plus
a 2-line templated body. No prose judgment is needed, so — unlike rollup
composition (SKILL.md §7.1) — no agent is dispatched for this step; it is
pure mechanics like the rest of this scripts/ directory.

Idempotent: skips any file that already exists (SKILL.md §6 idempotency rule).

Usage:
  write_entries.py <workspace> [--tmp DIR]
"""
import os, re, sys, glob, json, argparse, unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import ledger_root, slugify

EVENT_VERB = {
    "created": "opened",
    "opened": "opened",
    "status-changed": "status changed to",
    "closed": "closed",
    "merged": "merged",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    a = ap.parse_args()
    root = ledger_root()
    ws = a.workspace
    entries_root = f"{root}/workspaces/{ws}/entries"

    written = 0
    skipped = 0

    for f in sorted(glob.glob(f"{a.tmp}/ent/*.json")):
        e = json.load(open(f))
        kind = e["kind"]
        typ = "ticket" if kind == "ticket" else "pr"
        eid = e["id"]
        title = e["title"]
        for ev in e["events"]:
            dest_dir = f"{entries_root}/{ev['date_path']}"
            os.makedirs(dest_dir, exist_ok=True)
            slug = slugify(title)
            fname = f"{ev['fname_prefix']}{slug}.md"
            path = f"{dest_dir}/{fname}"
            if os.path.exists(path):
                skipped += 1
                continue
            event = ev["event"]
            status = ev["status"]
            verb = EVENT_VERB.get(event, event)
            if kind == "ticket":
                body = f'`{eid}` {verb} — "{title}".\nStatus: {status}.'
            else:
                repo = e.get("repo", "")
                body = f'`{eid}` ({repo}) {verb} — "{title}".\nStatus: {status}.'
            content = (
                "---\n"
                f"id: {eid}\n"
                f"workspace: {ws}\n"
                f"type: {typ}\n"
                f"event: {event}\n"
                f"status: {status}\n"
                f"timestamp: {ev['ts_utc']}\n"
                f"source_url: {e.get('source_url')}\n"
                "---\n\n"
                f"{body}\n"
            )
            with open(path, "w") as fh:
                fh.write(content)
            written += 1

    print(json.dumps({"written": written, "skipped_existing": skipped}))


if __name__ == "__main__":
    main()
