"""Tests for scripts/resolve_base_ref.py."""

import os
import sys
import tempfile
import unittest
from io import StringIO
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import resolve_base_ref as rbr  # noqa: E402
from tests.gitrepo import TempRepo  # noqa: E402

ZEROS = "0" * 40


class TestResolveBaseRef(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)
        self.c1 = self.repo.commit({"a.txt": "1"})
        self.c2 = self.repo.commit({"a.txt": "2"})
        self.c3 = self.repo.commit({"a.txt": "3"})

    def test_push_before_is_used(self):
        self.assertEqual(rbr.resolve_base_ref(before=self.c1), self.c1)

    def test_zero_before_falls_back_to_parent(self):
        self.assertEqual(rbr.resolve_base_ref(before=ZEROS), self.c2)

    def test_empty_before_falls_back_to_parent(self):
        self.assertEqual(rbr.resolve_base_ref(before=""), self.c2)

    def test_unknown_before_falls_back_to_parent(self):
        self.assertEqual(rbr.resolve_base_ref(before="ab" * 20), self.c2)

    def test_non_ancestor_before_falls_back_to_parent(self):
        # Simulate a force push: before points at a commit not in HEAD's history.
        self.repo.git("checkout", "-q", "-b", "side", self.c1)
        side = self.repo.commit({"b.txt": "x"})
        self.repo.git("checkout", "-q", "master")
        self.assertEqual(rbr.resolve_base_ref(before=side), self.c2)

    def test_explicit_base_wins_over_before(self):
        self.assertEqual(rbr.resolve_base_ref(before=self.c2, explicit="HEAD~2"), self.c1)

    def test_explicit_unknown_base_raises(self):
        with self.assertRaises(ValueError):
            rbr.resolve_base_ref(explicit="no-such-ref")

    def test_explicit_option_like_base_raises(self):
        with self.assertRaises(ValueError):
            rbr.resolve_base_ref(explicit="--output=/tmp/x")


class TestRootCommit(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)
        self.repo.commit({"a.txt": "1"})

    def test_root_commit_has_no_base(self):
        self.assertEqual(rbr.resolve_base_ref(before=ZEROS), "")


class TestMain(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)
        self.c1 = self.repo.commit({"a.txt": "1"})
        self.repo.commit({"a.txt": "2"})
        fd, self.out = tempfile.mkstemp()
        os.close(fd)
        self.addCleanup(os.unlink, self.out)

    def _read_out(self):
        with open(self.out) as f:
            return f.read()

    def test_writes_output(self):
        env = {"GITHUB_OUTPUT": self.out, "BEFORE_SHA": self.c1, "INPUT_BASE_REF": ""}
        with patch.dict(os.environ, env):
            rbr.main()
        self.assertEqual(self._read_out(), f"base_ref={self.c1}\n")

    @patch("sys.stdout", new_callable=StringIO)
    def test_invalid_explicit_exits_1(self, _stdout):
        env = {"GITHUB_OUTPUT": self.out, "BEFORE_SHA": "", "INPUT_BASE_REF": "nope"}
        with patch.dict(os.environ, env):
            with self.assertRaises(SystemExit) as ctx:
                rbr.main()
        self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(self._read_out(), "")


if __name__ == "__main__":
    unittest.main()
