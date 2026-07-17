#!/usr/bin/env python3
"""gen_summaries.py — deterministic summary (re)generation (SKILL.md §10).

Summary content is pure aggregation over the SQLite index (event list +
complexity/impact counts + top-5-by-impact + top-5 themes). Computing it in
Python gives exact counts and trivial ## Notes / ## Narrative preservation —
more reliable than asking a haiku agent to count. Prose composition stays with
agents elsewhere; summaries are metrics, so they live here.

Regenerates every period touched on/after --since: the daily files for each
date with an event, and the containing week / month / quarter (+ year for
cross). Existing ## Notes (all) and ## Narrative (monthly+) are preserved.

Usage:
  gen_summaries.py <workspace> --since YYYY-MM-DD [--cross] [--tmp DIR]
"""
import os, sys, json, argparse, datetime
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import ledger_root, db_connect, extract_sections

IMP_ORDER = {"critical": 0, "high": 1, "med": 2, "low": 3, "?": 4, None: 4}
NOW = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bt(i):
    return f"`{i}`"


def qt(t, n):
    return '"' + str(t)[:n] + '"'


def load(conn, ws):
    ev = []
    for eid, event, ts in conn.execute(
            "SELECT entity_id,event,ts FROM events WHERE workspace=?", (ws,)):
        ts = str(ts).replace("T", " ")
        ev.append({"id": eid, "event": event, "date": ts[:10], "hm": ts[11:16]})
    ents = {}
    for row in conn.execute(
            "SELECT id,type,title,status,complexity,impact,tags FROM entities WHERE workspace=?", (ws,)):
        d = {"id": row[0], "type": row[1], "title": row[2], "status": row[3],
             "complexity": row[4], "impact": row[5]}
        try:
            d["tags"] = json.loads(row[6] or "[]")
        except Exception:
            d["tags"] = []
        ents[d["id"]] = d
    return ev, ents


def touched_ids(evs):
    out = []
    for e in evs:
        if e["id"] not in out:
            out.append(e["id"])
    return out


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w", encoding="utf-8").write(content.rstrip() + "\n")


def daily(EV, ENTS, root, date, ws):
    evs = sorted([e for e in EV if e["date"] == date], key=lambda e: e["hm"])
    if not evs:
        return None
    sub = "cross/summaries/daily" if ws == "cross" else f"workspaces/{ws}/summaries/daily"
    path = f"{root}/{sub}/{date}.md"
    pres = extract_sections(path, ["Notes"])
    L = [f"---\nperiod: {date}\nworkspace: {ws}\ngranularity: daily\ngenerated_at: {NOW}\n---",
         "", "## Activity", ""]
    for e in evs:
        ent = ENTS.get(e["id"], {})
        L.append(f"- {e['hm']} {bt(e['id'])} [{ent.get('type','?')}] {e['event']} — {qt(ent.get('title',''),80)}")
    L += ["", "## Notes", "", pres["Notes"]]
    write(path, "\n".join(L))
    return len(evs)


