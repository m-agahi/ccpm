#!/usr/bin/env python3
"""Check the shape of a plan-task Fleet brief (fleet 6.2.0, ledger 2058, ADR-1219).

    python3 -I brief_check.py [--repo DIR] [--allow-open] FILE|-
    python3 -I brief_check.py --classify-paths JSON      (tests: the IaC and hook rules)

Prints one JSON object {ok, errors: [{check, line, detail}], warnings: [...], repo}.
Exit 0: the brief passes. Exit 1: at least one error. Exit 2: usage or read error.

The check covers only what the text can show: the marker, the headings, one
owner/repo (and, with --repo, that the checkout's origin is that repo), a
Given/When/Then example on each behaviour, no command text, no IaC or hook
path outside "Out of plan", no open decision, no invisible character. It
never decides that a brief is buildable: plan mode (planner and plan-audit)
does. The brief is data: this program never runs anything it names.

This file lives under skills/plan-task/, never in scripts/ or roles/: the
workflow's preflight refuses an unknown file there. The IaC and hook rules are
copies of isIacPath and HOOK_PATH_RE in workflows/build-task-run.js; the
6.2.0 T2 test compares both on a fixed path list.
"""

import json
import os
import re
import subprocess
import sys
import unicodedata

MAX_BYTES = 65536
MARKER = "<!-- fleet-brief:v1 -->"
TOP = "## Fleet brief (plan-task, "
# the seven section headings, in order (prefix match)
HEADINGS = (
    "### Outcome",
    "### Behaviours",
    "### Rulings",
    "### Draft by plan-task",
    "### Non-goals",
    "### Open decisions",
    "### Out of plan",
)
OUT_OF_PLAN = "### Out of plan"

# --- copied from build-task-run.js (normPath, isIacPath, HOOK_PATH_RE) ---
IAC_TF = "terra" + "form"
IAC_EXT = re.compile(r"\.(tf|tofu|tf\.json|tofu\.json|tfvars|tfvars\.json|tofuvars|tofuvars\.json|hcl|hcl\.json|tfbackend)\Z")
IAC_NAMES = ("." + IAC_TF + "rc", "." + IAC_TF + "-version", ".open" + "to" + "fu-version", "." + "to" + "fu-version", "atlan" + "tis.yaml", "atlan" + "tis.yml")
IAC_ORCH = re.compile("dig" + r"ger\.ya?ml\Z")
HOOK_PATH_RE = re.compile(
    r"(\.pre-commit-config\.yaml|\.pre-commit-hooks\.yaml|\.gitlab-ci\.yml|jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.woodpecker[^/]*"
    r"|(\.github|\.gitea|\.forgejo|\.circleci|\.gitlab|\.buildkite|\.husky|\.githooks|\.woodpecker)/.*"
    r"|(.*/)?lefthook[^/]*\.ya?ml|\.lefthook[^/]*(/.*)?|(.*/)?atlan" r"tis\.ya?ml)\Z",
    re.IGNORECASE,
)


def norm_path(p):
    s = str(p).strip()
    while s.startswith("./"):
        s = s[2:]
    return re.sub(r"/+\Z", "", s)


def is_iac_path(p):
    segs = norm_path(p).lower().split("/")
    b = segs[-1]
    if any(x in ("." + IAC_TF, IAC_TF + ".d", "." + IAC_TF + ".d") for x in segs):
        return True
    if ".spacelift" in segs[:-1]:
        return True
    if IAC_EXT.search(b):
        return True
    if b in IAC_NAMES or re.search(r"\.tfrc\Z", b):
        return True
    return bool(IAC_ORCH.match(b))


def hook_re(p):
    return bool(HOOK_PATH_RE.match(p))


# --- end of the copied rules ---


def is_hook_path(p):
    q = norm_path(p)
    if hook_re(q):
        return True
    # git's own hook dir (the hook surface in Max's rules), not a repo file
    segs = q.lower().split("/")
    return any(segs[i] == ".git" and segs[i + 1] == "hooks" for i in range(len(segs) - 1))


# invisible or confusable characters (the planner's class): controls (bar LF),
# format characters (tags U+E0000-E007F included), non-plain spaces, line and paragraph separators,
# variation selectors, tags, Hangul fillers
HANGUL_FILLERS = {0x115F, 0x1160, 0x3164, 0xFFA0}


