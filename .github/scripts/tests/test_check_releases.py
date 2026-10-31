"""Tests for scripts/check_releases.py."""

import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import check_releases  # noqa: E402
from tests.gitrepo import TempRepo  # noqa: E402

MP = ".claude-plugin/marketplace.json"


def _mp(**versions):
    return json.dumps(
        {"plugins": [{"name": n, "version": v} for n, v in versions.items()]}
    )


class TestComputeReleases(unittest.TestCase):
    def _compute(self, old, new):
        return check_releases.compute_releases(json.loads(old), json.loads(new))

    def test_new_plugin(self):
        self.assertEqual(
            self._compute(_mp(), _mp(a="1.0.0")),
            [{"name": "a", "version": "1.0.0", "type": "new"}],
        )

    def test_updated_plugin(self):
        self.assertEqual(
            self._compute(_mp(a="1.0.0"), _mp(a="1.1.0")),
            [{"name": "a", "version": "1.1.0", "type": "update", "old_version": "1.0.0"}],
        )

    def test_unchanged_plugin(self):
        self.assertEqual(self._compute(_mp(a="1.0.0"), _mp(a="1.0.0")), [])

    def test_removed_plugin_is_ignored(self):
        self.assertEqual(self._compute(_mp(a="1.0.0", b="2.0.0"), _mp(a="1.0.0")), [])

    def test_missing_version_is_ignored(self):
        old = {"plugins": []}
        new = {"plugins": [{"name": "a"}]}
        self.assertEqual(check_releases.compute_releases(old, new), [])


class TestMain(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)
        fd, self.out = tempfile.mkstemp()
        os.close(fd)
        self.addCleanup(os.unlink, self.out)

    def _run(self, base_ref):
        env = {"GITHUB_OUTPUT": self.out, "BASE_REF": base_ref}
        with patch.dict(os.environ, env), patch("sys.stdout", new_callable=StringIO):
            check_releases.main()
        with open(self.out) as f:
            return f.read()

    def test_reads_base_from_env(self):
        base = self.repo.commit({MP: _mp(a="1.0.0", b="1.0.0")})
        self.repo.commit({MP: _mp(a="1.0.0", b="1.1.0")})
        self.repo.commit({MP: _mp(a="1.0.1", b="1.1.0")})
        out = self._run(base)
        self.assertIn("has_releases=true", out)
        self.assertIn('"name": "a"', out)
        self.assertIn('"name": "b"', out)

    def test_unchanged(self):
        base = self.repo.commit({MP: _mp(a="1.0.0")})
        self.repo.commit({"README.md": "x"})
        self.assertEqual(self._run(base), "has_releases=false\n")

    def test_empty_base_treats_all_as_new(self):
        self.repo.commit({MP: _mp(a="1.0.0")})
        out = self._run("")
        self.assertIn("has_releases=true", out)
        self.assertIn('"type": "new"', out)

    def test_base_without_marketplace_treats_all_as_new(self):
        base = self.repo.commit({"README.md": "x"})
        self.repo.commit({MP: _mp(a="1.0.0")})
        self.assertIn('"type": "new"', self._run(base))

    def test_unknown_base_fails(self):
        self.repo.commit({MP: _mp(a="1.0.0")})
        with self.assertRaises(SystemExit) as ctx:
            with patch("sys.stderr", new_callable=StringIO):
                self._run("ab" * 20)
        self.assertEqual(ctx.exception.code, 1)
        with open(self.out) as f:
            self.assertEqual(f.read(), "")


if __name__ == "__main__":
    unittest.main()
