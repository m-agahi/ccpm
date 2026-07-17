#!/usr/bin/env python3
"""fix_frontmatter.py — guard against unquoted-colon YAML in rollups.

Haiku composer agents reliably emit `title: chore(FOO-1): bar` — a colon in an
unquoted YAML scalar, which makes the whole frontmatter unparseable and silently
breaks summary regen, exports, and the next sync's index. This pass re-quotes the
`title:` scalar of every named rollup (idempotent) and then verifies the whole
frontmatter parses. Run it right after the composer agents return, before the
index/summary steps (SKILL.md §7).

Usage:
  fix_frontmatter.py [--ent-dir DIR] <file-or-glob> [<file-or-glob> ...]
"""
import os, sys, glob, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import read_frontmatter


def canonical_titles(ent_dir):
    import json
    out = {}
    if ent_dir and os.path.isdir(ent_dir):
        for f in glob.glob(f"{ent_dir}/*.json"):
            try:
                d = json.load(open(f))
                out[d["id"]] = d["title"]
            except Exception:
                pass
    return out


def quote_title(path, canon):
    lines = open(path, encoding="utf-8").read().split("\n")
    if not lines or lines[0].strip() != "---":
        return False
    end = next((k for k in range(1, len(lines)) if lines[k].strip() == "---"), None)
    if end is None:
        return False
    changed = False
    for k in range(1, end):
        if lines[k].startswith("title:"):
            cur = lines[k][6:].strip()
            if (cur.startswith('"') and cur.endswith('"')) or (cur.startswith("'") and cur.endswith("'")):
                inner = cur[1:-1]
            else:
                inner = cur
            fid = None
            for j in range(1, end):
                if lines[j].startswith("id:"):
                    fid = lines[j][3:].strip().strip('"\'')
                    break
            title = canon.get(fid, inner)
            esc = str(title).replace("\\", "\\\\").replace('"', '\\"')
            new = f'title: "{esc}"'
            if lines[k] != new:
                lines[k] = new
                changed = True
            break
    if changed:
        open(path, "w", encoding="utf-8").write("\n".join(lines))
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ent-dir", default="/tmp/ledger-sync/ent")
    ap.add_argument("targets", nargs="+")
    a = ap.parse_args()
    canon = canonical_titles(a.ent_dir)
    files = []
    for t in a.targets:
        files += glob.glob(t) if any(c in t for c in "*?[") else [t]
    fixed = bad = 0
    for p in files:
        if not os.path.exists(p):
            continue
        if quote_title(p, canon):
            fixed += 1
        if read_frontmatter(p) is None:
            bad += 1
            print("STILL UNPARSEABLE:", p, file=sys.stderr)
    print(f"files={len(files)} title_quoted={fixed} still_bad={bad}")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
