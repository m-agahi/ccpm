"""Tests for scripts/lib/git.py."""

import os
import subprocess
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import git
from tests.gitrepo import TempRepo


class TestRun(unittest.TestCase):
    @patch("lib.git.subprocess.run")
    def test_returns_stripped_stdout(self, mock_run):
        mock_run.return_value = MagicMock(stdout="  hello world  \n", returncode=0)
        result = git.run("status")
        self.assertEqual(result, "hello world")

    @patch("lib.git.subprocess.run")
    def test_raises_runtime_error_with_stderr(self, mock_run):
        err = subprocess.CalledProcessError(128, ["git", "show"])
        err.stderr = "fatal: bad revision"
        mock_run.side_effect = err
        with self.assertRaises(RuntimeError) as ctx:
            git.run("show", "HEAD:missing")
        self.assertIn("fatal: bad revision", str(ctx.exception))
        self.assertIn("exit 128", str(ctx.exception))

    @patch("lib.git.subprocess.run")
    def test_raises_with_no_stderr(self, mock_run):
        err = subprocess.CalledProcessError(1, ["git", "diff"])
        err.stderr = ""
        mock_run.side_effect = err
        with self.assertRaises(RuntimeError) as ctx:
            git.run("diff")
        self.assertIn("(no stderr)", str(ctx.exception))


class TestDiffNames(unittest.TestCase):
    @patch("lib.git.run")
    def test_splits_output(self, mock_run):
        mock_run.return_value = "file1.py\nfile2.py\nfile3.py"
        result = git.diff_names("HEAD~1")
        self.assertEqual(result, ["file1.py", "file2.py", "file3.py"])

    @patch("lib.git.run")
    def test_empty_output(self, mock_run):
        mock_run.return_value = ""
        result = git.diff_names("HEAD~1")
        self.assertEqual(result, [])


class TestShowFile(unittest.TestCase):
    @patch("lib.git.run")
    def test_returns_content(self, mock_run):
        mock_run.return_value = '{"key": "value"}'
        result = git.show_file("HEAD", "file.json")
        self.assertEqual(result, '{"key": "value"}')

    @patch("lib.git.run")
    def test_returns_none_on_missing(self, mock_run):
        mock_run.side_effect = subprocess.CalledProcessError(128, "git")
        result = git.show_file("HEAD", "missing.json")
        self.assertIsNone(result)

    @patch("lib.git.run")
    def test_returns_none_when_run_raises_runtime_error(self, mock_run):
        # git.run converts CalledProcessError into RuntimeError.
        mock_run.side_effect = RuntimeError("git show failed (exit 128)")
        self.assertIsNone(git.show_file("HEAD", "missing.json"))


class TestRealRepo(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)
        self.first = self.repo.commit({"a.txt": "1"})
        self.second = self.repo.commit({"a.txt": "2"})

    def test_show_file_missing_path_returns_none(self):
        self.assertIsNone(git.show_file(self.first, "nope.json"))

    def test_show_file_existing_path(self):
        self.assertEqual(git.show_file(self.first, "a.txt"), "1")

    def test_commit_sha_resolves_ref(self):
        self.assertEqual(git.commit_sha("HEAD~1"), self.first)

    def test_commit_sha_unknown_returns_none(self):
        self.assertIsNone(git.commit_sha("0123456789abcdef0123456789abcdef01234567"))
        self.assertIsNone(git.commit_sha("no-such-branch"))

    def test_commit_sha_rejects_option_like_ref(self):
        self.assertIsNone(git.commit_sha("--all"))

    def test_is_ancestor(self):
        self.assertTrue(git.is_ancestor(self.first, "HEAD"))
        self.assertFalse(git.is_ancestor(self.second, self.first))


if __name__ == "__main__":
    unittest.main()
