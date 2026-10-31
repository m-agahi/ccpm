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
import os, sys, glob, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ledger_lib import read_frontmatter


def canonical_titles(ent_dir):
    out = {}
    if ent_dir and os.path.isdir(ent_dir):
        for f in glob.glob(f"{ent_dir}/*.json"):
            try:
                d = json.load(open(f))
                out[d["id"]] = d["title"]
            except Exception:
                pass
    return out


def _parse_scalar(cur):
    """Decode a YAML scalar line value to str, or None when it does not parse to a string."""
    import yaml
    try:
        v = yaml.safe_load("t: " + cur)
        v = v["t"] if isinstance(v, dict) else None
    except Exception:
        return None
    return v if isinstance(v, str) else None


def _dump_scalar(title):
    """Emit a YAML double-quoted scalar; non-ASCII stays literal, controls are escaped."""
    out = json.dumps(title, ensure_ascii=False)
    # json leaves these raw; PyYAML treats them as line breaks / non-printable
    return (out.replace("\x7f", "\\x7f").replace("\x85", "\\x85")
               .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


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
            parsed = _parse_scalar(cur)
            fid = None
            for j in range(1, end):
                if lines[j].startswith("id:"):
                    fid = lines[j][3:].strip().strip('"\'')
                    break
            if fid in canon:
                title = str(canon[fid])
            elif parsed is not None:
                title = parsed
            else:
                title = cur  # unquoted and unparseable: keep the raw text
            if parsed == title:
                break  # existing scalar already decodes to the target: leave it
            new = "title: " + _dump_scalar(title)
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
