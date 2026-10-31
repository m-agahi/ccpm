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


def _ff_rollup(sandbox, eid, title_line):
    p = sandbox["root"] / f"workspaces/test/tickets/{eid}.md"
    p.write_text(f"---\nid: {eid}\n{title_line}\nstatus: done\n---\n## Notes\nkeep\n",
                 encoding="utf-8")
    return p


def _ff_canon(sandbox, eid, title):
    d = sandbox["tmp"] / "ent"
    d.mkdir(exist_ok=True)
    (d / f"{eid}.json").write_text(json.dumps({"id": eid, "title": title}))
    return str(d)


def _ff_run(sandbox, p, ent=None):
    args = ["--ent-dir", ent or str(sandbox["tmp"] / "ent"), str(p)]
    return run("fix_frontmatter.py", *args, env=sandbox["env"])


def test_fix_frontmatter_no_backslash_doubling_without_canon(sandbox):
    # id not in canon: the existing quoted scalar is the only source of truth
    p = _ff_rollup(sandbox, "TEST-10", 'title: "say \\"hi\\" C:\\\\dir"')
    want = 'say "hi" C:\\dir'
    assert lib.read_frontmatter(str(p))["title"] == want
    before = p.read_text(encoding="utf-8")
    for _ in range(3):
        r = _ff_run(sandbox, p)
        assert r.returncode == 0, r.stderr
        assert lib.read_frontmatter(str(p))["title"] == want
    assert p.read_text(encoding="utf-8") == before


def test_fix_frontmatter_decodes_yaml_escape_for_non_ascii(sandbox):
    p = _ff_rollup(sandbox, "TEST-11", 'title: "caf\\xE9 \\xA0 x"')
    r = _ff_run(sandbox, p)
    assert r.returncode == 0, r.stderr
    assert lib.read_frontmatter(str(p))["title"] == "caf\u00e9 \u00a0 x"


def test_fix_frontmatter_title_with_newline_stays_parseable(sandbox):
    ent = _ff_canon(sandbox, "TEST-12", "Patch: Deploy x to prod\n")
    p = _ff_rollup(sandbox, "TEST-12", "title: Patch: Deploy x to prod")
    r = _ff_run(sandbox, p, ent)
    assert r.returncode == 0, r.stderr
    assert lib.read_frontmatter(str(p))["title"] == "Patch: Deploy x to prod\n"
    assert len(p.read_text(encoding="utf-8").split("\n")) == 8  # no raw newline split
    ent = _ff_canon(sandbox, "TEST-13", "(AI crawler tracking)\n\n")
    p = _ff_rollup(sandbox, "TEST-13", 'title: "old"')
    assert _ff_run(sandbox, p, ent).returncode == 0
    assert lib.read_frontmatter(str(p))["title"] == "(AI crawler tracking)\n\n"


def test_fix_frontmatter_leaves_equivalent_single_quoted_alone(sandbox):
    # prettier rewrites to single quotes; script must not churn it back
    ent = _ff_canon(sandbox, "TEST-14", 'say "hi": ok')
    p = _ff_rollup(sandbox, "TEST-14", "title: 'say \"hi\": ok'")
    before = p.read_text(encoding="utf-8")
    r = _ff_run(sandbox, p, ent)
    assert r.returncode == 0, r.stderr
    assert p.read_text(encoding="utf-8") == before
    assert "title_quoted=0" in r.stdout


def test_fix_frontmatter_rewrites_when_parsed_differs_from_canon(sandbox):
    ent = _ff_canon(sandbox, "TEST-15", "new title")
    p = _ff_rollup(sandbox, "TEST-15", "title: 'old title'")
    r = _ff_run(sandbox, p, ent)
    assert r.returncode == 0, r.stderr
    assert lib.read_frontmatter(str(p))["title"] == "new title"
    assert "title_quoted=1" in r.stdout


