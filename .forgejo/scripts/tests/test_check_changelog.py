"""Tests for scripts/check_changelog.py — file classification logic."""

import os
import pathlib
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestChangelogClassification(unittest.TestCase):
    """Test the file classification logic extracted from check_changelog.py."""

    def _classify(self, changed_files):
        """Reproduce the classification logic from check_changelog.py."""
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
        return plugins_changed - plugins_with_changelog

    def test_plugin_change_without_changelog(self):
        missing = self._classify(["plugins/foo/src/main.py"])
        self.assertEqual(missing, {"foo"})

    def test_plugin_change_with_changelog(self):
        missing = self._classify(
            [
                "plugins/foo/src/main.py",
                "plugins/foo/CHANGELOG.md",
            ]
        )
        self.assertEqual(missing, set())

    def test_non_plugin_file_ignored(self):
        missing = self._classify(["README.md", ".forgejo/scripts/check.py"])
        self.assertEqual(missing, set())

    def test_multiple_plugins_mixed(self):
        missing = self._classify(
            [
                "plugins/foo/src/main.py",
                "plugins/foo/CHANGELOG.md",
                "plugins/bar/src/main.py",
            ]
        )
        self.assertEqual(missing, {"bar"})


if __name__ == "__main__":
    unittest.main()
