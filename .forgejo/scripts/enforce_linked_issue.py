#!/usr/bin/env python3
"""Enforce that every PR references a linked issue.

Checks the PR body for issue keywords (closes, fixes, resolves,
related to) followed by #N, and the Forgejo timeline for
cross-references. If no issue is found and the author isn't exempt,
closes the PR with an explanatory comment.

Exempt conditions:
  - PR has a "docs", "chore", or "dependencies" label
  - PR author has admin or owner permissions on the repo
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import forgejo_api, workflow_io

EXEMPT_LABELS = {"docs", "chore", "dependencies"}
ISSUE_PATTERN = re.compile(
    r"(closes|fixes|resolves|related\s+to)\s+#\d+", re.IGNORECASE
)


def get_pr():
    pr_number = workflow_io.require_env("PR_NUMBER")
    return int(pr_number), forgejo_api.get(forgejo_api.repo_path(f"/pulls/{pr_number}"))


def is_label_exempt(pr_data):
    labels = {label["name"].lower() for label in pr_data.get("labels", [])}
    return bool(labels & EXEMPT_LABELS)


def is_author_exempt(pr_data):
    """Check if the PR author is the repo owner.

    The collaborator permission endpoint requires admin access on Codeberg,
    so instead we compare the PR author against the repo owner directly.
    """
    login = pr_data["user"]["login"]
    try:
        repo = forgejo_api.get(forgejo_api.repo_path())
        if repo and repo.get("owner", {}).get("login") == login:
            return True
    except RuntimeError as e:
        print(f"WARNING: repo owner check failed: {e}", file=sys.stderr)

    # Fallback: try the permission endpoint (works if token has admin scope)
    try:
        collab = forgejo_api.get(
            forgejo_api.repo_path(f"/collaborators/{login}/permission")
        )
        if collab and collab.get("permission") in ("admin", "owner"):
            return True
    except RuntimeError:
        pass

    return False


def has_linked_issue(pr_number, pr_data):
    body = pr_data.get("body") or ""
    if ISSUE_PATTERN.search(body):
        return True

    # Check timeline for cross-references
    try:
        timeline = forgejo_api.get(
            forgejo_api.repo_path(f"/issues/{pr_number}/timeline")
        )
        if timeline:
            for event in timeline:
                if event.get("type") in ("cross_ref", "ref"):
                    return True
    except RuntimeError as e:
        raise RuntimeError(f"Timeline API unavailable for PR #{pr_number}: {e}") from e

    return False


def main():
    pr_number, pr_data = get_pr()

    if is_label_exempt(pr_data):
        print(f"PR #{pr_number} is exempt via label.")
        return

    if is_author_exempt(pr_data):
        print(f"PR #{pr_number} is exempt — author has elevated permissions.")
        return

    if has_linked_issue(pr_number, pr_data):
        print(f"PR #{pr_number} has a linked issue.")
    else:
        print(
            f"::error::PR #{pr_number} has no linked issue. "
            "Reference one in the description with Closes #N, Fixes #N, or Resolves #N. "
            "PRs with the docs, chore, or dependencies label are exempt.",
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