def test_fix_frontmatter_double_run_is_noop(sandbox):
    ent = _ff_canon(sandbox, "TEST-16", 'a "q" \\ b\n: c')
    p = _ff_rollup(sandbox, "TEST-16", "title: x: y")
    assert _ff_run(sandbox, p, ent).returncode == 0
    once = p.read_text(encoding="utf-8")
    r = _ff_run(sandbox, p, ent)
    assert r.returncode == 0 and "title_quoted=0" in r.stdout
    assert p.read_text(encoding="utf-8") == once
    assert lib.read_frontmatter(str(p))["title"] == 'a "q" \\ b\n: c'


def test_fix_frontmatter_nbsp_and_accent_survive_byte_exact(sandbox):
    title = "fix:\u00a0caf\u00e9 \u2014 ok"
    ent = _ff_canon(sandbox, "TEST-17", title)
    p = _ff_rollup(sandbox, "TEST-17", "title: placeholder")
    assert _ff_run(sandbox, p, ent).returncode == 0
    assert lib.read_frontmatter(str(p))["title"] == title
    txt = p.read_text(encoding="utf-8")
    assert "\u00a0" in txt and "\u00e9" in txt      # literal chars, not escapes
    assert _ff_run(sandbox, p).returncode == 0   # no canon this time
    assert p.read_text(encoding="utf-8") == txt


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


