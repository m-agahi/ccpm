#!/usr/bin/env python3
"""Create GitHub releases (and their tags) for each version-bumped plugin.

Reads the release plan from .ci-outputs/releases.json (written by
check_releases.py during the detect step) and creates a GitHub release for
each entry, pulling the changelog entry as the body. GitHub creates the tag
at RELEASE_SHA when it does not exist yet; an existing tag is reused as-is.
"""

import json
import os
import pathlib
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
from lib import github_api

sha = (os.environ.get("RELEASE_SHA") or os.environ.get("GITHUB_SHA", "")).strip()
if not sha:
    print("ERROR: RELEASE_SHA or GITHUB_SHA must be set", file=sys.stderr)
    sys.exit(1)


def extract_changelog_entry(plugin_name, version):
    """Pull the changelog section for a specific version."""
    changelog_path = pathlib.Path(f"plugins/{plugin_name}/CHANGELOG.md")
    if not changelog_path.exists():
        return ""

    content = changelog_path.read_text()
    header = f"## [{version}]"
    start = content.find(header)
    if start == -1:
        return ""

    after = content[start:]
    next_version = after.find("\n## [", 1)
    entry = after[:next_version].strip() if next_version != -1 else after.strip()

    # Strip the version header line itself
    lines = entry.split("\n")[1:]
    return "\n".join(lines).strip()


def create_release(tag, title, body, sha):
    """Create the release for ``tag``. Returns True if created, False if skipped.

    Idempotent: skips when a release for the tag already exists.
    """
    encoded_tag = urllib.parse.quote(tag, safe="")
    try:
        github_api.get(github_api.repo_path(f"/releases/tags/{encoded_tag}"))
        print(f"  Release for {tag} already exists, skipping")
        return False
    except github_api.APIError as e:
        if e.status_code != 404:
            raise

    try:
        github_api.post(
            github_api.repo_path("/releases"),
            {
                "tag_name": tag,
                "target_commitish": sha,
                "name": title,
                "body": body,
                "draft": False,
                "prerelease": False,
            },
        )
    except github_api.APIError as e:
        if github_api.is_already_exists(e):
            print(f"  Release for {tag} already exists, skipping")
            return False
        raise
    print(f"Created release: {title} ({tag})")
    return True


def main():
    outputs_path = pathlib.Path(".ci-outputs/releases.json")
    if not outputs_path.exists():
        print("No releases.json found, nothing to release.")
        return

    releases = json.loads(outputs_path.read_text())
    if not releases:
        print("Empty release list, nothing to do.")
        return

    for rel in releases:
        tag = f"{rel['name']}/v{rel['version']}"
        title = f"{rel['name']} v{rel['version']}"

        body_parts = []
        if rel.get("type") == "update" and rel.get("old_version"):
            body_parts.append(f"Upgraded from v{rel['old_version']}")

        changelog = extract_changelog_entry(rel["name"], rel["version"])
        if changelog:
            body_parts.append(changelog)

        if rel.get("type") == "new":
            body_parts.append("*New plugin*")

        body = "\n\n".join(body_parts).strip()

        create_release(tag, title, body, sha)


if __name__ == "__main__":
    main()
