#!/usr/bin/env python3
"""Detect plugin version changes between two git states.

Compares marketplace.json at BASE_REF against the current working tree.
BASE_REF comes from resolve_base_ref.py; an empty BASE_REF means "no base"
(root commit) and every plugin counts as new. An unknown BASE_REF is an
error, never silently treated as "no base".

Outputs a JSON array of releases to GITHUB_OUTPUT so the workflow can
create tags and releases for each changed plugin.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import git, workflow_io

MARKETPLACE_PATH = ".claude-plugin/marketplace.json"


def load_current():
    if not os.path.exists(MARKETPLACE_PATH):
        print(
            f"ERROR: {MARKETPLACE_PATH} not found — cannot detect version changes.",
            file=sys.stderr,
        )
        sys.exit(1)
    with open(MARKETPLACE_PATH) as f:
        return json.load(f)


def load_previous(base_ref):
    if not base_ref:
        return {"plugins": []}
    if git.commit_sha(base_ref) is None:
        print(f"ERROR: BASE_REF {base_ref!r} does not name a commit.", file=sys.stderr)
        sys.exit(1)
    content = git.show_file(base_ref, MARKETPLACE_PATH)
    if content is None:
        return {"plugins": []}
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return {"plugins": []}


def compute_releases(old, current):
    old_versions = {p["name"]: p.get("version", "") for p in old.get("plugins", [])}
    releases = []
    for p in current.get("plugins", []):
        name, version = p["name"], p.get("version", "")
        old_version = old_versions.get(name, "")
        if version and version != old_version:
            rel = {"name": name, "version": version}
            if old_version:
                rel["type"] = "update"
                rel["old_version"] = old_version
            else:
                rel["type"] = "new"
            releases.append(rel)
    return releases


def main():
    base_ref = os.environ.get("BASE_REF", "HEAD~1").strip()
    releases = compute_releases(load_previous(base_ref), load_current())

    if releases:
        output = json.dumps(releases)
        print(output)
        workflow_io.set_output("releases", output)
        workflow_io.set_output("has_releases", "true")
    else:
        print("No version changes detected.")
        workflow_io.set_output("has_releases", "false")


if __name__ == "__main__":
    main()
