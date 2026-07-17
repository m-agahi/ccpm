"""Shared helpers for update-ledger deterministic scripts.

These scripts own the MECHANICAL, error-prone parts of a sync that the skill
used to do by hand (and got wrong): timezone conversion, event detection,
slug sanitisation, SQLite upsert, summary aggregation, frontmatter guarding.

Prose composition (rollup Summary/Why/Impact, note bodies) stays with haiku
agents — see SKILL.md §1.5. Scripts = mechanics; agents = writing.

All scripts resolve the ledger root from $LEDGER_HOME (SKILL.md §2).
"""
import os, re, json, sqlite3
from datetime import datetime, timezone


def ledger_root():
    root = os.environ.get("LEDGER_HOME")
    if not root:
        raise SystemExit("LEDGER_HOME is not set (see SKILL.md §2).")
    if not os.path.isdir(root):
        raise SystemExit(f"LEDGER_HOME={root} does not exist.")
    return root


# ---------------------------------------------------------------------------
# frontmatter
# ---------------------------------------------------------------------------
def read_frontmatter(path):
    """Return the parsed YAML frontmatter dict of a markdown file, or None.

    Frontmatter is canon (SKILL.md §1.5.1) — always parse it, never trust a
    manifest. Uses PyYAML; tolerant of a missing closing fence.
    """
    import yaml
    try:
        txt = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        return None
    if not txt.startswith("---"):
        return None
    end = txt.find("\n---", 3)
    if end < 0:
        return None
    try:
        return yaml.safe_load(txt[3:end])
    except Exception:
        return None


def extract_sections(path, heads):
    """Return {head: body_text} for the named '## <head>' sections of a file.

    Used to preserve ## Notes / ## Narrative verbatim across regeneration
    (SKILL.md §8, §10 preservation rule). Missing file/section → "".
    """
    out = {h: "" for h in heads}
    if not os.path.exists(path):
        return out
    lines = open(path, encoding="utf-8").read().split("\n")
    idx = [(i, l) for i, l in enumerate(lines) if l.startswith("## ")]
    for k, (i, l) in enumerate(idx):
        h = l[3:].strip()
        if h in heads:
            end = idx[k + 1][0] if k + 1 < len(idx) else len(lines)
            out[h] = "\n".join(lines[i + 1:end]).strip()
    return out


# ---------------------------------------------------------------------------
# slug (SKILL.md §6 — skill is the single source of truth, never the agent)
# ---------------------------------------------------------------------------
def slugify(title):
    # lowercase ASCII only (transliterate-by-drop), then any run of
    # non-[a-z0-9] -> single '-'. This strips parens/colons/commas/etc that the
    # elaborate SKILL §6 char list left behind, matching observed filenames
    # (e.g. "chore(x): bump" -> "chore-x-bump").
    s = (title or "").encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    # truncate to 40, cut at last '-' boundary if possible
    if len(s) > 40:
        s = s[:40]
        if "-" in s:
            s = s[:s.rfind("-")]
    s = s.strip("-")
    return s or "untitled"


# ---------------------------------------------------------------------------
# time
# ---------------------------------------------------------------------------
def to_utc(iso):
    """Parse an ISO8601 ts (any offset) → aware UTC datetime. SKILL.md: all
    entry timestamps are UTC. Hand tz-math is the classic silent break."""
    return datetime.fromisoformat(iso).astimezone(timezone.utc)


def utc_iso(iso):
    return to_utc(iso).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_status(s):
    s = (s or "").strip().lower()
    if s in ("done", "closed", "resolved", "merged"):
        return "merged" if s == "merged" else "done"
    if s in ("in progress", "in-progress"):
        return "in-progress"
    if s in ("to do", "to-do"):
        return "to-do"
    if s == "backlog":
        return "backlog"
    return s


# ---------------------------------------------------------------------------
# sqlite (SKILL.md §12)
# ---------------------------------------------------------------------------
def db_connect():
    db = os.path.join(ledger_root(), ".ledger", "index.sqlite")
    conn = sqlite3.connect(db)
    conn.execute("""CREATE TABLE IF NOT EXISTS entities(
        id TEXT, workspace TEXT, type TEXT, title TEXT, status TEXT,
        opened TEXT, closed TEXT, complexity TEXT, impact TEXT, tags TEXT,
        last_synced TEXT, PRIMARY KEY(workspace,id))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, workspace TEXT,
        event TEXT, ts TEXT, file TEXT)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(workspace,status)")
    return conn


def old_status_map(conn, workspace):
    """Existing entity id -> stored status/complexity/impact (for event
    detection + enrichment preservation). Replaces hand-transcribed maps."""
    out = {}
    for r in conn.execute(
        "SELECT id,status,complexity,impact FROM entities WHERE workspace=?",
        (workspace,)):
        out[r[0]] = {"status": r[1], "complexity": r[2], "impact": r[3]}
    return out
