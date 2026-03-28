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
MISSING_LABEL = "missing-issue"
MISSING_LABEL_COLOR = "#B60205"
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
    login = pr_data["user"]["login"]
    try:
        collab = forgejo_api.get(
            forgejo_api.repo_path(f"/collaborators/{login}/permission")
        )
        if not collab:
            return False
        return collab.get("permission") in ("admin", "owner")
    except RuntimeError as e:
        print(f"WARNING: permission check failed: {e}", file=sys.stderr)
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


def get_or_create_label_id():
    """Create the missing-issue label if needed and return its integer ID."""
    try:
        label = forgejo_api.post(
            forgejo_api.repo_path("/labels"),
            {
                "name": MISSING_LABEL,
                "color": MISSING_LABEL_COLOR,
                "description": "PR has no linked issue",
            },
        )
        if label and "id" in label:
            return label["id"]
    except forgejo_api.APIError as e:
        if e.status_code != 409:
            raise
    # Label already existed — look it up
    labels = forgejo_api.get(forgejo_api.repo_path("/labels"))
    if labels:
        for label in labels:
            if label["name"] == MISSING_LABEL:
                return label["id"]
    return None


def close_pr(pr_number):
    label_id = get_or_create_label_id()
    if label_id is not None:
        forgejo_api.post(
            forgejo_api.issue_labels_path(pr_number),
            {"labels": [label_id]},
        )

    # Post comment
    forgejo_api.post(
        forgejo_api.issue_comments_path(pr_number),
        {
            "body": (
                "This PR was automatically closed because it has no linked issue.\n\n"
                "Please create an issue first, then reference it in the PR description:\n"
                "- `Closes #<issue-number>`\n"
                "- `Fixes #<issue-number>`\n"
                "- `Resolves #<issue-number>`\n\n"
                "Once updated, the PR will be reopened automatically.\n\n"
                "PRs with the `docs`, `chore`, or `dependencies` label are exempt."
            )
        },
    )

    # Close
    forgejo_api.patch(
        forgejo_api.repo_path(f"/pulls/{pr_number}"),
        {"state": "closed"},
    )
    print(f"Closed PR #{pr_number} — no linked issue found.")


def reopen_pr(pr_number, pr_data):
    # Remove the label if present (use integer ID from pr_data)
    label_id = next(
        (
            label["id"]
            for label in pr_data.get("labels", [])
            if label["name"] == MISSING_LABEL
        ),
        None,
    )
    if label_id is not None:
        try:
            forgejo_api.delete(
                forgejo_api.repo_path(f"/issues/{pr_number}/labels/{label_id}")
            )
        except RuntimeError as e:
            print(f"WARNING: failed to remove label: {e}", file=sys.stderr)

    # Reopen if closed
    if pr_data.get("state") == "closed":
        try:
            forgejo_api.patch(
                forgejo_api.repo_path(f"/pulls/{pr_number}"),
                {"state": "open"},
            )
            print(f"Reopened PR #{pr_number} — linked issue found.")
        except RuntimeError as e:
            print(f"WARNING: failed to reopen PR: {e}", file=sys.stderr)


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
        reopen_pr(pr_number, pr_data)
    else:
        close_pr(pr_number)
        sys.exit(1)


if __name__ == "__main__":
    main()
