"""Tests for scripts/lib/workflow_io.py."""

import os
import sys
import tempfile
import unittest
from io import StringIO
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import workflow_io


class TestRequireEnv(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_exits_when_unset(self):
        with self.assertRaises(SystemExit) as ctx:
            workflow_io.require_env("MISSING_VAR")
        self.assertEqual(ctx.exception.code, 1)

    @patch.dict(os.environ, {"EMPTY_VAR": ""})
    def test_exits_when_empty_string(self):
        with self.assertRaises(SystemExit) as ctx:
            workflow_io.require_env("EMPTY_VAR")
        self.assertEqual(ctx.exception.code, 1)

    @patch.dict(os.environ, {"PRESENT_VAR": "value"})
    def test_returns_value_when_set(self):
        self.assertEqual(workflow_io.require_env("PRESENT_VAR"), "value")


class TestSetOutput(unittest.TestCase):
    def test_writes_to_output_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            path = f.name
        try:
            with patch.dict(os.environ, {"FORGEJO_OUTPUT": path}):
                workflow_io.set_output("key1", "val1")
                workflow_io.set_output("key2", "val2")
            with open(path) as f:
                content = f.read()
            self.assertIn("key1=val1\n", content)
            self.assertIn("key2=val2\n", content)
        finally:
            os.unlink(path)

    def test_encodes_newlines_in_value(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            path = f.name
        try:
            with patch.dict(os.environ, {"FORGEJO_OUTPUT": path}):
                workflow_io.set_output("releases", "line1\nline2\rline3")
            with open(path) as f:
                content = f.read()
            self.assertEqual(content, "releases=line1%0Aline2%0Dline3\n")
        finally:
            os.unlink(path)

    @patch.dict(os.environ, {}, clear=True)
    @patch("sys.stderr", new_callable=StringIO)
    def test_warns_when_output_not_set(self, mock_stderr):
        workflow_io.set_output("k", "v")
        self.assertIn("WARNING", mock_stderr.getvalue())


class TestError(unittest.TestCase):
    @patch("sys.stdout", new_callable=StringIO)
    def test_emits_error_annotation(self, mock_stdout):
        workflow_io.error("something broke")
        self.assertEqual(mock_stdout.getvalue(), "::error::something broke\n")


if __name__ == "__main__":
    unittest.main()
