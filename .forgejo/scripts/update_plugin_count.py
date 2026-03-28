#!/usr/bin/env python3
"""Keep the plugin count badge in README.md in sync with marketplace.json.

Looks for a shields.io badge URL like:
  https://img.shields.io/badge/plugins-N-blue
and replaces N with the actual count from marketplace.json.
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

count = len(marketplace.get("plugins", []))

with open("README.md") as f:
    readme = f.read()

updated = re.sub(
    r"(https://img\.shields\.io/badge/plugins-)\d+(-blue)",
    rf"\g<1>{count}\g<2>",
    readme,
)

if updated != readme:
    with open("README.md", "w") as f:
        f.write(updated)
    print(f"Updated plugin count badge to {count}.")
else:
    print(f"Plugin count badge already shows {count}.")
