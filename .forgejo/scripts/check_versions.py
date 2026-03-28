#!/usr/bin/env python3
"""Ensure plugin versions are declared in exactly one place.

Version must live in marketplace.json OR plugin.json, never both.
Having it in both causes silent precedence issues.
"""

import json
import pathlib
import sys

root = pathlib.Path(".")
marketplace_path = root / ".claude-plugin" / "marketplace.json"

if not marketplace_path.exists():
    print("ERROR: .claude-plugin/marketplace.json not found", file=sys.stderr)
    sys.exit(1)

marketplace = json.loads(marketplace_path.read_text())
errors = []

# Verify plugin names are unique
plugin_names = [entry.get("name") for entry in marketplace.get("plugins", [])]
seen = set()
duplicates = [name for name in plugin_names if name in seen or seen.add(name)]
if duplicates:
    print(
        f"ERROR: Duplicate plugin names in marketplace.json: {duplicates}",
        file=sys.stderr,
    )
    sys.exit(1)

for entry in marketplace.get("plugins", []):
    source = entry.get("source", "")
    if not isinstance(source, str) or not source.startswith("./"):
        continue

    plugin_json = root / source.removeprefix("./") / ".claude-plugin" / "plugin.json"
    if not plugin_json.resolve().is_relative_to(root.resolve()):
        continue
    if not plugin_json.exists():
        continue

    manifest = json.loads(plugin_json.read_text())

    if entry.get("version") and manifest.get("version"):
        errors.append(
            f"  {entry['name']}: version set in both marketplace.json "
            f"({entry['version']}) and {plugin_json} ({manifest['version']}). "
            f"Remove it from one location to avoid silent precedence issues."
        )

if errors:
    print("Version consistency errors:", file=sys.stderr)
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)

print("Version consistency check passed.")
