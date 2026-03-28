#!/usr/bin/env python3
"""Pre-commit variant: check that staged plugin changes include a CHANGELOG update.

Looks at the git staging area (--cached) rather than comparing branches,
so it catches missing changelogs before you even push.
"""

import pathlib
import subprocess
import sys


def staged_files():
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip().splitlines()


plugins_changed = set()
plugins_with_changelog = set()

for f in staged_files():
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
