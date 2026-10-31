#!/usr/bin/env python3
"""Validate YAML frontmatter in all SKILL.md files under plugins/."""

import pathlib
import re
import sys

import yaml

errors = []

for skill_file in sorted(pathlib.Path("plugins").rglob("SKILL.md")):
    content = skill_file.read_text()
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        print(f"WARN: No frontmatter in {skill_file}")
        continue
    try:
        yaml.safe_load(match.group(1))
        print(f"OK: {skill_file}")
    except yaml.YAMLError as e:
        errors.append(f"  {skill_file}: {e}")

if errors:
    print("Invalid SKILL.md frontmatter:", file=sys.stderr)
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