def invisible(ch):
    o = ord(ch)
    if ch == "\n":
        return False
    cat = unicodedata.category(ch)
    if cat in ("Cc", "Cf", "Zl", "Zp", "Co", "Cs", "Cn"):
        return True
    if cat == "Zs" and ch != " ":
        return True
    if 0xFE00 <= o <= 0xFE0F or 0xE0100 <= o <= 0xE01EF or 0x180B <= o <= 0x180F:
        return True
    return o in HANGUL_FILLERS


COMMAND_WORDS = re.compile(r"\b(change_kind|bug_fix|test_cmd|check_cmd|new_behaviour)\b", re.IGNORECASE)
ENV_KEY = re.compile(r"^\s*(?:[-*]\s+)?`?env`?\s*[:=]", re.IGNORECASE)
FENCE = re.compile(r"^\s*(```|~~~)")
PROMPT = re.compile(r"^\s*\$\s+\S")
REPO_LINE = re.compile(r"^Repo:\s*(.*)$")
REPO_RE = re.compile(r"[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+\Z")
LIST_ITEM = re.compile(r"^\s*[-*]\s+(.*)$")
GWT = re.compile(r"\bGiven\b.+\bWhen\b.+\bThen\b", re.IGNORECASE | re.DOTALL)
NONE_RE = re.compile(r"^\(?none\)?\.?\Z", re.IGNORECASE)
TOKEN_STRIP = "`'\"()[]{}<>,;:!?*"
RUNNER_FILES = ("Makefile", "makefile", "GNUmakefile", "pyproject.toml", "setup.cfg", "tox.ini", "pytest.ini", "package.json", "Cargo.toml", "go.mod")


def origin_repo(url):
    """owner/repo (or group/sub/repo) of a git remote URL, else None."""
    u = url.strip()
    m = re.match(r"^[a-z][a-z0-9+.-]*://[^/]+/(.+)\Z", u, re.IGNORECASE)
    if m:
        path = m.group(1)
    else:
        m = re.match(r"^(?:[^@/:]+@)?[^/:]+:(.+)\Z", u)
        if not m:
            return None
        path = m.group(1)
    path = re.sub(r"\.git/?\Z", "", path.strip("/"))
    return path if REPO_RE.match(path) else None


