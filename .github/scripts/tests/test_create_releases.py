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
create_release = _mod.create_release
APIError = _mod.github_api.APIError


class TestCreateRelease(unittest.TestCase):
    def setUp(self):
        p = patch.dict(os.environ, {"GITHUB_REPOSITORY": "o/r", "GITHUB_TOKEN": "t"})
        p.start()
        self.addCleanup(p.stop)

    @patch("create_releases.github_api.post")
    @patch("create_releases.github_api.get")
    def test_skips_when_release_exists(self, mock_get, mock_post):
        mock_get.return_value = {"id": 1, "tag_name": "p/v1.0.0"}
        self.assertFalse(create_release("p/v1.0.0", "p v1.0.0", "body", "abc"))
        mock_get.assert_called_once_with("/repos/o/r/releases/tags/p%2Fv1.0.0")
        mock_post.assert_not_called()

    @patch("create_releases.github_api.post")
    @patch("create_releases.github_api.get")
    def test_creates_release_with_target_commitish(self, mock_get, mock_post):
        mock_get.side_effect = APIError("GET", "u", 404, "Not Found")
        mock_post.return_value = {"id": 2}
        self.assertTrue(create_release("p/v1.0.0", "p v1.0.0", "notes", "abc123"))
        mock_post.assert_called_once_with(
            "/repos/o/r/releases",
            {
                "tag_name": "p/v1.0.0",
                "target_commitish": "abc123",
                "name": "p v1.0.0",
                "body": "notes",
                "draft": False,
                "prerelease": False,
            },
        )

    @patch("create_releases.github_api.post")
    @patch("create_releases.github_api.get")
    def test_post_already_exists_is_skipped(self, mock_get, mock_post):
        mock_get.side_effect = APIError("GET", "u", 404, "Not Found")
        mock_post.side_effect = APIError(
            "POST", "u", 422, '{"errors":[{"code":"already_exists"}]}'
        )
        self.assertFalse(create_release("p/v1.0.0", "t", "b", "abc"))

    @patch("create_releases.github_api.post")
    @patch("create_releases.github_api.get")
    def test_post_validation_error_raises(self, mock_get, mock_post):
        mock_get.side_effect = APIError("GET", "u", 404, "Not Found")
        mock_post.side_effect = APIError("POST", "u", 422, '{"errors":[{"code":"invalid"}]}')
        with self.assertRaises(APIError):
            create_release("p/v1.0.0", "t", "b", "abc")

    @patch("create_releases.github_api.post")
    @patch("create_releases.github_api.get")
    def test_lookup_error_other_than_404_raises(self, mock_get, mock_post):
        mock_get.side_effect = APIError("GET", "u", 403, "Forbidden")
        with self.assertRaises(APIError):
            create_release("p/v1.0.0", "t", "b", "abc")
        mock_post.assert_not_called()


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