def aggregate(EV, ENTS, root, name, gran, pred, ws, narrative=False):
    evs = [e for e in EV if pred(e["date"])]
    if not evs:
        return None
    ids = touched_ids(evs)
    ents = [ENTS[i] for i in ids if i in ENTS]
    tc = Counter(e["type"] for e in ents)
    comp = Counter(e["complexity"] or "?" for e in ents)
    imp = Counter(e["impact"] or "?" for e in ents)
    new = sum(1 for e in evs if e["event"] in ("created", "opened"))
    clo = sum(1 for e in evs if e["event"] in ("closed", "merged"))
    top = sorted(ents, key=lambda e: (IMP_ORDER.get(e["impact"], 4), e["id"]))[:5]
    tagc = Counter()
    for e in ents:
        for t in e["tags"]:
            tagc[t] += 1
    base = "cross/summaries" if ws == "cross" else f"workspaces/{ws}/summaries"
    path = f"{root}/{base}/{gran}/{name}.md"
    keep = ["Notes"] + (["Narrative"] if narrative else [])
    pres = extract_sections(path, keep)
    L = [f"---\nperiod: {name}\nworkspace: {ws}\ngranularity: {gran}\ngenerated_at: {NOW}\n---", "",
         "## Activity", "", f"- Events: {len(evs)}", f"- Entities touched: {len(ents)}", "",
         "## Metrics", "",
         f"- Entities touched: {len(ents)} ({tc.get('ticket',0)} tickets, {tc.get('pr',0)} prs, {tc.get('note',0)} notes)",
         f"- New: {new} | Closed/Merged: {clo}",
         f"- Complexity: S={comp.get('S',0)} M={comp.get('M',0)} L={comp.get('L',0)} XL={comp.get('XL',0)} ?={comp.get('?',0)}",
         f"- Impact: low={imp.get('low',0)} med={imp.get('med',0)} high={imp.get('high',0)} critical={imp.get('critical',0)} ?={imp.get('?',0)}",
         "", "## Top items", ""]
    L += [f"- {bt(e['id'])} [{e['impact']}] {qt(e['title'],68)}" for e in top] or ["_(none)_"]
    L += ["", "## Themes", ""]
    L += [f'- "{t}" ({c})' for t, c in tagc.most_common(5)] or ["_(none)_"]
    if narrative:
        L += ["", "## Narrative", "", pres.get("Narrative", "")]
    L += ["", "## Notes", "", pres.get("Notes", "")]
    write(path, "\n".join(L))
    return len(ents)


def periods_since(EV, since):
    dates = sorted({e["date"] for e in EV if e["date"] >= since})
    weeks, months, quarters, years = set(), set(), set(), set()
    for ds in dates:
        d = datetime.date.fromisoformat(ds)
        iy, iw, _ = d.isocalendar()
        weeks.add(f"{iy}-W{iw:02d}")
        months.add(ds[:7])
        quarters.add(f"{ds[:4]}-Q{(d.month - 1)//3 + 1}")
        years.add(ds[:4])
    return dates, sorted(weeks), sorted(months), sorted(quarters), sorted(years)


def week_pred(name):
    iy, iw = int(name[:4]), int(name[6:])
    return lambda ds: (lambda d: d.isocalendar()[0] == iy and d.isocalendar()[1] == iw)(datetime.date.fromisoformat(ds))


def month_pred(name):
    return lambda ds: ds[:7] == name


def quarter_pred(name):
    y, q = name[:4], int(name[6:])
    lo = (q - 1) * 3 + 1
    return lambda ds: ds[:4] == y and lo <= int(ds[5:7]) <= lo + 2


def year_pred(name):
    return lambda ds: ds[:4] == name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--since", required=True, help="YYYY-MM-DD; regen periods with events on/after this")
    ap.add_argument("--cross", action="store_true")
    a = ap.parse_args()
    root = ledger_root()
    conn = db_connect()
    EV, ENTS = load(conn, a.workspace)
    conn.close()
    dates, weeks, months, quarters, years = periods_since(EV, a.since)
    stats = {"daily": 0, "weekly": 0, "monthly": 0, "quarterly": 0, "yearly": 0}
    targets = [a.workspace] + (["cross"] if a.cross else [])
    for ws in targets:
        for d in dates:
            if daily(EV, ENTS, root, d, ws) is not None:
                stats["daily"] += 1
        for w in weeks:
            if aggregate(EV, ENTS, root, w, "weekly", week_pred(w), ws) is not None:
                stats["weekly"] += 1
        for m in months:
            if aggregate(EV, ENTS, root, m, "monthly", month_pred(m), ws, narrative=True) is not None:
                stats["monthly"] += 1
        for q in quarters:
            if aggregate(EV, ENTS, root, q, "quarterly", quarter_pred(q), ws, narrative=True) is not None:
                stats["quarterly"] += 1
        if ws == "cross":
            for y in years:
                if aggregate(EV, ENTS, root, y, "yearly", year_pred(y), ws, narrative=True) is not None:
                    stats["yearly"] += 1
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
