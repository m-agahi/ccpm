"""Tests for scripts/lib/github_api.py."""

import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import github_api


def _mock_response(data):
    body = json.dumps(data).encode() if data is not None else b""
    resp = MagicMock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _http_error(code, body=b"oops"):
    return urllib.error.HTTPError("http://x", code, "Error", {}, io.BytesIO(body))


class TestToken(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_missing_token_raises_runtime_error(self):
        with self.assertRaises(RuntimeError) as ctx:
            github_api._token()
        self.assertIn("GITHUB_TOKEN", str(ctx.exception))

    @patch.dict(os.environ, {"GITHUB_TOKEN": "test-token-123"})
    def test_returns_token_when_set(self):
        self.assertEqual(github_api._token(), "test-token-123")

    @patch.dict(os.environ, {"FORGEJO_TOKEN": "old"}, clear=True)
    def test_forgejo_token_is_ignored(self):
        with self.assertRaises(RuntimeError):
            github_api._token()


class TestRepo(unittest.TestCase):
    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo"}, clear=True)
    def test_uses_github_repository(self):
        self.assertEqual(github_api._repo(), "owner/repo")

    @patch.dict(os.environ, {"FORGEJO_REPOSITORY": "owner/repo"}, clear=True)
    def test_forgejo_repository_is_ignored(self):
        with self.assertRaises(KeyError):
            github_api._repo()

    @patch.dict(os.environ, {}, clear=True)
    def test_raises_when_missing(self):
        with self.assertRaises(KeyError):
            github_api._repo()

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "../../admin/orgs"}, clear=True)
    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            github_api._repo()

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "valid-owner/valid.repo"}, clear=True)
    def test_accepts_valid_repo_with_dots_and_dashes(self):
        self.assertEqual(github_api._repo(), "valid-owner/valid.repo")


class TestApiBase(unittest.TestCase):
    def test_default_api_base_is_github(self):
        self.assertEqual(github_api.DEFAULT_API_BASE, "https://api.github.com")

    def test_default_uploads_base_is_github(self):
        self.assertEqual(github_api.DEFAULT_UPLOADS_BASE, "https://uploads.github.com")


class TestRequest(unittest.TestCase):
    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_get_parses_json(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"id": 1})
        result = github_api.get("/repos/o/r")
        self.assertEqual(result, {"id": 1})

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_sends_github_headers(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({})
        github_api.get("/repos/o/r")
        req = mock_urlopen.call_args[0][0]
        self.assertTrue(req.full_url.startswith(github_api.API_BASE + "/repos/o/r"))
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")
        self.assertEqual(req.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(req.get_header("X-github-api-version"), "2022-11-28")

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_returns_none_on_empty_body(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(None)
        result = github_api.get("/repos/o/r")
        self.assertIsNone(result)

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_raises_api_error_on_http_error(self, mock_urlopen):
        mock_urlopen.side_effect = _http_error(404, b"nope")
        with self.assertRaises(github_api.APIError) as ctx:
            github_api.get("/repos/o/r")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.body, "nope")

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_post_sends_body(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"ok": True})
        result = github_api.post("/repos/o/r", {"key": "val"})
        self.assertEqual(result, {"ok": True})
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.method, "POST")
        self.assertEqual(json.loads(req.data), {"key": "val"})
        self.assertEqual(req.get_header("Content-type"), "application/json")

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_response_size_limit(self, mock_urlopen):
        resp = MagicMock()
        resp.read.return_value = b"x" * (github_api.MAX_RESPONSE_BYTES + 2)
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = resp
        with self.assertRaises(RuntimeError) as ctx:
            github_api.get("/repos/o/r")
        self.assertIn("exceeds", str(ctx.exception))


class TestRetry(unittest.TestCase):
    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.time.sleep")
    @patch("lib.github_api.urllib.request.urlopen")
    def test_5xx_is_retried_and_succeeds_on_second_attempt(
        self, mock_urlopen, mock_sleep
    ):
        mock_urlopen.side_effect = [_http_error(502), _mock_response({"ok": True})]
        result = github_api.get("/repos/o/r")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_urlopen.call_count, 2)
        mock_sleep.assert_called_once_with(github_api._RETRY_DELAYS[0])

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.time.sleep")
    @patch("lib.github_api.urllib.request.urlopen")
    def test_5xx_exhausts_all_retries_and_raises(self, mock_urlopen, mock_sleep):
        total_attempts = len(github_api._RETRY_DELAYS) + 1
        mock_urlopen.side_effect = [_http_error(503)] * total_attempts
        with self.assertRaises(github_api.APIError) as ctx:
            github_api.get("/repos/o/r")
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(mock_urlopen.call_count, total_attempts)
        self.assertEqual(mock_sleep.call_count, len(github_api._RETRY_DELAYS))

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.time.sleep")
    @patch("lib.github_api.urllib.request.urlopen")
    def test_4xx_is_not_retried(self, mock_urlopen, mock_sleep):
        mock_urlopen.side_effect = _http_error(404)
        with self.assertRaises(github_api.APIError) as ctx:
            github_api.get("/repos/o/r")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(mock_urlopen.call_count, 1)
        mock_sleep.assert_not_called()


