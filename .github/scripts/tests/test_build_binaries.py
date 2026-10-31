"""Tests for scripts/build_binaries.py."""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from io import StringIO
from unittest.mock import MagicMock, call, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import build_binaries  # noqa: E402
from lib.github_api import APIError  # noqa: E402

RELEASE = {"id": 7, "upload_url": "https://uploads.github.com/x/assets{?name,label}"}
EXISTS = APIError("POST", "u", 422, '{"errors":[{"code":"already_exists"}]}')


class _Env(unittest.TestCase):
    def setUp(self):
        p = patch.dict(os.environ, {"GITHUB_REPOSITORY": "o/r", "GITHUB_TOKEN": "t"})
        p.start()
        self.addCleanup(p.stop)
        for stream in ("sys.stdout", "sys.stderr"):
            s = patch(stream, new_callable=StringIO)
            s.start()
            self.addCleanup(s.stop)


class TestFindRelease(_Env):
    @patch("build_binaries.github_api.get")
    def test_404_returns_none(self, mock_get):
        mock_get.side_effect = APIError("GET", "u", 404, "Not Found")
        self.assertIsNone(build_binaries.find_release("p/v1.0.0"))
        mock_get.assert_called_once_with("/repos/o/r/releases/tags/p%2Fv1.0.0")


class TestBuildBinary(unittest.TestCase):
    @patch("build_binaries.run")
    def test_cargo_build_is_locked(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1)
        with tempfile.TemporaryDirectory() as d, patch("sys.stdout", new_callable=StringIO):
            cargo = pathlib.Path(d) / "Cargo.toml"
            cargo.write_text('[package]\nname = "x"\n')
            build_binaries.build_binary(cargo, "x86_64-unknown-linux-gnu")
        cmd = mock_run.call_args.args[0]
        self.assertEqual(cmd[:2], ["cargo", "build"])
        self.assertIn("--locked", cmd)


class TestUploadAsset(_Env):
    @patch("build_binaries.github_api.delete")
    @patch("build_binaries.github_api.get")
    @patch("build_binaries.github_api.upload_asset")
    def test_success(self, mock_upload, mock_get, mock_delete):
        self.assertTrue(build_binaries.upload_binary(RELEASE, "bin", "a"))
        mock_get.assert_not_called()
        mock_delete.assert_not_called()

    @patch("build_binaries.github_api.delete")
    @patch("build_binaries.github_api.get")
    @patch("build_binaries.github_api.upload_asset")
    def test_already_uploaded_is_skipped(self, mock_upload, mock_get, mock_delete):
        mock_upload.side_effect = EXISTS
        mock_get.return_value = [{"id": 99, "name": "a", "state": "uploaded"}]
        self.assertTrue(build_binaries.upload_binary(RELEASE, "bin", "a"))
        mock_get.assert_called_once_with("/repos/o/r/releases/7/assets?per_page=100")
        mock_delete.assert_not_called()
        self.assertEqual(mock_upload.call_count, 1)

    @patch("build_binaries.github_api.delete")
    @patch("build_binaries.github_api.get")
    @patch("build_binaries.github_api.upload_asset")
    def test_broken_asset_is_replaced(self, mock_upload, mock_get, mock_delete):
        mock_upload.side_effect = [EXISTS, {"id": 100}]
        mock_get.return_value = [
            {"id": 98, "name": "other", "state": "uploaded"},
            {"id": 99, "name": "a", "state": "starter"},
        ]
        self.assertTrue(build_binaries.upload_binary(RELEASE, "bin", "a"))
        mock_delete.assert_called_once_with("/repos/o/r/releases/assets/99")
        self.assertEqual(mock_upload.call_args_list, [call(RELEASE, "bin", "a")] * 2)

    @patch("build_binaries.github_api.delete")
    @patch("build_binaries.github_api.get")
    @patch("build_binaries.github_api.upload_asset")
    def test_failed_reupload_is_failure(self, mock_upload, mock_get, mock_delete):
        mock_upload.side_effect = [EXISTS, APIError("POST", "u", 500, "boom")]
        mock_get.return_value = [{"id": 99, "name": "a", "state": "starter"}]
        self.assertFalse(build_binaries.upload_binary(RELEASE, "bin", "a"))

    @patch("build_binaries.github_api.get")
    @patch("build_binaries.github_api.upload_asset")
    def test_conflict_without_listed_asset_is_failure(self, mock_upload, mock_get):
        mock_upload.side_effect = EXISTS
        mock_get.return_value = []
        self.assertFalse(build_binaries.upload_binary(RELEASE, "bin", "a"))

    @patch("build_binaries.github_api.upload_asset")
    def test_other_error_is_failure(self, mock_upload):
        mock_upload.side_effect = APIError("POST", "u", 403, "forbidden")
        self.assertFalse(build_binaries.upload_binary(RELEASE, "bin", "a"))


class TestMain(_Env):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        old = os.getcwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, old)
        pathlib.Path(".ci-outputs").mkdir()
        pathlib.Path(".ci-outputs/releases.json").write_text(
            json.dumps([{"name": "p", "version": "1.0.0"}, {"name": "q", "version": "2.0.0"}])
        )
        pathlib.Path("plugins/p/indexer").mkdir(parents=True)
        pathlib.Path("plugins/p/indexer/Cargo.toml").write_text('name = "x"\n')

    @patch("build_binaries.upload_binary", return_value=True)
    @patch("build_binaries.build_binary")
    @patch("build_binaries.find_release", return_value=RELEASE)
    def test_partial_build_failure_exits_1(self, _find, mock_build, mock_upload):
        mock_build.side_effect = lambda cargo, triple: (
            None if triple.startswith("aarch64") else pathlib.Path("bin")
        )
        with self.assertRaises(SystemExit) as ctx:
            build_binaries.main()
        self.assertEqual(ctx.exception.code, 1)
        mock_upload.assert_called_once()

    @patch("build_binaries.build_binary")
    @patch("build_binaries.find_release", return_value=None)
    def test_missing_release_exits_1(self, _find, mock_build):
        with self.assertRaises(SystemExit) as ctx:
            build_binaries.main()
        self.assertEqual(ctx.exception.code, 1)
        mock_build.assert_not_called()

    @patch("build_binaries.upload_binary", return_value=True)
    @patch("build_binaries.build_binary", return_value=pathlib.Path("bin"))
    @patch("build_binaries.find_release", return_value=RELEASE)
    def test_all_ok_does_not_exit(self, _find, _build, mock_upload):
        build_binaries.main()
        self.assertEqual(mock_upload.call_count, 2)


if __name__ == "__main__":
    unittest.main()
