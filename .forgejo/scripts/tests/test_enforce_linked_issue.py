"""Tests for scripts/enforce_linked_issue.py."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import forgejo_api

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
    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_admin_is_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/alice/permission"
        mock_get.return_value = {"permission": "admin"}
        pr = {"user": {"login": "alice"}}
        self.assertTrue(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_owner_is_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/bob/permission"
        mock_get.return_value = {"permission": "owner"}
        pr = {"user": {"login": "bob"}}
        self.assertTrue(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_write_is_not_exempt(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/carol/permission"
        mock_get.return_value = {"permission": "write"}
        pr = {"user": {"login": "carol"}}
        self.assertFalse(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_none_response_returns_false(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/dave/permission"
        mock_get.return_value = None
        pr = {"user": {"login": "dave"}}
        self.assertFalse(eli.is_author_exempt(pr))

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_api_error_returns_false(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/collaborators/eve/permission"
        mock_get.side_effect = RuntimeError("API down")
        pr = {"user": {"login": "eve"}}
        self.assertFalse(eli.is_author_exempt(pr))


class TestHasLinkedIssue(unittest.TestCase):
    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_body_match(self, mock_path, mock_get):
        pr = {"body": "Fixes #10"}
        self.assertTrue(eli.has_linked_issue(1, pr))
        mock_get.assert_not_called()

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_timeline_cross_ref(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.return_value = [{"type": "cross_ref"}]
        pr = {"body": "no issue ref here"}
        self.assertTrue(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_no_match_returns_false(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.return_value = []
        pr = {"body": "just a PR"}
        self.assertFalse(eli.has_linked_issue(1, pr))

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_api_error_re_raises(self, mock_path, mock_get):
        mock_path.return_value = "/repos/o/r/issues/1/timeline"
        mock_get.side_effect = RuntimeError("timeout")
        pr = {"body": "no ref"}
        with self.assertRaises(RuntimeError) as ctx:
            eli.has_linked_issue(1, pr)
        self.assertIn("Timeline API unavailable", str(ctx.exception))


class TestGetOrCreateLabelId(unittest.TestCase):
    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.post")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_returns_id_from_post_response(self, mock_path, mock_post, mock_get):
        mock_path.return_value = "/repos/o/r/labels"
        mock_post.return_value = {"id": 42, "name": "missing-issue"}
        result = eli.get_or_create_label_id()
        self.assertEqual(result, 42)
        mock_get.assert_not_called()

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.post")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_falls_back_to_get_on_409(self, mock_path, mock_post, mock_get):
        mock_path.return_value = "/repos/o/r/labels"
        mock_post.side_effect = forgejo_api.APIError("POST", "url", 409, "conflict")
        mock_get.return_value = [
            {"id": 99, "name": "missing-issue"},
            {"id": 100, "name": "other"},
        ]
        result = eli.get_or_create_label_id()
        self.assertEqual(result, 99)

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.post")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_raises_on_non_409_error(self, mock_path, mock_post, mock_get):
        mock_path.return_value = "/repos/o/r/labels"
        mock_post.side_effect = forgejo_api.APIError("POST", "url", 500, "server err")
        with self.assertRaises(forgejo_api.APIError) as ctx:
            eli.get_or_create_label_id()
        self.assertEqual(ctx.exception.status_code, 500)

    @patch("enforce_linked_issue.forgejo_api.get")
    @patch("enforce_linked_issue.forgejo_api.post")
    @patch("enforce_linked_issue.forgejo_api.repo_path")
    def test_returns_none_when_label_not_found(self, mock_path, mock_post, mock_get):
        mock_path.return_value = "/repos/o/r/labels"
        mock_post.side_effect = forgejo_api.APIError("POST", "url", 409, "conflict")
        mock_get.return_value = [{"id": 1, "name": "other-label"}]
        result = eli.get_or_create_label_id()
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