class TestUploadAsset(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp()
        os.write(fd, b"\x7fELF-binary")
        os.close(fd)
        self.release = {
            "id": 7,
            "upload_url": "https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}",
        }

    def tearDown(self):
        os.unlink(self.path)

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_posts_raw_body_to_upload_url(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"id": 99})
        result = github_api.upload_asset(self.release, self.path, "my plugin-amd64")
        self.assertEqual(result, {"id": 99})
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.method, "POST")
        self.assertEqual(
            req.full_url,
            "https://uploads.github.com/repos/o/r/releases/7/assets?name=my%20plugin-amd64",
        )
        self.assertEqual(req.data, pathlib.Path(self.path).read_bytes())
        self.assertEqual(req.get_header("Content-type"), "application/octet-stream")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")
        self.assertEqual(req.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(req.get_header("X-github-api-version"), "2022-11-28")

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_rejects_upload_url_outside_uploads_base(self, mock_urlopen):
        release = {"upload_url": "https://evil.example/assets{?name,label}"}
        with self.assertRaises(ValueError):
            github_api.upload_asset(release, self.path, "x")
        mock_urlopen.assert_not_called()

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_rejects_lookalike_host(self, mock_urlopen):
        release = {"upload_url": "https://uploads.github.com.evil.example/a{?name,label}"}
        with self.assertRaises(ValueError):
            github_api.upload_asset(release, self.path, "x")
        mock_urlopen.assert_not_called()

    @patch.dict(os.environ, {"GITHUB_TOKEN": "tok"})
    @patch("lib.github_api.urllib.request.urlopen")
    def test_http_error_raises_api_error_with_body(self, mock_urlopen):
        mock_urlopen.side_effect = _http_error(422, b'{"errors":[{"code":"already_exists"}]}')
        with self.assertRaises(github_api.APIError) as ctx:
            github_api.upload_asset(self.release, self.path, "x")
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertTrue(github_api.is_already_exists(ctx.exception))


class TestIsAlreadyExists(unittest.TestCase):
    def test_true_for_422_already_exists(self):
        err = github_api.APIError(
            "POST", "u", 422, '{"errors":[{"resource":"Release","code":"already_exists"}]}'
        )
        self.assertTrue(github_api.is_already_exists(err))

    def test_false_for_422_validation_error(self):
        err = github_api.APIError("POST", "u", 422, '{"errors":[{"code":"invalid"}]}')
        self.assertFalse(github_api.is_already_exists(err))

    def test_false_for_other_status(self):
        err = github_api.APIError("POST", "u", 500, "already_exists")
        self.assertFalse(github_api.is_already_exists(err))


class TestUrlConstruction(unittest.TestCase):
    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_TOKEN": "tok"})
    def test_repo_path(self):
        self.assertEqual(github_api.repo_path(), "/repos/owner/repo")
        self.assertEqual(github_api.repo_path("/labels"), "/repos/owner/repo/labels")

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_TOKEN": "tok"})
    def test_issue_labels_path(self):
        self.assertEqual(
            github_api.issue_labels_path(42), "/repos/owner/repo/issues/42/labels"
        )

    @patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_TOKEN": "tok"})
    def test_issue_comments_path(self):
        self.assertEqual(
            github_api.issue_comments_path(7), "/repos/owner/repo/issues/7/comments"
        )


class TestAPIError(unittest.TestCase):
    def test_is_runtime_error_subclass(self):
        err = github_api.APIError("GET", "http://x", 500, "fail")
        self.assertIsInstance(err, RuntimeError)
        self.assertEqual(err.status_code, 500)
        self.assertEqual(err.body, "fail")
        self.assertIn("500", str(err))


if __name__ == "__main__":
    unittest.main()
