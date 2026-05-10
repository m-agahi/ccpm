#!/usr/bin/env python3
"""Verify code-review plugin version is consistent across three sources:
- plugins/code-review/docker/Dockerfile  (LABEL version="x.y.z")
- plugins/code-review/CHANGELOG.md       (first ## [x.y.z] heading)
- .claude-plugin/marketplace.json        (plugins[name=code-review].version)
"""

import json
import pathlib
import re
import sys

root = pathlib.Path(".")

dockerfile = root / "plugins" / "code-review" / "docker" / "Dockerfile"
changelog = root / "plugins" / "code-review" / "CHANGELOG.md"
marketplace_path = root / ".claude-plugin" / "marketplace.json"

errors = []


def read_dockerfile_version():
    for line in dockerfile.read_text().splitlines():
        m = re.match(r'LABEL version="([^"]+)"', line.strip())
        if m:
            return m.group(1)
    return None


def read_changelog_version():
    for line in changelog.read_text().splitlines():
        m = re.match(r"^##\s+\[([^\]]+)\]", line)
        if m:
            return m.group(1)
    return None


def read_marketplace_version():
    data = json.loads(marketplace_path.read_text())
    for plugin in data.get("plugins", []):
        if plugin.get("name") == "code-review":
            return plugin.get("version")
    return None


for path, label in [(dockerfile, "Dockerfile"), (changelog, "CHANGELOG.md"), (marketplace_path, "marketplace.json")]:
    if not path.exists():
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)

dockerfile_ver = read_dockerfile_version()
changelog_ver = read_changelog_version()
marketplace_ver = read_marketplace_version()

if dockerfile_ver is None:
    errors.append("Dockerfile: LABEL version not found")
if changelog_ver is None:
    errors.append("CHANGELOG.md: no ## [x.y.z] heading found")
if marketplace_ver is None:
    errors.append("marketplace.json: code-review plugin entry not found")

if errors:
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

versions = {
    "Dockerfile": dockerfile_ver,
    "CHANGELOG.md": changelog_ver,
    "marketplace.json": marketplace_ver,
}

if len(set(versions.values())) != 1:
    print("ERROR: code-review version mismatch:", file=sys.stderr)
    for source, ver in versions.items():
        print(f"  {source}: {ver}", file=sys.stderr)
    sys.exit(1)

print(f"code-review version consistent: {dockerfile_ver}")
