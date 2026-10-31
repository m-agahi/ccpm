#!/usr/bin/env python3
"""Enforce that every PR references a linked issue.

Checks the PR body for issue keywords (closes, fixes, resolves,
related to) followed by #N, and the GitHub issue timeline for
cross-references (``cross-referenced``) or sidebar-linked issues
(``connected`` not later ``disconnected``). If no issue is found and the
author isn't exempt, fails the check with an explanatory error.

Exempt conditions:
  - PR has a "docs", "chore", or "dependencies" label
  - PR author is the repo owner or has admin permission on the repo
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import github_api, workflow_io

EXEMPT_LABELS = {"docs", "chore", "dependencies"}
ISSUE_PATTERN = re.compile(
    r"(closes|fixes|resolves|related[ \t]+to)[ \t]+#(\d+)", re.IGNORECASE
)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def get_pr():
    pr_number = workflow_io.require_env("PR_NUMBER")
    return int(pr_number), github_api.get(github_api.repo_path(f"/pulls/{pr_number}"))


def is_label_exempt(pr_data):
    labels = {label["name"].lower() for label in pr_data.get("labels", [])}
    return bool(labels & EXEMPT_LABELS)


def is_author_exempt(pr_data):
    """Check if the PR author is the repo owner or a repo admin.

    GitHub permission values are admin/maintain/write/triage/read/none; there
    is no "owner" value, so ownership is checked against the repo owner login.
    """
    login = pr_data["user"]["login"]
    try:
        repo = github_api.get(github_api.repo_path())
        if repo and repo.get("owner", {}).get("login") == login:
            return True
    except RuntimeError as e:
        print(f"WARNING: repo owner check failed: {e}", file=sys.stderr)

    # Fallback: collaborator permission endpoint (admin only)
    try:
        collab = github_api.get(
            github_api.repo_path(f"/collaborators/{login}/permission")
        )
        if collab and collab.get("permission") == "admin":
            return True
    except RuntimeError:
        pass

    return False


def issue_exists(issue_number):
    """Check that the referenced issue exists and is not a pull request."""
    try:
        issue = github_api.get(
            github_api.repo_path(f"/issues/{issue_number}")
        )
        if issue and not issue.get("pull_request"):
            return True
    except RuntimeError:
        pass
    return False


def has_linked_issue(pr_number, pr_data):
    body = pr_data.get("body") or ""
    body = HTML_COMMENT.sub("", body)
    for match in ISSUE_PATTERN.finditer(body):
        issue_number = int(match.group(2))
        if issue_exists(issue_number):
            return True

    # Check timeline for cross-references and sidebar-linked issues.
    # One page of 100 events is enough for a PR's linking history.
    try:
        timeline = github_api.get(
            github_api.repo_path(f"/issues/{pr_number}/timeline?per_page=100")
        )
        connected = 0
        for event in timeline or []:
            kind = event.get("event")
            if kind == "cross-referenced":
                return True
            if kind == "connected":
                connected += 1
            elif kind == "disconnected":
                connected -= 1
        if connected > 0:
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
