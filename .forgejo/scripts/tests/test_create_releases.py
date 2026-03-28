"""Tests for scripts/create_releases.py — extract_changelog_entry()."""

import importlib
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _import_create_releases():
    """Import create_releases with RELEASE_SHA set to avoid sys.exit."""
    with patch.dict(os.environ, {"RELEASE_SHA": "abc123"}):
        if "create_releases" in sys.modules:
            return importlib.reload(sys.modules["create_releases"])
        return importlib.import_module("create_releases")


# Import at module level with env var mocked
_mod = _import_create_releases()
extract_changelog_entry = _mod.extract_changelog_entry


class TestExtractChangelogEntry(unittest.TestCase):
    def _write_changelog(self, plugin_name, content):
        d = os.path.join(self.tmpdir, "plugins", plugin_name)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "CHANGELOG.md")
        with open(path, "w") as f:
            f.write(content)

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self._orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)

    def tearDown(self):
        os.chdir(self._orig_cwd)

    def test_extracts_correct_section(self):
        self._write_changelog(
            "myplugin",
            (
                "# Changelog\n\n"
                "## [2.0.0]\n\n"
                "- Breaking change\n\n"
                "## [1.0.0]\n\n"
                "- Initial release\n"
            ),
        )
        result = extract_changelog_entry("myplugin", "2.0.0")
        self.assertIn("Breaking change", result)
        self.assertNotIn("Initial release", result)

    def test_returns_empty_for_missing_file(self):
        self.assertEqual(extract_changelog_entry("noplugin", "1.0.0"), "")

    def test_returns_empty_for_missing_version(self):
        self._write_changelog("myplugin", "## [1.0.0]\n\n- stuff\n")
        self.assertEqual(extract_changelog_entry("myplugin", "9.9.9"), "")

    def test_last_version_extracts_to_end(self):
        self._write_changelog("myplugin", "## [1.0.0]\n\n- only version\n")
        result = extract_changelog_entry("myplugin", "1.0.0")
        self.assertIn("only version", result)

    def test_header_only_returns_empty(self):
        self._write_changelog("myplugin", "## [1.0.0]\n")
        result = extract_changelog_entry("myplugin", "1.0.0")
        self.assertEqual(result, "")


if __name__ == "__main__":
    unittest.main()
