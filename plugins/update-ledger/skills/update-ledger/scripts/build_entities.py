#!/usr/bin/env python3
"""build_entities.py — deterministic entity + event builder (SKILL.md §6/§7/§9).

Reads the raw source fetches the skill has already written to disk, and emits
one self-contained JSON per entity into <tmp>/ent/<id>.json. Each carries the
precomputed EVENT list (created/closed/status-changed/opened/merged) with UTC
timestamps and entry-path stubs, plus a heuristic complexity/impact default.
Haiku composer agents then read one ent file each and render markdown — the
skill no longer hand-derives events, timezones, or slugs.

Inputs (under --tmp, default /tmp/ledger-sync), any missing file is skipped:
  jira_search*.json        Jira search results   {issues:[...]}  (no board tag)
  jira_board_<Name>.json   Jira board results    {issues:[...]}  -> tag board:<Name>
  gh_merged.json           deduped GitHub PRs (list; each has .origin)
  cb_merged.json           deduped Codeberg/Forgejo PRs (list; each has .origin)

Old status / prior enrichment come from the SQLite index (never hand-coded).

Usage:
  build_entities.py <workspace> [--tmp DIR] [--last-synced ISO8601]
"""
import os, sys, json, glob, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import (ledger_root, db_connect, old_status_map, norm_status,
                        to_utc, utc_iso)

LEVELS = ["S", "M", "L", "XL"]


def clamp(i):
    return LEVELS[max(0, min(len(LEVELS) - 1, i))]


def ticket_complexity(iss, ncomments):
    step = 0
    step += ncomments // 10
    try:
        c = to_utc(iss["created"]); u = to_utc(iss.get("resolutiondate") or iss["updated"])
        step += (u - c).days // 14
    except Exception:
        pass
    return clamp(step)