# --------------------------------------------------------------------------- #
# integration: flatten_jira
# --------------------------------------------------------------------------- #
def test_flatten_jira_rovo_shape_and_comments(sandbox):
    rovo = {"issues": {"nodes": [{
        "key": "TEST-9", "self": "https://x/issue/1",
        "fields": {
            "summary": "s", "status": {"name": "Done"}, "issuetype": {"name": "Task"},
            "created": "2026-07-16T14:15:29+0200", "updated": "2026-07-16T14:22:55+0200",
            "resolutiondate": "2026-07-16T14:22:54+0200", "description": "d", "labels": [],
            "comment": {"comments": [{"body": "hello"}, {"body": "world"}]},
        },
    }], "pageInfo": {"hasNextPage": False}}}
    (sandbox["tmp"] / "jira_rovo_raw_p1.json").write_text(json.dumps(rovo))
    r = run("flatten_jira.py", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    flat = json.load(open(sandbox["tmp"] / "jira_search_flat.json"))
    assert len(flat["issues"]) == 1
    iss = flat["issues"][0]
    assert iss["key"] == "TEST-9" and iss["summary"] == "s"   # flattened, not nested under fields
    comments = json.load(open(sandbox["tmp"] / "jira_comments_TEST-9.json"))
    assert comments == ["hello", "world"]


def test_flatten_jira_dedups_across_pages(sandbox):
    def page(key):
        return {"issues": {"nodes": [{"key": key, "self": "u", "fields": {
            "summary": "s", "status": {"name": "Done"}, "created": "2026-07-16T00:00:00Z",
            "updated": "2026-07-16T00:00:00Z", "labels": [],
        }}]}}
    (sandbox["tmp"] / "jira_rovo_raw_p1.json").write_text(json.dumps(page("TEST-1")))
    (sandbox["tmp"] / "jira_rovo_raw_p2.json").write_text(json.dumps(page("TEST-1")))
    r = run("flatten_jira.py", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    flat = json.load(open(sandbox["tmp"] / "jira_search_flat.json"))
    assert len(flat["issues"]) == 1                            # first-seen wins, no dup


# --------------------------------------------------------------------------- #
# integration: write_entries
# --------------------------------------------------------------------------- #
def _make_ent(sandbox, eid, kind, title, events, **extra):
    d = {
        "kind": kind, "id": eid, "path": str(sandbox["root"] / f"workspaces/test/tickets/{eid}.md"),
        "exists": False, "title": title, "status": "open", "opened": "2026-07-16",
        "closed": None, "source_url": "https://x/browse/" + eid, "labels": [],
        "complexity": "S", "impact": "med", "last_synced": "2026-07-16T18:30:00Z",
        "events": [],
    }
    d.update(extra)
    for ev in events:
        d["events"].append({
            "event": ev, "ts": "2026-07-16T12:15:29Z", "status": "open",
            "ts_utc": "2026-07-16T12:15:29Z", "date_path": "2026/07/16",
            "fname_prefix": f"20260716_1215_{'ticket' if kind == 'ticket' else 'pr'}_{eid}_",
        })
    (sandbox["tmp"] / "ent").mkdir(parents=True, exist_ok=True)
    json.dump(d, open(sandbox["tmp"] / f"ent/{eid}.json", "w"))
    return d


def test_write_entries_writes_frontmatter_and_body(sandbox):
    _make_ent(sandbox, "TEST-1", "ticket", "fix(x): thing", ["created"])
    r = run("write_entries.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["written"] == 1 and res["skipped_existing"] == 0
    p = sandbox["root"] / "workspaces/test/entries/2026/07/16/20260716_1215_ticket_TEST-1_fix-x-thing.md"
    assert p.exists()
    body = p.read_text()
    assert "id: TEST-1" in body and "event: created" in body and "`TEST-1`" in body


def test_write_entries_idempotent_skips_existing(sandbox):
    _make_ent(sandbox, "TEST-1", "ticket", "fix(x): thing", ["created"])
    run("write_entries.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    r2 = run("write_entries.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    res = json.loads(r2.stdout)
    assert res["written"] == 0 and res["skipped_existing"] == 1


# --------------------------------------------------------------------------- #
# integration: build_chunks
# --------------------------------------------------------------------------- #
def test_build_chunks_stages_existing_timeline_and_notes(sandbox):
    # regen-only entity: zero new events, but a pre-existing rollup with history
    _make_ent(sandbox, "TEST-1", "ticket", "fix(x): thing", [], priority="P1",
              issuetype="Task", description="d", comments=["c1"])
    p = sandbox["root"] / "workspaces/test/tickets/TEST-1.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("---\nid: TEST-1\n---\n## Timeline\n- 2026-07-01: created\n## Notes\nkeep me\n")
    json.dump(["TEST-1"], open(sandbox["tmp"] / "manifest_ids.json", "w"))
    r = run("build_chunks.py", "test", "--tmp", str(sandbox["tmp"]), "--target-size", "5",
            env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    chunk = json.load(open(sandbox["tmp"] / "chunks/chunk_00.json"))
    assert len(chunk) == 1
    rec = chunk[0]
    assert rec["existing_timeline"] == "- 2026-07-01: created"    # gotcha #14: must be staged
    assert rec["existing_notes"] == "keep me"
    assert rec["out_path"] == str(p)


def test_build_chunks_folds_gh_stats_and_caps_chunk_count(sandbox):
    for i in range(40):
        _make_ent(sandbox, f"acme__core__{i}", "pr", "t", ["opened"], repo="acme/core", number=i)
    (sandbox["tmp"] / "gh_merged.json").write_text(json.dumps([
        {"number": i, "repository": {"nameWithOwner": "acme/core"},
         "additions": 10 + i, "deletions": 1, "changedFiles": 2}
        for i in range(40)
    ]))
    json.dump([f"acme__core__{i}" for i in range(40)], open(sandbox["tmp"] / "manifest_ids.json", "w"))
    r = run("build_chunks.py", "test", "--tmp", str(sandbox["tmp"]), "--target-size", "1",
            "--max-chunks", "5", env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["n_chunks"] == 5                                   # capped, not 40
    chunk = json.load(open(sandbox["tmp"] / "chunks/chunk_00.json"))
    ids = {rec["id"]: rec for rec in chunk}
    assert ids["acme__core__0"]["additions"] == 10                # gh stats folded in


# --------------------------------------------------------------------------- #
# integration: merge_pr_detail
# --------------------------------------------------------------------------- #
def test_merge_pr_detail_folds_stats_into_gh_merged(sandbox):
    (sandbox["tmp"] / "gh_merged.json").write_text(json.dumps([
        {"number": 42, "repository": {"nameWithOwner": "acme/core"}, "title": "t"},
    ]))
    (sandbox["tmp"] / "pr_detail").mkdir()
    (sandbox["tmp"] / "pr_detail/acme__core__42.json").write_text(json.dumps(
        {"additions": 50, "deletions": 10, "changedFiles": 3, "mergedAt": "2026-07-16T09:00:00Z"}))
    r = run("merge_pr_detail.py", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["matched"] == 1
    gh = json.load(open(sandbox["tmp"] / "gh_merged.json"))
    assert gh[0]["additions"] == 50 and gh[0]["changedFiles"] == 3


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


# --------------------------------------------------------------------------- #
# integration: build_chunks existing_tags (v1.9.0, task 1011)
# --------------------------------------------------------------------------- #
def test_build_chunks_carries_existing_tags_minus_origin(sandbox):
    _make_ent(sandbox, "TEST-1", "ticket", "fix(x): thing", [], labels=["chore"])
    p = sandbox["root"] / "workspaces/test/tickets/TEST-1.md"
    p.write_text('---\nid: TEST-1\ntags: ["board:DevOps-Team", "chore", "tool:terraform", '
                 '"origin:authored"]\n---\n## Timeline\n- 2026-07-01: created\n## Notes\n\n')
    _make_ent(sandbox, "TEST-2", "ticket", "new", [])                 # no live rollup
    json.dump(["TEST-1", "TEST-2"], open(sandbox["tmp"] / "manifest_ids.json", "w"))
    r = run("build_chunks.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    recs = {x["id"]: x for x in json.load(open(sandbox["tmp"] / "chunks/chunk_00.json"))}
    assert recs["TEST-1"]["existing_tags"] == ["board:DevOps-Team", "chore", "tool:terraform"]
    assert recs["TEST-2"]["existing_tags"] == []
    assert recs["TEST-1"]["existing_timeline"] == "- 2026-07-01: created"   # unchanged behaviour


def test_build_chunks_existing_tags_block_form_and_junk(sandbox):
    _make_ent(sandbox, "TEST-1", "ticket", "t", [])
    p = sandbox["root"] / "workspaces/test/tickets/TEST-1.md"
    p.write_text("---\nid: TEST-1\ntags:\n  - board:Ops\n  - 7\n---\n## Notes\n\n")
    json.dump(["TEST-1"], open(sandbox["tmp"] / "manifest_ids.json", "w"))
    r = run("build_chunks.py", "test", "--tmp", str(sandbox["tmp"]), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    rec = json.load(open(sandbox["tmp"] / "chunks/chunk_00.json"))[0]
    assert rec["existing_tags"] == ["board:Ops", "7"]


# --------------------------------------------------------------------------- #
# integration: merge_gh (v1.9.0, task 945)
# --------------------------------------------------------------------------- #
def _gh_row(n, updated, repo="acme/core", title="t"):
    return {"number": n, "title": title, "url": f"https://github.com/{repo}/pull/{n}",
            "state": "MERGED", "createdAt": "2026-09-01T00:00:00Z", "updatedAt": updated,
            "closedAt": None, "author": {"login": "me"}, "body": "b", "labels": [],
            "repository": {"nameWithOwner": repo}, "commentsCount": 0}


def test_merge_gh_dedups_tags_origin_and_filters_cursor(sandbox):
    tmp = sandbox["tmp"]
    (tmp / "gh_authored.json").write_text(json.dumps([
        _gh_row(1, "2026-09-20T10:00:00Z"), _gh_row(2, "2026-09-21T10:00:00Z"),
        _gh_row(3, "2026-09-10T00:00:00Z")]))           # 3 is older than cursor
    (tmp / "gh_reviewed.json").write_text(json.dumps([
        _gh_row(2, "2026-09-21T10:00:00Z"), _gh_row(4, "2026-09-21T12:36:49Z"),
        _gh_row(5, "2026-09-15T00:00:00Z")]))           # 5 == cursor -> dropped
    r = run("merge_gh.py", "--tmp", str(tmp), "--cursor", "2026-09-15T00:00:00Z",
            env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["total_unique"] == 5 and res["kept"] == 3
    assert res["origin_counts"] == {"authored": 1, "reviewed": 1, "both": 1}
    assert res["max_updated_at"] == "2026-09-21T12:36:49Z"
    out = {p["number"]: p for p in json.load(open(tmp / "gh_merged.json"))}
    assert set(out) == {1, 2, 4}
    assert out[1]["origin"] == "authored" and out[2]["origin"] == "both"
    assert out[4]["origin"] == "reviewed"


def test_merge_gh_reads_cursor_from_last_sync(sandbox):
    tmp = sandbox["tmp"]
    (sandbox["root"] / ".ledger/last_sync.json").write_text(json.dumps(
        {"workspaces": {"test": {"github_updated_after": "2026-09-20T00:00:00Z"}}}))
    (tmp / "gh_authored.json").write_text(json.dumps([
        _gh_row(1, "2026-09-19T00:00:00Z"), _gh_row(2, "2026-09-21T00:00:00Z")]))
    r = run("merge_gh.py", "test", "--tmp", str(tmp), env=sandbox["env"])   # no reviewed file
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["cursor"] == "2026-09-20T00:00:00Z" and res["kept"] == 1
    assert [p["number"] for p in json.load(open(tmp / "gh_merged.json"))] == [2]


def test_merge_gh_no_cursor_keeps_all(sandbox):
    tmp = sandbox["tmp"]
    (tmp / "gh_reviewed.json").write_text(json.dumps([_gh_row(1, "2026-01-01T00:00:00Z")]))
    r = run("merge_gh.py", "--tmp", str(tmp), env=sandbox["env"])
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res["kept"] == 1 and res["cursor"] is None


# --------------------------------------------------------------------------- #
# integration: fetch_pr_detail.sh (v1.9.0, task 945) — stub gh, no network
# --------------------------------------------------------------------------- #
GH_STUB = r"""#!/usr/bin/env bash
# fake gh: `pr view N --repo R --json ...` and `api repos/R/pulls/N/comments --jq ...`
if [ -n "$GH_TOKEN" ]; then echo "bad token" >&2; exit 4; fi
if [ "$1" = pr ]; then
  n=$3
  [ "$n" = 99 ] && { echo "boom" >&2; exit 1; }
  echo "{\"additions\": $n, \"deletions\": 1, \"changedFiles\": 2, \"mergedAt\": null, \"mergeCommit\": null}"
elif [ "$1" = api ]; then
  echo '[{"user":"rev","body":"lgtm","created_at":"2026-09-21T00:00:00Z"}]'
fi
"""


def run_sh(script, *args, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run(["bash", os.path.join(SCRIPTS, script), *args],
                          capture_output=True, text=True, env=e)


def _stub_gh(tmp_path):
    stub = tmp_path / "gh_stub"
    stub.write_text(GH_STUB)
    stub.chmod(0o755)
    return stub


def test_fetch_pr_detail_writes_files_in_parallel(sandbox, tmp_path):
    stub = _stub_gh(tmp_path)
    tmp = sandbox["tmp"]
    (tmp / "gh_merged.json").write_text(json.dumps(
        [_gh_row(n, "2026-09-21T00:00:00Z", repo="acme/core") for n in (1, 2, 3)]
        + [_gh_row(7, "2026-09-21T00:00:00Z", repo="acme/web")]))
    # multi-word GH_BIN is the documented workaround for a set-but-invalid GH_TOKEN
    r = run_sh("fetch_pr_detail.sh", "--tmp", str(tmp), "-P", "3",
               env={"GH_BIN": f"env -u GH_TOKEN {stub}", "GH_TOKEN": "invalid"})
    assert r.returncode == 0, r.stderr + r.stdout
    res = json.loads(r.stdout)
    assert res["prs"] == 4 and res["detail_written"] == 4 and res["reviews_written"] == 4
    assert res["failed"] == []
    d = json.load(open(tmp / "pr_detail/acme__web__7.json"))
    assert d["additions"] == 7
    rv = json.load(open(tmp / "pr_reviews/acme__core__2.json"))
    assert rv[0]["user"] == "rev"


def test_fetch_pr_detail_reports_failures_nonzero(sandbox, tmp_path):
    stub = _stub_gh(tmp_path)
    tmp = sandbox["tmp"]
    (tmp / "gh_merged.json").write_text(json.dumps(
        [_gh_row(1, "2026-09-21T00:00:00Z"), _gh_row(99, "2026-09-21T00:00:00Z")]))
    r = run_sh("fetch_pr_detail.sh", "--tmp", str(tmp), env={"GH_BIN": str(stub), "GH_TOKEN": ""})
    assert r.returncode != 0
    res = json.loads(r.stdout)
    assert res["detail_written"] == 1
    assert any("acme/core#99" in f and "detail" in f for f in res["failed"])
    assert not (tmp / "pr_detail/acme__core__99.json").exists()     # no empty leftovers


# --------------------------------------------------------------------------- #
# integration: verify_rollups (v1.9.0) — temp git repo as the baseline
# --------------------------------------------------------------------------- #
NOW = "2026-09-21T14:19:51Z"
SECTIONS = ["Summary", "Why it mattered", "Complexity", "Challenges", "Impact", "Timeline", "Notes"]


def _rollup_text(eid, title_line, tags_line, timeline, notes="", last_synced=f'"{NOW}"',
                 closed="2026-09-20", pending="false", sections=None, empty=()):
    fm = (f"---\nid: {eid}\nworkspace: test\ntype: ticket\n{title_line}\nstatus: done\n"
          f"opened: 2026-09-01\nclosed: {closed}\ncomplexity: S\nimpact: low\nchallenges: []\n"
          f"{tags_line}\nlast_synced: {last_synced}\nenrichment_pending: {pending}\n---\n")
    body = ""
    for s in (sections or SECTIONS):
        if s == "Timeline":
            content = "\n".join(timeline)
        elif s == "Notes":
            content = notes
        else:
            content = "" if s in empty else f"{s} text."
        body += f"## {s}\n\n{content}\n\n"
    return fm + body


def _git(root, *args):
    subprocess.run(["git", "-C", str(root), "-c", "user.email=t@t", "-c", "user.name=t",
                    "-c", "commit.gpgsign=false", *args],
                   check=True, capture_output=True, text=True)


@pytest.fixture
def git_sandbox(sandbox):
    root = sandbox["root"]
    _git(root, "init", "-q")
    return sandbox


def _baseline(sb, files):
    root = sb["root"]
    for eid, txt in files.items():
        (root / f"workspaces/test/tickets/{eid}.md").write_text(txt)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "baseline")
    return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                          capture_output=True, text=True).stdout.strip()


def _chunk(sb, recs):
    (sb["tmp"] / "chunks").mkdir(exist_ok=True)
    out = []
    for eid, title in recs:
        out.append({"id": eid, "title": title, "last_synced": NOW,
                    "out_path": str(sb["root"] / f"workspaces/test/tickets/{eid}.md")})
    json.dump(out, open(sb["tmp"] / "chunks/chunk_00.json", "w"))


def _verify(sb, base, *extra):
    r = run("verify_rollups.py", "test", "--baseline", base, "--tmp", str(sb["tmp"]),
            *extra, env=sb["env"])
    try:
        return r, json.loads(r.stdout)
    except ValueError:
        raise AssertionError(r.stdout + r.stderr)


def test_verify_rollups_clean_passes(git_sandbox):
    sb = git_sandbox
    old = _rollup_text("T-1", 'title: "a b"', 'tags: ["board:Ops"]', ["- 2026-09-01: created"],
                       notes="keep", last_synced='"2026-09-01T00:00:00Z"')
    base = _baseline(sb, {"T-1": old})
    new = _rollup_text("T-1", 'title: "a b"', 'tags: ["board:Ops", "x"]',
                       ["- 2026-09-01: created", "- 2026-09-20: closed"], notes="keep")
    (sb["root"] / "workspaces/test/tickets/T-1.md").write_text(new)
    _chunk(sb, [("T-1", "a b")])
    r, rep = _verify(sb, base, "--now", NOW)
    assert r.returncode == 0, rep
    assert rep["checked"] == 1 and rep["failures"] == {}


def test_verify_rollups_detects_every_failure_class(git_sandbox):
    sb = git_sandbox
    old = _rollup_text("T-1", 'title: "Réunion plan"', 'tags: ["board:Ops", "y"]',
                       ["- 2026-09-01: created", "- 2026-09-05: status-changed"], notes="keep")
    base = _baseline(sb, {"T-1": old})
    tdir = sb["root"] / "workspaces/test/tickets"
    # T-1: title "fixed", board tag lost, timeline bullet lost, notes edited
    (tdir / "T-1.md").write_text(_rollup_text(
        "T-1", 'title: "Reunion plan"', 'tags: ["y"]', ["- 2026-09-01: created"], notes="edited"))
    # T-2: unquoted last_synced, sentinel closed, pending, empty Impact
    (tdir / "T-2.md").write_text(_rollup_text(
        "T-2", 'title: "two"', "tags: []", ["- x"], last_synced=NOW, closed="0001-01-01",
        pending="true", empty=("Impact",)))
    # T-3: headings out of order; T-4: unparseable; T-5: missing
    (tdir / "T-3.md").write_text(_rollup_text("T-3", 'title: "three"', "tags: []", ["- x"],
                                              sections=["Summary", "Timeline", "Notes"]))
    (tdir / "T-4.md").write_text('---\ntitle: a: b: [\n---\n## Summary\n')
    _chunk(sb, [("T-1", "Réunion plan"), ("T-2", "two"), ("T-3", "three"),
                ("T-4", "four"), ("T-5", "five")])
    r, rep = _verify(sb, base, "--now", NOW)
    assert r.returncode == 1
    f = {k: v["ids"] for k, v in rep["failures"].items()}
    assert f["title_mismatch"] == ["T-1"]
    assert f["board_tags_lost"] == ["T-1"]
    assert f["timeline_lost"] == ["T-1"]
    assert f["notes_changed"] == ["T-1"]
    assert f["last_synced_unquoted"] == ["T-2"]
    assert f["closed_sentinel"] == ["T-2"]
    assert f["enrichment_pending"] == ["T-2"]
    assert f["empty_sections"] == ["T-2"]
    assert f["bad_headings"] == ["T-3"]
    assert f["unparseable"] == ["T-4"]
    assert f["missing"] == ["T-5"]
    assert rep["failures"]["board_tags_lost"]["count"] == 1


def test_verify_rollups_now_from_tmp_file(git_sandbox):
    sb = git_sandbox
    (sb["root"] / "README").write_text("x")
    _git(sb["root"], "add", "-A"); _git(sb["root"], "commit", "-q", "-m", "init")
    base = "HEAD"
    (sb["root"] / "workspaces/test/tickets/T-9.md").write_text(_rollup_text(
        "T-9", 'title: "n"', "tags: []", ["- x"], last_synced='"2026-01-01T00:00:00Z"'))
    _chunk(sb, [("T-9", "n")])
    (sb["tmp"] / "NOW").write_text("2026-01-01T00:00:00Z\n")
    r, rep = _verify(sb, base)
    assert r.returncode == 0, rep                                     # new rollup, no baseline


def test_verify_rollups_fix_board_tags_flow_and_block(git_sandbox):
    sb = git_sandbox
    tl = ["- 2026-09-01: created"]
    base = _baseline(sb, {
        "T-1": _rollup_text("T-1", 'title: "a"', 'tags: ["board:Ops", "board:Dev"]', tl),
        "T-2": _rollup_text("T-2", 'title: "b"', "tags:\n  - board:Ops", tl),
        "T-3": _rollup_text("T-3", 'title: "c"', 'tags: ["board:Ops"]', tl)})
    tdir = sb["root"] / "workspaces/test/tickets"
    (tdir / "T-1.md").write_text(_rollup_text("T-1", 'title: "a"', 'tags: ["x", board:Dev]', tl))
    (tdir / "T-2.md").write_text(_rollup_text("T-2", 'title: "b"', "tags:\n  - x\n  - y", tl))
    (tdir / "T-3.md").write_text(_rollup_text("T-3", 'title: "c"', "tags: []", tl))
    _chunk(sb, [("T-1", "a"), ("T-2", "b"), ("T-3", "c")])
    r, rep = _verify(sb, base, "--now", NOW, "--fix-board-tags")
    assert r.returncode == 0, rep
    assert sorted(rep["fixed"]["board_tags"]) == ["T-1", "T-2", "T-3"]
    fm = lambda eid: lib.read_frontmatter(str(tdir / f"{eid}.md"))  # noqa: E731
    assert fm("T-1")["tags"] == ["x", "board:Dev", "board:Ops"]
    assert fm("T-2")["tags"] == ["x", "y", "board:Ops"]
    assert fm("T-3")["tags"] == ["board:Ops"]
    assert "## Summary" in (tdir / "T-2.md").read_text()                # body untouched


def test_verify_rollups_fix_titles_restores_baseline_line(git_sandbox):
    sb = git_sandbox
    title = "Réunion plan: q3"
    old_line = 'title: "Réunion plan: q3"'
    tl = ["- 2026-09-01: created"]
    base = _baseline(sb, {"T-1": _rollup_text("T-1", old_line, "tags: []", tl)})
    p = sb["root"] / "workspaces/test/tickets/T-1.md"
    p.write_text(_rollup_text("T-1", "title: 'Reunion plan: Q3'", "tags: []", tl))
    _chunk(sb, [("T-1", title)])
    r, rep = _verify(sb, base, "--now", NOW, "--fix-titles")
    assert r.returncode == 0, rep
    assert rep["fixed"]["titles"] == ["T-1"]
    assert old_line in p.read_text()
    assert lib.read_frontmatter(str(p))["title"] == title


def test_verify_rollups_quoted_but_stale_last_synced_is_its_own_class(git_sandbox):
    sb = git_sandbox
    (sb["root"] / "README").write_text("x")
    _git(sb["root"], "add", "-A"); _git(sb["root"], "commit", "-q", "-m", "init")
    (sb["root"] / "workspaces/test/tickets/T-8.md").write_text(_rollup_text(
        "T-8", 'title: "s"', "tags: []", ["- x"], last_synced='"2026-01-01T00:00:00Z"'))
    _chunk(sb, [("T-8", "s")])
    r, rep = _verify(sb, "HEAD", "--now", NOW)
    assert r.returncode == 1
    assert list(rep["failures"]) == ["last_synced_stale"]          # quoted, wrong value
    assert rep["failures"]["last_synced_stale"]["sample"]["T-8"]["want"] == NOW
