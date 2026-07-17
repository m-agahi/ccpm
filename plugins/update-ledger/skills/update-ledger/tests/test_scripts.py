"""Test suite for the update-ledger deterministic helper scripts.

Unit tests import the pure functions; integration tests drive each script via
subprocess with a throwaway $LEDGER_HOME sandbox. Run: `pytest` from anywhere.
"""
import os, sys, json, subprocess, sqlite3
import pytest

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
sys.path.insert(0, SCRIPTS)

import ledger_lib as lib          # noqa: E402
import build_entities as be       # noqa: E402


# --------------------------------------------------------------------------- #
# unit: ledger_lib
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("title,expected", [
    ("fix(area): thing with: colon", "fix-area-thing-with-colon"),
    ("chore(x): bump", "chore-x-bump"),
    ("  leading/trailing  ", "leading-trailing"),
    ("café ☕ résumé", "caf-rsum"),
    ("***", "untitled"),
    ("", "untitled"),
])
def test_slugify(title, expected):
    assert lib.slugify(title) == expected


def test_slugify_truncates_at_boundary():
    s = lib.slugify("word " * 20)
    assert len(s) <= 40
    assert not s.endswith("-")


@pytest.mark.parametrize("iso,expected", [
    ("2026-07-16T14:15:29.373+0200", "2026-07-16T12:15:29Z"),
    ("2026-07-16T09:00:00Z", "2026-07-16T09:00:00Z"),
    ("2026-01-01T00:30:00+05:30", "2025-12-31T19:00:00Z"),
])
def test_to_utc(iso, expected):
    assert lib.utc_iso(iso) == expected


@pytest.mark.parametrize("s,expected", [
    ("Done", "done"), ("Closed", "done"), ("In Progress", "in-progress"),
    ("To Do", "to-do"), ("Backlog", "backlog"), ("Merged", "merged"),
])
def test_norm_status(s, expected):
    assert lib.norm_status(s) == expected


# --------------------------------------------------------------------------- #
# unit: build_entities heuristics
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("labels,priority,expected", [
    (["blocker"], None, "critical"),
    ([], "Prio 1 (Critical)", "critical"),
    (["breaking"], None, "high"),
    (["chore"], None, "low"),
    ([], "Prio 4 (Normal)", "med"),
])
def test_impact_from(labels, priority, expected):
    assert be.impact_from(labels, priority) == expected


def test_pr_complexity_buckets():
    assert be.pr_complexity({}) == "S"                                   # unknown -> S
    assert be.pr_complexity({"additions": 50, "deletions": 10, "changedFiles": 3}) == "S"
    assert be.pr_complexity({"additions": 700, "deletions": 0, "changedFiles": 0}) == "L"   # 700//300=2
    assert be.pr_complexity({"additions": 0, "deletions": 0, "changedFiles": 10}) == "L"    # 10//5=2
    assert be.pr_complexity({"additions": 900, "deletions": 0, "changedFiles": 0}) == "XL"  # 900//300=3


def test_ticket_complexity_age_and_comments():
    base = {"created": "2026-07-01T00:00:00+00:00", "updated": "2026-07-02T00:00:00+00:00"}
    assert be.ticket_complexity(base, 0) == "S"
    assert be.ticket_complexity(base, 20) == "L"           # +2 steps from comments
    old = {"created": "2026-06-01T00:00:00+00:00", "resolutiondate": "2026-07-01T00:00:00+00:00"}
    assert be.ticket_complexity(old, 0) == "L"             # 30d open -> 30//14=2 -> L
    mid = {"created": "2026-06-20T00:00:00+00:00", "resolutiondate": "2026-07-05T00:00:00+00:00"}
    assert be.ticket_complexity(mid, 0) == "M"             # 15d open -> 15//14=1 -> M


