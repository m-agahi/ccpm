"""Tests for scripts/check_changelog.py — file classification logic."""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from check_changelog_staged import check_marketplace_bumps  # noqa: E402


class TestChangelogClassification(unittest.TestCase):
    """Test the file classification logic extracted from check_changelog.py."""

    def _classify(self, changed_files):
        """Reproduce the classification logic from check_changelog.py."""
        plugins_changed = set()
        plugins_with_changelog = set()
        for f in changed_files:
            parts = pathlib.PurePosixPath(f).parts
            if len(parts) >= 2 and parts[0] == "plugins":
                plugin_name = parts[1]
                if f == f"plugins/{plugin_name}/CHANGELOG.md":
                    plugins_with_changelog.add(plugin_name)
                else:
                    plugins_changed.add(plugin_name)
        return plugins_changed - plugins_with_changelog

    def test_plugin_change_without_changelog(self):
        missing = self._classify(["plugins/foo/src/main.py"])
        self.assertEqual(missing, {"foo"})

    def test_plugin_change_with_changelog(self):
        missing = self._classify(
            [
                "plugins/foo/src/main.py",
                "plugins/foo/CHANGELOG.md",
            ]
        )
        self.assertEqual(missing, set())

    def test_non_plugin_file_ignored(self):
        missing = self._classify(["README.md", ".github/scripts/check.py"])
        self.assertEqual(missing, set())

    def test_multiple_plugins_mixed(self):
        missing = self._classify(
            [
                "plugins/foo/src/main.py",
                "plugins/foo/CHANGELOG.md",
                "plugins/bar/src/main.py",
            ]
        )
        self.assertEqual(missing, {"bar"})


class TestMarketplaceBumps(unittest.TestCase):
    """Tests for check_marketplace_bumps — marketplace.json version-bump checks."""

    def _make_mp(self, plugins_dict):
        """Build a marketplace dict from {name: version}."""
        return {"plugins": [{"name": n, "version": v} for n, v in plugins_dict.items()]}

    def _changelog_with_version(self, version):
        return f"# Changelog\n\n## [{version}] - 2026-01-01\n\n### Fixed\n\n- some fix\n"

    def _no_changelog(self, _name):
        return ""

    def test_bump_with_matching_changelog_heading(self):
        """Version bump + matching CHANGELOG heading → no failures."""
        staged = self._make_mp({"repo-wiki": "1.1.2"})
        head = self._make_mp({"repo-wiki": "1.1.1"})

        def reader(name):
            return self._changelog_with_version("1.1.2")

        failures = check_marketplace_bumps(staged, head, set(), reader)
        self.assertEqual(failures, [])

    def test_bump_with_no_changelog_entry(self):
        """Version bump + no matching CHANGELOG entry → reports missing."""
        staged = self._make_mp({"repo-wiki": "1.1.2"})
        head = self._make_mp({"repo-wiki": "1.1.1"})

        def reader(name):
            return self._changelog_with_version("1.1.1")

        failures = check_marketplace_bumps(staged, head, set(), reader)
        self.assertEqual(len(failures), 1)
        self.assertIn("repo-wiki", failures[0])
        self.assertIn("1.1.2", failures[0])

    def test_bump_satisfied_by_staged_changelog(self):
        """Version bump + CHANGELOG.md staged in same commit → passes without reading disk."""
        staged = self._make_mp({"repo-wiki": "1.1.2"})
        head = self._make_mp({"repo-wiki": "1.1.1"})

        def reader(name):
            # Should never be called — staged changelog satisfies requirement
            raise AssertionError("reader should not be called when CHANGELOG is staged")

        failures = check_marketplace_bumps(staged, head, {"repo-wiki"}, reader)
        self.assertEqual(failures, [])

    def test_new_plugin_no_head_version_with_changelog(self):
        """Plugin added to marketplace (no HEAD version) + CHANGELOG present → passes."""
        staged = self._make_mp({"new-plugin": "1.0.0"})
        head = self._make_mp({})

        def reader(name):
            return self._changelog_with_version("1.0.0")

        failures = check_marketplace_bumps(staged, head, set(), reader)
        self.assertEqual(failures, [])

    def test_new_plugin_no_head_version_missing_changelog(self):
        """Plugin added to marketplace (no HEAD version) + no CHANGELOG → reports missing."""
        staged = self._make_mp({"new-plugin": "1.0.0"})
        head = self._make_mp({})
        failures = check_marketplace_bumps(staged, head, set(), self._no_changelog)
        self.assertEqual(len(failures), 1)
        self.assertIn("new-plugin", failures[0])
        self.assertIn("1.0.0", failures[0])

    def test_multiple_plugins_mixed_pass_fail(self):
        """Multiple bumps: one with CHANGELOG, one without → only the latter fails."""
        staged = self._make_mp({"alpha": "2.0.0", "beta": "3.0.0"})
        head = self._make_mp({"alpha": "1.0.0", "beta": "2.0.0"})

        def reader(name):
            if name == "alpha":
                return self._changelog_with_version("2.0.0")
            return self._changelog_with_version("2.0.0")  # beta has old version only

        failures = check_marketplace_bumps(staged, head, set(), reader)
        names_failing = [f for f in failures if "beta" in f]
        names_passing = [f for f in failures if "alpha" in f]
        self.assertEqual(len(names_passing), 0)
        self.assertEqual(len(names_failing), 1)

    def test_no_version_changes(self):
        """No version changes in marketplace.json → no failures."""
        staged = self._make_mp({"repo-wiki": "1.1.2", "other": "2.0.0"})
        head = self._make_mp({"repo-wiki": "1.1.2", "other": "2.0.0"})
        failures = check_marketplace_bumps(staged, head, set(), self._no_changelog)
        self.assertEqual(failures, [])

    def test_empty_marketplace(self):
        """Empty marketplace staged → no failures."""
        failures = check_marketplace_bumps({"plugins": []}, {"plugins": []}, set(), self._no_changelog)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()


SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "check_changelog_staged.py"


class TestStagedRenames(unittest.TestCase):
    """Run the real script against a throwaway git repo with staged changes."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = pathlib.Path(self._tmp.name)
        self._git("init", "-q")
        self._git("config", "user.email", "t@example.com")
        self._git("config", "user.name", "t")
        self._git("config", "commit.gpgsign", "false")
        # Without -M on the command line, this makes git report a rename as D + A.
        self._git("config", "diff.renames", "false")
        self._write("plugins/old/CHANGELOG.md", "# Changelog\n\n## 1.0.0\n- first\n")
        self._write("plugins/old/skills/a/SKILL.md", "skill body line one\nline two\nline three\n")
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "init")

    def _git(self, *args):
        subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

    def _write(self, rel, text):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def _run(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT)], cwd=self.repo, capture_output=True, text=True
        )

    def _move_skill_to_new_plugin(self):
        (self.repo / "plugins/new/skills/a").mkdir(parents=True)
        self._git("mv", "plugins/old/skills/a/SKILL.md", "plugins/new/skills/a/SKILL.md")

    def test_rename_with_changelog_under_new_dir_passes(self):
        self._move_skill_to_new_plugin()
        self._write("plugins/new/CHANGELOG.md", "# Changelog\n\n## 1.0.0\n- moved\n")
        self._git("add", "-A")
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rename_without_changelog_update_fails(self):
        self._move_skill_to_new_plugin()
        self._git("add", "-A")
        result = self._run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("plugins/new/CHANGELOG.md", result.stderr)
        self.assertNotIn("plugins/old/CHANGELOG.md", result.stderr)

    def test_deleting_plugin_file_still_requires_that_changelog(self):
        self._git("rm", "-q", "plugins/old/skills/a/SKILL.md")
        result = self._run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("plugins/old/CHANGELOG.md", result.stderr)