def pr_complexity(p):
    add = p.get("additions"); dele = p.get("deletions"); files = p.get("changedFiles") or p.get("changed_files")
    if add is None and files is None:
        return "S"
    loc = (add or 0) + (dele or 0)
    return clamp(loc // 300 + (files or 0) // 5)


def impact_from(labels, priority):
    labs = " ".join(labels).lower()
    pr = (priority or "").lower()
    if any(k in labs for k in ("blocker", "breaking:critical", "security", "incident")) or "critical" in pr or "blocker" in pr:
        return "critical"
    if any(k in labs for k in ("breaking", "customer", "feature")) or "high" in pr:
        return "high"
    if any(k in labs for k in ("doc", "docs", "chore", "cleanup", "trivial")):
        return "low"
    return "med"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--last-synced", default=None)
    ap.add_argument("--jira-host", default=None,
                    help="Jira host for source_url; default = workspace.yaml sources.jira.cloud_id")
    a = ap.parse_args()
    root = ledger_root()
    ws = a.workspace
    jira_host = a.jira_host or _jira_host_from_yaml(root, ws) or "your-domain.atlassian.net"
    tickets_dir = f"{root}/workspaces/{ws}/tickets"
    prs_dir = f"{root}/workspaces/{ws}/prs"
    ent_dir = f"{a.tmp}/ent"
    os.makedirs(ent_dir, exist_ok=True)
    last_synced = a.last_synced or utc_iso("1970-01-01T00:00:00+00:00")

    conn = db_connect()
    old = old_status_map(conn, ws)
    conn.close()

    entities = []

    # ---- Jira tickets (search ∪ boards) ----
    board_tags = {}   # key -> set of board:<Name>
    issues = {}       # key -> issue dict (first seen wins for fields)
    comments = {}     # key -> [str]  (optional sidecar jira_comments_<KEY>.json)
    for f in sorted(glob.glob(f"{a.tmp}/jira_search*.json")):
        for iss in (json.load(open(f)).get("issues") or []):
            issues.setdefault(iss["key"], iss)
    for f in sorted(glob.glob(f"{a.tmp}/jira_board_*.json")):
        name = os.path.basename(f)[len("jira_board_"):-len(".json")]
        for iss in (json.load(open(f)).get("issues") or []):
            issues.setdefault(iss["key"], iss)
            board_tags.setdefault(iss["key"], set()).add(f"board:{name}")
    for f in glob.glob(f"{a.tmp}/jira_comments_*.json"):
        key = os.path.basename(f)[len("jira_comments_"):-len(".json")]
        try:
            comments[key] = [c if isinstance(c, str) else c.get("body", "") for c in json.load(open(f))]
        except Exception:
            pass

    for key, iss in issues.items():
        cur = norm_status((iss.get("status") or {}).get("name"))
        created, updated = iss["created"], iss["updated"]
        res = iss.get("resolutiondate")
        exists = key in old
        events = []
        if exists:
            if cur != old[key]["status"]:
                ev = "closed" if cur == "done" else "status-changed"
                events.append({"event": ev, "ts": updated, "status": cur})
        else:
            events.append({"event": "created", "ts": created, "status": ("open" if cur != "done" else "open")})
            if cur == "done" and res:
                events.append({"event": "closed", "ts": res, "status": "done"})
        if exists:
            comp, imp = old[key]["complexity"] or "?", old[key]["impact"] or "?"
        else:
            comp = ticket_complexity(iss, len(comments.get(key, [])))
            imp = impact_from(iss.get("labels") or [], (iss.get("priority") or {}).get("name"))
        labels = list(iss.get("labels") or []) + sorted(board_tags.get(key, []))
        entities.append({
            "kind": "ticket", "id": key, "path": f"{tickets_dir}/{key}.md",
            "exists": exists, "title": iss["summary"], "status": cur,
            "opened": created[:10], "closed": (res[:10] if res else None),
            "created_ts": created, "updated_ts": updated, "resolutiondate": res,
            "priority": (iss.get("priority") or {}).get("name", ""),
            "issuetype": (iss.get("issue_type") or iss.get("issuetype") or {}).get("name", ""),
            "labels": labels, "complexity": comp, "impact": imp,
            "source_url": f"https://{jira_host}/browse/{key}",
            "description": (iss.get("description") or "")[:600],
            "comments": comments.get(key, []),
            "events": events,
            "board_tags": sorted(board_tags.get(key, [])),
        })

    # ---- GitHub + Codeberg PRs ----
    for fname, prefix, url_key in (("gh_merged.json", "", "url"),
                                    ("cb_merged.json", "codeberg__", "html_url")):
        path = f"{a.tmp}/{fname}"
        if not os.path.exists(path):
            continue
        for p in json.load(open(path)):
            repo_full = (p.get("repository") or {}).get("nameWithOwner") or (p.get("repository") or {}).get("full_name")
            owner, repo = repo_full.split("/")
            num = p["number"]
            eid = f"{prefix}{owner}__{repo}__{num}"
            state = (p.get("state") or "").lower()
            merged = state == "merged" or bool(p.get("mergedAt") or (p.get("pull_request") or {}).get("merged_at"))
            exists = eid in old
            origin = p.get("origin", "authored")
            created = p.get("createdAt") or p.get("created_at")
            updated = p.get("updatedAt") or p.get("updated_at")
            closed = p.get("closedAt") or p.get("closed_at")
            events = []
            if not exists:
                events.append({"event": "opened", "ts": created, "status": "open"})
                if merged:
                    events.append({"event": "merged", "ts": closed or updated, "status": "merged"})
                elif state == "closed":
                    events.append({"event": "closed", "ts": closed or updated, "status": "closed"})
            labels = [l["name"] if isinstance(l, dict) else l for l in (p.get("labels") or [])]
            if exists:
                comp, imp = old[eid]["complexity"] or "?", old[eid]["impact"] or "?"
            else:
                comp = pr_complexity(p)
                imp = impact_from(labels, None)
                if origin == "reviewed" and imp == "med":
                    imp = "low"
            entities.append({
                "kind": "pr", "id": eid, "path": f"{prs_dir}/{eid}.md",
                "exists": exists, "title": p["title"],
                "status": "merged" if merged else state, "origin": origin,
                "opened": created[:10], "closed": (closed[:10] if closed else None),
                "created_ts": created, "updated_ts": updated,
                "repo": repo_full, "number": num,
                "labels": labels, "complexity": comp, "impact": imp,
                "source_url": p.get(url_key), "body": (p.get("body") or "")[:600],
                "events": events,
            })

    # ---- enrich events with UTC + entry path stubs ----
    for e in entities:
        typ = "ticket" if e["kind"] == "ticket" else "pr"
        for ev in e["events"]:
            d = to_utc(ev["ts"])
            ev["ts_utc"] = d.strftime("%Y-%m-%dT%H:%M:%SZ")
            ev["date_path"] = d.strftime("%Y/%m/%d")
            ev["fname_prefix"] = d.strftime("%Y%m%d_%H%M") + f"_{typ}_{e['id']}_"
        e["last_synced"] = last_synced

    for e in entities:
        json.dump(e, open(f"{ent_dir}/{e['id']}.json", "w"), indent=1)
    json.dump([e["id"] for e in entities], open(f"{a.tmp}/manifest_ids.json", "w"))

    tk = [e for e in entities if e["kind"] == "ticket"]
    pr = [e for e in entities if e["kind"] == "pr"]
    evc = sum(len(e["events"]) for e in entities)
    print(json.dumps({
        "entities": len(entities), "tickets": len(tk), "prs": len(pr),
        "events": evc,
        "new": sum(1 for e in entities if not e["exists"]),
        "regen_only": [e["id"] for e in entities if not e["events"]],
    }, indent=1))


def _jira_host_from_yaml(root, ws):
    import yaml
    p = f"{root}/workspaces/{ws}/workspace.yaml"
    try:
        d = yaml.safe_load(open(p))
        cid = (((d or {}).get("sources") or {}).get("jira") or {}).get("cloud_id") or ""
        cid = cid.strip()
        return cid or None
    except Exception:
        return None


if __name__ == "__main__":
    main()