def git_origin(repo):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        r = subprocess.run(
            ["git", "-c", "core.fsmonitor=false", "-C", repo, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=30, env=env,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    if r.returncode != 0:
        return None, (r.stderr.strip() or "git remote get-url origin failed")[:300]
    return r.stdout.strip(), None


def check(text, repo_dir=None, allow_open=False):
    errors, warnings = [], []

    def err(name, line, detail):
        errors.append({"check": name, "line": line, "detail": detail})

    def warn(name, line, detail):
        warnings.append({"check": name, "line": line, "detail": detail})

    for i, line in enumerate(text.split("\n"), 1):
        bad = sorted({c for c in line if invisible(c)})
        if bad:
            err("invisible", i, "invisible or confusable character(s): " + ", ".join("U+%04X" % ord(c) for c in bad))

    lines = text.replace("\r", "").split("\n")

    # marker
    n_marker = text.count(MARKER)
    if n_marker != 1:
        err("marker", None, "the brief needs exactly one %s (found %d)" % (MARKER, n_marker))

    # headings: the top heading, then the seven sections in order
    if not any(l.startswith(TOP) for l in lines):
        err("headings", None, "missing top heading %r" % (TOP + "<date>)"))
    found = []
    for i, l in enumerate(lines):
        for h in HEADINGS:
            if l.startswith(h):
                found.append((h, i))
    names = [h for h, _ in found]
    for h in HEADINGS:
        if names.count(h) != 1:
            err("headings", None, "heading %r found %d times, needs 1" % (h, names.count(h)))
    if names != list(HEADINGS) and all(names.count(h) == 1 for h in HEADINGS):
        err("headings", None, "headings out of order: " + ", ".join(names))
    pos = {h: i for h, i in found}

    def section(h):
        if h not in pos:
            return []
        start = pos[h] + 1
        later = [i for _, i in found if i > pos[h]]
        end = min(later) if later else len(lines)
        return [(j + 1, lines[j]) for j in range(start, end)]

    # repo
    repo_lines = [(i + 1, REPO_LINE.match(l).group(1)) for i, l in enumerate(lines) if REPO_LINE.match(l)]
    repo = None
    if len(repo_lines) != 1:
        err("repo", None, "the brief needs exactly one 'Repo: <owner>/<repo>' line (found %d)" % len(repo_lines))
    else:
        ln, rest = repo_lines[0]
        val = re.sub(r"\s+Component:.*\Z", "", rest).strip()
        if not REPO_RE.match(val):
            err("repo", ln, "Repo must name exactly one <owner>/<repo>, got %r" % val[:200])
        else:
            repo = val
    if repo and repo_dir is not None:
        url, problem = git_origin(repo_dir)
        if url is None:
            err("repo", None, "cannot read origin of %s: %s" % (repo_dir, problem))
        else:
            got = origin_repo(url)
            if got is None or got.lower() != repo.lower():
                err("repo", None, "origin of %s is %r, not %s" % (repo_dir, got or url[:200], repo))
    if repo_dir is not None:
        if not any(os.path.isfile(os.path.join(repo_dir, f)) for f in RUNNER_FILES):
            warn("runner", None, "no test runner file found (" + ", ".join(RUNNER_FILES) + "); plan mode must find the test command")

    # behaviours: one list item per behaviour, each with Given ... When ... Then
    items = 0
    for ln, l in section("### Behaviours"):
        if not l.strip():
            continue
        m = LIST_ITEM.match(l)
        if not m:
            err("behaviours", ln, "one behaviour per list item ('- ...'); got prose: %r" % l[:200])
            continue
        items += 1
        if not GWT.search(m.group(1)):
            err("behaviours", ln, "behaviour has no literal Given ... When ... Then ... example: %r" % l[:200])
    if "### Behaviours" in pos and items == 0:
        err("behaviours", None, "no behaviour listed")

    # open decisions
    open_items = []
    for ln, l in section("### Open decisions"):
        s = l.strip()
        if not s:
            continue
        m = LIST_ITEM.match(l)
        body = (m.group(1) if m else s).strip()
        if NONE_RE.match(body):
            continue
        open_items.append((ln, body))
    for ln, body in open_items:
        (warn if allow_open else err)("open_decisions", ln, "open decision: %r" % body[:200])

    # command text and IaC / hook paths (outside "Out of plan" for paths)
    out_lines = {ln for ln, _ in section(OUT_OF_PLAN)}
    for i, l in enumerate(lines, 1):
        if COMMAND_WORDS.search(l):
            err("commands", i, "the brief holds no %s: the planner derives it from the repo" % COMMAND_WORDS.search(l).group(1))
        if ENV_KEY.search(l):
            err("commands", i, "the brief holds no env settings")
        if FENCE.search(l):
            err("commands", i, "the brief holds no code fence (no command slot)")
        elif PROMPT.search(l):
            err("commands", i, "the brief holds no shell prompt line")
        if i in out_lines:
            continue
        for tok in l.split():
            t = tok.strip(TOKEN_STRIP).rstrip(".")
            if not t or "://" in t or ("/" not in t and "." not in t and t.lower() != "jenkinsfile"):
                continue
            if is_iac_path(t):
                err("iac", i, "IaC path %r outside 'Out of plan': the fleet never plans IaC; hand it to Max" % t)
            elif is_hook_path(t):
                err("hook", i, "hook-surface path %r outside 'Out of plan': hook changes need their own PR with Max" % t)

    return errors, warnings, repo


def main(argv):
    args = list(argv)
    if args[:1] == ["--classify-paths"] and len(args) == 2:
        paths = json.loads(args[1])
        print(json.dumps([{"path": p, "iac": is_iac_path(p), "hook_re": hook_re(p), "hook": is_hook_path(p)} for p in paths]))
        return 0
    repo_dir, allow_open, files = None, False, []
    while args:
        a = args.pop(0)
        if a == "--repo" and args:
            repo_dir = args.pop(0)
        elif a == "--allow-open":
            allow_open = True
        elif a == "-" or not a.startswith("-"):
            files.append(a)
        else:
            print("unknown option: " + a, file=sys.stderr)
            return 2
    if len(files) != 1:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        return 2
    try:
        if files[0] == "-":
            raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        else:
            with open(files[0], "rb") as fh:
                raw = fh.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            print(json.dumps({"ok": False, "errors": [{"check": "size", "line": None, "detail": "the brief is over %d bytes" % MAX_BYTES}], "warnings": [], "repo": None}))
            return 1
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        print("cannot read the brief: %s" % e, file=sys.stderr)
        return 2
    errors, warnings, repo = check(text, repo_dir, allow_open)
    print(json.dumps({"ok": not errors, "errors": errors, "warnings": warnings, "repo": repo}, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
