#!/usr/bin/env python3
"""Detect plugin version changes between two git states.

Compares marketplace.json at BASE_REF against the current working tree.
Outputs a JSON array of releases to FORGEJO_OUTPUT so the workflow can
create tags and releases for each changed plugin.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import git, workflow_io

base_ref = os.environ.get("BASE_REF", "HEAD~1")
marketplace_path = ".claude-plugin/marketplace.json"


def load_current():
    if not os.path.exists(marketplace_path):
        print(
            f"ERROR: {marketplace_path} not found — cannot detect version changes.",
            file=sys.stderr,
        )
        sys.exit(1)
    with open(marketplace_path) as f:
        return json.load(f)


def load_previous():
    content = git.show_file(base_ref, marketplace_path)
    if content is None:
        return {"plugins": []}
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return {"plugins": []}


old = load_previous()
current = load_current()

old_versions = {p["name"]: p.get("version", "") for p in old.get("plugins", [])}
current_versions = {p["name"]: p.get("version", "") for p in current.get("plugins", [])}

releases = []
for name, version in current_versions.items():
    old_version = old_versions.get(name, "")
    if version and version != old_version:
        rel = {"name": name, "version": version}
        if old_version:
            rel["type"] = "update"
            rel["old_version"] = old_version
        else:
            rel["type"] = "new"
        releases.append(rel)

if releases:
    output = json.dumps(releases)
    print(output)
    workflow_io.set_output("releases", output)
    workflow_io.set_output("has_releases", "true")
else:
    print("No version changes detected.")
    workflow_io.set_output("has_releases", "false")
