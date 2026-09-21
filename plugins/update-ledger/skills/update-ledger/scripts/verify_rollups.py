#!/usr/bin/env python3
"""verify_rollups.py — post-composer rollup verifier (SKILL.md §7, after fix_frontmatter.py).

Composer agents write rollups straight to their live `out_path`. This pass
checks every record staged in `<tmp>/chunks/chunk_*.json` against what the
agent actually wrote, and against the pre-sync version of the same file in git
(`--baseline <commit>`, normally the ledger HEAD from before the sync):

  missing              out_path does not exist
  unparseable          frontmatter missing or not valid YAML
  enrichment_pending   `enrichment_pending` is not False
  last_synced_unquoted `last_synced:` missing or not double-quoted
  last_synced_stale    quoted, but the value is not NOW (wrong --now, or the
                       composer copied an old value)
  closed_sentinel      `closed` is 0001-01-01
  bad_headings         body `## ` headings are not exactly Summary .. Notes in order
  empty_sections       a section other than Notes is empty
  title_mismatch       frontmatter title != record title, byte for byte
                       (composers "fix" typos and strip NBSP)
  timeline_lost        a baseline `## Timeline` bullet is gone
  board_tags_lost      a baseline `board:*` tag is gone from `tags`
                       (unrecoverable from source — the board pass is off)
  notes_changed        `## Notes` body differs from baseline

A rollup that does not exist at the baseline skips the three baseline checks.

NOW = `--now`, else the `<tmp>/NOW` file (operator override), else each
record's own `last_synced`.

Fixers (text edits in place, never a YAML re-dump; checks re-run afterwards
and the exit code reflects what is still broken):
  --fix-board-tags  re-add lost baseline `board:*` tags to the `tags:` line
                    (flow `tags: [a, b]` or block `tags:\\n  - a` form)
  --fix-titles      restore the baseline's raw `title:` line when it parses to
                    the record title; else write the record title double-quoted

Prints a JSON report (per failure class: count + capped id list + sample
detail); exits 1 on any remaining failure.

Usage:
  verify_rollups.py <workspace> --baseline <commit> [--tmp DIR] [--now ISO]
                    [--fix-board-tags] [--fix-titles] [--cap N]
"""
import os, re, sys, json, glob, argparse, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import ledger_root

HEADINGS = ["Summary", "Why it mattered", "Complexity", "Challenges", "Impact", "Timeline", "Notes"]
FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)


def split_fm(txt):
    """(raw frontmatter text, parsed dict or None, body). raw is None if no fence."""
    import yaml
    m = FM_RE.match(txt)
    if not m:
        return None, None, txt
    try:
        d = yaml.safe_load(m.group(1))
    except Exception:
        d = None
    return m.group(1), (d if isinstance(d, dict) else None), txt[m.end():]


def sections(body):
    parts = re.split(r"^## (.+)$", body, flags=re.M)
    return [(parts[i].strip(), parts[i + 1]) for i in range(1, len(parts), 2)]


def bullets(text):
    return {l.strip() for l in (text or "").split("\n") if l.strip().startswith("- ")}


def tag_list(fm):
    t = (fm or {}).get("tags")
    if t is None:
        return []
    return [str(x) for x in (t if isinstance(t, list) else [t]) if x is not None]


