#!/usr/bin/env python3
"""Verify that every modified plugin has an updated CHANGELOG.md.

Compares the current tree against BASE_REF (defaults to origin/master)
and fails if any plugin directory has changes without a corresponding
CHANGELOG.md update in the same PR.
"""

import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib import git

base_ref = os.environ.get("BASE_REF", "origin/master")
changed_files = git.diff_names(base_ref)

plugins_changed = set()
plugins_with_changelog = set()

for f in changed_files:
    parts = pathlib.PurePosixPath(f).parts
    if len(parts) >= 2 and parts[0] == "plugins":
        plugin_name = parts[1]
        if f == f"plugins/{plugin_name}/CHANGELOG.md":
            plugins_with_changelog.add(plugin_name)
        else:
            plugins_changed.add(plugin_name)

missing = plugins_changed - plugins_with_changelog

if missing:
    print("CHANGELOG.md not updated for these plugins:", file=sys.stderr)
    for name in sorted(missing):
        print(f"  - plugins/{name}/CHANGELOG.md", file=sys.stderr)
    print(
        "\nPlease add a changelog entry for each modified plugin.",
        file=sys.stderr,
    )
    sys.exit(1)

print("Changelog check passed.")
