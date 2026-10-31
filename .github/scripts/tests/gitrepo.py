"""Throwaway git repositories for tests that need real git behaviour."""

import os
import shutil
import subprocess
import tempfile

_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


class TempRepo:
    """A temporary git repository; chdir into it for the duration of a test."""

    def __init__(self):
        self.path = tempfile.mkdtemp(prefix="ccpm-test-repo-")
        self._old_cwd = os.getcwd()
        self._old_env = {k: os.environ.get(k) for k in _ENV}
        os.environ.update(_ENV)
        self.git("init", "-q", "-b", "master")
        os.chdir(self.path)

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.path, *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, files, message="c"):
        """Write ``files`` ({relpath: content}) and commit. Returns the sha."""
        for rel, content in files.items():
            full = os.path.join(self.path, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(content)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def cleanup(self):
        os.chdir(self._old_cwd)
        for k, v in self._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.path, ignore_errors=True)
