"""Tests for scripts/lib/forgejo_api.py."""

import io
import json
import os
import sys
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import forgejo_api


class TestToken(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_missing_token_raises_runtime_error(self):
        with self.assertRaises(RuntimeError) as ctx:
            forgejo_api._token()
        self.assertIn("FORGEJO_TOKEN", str(ctx.exception))

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "test-token-123"})
    def test_returns_token_when_set(self):
        self.assertEqual(forgejo_api._token(), "test-token-123")


class TestRepo(unittest.TestCase):
    @patch.dict(os.environ, {"FORGEJO_REPOSITORY": "owner/repo"}, clear=True)
    def test_uses_forgejo_repository(self):
        self.assertEqual(forgejo_api._repo(), "owner/repo")

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo"}, clear=True)
    def test_falls_back_to_github_repository(self):
        self.assertEqual(forgejo_api._repo(), "owner/repo")

    @patch.dict(
        os.environ,
        {"FORGEJO_REPOSITORY": "forgejo/repo", "GITHUB_REPOSITORY": "github/repo"},
    )
    def test_prefers_forgejo_over_github(self):
        self.assertEqual(forgejo_api._repo(), "forgejo/repo")

    @patch.dict(os.environ, {}, clear=True)
    def test_raises_when_both_missing(self):
        with self.assertRaises(KeyError):
            forgejo_api._repo()

    @patch.dict(os.environ, {"FORGEJO_REPOSITORY": "../../admin/orgs"}, clear=True)
    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            forgejo_api._repo()

    @patch.dict(os.environ, {"FORGEJO_REPOSITORY": "valid-owner/valid.repo"}, clear=True)
    def test_accepts_valid_repo_with_dots_and_dashes(self):
        self.assertEqual(forgejo_api._repo(), "valid-owner/valid.repo")


class TestRequest(unittest.TestCase):
    def _mock_response(self, data, status=200):
        body = json.dumps(data).encode() if data is not None else b""
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_get_parses_json(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_response({"id": 1})
        result = forgejo_api.get("/repos/o/r")
        self.assertEqual(result, {"id": 1})

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_returns_none_on_empty_body(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_response(None)
        result = forgejo_api.get("/repos/o/r")
        self.assertIsNone(result)

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_raises_api_error_on_http_error(self, mock_urlopen):
        error = urllib.error.HTTPError(
            "http://x", 404, "Not Found", {}, io.BytesIO(b"nope")
        )
        mock_urlopen.side_effect = error
        with self.assertRaises(forgejo_api.APIError) as ctx:
            forgejo_api.get("/repos/o/r")
        self.assertEqual(ctx.exception.status_code, 404)

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_post_sends_body(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_response({"ok": True})
        result = forgejo_api.post("/repos/o/r", {"key": "val"})
        self.assertEqual(result, {"ok": True})
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.method, "POST")
        self.assertEqual(json.loads(req.data), {"key": "val"})

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_response_size_limit(self, mock_urlopen):
        resp = MagicMock()
        resp.read.return_value = b"x" * (forgejo_api.MAX_RESPONSE_BYTES + 2)
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = resp
        with self.assertRaises(RuntimeError) as ctx:
            forgejo_api.get("/repos/o/r")
        self.assertIn("exceeds", str(ctx.exception))


class TestRetry(unittest.TestCase):
    def _mock_response(self, data):
        body = json.dumps(data).encode()
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    def _http_error(self, code):
        return urllib.error.HTTPError(
            "http://x", code, "Error", {}, io.BytesIO(b"oops")
        )

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.time.sleep")
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_5xx_is_retried_and_succeeds_on_second_attempt(
        self, mock_urlopen, mock_sleep
    ):
        mock_urlopen.side_effect = [
            self._http_error(502),
            self._mock_response({"ok": True}),
        ]
        result = forgejo_api.get("/repos/o/r")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_urlopen.call_count, 2)
        mock_sleep.assert_called_once_with(forgejo_api._RETRY_DELAYS[0])

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.time.sleep")
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_5xx_exhausts_all_retries_and_raises(self, mock_urlopen, mock_sleep):
        total_attempts = len(forgejo_api._RETRY_DELAYS) + 1
        mock_urlopen.side_effect = [self._http_error(503)] * total_attempts
        with self.assertRaises(forgejo_api.APIError) as ctx:
            forgejo_api.get("/repos/o/r")
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(mock_urlopen.call_count, total_attempts)
        self.assertEqual(mock_sleep.call_count, len(forgejo_api._RETRY_DELAYS))

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "tok"})
    @patch("lib.forgejo_api.time.sleep")
    @patch("lib.forgejo_api.urllib.request.urlopen")
    def test_4xx_is_not_retried(self, mock_urlopen, mock_sleep):
        mock_urlopen.side_effect = self._http_error(404)
        with self.assertRaises(forgejo_api.APIError) as ctx:
            forgejo_api.get("/repos/o/r")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(mock_urlopen.call_count, 1)
        mock_sleep.assert_not_called()


class TestUrlConstruction(unittest.TestCase):
    @patch.dict(
        os.environ,
        {"FORGEJO_REPOSITORY": "owner/repo", "FORGEJO_TOKEN": "tok"},
    )
    def test_repo_path(self):
        self.assertEqual(forgejo_api.repo_path(), "/repos/owner/repo")
        self.assertEqual(forgejo_api.repo_path("/labels"), "/repos/owner/repo/labels")

    @patch.dict(
        os.environ,
        {"FORGEJO_REPOSITORY": "owner/repo", "FORGEJO_TOKEN": "tok"},
    )
    def test_issue_labels_path(self):
        self.assertEqual(
            forgejo_api.issue_labels_path(42), "/repos/owner/repo/issues/42/labels"
        )

    @patch.dict(
        os.environ,
        {"FORGEJO_REPOSITORY": "owner/repo", "FORGEJO_TOKEN": "tok"},
    )
    def test_issue_comments_path(self):
        self.assertEqual(
            forgejo_api.issue_comments_path(7), "/repos/owner/repo/issues/7/comments"
        )


class TestAPIError(unittest.TestCase):
    def test_is_runtime_error_subclass(self):
        err = forgejo_api.APIError("GET", "http://x", 500, "fail")
        self.assertIsInstance(err, RuntimeError)
        self.assertEqual(err.status_code, 500)
        self.assertIn("500", str(err))


if __name__ == "__main__":
    unittest.main()
