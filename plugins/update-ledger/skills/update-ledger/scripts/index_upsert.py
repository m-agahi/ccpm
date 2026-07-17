#!/usr/bin/env python3
"""index_upsert.py — refresh the SQLite index from written files (SKILL.md §12).

Upserts entity rows from the rollup frontmatter (frontmatter is canon,
§1.5.1) named in <tmp>/manifest_ids.json, and inserts one event row per
recently-written entry file. Dedup of events is by absolute file path, so
re-running is safe.

Usage:
  index_upsert.py <workspace> [--tmp DIR] [--entries-minutes N] [--since-ts ISO]
"""
import os, sys, json, glob, time, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import ledger_root, db_connect, read_frontmatter


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--entries-minutes", type=int, default=60,
                    help="index entry files modified within the last N minutes")
    a = ap.parse_args()
    root = ledger_root()
    ws = a.workspace
    conn = db_connect()

    ids = json.load(open(f"{a.tmp}/manifest_ids.json"))
    tdir = f"{root}/workspaces/{ws}/tickets"
    pdir = f"{root}/workspaces/{ws}/prs"
    rdir = f"{root}/workspaces/{ws}/repos"

    def rollup_path(i):
        for d in (tdir, pdir, rdir, f"{root}/workspaces/{ws}/notes"):
            p = f"{d}/{i}.md"
            if os.path.exists(p):
                return p
        return None

    up = 0
    for i in ids:
        p = rollup_path(i)
        if not p:
            print("MISS rollup", i, file=sys.stderr); continue
        d = read_frontmatter(p)
        if not d:
            print("BAD frontmatter", p, file=sys.stderr); continue
        tags = d.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        closed = d.get("closed")
        closed = None if closed in (None, "null", "None", "") else str(closed)
        conn.execute("""INSERT INTO entities(id,workspace,type,title,status,opened,closed,complexity,impact,tags,last_synced)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace,id) DO UPDATE SET
              type=excluded.type,title=excluded.title,status=excluded.status,
              opened=excluded.opened,closed=excluded.closed,complexity=excluded.complexity,
              impact=excluded.impact,tags=excluded.tags,last_synced=excluded.last_synced""",
            (d.get("id"), ws, d.get("type"), str(d.get("title")), d.get("status"),
             str(d.get("opened")), closed, d.get("complexity"), d.get("impact"),
             json.dumps(tags), str(d.get("last_synced"))))
        up += 1

    cutoff = time.time() - a.entries_minutes * 60
    seen = set(r[0] for r in conn.execute(
        "SELECT file FROM events WHERE workspace=? AND file IS NOT NULL", (ws,)))
    ev = 0
    for p in glob.glob(f"{root}/workspaces/{ws}/entries/**/*.md", recursive=True):
        if os.path.getmtime(p) < cutoff or p in seen:
            continue
        d = read_frontmatter(p)
        if not d:
            continue
        conn.execute("INSERT INTO events(entity_id,workspace,event,ts,file) VALUES(?,?,?,?,?)",
                     (d.get("id"), ws, d.get("event"), str(d.get("timestamp")), p))
        ev += 1
    conn.commit()
    cnt = conn.execute(
        "SELECT COUNT(*) FROM entities WHERE workspace=? AND last_synced >= ?",
        (ws, "")).fetchone()[0]
    print(json.dumps({"entities_upserted": up, "events_inserted": ev, "entities_total": cnt}))
    if up == 0:
        print(f"Warning: SQLite index may be stale — no entities updated for {ws}.", file=sys.stderr)
    conn.close()


if __name__ == "__main__":
    main()