# --------------------------------------------------------------------------- #
# integration helpers
# --------------------------------------------------------------------------- #
def run(script, *args, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    r = subprocess.run([sys.executable, os.path.join(SCRIPTS, script), *args],
                       capture_output=True, text=True, env=e)
    return r


@pytest.fixture
def sandbox(tmp_path):
    root = tmp_path / "ledger"
    for d in ["tickets", "prs", "entries", "notes",
              "summaries/daily", "summaries/weekly", "summaries/monthly", "summaries/quarterly"]:
        (root / "workspaces/test" / d).mkdir(parents=True, exist_ok=True)
    for d in ["daily", "weekly", "monthly", "quarterly", "yearly"]:
        (root / "cross/summaries" / d).mkdir(parents=True, exist_ok=True)
    (root / ".ledger").mkdir(parents=True, exist_ok=True)
    (root / "workspaces/test/workspace.yaml").write_text(
        "name: test\nsources:\n  jira:\n    cloud_id: \"test.atlassian.net\"\n")
    tmp = tmp_path / "sync"
    tmp.mkdir()
    env = {"LEDGER_HOME": str(root)}
    return {"root": root, "tmp": tmp, "env": env}


def seed_entity(sandbox, eid, status="backlog", complexity="M", impact="high"):
    """Put an existing entity in the index so build_entities sees OLD status."""
    conn = sqlite3.connect(sandbox["root"] / ".ledger/index.sqlite")
    conn.execute("""CREATE TABLE IF NOT EXISTS entities(id TEXT,workspace TEXT,type TEXT,
        title TEXT,status TEXT,opened TEXT,closed TEXT,complexity TEXT,impact TEXT,
        tags TEXT,last_synced TEXT,PRIMARY KEY(workspace,id))""")
    conn.execute("INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                 (eid, "test", "ticket", "t", status, "2026-07-01", None, complexity, impact, "[]", "x"))
    conn.commit(); conn.close()


def write_fetches(sandbox, search=None, boards=None, gh=None):
    tmp = sandbox["tmp"]
    if search is not None:
        (tmp / "jira_search.json").write_text(json.dumps({"issues": search}))
    for name, issues in (boards or {}).items():
        (tmp / f"jira_board_{name}.json").write_text(json.dumps({"issues": issues}))
    if gh is not None:
        (tmp / "gh_merged.json").write_text(json.dumps(gh))


TICKET_DONE = {"key": "TEST-1", "summary": "fix(x): thing", "status": {"name": "Done"},
               "issue_type": {"name": "Task"}, "priority": {"name": "Prio 4 (Normal)"},
               "labels": ["chore"], "created": "2026-07-16T14:15:29+0200",
               "updated": "2026-07-16T14:22:55+0200", "resolutiondate": "2026-07-16T14:22:54+0200",
               "description": "d"}
TICKET_WIP = {"key": "TEST-2", "summary": "migration", "status": {"name": "In Progress"},
              "issue_type": {"name": "Story"}, "priority": {"name": "Prio 1 (Critical)"},
              "labels": ["blocker"], "created": "2026-07-10T09:00:00+0200",
              "updated": "2026-07-16T10:00:00+0200", "resolutiondate": None, "description": "d"}
PR_MERGED = {"number": 42, "title": "chore(x): bump", "state": "MERGED", "origin": "authored",
             "createdAt": "2026-07-16T08:00:00Z", "updatedAt": "2026-07-16T09:00:00Z",
             "closedAt": "2026-07-16T09:00:00Z", "repository": {"nameWithOwner": "acme/core"},
             "labels": [{"name": "deps"}], "body": "b", "additions": 50, "deletions": 10,
             "changedFiles": 3}


# --------------------------------------------------------------------------- #
# integration: build_entities
# --------------------------------------------------------------------------- #
def test_build_new_ticket_events_and_utc(sandbox):
    write_fetches(sandbox, search=[TICKET_DONE])
    r = run("build_entities.py", "test", "--tmp", str(sandbox["tmp"]),
            "--last-synced", "2026-07-16T18:30:00Z", env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    d = json.load(open(sandbox["tmp"] / "ent/TEST-1.json"))
    assert d["exists"] is False
    evs = [(e["event"], e["ts_utc"]) for e in d["events"]]
    assert evs == [("created", "2026-07-16T12:15:29Z"), ("closed", "2026-07-16T12:22:54Z")]
    assert d["events"][0]["fname_prefix"] == "20260716_1215_ticket_TEST-1_"
    assert d["source_url"] == "https://test.atlassian.net/browse/TEST-1"
    assert d["complexity"] == "S" and d["impact"] == "low"


def test_build_existing_ticket_only_status_change(sandbox):
    seed_entity(sandbox, "TEST-1", status="in-progress", complexity="M", impact="high")
    write_fetches(sandbox, search=[TICKET_DONE])
    r = run("build_entities.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    d = json.load(open(sandbox["tmp"] / "ent/TEST-1.json"))
    assert d["exists"] is True
    assert [e["event"] for e in d["events"]] == ["closed"]     # transition, not created
    assert d["complexity"] == "M" and d["impact"] == "high"    # preserved, not re-heuristic'd


def test_build_wip_new_created_only_and_critical(sandbox):
    write_fetches(sandbox, search=[TICKET_WIP])
    run("build_entities.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    d = json.load(open(sandbox["tmp"] / "ent/TEST-2.json"))
    assert [e["event"] for e in d["events"]] == ["created"]
    assert d["impact"] == "critical"


def test_build_board_tag_from_filename_and_dedup(sandbox):
    # TEST-1 appears in both search and board -> single entity, board tagged
    write_fetches(sandbox, search=[TICKET_DONE], boards={"DevOps-Team": [TICKET_DONE]})
    out = run("build_entities.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    summ = json.loads(out.stdout)
    assert summ["tickets"] == 1
    d = json.load(open(sandbox["tmp"] / "ent/TEST-1.json"))
    assert "board:DevOps-Team" in d["labels"]


def test_build_pr_events(sandbox):
    write_fetches(sandbox, gh=[PR_MERGED])
    run("build_entities.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    d = json.load(open(sandbox["tmp"] / "ent/acme__core__42.json"))
    assert d["id"] == "acme__core__42"
    assert [e["event"] for e in d["events"]] == ["opened", "merged"]
    assert d["complexity"] == "S"


# --------------------------------------------------------------------------- #
# integration: fix_frontmatter
# --------------------------------------------------------------------------- #
ROLLUP_BAD = """---
id: TEST-1
workspace: test
type: ticket
title: chore(x): bump with: colon
status: done
---
## Summary
x
## Notes
keep me
"""


def test_fix_frontmatter_quotes_colon_title(sandbox):
    p = sandbox["root"] / "workspaces/test/tickets/TEST-1.md"
    p.write_text(ROLLUP_BAD)
    # sanity: currently unparseable
    assert lib.read_frontmatter(str(p)) is None
    r = run("fix_frontmatter.py", "--ent-dir", str(sandbox["tmp"] / "ent"),
            str(p), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    fm = lib.read_frontmatter(str(p))
    assert fm is not None and fm["title"] == "chore(x): bump with: colon"
    assert "keep me" in p.read_text()          # body untouched


def test_fix_frontmatter_idempotent_on_quoted(sandbox):
    p = sandbox["root"] / "workspaces/test/tickets/TEST-2.md"
    p.write_text('---\nid: TEST-2\ntitle: "already safe"\nstatus: done\n---\n## Notes\n')
    r = run("fix_frontmatter.py", str(p), env=sandbox["env"])
    assert r.returncode == 0
    assert lib.read_frontmatter(str(p))["title"] == "already safe"


# --------------------------------------------------------------------------- #
# integration: index_upsert + gen_summaries
# --------------------------------------------------------------------------- #
def _make_rollup(sandbox, sub, eid, typ, status, comp, imp, tags, closed="2026-07-16", notes=""):
    p = sandbox["root"] / f"workspaces/test/{sub}/{eid}.md"
    p.write_text(
        f'---\nid: {eid}\nworkspace: test\ntype: {typ}\ntitle: "t {eid}"\n'
        f'status: {status}\nopened: 2026-07-16\nclosed: {closed}\ncomplexity: {comp}\n'
        f'impact: {imp}\ntags: {json.dumps(tags)}\nlast_synced: 2026-07-16T18:30:00Z\n---\n'
        f'## Summary\nx\n## Notes\n{notes}\n')
    return p


def _make_entry(sandbox, ts, typ, eid, event, status):
    d = ts[:10].replace("-", "/")
    hm = ts[11:16].replace(":", "")
    p = sandbox["root"] / f"workspaces/test/entries/{ts[:4]}/{ts[5:7]}/{ts[8:10]}/{ts[:10].replace('-','')}_{hm}_{typ}_{eid}_x.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"---\nid: {eid}\nworkspace: test\ntype: {typ}\nevent: {event}\n"
                 f"status: {status}\ntimestamp: {ts}\nsource_url: u\n---\nbody\n")
    return p


def test_index_and_summaries_end_to_end(sandbox):
    _make_rollup(sandbox, "tickets", "TEST-1", "ticket", "done", "S", "low", ["chore"], notes="preserve-me")
    _make_rollup(sandbox, "prs", "acme__core__42", "pr", "merged", "M", "high", ["deps"])
    _make_entry(sandbox, "2026-07-16T12:15:29Z", "ticket", "TEST-1", "created", "open")
    _make_entry(sandbox, "2026-07-16T12:22:54Z", "ticket", "TEST-1", "closed", "done")
    _make_entry(sandbox, "2026-07-16T09:00:00Z", "pr", "acme__core__42", "merged", "merged")
    json.dump(["TEST-1", "acme__core__42"], open(sandbox["tmp"] / "manifest_ids.json", "w"))

    r = run("index_upsert.py", "test", "--tmp", str(sandbox["tmp"]),
            "--entries-minutes", "600", env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["entities_upserted"] == 2 and res["events_inserted"] == 3

    # rerun -> events dedup by file, no duplicates
    r2 = run("index_upsert.py", "test", "--tmp", str(sandbox["tmp"]),
             "--entries-minutes", "600", env=sandbox["env"])
    assert json.loads(r2.stdout)["events_inserted"] == 0

    r3 = run("gen_summaries.py", "test", "--since", "2026-07-16", "--cross", env=sandbox["env"])
    assert r3.returncode == 0, r3.stderr
    stats = json.loads(r3.stdout)
    assert stats["daily"] == 2 and stats["weekly"] == 2 and stats["yearly"] == 1

    daily = (sandbox["root"] / "workspaces/test/summaries/daily/2026-07-16.md").read_text()
    assert "`TEST-1`" in daily and "12:15" in daily
    weekly = (sandbox["root"] / "workspaces/test/summaries/weekly/2026-W29.md").read_text()
    assert "Entities touched: 2 (1 tickets, 1 prs, 0 notes)" in weekly
    assert "Complexity: S=1 M=1 L=0 XL=0 ?=0" in weekly


def test_summaries_preserve_notes(sandbox):
    _make_rollup(sandbox, "tickets", "TEST-1", "ticket", "done", "S", "low", [])
    _make_entry(sandbox, "2026-07-16T12:15:29Z", "ticket", "TEST-1", "created", "open")
    json.dump(["TEST-1"], open(sandbox["tmp"] / "manifest_ids.json", "w"))
    run("index_upsert.py", "test", "--tmp", str(sandbox["tmp"]), "--entries-minutes", "600", env=sandbox["env"])
    # pre-existing monthly with manual Narrative + Notes must survive regen
    m = sandbox["root"] / "workspaces/test/summaries/monthly/2026-07.md"
    m.write_text("---\nperiod: 2026-07\n---\n## Narrative\nMY STORY\n## Notes\nMY NOTE\n")
    run("gen_summaries.py", "test", "--since", "2026-07-16", env=sandbox["env"])
    out = m.read_text()
    assert "MY STORY" in out and "MY NOTE" in out
