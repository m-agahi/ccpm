#!/usr/bin/env python3
"""Pick the commit that release detection compares HEAD against.

Inputs (environment):
  INPUT_BASE_REF  explicit base from workflow_dispatch; must name a commit,
                  otherwise the step fails.
  BEFORE_SHA      ``github.event.before`` on push; ignored when empty, all
                  zeros, unknown, or not an ancestor of HEAD (force push).

Fallback is HEAD~1. A root commit has no base: the output is empty and
callers treat every plugin as new/changed.

Output: ``base_ref`` (full sha or empty) to $GITHUB_OUTPUT.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import git, workflow_io

_ZERO_SHA = re.compile(r"0+")


def _fallback():
    return git.commit_sha("HEAD~1") or ""


def resolve_base_ref(before="", explicit=""):
    """Return the base commit sha ('' for none). Raises ValueError on bad explicit."""
    if explicit:
        sha = git.commit_sha(explicit)
        if sha is None:
            raise ValueError(f"base_ref {explicit!r} does not name a commit")
        return sha

    if not before or _ZERO_SHA.fullmatch(before):
        return _fallback()
    sha = git.commit_sha(before)
    if sha is None:
        print(f"::warning::push 'before' {before} not found; using HEAD~1")
        return _fallback()
    if not git.is_ancestor(sha, "HEAD"):
        print(f"::warning::push 'before' {before} is not an ancestor of HEAD; using HEAD~1")
        return _fallback()
    return sha


def main():
    try:
        base = resolve_base_ref(
            before=os.environ.get("BEFORE_SHA", "").strip(),
            explicit=os.environ.get("INPUT_BASE_REF", "").strip(),
        )
    except ValueError as e:
        workflow_io.error(str(e))
        sys.exit(1)
    print(f"Base ref: {base or '(none: root commit)'}")
    workflow_io.set_output("base_ref", base)


if __name__ == "__main__":
    main()
