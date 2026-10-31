#!/usr/bin/env python3
"""Pre-commit variant: check that staged plugin changes include a CHANGELOG update.

Looks at the git staging area (--cached) rather than comparing branches,
so it catches missing changelogs before you even push.

Also checks marketplace.json version bumps: if .claude-plugin/marketplace.json
is staged and a plugin's version changed, requires either a staged
plugins/<name>/CHANGELOG.md in the same commit, or an existing matching version
heading already committed in plugins/<name>/CHANGELOG.md.
"""

import json
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


def read_marketplace_json_staged():
    """Read marketplace.json from the git index (staged version)."""
    result = subprocess.run(
        ["git", "show", ":.claude-plugin/marketplace.json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {"plugins": []}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"plugins": []}


def read_marketplace_json_head():
    """Read marketplace.json from HEAD (committed version)."""
    result = subprocess.run(
        ["git", "show", "HEAD:.claude-plugin/marketplace.json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {"plugins": []}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"plugins": []}


def read_changelog_from_disk(plugin_name):
    """Read plugins/<name>/CHANGELOG.md from working tree, then HEAD."""
    local_path = pathlib.Path(f"plugins/{plugin_name}/CHANGELOG.md")
    if local_path.exists():
        return local_path.read_text()
    result = subprocess.run(
        ["git", "show", f"HEAD:plugins/{plugin_name}/CHANGELOG.md"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return result.stdout
    return ""


def check_marketplace_bumps(staged_mp, head_mp, staged_changelog_plugins, changelog_reader):
    """Check marketplace.json version bumps against CHANGELOG entries.

    Args:
        staged_mp: parsed staged marketplace.json dict
        head_mp: parsed HEAD marketplace.json dict (or empty dict)
        staged_changelog_plugins: set of plugin names whose CHANGELOG.md is staged
        changelog_reader: callable(plugin_name) -> str of CHANGELOG content

    Returns:
        list of failure message strings (empty = all pass)
    """
    head_versions = {
        p["name"]: p.get("version", "")
        for p in head_mp.get("plugins", [])
        if "name" in p
    }

    failures = []
    for plugin in staged_mp.get("plugins", []):
        name = plugin.get("name")
        new_version = plugin.get("version", "")
        if not name or not new_version:
            continue

        old_version = head_versions.get(name, "")
        if new_version == old_version:
            continue

        # Version changed — check if CHANGELOG covers it
        if name in staged_changelog_plugins:
            # CHANGELOG.md staged in this commit — satisfied
            continue

        # Check working-tree / HEAD CHANGELOG for a matching version heading
        content = changelog_reader(name)
        if content and new_version in content:
            # Look for a heading line containing the version string
            for line in content.splitlines():
                stripped = line.strip()
                if stripped.startswith("#") and new_version in stripped:
                    break
            else:
                # version string appears in content but not in a heading
                failures.append(
                    f"marketplace.json bumps plugin '{name}' to {new_version} but no matching "
                    f"CHANGELOG heading found.\n"
                    f"  - expected heading containing '{new_version}' in "
                    f"plugins/{name}/CHANGELOG.md\n"
                    f"  - or stage plugins/{name}/CHANGELOG.md with a new entry in this commit"
                )
            continue

        failures.append(
            f"marketplace.json bumps plugin '{name}' to {new_version} but no matching "
            f"CHANGELOG entry found.\n"
            f"  - expected heading containing '{new_version}' in plugins/{name}/CHANGELOG.md\n"
            f"  - or stage plugins/{name}/CHANGELOG.md with a new entry in this commit"
        )

    return failures


def main():
    files = staged_files()

    plugins_changed = set()
    plugins_with_changelog = set()
    marketplace_staged = False

    for f in files:
        parts = pathlib.PurePosixPath(f).parts
        if len(parts) >= 2 and parts[0] == "plugins":
            plugin_name = parts[1]
            if f == f"plugins/{plugin_name}/CHANGELOG.md":
                plugins_with_changelog.add(plugin_name)
            else:
                plugins_changed.add(plugin_name)
        if f == ".claude-plugin/marketplace.json":
            marketplace_staged = True

    errors = []

    missing = plugins_changed - plugins_with_changelog
    if missing:
        lines = ["CHANGELOG.md not updated for these plugins:"]
        for name in sorted(missing):
            lines.append(f"  - plugins/{name}/CHANGELOG.md")
        lines.append("\nPlease add a changelog entry for each modified plugin.")
        errors.append("\n".join(lines))

    if marketplace_staged:
        staged_mp = read_marketplace_json_staged()
        head_mp = read_marketplace_json_head()
        mp_failures = check_marketplace_bumps(
            staged_mp, head_mp, plugins_with_changelog, read_changelog_from_disk
        )
        errors.extend(mp_failures)

    if errors:
        for msg in errors:
            print(msg, file=sys.stderr)
        sys.exit(1)

    print("Changelog check passed.")


if __name__ == "__main__":
    main()
