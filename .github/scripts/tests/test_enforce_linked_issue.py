"""Tests for scripts/enforce_linked_issue.py."""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Import the module under test
import enforce_linked_issue as eli


class TestIssuePattern(unittest.TestCase):
    def test_closes_hash(self):
        self.assertIsNotNone(eli.ISSUE_PATTERN.search("closes #1"))

    def test_fixes_hash(self):
        self.assertIsNotNone(eli.ISSUE_PATTERN.search("Fixes #42"))

    def test_resolves_hash(self):
        self.assertIsNotNone(eli.ISSUE_PATTERN.search("RESOLVES #100"))

    def test_related_to_hash(self):
        self.assertIsNotNone(eli.ISSUE_PATTERN.search("related to #3"))

    def test_bare_hash_does_not_match(self):
        self.assertIsNone(eli.ISSUE_PATTERN.search("see #5 for details"))

    def test_no_issue_reference(self):
        self.assertIsNone(eli.ISSUE_PATTERN.search("just some text"))

    def test_html_comment_is_stripped(self):
        body = "## Closes\n\n<!-- Link issues: Closes #123 -->\n"
        stripped = eli.HTML_COMMENT.sub("", body)
        self.assertIsNone(eli.ISSUE_PATTERN.search(stripped))

    def test_heading_plus_bare_hash_does_not_match(self):
        self.assertIsNone(eli.ISSUE_PATTERN.search("## Closes\n\n#40"))


class TestIsLabelExempt(unittest.TestCase):
    def test_exempt_label_docs(self):
        pr = {"labels": [{"name": "docs"}]}
        self.assertTrue(eli.is_label_exempt(pr))

    def test_exempt_label_case_insensitive(self):
        pr = {"labels": [{"name": "Docs"}]}
        self.assertTrue(eli.is_label_exempt(pr))

    def test_non_exempt_label(self):
        pr = {"labels": [{"name": "enhancement"}]}
        self.assertFalse(eli.is_label_exempt(pr))

    def test_empty_labels(self):
        pr = {"labels": []}
        self.assertFalse(eli.is_label_exempt(pr))

    def test_no_labels_key(self):
        self.assertFalse(eli.is_label_exempt({}))


class TestIsAuthorExempt(unittest.TestCase):
    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_admin_is_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/alice/permission"
        mock_get.return_value = {"permission": "admin"}
        pr = {"user": {"login": "alice"}}
        self.assertTrue(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_owner_is_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r"
        mock_get.return_value = {"owner": {"login": "bob"}}
        pr = {"user": {"login": "bob"}}
        self.assertTrue(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_maintain_is_not_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/mia/permission"
        mock_get.side_effect = [
            {"owner": {"login": "someone-else"}},
            {"permission": "write", "role_name": "maintain"},
        ]
        pr = {"user": {"login": "mia"}}
        self.assertFalse(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_write_is_not_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/carol/permission"
        mock_get.return_value = {"permission": "write"}
        pr = {"user": {"login": "carol"}}
        self.assertFalse(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_none_response_returns_false(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/dave/permission"
        mock_get.return_value = None
        pr = {"user": {"login": "dave"}}
        self.assertFalse(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_api_error_returns_false(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/eve/permission"
        mock_get.side_effect = RuntimeError("API down")
        pr = {"user": {"login": "eve"}}
        self.assertFalse(eli.is_author_exempt(pr))


class TestIssueExists(unittest.TestCase):
    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_valid_issue(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/10"
        mock_get.return_value = {"id": 10, "title": "bug"}
        self.assertTrue(eli.issue_exists(10))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_pull_request_is_not_issue(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/5"
        mock_get.return_value = {"id": 5, "pull_request": {"merged": False}}
        self.assertFalse(eli.issue_exists(5))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_nonexistent_issue(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/999"
        mock_get.side_effect = RuntimeError("404")
        self.assertFalse(eli.issue_exists(999))


class TestHasLinkedIssue(unittest.TestCase):
    @patch("enforce_linked_issue.issue_exists", return_value=True)
    def test_body_match(self, mock_exists):
        pr = {"body": "Fixes #10"}
        self.assertTrue(eli.has_linked_issue(1, pr))
        mock_exists.assert_called_once_with(10)

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_ignores_html_comment_reference(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.return_value = []
        pr = {"body": "## Closes\n\n<!-- Link issues: Closes #123 -->\n"}
        self.assertFalse(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.issue_exists", return_value=True)
    def test_real_ref_outside_comment(self, mock_exists):
        pr = {"body": "<!-- template -->\n\nCloses #40"}
        self.assertTrue(eli.has_linked_issue(1, pr))
        mock_exists.assert_called_once_with(40)

    @patch("enforce_linked_issue.issue_exists", return_value=False)
    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_nonexistent_issue_falls_through(self, mock_path, mock_get, mock_exists):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.return_value = []
        pr = {"body": "Closes #999"}
        self.assertFalse(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_timeline_cross_referenced(self, mock_path, mock_get):
        mock_path.side_effect = lambda suffix="": f"/repos/o/r{suffix}"
        mock_get.return_value = [{"event": "cross-referenced"}]
        pr = {"body": "no issue ref here"}
        self.assertTrue(eli.has_linked_issue(1, pr))
        mock_get.assert_called_once_with("/repos/o/r/issues/1/timeline?per_page=100")

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_timeline_connected(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline?per_page=100"
        mock_get.return_value = [{"event": "labeled"}, {"event": "connected"}]
        pr = {"body": "no issue ref here"}
        self.assertTrue(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_timeline_connected_then_disconnected(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline?per_page=100"
        mock_get.return_value = [{"event": "connected"}, {"event": "disconnected"}]
        pr = {"body": "no issue ref here"}
        self.assertFalse(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_forgejo_timeline_types_ignored(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline?per_page=100"
        mock_get.return_value = [{"type": "cross_ref"}, {"type": "ref"}]
        pr = {"body": "no issue ref here"}
        self.assertFalse(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_no_match_returns_false(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.return_value = []
        pr = {"body": "just a PR"}
        self.assertFalse(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.github_api.get")
    @patch("enforce_linked_issue.github_api.repo_path")
    def test_api_error_re_raises(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.side_effect = RuntimeError("timeout")
        pr = {"body": "no ref"}
        with self.assertRaises(RuntimeError) as ctx:
            eli.has_linked_issue(1, pr)
        self.assertIn("Timeline API unavailable", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
