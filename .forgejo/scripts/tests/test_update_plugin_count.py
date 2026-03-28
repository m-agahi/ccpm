"""Tests for scripts/update_plugin_count.py — badge regex logic."""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Extract the regex pattern used in update_plugin_count.py
BADGE_PATTERN = re.compile(r"(https://img\.shields\.io/badge/plugins-)\d+(-blue)")


class TestBadgeRegex(unittest.TestCase):
    def test_updates_count(self):
        readme = "![](https://img.shields.io/badge/plugins-3-blue)"
        updated = BADGE_PATTERN.sub(r"\g<1>5\g<2>", readme)
        self.assertIn("plugins-5-blue", updated)

    def test_no_op_when_correct(self):
        readme = "![](https://img.shields.io/badge/plugins-5-blue)"
        updated = BADGE_PATTERN.sub(r"\g<1>5\g<2>", readme)
        self.assertEqual(readme, updated)

    def test_no_badge_in_readme(self):
        readme = "# My Project\n\nNo badge here."
        updated = BADGE_PATTERN.sub(r"\g<1>5\g<2>", readme)
        self.assertEqual(readme, updated)


if __name__ == "__main__":
    unittest.main()
