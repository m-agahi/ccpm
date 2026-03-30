#!/usr/bin/env python3
"""Keep plugin version strings in README.md in sync with marketplace.json.

Looks for headings like:
  ### code-review (v3.6.3)
and replaces the version with the actual value from marketplace.json.
"""

import json
import os
import re
import sys

if not os.path.exists(".claude-plugin/marketplace.json"):
    print("ERROR: .claude-plugin/marketplace.json not found", file=sys.stderr)
    sys.exit(1)
if not os.path.exists("README.md"):
    print("ERROR: README.md not found", file=sys.stderr)
    sys.exit(1)

with open(".claude-plugin/marketplace.json") as f:
    marketplace = json.load(f)

versions = {p["name"]: p["version"] for p in marketplace.get("plugins", [])}

with open("README.md") as f:
    readme = f.read()

updated = readme
for name, version in versions.items():
    updated = re.sub(
        rf"(### {re.escape(name)} \(v)\d+\.\d+\.\d+(\))",
        rf"\g<1>{version}\g<2>",
        updated,
    )

if updated != readme:
    with open("README.md", "w") as f:
        f.write(updated)
    print(f"Updated plugin versions in README: {versions}")
else:
    print(f"Plugin versions in README already up to date: {versions}")
