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
            with patch.dict(os.environ, {"GITHUB_OUTPUT": path}):
                workflow_io.set_output("key1", "val1")
                workflow_io.set_output("key2", "val2")
            with open(path) as f:
                content = f.read()
            self.assertIn("key1=val1\n", content)
            self.assertIn("key2=val2\n", content)
        finally:
            os.unlink(path)

    def _write(self, key, value):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            path = f.name
        self.addCleanup(os.unlink, path)
        with patch.dict(os.environ, {"GITHUB_OUTPUT": path}):
            workflow_io.set_output(key, value)
        with open(path, newline="") as f:
            return f.read()

    def test_single_line_value_is_written_verbatim(self):
        # No legacy %25/%0A escaping: GITHUB_OUTPUT never decodes it.
        self.assertEqual(self._write("k", "100% a,b"), "k=100% a,b\n")

    def test_multiline_value_uses_heredoc_delimiter(self):
        content = self._write("releases", "line1\nline2\rline3")
        lines = content.split("\n")
        self.assertTrue(lines[0].startswith("releases<<ghadelimiter_"))
        delim = lines[0].split("<<", 1)[1]
        self.assertEqual(content, f"releases<<{delim}\nline1\nline2\rline3\n{delim}\n")

    def test_delimiter_never_occurs_in_value(self):
        with patch("lib.workflow_io.uuid.uuid4") as mock_uuid:
            mock_uuid.side_effect = [type("U", (), {"hex": "aaa"})(), type("U", (), {"hex": "bbb"})()]
            content = self._write("k", "x\nghadelimiter_aaa\ny")
        self.assertTrue(content.startswith("k<<ghadelimiter_bbb\n"))

    @patch("sys.stderr", new_callable=StringIO)
    def test_forgejo_output_is_ignored(self, mock_stderr):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            path = f.name
        try:
            with patch.dict(os.environ, {"FORGEJO_OUTPUT": path}, clear=True):
                workflow_io.set_output("k", "v")
            with open(path) as f:
                self.assertEqual(f.read(), "")
            self.assertIn("GITHUB_OUTPUT not set", mock_stderr.getvalue())
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