def git_show(root, baseline, rel):
    r = subprocess.run(["git", "-C", root, "show", f"{baseline}:{rel}"],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def resolve_now(a):
    if a.now:
        return a.now
    p = os.path.join(a.tmp, "NOW")
    if os.path.exists(p):
        v = open(p).read().strip()
        if v:
            return v
    return None


# --------------------------------------------------------------------------- #
# fixers (text edits on the frontmatter lines only)
# --------------------------------------------------------------------------- #
def _q(s):
    return json.dumps(s, ensure_ascii=False)


def fm_bounds(lines):
    if not lines or lines[0] != "---":
        return None
    return next((k for k in range(1, len(lines)) if lines[k] == "---"), None)


def add_tags(txt, missing):
    lines = txt.split("\n")
    end = fm_bounds(lines)
    if end is None:
        return txt
    k = next((i for i in range(1, end) if re.match(r"^tags:", lines[i])), None)
    add = [_q(t) for t in missing]
    if k is None:
        lines.insert(end, f"tags: [{', '.join(add)}]")
        return "\n".join(lines)
    rest = lines[k][5:].strip()
    if rest.startswith("["):
        j = k
        while "]" not in lines[j] and j + 1 < end:
            j += 1
        line = lines[j]
        cut = line.rfind("]")
        inner_empty = re.fullmatch(r"tags:\s*\[\s*", line[:cut]) is not None
        sep = "" if inner_empty else ", "
        lines[j] = line[:cut].rstrip() + sep + ", ".join(add) + line[cut:]
        return "\n".join(lines)
    if rest == "":
        j = k + 1
        indent = "  "
        while j < end and re.match(r"^\s+-", lines[j]):
            indent = re.match(r"^(\s+)-", lines[j]).group(1)
            j += 1
        for t in reversed(add):
            lines.insert(j, f"{indent}- {t}")
        return "\n".join(lines)
    # scalar `tags: foo` — rewrite as a flow list
    lines[k] = f"tags: [{', '.join([_q(rest)] + add)}]"
    return "\n".join(lines)


def set_title_line(txt, new_line):
    lines = txt.split("\n")
    end = fm_bounds(lines)
    if end is None:
        return txt
    for i in range(1, end):
        if re.match(r"^title:", lines[i]):
            j = i + 1   # drop folded continuation lines of a multi-line scalar
            while j < end and re.match(r"^\s+\S", lines[j]):
                j += 1
            lines[i:j] = [new_line]
            return "\n".join(lines)
    lines.insert(end, new_line)
    return "\n".join(lines)


def raw_title_line(raw_fm):
    ls = raw_fm.split("\n")
    for i, l in enumerate(ls):
        if l.startswith("title:"):
            j = i + 1
            while j < len(ls) and re.match(r"^\s+\S", ls[j]):
                j += 1
            return "\n".join(ls[i:j])
    return None


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #
def check(rec, now, root, baseline):
    """Return (failures: {class: detail}, context for fixers)."""
    fails = {}
    path = rec["out_path"]
    if not os.path.exists(path):
        return {"missing": path}, None
    txt = open(path, encoding="utf-8").read()
    raw, fm, body = split_fm(txt)
    if fm is None:
        return {"unparseable": path}, None

    if fm.get("enrichment_pending") is not False:
        fails["enrichment_pending"] = fm.get("enrichment_pending")
    want_now = now or rec.get("last_synced")
    if want_now and f'last_synced: "{want_now}"' not in raw.split("\n"):
        line = next((l for l in raw.split("\n") if l.startswith("last_synced:")), None)
        if line and re.fullmatch(r'last_synced: "[^"]*"\s*', line):
            fails["last_synced_stale"] = {"got": line, "want": want_now}
        else:
            fails["last_synced_unquoted"] = line
    if str(fm.get("closed")) == "0001-01-01":
        fails["closed_sentinel"] = str(fm.get("closed"))
    secs = sections(body)
    heads = [h for h, _ in secs]
    if heads != HEADINGS:
        fails["bad_headings"] = heads
    empty = [h for h, b in secs if h != "Notes" and not b.strip()]
    if empty:
        fails["empty_sections"] = empty
    if fm.get("title") != rec.get("title"):
        fails["title_mismatch"] = {"got": fm.get("title"), "want": rec.get("title")}

    ctx = {"txt": txt, "base_raw": None, "base_fm": None, "lost_board": []}
    rel = os.path.relpath(path, root)
    old = git_show(root, baseline, rel) if not rel.startswith("..") else None
    if old is not None:
        o_raw, o_fm, o_body = split_fm(old)
        ctx["base_raw"], ctx["base_fm"] = o_raw, o_fm
        new_secs, old_secs = dict(secs), dict(sections(o_body))
        lost = sorted(bullets(old_secs.get("Timeline")) - bullets(new_secs.get("Timeline")))
        if lost:
            fails["timeline_lost"] = lost
        now_tags = set(tag_list(fm))
        lost_b = [t for t in tag_list(o_fm) if t.startswith("board:") and t not in now_tags]
        if lost_b:
            fails["board_tags_lost"] = lost_b
            ctx["lost_board"] = lost_b
        if (old_secs.get("Notes") or "").strip() != (new_secs.get("Notes") or "").strip():
            fails["notes_changed"] = True
    return fails, ctx


def apply_fixes(rec, fails, ctx, a, fixed):
    if ctx is None:
        return
    txt = ctx["txt"]
    new = txt
    if a.fix_board_tags and ctx["lost_board"]:
        new = add_tags(new, ctx["lost_board"])
        fixed["board_tags"].append(rec["id"])
    if a.fix_titles and "title_mismatch" in fails:
        line = None
        if ctx["base_fm"] is not None and ctx["base_fm"].get("title") == rec.get("title"):
            line = raw_title_line(ctx["base_raw"])
        new = set_title_line(new, line or f"title: {_q(rec.get('title'))}")
        fixed["titles"].append(rec["id"])
    if new != txt:
        open(rec["out_path"], "w", encoding="utf-8").write(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace")
    ap.add_argument("--baseline", required=True,
                    help="ledger commit from before the sync (e.g. the pre-sync HEAD)")
    ap.add_argument("--tmp", default="/tmp/ledger-sync")
    ap.add_argument("--now", default=None, help="expected last_synced value (UTC ...Z)")
    ap.add_argument("--fix-board-tags", action="store_true")
    ap.add_argument("--fix-titles", action="store_true")
    ap.add_argument("--cap", type=int, default=20, help="max ids listed per failure class")
    a = ap.parse_args()
    root = ledger_root()
    now = resolve_now(a)

    records = []
    for f in sorted(glob.glob(f"{a.tmp}/chunks/chunk_*.json")):
        records.extend(json.load(open(f)))
    if not records:
        raise SystemExit(f"no records in {a.tmp}/chunks/chunk_*.json")

    fixed = {"board_tags": [], "titles": []}
    results = {}
    for rec in records:
        fails, ctx = check(rec, now, root, a.baseline)
        if fails and (a.fix_board_tags or a.fix_titles):
            apply_fixes(rec, fails, ctx, a, fixed)
            fails, _ = check(rec, now, root, a.baseline)
        results[rec["id"]] = fails

    classes = {}
    for eid, fails in results.items():
        for cls, detail in fails.items():
            c = classes.setdefault(cls, {"count": 0, "ids": [], "sample": {}})
            c["count"] += 1
            if len(c["ids"]) < a.cap:
                c["ids"].append(eid)
            if len(c["sample"]) < 3:
                c["sample"][eid] = detail
    report = {"workspace": a.workspace, "checked": len(records), "baseline": a.baseline,
              "now": now, "failures": dict(sorted(classes.items()))}
    if a.fix_board_tags or a.fix_titles:
        report["fixed"] = fixed
    print(json.dumps(report, indent=1, ensure_ascii=False, default=str))
    sys.exit(1 if classes else 0)


if __name__ == "__main__":
    main()
