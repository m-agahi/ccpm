"""Thin subprocess wrappers for git."""

import subprocess


def run(*args):
    """Run a git command and return stdout as stripped string."""
    try:
        result = subprocess.run(
            ["git"] + list(args), capture_output=True, text=True, check=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else "(no stderr)"
        raise RuntimeError(
            f"git {' '.join(args)} failed (exit {e.returncode}): {stderr}"
        ) from e


def diff_names(target):
    """Return list of files changed compared to target."""
    output = run("diff", "--name-only", target)
    return output.splitlines() if output else []


def show_file(ref, path):
    """Return file contents at a given git ref, or None if missing."""
    try:
        return run("show", f"{ref}:{path}")
    except subprocess.CalledProcessError:
        return None
