"""Tests for scripts/lib/git.py."""

import os
import subprocess
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import git


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


if __name__ == "__main__":
    unittest.main()
